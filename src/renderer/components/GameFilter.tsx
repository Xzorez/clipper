import { useMemo } from 'react';
import { GAME_DISPLAY_NAMES, GameKey, RecordingRecord } from '@shared/types';

export type GameFilterValue = GameKey | 'all';

/** Nombres cortos: en un chip mono de 11px no cabe "Rainbow Six Siege". */
const SHORT: Record<GameKey, string> = {
  valorant: 'Valorant',
  rainbowsix: 'R6',
  lol: 'LoL',
  generic: 'Otros',
};

/**
 * Filtro de juego del mosaico.
 *
 * Solo aparecen los juegos de los que hay partidas: una fila de chips con
 * juegos vacios seria una fila de botones que no hacen nada.
 */
export function GameFilter({
  recordings,
  value,
  onChange,
}: {
  recordings: RecordingRecord[];
  value: GameFilterValue;
  onChange: (value: GameFilterValue) => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<GameKey, number>();
    for (const recording of recordings) {
      map.set(recording.game, (map.get(recording.game) ?? 0) + 1);
    }
    return map;
  }, [recordings]);

  const games = [...counts.keys()].sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0),
  );

  if (recordings.length === 0) return null;

  return (
    <div className="tabs">
      <button
        className={`chip${value === 'all' ? ' chip--on' : ''}`}
        onClick={() => onChange('all')}
      >
        Todos
        <span className="chip__n">{recordings.length}</span>
      </button>
      {games.map((game) => (
        <button
          key={game}
          className={`chip${value === game ? ' chip--on' : ''}`}
          onClick={() => onChange(game)}
          title={GAME_DISPLAY_NAMES[game]}
        >
          {SHORT[game] ?? game}
          <span className="chip__n">{counts.get(game)}</span>
        </button>
      ))}
    </div>
  );
}
