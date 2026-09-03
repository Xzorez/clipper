import { EVENT_PRIORITY, GameEvent, GameEventType } from './types';

export interface TimelineCluster {
  /** Posicion en pixeles dentro de la pista. */
  x: number;
  /** Tiempo del primer evento del grupo, en segundos. */
  time: number;
  events: GameEvent[];
  /** Tipo con mayor prioridad visual del grupo; define el color del marcador. */
  dominant: GameEventType;
}

/**
 * Agrupa eventos que caerian demasiado juntos en la timeline.
 *
 * Se extrae del componente React a proposito: es la parte con reglas reales
 * (orden, proximidad en pixeles, tipo dominante) y conviene poder probarla sin
 * montar el DOM.
 *
 * El criterio es la distancia en PIXELES, no en segundos: dos kills separadas
 * por 4 segundos se solapan en un video de una hora pero se ven perfectamente
 * separadas con el zoom puesto. Al depender del ancho renderizado, la
 * agrupacion se adapta sola al zoom y al tamano de la ventana.
 */
export function clusterEvents(
  events: GameEvent[],
  trackWidth: number,
  duration: number,
  minSpacingPx: number,
): TimelineCluster[] {
  if (events.length === 0) return [];

  const safeDuration = duration > 0 ? duration : 1;
  const sorted = [...events].sort((a, b) => a.videoTime - b.videoTime);

  const clusters: TimelineCluster[] = [];
  let bucket: GameEvent[] = [];
  let bucketX = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const dominant = bucket.reduce((best, event) =>
      EVENT_PRIORITY[event.type] > EVENT_PRIORITY[best.type] ? event : best,
    ).type;
    clusters.push({ x: bucketX, time: bucket[0].videoTime, events: bucket, dominant });
    bucket = [];
  };

  for (const event of sorted) {
    const x = (Math.min(event.videoTime, safeDuration) / safeDuration) * trackWidth;
    if (bucket.length === 0) {
      bucket = [event];
      bucketX = x;
    } else if (x - bucketX < minSpacingPx) {
      bucket.push(event);
    } else {
      flush();
      bucket = [event];
      bucketX = x;
    }
  }
  flush();

  return clusters;
}

/**
 * Calcula marcas de tiempo con un intervalo legible.
 * Evita ejes con etiquetas del estilo "3:17", "6:34", "9:51".
 */
export function computeTicks(
  duration: number,
  trackWidth: number,
  targetSpacingPx = 96,
): Array<{ time: number; x: number }> {
  const safeDuration = duration > 0 ? duration : 1;
  const approxCount = Math.max(2, Math.floor(trackWidth / targetSpacingPx));
  const rawInterval = safeDuration / approxCount;
  const niceIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const interval = niceIntervals.find((value) => value >= rawInterval) ?? 3600;

  const ticks: Array<{ time: number; x: number }> = [];
  for (let t = 0; t <= safeDuration; t += interval) {
    ticks.push({ time: t, x: (t / safeDuration) * trackWidth });
  }
  return ticks;
}
