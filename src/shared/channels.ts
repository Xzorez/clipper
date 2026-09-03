/** Nombres de canal IPC. Centralizados para que main y renderer no se desincronicen. */
export const IPC = {
  // Consultas (renderer -> main, con respuesta)
  GET_STATUS: 'clipper:get-status',
  GET_SETTINGS: 'clipper:get-settings',
  UPDATE_SETTINGS: 'clipper:update-settings',
  LIST_RECORDINGS: 'clipper:list-recordings',
  GET_RECORDING: 'clipper:get-recording',
  GET_EVENTS: 'clipper:get-events',
  DELETE_RECORDING: 'clipper:delete-recording',
  LIST_CLIPS: 'clipper:list-clips',
  CREATE_CLIP: 'clipper:create-clip',
  DELETE_CLIP: 'clipper:delete-clip',
  START_RECORDING: 'clipper:start-recording',
  STOP_RECORDING: 'clipper:stop-recording',
  PROBE_RECORDER: 'clipper:probe-recorder',
  PICK_FOLDER: 'clipper:pick-folder',
  OPEN_PATH: 'clipper:open-path',
  REVEAL_PATH: 'clipper:reveal-path',
  GET_LOGS: 'clipper:get-logs',
  GET_DIAGNOSTICS: 'clipper:get-diagnostics',
  RESTART_AS_ADMIN: 'clipper:restart-as-admin',

  // Notificaciones (main -> renderer)
  ON_STATUS: 'clipper:on-status',
  ON_EVENT: 'clipper:on-event',
  ON_LIBRARY_CHANGED: 'clipper:on-library-changed',
  ON_WARNING: 'clipper:on-warning',
  ON_LOG: 'clipper:on-log',
  ON_NAVIGATE: 'clipper:on-navigate',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
