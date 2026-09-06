import { BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import { MediaPipe } from '../core/recording/MediaPipe';
import { VideoCaptureRequest, VideoCaptureResult } from '../shared/video';
import { IPC } from '../shared/channels';
import { createLogger } from '../core/logging/Logger';

const log = createLogger('Recording');

/** Margen para que la ventana abra la captura antes de darla por perdida. */
const READY_TIMEOUT_MS = 8000;

export interface GameCapture {
  /** Ruta de la tuberia por la que FFmpeg leera el video. */
  pipePath: string;
  width: number;
  height: number;
}

/**
 * Busca la ventana de un juego entre las que Windows deja capturar.
 *
 * Se compara por titulo porque es lo unico que da la API: el nombre visible de
 * la ventana. Se descartan las ventanas de la propia aplicacion para no
 * acabar grabandonos a nosotros mismos, que ademas daria un efecto de espejo
 * infinito.
 */
export function findGameWindow(
  windows: Array<{ id: string; name: string }>,
  candidates: string[],
): string | null {
  const wanted = candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length >= 3);
  if (wanted.length === 0) return null;

  for (const window of windows) {
    const name = window.name.trim().toLowerCase();
    if (!name || name === 'clipper') continue;
    if (wanted.some((c) => name === c || name.startsWith(c) || c.startsWith(name))) {
      return window.id;
    }
  }
  return null;
}

/**
 * Captura de la ventana del juego, en lugar de la pantalla entera.
 *
 * FFmpeg solo sabe capturar pantallas: con ddagrab la grabacion enseña todo lo
 * que haya delante, asi que al cambiar de ventana en mitad de la partida sale
 * el escritorio y lo que se estuviera abriendo. Chromium si sabe capturar una
 * ventana concreta y la sigue viendo aunque quede tapada, usando la API de
 * captura de Windows: sin inyectar nada en el juego ni tocar su proceso.
 *
 * Falla hacia el lado seguro. Si no encuentra la ventana, si la ventana no
 * contesta o si no llega imagen, devuelve null y el grabador se queda con la
 * captura de pantalla de siempre. Es preferible grabar de mas que no grabar.
 */
export class VideoBridge {
  private pipe: MediaPipe | null = null;
  private capturing = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on(IPC.VIDEO_CHUNK, (_event, chunk: ArrayBuffer) => {
      if (this.pipe) this.pipe.write(Buffer.from(chunk));
    });
  }

  /**
   * Prepara la captura de la ventana del juego.
   *
   * `candidates` son los nombres por los que puede aparecer: el nombre del
   * juego detectado y el de su proceso.
   */
  async begin(params: {
    candidates: string[];
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  }): Promise<GameCapture | null> {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return null;

    let sourceId: string | null = null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        // Sin miniaturas: solo hacen falta los nombres, y generarlas para cada
        // ventana abierta cuesta tiempo justo cuando arranca la partida.
        thumbnailSize: { width: 0, height: 0 },
      });
      sourceId = findGameWindow(sources, params.candidates);
    } catch (err) {
      log.warn(`No se han podido listar las ventanas: ${(err as Error).message}`);
      return null;
    }

    if (!sourceId) {
      log.info(
        `No se ha encontrado la ventana de ${params.candidates[0] ?? 'el juego'}; ` +
          'se graba la pantalla',
      );
      return null;
    }

    const pipe = new MediaPipe();
    try {
      await pipe.start();
    } catch (err) {
      log.warn(`No se pudo abrir la tuberia de video: ${(err as Error).message}`);
      return null;
    }

    const request: VideoCaptureRequest = {
      sourceId,
      width: params.width,
      height: params.height,
      fps: params.fps,
      bitrateKbps: params.bitrateKbps,
    };

    const result = await this.ask(window, request);
    if (!result?.ok) {
      await pipe.close();
      log.warn(
        `La captura de la ventana no ha arrancado (${result?.error ?? 'sin respuesta'}); ` +
          'se graba la pantalla',
      );
      return null;
    }

    this.pipe = pipe;
    this.capturing = true;
    const width = result.width ?? params.width;
    const height = result.height ?? params.height;
    log.info(`Capturando la ventana del juego a ${width}x${height}`);
    return { pipePath: pipe.path, width, height };
  }

  async end(): Promise<void> {
    if (this.capturing) {
      const window = this.getWindow();
      if (window && !window.isDestroyed()) window.webContents.send(IPC.ON_VIDEO_STOP, null);
      this.capturing = false;
    }
    if (this.pipe) {
      if (this.pipe.bytesWritten === 0) {
        log.warn('La captura de la ventana no llego a entregar imagen');
      }
      await this.pipe.close();
      this.pipe = null;
    }
  }

  private ask(
    window: BrowserWindow,
    request: VideoCaptureRequest,
  ): Promise<VideoCaptureResult | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: VideoCaptureResult | null) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener(IPC.VIDEO_READY, onReady);
        resolve(value);
      };
      const onReady = (_event: unknown, result: VideoCaptureResult) => finish(result);

      ipcMain.once(IPC.VIDEO_READY, onReady);
      window.webContents.send(IPC.ON_VIDEO_START, request);
      setTimeout(() => finish(null), READY_TIMEOUT_MS);
    });
  }
}
