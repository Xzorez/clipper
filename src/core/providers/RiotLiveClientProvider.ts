import { EventEmitter } from 'node:events';
import { request as httpsRequest } from 'node:https';
import { ProviderState } from '../../shared/types';
import { RawGameEvent } from '../games/GameAdapter';
import { createLogger } from '../logging/Logger';

const log = createLogger('RiotLive');

/** Puerto fijo que Riot reserva para el cliente de juego de League of Legends. */
const PORT = 2999;
const HOST = '127.0.0.1';
const ENDPOINT = '/liveclientdata/allgamedata';

const POLL_INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 2500;

/** Fallos consecutivos antes de dar la partida por terminada. */
const MISSES_BEFORE_GAME_OVER = 3;

export interface RiotEvent {
  EventID: number;
  EventName: string;
  EventTime: number;
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  Result?: string;
  KillStreak?: number;
  Acer?: string;
}

export interface AllGameData {
  activePlayer?: { summonerName?: string; riotId?: string; riotIdGameName?: string };
  events?: { Events?: RiotEvent[] };
  gameData?: { gameTime?: number; gameMode?: string; mapName?: string };
}

/** Obtiene el estado de la partida. Se inyecta en los tests. */
export type GameDataFetcher = () => Promise<AllGameData>;

/**
 * Proveedor de eventos nativo para League of Legends.
 *
 * Usa la Live Client Data API que el propio cliente de Riot expone en
 * `https://127.0.0.1:2999`. Es la MISMA fuente que la feature `live_client_data`
 * de Overwolf GEP envuelve, asi que ir directamente no pierde nada: de hecho
 * gana, porque entrega los nombres del asesino, la victima y los asistentes,
 * datos que GEP no expone en sus contadores.
 *
 * Sobre su legitimidad: es un endpoint HTTP local, de solo lectura, que Riot
 * documenta en su portal de desarrolladores. No hay inyeccion, ni lectura de
 * memoria, ni interaccion con el proceso del juego. Riot lo marca como "no
 * soportado oficialmente para terceros", que es exactamente el mismo estatus
 * bajo el que opera Overwolf con esta fuente.
 *
 * ## Precision temporal
 *
 * El sondeo cada segundo introduciria hasta un segundo de imprecision si nos
 * limitaramos a la hora de llegada. Se evita usando el reloj de la partida: la
 * respuesta trae `gameData.gameTime` y cada evento su `EventTime`, ambos en
 * segundos de juego. La diferencia dice exactamente cuanto hace que ocurrio el
 * evento, y se envia como `latencyHintMs`. El resultado es MAS preciso que la
 * compensacion fija estimada que se usa con GEP.
 *
 * Los eventos se traducen al mismo formato `{feature, key, value}` de GEP para
 * que `LeagueOfLegendsAdapter` los procese sin cambios: el adaptador no sabe ni
 * necesita saber de que proveedor vienen.
 */
