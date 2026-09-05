/** Que fuentes de sonido debe mezclar la ventana durante una grabacion. */
export interface AudioCaptureRequest {
  /** Sonido del juego y del resto del sistema. */
  system: boolean;
  /** Voz del microfono predeterminado. */
  microphone: boolean;
}

/** Lo que la ventana consiguio capturar de verdad. */
export interface AudioCaptureResult {
  system: boolean;
  microphone: boolean;
  /** Motivo por el que no se pudo capturar el sonido del sistema, si fallo. */
  systemError?: string;
  /** Motivo por el que no se pudo capturar el microfono, si fallo. */
  microphoneError?: string;
}

/** Formato acordado entre la ventana y FFmpeg. No se negocia en tiempo real. */
export const AUDIO_FORMAT = {
  sampleRate: 48000,
  channels: 2,
  /** Muestras por bloque enviado. A 48 kHz son unos 85 ms. */
  blockSize: 4096,
} as const;
