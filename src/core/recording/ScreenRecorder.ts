import { EventEmitter } from 'node:events';
import { EncoderInfo, MonitorSummary, RecorderCapabilities, RecordingSettings } from '../../shared/types';

export interface StartRecordingRequest {
  /**
   * Tuberia de la que FFmpeg leera el sonido, o null para grabar sin audio.
   * La prepara quien sepa capturarlo; el grabador solo la consume.
   */
  audioPipePath?: string | null;
  /** Ruta de salida SIN extension: el backend anade la suya. */
  outputPathWithoutExt: string;
  settings: RecordingSettings;
  /** PID del proceso del juego, si se quiere captura de juego. */
  gamePid?: number;
  /** Nombre del ejecutable, alternativa al PID. */
  gameProcessName?: string;
  /** true si el juego corre elevado (obliga a captura de pantalla). */
  gameIsElevated?: boolean;
}

export interface StartRecordingResult {
  filePath: string;
  /** Encoder realmente utilizado. */
  encoder: string;
  resolution: string;
  fps: number;
}

export interface StopRecordingResult {
  filePath: string | null;
  /** Duracion en milisegundos segun el backend. */
  durationMs: number | null;
  /**
   * Epoch del primer frame del video. Clave para la reconciliacion del reloj.
   * Puede ser null si el backend no lo proporciona.
   */
  startTimeEpochMs: number | null;
  hasError: boolean;
  error?: string;
}

/**
 * Contrato de captura de video.
 *
 * Eventos:
 *   'started'  -> StartRecordingResult (el video ha empezado de verdad)
 *   'stopped'  -> StopRecordingResult
 *   'error'    -> Error
 *   'stats'    -> { cpuUsage, memoryUsage, availableDiskSpace }
 */
export interface ScreenRecorder extends EventEmitter {
  readonly backend: 'overwolf' | 'ffmpeg';
  /** Consulta capacidades: encoders disponibles, monitores, etc. */
  probe(): Promise<RecorderCapabilities>;
  isRecording(): Promise<boolean>;
  start(request: StartRecordingRequest): Promise<StartRecordingResult>;
  stop(): Promise<StopRecordingResult>;
  dispose(): void;
}

export interface RecorderStats {
  cpuUsage: number;
  memoryUsage: number;
  availableDiskSpace: number;
}

/**
 * Catalogo de encoders de OBS que expone el paquete recorder de Overwolf.
 * Los identificadores son los reales de OBS: verificados en la especificacion
 * de tipos (kSupportedEncodersTypes).
 */
export const ENCODER_CATALOG: Record<string, Omit<EncoderInfo, 'id'>> = {
  jim_nvenc: { label: 'NVIDIA NVENC H.264', hardware: true, vendor: 'nvidia' },
  jim_hevc_nvenc: { label: 'NVIDIA NVENC HEVC', hardware: true, vendor: 'nvidia' },
  jim_av1_nvenc: { label: 'NVIDIA NVENC AV1', hardware: true, vendor: 'nvidia' },
  h264_texture_amf: { label: 'AMD AMF H.264', hardware: true, vendor: 'amd' },
  h265_texture_amf: { label: 'AMD AMF HEVC', hardware: true, vendor: 'amd' },
  av1_texture_amf: { label: 'AMD AMF AV1', hardware: true, vendor: 'amd' },
  obs_qsv11_v2: { label: 'Intel Quick Sync H.264', hardware: true, vendor: 'intel' },
  obs_qsv11_hevc: { label: 'Intel Quick Sync HEVC', hardware: true, vendor: 'intel' },
  obs_qsv11_av1: { label: 'Intel Quick Sync AV1', hardware: true, vendor: 'intel' },
  obs_x264: { label: 'x264 (software)', hardware: false, vendor: 'software' },
  ffmpeg_svt_av1: { label: 'SVT-AV1 (software)', hardware: false, vendor: 'software' },
  ffmpeg_aom_av1: { label: 'AOM-AV1 (software)', hardware: false, vendor: 'software' },
};

/**
 * Prioridad de eleccion automatica de encoder.
 *
 * Se prefiere H.264 por hardware antes que HEVC/AV1 porque el objetivo es
 * reproducir el video despues dentro de la propia aplicacion (Chromium), y
 * H.264 en MP4 es el unico combo con reproduccion garantizada. Un AV1 grabado
 * a 1440p seria mas eficiente pero podria no reproducirse.
 */
export const ENCODER_PREFERENCE = [
  'jim_nvenc',
  'h264_texture_amf',
  'obs_qsv11_v2',
  'obs_x264',
];

export function describeEncoder(id: string): EncoderInfo {
  const known = ENCODER_CATALOG[id];
  if (known) return { id, ...known };
  return { id, label: id, hardware: false, vendor: 'unknown' };
}

/**
 * Elige el mejor encoder disponible respetando la preferencia del usuario.
 * Si el usuario ha fijado uno concreto y sigue disponible, se respeta.
 */
export function pickEncoder(available: string[], preferred: string): string | null {
  if (available.length === 0) return null;
  if (preferred && preferred !== 'auto' && available.includes(preferred)) {
    return preferred;
  }
  for (const candidate of ENCODER_PREFERENCE) {
    if (available.includes(candidate)) return candidate;
  }
  return available[0];
}

/**
 * Calcula la resolucion de salida a partir de la altura deseada,
 * conservando la relacion de aspecto del monitor de origen.
 * Se redondea a multiplo de 2 porque los encoders de video lo exigen.
 */
export function computeOutputSize(
  baseWidth: number,
  baseHeight: number,
  targetHeight: number,
): { width: number; height: number } {
  if (baseHeight <= 0 || baseWidth <= 0) {
    return { width: 1920, height: 1080 };
  }
  // Nunca escalamos hacia arriba: no aporta calidad y cuesta rendimiento.
  const height = Math.min(targetHeight, baseHeight);
  const ratio = baseWidth / baseHeight;
  const width = Math.round((height * ratio) / 2) * 2;
  return { width, height: Math.round(height / 2) * 2 };
}

/** Bitrate por defecto (kbps) segun resolucion y fps. */
export function defaultBitrate(height: number, fps: number): number {
  const base: Record<number, number> = { 720: 6000, 1080: 12000, 1440: 20000, 2160: 40000 };
  const closest = [720, 1080, 1440, 2160].reduce((prev, curr) =>
    Math.abs(curr - height) < Math.abs(prev - height) ? curr : prev,
  );
  const value = base[closest] ?? 12000;
  return fps > 60 ? Math.round(value * 1.5) : fps > 30 ? value : Math.round(value * 0.7);
}

export function selectMonitor(monitors: MonitorSummary[]): MonitorSummary | null {
  if (monitors.length === 0) return null;
  return monitors.find((m) => m.isPrimary) ?? monitors[0];
}
