import { BrowserWindow, ipcMain } from 'electron';
import { AudioPipe } from '../core/recording/AudioPipe';
import { SystemAudioCapture } from '../core/recording/SystemAudioCapture';
import { AudioSource } from '../core/recording/RecordingManager';
import { AudioCaptureRequest, AudioCaptureResult } from '../shared/audio';
import { RecordingSettings } from '../shared/types';
import { IPC } from '../shared/channels';
import { createLogger } from '../core/logging/Logger';

const log = createLogger('Audio');

/** Margen para que la ventana abra los dispositivos antes de darlo por perdido. */
const READY_TIMEOUT_MS = 5000;

/**
 * Une la captura de sonido de la ventana con la tuberia que lee FFmpeg.
 *
 * El sonido no puede capturarlo el proceso principal: Windows no ofrece
 * ningun dispositivo de bucle y FFmpeg solo ve microfonos. Quien si puede es
 * Chromium, que sabe capturar lo que suena en el sistema. Por eso la ventana
 * hace la captura, mezcla las fuentes y manda el audio en crudo aqui, y aqui
 * se le entrega a FFmpeg.
 *
 * Todo el camino esta pensado para fallar hacia el lado seguro: si el sonido
 * no se puede capturar, la grabacion sigue adelante sin el. Perder el audio de
 * una partida es un fastidio; perder la partida entera, no.
 */
export class AudioBridge implements AudioSource {
  private pipe: AudioPipe | null = null;
  private capturing = false;
  private system: SystemAudioCapture | null = null;
  /**
   * Que representa lo que manda la ventana.
   *
   * Cuando el sonido del sistema lo captura el programa propio, la ventana
   * solo aporta el microfono y las dos cosas hay que sumarlas. Si no, la
   * ventana manda ya lo que haya conseguido mezclar.
   */
  private windowTrack: 'system' | 'mic' = 'system';

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.AUDIO_CHUNK, (_event, chunk: ArrayBuffer) => {
      if (this.pipe) this.pipe.write(Buffer.from(chunk), this.windowTrack);
    });
  }

  async begin(settings: RecordingSettings): Promise<string | null> {
    const request: AudioCaptureRequest = {
      system: settings.captureSystemAudio,
      microphone: settings.captureMicrophone,
    };
    if (!request.system && !request.microphone) return null;

    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      log.warn('No hay ventana disponible: se grabara sin sonido');
      return null;
    }

    const pipe = new AudioPipe();
    try {
      await pipe.start();
    } catch (err) {
      log.warn(`No se pudo abrir la tuberia de audio: ${(err as Error).message}`);
      return null;
    }

    // El sonido del sistema, por la via directa de Windows. Se intenta antes
    // que la ventana porque es la que funciona: el bucle de Chromium falla en
    // algunas maquinas sin nada que se pueda hacer desde aqui.
    let systemOk = false;
    if (request.system && SystemAudioCapture.isAvailable()) {
      const capture = new SystemAudioCapture();
      if (capture.start()) {
        capture.on('data', (chunk: Buffer) => this.pipe?.write(chunk, 'system'));
        this.system = capture;
        systemOk = true;
      }
    }

    // A la ventana solo se le pide lo que falte.
    const fromWindow: AudioCaptureRequest = {
      system: request.system && !systemOk,
      microphone: request.microphone,
    };
    this.windowTrack = systemOk ? 'mic' : 'system';

    const result = fromWindow.system || fromWindow.microphone
      ? await this.askWindowToCapture(window, fromWindow)
      : { system: false, microphone: false };

    if (systemOk) {
      this.pipe = pipe;
      this.capturing = fromWindow.microphone && Boolean(result?.microphone);
      log.info(
        `Capturando sonido (sistema: si, microfono: ${result?.microphone ? 'si' : 'no'})`,
      );
      return pipe.path;
    }

    if (!result || (!result.system && !result.microphone)) {
      // Nada que enviar: se cierra la tuberia para que FFmpeg no espere una
      // pista de audio que no va a llegar nunca.
      await pipe.close();
      const reasons = [result?.systemError, result?.microphoneError].filter(Boolean).join('; ');
      log.warn(`Sin captura de sonido${reasons ? `: ${reasons}` : ''}. Se graba solo video.`);
      return null;
    }

    if (request.system && !result.system) {
      log.warn(`Sin sonido del sistema (${result.systemError ?? 'motivo desconocido'})`);
    }
    if (request.microphone && !result.microphone) {
      log.warn(`Sin microfono (${result.microphoneError ?? 'motivo desconocido'})`);
    }

    this.pipe = pipe;
    this.capturing = true;
    log.info(
      `Capturando sonido (sistema: ${result.system ? 'si' : 'no'}, ` +
        `microfono: ${result.microphone ? 'si' : 'no'})`,
    );
    return pipe.path;
  }

  async end(): Promise<void> {
    if (this.system) {
      if (this.system.bytesCaptured === 0) {
        log.warn('El capturador de sonido del sistema no llego a captar nada');
      }
      this.system.stop();
      this.system = null;
    }
    if (this.capturing) {
      const window = this.getWindow();
      if (window && !window.isDestroyed()) window.webContents.send(IPC.ON_AUDIO_STOP, null);
      this.capturing = false;
    }
    if (this.pipe) {
      if (this.pipe.paddedSilenceMs > 0) {
        log.info(`Se rellenaron ${this.pipe.paddedSilenceMs} ms de silencio por huecos de audio`);
      }
      await this.pipe.close();
      this.pipe = null;
    }
  }

  /**
   * Pide la captura a la ventana y espera su confirmacion.
   *
   * Con un limite de tiempo: si la ventana no contesta (pestana bloqueada,
   * dialogo del sistema), la grabacion no se queda esperando indefinidamente.
   */
  private askWindowToCapture(
    window: BrowserWindow,
    request: AudioCaptureRequest,
  ): Promise<AudioCaptureResult | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: AudioCaptureResult | null) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener(IPC.AUDIO_READY, onReady);
        resolve(value);
      };
      const onReady = (_event: unknown, result: AudioCaptureResult) => finish(result);

      ipcMain.once(IPC.AUDIO_READY, onReady);
      window.webContents.send(IPC.ON_AUDIO_START, request);
      setTimeout(() => {
        log.warn('La ventana no ha confirmado la captura de sonido a tiempo');
        finish(null);
      }, READY_TIMEOUT_MS);
    });
  }
}
