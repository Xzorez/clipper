import { GameEventType, GameKey } from '../../shared/types';
import { CounterTracker } from '../events/CounterTracker';

/**
 * Payload crudo tal y como lo entrega Overwolf GEP.
 * Corresponde a `gep.GameEvent` / `gep.InfoUpdate` del paquete oficial:
 *   { gameId, feature, key, value }  (+ `category` en los info updates)
 */
export interface RawGameEvent {
  gameId: number;
  feature: string;
  key: string;
  value: unknown;
  category?: string;
  /**
   * De que canal viene:
   *  - 'event' -> new-game-event  (ocurrencia puntual)
   *  - 'info'  -> new-info-update (estado persistente)
   * La distincion es critica: los info updates fijan lineas base de contadores
   * pero NO deben generar marcadores en la timeline.
   */
  kind: 'event' | 'info';

  /**
   * Cuantos milisegundos hace que ocurrio el evento, si el proveedor lo sabe
   * con certeza.
   *
   * Los proveedores por sondeo (como la Live Client Data API de Riot) pueden
   * calcularlo exactamente restando el reloj de la partida, asi que este valor
   * es preferible a la compensacion fija configurada por el usuario, que es
   * solo una estimacion. Cuando esta presente, tiene prioridad.
   */
  latencyHintMs?: number;
}

/** Evento ya normalizado, listo para que el EventManager lo selle con tiempos. */
export interface NormalizedEvent {
  type: GameEventType;
  metadata?: Record<string, unknown>;
}

/**
 * Parche de metadata sobre un evento ya emitido.
 *
 * Hace falta porque algunos datos llegan separados del evento al que
 * pertenecen. Caso real: en Rainbow Six Siege el evento `killer` (UUID del que
 * te ha matado) llega en un mensaje distinto al `death`, milisegundos antes o
 * despues. En lugar de inventar un evento nuevo, adjuntamos el dato a la muerte
 * mas reciente dentro de una ventana temporal.
 */
export interface MetadataPatch {
  targetType: GameEventType;
  withinMs: number;
  metadata: Record<string, unknown>;
}

export interface AdapterOutput {
  events: NormalizedEvent[];
  patches?: MetadataPatch[];
}

const EMPTY: AdapterOutput = { events: [] };

/**
 * Contrato que cumple cada juego.
 *
 * La regla de oro del proyecto: aqui NO se mezcla logica de juegos distintos.
 * VALORANT usa contadores acumulados, Rainbow Six usa eventos discretos con
 * value null, y League of Legends usa JSON serializado. Cada adaptador conoce
 * unicamente su propio formato y lo traduce al modelo comun.
 */
export interface GameAdapter {
  readonly game: GameKey;
  readonly gepGameId: number;
  readonly displayName: string;
  /** Nombres de proceso que identifican al juego (en minusculas). */
  readonly processNames: string[];

  /**
   * Features de GEP a las que hay que suscribirse.
   * Devolver null significa "todas las soportadas por el juego", que es lo que
   * hace el ejemplo oficial de Overwolf pasando null a setRequiredFeatures.
   */
  requiredFeatures(): string[] | null;

  /** Comprueba si un proceso corresponde a este juego. */
  detect(processName: string): boolean;

  /** Prepara el adaptador para una sesion nueva. */
  start(): Promise<void>;

  /** Libera el estado de la sesion. */
  stop(): Promise<void>;

  /** Traduce un payload crudo de GEP a cero o mas eventos normalizados. */
  normalizeEvent(raw: RawGameEvent): AdapterOutput;

  /** Reinicia contadores y estado interno (partida nueva, reconexion de GEP). */
  reset(): void;
}

/**
 * Base comun: gestion del ciclo de vida y del tracker de contadores.
 * Las subclases solo implementan `normalizeEvent` y sus metadatos.
 */
export abstract class BaseGameAdapter implements GameAdapter {
  abstract readonly game: GameKey;
  abstract readonly gepGameId: number;
  abstract readonly displayName: string;
  abstract readonly processNames: string[];

  protected readonly counters = new CounterTracker();
  protected running = false;

  abstract requiredFeatures(): string[] | null;
  abstract normalizeEvent(raw: RawGameEvent): AdapterOutput;

  detect(processName: string): boolean {
    if (!processName) return false;
    const normalized = processName.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
    return this.processNames.some((p) => normalized === p || normalized.startsWith(p));
  }

  async start(): Promise<void> {
    this.reset();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  reset(): void {
    this.counters.reset();
    this.onReset();
  }

  /** Punto de extension para que las subclases limpien su estado propio. */
  protected onReset(): void {
    /* por defecto no hay estado adicional */
  }

  /** Helper para devolver un unico evento. */
  protected one(type: GameEventType, metadata?: Record<string, unknown>): AdapterOutput {
    return { events: [{ type, metadata }] };
  }

  /** Helper para devolver N eventos identicos (contador que salta de 4 a 6). */
  protected repeat(
    type: GameEventType,
    times: number,
    metadata?: Record<string, unknown>,
  ): AdapterOutput {
    if (times <= 0) return EMPTY;
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < times; i++) {
      events.push({ type, metadata: times > 1 ? { ...metadata, burstIndex: i } : metadata });
    }
    return { events };
  }

  protected none(): AdapterOutput {
    return EMPTY;
  }
}

/** Convierte con seguridad un value de GEP a string. */
export function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Parsea un value que puede venir como objeto o como JSON serializado. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
