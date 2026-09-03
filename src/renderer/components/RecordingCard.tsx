import { GAME_DISPLAY_NAMES, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatDateShort, formatTime } from '../lib/events';

export function RecordingCard({
  recording,
  onOpen,
}: {
  recording: RecordingRecord;
  onOpen: (id: string) => void;
}) {
  const summary = recording.summary;
  const isLol = recording.game === 'lol';

  return (
    <button className="rec-card" onClick={() => onOpen(recording.id)}>
      <div className="rec-card__thumb">
        {recording.thumbnailPath ? (
          <img
            src={api.mediaUrl(recording.thumbnailPath)}
            alt=""
            loading="lazy"
            onError={(e) => {
              // Si la miniatura desaparecio, se oculta y queda el marcador.
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="rec-card__placeholder">🎬</span>
        )}

        {recording.missingFile && <span className="rec-card__badge">sin video</span>}
        {!recording.missingFile && recording.status === 'recovered' && (
          <span className="rec-card__badge">recuperada</span>
        )}

        <span className="rec-card__duration">{formatTime(recording.duration ?? 0)}</span>
      </div>

      <div className="rec-card__body">
        <div className="rec-card__game">{GAME_DISPLAY_NAMES[recording.game]}</div>
        <div className="rec-card__date">{formatDateShort(recording.startedAt)}</div>

        {summary && (
          <div className="stat-row">
            <span className="stat" style={{ color: 'var(--kill)' }}>
              ⚔️ {summary.kills}
            </span>
            <span className="stat" style={{ color: 'var(--death)' }}>
              💀 {summary.deaths}
            </span>
            {isLol ? (
              <span className="stat" style={{ color: 'var(--assist)' }}>
                🤝 {summary.assists}
              </span>
            ) : (
              <span className="stat" style={{ color: 'var(--headshot)' }}>
                🎯 {summary.headshots}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
