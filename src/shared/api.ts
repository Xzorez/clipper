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
} from './types';

export interface CreateClipRequest {
  recordingId: string;
  centerSeconds: number;
  secondsBefore?: number;
  secondsAfter?: number;
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
}
