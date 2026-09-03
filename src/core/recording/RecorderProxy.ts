import { EventEmitter } from 'node:events';
import { RecorderCapabilities } from '../../shared/types';
import {
  ScreenRecorder,
  StartRecordingRequest,
  StartRecordingResult,
  StopRecordingResult,
} from './ScreenRecorder';
import { OverwolfRecorder } from './OverwolfRecorder';
import { FFmpegRecorder } from './FFmpegRecorder';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/** Cuanto esperamos a que cargue el paquete recorder antes de asumir que no llega. */
const OVERWOLF_READY_TIMEOUT_MS = 12_000;

/**
 * Selecciona el backend de captura y reexpone su interfaz.
 *
 * La decision no se puede tomar al arrancar porque los paquetes de ow-electron
 * se cargan de forma asincrona. Este proxy resuelve el problema:
 *
 *  - registra ambos backends desde el principio,
 *  - prefiere el de Overwolf si su paquete llega a estar listo (captura del
 *    proceso del juego con codificacion por hardware),
 *  - cae a FFmpeg si no llega (Electron estandar o sin credenciales Dev Mode),
 *  - y reenvia hacia arriba los eventos del backend activo, de modo que el
 *    RecordingManager no necesita saber cual esta en uso.
 */
export class RecorderProxy extends EventEmitter implements ScreenRecorder {
  private readonly overwolf: OverwolfRecorder;
  private readonly ffmpeg: FFmpegRecorder;
  private activeBackend: ScreenRecorder | null = null;
  private resolution: Promise<ScreenRecorder> | null = null;

  constructor() {
    super();
    this.overwolf = new OverwolfRecorder();
    this.ffmpeg = new FFmpegRecorder();
  }

  get backend(): 'overwolf' | 'ffmpeg' {
    return (this.activeBackend?.backend ?? 'ffmpeg') as 'overwolf' | 'ffmpeg';
  }

  /** Arranca la espera del paquete de Overwolf. No bloquea. */
  initialize(): void {
    this.overwolf.initialize();
    this.resolution = this.resolveBackend();
    void this.resolution;
  }

  private resolveBackend(): Promise<ScreenRecorder> {
    return new Promise<ScreenRecorder>((resolve) => {
      let settled = false;

      const select = (recorder: ScreenRecorder, reason: string) => {
        if (settled) return;
        settled = true;
        this.activeBackend = recorder;
        this.forwardEvents(recorder);
        log.info(`Backend de captura seleccionado: ${recorder.backend} (${reason})`);
        this.emit('backend-selected', recorder.backend);
        resolve(recorder);
      };

      this.overwolf.once('ready', () => {
        select(this.overwolf, 'paquete recorder de Overwolf disponible');
      });

      setTimeout(() => {
        select(
          this.ffmpeg,
          'el paquete recorder de Overwolf no se ha cargado; se usa FFmpeg',
        );
      }, OVERWOLF_READY_TIMEOUT_MS);
    });
  }

  private forwardEvents(recorder: ScreenRecorder): void {
    recorder.on('backend-started', (payload) => this.emit('backend-started', payload));
    recorder.on('backend-stopped', (payload) => this.emit('backend-stopped', payload));
    recorder.on('stats', (payload) => this.emit('stats', payload));
    recorder.on('error', (payload) => this.emit('error', payload));
  }

  private async active(): Promise<ScreenRecorder> {
    if (this.activeBackend) return this.activeBackend;
    if (!this.resolution) this.initialize();
    return this.resolution as Promise<ScreenRecorder>;
  }

  async probe(): Promise<RecorderCapabilities> {
    const recorder = await this.active();
    const capabilities = await recorder.probe();

    // Si el backend preferido no puede grabar, probamos el otro antes de
    // rendirnos: es preferible grabar con FFmpeg que no grabar nada.
    if (!capabilities.available && recorder === this.overwolf) {
      log.warn('El grabador de Overwolf no esta operativo; se prueba FFmpeg');
      this.activeBackend = this.ffmpeg;
      this.forwardEvents(this.ffmpeg);
      return this.ffmpeg.probe();
    }
    return capabilities;
  }

  async isRecording(): Promise<boolean> {
    const recorder = this.activeBackend;
    return recorder ? recorder.isRecording() : false;
  }

  async start(request: StartRecordingRequest): Promise<StartRecordingResult> {
    const recorder = await this.active();
    try {
      return await recorder.start(request);
    } catch (err) {
      if (recorder === this.overwolf) {
        log.warn(
          `El grabador de Overwolf fallo (${(err as Error).message}); se reintenta con FFmpeg`,
        );
        this.activeBackend = this.ffmpeg;
        this.forwardEvents(this.ffmpeg);
        return this.ffmpeg.start(request);
      }
      throw err;
    }
  }

  async stop(): Promise<StopRecordingResult> {
    const recorder = this.activeBackend;
    if (!recorder) {
      return {
        filePath: null,
        durationMs: null,
        startTimeEpochMs: null,
        hasError: true,
        error: 'no hay backend activo',
      };
    }
    return recorder.stop();
  }

  dispose(): void {
    this.overwolf.dispose();
    this.ffmpeg.dispose();
    this.removeAllListeners();
  }
}
