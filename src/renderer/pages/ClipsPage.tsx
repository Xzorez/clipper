import { useEffect, useState } from 'react';
import { ClipRecord, GAME_DISPLAY_NAMES } from '@shared/types';
import { api } from '../lib/api';
import { formatDateShort, formatTime } from '../lib/events';
import { IconClips } from '../components/Icons';

export interface ClipsPageProps {
  refreshToken: number;
  onNotify: (title: string, message: string) => void;
}

export function ClipsPage({ refreshToken, onNotify }: ClipsPageProps) {
  const [clips, setClips] = useState<ClipRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<ClipRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .listClips()
      .then((result) => {
        if (!cancelled) setClips(result);
      })
      .catch((err) => {
        if (!cancelled) onNotify('No se han podido cargar los clips', (err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, onNotify]);

  const remove = async (clip: ClipRecord) => {
    try {
      await api.deleteClip(clip.id, true);
      setClips((previous) => previous.filter((c) => c.id !== clip.id));
      if (playing?.id === clip.id) setPlaying(null);
      onNotify('Clip eliminado', 'El fichero se ha borrado del disco.');
    } catch (err) {
      onNotify('No se ha podido eliminar el clip', (err as Error).message);
    }
  };

  return (
    <div>
      <h1 className="page__title">Clips</h1>
      <p className="page__sub">
        Fragmentos recortados de tus grabaciones. Se generan sin recodificar, asi que
        conservan la calidad original.
      </p>

      {playing && (
        <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
          <video
            src={api.mediaUrl(playing.filePath)}
            controls
            autoPlay
            style={{ width: '100%', display: 'block', maxHeight: '55vh', background: '#000' }}
          />
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <strong>{playing.title}</strong>
            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
              {formatTime(playing.endTime - playing.startTime)}
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn btn--sm btn--quiet" onClick={() => setPlaying(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty">
          <div className="empty__title">Cargando clips</div>
        </div>
      ) : clips.length === 0 ? (
        <div className="empty">
          <IconClips size={32} className="empty__mark" />
          <div className="empty__title">Todavia no hay clips</div>
          <div className="empty__hint">
            Abre una grabacion y pulsa la tijera junto a cualquier evento.
          </div>
        </div>
      ) : (
        <div className="grid">
          {clips.map((clip) => (
            <div className="rec" key={clip.id} style={{ cursor: 'default' }}>
              <button
                className="rec__thumb"
                style={{ width: '100%', border: 'none' }}
                onClick={() => !clip.missingFile && setPlaying(clip)}
              >
                {clip.thumbnailPath ? (
                  <img src={api.mediaUrl(clip.thumbnailPath)} alt="" loading="lazy" />
                ) : (
                  <IconClips size={24} className="rec__ph" />
                )}
                {clip.missingFile && <span className="rec__tag">sin fichero</span>}
                <span className="rec__time">
                  {formatTime(clip.endTime - clip.startTime)}
                </span>
              </button>
              <div className="rec__body">
                <div className="rec__game">{clip.title}</div>
                <div className="rec__date">
                  {GAME_DISPLAY_NAMES[clip.game]} · {formatDateShort(clip.createdAt)}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button
                    className="btn btn--sm btn--quiet"
                    onClick={() => void api.revealPath(clip.filePath).catch(() => undefined)}
                  >
                    Carpeta
                  </button>
                  <button className="btn btn--sm btn--danger" onClick={() => void remove(clip)}>
                    Borrar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
