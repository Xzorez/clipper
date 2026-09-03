import { EventEmitter } from 'node:events';
import { GEP_GAME_IDS, ProviderState } from '../../../shared/types';
import { RawGameEvent } from '../../games/GameAdapter';
import { buildContext, ValorantContext } from './ValorantLocalAuth';
import {
  fetchMatchHistory,
  fetchMatchDetails,
  MatchSummary,
  ParsedMatch,
} from './ValorantMatchApi';
import { createLogger } from '../../logging/Logger';

const log = createLogger('Valorant');

/**
 * Intervalo de sondeo del historial.
 *
 * Una partida solo aparece en el historial cuando ha terminado, asi que sondear
 * cada pocos segundos no aportaria nada y castigaria la API de Riot sin motivo.
 * Noventa segundos basta para recoger una partida terminada mientras sigues
 * jugando la siguiente.
 */
const POLL_INTERVAL_MS = 90_000;

/** Reintentos de obtencion de credenciales mientras el cliente arranca. */
const CONTEXT_RETRY_MS = 15_000;

export interface ValorantProviderDeps {
  /** Se inyecta en los tests para no depender del cliente de Riot. */
  buildContext?: () => Promise<ValorantContext | null>;
  fetchHistory?: (context: ValorantContext, count: number) => Promise<MatchSummary[] | null>;
  fetchDetails?: (context: ValorantContext, matchId: string) => Promise<ParsedMatch | null>;
  now?: () => number;
}

/**
 * Proveedor de eventos de VALORANT sin Overwolf.
 *
 * Riot no expone kills en tiempo real para VALORANT, y su politica rechaza los
 * overlays que dan ventaja durante la partida. Lo que si acepta expresamente es
 * el historial personal de partidas, y eso es justo lo que se usa aqui: al
 * terminar una partida, se consulta su detalle y se marcan los eventos sobre la
 * grabacion.
 *
 * ## Como se autentica
 *
 * El cliente de Riot escribe un lockfile con un puerto y una contrasena. Con
 * ellos se le piden al propio cliente las credenciales de la sesion, y con esas
 * credenciales se consulta el historial del jugador. No hay inyeccion, ni
 * lectura de memoria, ni contacto con el proceso del juego.
 *
 * Las credenciales viven solo en memoria, nunca se escriben en el log ni en la
 * base de datos, y solo viajan a los servidores de Riot.
 *
 * ## Precision
 *
 * La mejor de los tres juegos. `gameStartMillis` da el inicio absoluto de la
 * partida y cada kill trae su desplazamiento en milisegundos, asi que la
 * posicion en el video sale exacta sin ninguna calibracion.
 *
 * ## Limitacion
 *
 * No hay headshots por kill en estos datos, asi que esta via no los emite. Es
 * la unica diferencia funcional frente a Overwolf.
 */
