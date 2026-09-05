/**
 * Modelo de dominio compartido entre proceso principal y renderer.
 * Este fichero NO debe importar nada de Electron ni de Node: se usa en ambos lados.
 */

/** Juegos soportados por la aplicacion. */
export type GameKey = 'valorant' | 'rainbowsix' | 'lol';

/**
 * IDs reales de Overwolf GEP.
 * Fuente: @overwolf/ow-electron-packages-types/gep-supported-games.d.ts (kGepSupportedGameIds).
 */
export const GEP_GAME_IDS: Record<GameKey, number> = {
  valorant: 21640,
  rainbowsix: 10826,
  lol: 5426,
};

/** IDs adicionales que deben mapearse al mismo adaptador (p.ej. el PBE de LoL). */
export const GEP_GAME_ID_ALIASES: Record<number, GameKey> = {
  21640: 'valorant',
  10826: 'rainbowsix',
  5426: 'lol',
  22848: 'lol', // LeagueofLegendsPBE
};

export const GAME_DISPLAY_NAMES: Record<GameKey, string> = {
  valorant: 'VALORANT',
  rainbowsix: 'Rainbow Six Siege',
  lol: 'League of Legends',
};

/**
 * Tipos de evento normalizados. Cada adaptador traduce los eventos
 * especificos de su juego a este conjunto comun.
 */
export enum GameEventType {
  KILL = 'KILL',
  DEATH = 'DEATH',
  HEADSHOT = 'HEADSHOT',
  ASSIST = 'ASSIST',
  KNOCKED_OUT = 'KNOCKED_OUT',
  RESPAWN = 'RESPAWN',
  MATCH_START = 'MATCH_START',
  MATCH_END = 'MATCH_END',
  ROUND_START = 'ROUND_START',
  ROUND_END = 'ROUND_END',
  BOOKMARK = 'BOOKMARK',
}

/** Orden de prioridad visual en la timeline cuando varios eventos colisionan. */
export const EVENT_PRIORITY: Record<GameEventType, number> = {
  [GameEventType.DEATH]: 100,
  [GameEventType.KILL]: 90,
  [GameEventType.HEADSHOT]: 85,
  [GameEventType.KNOCKED_OUT]: 80,
  [GameEventType.ASSIST]: 70,
  [GameEventType.BOOKMARK]: 60,
  [GameEventType.MATCH_START]: 50,
  [GameEventType.MATCH_END]: 50,
  [GameEventType.ROUND_START]: 20,
  [GameEventType.ROUND_END]: 20,
  [GameEventType.RESPAWN]: 10,
};

/**
 * Evento de juego normalizado.
 *
 * Sobre los tiempos:
 * - `timestamp`  : instante absoluto (epoch ms). Util para depurar y correlacionar.
 * - `monotonicNs`: reloj monotonico en nanosegundos. Es la fuente de verdad para
 *                  calcular `videoTime`, porque no se ve afectado por cambios de
 *                  hora del sistema, NTP ni cambios de horario de verano.
 * - `videoTime`  : segundos desde el primer frame del video. Se calcula al vuelo y
 *                  se REAJUSTA al terminar la grabacion (ver RecordingClock).
 */
export interface GameEvent {
  id: string;
  game: GameKey;
  type: GameEventType;
  /** Epoch en milisegundos del instante en que se recibio el evento. */
  timestamp: number;
  /** Reloj monotonico (ns, como string para no perder precision en JSON). */
  monotonicNs: string;
  /** Segundos desde el inicio del video. Puede ser negativo si el evento precede al video. */
  videoTime: number;
  /** true si el evento ocurrio antes del primer frame (se conserva pero no se dibuja). */
  beforeRecording?: boolean;
  metadata?: Record<string, unknown>;
}

/** Estados del detector de juego. */
export enum DetectionState {
  IDLE = 'IDLE',
  GAME_DETECTED = 'GAME_DETECTED',
  RECORDING = 'RECORDING',
  GAME_ENDED = 'GAME_ENDED',
  ERROR = 'ERROR',
}

/** Estado de la conexion con el proveedor de eventos. */
export type EventProviderStatus =
  | 'unavailable'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'elevation-required'
  | 'error';

export interface ProviderState {
  status: EventProviderStatus;
  /** Nombre del proveedor activo: 'gep' | 'riot-live-client' | 'none'. */
  provider: string;
  message?: string;
  /** true si el juego corre elevado y nosotros no. */
  elevationRequired?: boolean;
}

export interface EncoderInfo {
  id: string;
  label: string;
  hardware: boolean;
  vendor: 'nvidia' | 'amd' | 'intel' | 'software' | 'unknown';
}

export interface MonitorSummary {
  id: string;
  name: string;
  isPrimary: boolean;
  width: number;
  height: number;
  refreshRate: number;
}

export interface RecorderCapabilities {
  /**
   * En que punto esta la deteccion del sistema de captura.
   *
   * Hace falta distinguir "todavia no lo se" de "no hay nada": al arrancar se
   * espera unos segundos a que cargue el paquete de Overwolf, y durante esa
   * espera no se puede afirmar que no haya sistema de captura. Confundir ambos
   * estados hacia que la interfaz mostrara un error alarmante en un arranque
   * perfectamente normal.
   */
  status: 'checking' | 'ready' | 'unavailable';
  available: boolean;
  backend: 'overwolf' | 'ffmpeg' | 'none';
  encoders: EncoderInfo[];
  monitors: MonitorSummary[];
  message?: string;
}

