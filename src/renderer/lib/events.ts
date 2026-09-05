import { GameEventType } from '@shared/types';

export interface EventVisual {
  icon: string;
  color: string;
  label: string;
  /** Si aparece como filtro propio en la timeline. */
  filterable: boolean;
}

/**
 * Presentacion de cada tipo de evento.
 * Un unico sitio para iconos, colores y etiquetas, de modo que la timeline,
 * la lista y la biblioteca no se contradigan nunca.
 */
export const EVENT_VISUALS: Record<GameEventType, EventVisual> = {
  [GameEventType.KILL]: { icon: '⚔️', color: 'var(--kill)', label: 'Kill', filterable: true },
  [GameEventType.DEATH]: { icon: '💀', color: 'var(--death)', label: 'Muerte', filterable: true },
  [GameEventType.HEADSHOT]: { icon: '🎯', color: 'var(--headshot)', label: 'Headshot', filterable: true },
  [GameEventType.ASSIST]: { icon: '🤝', color: 'var(--assist)', label: 'Asistencia', filterable: true },
  [GameEventType.KNOCKED_OUT]: { icon: '🩹', color: 'var(--knocked)', label: 'Derribado', filterable: true },
  [GameEventType.BOOKMARK]: { icon: '🔖', color: 'var(--bookmark)', label: 'Marcador', filterable: true },
  [GameEventType.HIGHLIGHT]: {
    icon: '✦',
    color: 'var(--highlight)',
    label: 'Destacado',
    filterable: true,
  },
  [GameEventType.RESPAWN]: { icon: '↻', color: 'var(--round)', label: 'Reaparicion', filterable: false },
  [GameEventType.MATCH_START]: { icon: '▶', color: 'var(--round)', label: 'Inicio de partida', filterable: false },
  [GameEventType.MATCH_END]: { icon: '⏹', color: 'var(--round)', label: 'Fin de partida', filterable: false },
  [GameEventType.ROUND_START]: { icon: '│', color: 'var(--round)', label: 'Inicio de ronda', filterable: false },
  [GameEventType.ROUND_END]: { icon: '│', color: 'var(--round)', label: 'Fin de ronda', filterable: false },
};

/** Tipos que se muestran por defecto en la timeline. */
export const DEFAULT_VISIBLE_TYPES: GameEventType[] = [
  GameEventType.KILL,
  GameEventType.DEATH,
  GameEventType.HEADSHOT,
  GameEventType.ASSIST,
  GameEventType.KNOCKED_OUT,
  GameEventType.BOOKMARK,
  GameEventType.HIGHLIGHT,
];

/** Agrupacion de "Otros" en los filtros. */
export const OTHER_TYPES: GameEventType[] = [
  GameEventType.RESPAWN,
  GameEventType.MATCH_START,
  GameEventType.MATCH_END,
  GameEventType.ROUND_START,
  GameEventType.ROUND_END,
];

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Formato largo con milisegundos, para tooltips y depuracion de sincronizacion. */
export function formatTimePrecise(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
  const total = Math.floor(seconds);
  const ms = Math.round((seconds - total) * 1000);
  return `${formatTime(total)}.${String(ms).padStart(3, '0')}`;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateShort(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}
