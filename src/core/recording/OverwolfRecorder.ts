import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { RecorderCapabilities, MonitorSummary } from '../../shared/types';
import {
  ScreenRecorder,
  StartRecordingRequest,
  StartRecordingResult,
  StopRecordingResult,
  computeOutputSize,
  describeEncoder,
  pickEncoder,
  selectMonitor,
} from './ScreenRecorder';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/**
 * Variables con las que Overwolf activa el Dev Mode.
 * Cualquiera de las dos formas vale: par email + clave, o token de desarrollo.
 */
function hasDevCredentials(): boolean {
  const email = process.env.OW_CLI_EMAIL;
  const apiKey = process.env.OW_CLI_API_KEY;
  const devKey = process.env.OW_DEV_KEY;
  return Boolean((email && apiKey) || devKey);
}

function isPackagedBuild(): boolean {
  try {
    return app.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * Grabador basado en el paquete `recorder` de ow-electron.
 *
 * Por debajo es OBS: los identificadores de encoder que devuelve
 * (jim_nvenc, h264_texture_amf, obs_qsv11_v2, obs_x264) son los de OBS Studio.
 * Esto nos da exactamente lo que buscabamos:
 *   - codificacion por hardware (NVENC / AMF / Quick Sync),
 *   - captura del proceso del juego (`addGameSource`), no de la pantalla,
 *   - bajo consumo de CPU.
 *
 * Limitacion real y documentada: un juego que corre con privilegios elevados
 * NO se puede capturar por game source. En ese caso se cae automaticamente a
 * captura de pantalla, que si funciona.
 */
export class OverwolfRecorder extends EventEmitter implements ScreenRecorder {
  readonly backend = 'overwolf' as const;

  private api: overwolf.packages.OverwolfPackageManager['recorder'] | null = null;
  private ready = false;
  private capabilities: RecorderCapabilities | null = null;
  private currentFilePath: string | null = null;
  private monitors: MonitorSummary[] = [];
  private availableEncoders: string[] = [];

  /** Espera a que el paquete recorder este listo. */
  initialize(): void {
    const overwolfApp = app as unknown as {
      overwolf?: { packages?: EventEmitter & Record<string, unknown> };
    };
    const packages = overwolfApp.overwolf?.packages;
    if (!packages || typeof packages.on !== 'function') {
      log.warn('Paquete recorder no disponible (no se ejecuta bajo ow-electron)');
      // Se sabe ya: no hay que hacer esperar a nadie los doce segundos.
      queueMicrotask(() => this.emit('unavailable', 'no se ejecuta bajo ow-electron'));
      return;
    }

    // Overwolf avisa cuando un paquete no consigue inicializarse. No siempre
    // llega (si la verificacion se corta antes, no se emite nada), asi que
    // sirve de atajo cuando existe, no de unica via.
    packages.on(
      'failed-to-initialize' as never,
      ((_event: unknown, name: string) => {
        if (name !== 'recorder') return;
        log.warn('El paquete recorder de Overwolf no pudo inicializarse');
        this.emit('unavailable', 'el paquete recorder no pudo inicializarse');
      }) as never,
    );

    // Atajo fiable en desarrollo. La documentacion de Overwolf es tajante:
    // "Without valid credentials, the app still runs, but the gaming packages
    // stay inactive". Si no hay credenciales no tiene sentido esperar doce
    // segundos a algo que no va a cargar; se pasa a FFmpeg de inmediato.
    // En una compilacion firmada las credenciales vienen de la firma, no del
    // entorno, asi que ahi si se espera.
    if (!isPackagedBuild() && !hasDevCredentials()) {
      log.info(
        'Sin credenciales de Overwolf Dev Mode: los paquetes de juego no se cargaran. ' +
          'Se usa FFmpeg sin esperar.',
      );
      queueMicrotask(() => this.emit('unavailable', 'sin credenciales de Dev Mode'));
      return;
    }

    packages.on('ready', (_e: unknown, name: string, version: string) => {
      if (name !== 'recorder') return;
      log.info(`Paquete recorder listo (version ${version})`);
      this.api = (
        overwolfApp as unknown as { overwolf: { packages: overwolf.packages.OverwolfPackageManager } }
      ).overwolf.packages.recorder;
      this.ready = true;
      this.attachListeners();
      this.emit('ready');
    });
  }

  private attachListeners(): void {
    const api = this.api;
    if (!api) return;

    api.on('recording-started', (args) => {
      this.currentFilePath = args.filePath ?? this.currentFilePath;
      log.info(`Grabacion iniciada: ${this.currentFilePath}`);
      // Nota importante: RecordEventArgs NO trae startTimeEpoch. El instante
      // real del primer frame solo se conoce al parar. Por eso el RecordingClock
      // usa un ancla provisional aqui y reconcilia despues.
      this.emit('backend-started', { filePath: this.currentFilePath });
    });

    api.on('recording-stopped', (args) => {
      log.info(
        `Grabacion detenida. Duracion ${args.duration ?? 'desconocida'}ms, ` +
          `inicio real ${args.startTimeEpoch ?? 'desconocido'}`,
      );
      this.emit('backend-stopped', {
        filePath: args.filePath ?? this.currentFilePath,
        durationMs: args.duration ?? null,
        startTimeEpochMs: args.startTimeEpoch ?? null,
        hasError: Boolean(args.hasError),
        error: args.error,
      } satisfies StopRecordingResult);
    });

    api.on('stats', (stats) => {
      this.emit('stats', stats);
    });
  }

  async probe(): Promise<RecorderCapabilities> {
    if (!this.ready || !this.api) {
      return {
        status: 'unavailable',
        available: false,
        backend: 'overwolf',
        encoders: [],
        monitors: [],
        message:
          'El paquete de grabacion de Overwolf no esta cargado. Se usara FFmpeg como alternativa.',
      };
    }

    try {
      const info = (await this.api.queryInformation()) as {
        video?: { encoders?: Array<{ type: string }> };
        monitors?: Array<{
          id: string;
          friendlyName: string;
          isPrimary: boolean;
          refreshRate: number;
          rect?: { width?: number; height?: number; right?: number; bottom?: number; left?: number; top?: number };
        }>;
      };

      this.availableEncoders = (info.video?.encoders ?? []).map((e) => e.type);
      this.monitors = (info.monitors ?? []).map((m) => {
        const rect = m.rect ?? {};
        const width = rect.width ?? (rect.right ?? 0) - (rect.left ?? 0);
        const height = rect.height ?? (rect.bottom ?? 0) - (rect.top ?? 0);
        return {
          id: m.id,
          name: m.friendlyName,
          isPrimary: Boolean(m.isPrimary),
          width: width || 1920,
          height: height || 1080,
          refreshRate: m.refreshRate ?? 60,
        };
      });

      this.capabilities = {
        status: 'ready',
        available: true,
        backend: 'overwolf',
        encoders: this.availableEncoders.map(describeEncoder),
        monitors: this.monitors,
      };
      log.info(`Encoders disponibles: ${this.availableEncoders.join(', ') || 'ninguno'}`);
      return this.capabilities;
    } catch (err) {
      log.error(`queryInformation fallo: ${(err as Error).message}`);
      return {
        status: 'unavailable',
        available: false,
        backend: 'overwolf',
        encoders: [],
        monitors: [],
        message: `No se pudo consultar el sistema de grabacion: ${(err as Error).message}`,
      };
    }
  }

  async isRecording(): Promise<boolean> {
    if (!this.api) return false;
    try {
      return await this.api.isActive();
    } catch {
      return false;
    }
  }

  async start(request: StartRecordingRequest): Promise<StartRecordingResult> {
    if (!this.ready || !this.api) {
      throw new Error('El paquete de grabacion de Overwolf no esta disponible');
    }

    if (!this.capabilities) await this.probe();

    const { settings } = request;
    const encoder = pickEncoder(this.availableEncoders, settings.encoder);
    if (!encoder) {
      throw new Error('No se ha encontrado ningun codificador de video utilizable');
    }

    const monitor = selectMonitor(this.monitors);
    const baseWidth = monitor?.width ?? 1920;
    const baseHeight = monitor?.height ?? 1080;
    const output = computeOutputSize(baseWidth, baseHeight, settings.resolution);

    const builder = await this.api.createSettingsBuilder({
      videoEncoder: encoder as never,
      includeDefaultAudioSources: settings.captureSystemAudio || settings.captureMicrophone,
    });

    builder.videoSettings = {
      ...builder.videoSettings,
      baseWidth,
      baseHeight,
      outputWidth: output.width,
      outputHeight: output.height,
      fps: settings.fps,
    };

    builder.videoEncoderSettings = {
      ...builder.videoEncoderSettings,
      bitrate: settings.bitrate,
      // Un keyframe cada 2 segundos permite cortar clips con precision
      // razonable sin recodificar. Es el compromiso clave para que
      // "crear clip" sea instantaneo.
      keyint_sec: 2,
    };

    // Eleccion de la fuente de captura.
    const wantsGameCapture = settings.captureMode === 'game' && !request.gameIsElevated;
    let usedMode: 'game' | 'display' = 'display';

    if (wantsGameCapture && (request.gamePid || request.gameProcessName)) {
      try {
        builder.addGameSource({
          gameProcess: request.gamePid ?? (request.gameProcessName as string),
          captureOverlays: true,
        });
        usedMode = 'game';
      } catch (err) {
        log.warn(
          `No se pudo anadir la fuente de juego (${(err as Error).message}); ` +
            'se recurre a captura de pantalla',
        );
      }
    } else if (request.gameIsElevated) {
      log.warn(
        'El juego corre con privilegios elevados: la captura del proceso no es posible, ' +
          'se graba la pantalla completa',
      );
    }

    if (usedMode === 'display') {
      if (!monitor) throw new Error('No se ha detectado ningun monitor para capturar');
      builder.addScreenSource({ monitorId: monitor.id });
    }

    if (settings.captureSystemAudio) {
      try {
        builder.addAudioDefaultCapture('output', {}, {});
      } catch (err) {
        log.warn(`No se pudo anadir el audio del sistema: ${(err as Error).message}`);
      }
    }
    if (settings.captureMicrophone) {
      try {
        builder.addAudioDefaultCapture('input', {}, {});
      } catch (err) {
        log.warn(`No se pudo anadir el microfono: ${(err as Error).message}`);
      }
    }

    const captureSettings = builder.build();
    this.currentFilePath = request.outputPathWithoutExt + '.mp4';

    await this.api.startRecording(
      { filePath: request.outputPathWithoutExt, fileFormat: 'mp4' as never },
      captureSettings,
      (stopResult) => {
        // Callback de parada no solicitada (p.ej. el juego se cerro).
        log.info('El backend ha detenido la grabacion');
        this.emit('backend-stopped', {
          filePath: stopResult.filePath ?? this.currentFilePath,
          durationMs: stopResult.duration ?? null,
          startTimeEpochMs: stopResult.startTimeEpoch ?? null,
          hasError: Boolean(stopResult.hasError),
          error: stopResult.error,
        } satisfies StopRecordingResult);
      },
    );

    log.info(
      `Captura ${usedMode === 'game' ? 'del proceso del juego' : 'de pantalla'} a ` +
        `${output.width}x${output.height}@${settings.fps} con ${encoder} ` +
        `(${settings.bitrate} kbps)`,
    );

    return {
      filePath: this.currentFilePath,
      encoder,
      resolution: `${output.width}x${output.height}`,
      fps: settings.fps,
    };
  }

  async stop(): Promise<StopRecordingResult> {
    if (!this.api) {
      return {
        filePath: this.currentFilePath,
        durationMs: null,
        startTimeEpochMs: null,
        hasError: true,
        error: 'recorder no disponible',
      };
    }

    return new Promise<StopRecordingResult>((resolve) => {
      let settled = false;
      const finish = (result: StopRecordingResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Red de seguridad: si el backend no responde, no bloqueamos el cierre.
      const timeout = setTimeout(() => {
        log.warn('El backend no confirmo la parada en 10s');
        finish({
          filePath: this.currentFilePath,
          durationMs: null,
          startTimeEpochMs: null,
          hasError: true,
          error: 'timeout al detener la grabacion',
        });
      }, 10000);

      try {
        void this.api!.stopRecording((stopResult) => {
          clearTimeout(timeout);
          finish({
            filePath: stopResult.filePath ?? this.currentFilePath,
            durationMs: stopResult.duration ?? null,
            startTimeEpochMs: stopResult.startTimeEpoch ?? null,
            hasError: Boolean(stopResult.hasError),
            error: stopResult.error,
          });
        });
      } catch (err) {
        clearTimeout(timeout);
        finish({
          filePath: this.currentFilePath,
          durationMs: null,
          startTimeEpochMs: null,
          hasError: true,
          error: (err as Error).message,
        });
      }
    });
  }

  dispose(): void {
    try {
      (this.api as unknown as { removeAllListeners?: () => void })?.removeAllListeners?.();
    } catch {
      /* ignorado */
    }
    this.removeAllListeners();
  }
}
