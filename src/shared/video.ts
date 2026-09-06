/** Peticion de captura de la ventana de un juego. */
export interface VideoCaptureRequest {
  /** Identificador de la fuente que da desktopCapturer. */
  sourceId: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

export interface VideoCaptureResult {
  ok: boolean;
  /** Tamano real de la ventana capturada, que manda sobre el pedido. */
  width?: number;
  height?: number;
  error?: string;
}

/**
 * Contenedor con el que la ventana entrega el video ya codificado.
 *
 * Matroska y no MP4 porque se transmite en directo por una tuberia: el MP4
 * necesita saber al final donde queda cada cosa, y matroska no. Dentro va
 * H.264, que es lo que ya grabamos, asi que FFmpeg lo copia tal cual sin
 * recodificar.
 */
export const VIDEO_MIME = 'video/x-matroska;codecs=avc1';
/** Cada cuanto entrega la ventana un trozo de video, en milisegundos. */
export const VIDEO_CHUNK_MS = 250;
