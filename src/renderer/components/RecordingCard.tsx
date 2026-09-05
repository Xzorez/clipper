import { gameLabel, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatDateShort, formatTime, gameShort } from '../lib/events';

/** Tope de segmentos de la franja. Mas alla no se distingue nada. */
const MAX_TICKS = 28;

/**
 * Franja de momentos de la tarjeta.
 *
 * Se construye con el resumen que ya trae la grabacion, agrupando por tipo.
 * No pretende ser una linea temporal en miniatura —para eso no basta el
 * resumen, harian falta los eventos uno a uno y son cientos por partida—:
 * dice cuanta accion hubo y de que clase, que es lo que se decide de un
 * vistazo al elegir que repasar.
 */
function ticksFor(recording: RecordingRecord): string[] {
  const summary = recording.summary;
  if (!summary) return [];

  const groups: Array<[number, string]> = [
    [summary.kills, 'var(--kill)'],
    [summary.headshots, 'var(--headshot)'],
    [summary.assists, 'var(--assist)'],
    [summary.knockedOut, 'var(--knocked)'],
    [summary.deaths, 'var(--death)'],
  ];

  const total = groups.reduce((sum, [n]) => sum + n, 0);
  if (total === 0) return [];

  // Con muchos eventos se reparten proporcionalmente hasta el tope, para que
  // una partida de cien momentos no se coma la resolucion de la franja.
  const scale = total > MAX_TICKS ? MAX_TICKS / total : 1;
  const ticks: string[] = [];
  for (const [count, color] of groups) {
    const n = Math.round(count * scale);
    for (let i = 0; i < n; i++) ticks.push(color);
  }
  return ticks;
}

export function RecordingCard({
  recording,
  onOpen,
}: {
  recording: RecordingRecord;
  onOpen: () => void;
}) {
  const summary = recording.summary;
  const ticks = ticksFor(recording);
  const moments = recording.eventCount ?? 0;

  const meta = [
    formatDateShort(recording.startedAt),
    recording.duration ? formatTime(recording.duration) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button className="rec" onClick={onOpen}>
      <div className="rec__thumb">
        {recording.thumbnailPath && !recording.missingFile ? (
          <img src={api.mediaUrl(recording.thumbnailPath)} alt="" loading="lazy" />
        ) : (
          <span className="rec__ph">
            {recording.missingFile ? 'sin video' : 'captura de partida'}
          </span>
        )}
        <span className="rec__badge">{gameShort(recording.game)}</span>
        {recording.duration ? (
          <span className="rec__dur">{formatTime(recording.duration)}</span>
        ) : null}
      </div>

      {/* Con cero momentos no se pinta: una barra vacia solo seria ruido. */}
      {ticks.length > 0 && (
        <div className="rec__ticks">
          {ticks.map((color, i) => (
            <i key={i} style={{ background: color }} />
          ))}
        </div>
      )}

      <div className="rec__body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span className="rec__name">{gameLabel(recording.game, recording.title)}</span>
          <span className="rec__meta">{meta}</span>
        </div>

        <div className="rec__foot">
          {summary && (
            <span className="rec__kda">
              <b style={{ color: 'var(--kill)' }}>{summary.kills}</b>
              <span>/</span>
              <b style={{ color: 'var(--death)' }}>{summary.deaths}</b>
              <span>/</span>
              <b style={{ color: 'var(--assist)' }}>{summary.assists}</b>
            </span>
          )}
          {moments > 0 && <span className="rec__mom">{moments} mom.</span>}
        </div>
      </div>
    </button>
  );
}
