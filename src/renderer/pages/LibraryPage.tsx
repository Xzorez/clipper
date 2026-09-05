import { useMemo, useState } from 'react';
import { RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { RecordingCard } from '../components/RecordingCard';
import { GameFilter, GameFilterValue } from '../components/GameFilter';
import { IconMore } from '../components/Icons';

export interface LibraryPageProps {
  recordings: RecordingRecord[];
  onOpenRecording: (id: string) => void;
  onRefresh: () => void;
  onNotify: (title: string, message: string) => void;
}

/**
 * Biblioteca de partidas.
 *
 * Mosaico y no lista: lo que distingue una partida de otra es la imagen y la
 * cantidad de accion, y eso una fila de texto no lo cuenta.
 */
export function LibraryPage({
  recordings,
  onOpenRecording,
  onRefresh,
  onNotify,
}: LibraryPageProps) {
  const [filter, setFilter] = useState<GameFilterValue>('all');
  const [menu, setMenu] = useState<string | null>(null);

  const filtered = useMemo(
    () => (filter === 'all' ? recordings : recordings.filter((r) => r.game === filter)),
    [recordings, filter],
  );

  const remove = async (id: string, deleteFile: boolean) => {
    setMenu(null);
    try {
      await api.deleteRecording(id, deleteFile);
      onRefresh();
      onNotify(
        'Partida borrada',
        deleteFile ? 'Se ha borrado tambien el video.' : 'El video sigue en la carpeta.',
      );
    } catch (err) {
      onNotify('No se ha podido borrar', (err as Error).message);
    }
  };

  return (
    <>
      <div className="section-h">
        <h1 className="title">Partidas</h1>
        <div className="hair" />
        <GameFilter recordings={recordings} value={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Todavia no hay partidas</div>
          <div className="empty__hint">
            Abre un juego y Clipper empezara a grabar sola. Lo que grabe aparecera aqui.
          </div>
        </div>
      ) : (
        <div className="grid-recs">
          {filtered.map((recording) => (
            <div key={recording.id} style={{ position: 'relative', minWidth: 0 }}>
              <RecordingCard
                recording={recording}
                onOpen={() => onOpenRecording(recording.id)}
              />

              <button
                className="ctl"
                title="Mas opciones"
                style={{ position: 'absolute', top: 8, right: 8, width: 26, height: 26 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(menu === recording.id ? null : recording.id);
                }}
              >
                <IconMore size={14} />
              </button>

              {menu === recording.id && (
                <div
                  className="panel"
                  style={{
                    position: 'absolute',
                    top: 38,
                    right: 8,
                    zIndex: 20,
                    padding: 6,
                    gap: 2,
                    boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
                  }}
                >
                  <button
                    className="btn btn--quiet btn--sm"
                    onClick={() => void api.revealPath(recording.filePath).catch(() => undefined)}
                  >
                    Ver en la carpeta
                  </button>
                  <button
                    className="btn btn--quiet btn--sm"
                    onClick={() => void remove(recording.id, false)}
                  >
                    Quitar de la lista
                  </button>
                  <button
                    className="btn btn--quiet btn--sm"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => void remove(recording.id, true)}
                  >
                    Borrar con el video
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
