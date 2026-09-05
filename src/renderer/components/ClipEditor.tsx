import { useCallback, useEffect, useState } from 'react';
import { formatTime } from '../lib/events';

export type ClipAspect = 'original' | 'vertical';

/** Lo minimo que puede durar un clip para que valga de algo. */
const MIN_LENGTH = 1;

export interface ClipDraft {
  start: number;
  end: number;
}

/**
 * Ajuste del principio y el final de un clip antes de exportarlo.
 *
 * Antes un clip eran diez segundos antes y cinco despues, siempre. Sirve para
 * una kill suelta y no sirve para nada mas: una jugada larga se queda cortada
 * y un momento breve arrastra medio minuto de nada.
 *
 * El ajuste se hace llevando el video al punto exacto y fijando ahi el
 * principio o el final, en lugar de arrastrando un tirador diminuto. Es mas
 * preciso, porque se ve el fotograma mientras se decide, y funciona igual de
 * bien en una grabacion de veinte minutos que en una de dos.
 */
export function ClipEditor({
  duration,
  draft,
  currentTime,
  busy,
  onChange,
  onSeek,
  onCancel,
  onExport,
}: {
  duration: number;
  draft: ClipDraft;
  currentTime: number;
  busy: boolean;
  onChange: (draft: ClipDraft) => void;
  onSeek: (seconds: number) => void;
  onCancel: () => void;
  onExport: (aspect: ClipAspect) => void;
}) {
  const [aspect, setAspect] = useState<ClipAspect>('original');

  const length = Math.max(0, draft.end - draft.start);
  const valid = length >= MIN_LENGTH;

  const setStartHere = useCallback(() => {
    // El principio nunca puede pasarse del final: se empuja el final si hace
    // falta, en lugar de rechazar la accion y dejar a nadie sin saber por que.
    const start = Math.min(currentTime, duration - MIN_LENGTH);
    onChange({ start: Math.max(0, start), end: Math.max(draft.end, start + MIN_LENGTH) });
  }, [currentTime, duration, draft.end, onChange]);

  const setEndHere = useCallback(() => {
    const end = Math.max(currentTime, MIN_LENGTH);
    onChange({ start: Math.min(draft.start, end - MIN_LENGTH), end: Math.min(duration, end) });
  }, [currentTime, duration, draft.start, onChange]);

  const nudge = useCallback(
    (edge: 'start' | 'end', delta: number) => {
      if (edge === 'start') {
        const start = Math.max(0, Math.min(draft.start + delta, draft.end - MIN_LENGTH));
        onChange({ ...draft, start });
      } else {
        const end = Math.min(duration, Math.max(draft.end + delta, draft.start + MIN_LENGTH));
        onChange({ ...draft, end });
      }
    },
    [draft, duration, onChange],
  );

  // Escape cancela: es lo que espera cualquiera con un panel abierto delante.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const pct = (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0);

  return (
    <div className="cliped">
      <div className="cliped__head">
        <span className="cliped__title">Recortar clip</span>
        <span className="cliped__len">
          {formatTime(draft.start)} - {formatTime(draft.end)}
          <b>{length.toFixed(1)}s</b>
        </span>
      </div>

      {/* Franja de la grabacion entera con el trozo elegido resaltado. */}
      <div className="cliped__bar" onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}>
        <div
          className="cliped__sel"
          style={{ left: `${pct(draft.start)}%`, width: `${pct(length)}%` }}
        />
        <div className="cliped__cursor" style={{ left: `${pct(currentTime)}%` }} />
      </div>

      <div className="cliped__edges">
        <div className="cliped__edge">
          <span className="cliped__label">Inicio</span>
          <button className="btn btn--sm btn--quiet" onClick={() => nudge('start', -1)}>
            -1s
          </button>
          <button className="btn btn--sm btn--quiet" onClick={() => onSeek(draft.start)}>
            {formatTime(draft.start)}
          </button>
          <button className="btn btn--sm btn--quiet" onClick={() => nudge('start', 1)}>
            +1s
          </button>
          <button className="btn btn--sm" onClick={setStartHere}>
            Aqui
          </button>
        </div>

        <div className="cliped__edge">
          <span className="cliped__label">Fin</span>
          <button className="btn btn--sm btn--quiet" onClick={() => nudge('end', -1)}>
            -1s
          </button>
          <button className="btn btn--sm btn--quiet" onClick={() => onSeek(draft.end)}>
            {formatTime(draft.end)}
          </button>
          <button className="btn btn--sm btn--quiet" onClick={() => nudge('end', 1)}>
            +1s
          </button>
          <button className="btn btn--sm" onClick={setEndHere}>
            Aqui
          </button>
        </div>
      </div>

      <div className="cliped__foot">
        <div className="cliped__aspect">
          <button
            className={`chip${aspect === 'original' ? ' chip--on' : ''}`}
            onClick={() => setAspect('original')}
          >
            Original
          </button>
          <button
            className={`chip${aspect === 'vertical' ? ' chip--on' : ''}`}
            onClick={() => setAspect('vertical')}
            title="Recorta a 9:16 para mandarlo por el movil"
          >
            Vertical
          </button>
        </div>

        <div className="cliped__actions">
          <button className="btn btn--sm btn--quiet" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button className="btn btn--sm" onClick={() => onExport(aspect)} disabled={busy || !valid}>
            {busy ? 'Exportando...' : 'Exportar'}
          </button>
        </div>
      </div>

      {!valid && <div className="cliped__warn">El clip tiene que durar al menos un segundo.</div>}
      {aspect === 'vertical' && (
        <div className="cliped__warn cliped__warn--soft">
          El vertical recorta los lados y hay que recodificar, asi que tarda algo mas.
        </div>
      )}
    </div>
  );
}