export class ValorantMatchProvider extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private contextTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: ProviderState = { status: 'unavailable', provider: 'valorant-match-api' };

  private context: ValorantContext | null = null;
  private sessionStartMs = 0;
  private readonly processed = new Set<string>();
  private readonly deps: Required<ValorantProviderDeps>;

  constructor(deps: ValorantProviderDeps = {}) {
    super();
    this.deps = {
      buildContext: deps.buildContext ?? (() => buildContext()),
      fetchHistory: deps.fetchHistory ?? fetchMatchHistory,
      fetchDetails: deps.fetchDetails ?? fetchMatchDetails,
      now: deps.now ?? (() => Date.now()),
    };
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  get hasSession(): boolean {
    return this.context !== null;
  }

  /**
   * Empieza a vigilar. Solo se consideran las partidas iniciadas a partir de
   * `sessionStartMs`, para no importar el historial entero del jugador.
   */
  start(sessionStartMs: number): void {
    this.sessionStartMs = sessionStartMs;
    this.processed.clear();
    this.context = null;

    this.setState({
      status: 'connecting',
      provider: 'valorant-match-api',
      message: 'Conectando con el cliente de Riot...',
    });

    void this.ensureContext();

    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.contextTimer) {
      clearTimeout(this.contextTimer);
      this.contextTimer = null;
    }
    this.context = null;
    this.setState({ status: 'unavailable', provider: 'valorant-match-api' });
  }

  /**
   * Recoge la ultima partida antes de cerrar la grabacion.
   *
   * Igual que en Rainbow Six: la partida aparece en el historial cuando ha
   * terminado, es decir, cuando el juego ya se esta cerrando. Sin esta espera
   * sus eventos llegarian con la grabacion ya consolidada.
   */
  async drain(waitMs = 6000): Promise<void> {
    if (!this.context) await this.ensureContext();
    if (!this.context) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.poll();
  }

  /**
   * Obtiene las credenciales, reintentando mientras el cliente no las exponga.
   *
   * Con el cliente de Riot en segundo plano la API de sesion no existe todavia:
   * responde 404. No es un error, solo hay que esperar a que el juego arranque.
   */
  private async ensureContext(): Promise<void> {
    if (this.context) return;

    try {
      this.context = await this.deps.buildContext();
    } catch (err) {
      log.debug(`No se pudieron obtener credenciales: ${(err as Error).message}`);
      this.context = null;
    }

    if (this.context) {
      log.info(`Sesion de VALORANT lista (region ${this.context.shard})`);
      this.setState({
        status: 'connected',
        provider: 'valorant-match-api',
        message: 'Se marcaran los eventos al terminar cada partida',
      });
      void this.poll();
      return;
    }

    this.setState({
      status: 'connecting',
      provider: 'valorant-match-api',
      message: 'Esperando a que el cliente de Riot inicie sesion...',
    });

    if (this.timer && !this.contextTimer) {
      this.contextTimer = setTimeout(() => {
        this.contextTimer = null;
        void this.ensureContext();
      }, CONTEXT_RETRY_MS);
    }
  }

  /** Una pasada de sondeo. Publico para poder dirigirlo desde los tests. */
  async poll(): Promise<void> {
    if (this.polling) return;
    if (!this.context) {
      await this.ensureContext();
      if (!this.context) return;
    }

    this.polling = true;
    try {
      const history = await this.deps.fetchHistory(this.context, 5);
      if (history === null) {
        // Las credenciales caducan; se fuerza una renovacion en el siguiente ciclo.
        log.debug('El historial no respondio; se renovaran las credenciales');
        this.context = null;
        return;
      }

      for (const summary of history) {
        if (this.processed.has(summary.matchId)) continue;
        if (summary.gameStartMillis > 0 && summary.gameStartMillis < this.sessionStartMs) {
          continue;
        }
        this.processed.add(summary.matchId);
        await this.ingestMatch(summary.matchId);
      }
    } catch (err) {
      log.warn(`Fallo al consultar el historial: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async ingestMatch(matchId: string): Promise<void> {
    if (!this.context) return;

    const match = await this.deps.fetchDetails(this.context, matchId);
    if (!match) return;

    if (match.events.length === 0) {
      log.info('Partida leida sin eventos del jugador local');
      return;
    }

    log.info(`Partida leida: ${match.events.length} eventos del jugador local`);

    for (const raw of this.toRawEvents(match)) {
      this.emit('raw', raw);
    }
    this.emit('match-parsed', { matchId: match.matchId, events: match.events.length });
  }

  /**
   * Convierte los eventos al formato que espera el adaptador de VALORANT.
   *
   * El adaptador trabaja con contadores acumulados, exactamente igual que los
   * que entrega GEP, asi que se le entregan totales crecientes y no necesita
   * ningun cambio: no sabe ni le importa de que proveedor vienen.
   */
  private toRawEvents(match: ParsedMatch): RawGameEvent[] {
    const now = this.deps.now();
    const result: RawGameEvent[] = [];

    let kills = 0;
    let deaths = 0;
    let assists = 0;

    // Inicio de partida, para delimitar la sesion en la timeline.
    result.push({
      gameId: GEP_GAME_IDS.valorant,
      kind: 'event',
      feature: 'match_info',
      key: 'match_start',
      value: null,
      latencyHintMs: Math.max(0, now - match.startedAtMs),
    });

    for (const event of match.events) {
      // El evento ya ocurrio: se indica cuanto hace para colocarlo en su sitio
      // del video, no en el instante en que se leyo el historial.
      const latencyHintMs = Math.max(0, now - event.occurredAtMs);
      const common = {
        gameId: GEP_GAME_IDS.valorant,
        kind: 'event' as const,
        latencyHintMs,
      };

      if (event.type === 'kill') {
        kills++;
        result.push({ ...common, feature: 'kill', key: 'kill', value: kills });
      } else if (event.type === 'death') {
        deaths++;
        result.push({ ...common, feature: 'death', key: 'death', value: deaths });
      } else {
        assists++;
        result.push({ ...common, feature: 'kill', key: 'assist', value: assists });
      }
    }

    if (match.endedAtMs !== null) {
      result.push({
        gameId: GEP_GAME_IDS.valorant,
        kind: 'event',
        feature: 'match_info',
        key: 'match_end',
        value: null,
        latencyHintMs: Math.max(0, now - match.endedAtMs),
      });
    }

    return result;
  }

  private setState(state: ProviderState): void {
    this.state = state;
    this.emit('state', this.getState());
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}
