import { useMemo, useState } from 'react';
import { GAME_DISPLAY_NAMES, GameKey, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { RecordingCard } from '../components/RecordingCard';
import { IconFilm, IconMore } from '../components/Icons';

export interface LibraryPageProps {
  recordings: RecordingRecord[];
  onOpenRecording: (id: string) => void;
  onRefresh: () => void;
  onNotify: (title: string, message: string) => void;
}

const GAME_FILTERS: Array<{ key: GameKey | 'all'; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'valorant', label: 'VALORANT' },
  { key: 'rainbowsix', label: 'Rainbow Six' },
  { key: 'lol', label: 'League of Legends' },
  { key: 'generic', label: 'Otros' },
];

export function LibraryPage({
  recordings,
  onOpenRecording,
  onRefresh,
  onNotify,
}: LibraryPageProps) {
  const [filter, setFilter] = useState<GameKey | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(
    () => (filter === 'all' ? recordings : recordings.filter((r) => r.game === filter)),
    [recordings, filter],
  );

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, item) => {
        acc.kills += item.summary?.kills ?? 0;
        acc.deaths += item.summary?.deaths ?? 0;
        acc.headshots += item.summary?.headshots ?? 0;
        acc.seconds += item.duration ?? 0;
        return acc;
      },
      { kills: 0, deaths: 0, headshots: 0, seconds: 0 },
    );
  }, [filtered]);

  const remove = async (id: string, deleteFile: boolean) => {
    try {
      await api.deleteRecording(id, deleteFile);
      onNotify('Grabacion eliminada', deleteFile ? 'Se ha borrado tambien el fichero.' : 'Se ha quitado de la biblioteca.');
      setSelected(null);
      onRefresh();
    } catch (err) {
      onNotify('No se ha podido eliminar', (err as Error).message);
    }
  };

  return (
    <div>
      <h1 className="page__title">Mis partidas</h1>
      <p className="page__sub">
        {filtered.length} grabacion{filtered.length === 1 ? '' : 'es'}
        {totals.seconds > 0 && ` · ${Math.round(totals.seconds / 60)} minutos`}
        {totals.kills > 0 && ` · ${totals.kills} kills en total`}
      </p>

      <div className="tabs">
        {GAME_FILTERS.map((item) => (
          <button
            key={item.key}
            className={`tab${filter === item.key ? ' tab--on' : ''}`}
            onClick={() => setFilter(item.key)}
          >
            {item.label}
            <span className="tab__n">
              {item.key === 'all'
                ? recordings.length
                : recordings.filter((r) => r.game === item.key).length}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <IconFilm size={32} className="empty__mark" />
          <div className="empty__title">
            {filter === 'all'
              ? 'Todavia no hay partidas'
              : `Sin partidas de ${GAME_DISPLAY_NAMES[filter as GameKey]}`}
          </div>
        </div>
      ) : (
        <div className="grid">
          {filtered.map((item) => (
            <div key={item.id} style={{ position: 'relative' }}>
              <RecordingCard recording={item} onOpen={onOpenRecording} />
              <button
                className="btn btn--sm btn--quiet"
                style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.6)' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(selected === item.id ? null : item.id);
                }}
                title="Opciones"
              >
                <IconMore size={14} />
              </button>

              {selected === item.id && (
                <div
                  className="card"
                  style={{
                    position: 'absolute',
                    top: 38,
                    right: 6,
                    zIndex: 20,
                    padding: 8,
                    minWidth: 210,
                    boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
                  }}
                >
                  <button
                    className="btn btn--sm btn--quiet"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => void api.revealPath(item.filePath).catch(() => undefined)}
                  >
                    Ver en la carpeta
                  </button>
                  <button
                    className="btn btn--sm btn--quiet"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                    onClick={() => void remove(item.id, false)}
                  >
                    Quitar de la biblioteca
                  </button>
                  <button
                    className="btn btn--sm btn--danger"
                    style={{ width: '100%', justifyContent: 'flex-start', marginTop: 4 }}
                    onClick={() => void remove(item.id, true)}
                  >
                    Borrar tambien el video
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
