import { gameLabel, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatDateShort, formatTime } from '../lib/events';
import { IconFilm } from './Icons';

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
    <button className="rec" onClick={() => onOpen(recording.id)}>
      <div className="rec__thumb">
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
          <IconFilm size={26} className="rec__ph" />
        )}

        {recording.missingFile && <span className="rec__tag">sin video</span>}
        {!recording.missingFile && recording.status === 'recovered' && (
          <span className="rec__tag">recuperada</span>
        )}

        <span className="rec__time">{formatTime(recording.duration ?? 0)}</span>
      </div>

      <div className="rec__body">
        <div className="rec__game">{gameLabel(recording.game, recording.title)}</div>
        <div className="rec__date">{formatDateShort(recording.startedAt)}</div>

        {summary && (
          <div className="rec__stats">
            <span className="rec__stat">
              <i style={{ background: 'var(--kill)' }} />
              {summary.kills}
            </span>
            <span className="rec__stat">
              <i style={{ background: 'var(--death)' }} />
              {summary.deaths}
            </span>
            {isLol ? (
              <span className="rec__stat">
                <i style={{ background: 'var(--assist)' }} />
                {summary.assists}
              </span>
            ) : (
              <span className="rec__stat">
                <i style={{ background: 'var(--headshot)' }} />
                {summary.headshots}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
