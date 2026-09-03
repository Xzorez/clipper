import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameEvent, GameEventType } from '@shared/types';
import { clusterEvents, computeTicks, TimelineCluster } from '@shared/timeline';
import { EVENT_VISUALS, formatTime, formatTimePrecise } from '../lib/events';

/** Separacion minima en pixeles entre dos marcadores antes de agruparlos. */
const MIN_MARKER_SPACING_PX = 20;

/** Margen extra, en pixeles, que se renderiza fuera de la zona visible. */
const OVERSCAN_PX = 300;

export interface TimelineProps {
  events: GameEvent[];
  duration: number;
  currentTime: number;
  visibleTypes: Set<GameEventType>;
  iconSize: 'small' | 'medium' | 'large';
  showLabels: boolean;
  onSeek: (seconds: number) => void;
}

type Cluster = TimelineCluster;

/**
 * Linea temporal con marcadores de evento.
 *
 * Decisiones de rendimiento, que es donde esto se puede ir de las manos:
 *
 *  1. **Agrupacion.** No se pinta un nodo por evento: los eventos que caerian a
 *     menos de 20 px se agrupan en un unico marcador con el numero de eventos.
 *     Una partida de VALORANT con 24 kills, 13 muertes y 8 headshots son 45
 *     eventos; en una timeline de 900 px muchos se solapan y sin agrupar
 *     resultarian ilegibles ademas de costosos.
 *
 *  2. **Ventana visible.** Con zoom la pista se hace mas ancha que el
 *     contenedor. Solo se renderizan los grupos dentro del area visible mas un
 *     margen, asi que el numero de nodos del DOM no crece con el zoom.
 *
 *  3. **Recalculo controlado.** Los grupos se recalculan solo cuando cambian
 *     los eventos, los filtros, el zoom o el ancho del contenedor. El
 *     movimiento del cabezal de reproduccion, que ocurre varias veces por
 *     segundo, no dispara ningun recalculo: solo mueve un elemento.
 *
 *  4. **Redimensionado.** Un ResizeObserver mantiene el ancho actualizado, de
 *     forma que la timeline se recoloca al cambiar el tamano de la ventana.
 */
export function Timeline({
  events,
  duration,
  currentTime,
  visibleTypes,
  iconSize,
  showLabels,
  onSeek,
}: TimelineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const [zoom, setZoom] = useState(1);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [hover, setHover] = useState<{ cluster: Cluster; x: number; y: number } | null>(null);

  // Ancho real del contenedor, actualizado ante cualquier redimensionado.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setContainerWidth(width);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth || 900);
    return () => observer.disconnect();
  }, []);

  const trackWidth = Math.max(containerWidth, containerWidth * zoom);
  const safeDuration = duration > 0 ? duration : 1;

  const visibleEvents = useMemo(
    () => events.filter((event) => visibleTypes.has(event.type)),
    [events, visibleTypes],
  );

  /** Agrupacion por proximidad en pixeles (logica pura en @shared/timeline). */
  const clusters = useMemo<Cluster[]>(
    () => clusterEvents(visibleEvents, trackWidth, safeDuration, MIN_MARKER_SPACING_PX),
    [visibleEvents, trackWidth, safeDuration],
  );

  /** Solo los grupos dentro de la ventana visible, con margen. */
  const renderedClusters = useMemo(() => {
    if (zoom === 1) return clusters;
    const from = scrollLeft - OVERSCAN_PX;
    const to = scrollLeft + containerWidth + OVERSCAN_PX;
    return clusters.filter((cluster) => cluster.x >= from && cluster.x <= to);
  }, [clusters, zoom, scrollLeft, containerWidth]);

  /** Marcas de tiempo con un intervalo legible segun el zoom. */
  const ticks = useMemo(() => computeTicks(safeDuration, trackWidth), [safeDuration, trackWidth]);

  const handleTrackClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const ratio = Math.min(1, Math.max(0, x / trackWidth));
      onSeek(ratio * safeDuration);
    },
    [trackWidth, safeDuration, onSeek],
  );

  const playheadX = (Math.min(currentTime, safeDuration) / safeDuration) * trackWidth;

  return (
    <div>
      <div
        className="timeline-track-wrap"
        ref={wrapRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div
          className="timeline-track"
          style={{ width: trackWidth }}
          onClick={handleTrackClick}
        >
          <div className="timeline-rail">
            <div
              className="timeline-rail__progress"
              style={{ width: `${(Math.min(currentTime, safeDuration) / safeDuration) * 100}%` }}
            />
          </div>

          <div className="timeline-playhead" style={{ left: playheadX }} />

          {renderedClusters.map((cluster) => (
            <Marker
              key={`${cluster.events[0].id}-${cluster.events.length}`}
              cluster={cluster}
              size={iconSize}
              showLabel={showLabels}
              onSeek={onSeek}
              onHover={setHover}
            />
          ))}
        </div>

        <div className="timeline-ruler" style={{ width: trackWidth, position: 'relative' }}>
          {ticks.map((tick) => (
            <span key={tick.time} className="timeline-tick" style={{ left: tick.x }}>
              {formatTime(tick.time)}
            </span>
          ))}
        </div>
      </div>

      <div
        className="zoom-controls"
        style={{ marginTop: 10, justifyContent: 'flex-end' }}
      >
        <span>
          {visibleEvents.length} evento{visibleEvents.length === 1 ? '' : 's'}
          {clusters.length !== visibleEvents.length && ` en ${clusters.length} grupos`}
        </span>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => setZoom((z) => Math.max(1, z - 1))}
          disabled={zoom <= 1}
          title="Alejar"
        >
          −
        </button>
        <span style={{ minWidth: 34, textAlign: 'center' }}>{zoom}x</span>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => setZoom((z) => Math.min(20, z + 1))}
          disabled={zoom >= 20}
          title="Acercar"
        >
          +
        </button>
      </div>

      {hover && <Tooltip cluster={hover.cluster} x={hover.x} y={hover.y} />}
    </div>
  );
}

