import { request as httpsRequest } from 'node:https';
import { CLIENT_PLATFORM, ValorantContext } from './ValorantLocalAuth';
import { createLogger } from '../../logging/Logger';

const log = createLogger('Valorant');

const REQUEST_TIMEOUT_MS = 10_000;

export interface MatchSummary {
  matchId: string;
  gameStartMillis: number;
  queueId: string;
}

export type ValorantEventType = 'kill' | 'death' | 'assist';

export interface ValorantMatchEvent {
  type: ValorantEventType;
  /** Instante absoluto del evento, en epoch ms. */
  occurredAtMs: number;
  /** Nombre del oponente implicado, si se ha podido resolver. */
  opponent?: string;
  weapon?: string;
  round?: number;
}

export interface ParsedMatch {
  matchId: string;
  startedAtMs: number;
  endedAtMs: number | null;
  mapId?: string;
  queueId?: string;
  events: ValorantMatchEvent[];
}

/**
 * Cliente de la API de partidas de VALORANT.
 *
 * Habla con los endpoints que el propio cliente del juego usa, autenticandose
 * con las credenciales de la sesion local del usuario. No hay inyeccion ni
 * lectura de memoria: son peticiones HTTPS a los servidores de Riot pidiendo
 * el historial de partidas del propio jugador.
 *
 * Las credenciales solo viajan a `*.a.pvp.net` y nunca se registran.
 */

/** Historial reciente del jugador. Devuelve null si la peticion falla. */
export async function fetchMatchHistory(
  context: ValorantContext,
  count = 5,
): Promise<MatchSummary[] | null> {
  const path = `/match-history/v1/history/${context.puuid}?startIndex=0&endIndex=${count}`;
  const response = await apiRequest(context, path);
  if (!response) return null;

  if (response.status !== 200) {
    log.warn(`El historial de partidas respondio ${response.status}`);
    return null;
  }

  try {
    const parsed = JSON.parse(response.body) as {
      History?: Array<{ MatchID?: string; GameStartTime?: number; QueueID?: string }>;
    };
    return (parsed.History ?? [])
      .filter((entry) => typeof entry.MatchID === 'string')
      .map((entry) => ({
        matchId: entry.MatchID as string,
        gameStartMillis: Number(entry.GameStartTime) || 0,
        queueId: entry.QueueID ?? '',
      }));
  } catch {
    return null;
  }
}

/** Detalle completo de una partida, ya traducido a eventos del jugador local. */
export async function fetchMatchDetails(
  context: ValorantContext,
  matchId: string,
): Promise<ParsedMatch | null> {
  const response = await apiRequest(context, `/match-details/v1/matches/${matchId}`);
  if (!response) return null;

  if (response.status !== 200) {
    log.warn(`El detalle de la partida respondio ${response.status}`);
    return null;
  }

  try {
    return extractMatch(JSON.parse(response.body), context.puuid);
  } catch (err) {
    log.warn(`No se pudo interpretar el detalle de la partida: ${(err as Error).message}`);
    return null;
  }
}

interface RawKill {
  gameTime?: number;
  roundTime?: number;
  killer?: string;
  victim?: string;
  round?: number;
  assistants?: string[];
  finishingDamage?: { damageType?: string; damageItem?: string };
}

interface RawMatch {
  matchInfo?: {
    matchId?: string;
    gameStartMillis?: number;
    gameLengthMillis?: number;
    mapId?: string;
    queueID?: string;
    isCompleted?: boolean;
  };
  players?: Array<{ subject?: string; gameName?: string; tagLine?: string }>;
  kills?: RawKill[];
  roundResults?: Array<{
    roundNum?: number;
    playerStats?: Array<{ subject?: string; kills?: RawKill[] }>;
  }>;
}

