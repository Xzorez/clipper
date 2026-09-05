import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/channels';
import type { AudioCaptureRequest, AudioCaptureResult } from '../shared/audio';
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
} from '../shared/types';
import type { ClipperApi, CreateClipRequest } from '../shared/api';

/** Respuesta uniforme de todos los manejadores IPC. */
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Desenvuelve la respuesta y convierte el fallo en una excepcion con el
 * mensaje original, ya redactado en castellano por el proceso principal.
 */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * Superficie expuesta al renderer.
 *
 * Es deliberadamente estrecha: contextIsolation esta activo y nodeIntegration
 * desactivado, asi que el renderer no tiene acceso a Node ni a Electron. Todo
 * lo que puede hacer esta enumerado aqui.
 */
const api: ClipperApi = {
  getStatus: () => call<LiveStatus>(IPC.GET_STATUS),
  getSettings: () => call<AppSettings>(IPC.GET_SETTINGS),
  updateSettings: (patch: unknown) => call<AppSettings>(IPC.UPDATE_SETTINGS, patch),
  probeRecorder: () => call<RecorderCapabilities>(IPC.PROBE_RECORDER),
  getLogs: () => call<LogEntry[]>(IPC.GET_LOGS),
  getDiagnostics: () => call<Record<string, unknown>>(IPC.GET_DIAGNOSTICS),
  restartAsAdmin: () => call<{ instructions: string }>(IPC.RESTART_AS_ADMIN),

  startRecording: () => call<LiveStatus>(IPC.START_RECORDING),
  stopRecording: () => call<LiveStatus>(IPC.STOP_RECORDING),

  listRecordings: (filter?: { game?: GameKey }) =>
    call<RecordingRecord[]>(IPC.LIST_RECORDINGS, filter ?? {}),
  getRecording: (id: string) => call<RecordingRecord>(IPC.GET_RECORDING, id),
  getEvents: (recordingId: string, types?: GameEventType[]) =>
    call<GameEvent[]>(IPC.GET_EVENTS, { recordingId, types }),
  deleteRecording: (id: string, deleteFile: boolean) =>
    call<{ deleted: boolean }>(IPC.DELETE_RECORDING, { id, deleteFile }),

  listClips: () => call<ClipRecord[]>(IPC.LIST_CLIPS),
  createClip: (request: CreateClipRequest) => call<ClipRecord>(IPC.CREATE_CLIP, request),
  deleteClip: (id: string, deleteFile: boolean) =>
    call<{ deleted: boolean }>(IPC.DELETE_CLIP, { id, deleteFile }),

  getUpdateStatus: () => call<UpdateStatus>(IPC.GET_UPDATE_STATUS),
  checkForUpdate: () => call<UpdateStatus>(IPC.CHECK_UPDATE),
  installUpdate: () => call<boolean>(IPC.INSTALL_UPDATE),

  pickFolder: () => call<string | null>(IPC.PICK_FOLDER),
  openPath: (path: string) => call<boolean>(IPC.OPEN_PATH, path),
  revealPath: (path: string) => call<boolean>(IPC.REVEAL_PATH, path),

  /**
   * Convierte una ruta local en una URL servida por el protocolo propio.
   * El proceso principal valida que la ruta este dentro de las carpetas
   * gestionadas antes de servirla.
   */
  mediaUrl: (path: string) => `clipper-media://local/${encodeURIComponent(path)}`,

  onStatus: (cb: (status: LiveStatus) => void) => subscribe(IPC.ON_STATUS, cb),
  onEvent: (cb: (event: GameEvent) => void) => subscribe(IPC.ON_EVENT, cb),
  onLibraryChanged: (cb: () => void) => subscribe(IPC.ON_LIBRARY_CHANGED, cb),
  onWarning: (cb: (warning: { title: string; message: string }) => void) =>
    subscribe(IPC.ON_WARNING, cb),
  onLog: (cb: (entry: LogEntry) => void) => subscribe(IPC.ON_LOG, cb),
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => subscribe(IPC.ON_UPDATE_STATUS, cb),

  onAudioStart: (cb: (request: AudioCaptureRequest) => void) => subscribe(IPC.ON_AUDIO_START, cb),
  onAudioStop: (cb: () => void) => subscribe(IPC.ON_AUDIO_STOP, cb),
  audioReady: (result: AudioCaptureResult) => ipcRenderer.send(IPC.AUDIO_READY, result),
  sendAudioChunk: (chunk: ArrayBuffer) => ipcRenderer.send(IPC.AUDIO_CHUNK, chunk),
};

contextBridge.exposeInMainWorld('clipper', api);
