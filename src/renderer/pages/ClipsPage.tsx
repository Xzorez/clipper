import { useEffect, useMemo, useState } from 'react';
import { ClipRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatDateShort, formatTime, gameShort } from '../lib/events';
import { IconMore } from '../components/Icons';
import { useDismiss } from '../lib/useDismiss';

type Sort = 'recent' | 'game';

export interface ClipsPageProps {
  refreshToken: number;
  onNotify: (title: string, message: string) => void;
}

/**
 * Los clips ya recortados.
 *
 * `Borrar` no esta a la vista sino en el menu de la tarjeta: competia
 * visualmente con `Abrir`, que es lo que se viene a hacer aqui el 95% de las
 * veces, y no conviene que la accion irreversible sea la mas facil de pulsar.
 */
export function ClipsPage({ refreshToken, onNotify }: ClipsPageProps) {
  const [clips, setClips] = useState<ClipRecord[] | null>(null);
  const [sort, setSort] = useState<Sort>('recent');
  const [playing, setPlaying] = useState<ClipRecord | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  useDismiss(menu !== null, () => setMenu(null));

  const load = () => {
    void api
      .listClips()
      .then(setClips)
      .catch((err) => onNotify('No se han podido cargar los clips', (err as Error).message));
  };

  useEffect(load, [refreshToken]);

  const ordered = useMemo(() => {
    const list = [...(clips ?? [])];
    if (sort === 'game') {
      return list.sort(
        (a, b) => a.game.localeCompare(b.game) || b.createdAt - a.createdAt,
      );
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }, [clips, sort]);

  const remove = async (clip: ClipRecord) => {
    setMenu(null);
    try {
      await api.deleteClip(clip.id, true);
      if (playing?.id === clip.id) setPlaying(null);
      load();
      onNotify('Clip borrado', 'Se ha borrado tambien el fichero.');
    } catch (err) {
      onNotify('No se ha podido borrar', (err as Error).message);
    }
  };

  if (clips === null) {
    return (
      <div className="empty">
        <div className="empty__title">Cargando clips</div>
      </div>
    );
  }

  return (
    <>
      <div className="section-h">
        <h1 className="title">Clips</h1>
        <span className="eyebrow" style={{ letterSpacing: '0.16em' }}>
          {clips.length} · sin recodificar
        </span>
        <div className="hair" />
        <div className="tabs">
          <button
            className={`chip${sort === 'recent' ? ' chip--on' : ''}`}
            onClick={() => setSort('recent')}
          >
            Recientes
          </button>
          <button
            className={`chip${sort === 'game' ? ' chip--on' : ''}`}
            onClick={() => setSort('game')}
          >
            Por juego
          </button>
        </div>
      </div>

      {playing && (
        <div className="panel" style={{ overflow: 'hidden' }}>
          <div className="player__video" style={{ height: 420, border: 0, borderRadius: 0 }}>
            <video src={api.mediaUrl(playing.filePath)} controls autoPlay />
          </div>
          <div className="aside__head">
            <span className="trim__title">{playing.title}</span>
            <button className="btn btn--quiet btn--sm" onClick={() => setPlaying(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      {clips.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Todavia no hay clips</div>
          <div className="empty__hint">
            Abre una partida y guarda un trozo desde el editor de clip, o usa el atajo mientras
            juegas.
          </div>
        </div>
      ) : (
        <div className="grid-clips">
          {ordered.map((clip) => {
            const length = Math.max(0, clip.endTime - clip.startTime);
            return (
              <div key={clip.id} style={{ position: 'relative', minWidth: 0 }}>
                <div className="rec" style={{ cursor: 'default' }}>
                  <div
                    className="rec__thumb"
                    style={{ height: 112, cursor: 'pointer' }}
                    onClick={() => setPlaying(clip)}
                  >
                    {clip.thumbnailPath && !clip.missingFile ? (
                      <img src={api.mediaUrl(clip.thumbnailPath)} alt="" loading="lazy" />
                    ) : (
                      <span className="rec__ph">{clip.missingFile ? 'sin fichero' : 'clip'}</span>
                    )}
                    <span className="rec__dur">{formatTime(length)}</span>
                  </div>

                  <div className="clip__bar" style={{ background: 'var(--accent)' }} />

                  <div className="rec__body">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span className="rec__name">{clip.title}</span>
                      <span
                        className="rec__meta"
                        style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.06em' }}
                      >
                        {gameShort(clip.game)} · {formatDateShort(clip.createdAt)}
                      </span>
                    </div>

                    <div className="clip__acts">
                      <button className="clip__act" onClick={() => setPlaying(clip)}>
                        Abrir
                      </button>
                      <button
                        className="clip__act"
                        onClick={() => void api.revealPath(clip.filePath).catch(() => undefined)}
                      >
                        Carpeta
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  className="ctl"
                  data-menu
                  title="Mas opciones"
                  style={{ position: 'absolute', top: 8, left: 8, width: 26, height: 26 }}
                  onClick={() => setMenu(menu === clip.id ? null : clip.id)}
                >
                  <IconMore size={14} />
                </button>

                {menu === clip.id && (
                  <div
                    className="panel"
                    data-menu
                    style={{
                      position: 'absolute',
                      top: 38,
                      left: 8,
                      zIndex: 20,
                      padding: 6,
                      boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
                    }}
                  >
                    <button
                      className="btn btn--quiet btn--sm"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => void remove(clip)}
                    >
                      Borrar el clip
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
