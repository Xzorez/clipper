import type {
  AppSettings,
  ClipRecord,
  GameEvent,
  GameEventType,
  GameKey,
  LiveStatus,
  LogEntry,
  RecorderCapabilities,
  RecordingRecord,
  UpdateStatus,
} from './types';
import type { AudioCaptureRequest, AudioCaptureResult } from './audio';

export interface CreateClipRequest {
  recordingId: string;
  centerSeconds: number;
  secondsBefore?: number;
  secondsAfter?: number;
  /** Recorte exacto. Tiene prioridad sobre centro y margenes. */
  startSeconds?: number;
  endSeconds?: number;
  /** 'vertical' recorta a 9:16 para compartir desde el movil. */
  aspect?: 'original' | 'vertical';
  title?: string;
}

export interface WarningPayload {
  title: string;
  message: string;
}

/** Cancela una suscripcion. */
export type Unsubscribe = () => void;

/**
 * Contrato del puente entre el renderer y el proceso principal.
 *
 * Vive en `shared` a proposito: el renderer no debe importar nada del preload
 * (que usa modulos de Electron y de Node), y el preload debe cumplir este
 * contrato. Asi el compilador detecta cualquier divergencia entre ambos lados
 * sin que el renderer arrastre tipos que no le corresponden.
 */
export interface ClipperApi {
  getStatus(): Promise<LiveStatus>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: unknown): Promise<AppSettings>;
  probeRecorder(): Promise<RecorderCapabilities>;
  getLogs(): Promise<LogEntry[]>;
  getDiagnostics(): Promise<Record<string, unknown>>;
  restartAsAdmin(): Promise<{ instructions: string }>;

  startRecording(): Promise<LiveStatus>;
  stopRecording(): Promise<LiveStatus>;

  listRecordings(filter?: { game?: GameKey }): Promise<RecordingRecord[]>;
  getRecording(id: string): Promise<RecordingRecord>;
  getEvents(recordingId: string, types?: GameEventType[]): Promise<GameEvent[]>;
  deleteRecording(id: string, deleteFile: boolean): Promise<{ deleted: boolean }>;

  listClips(): Promise<ClipRecord[]>;
  createClip(request: CreateClipRequest): Promise<ClipRecord>;
  deleteClip(id: string, deleteFile: boolean): Promise<{ deleted: boolean }>;

  getUpdateStatus(): Promise<UpdateStatus>;
  /** Comprueba a mano si hay version nueva y devuelve el resultado. */
  checkForUpdate(): Promise<UpdateStatus>;
  /** Cierra la aplicacion y aplica la version ya descargada. */
  installUpdate(): Promise<boolean>;

  pickFolder(): Promise<string | null>;
  openPath(path: string): Promise<boolean>;
  revealPath(path: string): Promise<boolean>;

  /** Convierte una ruta local en una URL servida por el protocolo propio. */
  mediaUrl(path: string): string;

  onStatus(callback: (status: LiveStatus) => void): Unsubscribe;
  onEvent(callback: (event: GameEvent) => void): Unsubscribe;
  onLibraryChanged(callback: () => void): Unsubscribe;
  onWarning(callback: (warning: WarningPayload) => void): Unsubscribe;
  onLog(callback: (entry: LogEntry) => void): Unsubscribe;
  onUpdateStatus(callback: (status: UpdateStatus) => void): Unsubscribe;

  /** El proceso principal pide empezar a capturar sonido para una grabacion. */
  onAudioStart(callback: (request: AudioCaptureRequest) => void): Unsubscribe;
  onAudioStop(callback: () => void): Unsubscribe;
  /** Responde que fuentes se han podido abrir de verdad. */
  audioReady(result: AudioCaptureResult): void;
  /** Entrega un bloque de audio en crudo (PCM 16 bits, 48 kHz, estereo). */
  sendAudioChunk(chunk: ArrayBuffer): void;
}
