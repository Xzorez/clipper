import { VIDEO_CHUNK_MS, VIDEO_MIME, VideoCaptureRequest, VideoCaptureResult } from '@shared/video';
import { api } from './api';

interface ActiveCapture {
  stream: MediaStream;
  recorder: MediaRecorder;
}

let active: ActiveCapture | null = null;

/**
 * Captura de la ventana del juego.
 *
 * FFmpeg solo sabe capturar pantallas enteras: con ddagrab se graba todo lo
 * que hay delante, asi que al cambiar de ventana en mitad de la partida la
 * grabacion enseña el escritorio, el navegador y lo que haya. Chromium si sabe
 * capturar una ventana concreta, a traves de la API de captura de Windows, y
 * la sigue viendo aunque quede tapada.
 *
 * Es tambien la unica via honesta para esto: capturar solo el juego sin
 * inyectar nada en su proceso. Aqui no se toca el juego, se le pide a Windows
 * el contenido de una ventana.
 *
 * La ventana codifica ya en H.264 y manda trozos empaquetados; el proceso
 * principal se los pasa a FFmpeg, que los copia al MP4 sin recodificar.
 */
export function installVideoCapture(): void {
  api.onVideoStart((request) => {
    void start(request).then((result) => api.videoReady(result));
  });
  api.onVideoStop(() => stop());
}

async function start(request: VideoCaptureRequest): Promise<VideoCaptureResult> {
  stop();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // La forma de pedir una fuente de escritorio concreta en Electron. No
        // es un getUserMedia normal: `mandatory` es la via heredada que
        // entiende Chromium para esto.
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: request.sourceId,
          maxWidth: request.width,
          maxHeight: request.height,
          maxFrameRate: request.fps,
        },
      } as MediaTrackConstraints,
    });
  } catch (err) {
    const error = err as { name?: string; message?: string };
    return { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? ''}`.trim() };
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: 'la fuente no ha dado imagen' };
  }

  const settings = track.getSettings();

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: VIDEO_MIME,
      videoBitsPerSecond: request.bitrateKbps * 1000,
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, error: `no se puede codificar: ${(err as Error).message}` };
  }

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    void event.data.arrayBuffer().then((buffer) => api.sendVideoChunk(buffer));
  };

  // Si el juego se cierra, la pista muere sola: se corta aqui en vez de dejar
  // un grabador girando en vacio.
  track.addEventListener('ended', () => stop());

  recorder.start(VIDEO_CHUNK_MS);
  active = { stream, recorder };

  return { ok: true, width: settings.width, height: settings.height };
}

function stop(): void {
  if (!active) return;
  const { stream, recorder } = active;
  active = null;
  try {
    if (recorder.state !== 'inactive') recorder.stop();
  } catch {
    /* ya estaba parado */
  }
  stream.getTracks().forEach((track) => track.stop());
}
