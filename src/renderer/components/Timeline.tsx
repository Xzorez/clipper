import { useEffect, useMemo, useRef, useState } from 'react';
import { GameEvent, GameEventType } from '@shared/types';
import { clusterEvents, computeTicks } from '@shared/timeline';
import { EVENT_VISUALS, formatTime } from '../lib/events';

/**
 * Pistas de la linea temporal, en orden de importancia.
 *
 * Una fila por clase de momento en vez de todos amontonados en una sola: con
 * una sola pista, una kill y un fin de ronda pesaban igual y no habia forma de
 * leer la partida de un vistazo. Solo se dibujan las pistas que tienen algo.
 */
const LANES: Array<{ label: string; types: GameEventType[] }> = [
  { label: 'Kills', types: [GameEventType.KILL] },
  { label: 'Headshots', types: [GameEventType.HEADSHOT] },
  { label: 'Muertes', types: [GameEventType.DEATH, GameEventType.KNOCKED_OUT] },
  { label: 'Asistencias', types: [GameEventType.ASSIST] },
  { label: 'Tus marcas', types: [GameEventType.BOOKMARK] },
  { label: 'Por sonido', types: [GameEventType.HIGHLIGHT] },
];

/** Tipos que se pueden filtrar, en el orden de los chips. */
const FILTERS: GameEventType[] = [
  GameEventType.KILL,
  GameEventType.DEATH,
  GameEventType.HEADSHOT,
  GameEventType.ASSIST,
  GameEventType.KNOCKED_OUT,
  GameEventType.BOOKMARK,
  GameEventType.HIGHLIGHT,
];

/** Separacion minima entre marcas. Por debajo se agrupan en una sola. */
const MIN_SPACING_PX = 7;

export function Timeline({
  events,
  duration,
  currentTime,
  visibleTypes,
  onToggleType,
  onSeek,
}: {
  events: GameEvent[];
  duration: number;
  currentTime: number;
  visibleTypes: Set<GameEventType>;
  onToggleType: (type: GameEventType) => void;
  onSeek: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  /**
   * Ancho real de una pista.
   *
   * El agrupado de marcas se hace en pixeles, no en porcentaje: lo que decide
   * si dos momentos se pisan es cuanto espacio hay en pantalla, y eso cambia
   * al redimensionar la ventana.
   */
  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const counts = useMemo(() => {
    const map = new Map<GameEventType, number>();
    for (const event of events) map.set(event.type, (map.get(event.type) ?? 0) + 1);
    return map;
  }, [events]);

  const lanes = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.videoTime - b.videoTime);
    return LANES.map((lane) => {
      const shown = lane.types.filter((type) => visibleTypes.has(type));
      const own = sorted.filter((event) => shown.includes(event.type));
      return {
        label: lane.label,
        clusters: width > 0 ? clusterEvents(own, width, duration, MIN_SPACING_PX) : [],
        total: lane.types.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0),
      };
    }).filter((lane) => lane.total > 0);
  }, [events, visibleTypes, duration, counts, width]);

  const ticks = useMemo(
    () => (width > 0 ? computeTicks(duration, width) : []),
    [duration, width],
  );

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const seekFromClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <div className="lanes">
      <div className="lanes__head">
        <span className="eyebrow">Linea temporal</span>
        <div className="hair" />
        <div className="lanes__filters">
          {FILTERS.filter((type) => (counts.get(type) ?? 0) > 0).map((type) => {
            const visual = EVENT_VISUALS[type];
            const on = visibleTypes.has(type);
            return (
              <button
                key={type}
                className={`chip${on ? '' : ' chip--off'}`}
                title={on ? 'Ocultar esta pista' : 'Mostrar esta pista'}
                onClick={() => onToggleType(type)}
              >
                <i style={{ background: visual.color }} />
                {visual.label}
                <span className="chip__n">{counts.get(type)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lanes__rows">
        {lanes.map((lane, index) => (
          <div className="lane" key={lane.label}>
            <span className="lane__l">{lane.label}</span>
            <div
              className="lane__track"
              // Se mide una sola pista: todas comparten ancho.
              ref={index === 0 ? trackRef : undefined}
              onClick={seekFromClick}
            >
              {lane.clusters.map((cluster) => (
                <button
                  key={cluster.events[0].id}
                  className="lane__mark"
                  title={
                    cluster.events.length > 1
                      ? `${cluster.events.length} momentos · ${formatTime(cluster.time)}`
                      : `${EVENT_VISUALS[cluster.dominant].label} · ${formatTime(cluster.time)}`
                  }
                  style={{
                    left: `${cluster.x}px`,
                    background: EVENT_VISUALS[cluster.dominant].color,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeek(cluster.time);
                  }}
                />
              ))}
            </div>
          </div>
        ))}

        <div className="ruler">
          <span className="ruler__pad" />
          <div className="ruler__bar" onClick={seekFromClick}>
            <div className="ruler__base" />
            <div className="ruler__done" style={{ width: `${progress}%` }} />
            <div className="ruler__head" style={{ left: `${progress}%` }} />
            {ticks.map((tick) => (
              <span key={tick.time} className="ruler__tick" style={{ left: `${tick.x}px` }}>
                {formatTime(tick.time)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
