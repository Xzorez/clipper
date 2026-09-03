import { createLogger } from '../logging/Logger';

const log = createLogger('EventManager');

/**
 * Si un contador salta mas que esto de golpe asumimos que es una resincronizacion
 * (reconexion de GEP, cambio de partida) y no una rafaga real de kills.
 */
const MAX_BURST = 8;

export interface CounterObservation {
  /** Cuantos eventos discretos hay que registrar. 0 = ninguno. */
  occurrences: number;
  /** Valor anterior conocido, para trazabilidad. */
  previous: number | null;
  /** Valor nuevo. */
  current: number;
  /** Motivo, util para logs y tests. */
  reason: 'first' | 'increment' | 'duplicate' | 'reset' | 'clamped' | 'decrement';
}

/**
 * Convierte el `value` heterogeneo de GEP en un numero.
 *
 * GEP no es consistente entre juegos ni entre versiones: el mismo contador puede
 * llegar como numero, como cadena numerica, o como JSON serializado. Ejemplos
 * reales segun la documentacion oficial:
 *
 *   VALORANT  kill   -> 6                          (total acumulado)
 *   LoL       kill   -> '{"label":"kill","count":1,"totalKills":3}'
 *   R6        kill   -> null                       (evento discreto, sin contador)
 *
 * Devuelve null cuando el valor no representa un contador.
 */
export function parseCounterValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;

    // Cadena puramente numerica
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }

    // JSON serializado
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseCounterValue(JSON.parse(trimmed));
      } catch {
        return null;
      }
    }
    return null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Preferimos el total acumulado; si no existe, el contador puntual.
    for (const field of ['totalKills', 'total', 'count', 'value', 'kills', 'deaths', 'assists']) {
      if (field in obj) {
        const parsed = parseCounterValue(obj[field]);
        if (parsed !== null) return parsed;
      }
    }
  }

  return null;
}

/**
 * Deduplica contadores acumulados y los convierte en eventos discretos.
 *
 * El problema que resuelve: VALORANT y League of Legends no dicen "ha ocurrido
 * una kill", dicen "tu total de kills es ahora 6". Si registraramos el valor tal
 * cual tendriamos seis kills en lugar de una. Y si GEP reenvia el mismo valor
 * (cosa que ocurre tras una reconexion o un `getInfo`), duplicariamos eventos.
 *
 * Reglas:
 *   - Primera observacion sin linea base -> 1 evento (el evento SI ha ocurrido).
 *   - Incremento de N -> N eventos (normalmente N = 1).
 *   - Mismo valor      -> 0 eventos.
 *   - Valor menor      -> el contador se ha reiniciado (partida nueva). Se
 *                         reajusta la linea base y se registra 1 evento si el
 *                         valor nuevo es mayor que cero.
 *   - Salto absurdo    -> se limita a MAX_BURST y se avisa en el log.
 *
 * Las actualizaciones de tipo "info" (`seed`) fijan la linea base SIN generar
 * eventos: sirven para no inventarse seis kills cuando la app arranca con la
 * partida ya empezada.
 */
export class CounterTracker {
  private readonly counters = new Map<string, number>();

  /**
   * Fija la linea base sin emitir eventos.
   * Se alimenta de los `new-info-update` (kills, deaths, headshots, assists).
   */
  seed(key: string, value: unknown): void {
    const parsed = parseCounterValue(value);
    if (parsed === null) return;
    const previous = this.counters.get(key);
    if (previous === parsed) return;
    this.counters.set(key, parsed);
    log.debug(`Linea base ${key}: ${previous ?? 'sin valor'} -> ${parsed}`);
  }

  /**
   * Procesa un evento con contador y devuelve cuantas ocurrencias representa.
   */
  observe(key: string, value: unknown): CounterObservation {
    const parsed = parseCounterValue(value);

    // Evento sin contador (R6 manda null): es una ocurrencia discreta.
    if (parsed === null) {
      return { occurrences: 1, previous: this.counters.get(key) ?? null, current: NaN, reason: 'first' };
    }

    const previous = this.counters.has(key) ? (this.counters.get(key) as number) : null;

    if (previous === null) {
      // No teniamos linea base. El evento ha ocurrido, asi que vale 1,
      // pero fijamos la linea base en el valor recibido para no repetirlo.
      this.counters.set(key, parsed);
      return { occurrences: 1, previous: null, current: parsed, reason: 'first' };
    }

    if (parsed === previous) {
      // Reenvio del mismo valor: no ha pasado nada nuevo.
      return { occurrences: 0, previous, current: parsed, reason: 'duplicate' };
    }

    if (parsed < previous) {
      // El contador ha bajado: partida nueva o resincronizacion.
      this.counters.set(key, parsed);
      log.debug(`Contador ${key} reiniciado: ${previous} -> ${parsed}`);
      return {
        occurrences: parsed > 0 ? 1 : 0,
        previous,
        current: parsed,
        reason: parsed > 0 ? 'reset' : 'decrement',
      };
    }

    const delta = parsed - previous;
    this.counters.set(key, parsed);

    if (delta > MAX_BURST) {
      log.warn(
        `Salto anomalo en ${key}: ${previous} -> ${parsed} (${delta}). ` +
          `Se registra 1 evento en lugar de ${delta}.`,
      );
      return { occurrences: 1, previous, current: parsed, reason: 'clamped' };
    }

    return { occurrences: delta, previous, current: parsed, reason: 'increment' };
  }

  get(key: string): number | null {
    return this.counters.has(key) ? (this.counters.get(key) as number) : null;
  }

  /** Se llama al empezar una partida nueva o al reconectar el proveedor. */
  reset(): void {
    this.counters.clear();
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}
