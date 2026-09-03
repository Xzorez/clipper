import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  EventSettings,
  GameEvent,
  GameEventType,
  GameKey,
  RecordingSummary,
} from '../../shared/types';
import { AdapterOutput, GameAdapter, MetadataPatch, RawGameEvent } from '../games/GameAdapter';
import { RecordingClock } from '../synchronization/RecordingClock';
import { Clock, SystemClock } from '../synchronization/MonotonicClock';
import { createLogger } from '../logging/Logger';

const log = createLogger('EventManager');

/** Cuantos eventos recientes conservamos en memoria para aplicar parches. */
const PATCH_WINDOW_SIZE = 40;

export function emptySummary(): RecordingSummary {
  return { kills: 0, deaths: 0, headshots: 0, assists: 0, knockedOut: 0, rounds: 0 };
}

export interface EventManagerOptions {
  clock?: Clock;
  recordingClock: RecordingClock;
}

/**
 * Punto central de eventos.
 *
 * Responsabilidades:
 *  1. Sellar cada evento con timestamp absoluto, monotonico y posicion de video.
 *  2. Bufferizar los eventos que llegan ANTES de que el video haya arrancado.
 *  3. Aplicar los parches de metadata que emiten los adaptadores.
 *  4. Filtrar por la configuracion del usuario.
 *  5. Mantener el resumen agregado de la partida.
 *  6. Reajustar todos los videoTime cuando llega la reconciliacion del reloj.
 *
 * Deliberadamente NO sabe nada de bases de datos ni de ficheros: emite
 * 'event' y quien corresponda persiste. Asi es testeable sin tocar disco.
 */
export class EventManager extends EventEmitter {
  private readonly clock: Clock;
  private readonly recordingClock: RecordingClock;

  private adapter: GameAdapter | null = null;
  private game: GameKey | null = null;
  private settings: EventSettings | null = null;

  /** Eventos ya sellados de la grabacion en curso. */
  private events: GameEvent[] = [];
  /** Eventos recibidos antes de que el video empezara. */
  private pending: Array<{
    output: AdapterOutput;
    monoNs: bigint;
    wallMs: number;
    latencyMs: number;
  }> = [];
  private summary: RecordingSummary = emptySummary();
  private active = false;

  constructor(options: EventManagerOptions) {
    super();
    this.clock = options.clock ?? new SystemClock();
    this.recordingClock = options.recordingClock;
  }

  get isActive(): boolean {
    return this.active;
  }

  getEvents(): GameEvent[] {
    return [...this.events];
  }

  getSummary(): RecordingSummary {
    return { ...this.summary };
  }

  /** Empieza una sesion de captura de eventos para un juego. */
  begin(adapter: GameAdapter, settings: EventSettings): void {
    this.adapter = adapter;
    this.game = adapter.game;
    this.settings = settings;
    this.events = [];
    this.pending = [];
    this.summary = emptySummary();
    this.active = true;
    log.info(`Sesion de eventos iniciada para ${adapter.displayName}`);
  }

  updateSettings(settings: EventSettings): void {
    this.settings = settings;
  }

  /** Termina la sesion y devuelve los eventos finales. */
  end(): GameEvent[] {
    this.active = false;
    const result = [...this.events];
    log.info(`Sesion de eventos cerrada con ${result.length} eventos`);
    return result;
  }

  /**
   * Entrada principal: recibe un payload crudo de GEP, lo pasa por el adaptador
   * y sella el resultado.
   */
  ingest(raw: RawGameEvent): GameEvent[] {
    if (!this.active || !this.adapter) return [];

    let output: AdapterOutput;
    try {
      output = this.adapter.normalizeEvent(raw);
    } catch (err) {
      // Un payload inesperado jamas debe tumbar la grabacion.
      log.error(
        `El adaptador de ${this.adapter.displayName} fallo con ` +
          `${raw.feature}/${raw.key}: ${(err as Error).message}`,
      );
      return [];
    }

    const monoNs = this.clock.monotonicNs();
    const wallMs = this.clock.wallMs();
    // Una pista exacta del proveedor gana a la estimacion configurada.
    const latencyMs = raw.latencyHintMs ?? this.configuredLatency();

    if (!this.recordingClock.isArmed) {
      // El video aun no ha arrancado: guardamos con su marca monotonica para
      // posicionarlos correctamente en cuanto se fije el ancla.
      if (output.events.length > 0 || output.patches?.length) {
        this.pending.push({ output, monoNs, wallMs, latencyMs });
      }
      return [];
    }

    return this.seal(output, monoNs, wallMs, latencyMs);
  }

  /**
   * Se llama cuando el grabador confirma que el video ha empezado.
   * Vuelca el buffer previo con sus marcas temporales originales.
   */
  onRecordingAnchored(): void {
    if (this.pending.length === 0) return;
    log.info(`Volcando ${this.pending.length} eventos recibidos antes del primer frame`);
    const buffered = this.pending;
    this.pending = [];
    for (const item of buffered) {
      this.seal(item.output, item.monoNs, item.wallMs, item.latencyMs);
    }
  }

