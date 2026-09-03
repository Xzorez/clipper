import { EventEmitter } from 'node:events';
import { spawn, ChildProcess, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { screen } from 'electron';
import { RecorderCapabilities } from '../../shared/types';
import {
  ScreenRecorder,
  StartRecordingRequest,
  StartRecordingResult,
  StopRecordingResult,
  computeOutputSize,
} from './ScreenRecorder';
import { createLogger } from '../logging/Logger';
import { resolveFfmpegPath } from './ffmpegPath';

const log = createLogger('Recording');
const execFileAsync = promisify(execFile);

/**
 * Encoders de FFmpeg equivalentes a los de OBS, en orden de preferencia.
 * Igual que en el backend de Overwolf, se prioriza H.264 por hardware para
 * garantizar que el video se reproduzca despues dentro de Chromium.
 */
const FFMPEG_ENCODERS: Array<{
  id: string;
  label: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'software';
  hardware: boolean;
}> = [
  { id: 'h264_nvenc', label: 'NVIDIA NVENC H.264', vendor: 'nvidia', hardware: true },
  { id: 'h264_amf', label: 'AMD AMF H.264', vendor: 'amd', hardware: true },
  { id: 'h264_qsv', label: 'Intel Quick Sync H.264', vendor: 'intel', hardware: true },
  { id: 'libx264', label: 'x264 (software)', vendor: 'software', hardware: false },
];

/** Metodo de captura de pantalla. */
export type CaptureMethod = 'ddagrab' | 'gdigrab';

export interface FfmpegArgsContext {
  encoder: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

/**
 * Construye la linea de comandos de FFmpeg.
 *
 * Se expone como funcion pura para poder verificar en los tests que ddagrab y
 * gdigrab producen los argumentos correctos, sin lanzar procesos.
 *
 * Diferencia clave entre ambos: con ddagrab el filtro ES la fuente y no hay
 * `-i`; con gdigrab la fuente es `-i desktop` y el escalado va en `-vf`.
 */
export function buildFfmpegArgs(
  method: CaptureMethod,
  context: FfmpegArgsContext,
  filePath: string,
): string[] {
  const { encoder, width, height, fps, bitrateKbps } = context;

  const source: string[] =
    method === 'ddagrab'
      ? [
          // La captura ocurre en la GPU; hwdownload la trae a memoria para que
          // el encoder la consuma. El filtro ES la fuente: no hay -i.
          '-init_hw_device', 'd3d11va',
          '-filter_complex',
          `ddagrab=output_idx=0:framerate=${fps}:draw_mouse=0,` +
            `hwdownload,format=bgra,scale=${width}:${height}:flags=bilinear,format=nv12`,
        ]
      : [
          '-f', 'gdigrab',
          '-framerate', String(fps),
          '-draw_mouse', '0',
          '-i', 'desktop',
          '-vf', `scale=${width}:${height}:flags=bilinear`,
        ];

  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...source,
    '-c:v', encoder,
    '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${Math.round(bitrateKbps * 1.2)}k`,
    '-bufsize', `${bitrateKbps * 2}k`,
    // Keyframe cada 2 segundos: permite cortar clips sin recodificar.
    '-g', String(fps * 2),
    '-pix_fmt', 'yuv420p',
    // faststart no sirve escribiendo en directo; frag_keyframe deja el fichero
    // legible aunque el proceso muera de forma abrupta.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-progress', 'pipe:1',
    '-y',
    filePath,
  ];
}

/**
 * Margen para decidir que un arranque ha fracasado.
 * Si FFmpeg muere antes de producir un solo fotograma y antes de este plazo,
 * se considera que el metodo de captura no es viable en esta maquina.
 */
const STARTUP_GRACE_MS = 6000;

/**
 * Grabador de respaldo basado en FFmpeg.
 *
 * Se usa cuando el paquete de grabacion de Overwolf no esta disponible: al
 * ejecutar con Electron estandar, sin credenciales de Dev Mode, o si el
 * paquete falla en tiempo de ejecucion.
 *
 * ## Dos metodos de captura
 *
 * 1. **ddagrab** (preferido). Usa la Desktop Duplication API de DirectX a
 *    traves de un dispositivo d3d11va: la captura ocurre en la GPU, sin
 *    componer el escritorio por CPU, y funciona con pantalla completa
 *    exclusiva. Es el mismo mecanismo que usa la captura de pantalla de OBS.
 *    Requiere FFmpeg 6.0 o superior (el binario empaquetado es 6.1.1).
 *
 * 2. **gdigrab** (repliegue). Compone el escritorio por CPU. Mas lento y con
 *    peor comportamiento en pantalla completa, pero funciona practicamente en
 *    cualquier configuracion.
 *
 * El repliegue es automatico: si ddagrab no llega a producir un fotograma
 * (multi-GPU, sesion remota, drivers antiguos), se relanza con gdigrab de forma
 * transparente. El ancla del reloj solo se fija cuando hay fotogramas reales,
 * asi que un reintento no descuadra la sincronizacion.
 *
 * Limitacion honesta frente al backend de Overwolf: captura la pantalla, no el
 * proceso del juego. Para captura del proceso hace falta ow-electron.
 */
export class FFmpegRecorder extends EventEmitter implements ScreenRecorder {
  readonly backend = 'ffmpeg' as const;

  private proc: ChildProcess | null = null;
  private ffmpegPath: string | null = null;
  private availableEncoders: string[] = [];
  private supportsDdagrab: boolean | null = null;
  /**
   * Las sondas se memorizan como promesa, no como resultado.
   *
   * `probe()` puede llamarse desde varios sitios a la vez (arranque y seleccion
   * de backend). Guardando solo el resultado, dos llamadas concurrentes pasan
   * ambas la comprobacion antes de que ninguna termine y se lanzan dos procesos
   * de FFmpeg innecesarios. Memorizando la promesa, la segunda espera a la
   * primera.
   */
  private encodersProbe: Promise<void> | null = null;
  private ddagrabProbe: Promise<void> | null = null;

  private currentFilePath: string | null = null;
  private startedAtEpochMs: number | null = null;
  private lastOutTimeMs = 0;
  private firstFrameSeen = false;
  private stopping = false;

  /** Estado del intento en curso, para poder replegarse. */
  private activeMethod: CaptureMethod = 'ddagrab';
  private triedFallback = false;
  private pendingRequest: StartRecordingRequest | null = null;
  private pendingArgsContext: { encoder: string; width: number; height: number } | null = null;

  async probe(): Promise<RecorderCapabilities> {
    this.ffmpegPath = resolveFfmpegPath();
    if (!this.ffmpegPath) {
      return {
        available: false,
        backend: 'ffmpeg',
        encoders: [],
        monitors: [],
        message: 'No se ha encontrado FFmpeg. La grabacion no esta disponible.',
      };
    }

    await this.detectEncoders();
    await this.detectDdagrab();

    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;

    return {
      available: true,
      backend: 'ffmpeg',
      encoders: this.availableEncoders.map((id) => {
        const meta = FFMPEG_ENCODERS.find((e) => e.id === id);
        return {
          id,
          label: meta?.label ?? id,
          hardware: meta?.hardware ?? false,
          vendor: meta?.vendor ?? 'unknown',
        };
      }),
      monitors: displays.map((d) => ({
        id: String(d.id),
        name: d.label || `Monitor ${d.id}`,
        isPrimary: d.id === primaryId,
        width: Math.round(d.size.width * d.scaleFactor),
        height: Math.round(d.size.height * d.scaleFactor),
        refreshRate: 60,
      })),
      message: this.supportsDdagrab
        ? 'Modo FFmpeg con captura por GPU (Desktop Duplication). Se graba la pantalla, no el ' +
          'proceso del juego: para eso hace falta ow-electron.'
        : 'Modo FFmpeg con captura por CPU. Se graba la pantalla y el consumo es mayor.',
    };
  }

  private detectEncoders(): Promise<void> {
    if (!this.encodersProbe) this.encodersProbe = this.runEncoderProbe();
    return this.encodersProbe;
  }

  private async runEncoderProbe(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(this.ffmpegPath as string, ['-hide_banner', '-encoders'], {
        maxBuffer: 8 * 1024 * 1024,
      });
      this.availableEncoders = FFMPEG_ENCODERS.filter((e) =>
        new RegExp(`\\s${e.id}\\s`).test(stdout),
      ).map((e) => e.id);
    } catch (err) {
      log.warn(`No se pudo listar los encoders de FFmpeg: ${(err as Error).message}`);
      this.availableEncoders = ['libx264'];
    }
  }

  /** Comprueba si el binario incluye el filtro ddagrab (FFmpeg 6.0+). */
  private detectDdagrab(): Promise<void> {
    if (!this.ddagrabProbe) this.ddagrabProbe = this.runDdagrabProbe();
    return this.ddagrabProbe;
  }

  private async runDdagrabProbe(): Promise<void> {
    if (process.platform !== 'win32') {
      this.supportsDdagrab = false;
      return;
    }
    try {
      const { stdout } = await execFileAsync(this.ffmpegPath as string, ['-hide_banner', '-filters'], {
        maxBuffer: 8 * 1024 * 1024,
      });
      this.supportsDdagrab = /\bddagrab\b/.test(stdout);
      log.info(
        this.supportsDdagrab
          ? 'ddagrab disponible: se usara captura por GPU'
          : 'ddagrab no disponible: se usara gdigrab',
      );
    } catch {
      this.supportsDdagrab = false;
    }
  }

  async isRecording(): Promise<boolean> {
    return this.proc !== null && !this.proc.killed;
  }

  async start(request: StartRecordingRequest): Promise<StartRecordingResult> {
    if (this.proc) throw new Error('Ya hay una grabacion en curso');
    if (!this.ffmpegPath) await this.probe();
    if (!this.ffmpegPath) throw new Error('FFmpeg no disponible');

    await this.detectEncoders();
    await this.detectDdagrab();

    const { settings } = request;
    const encoder =
      settings.encoder !== 'auto' && this.availableEncoders.includes(settings.encoder)
        ? settings.encoder
        : (this.availableEncoders[0] ?? 'libx264');

    const display = screen.getPrimaryDisplay();
    const baseWidth = Math.round(display.size.width * display.scaleFactor);
    const baseHeight = Math.round(display.size.height * display.scaleFactor);
    const output = computeOutputSize(baseWidth, baseHeight, settings.resolution);

    this.currentFilePath = request.outputPathWithoutExt + '.mp4';
    this.pendingRequest = request;
    this.pendingArgsContext = { encoder, width: output.width, height: output.height };
    this.lastOutTimeMs = 0;
    this.firstFrameSeen = false;
    this.stopping = false;
    this.triedFallback = false;
    this.activeMethod = this.supportsDdagrab ? 'ddagrab' : 'gdigrab';

    this.launch(this.activeMethod);

    return {
      filePath: this.currentFilePath,
      encoder,
      resolution: `${output.width}x${output.height}`,
      fps: settings.fps,
    };
  }

  /** Lanza el proceso de FFmpeg con el metodo de captura indicado. */
  private launch(method: CaptureMethod): void {
    const request = this.pendingRequest;
    const context = this.pendingArgsContext;
    if (!request || !context || !this.ffmpegPath || !this.currentFilePath) return;

    const args = buildFfmpegArgs(
      method,
      {
        encoder: context.encoder,
        width: context.width,
        height: context.height,
        fps: request.settings.fps,
        bitrateKbps: request.settings.bitrate,
      },
      this.currentFilePath,
    );
    log.info(
      `Lanzando FFmpeg (${method}) con ${context.encoder} a ` +
        `${context.width}x${context.height}@${request.settings.fps}`,
    );

    const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.proc = proc;
    this.activeMethod = method;
    this.startedAtEpochMs = Date.now();
    const launchedAt = Date.now();

    proc.stdout?.on('data', (chunk: Buffer) => this.parseProgress(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.warn(`ffmpeg: ${text.slice(0, 400)}`);
    });

    proc.on('error', (err) => {
      log.error(`FFmpeg fallo al arrancar: ${err.message}`);
      this.proc = null;
      this.emit('error', err);
    });

    proc.on('close', (code) => {
      const wasStopping = this.stopping;
      this.proc = null;

      // Arranque fallido con ddagrab: se reintenta con gdigrab en silencio.
      const failedStartup =
        !wasStopping &&
        !this.firstFrameSeen &&
        Date.now() - launchedAt < STARTUP_GRACE_MS &&
        method === 'ddagrab' &&
        !this.triedFallback;

      if (failedStartup) {
        this.triedFallback = true;
        log.warn(
          'La captura por GPU (ddagrab) no ha producido imagen en esta maquina; ' +
            'se reintenta con gdigrab',
        );
        this.launch('gdigrab');
        return;
      }

      const durationMs = this.lastOutTimeMs || null;
      // No conocemos el instante exacto del primer frame, pero si el momento de
      // cierre y la duracion producida, asi que lo derivamos.
      const startTimeEpochMs = durationMs !== null ? Date.now() - durationMs : this.startedAtEpochMs;
      log.info(`FFmpeg ha terminado con codigo ${code}`);

      this.emit('backend-stopped', {
        filePath: this.currentFilePath,
        durationMs,
        startTimeEpochMs,
        hasError: code !== 0 && !wasStopping,
        error: code !== 0 && !wasStopping ? `ffmpeg salio con codigo ${code}` : undefined,
      } satisfies StopRecordingResult);
    });

    // Red de seguridad: si no hay progreso pero el proceso sigue vivo, damos la
    // grabacion por iniciada para no bloquear la aplicacion.
    setTimeout(() => {
      if (!this.firstFrameSeen && this.proc === proc) {
        this.firstFrameSeen = true;
        this.emit('backend-started', { filePath: this.currentFilePath });
      }
    }, STARTUP_GRACE_MS);
  }

  private parseProgress(text: string): void {
    for (const line of text.split('\n')) {
      const [key, value] = line.split('=');
      if (key === 'out_time_ms') {
        const us = Number(value);
        // out_time_ms de ffmpeg viene en microsegundos pese a su nombre.
        if (Number.isFinite(us)) this.lastOutTimeMs = Math.round(us / 1000);
      }
      if (key === 'frame' && !this.firstFrameSeen) {
        const frames = Number(value);
        if (Number.isFinite(frames) && frames > 0) {
          this.firstFrameSeen = true;
          log.info(`Primer fotograma capturado con ${this.activeMethod}`);
          this.emit('backend-started', { filePath: this.currentFilePath });
        }
      }
    }
  }

  async stop(): Promise<StopRecordingResult> {
    const proc = this.proc;
    if (!proc) {
      return {
        filePath: this.currentFilePath,
        durationMs: this.lastOutTimeMs || null,
        startTimeEpochMs: this.startedAtEpochMs,
        hasError: false,
      };
    }

    this.stopping = true;

    return new Promise<StopRecordingResult>((resolve) => {
      let settled = false;
      const finish = (result: StopRecordingResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      this.once('backend-stopped', (result: StopRecordingResult) => finish(result));

      // 'q' por stdin cierra FFmpeg limpiamente y escribe el indice del MP4.
      // Matar el proceso a lo bruto dejaria un fichero sin moov atom.
      try {
        proc.stdin?.write('q');
        proc.stdin?.end();
      } catch {
        /* si stdin ya esta cerrado pasamos al plan B */
      }

      setTimeout(() => {
        if (!settled && this.proc) {
          log.warn('FFmpeg no respondio a la parada limpia; se termina el proceso');
          try {
            this.proc.kill('SIGKILL');
          } catch {
            /* ignorado */
          }
        }
      }, 8000);

      setTimeout(() => {
        finish({
          filePath: this.currentFilePath,
          durationMs: this.lastOutTimeMs || null,
          startTimeEpochMs: this.startedAtEpochMs,
          hasError: true,
          error: 'timeout al detener FFmpeg',
        });
      }, 12000);
    });
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignorado */
      }
      this.proc = null;
    }
    this.removeAllListeners();
  }
}