export class RiotLiveClientProvider extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: ProviderState = { status: 'unavailable', provider: 'riot-live-client' };

  private lastEventId = -1;
  private localPlayer: string | null = null;
  private consecutiveMisses = 0;
  private inGame = false;

  /** Contadores propios: el adaptador de LoL espera totales acumulados. */
  private kills = 0;
  private deaths = 0;
  private assists = 0;

  private readonly fetcher: GameDataFetcher;

  /**
   * El obtenedor de datos se inyecta para poder probar toda la cadena
   * (deteccion, deduplicado, traduccion, fin de partida) sin depender de que
   * haya un cliente de League of Legends abierto.
   */
  constructor(fetcher: GameDataFetcher = fetchAllGameData) {
    super();
    this.fetcher = fetcher;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  get isInGame(): boolean {
    return this.inGame;
  }

  start(): void {
    if (this.timer) return;
    log.info('Sondeo de la Live Client Data API de Riot iniciado');
    this.setState({
      status: 'connecting',
      provider: 'riot-live-client',
      message: 'Esperando una partida de League of Legends...',
    });
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resetMatch();
    this.setState({ status: 'unavailable', provider: 'riot-live-client' });
    log.info('Sondeo detenido');
  }

  private resetMatch(): void {
    this.lastEventId = -1;
    this.localPlayer = null;
    this.consecutiveMisses = 0;
    this.inGame = false;
    this.kills = 0;
    this.deaths = 0;
    this.assists = 0;
  }

  // -------------------------------------------------------------------------

  /** Un ciclo de sondeo. Publico para poder dirigirlo desde los tests. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const data = await this.fetcher();
      this.consecutiveMisses = 0;

      if (!this.inGame) {
        this.inGame = true;
        this.setState({
          status: 'connected',
          provider: 'riot-live-client',
          message: 'Recibiendo eventos de League of Legends',
        });
        log.info('Partida de League of Legends detectada');
        this.emit('game-detected', { game: 'lol' });
      }

      this.identifyLocalPlayer(data);
      this.processEvents(data);
    } catch (err) {
      this.onPollFailure(err as NodeJS.ErrnoException);
    } finally {
      this.polling = false;
    }
  }

  private onPollFailure(err: NodeJS.ErrnoException): void {
    // Que el puerto esté cerrado es lo normal fuera de partida, no un error.
    const expected = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';

    if (!this.inGame) {
      if (!expected) log.debug(`Sondeo sin respuesta: ${err.message}`);
      return;
    }

    this.consecutiveMisses++;
    if (this.consecutiveMisses >= MISSES_BEFORE_GAME_OVER) {
      log.info('La partida de League of Legends ha terminado');
      const hadGame = this.inGame;
      this.resetMatch();
      this.setState({
        status: 'connecting',
        provider: 'riot-live-client',
        message: 'Esperando una partida de League of Legends...',
      });
      if (hadGame) this.emit('game-exit', { game: 'lol' });
    }
  }

  /**
   * Determina el nombre del jugador local, necesario para saber si una kill
   * es nuestra o de otro. Riot ha cambiado el formato entre parches
   * (nombre suelto, riotId con etiqueta), asi que se aceptan varias claves.
   */
  private identifyLocalPlayer(data: AllGameData): void {
    if (this.localPlayer) return;
    const active = data.activePlayer;
    if (!active) return;

    const name = active.riotId ?? active.summonerName ?? active.riotIdGameName;
    if (name) {
      this.localPlayer = name;
      log.info(`Jugador local identificado: ${name}`);
    }
  }

  private processEvents(data: AllGameData): void {
    const events = data.events?.Events ?? [];
    if (events.length === 0) return;

    const gameTime = data.gameData?.gameTime ?? 0;

    for (const event of events) {
      if (typeof event?.EventID !== 'number') continue;

      // Un EventID menor que el ultimo visto significa partida nueva.
      if (event.EventID <= this.lastEventId) continue;
      this.lastEventId = event.EventID;

      // Antiguedad real del evento, derivada del reloj de la partida.
      const ageMs = Math.max(0, Math.round((gameTime - (event.EventTime ?? gameTime)) * 1000));

      for (const raw of this.translate(event, ageMs)) {
        this.emit('raw', raw);
      }
    }
  }

  /**
   * Traduce un evento de Riot al formato de GEP que el adaptador de LoL
   * ya sabe interpretar.
   */
  private translate(event: RiotEvent, ageMs: number): RawGameEvent[] {
    const base = { gameId: 5426, kind: 'event' as const, latencyHintMs: ageMs };

    switch (event.EventName) {
      case 'GameStart':
        this.kills = 0;
        this.deaths = 0;
        this.assists = 0;
        return [{ ...base, feature: 'matchState', key: 'matchStart', value: null }];

      case 'GameEnd': {
        // Result es "Win" o "Lose"; el adaptador espera victory/defeat.
        const key = event.Result === 'Win' ? 'victory' : 'defeat';
        return [{ ...base, feature: 'announcer', key, value: null }];
      }

      case 'ChampionKill':
        return this.translateChampionKill(event, base);

      default:
        // El resto (torres, dragones, barón, ace...) no son eventos del jugador
        // y de momento no generan marcadores.
        return [];
    }
  }

  private translateChampionKill(
    event: RiotEvent,
    base: { gameId: number; kind: 'event'; latencyHintMs: number },
  ): RawGameEvent[] {
    const me = this.localPlayer;
    if (!me) return [];

    const result: RawGameEvent[] = [];

    if (namesMatch(event.KillerName, me)) {
      this.kills++;
      result.push({
        ...base,
        feature: 'kill',
        key: 'kill',
        value: {
          label: 'kill',
          count: 1,
          totalKills: this.kills,
          victim: event.VictimName,
          assisters: event.Assisters ?? [],
        },
      });
    }

    if (namesMatch(event.VictimName, me)) {
      this.deaths++;
      result.push({
        ...base,
        feature: 'death',
        key: 'death',
        value: { totalDeaths: this.deaths, killer: event.KillerName },
      });
    }

    if ((event.Assisters ?? []).some((assister) => namesMatch(assister, me))) {
      this.assists++;
      result.push({
        ...base,
        feature: 'assist',
        key: 'assist',
        value: { totalAssists: this.assists, victim: event.VictimName },
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

/**
 * Compara nombres de invocador tolerando los cambios de formato de Riot.
 * "Jugador#EUW" y "Jugador" deben considerarse la misma persona.
 */
export function namesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const stripA = a.split('#')[0].trim().toLowerCase();
  const stripB = b.split('#')[0].trim().toLowerCase();
  return stripA !== '' && stripA === stripB;
}

/**
 * Consulta el endpoint local del cliente de League of Legends.
 *
 * El cliente sirve HTTPS con un certificado autofirmado de Riot, asi que la
 * verificacion se desactiva SOLO para esta peticion concreta a 127.0.0.1.
 * No afecta a ninguna otra conexion de la aplicacion, y el destino es el propio
 * equipo, no una red que un tercero pueda interceptar.
 */
export function fetchAllGameData(): Promise<AllGameData> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: HOST,
        port: PORT,
        path: ENDPOINT,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`respuesta ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as AllGameData);
          } catch (err) {
            reject(new Error(`respuesta ilegible: ${(err as Error).message}`));
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('tiempo de espera agotado'));
    });
    req.on('error', reject);
    req.end();
  });
}
