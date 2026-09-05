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
import { buildFfmpegArgs, CaptureMethod, FfmpegArgsContext } from './captureArgs';
import {
  CaptureCandidate,
  buildCandidates,
  createProbeRunner,
  describeCandidate,
  explainFailure,
  probeCandidate,
  selectCapture,
} from './CaptureProbe';

// Se reexportan para que el resto del proyecto siga teniendo un unico punto de
// entrada al grabador por FFmpeg.
export { buildFfmpegArgs };
export type { CaptureMethod, FfmpegArgsContext };

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

/**
 * Margen para decidir que un arranque ha fracasado.
 * Si FFmpeg muere antes de producir un solo fotograma y antes de este plazo,
 * se considera que el metodo de captura no es viable en esta maquina.
 */
const STARTUP_GRACE_MS = 6000;

/** Cuando se comprueba que la grabacion en curso sigue viendo imagen. */
const VERIFY_AFTER_MS = 12_000;

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
  private monitorCount = 1;
  private lastProbeFailure: string | null = null;

  private currentFilePath: string | null = null;
  private startedAtEpochMs: number | null = null;
  private lastOutTimeMs = 0;
  private firstFrameSeen = false;
  private stopping = false;
  /**
   * Hay un arranque en curso que todavia no ha llegado a lanzar el proceso.
   *
   * `this.proc` no sirve como guardia por si solo: entre la comprobacion y el
   * `spawn` hay un sondeo de captura que tarda segundos. Dos llamadas a
   * `start()` en ese intervalo pasarian ambas el filtro y dejarian dos FFmpeg
   * escribiendo el mismo fichero, con el agravante de que solo el ultimo
   * quedaria en `this.proc`: el otro seria un huerfano imposible de detener.
   */
  private starting = false;

  /** Metodo de captura en uso, decidido por el sondeo automatico. */
  private activeCandidate: CaptureCandidate = { method: 'ddagrab', outputIndex: 0 };
  private pendingRequest: StartRecordingRequest | null = null;
  private pendingArgsContext: {
    encoder: string;
    width: number;
    height: number;
    audioPipe: string | null;
  } | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;

  /**
   * Metodo que funciono la ultima vez, por juego.
   *
   * Es lo que hace que solo haya que sondear una vez: a partir de la segunda
   * partida con el mismo juego se arranca directamente con lo que ya sirvio.
   */
  private readonly learned = new Map<string, CaptureCandidate>();

  async probe(): Promise<RecorderCapabilities> {
    this.ffmpegPath = resolveFfmpegPath();
    if (!this.ffmpegPath) {
      return {
        status: 'unavailable',
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
    this.monitorCount = Math.max(1, displays.length);

    return {
      status: 'ready',
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
    if (this.proc || this.starting) throw new Error('Ya hay una grabacion en curso');
    // Se marca de forma sincrona, antes de cualquier await, para que la ventana
    // entre la comprobacion y el spawn deje de ser aprovechable.
    this.starting = true;
    try {
      return await this.runStart(request);
    } finally {
      this.starting = false;
    }
  }

  private async runStart(request: StartRecordingRequest): Promise<StartRecordingResult> {
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
    this.pendingArgsContext = {
      encoder,
      width: output.width,
      height: output.height,
      audioPipe: request.audioPipePath ?? null,
    };
    this.lastOutTimeMs = 0;
    this.firstFrameSeen = false;
    this.stopping = false;

    // Se decide COMO capturar antes de empezar, no despues de descubrir que el
    // video salio en negro. Dura poco mas de un segundo la primera vez y nada
    // las siguientes, porque el resultado se recuerda por juego.
    const candidate = await this.chooseCandidate(request);
    if (!candidate) {
      throw new Error(this.lastProbeFailure ?? 'No se ha podido capturar la pantalla.');
    }
    this.activeCandidate = candidate;

    this.launch(candidate);
    this.scheduleVerification();

    return {
      filePath: this.currentFilePath,
      encoder,
      resolution: `${output.width}x${output.height}`,
      fps: settings.fps,
    };
  }

  /**
   * Determina el metodo de captura para esta grabacion.
   *
   * Con un juego identificado se reutiliza lo aprendido; si no, se sondea. El
   * sondeo prueba la captura por GPU en cada monitor y, como ultimo recurso, la
   * captura por CPU, quedandose con el primero que devuelva imagen real.
   */
  private async chooseCandidate(
    request: StartRecordingRequest,
  ): Promise<CaptureCandidate | null> {
    const memoryKey = request.gameProcessName ?? 'desktop';
    const remembered = this.learned.get(memoryKey) ?? null;

    const run = createProbeRunner(this.ffmpegPath as string);
    const candidates = buildCandidates(this.monitorCount, this.supportsDdagrab === true);
    const { candidate, attempts } = await selectCapture(run, candidates, remembered);

    if (!candidate) {
      this.lastProbeFailure = explainFailure(attempts);
      log.error(this.lastProbeFailure);
      return null;
    }

    this.lastProbeFailure = null;
    this.learned.set(memoryKey, candidate);
    return candidate;
  }

  /**
   * Comprueba una vez, ya empezada la grabacion, que se sigue viendo algo.
   *
   * Cubre el caso de que el juego cambie a pantalla completa exclusiva despues
   * de arrancar. No se reinicia la grabacion (perderia continuidad y el ancla
   * del reloj); se avisa, que es lo util.
   */
  private scheduleVerification(): void {
    this.clearVerification();
    this.verifyTimer = setTimeout(() => {
      void this.verifyStillVisible();
    }, VERIFY_AFTER_MS);
  }

  private async verifyStillVisible(): Promise<void> {
    if (!this.proc || this.stopping || !this.ffmpegPath) return;
    try {
      const run = createProbeRunner(this.ffmpegPath);
      const result = await probeCandidate(run, this.activeCandidate);
      if (result.usable) return;

      log.warn(
        `La captura ha dejado de mostrar imagen (${describeCandidate(this.activeCandidate)})`,
      );
      this.emit('capture-blank', {
        message:
          'La grabacion en curso ha dejado de captar imagen. Si el juego ha cambiado a ' +
          'pantalla completa exclusiva, ponlo en "Pantalla completa sin bordes".',
      });
    } catch {
      /* la verificacion es un extra: nunca debe afectar a la grabacion */
    }
  }

  private clearVerification(): void {
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
    }
  }

  /** Lanza el proceso de FFmpeg con el metodo de captura elegido. */
  private launch(candidate: CaptureCandidate): void {
    const request = this.pendingRequest;
    const context = this.pendingArgsContext;
    if (!request || !context || !this.ffmpegPath || !this.currentFilePath) return;

    const args = buildFfmpegArgs(
      candidate.method,
      {
        encoder: context.encoder,
        width: context.width,
        height: context.height,
        fps: request.settings.fps,
        bitrateKbps: request.settings.bitrate,
        outputIndex: candidate.outputIndex,
        audioPipe: context.audioPipe,
      },
      this.currentFilePath,
    );
    log.info(
      `Lanzando FFmpeg (${describeCandidate(candidate)}) con ${context.encoder} a ` +
        `${context.width}x${context.height}@${request.settings.fps}`,
    );

    // Ultima red: si por cualquier via quedara un proceso anterior vivo, se
    // termina antes de lanzar el nuevo. Dos FFmpeg sobre el mismo fichero lo
    // dejan irrecuperable, y el que se pierde de vista no lo para nadie.
    if (this.proc) {
      log.error(
        'Se iba a lanzar FFmpeg con una captura ya en curso; se termina la anterior ' +
          'para no dejar dos procesos escribiendo el mismo fichero',
      );
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignorado */
      }
    }

    const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
    this.proc = proc;
    this.activeCandidate = candidate;
    this.startedAtEpochMs = Date.now();

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
      this.clearVerification();

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
          log.info(`Primer fotograma capturado con ${describeCandidate(this.activeCandidate)}`);
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
    this.clearVerification();
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