export interface RecordingSummary {
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  knockedOut: number;
  rounds: number;
}

export interface RecordingRecord {
  id: string;
  game: GameKey;
  filePath: string;
  thumbnailPath: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Duracion en segundos. */
  duration: number | null;
  resolution: string | null;
  fps: number | null;
  encoder: string | null;
  status: 'recording' | 'completed' | 'recovered' | 'failed';
  createdAt: number;
  summary?: RecordingSummary;
  eventCount?: number;
  /** true si el fichero de video ya no existe en disco. */
  missingFile?: boolean;
}

export interface ClipRecord {
  id: string;
  recordingId: string;
  filePath: string;
  thumbnailPath: string | null;
  title: string;
  /** Offsets dentro de la grabacion original, en segundos. */
  startTime: number;
  endTime: number;
  createdAt: number;
  game: GameKey;
  missingFile?: boolean;
}

/** Estado en vivo que el renderer pinta durante una partida. */
export interface LiveStatus {
  state: DetectionState;
  game: GameKey | null;
  gameName: string | null;
  recordingId: string | null;
  /** Segundos transcurridos de grabacion. */
  elapsed: number;
  summary: RecordingSummary;
  provider: ProviderState;
  recorder: RecorderCapabilities;
  lastError: string | null;
  diskFreeGb: number | null;
}

// ---------------------------------------------------------------------------
// Configuracion
// ---------------------------------------------------------------------------

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';
export type CaptureMode = 'game' | 'display';

export interface RecordingSettings {
  autoRecord: boolean;
  quality: QualityPreset;
  /** Altura de salida. La anchura se deriva del ratio del monitor. */
  resolution: 720 | 1080 | 1440 | 2160;
  fps: 30 | 60 | 120;
  /** kbps */
  bitrate: number;
  /** 'auto' elige el mejor encoder por hardware disponible. */
  encoder: string;
  captureMode: CaptureMode;
  outputFolder: string;
  captureMicrophone: boolean;
  captureSystemAudio: boolean;
  /** GB minimos libres para permitir iniciar una grabacion. */
  minFreeSpaceGb: number;
  /** GB por debajo de los cuales se detiene la grabacion en curso de forma segura. */
  stopAtFreeSpaceGb: number;
}

export interface EventSettings {
  detectKills: boolean;
  detectDeaths: boolean;
  detectHeadshots: boolean;
  detectAssists: boolean;
  detectRounds: boolean;
  /**
   * Compensacion de latencia del proveedor, en milisegundos.
   * GEP detecta el evento unos instantes DESPUES de que ocurra en pantalla,
   * asi que restamos este valor para centrar el marcador. Calibrable por juego.
   */
  latencyOffsetMs: Record<GameKey, number>;
  /**
   * Desfase, en milisegundos, entre el instante que marca un fichero de
   * repeticion de Rainbow Six y el momento en que empieza a contar el reloj de
   * la ronda (la fase de preparacion). Es una constante por modo de juego que
   * solo se puede determinar comparando con una grabacion real, asi que se deja
   * calibrable en lugar de adivinarla.
   */
  r6RoundOffsetMs: number;
}

export interface UiSettings {
  theme: 'dark' | 'light';
  showIcons: boolean;
  showLabels: boolean;
  iconSize: 'small' | 'medium' | 'large';
  /** Segundos antes del evento a los que salta el reproductor al hacer clic. */
  playFromSecondsBefore: number;
  playFromBeforeEnabled: boolean;
}

export interface ClipSettings {
  secondsBefore: number;
  secondsAfter: number;
}

export interface HotkeySettings {
  saveClip: string;
  bookmark: string;
  toggleRecording: string;
}

export interface AppSettings {
  recording: RecordingSettings;
  events: EventSettings;
  ui: UiSettings;
  clips: ClipSettings;
  hotkeys: HotkeySettings;
  games: Record<GameKey, boolean>;
}

/** Sidecar JSON que acompana a cada .mp4 (el recording.json del enunciado). */
export interface RecordingSidecar {
  version: number;
  recordingId: string;
  game: GameKey;
  startTime: string;
  startTimeEpochMs: number;
  endTime?: string;
  duration?: number;
  resolution?: string;
  fps?: number;
  encoder?: string;
  video: string;
  status: RecordingRecord['status'];
  events: Array<{
    id: string;
    type: GameEventType;
    timestamp: number;
    videoTime: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface LogEntry {
  time: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
}

/** Estado inicial: aun no se sabe con que se va a capturar. */
export function emptyRecorderCapabilities(): RecorderCapabilities {
  return { status: 'checking', available: false, backend: 'none', encoders: [], monitors: [] };
}

/** Estado del actualizador automatico, tal como lo ve la ventana. */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'unavailable'
  | 'disabled'
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  /** Version disponible o descargada, segun el estado. */
  version?: string;
  /** Porcentaje descargado, cuando esta en curso. */
  progress?: number;
  /** Motivo del fallo. Solo se rellena si alguien pidio comprobar a mano. */
  error?: string;
  /** Version que se esta ejecutando ahora mismo. */
  current: string;
}