interface MarkerProps {
  cluster: Cluster;
  size: 'small' | 'medium' | 'large';
  showLabel: boolean;
  onSeek: (seconds: number) => void;
  onHover: (value: { cluster: Cluster; x: number; y: number } | null) => void;
}

function Marker({ cluster, size, showLabel, onSeek, onHover }: MarkerProps) {
  const isCluster = cluster.events.length > 1;
  const visual = EVENT_VISUALS[cluster.dominant];

  return (
    <button
      className={`marker marker--${size}${isCluster ? ' marker--cluster' : ''}`}
      style={{
        left: cluster.x,
        background: isCluster ? undefined : visual.color,
        borderColor: isCluster ? visual.color : undefined,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(cluster.time);
      }}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onHover({ cluster, x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => onHover(null)}
      aria-label={`${visual.label} en ${formatTime(cluster.time)}`}
    >
      {isCluster ? cluster.events.length : showLabel ? '' : visual.icon}
    </button>
  );
}

function Tooltip({ cluster, x, y }: { cluster: Cluster; x: number; y: number }) {
  const lines = cluster.events.slice(0, 6);
  return (
    <div
      className="marker-tooltip"
      style={{ left: x, top: y - 12, transform: 'translate(-50%, -100%)' }}
    >
      {lines.map((event) => {
        const visual = EVENT_VISUALS[event.type];
        return (
          <div key={event.id}>
            <span style={{ color: visual.color, fontWeight: 700 }}>
              {visual.icon} {visual.label}
            </span>
            {' — '}
            {formatTimePrecise(event.videoTime)}
            {renderMeta(event)}
          </div>
        );
      })}
      {cluster.events.length > lines.length && (
        <div className="marker-tooltip__meta">
          y {cluster.events.length - lines.length} mas
        </div>
      )}
    </div>
  );
}

/** Muestra los datos utiles de la metadata sin volcar JSON crudo. */
function renderMeta(event: GameEvent) {
  const meta = event.metadata;
  if (!meta) return null;
  const parts: string[] = [];
  if (typeof meta.weapon === 'string') parts.push(String(meta.weapon));
  if (typeof meta.victim === 'string') parts.push(`a ${meta.victim}`);
  if (typeof meta.killer === 'string') parts.push(`por ${meta.killer}`);
  if (typeof meta.round === 'number' || typeof meta.round === 'string') {
    parts.push(`ronda ${meta.round}`);
  }
  if (typeof meta.label === 'string' && meta.label !== 'kill') parts.push(String(meta.label));
  if (parts.length === 0) return null;
  return <span className="marker-tooltip__meta"> · {parts.join(' · ')}</span>;
}
