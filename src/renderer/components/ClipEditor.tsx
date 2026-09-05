import { useMemo } from 'react';
import { GameEvent } from '@shared/types';
import { EVENT_VISUALS, formatTime } from '../lib/events';

export type ClipAspect = 'original' | 'vertical';

export interface ClipDraft {
  start: number;
  end: number;
}

/** Lo minimo que puede durar un clip para que valga de algo. */
const MIN_LENGTH = 1;
/** Hueco maximo entre dos momentos para considerarlos la misma racha. */
const STREAK_GAP = 20;

/**
 * Rango que cubre la racha a la que pertenece un instante.
 *
 * Una jugada buena rara vez es un solo evento: son tres kills seguidas. Se
 * agrupan los momentos separados por menos de veinte segundos y se devuelve
 * de la primera a la ultima, con un poco de aire a los lados.
 */
export function streakAround(events: GameEvent[], at: number): ClipDraft | null {
  const sorted = [...events].sort((a, b) => a.videoTime - b.videoTime);
  if (sorted.length === 0) return null;

  let start = -1;
  let end = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (start < 0) start = i;
    const next = sorted[i + 1];
    if (!next || next.videoTime - sorted[i].videoTime > STREAK_GAP) {
      end = i;
      if (sorted[start].videoTime - STREAK_GAP <= at && at <= sorted[end].videoTime + STREAK_GAP) {
        return { start: Math.max(0, sorted[start].videoTime - 6), end: sorted[end].videoTime + 5 };
      }
      start = -1;
    }
  }
  return null;
}

/**
 * Editor de recorte, en el lateral del reproductor.
 *
 * Dos flujos a la vez, a proposito. Arriba el ajuste fino: se lleva el video
 * al punto exacto y se fija ahi el principio o el final, que es mas preciso
 * que arrastrar un tirador porque se ve el fotograma mientras se decide.
 * Abajo, los de un clic, para cuando no hay nada que ajustar y lo unico que
 * se quiere es guardar lo que acaba de pasar.
 */
export function ClipEditor({
  duration,
  draft,
  currentTime,
  events,
  busy,
  aspect,
  onAspect,
  onChange,
  onSeek,
  onExport,
}: {
  duration: number;
  draft: ClipDraft;
  currentTime: number;
  events: GameEvent[];
  busy: boolean;
  aspect: ClipAspect;
  onAspect: (aspect: ClipAspect) => void;
  onChange: (draft: ClipDraft) => void;
  onSeek: (seconds: number) => void;
  onExport: () => void;
}) {
  const length = Math.max(0, draft.end - draft.start);
  const valid = length >= MIN_LENGTH;
  const pct = (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0);

  /** El momento mas cercano al centro del recorte, para titular el clip. */
  const nearest = useMemo(() => {
    const center = (draft.start + draft.end) / 2;
    let best: GameEvent | null = null;
    for (const event of events) {
      if (!best || Math.abs(event.videoTime - center) < Math.abs(best.videoTime - center)) {
        best = event;
      }
    }
    return best && Math.abs(best.videoTime - center) < 30 ? best : null;
  }, [events, draft]);

  const setEdge = (edge: 'start' | 'end', value: number) => {
    if (edge === 'start') {
      const start = Math.max(0, Math.min(value, draft.end - MIN_LENGTH));
      onChange({ ...draft, start });
    } else {
      const end = Math.min(duration, Math.max(value, draft.start + MIN_LENGTH));
      onChange({ ...draft, end });
    }
  };

  const quick: Array<{ label: string; key: string; color: string; range: ClipDraft | null }> = [
    {
      label: 'Ultimos 30 s',
      key: 'F8',
      color: 'var(--accent)',
      range: { start: Math.max(0, currentTime - 30), end: currentTime },
    },
    {
      label: 'Este momento ± 12 s',
      key: '↵',
      color: nearest ? EVENT_VISUALS[nearest.type].color : 'var(--round)',
      range: nearest
        ? {
            start: Math.max(0, nearest.videoTime - 12),
            end: Math.min(duration, nearest.videoTime + 12),
          }
        : null,
    },
    {
      label: 'Toda la racha',
      key: '⇧F8',
      color: 'var(--kill)',
      range: streakAround(events, (draft.start + draft.end) / 2),
    },
  ];

  return (
    <aside className="aside">
      <div className="aside__head">
        <span className="eyebrow">Editor de clip</span>
        <span className="aside__len">{formatTime(length)}</span>
      </div>

      <div className="aside__body">
        <div className="trim">
          <span className="trim__title">
            {nearest
              ? `${EVENT_VISUALS[nearest.type].label} · ${formatTime(nearest.videoTime)}`
              : `Desde ${formatTime(draft.start)}`}
          </span>

          <div className="trim__fields">
            <label className="field">
              <span className="field__l">Inicio</span>
              <input
                type="text"
                value={formatTime(draft.start)}
                readOnly
                onClick={() => onSeek(draft.start)}
                title="Pulsa para ir al principio del recorte"
              />
            </label>
            <label className="field">
              <span className="field__l">Fin</span>
              <input
                type="text"
                value={formatTime(draft.end)}
                readOnly
                onClick={() => onSeek(draft.end)}
                title="Pulsa para ir al final del recorte"
              />
            </label>
          </div>

          <div
            className="trim__strip"
            title="Pulsa para mover el video dentro de la grabacion"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - rect.left) / rect.width) * duration);
            }}
          >
            <div
              className="trim__sel"
              style={{ left: `${pct(draft.start)}%`, width: `${pct(length)}%` }}
            />
            <div className="trim__cursor" style={{ left: `${pct(currentTime)}%` }} />
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn--ghost btn--sm" onClick={() => setEdge('start', currentTime)}>
              Inicio aqui
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setEdge('end', currentTime)}>
              Fin aqui
            </button>
          </div>

          <div className="seg">
            <button className={aspect === 'original' ? 'on' : ''} onClick={() => onAspect('original')}>
              Original
            </button>
            <button
              className={aspect === 'vertical' ? 'on' : ''}
              onClick={() => onAspect('vertical')}
              title="Recorta a 9:16 para mandarlo por el movil"
            >
              Vertical
            </button>
          </div>

          <button className="btn btn--wide" disabled={busy || !valid} onClick={onExport}>
            {busy ? 'Guardando...' : 'Guardar clip'}
          </button>

          {!valid && (
            <span className="field__l" style={{ color: 'var(--warn)' }}>
              El clip tiene que durar al menos un segundo.
            </span>
          )}
        </div>

        <div className="quick">
          <span className="eyebrow" style={{ letterSpacing: '0.16em' }}>
            Un clic
          </span>
          <div className="quick__list">
            {quick.map((item) => (
              <button
                key={item.label}
                className="quick__row"
                disabled={!item.range}
                title={item.range ? undefined : 'No hay ningun momento cerca'}
                onClick={() => item.range && onChange(item.range)}
              >
                <span className="quick__dot" style={{ background: item.color }} />
                <span className="quick__l">{item.label}</span>
                <span className="quick__k">{item.key}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