  /**
   * Reajusta todos los videoTime tras la reconciliacion del reloj.
   * La correccion es constante, asi que basta con sumarla a todos.
   */
  applyClockCorrection(correctionSec: number): void {
    if (correctionSec === 0 || this.events.length === 0) return;
    for (const event of this.events) {
      event.videoTime = round3(event.videoTime + correctionSec);
      event.beforeRecording = event.videoTime < 0;
    }
    log.info(
      `Reajustados ${this.events.length} eventos con una correccion de ` +
        `${correctionSec >= 0 ? '+' : ''}${correctionSec.toFixed(3)}s`,
    );
    this.emit('events-adjusted', this.getEvents());
  }

  /** Anade un marcador manual (hotkey F9). */
  addBookmark(label?: string): GameEvent | null {
    if (!this.active || !this.game || !this.recordingClock.isArmed) return null;
    const monoNs = this.clock.monotonicNs();
    const sealed = this.seal(
      { events: [{ type: GameEventType.BOOKMARK, metadata: { label: label ?? 'Marcador' } }] },
      monoNs,
      this.clock.wallMs(),
      // Un marcador manual se pone donde el usuario pulsa: sin compensacion.
      0,
    );
    return sealed[0] ?? null;
  }

  // -------------------------------------------------------------------------

  private seal(
    output: AdapterOutput,
    monoNs: bigint,
    wallMs: number,
    latencyMs: number,
  ): GameEvent[] {
    const created: GameEvent[] = [];

    if (output.patches?.length) {
      for (const patch of output.patches) this.applyPatch(patch, wallMs);
    }

    for (const normalized of output.events) {
      if (!this.isEnabled(normalized.type)) continue;

      let videoTime = this.recordingClock.videoTimeFor(monoNs, latencyMs);
      if (!Number.isFinite(videoTime)) continue;

      const beforeRecording = videoTime < 0;
      // Los eventos anteriores al primer frame se conservan (son informacion
      // real de la partida) pero se fijan a 0 para que la timeline sea valida.
      if (beforeRecording) videoTime = 0;

      const event: GameEvent = {
        id: randomUUID(),
        game: this.game as GameKey,
        type: normalized.type,
        timestamp: wallMs,
        monotonicNs: monoNs.toString(),
        videoTime: round3(videoTime),
        metadata: normalized.metadata,
      };
      if (beforeRecording) event.beforeRecording = true;

      this.events.push(event);
      this.updateSummary(event.type);
      created.push(event);

      log.info(`${event.type} en ${event.videoTime.toFixed(3)}s`);
      this.emit('event', event);
    }

    if (created.length > 0) {
      this.emit('summary', this.getSummary());
    }
    return created;
  }

  /**
   * Adjunta metadata al evento mas reciente del tipo indicado, siempre que
   * este dentro de la ventana temporal. Resuelve el caso del `killer` de R6.
   */
  private applyPatch(patch: MetadataPatch, nowMs: number): void {
    const start = Math.max(0, this.events.length - PATCH_WINDOW_SIZE);
    for (let i = this.events.length - 1; i >= start; i--) {
      const candidate = this.events[i];
      if (candidate.type !== patch.targetType) continue;
      if (nowMs - candidate.timestamp > patch.withinMs) break;
      candidate.metadata = { ...(candidate.metadata ?? {}), ...patch.metadata };
      this.emit('event-updated', candidate);
      return;
    }
  }

  private isEnabled(type: GameEventType): boolean {
    const s = this.settings;
    if (!s) return true;
    switch (type) {
      case GameEventType.KILL:
        return s.detectKills;
      case GameEventType.DEATH:
      case GameEventType.KNOCKED_OUT:
        return s.detectDeaths;
      case GameEventType.HEADSHOT:
        return s.detectHeadshots;
      case GameEventType.ASSIST:
        return s.detectAssists;
      case GameEventType.ROUND_START:
      case GameEventType.ROUND_END:
        return s.detectRounds;
      default:
        return true;
    }
  }

  /** Compensacion estimada por el usuario, usada cuando el proveedor no da pista. */
  private configuredLatency(): number {
    if (!this.settings || !this.game) return 0;
    return this.settings.latencyOffsetMs[this.game] ?? 0;
  }

  private updateSummary(type: GameEventType): void {
    switch (type) {
      case GameEventType.KILL:
        this.summary.kills++;
        break;
      case GameEventType.DEATH:
        this.summary.deaths++;
        break;
      case GameEventType.HEADSHOT:
        this.summary.headshots++;
        break;
      case GameEventType.ASSIST:
        this.summary.assists++;
        break;
      case GameEventType.KNOCKED_OUT:
        this.summary.knockedOut++;
        break;
      case GameEventType.ROUND_START:
        this.summary.rounds++;
        break;
      default:
        break;
    }
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Calcula el resumen agregado a partir de una lista de eventos. */
export function summarize(events: Array<Pick<GameEvent, 'type'>>): RecordingSummary {
  const summary = emptySummary();
  for (const event of events) {
    switch (event.type) {
      case GameEventType.KILL:
        summary.kills++;
        break;
      case GameEventType.DEATH:
        summary.deaths++;
        break;
      case GameEventType.HEADSHOT:
        summary.headshots++;
        break;
      case GameEventType.ASSIST:
        summary.assists++;
        break;
      case GameEventType.KNOCKED_OUT:
        summary.knockedOut++;
        break;
      case GameEventType.ROUND_START:
        summary.rounds++;
        break;
      default:
        break;
    }
  }
  return summary;
}