/**
 * Traduce el detalle de una partida a los eventos del jugador local.
 *
 * ## Sobre la precision temporal
 *
 * Es la mejor de los tres juegos, y por un motivo concreto: `gameStartMillis`
 * da el instante absoluto de inicio de partida y cada kill trae `gameTime` en
 * milisegundos desde ese inicio. Sumandolos se obtiene el instante exacto del
 * evento, sin estimaciones ni calibracion. Rainbow Six necesita un ajuste
 * manual porque su fichero no dice cuando arranca el reloj de ronda; aqui ese
 * problema no existe.
 *
 * ## Lo que esta via NO da
 *
 * No hay indicador de headshot por kill: el detalle solo trae disparos a la
 * cabeza agregados por ronda, que no permiten saber si el disparo mortal lo
 * fue. Deducirlo seria inventarse el dato, asi que no se emiten headshots por
 * esta via. Es la unica diferencia funcional frente a Overwolf.
 */
export function extractMatch(raw: RawMatch, puuid: string): ParsedMatch | null {
  const info = raw.matchInfo;
  if (!info || typeof info.gameStartMillis !== 'number' || info.gameStartMillis <= 0) {
    return null;
  }

  const startedAtMs = info.gameStartMillis;
  const length = typeof info.gameLengthMillis === 'number' ? info.gameLengthMillis : null;

  const names = new Map<string, string>();
  for (const player of raw.players ?? []) {
    if (!player.subject) continue;
    const name = player.gameName
      ? player.tagLine
        ? `${player.gameName}#${player.tagLine}`
        : player.gameName
      : '';
    if (name) names.set(player.subject, name);
  }

  const events: ValorantMatchEvent[] = [];
  const seen = new Set<string>();

  for (const kill of collectKills(raw)) {
    if (typeof kill.gameTime !== 'number') continue;

    const occurredAtMs = startedAtMs + kill.gameTime;
    const isKiller = kill.killer === puuid;
    const isVictim = kill.victim === puuid;
    const isAssistant = (kill.assistants ?? []).includes(puuid);

    if (!isKiller && !isVictim && !isAssistant) continue;

    // El detalle repite las kills en la raiz y dentro de cada ronda.
    const signature = `${kill.gameTime}:${kill.killer ?? ''}:${kill.victim ?? ''}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    if (isKiller) {
      events.push({
        type: 'kill',
        occurredAtMs,
        opponent: kill.victim ? names.get(kill.victim) : undefined,
        weapon: kill.finishingDamage?.damageItem,
        round: kill.round,
      });
    }

    if (isVictim) {
      events.push({
        type: 'death',
        occurredAtMs,
        opponent: kill.killer ? names.get(kill.killer) : undefined,
        weapon: kill.finishingDamage?.damageItem,
        round: kill.round,
      });
    }

    // Una asistencia propia solo cuenta si la victima no somos nosotros.
    if (isAssistant && !isVictim && !isKiller) {
      events.push({
        type: 'assist',
        occurredAtMs,
        opponent: kill.victim ? names.get(kill.victim) : undefined,
        round: kill.round,
      });
    }
  }

  events.sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  return {
    matchId: info.matchId ?? '',
    startedAtMs,
    endedAtMs: length !== null ? startedAtMs + length : null,
    mapId: info.mapId,
    queueId: info.queueID,
    events,
  };
}

/**
 * Reune las kills de las dos ubicaciones donde aparecen.
 * La lista de la raiz suele estar completa, pero no siempre existe, asi que se
 * complementa con las de cada ronda. El deduplicado posterior se encarga.
 */
function collectKills(raw: RawMatch): RawKill[] {
  const all: RawKill[] = [...(raw.kills ?? [])];
  for (const round of raw.roundResults ?? []) {
    for (const stats of round.playerStats ?? []) {
      for (const kill of stats.kills ?? []) {
        all.push({ ...kill, round: kill.round ?? round.roundNum });
      }
    }
  }
  return all;
}

interface ApiResponse {
  status: number;
  body: string;
}

/**
 * Peticion autenticada a la API de partidas.
 * Las credenciales solo se usan aqui y solo contra el dominio de Riot.
 */
function apiRequest(context: ValorantContext, path: string): Promise<ApiResponse | null> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: `pd.${context.shard}.a.pvp.net`,
        path,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          'X-Riot-Entitlements-JWT': context.entitlementsToken,
          'X-Riot-ClientPlatform': CLIENT_PLATFORM,
          'X-Riot-ClientVersion': context.version,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      log.debug(`Peticion a la API de VALORANT fallida: ${err.message}`);
      resolve(null);
    });
    req.end();
  });
}
