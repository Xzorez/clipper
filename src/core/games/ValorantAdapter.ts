import { GameEventType, GameKey, GEP_GAME_IDS } from '../../shared/types';
import {
  AdapterOutput,
  BaseGameAdapter,
  RawGameEvent,
  asObject,
  asString,
} from './GameAdapter';

/**
 * Adaptador de VALORANT (GEP game id 21640).
 *
 * Formato de los datos, segun la documentacion oficial de Overwolf:
 *
 *  Feature `kill`
 *    eventos: kill / assist / headshot  -> el value es el TOTAL ACUMULADO
 *    info:    kills / assists / headshots -> mismo total, sirve de linea base
 *
 *  Feature `death`
 *    evento:  death   -> total acumulado de muertes
 *    info:    deaths  -> linea base
 *
 *  Feature `match_info`
 *    eventos: match_start, match_end, kill_feed, spike_planted/defused...
 *    info:    round_number, round_phase, score, roster, scoreboard, map...
 *
 *  Feature `game_info`
 *    info:    scene, state ('WaitingToStart' | 'InProgress' | 'LeavingMap' | ...)
 *
 * Punto importante: `round_phase` es un INFO UPDATE, no un evento. VALORANT no
 * emite round_start / round_end, asi que los derivamos de las transiciones de
 * fase ('shopping' -> ronda nueva, 'end' -> ronda terminada).
 *
 * Otro detalle: una kill con headshot dispara DOS eventos (kill y headshot).
 * Es correcto y deliberado que aparezcan ambos marcadores en la timeline.
 */
export class ValorantAdapter extends BaseGameAdapter {
  readonly game: GameKey = 'valorant';
  readonly gepGameId = GEP_GAME_IDS.valorant;
  readonly displayName = 'VALORANT';
  readonly processNames = ['valorant-win64-shipping.exe', 'valorant.exe'];

  private roundPhase: string | null = null;
  private roundNumber: number | null = null;
  private lastKillFeed: Record<string, unknown> | null = null;

  requiredFeatures(): string[] | null {
    return ['kill', 'death', 'match_info', 'game_info', 'me'];
  }

  protected onReset(): void {
    this.roundPhase = null;
    this.roundNumber = null;
    this.lastKillFeed = null;
  }

  normalizeEvent(raw: RawGameEvent): AdapterOutput {
    return raw.kind === 'info' ? this.handleInfo(raw) : this.handleEvent(raw);
  }

  // -------------------------------------------------------------------------
  // Info updates: fijan lineas base y derivan el ciclo de ronda.
  // -------------------------------------------------------------------------
  private handleInfo(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'kill') {
      // Sembramos la linea base para no inventar kills si la app arranca
      // con la partida ya empezada.
      if (key === 'kills' || key === 'assists' || key === 'headshots') {
        this.counters.seed(key.slice(0, -1), value);
      }
      return this.none();
    }

    if (feature === 'death' && key === 'deaths') {
      this.counters.seed('death', value);
      return this.none();
    }

    if (feature === 'match_info') {
      if (key === 'round_number') {
        const n = Number(asString(value));
        if (Number.isFinite(n)) this.roundNumber = n;
        return this.none();
      }

      if (key === 'round_phase') {
        return this.handleRoundPhase(asString(value));
      }

      if (key === 'kill_feed') {
        // Guardamos el ultimo kill feed para enriquecer la siguiente kill.
        const parsed = asObject(value);
        if (parsed) this.lastKillFeed = parsed;
        return this.none();
      }
    }

    if (feature === 'game_info' && key === 'state') {
      const state = asString(value);
      // 'InProgress' confirma partida en curso; no generamos marcador porque
      // match_start ya cubre ese instante, pero reseteamos si volvemos al menu.
      if (state === 'Init' || state === 'WaitingToStart') {
        this.counters.reset();
      }
      return this.none();
    }

    return this.none();
  }

  /**
   * Deriva ROUND_START / ROUND_END de las transiciones de `round_phase`.
   * Fases documentadas: 'shopping' | 'combat' | 'end' | 'game_end'.
   */
  private handleRoundPhase(phase: string | undefined): AdapterOutput {
    if (!phase || phase === this.roundPhase) return this.none();

    const previous = this.roundPhase;
    this.roundPhase = phase;

    if (phase === 'shopping' && previous !== null) {
      return this.one(GameEventType.ROUND_START, { round: this.roundNumber, phase });
    }
    if (phase === 'end') {
      return this.one(GameEventType.ROUND_END, { round: this.roundNumber, phase });
    }
    return this.none();
  }

  // -------------------------------------------------------------------------
  // Eventos: ocurrencias reales. Los contadores se diferencian aqui.
  // -------------------------------------------------------------------------
  private handleEvent(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'kill') {
      switch (key) {
        case 'kill': {
          const obs = this.counters.observe('kill', value);
          const metadata = this.buildKillMetadata(obs.current);
          this.lastKillFeed = null;
          return this.repeat(GameEventType.KILL, obs.occurrences, metadata);
        }
        case 'assist': {
          const obs = this.counters.observe('assist', value);
          return this.repeat(GameEventType.ASSIST, obs.occurrences, {
            totalAssists: obs.current,
          });
        }
        case 'headshot': {
          const obs = this.counters.observe('headshot', value);
          return this.repeat(GameEventType.HEADSHOT, obs.occurrences, {
            totalHeadshots: obs.current,
          });
        }
      }
      return this.none();
    }

    if (feature === 'death' && key === 'death') {
      const obs = this.counters.observe('death', value);
      return this.repeat(GameEventType.DEATH, obs.occurrences, {
        totalDeaths: obs.current,
        round: this.roundNumber,
      });
    }

    if (feature === 'match_info') {
      switch (key) {
        case 'match_start':
          // Partida nueva: los contadores del jugador vuelven a cero.
          this.counters.reset();
          this.roundPhase = null;
          this.roundNumber = null;
          return this.one(GameEventType.MATCH_START, {});
        case 'match_end':
          return this.one(GameEventType.MATCH_END, {
            outcome: asString(value),
          });
        case 'kill_feed': {
          // El kill_feed tambien llega como evento. Solo lo usamos para
          // enriquecer la kill correspondiente, nunca como marcador propio.
          const parsed = asObject(value);
          if (!parsed) return this.none();
          this.lastKillFeed = parsed;
          if (this.isLocalPlayerKill(parsed)) {
            return {
              events: [],
              patches: [
                {
                  targetType: GameEventType.KILL,
                  withinMs: 2500,
                  metadata: this.killFeedMetadata(parsed),
                },
              ],
            };
          }
          return this.none();
        }
      }
    }

    return this.none();
  }

  /**
   * El kill_feed incluye tanto kills propias como ajenas. Solo nos interesan
   * las nuestras, marcadas por el flag `is_local_player` en el atacante.
   */
  private isLocalPlayerKill(feed: Record<string, unknown>): boolean {
    const flag = feed['is_local_player_kill'] ?? feed['is_local_player'];
    if (typeof flag === 'boolean') return flag;
    if (typeof flag === 'string') return flag.toLowerCase() === 'true';
    return false;
  }

  private killFeedMetadata(feed: Record<string, unknown>): Record<string, unknown> {
    return {
      victim: feed['victim'] ?? feed['killed'],
      weapon: feed['weapon'],
      headshot: feed['headshot'] ?? feed['is_headshot'],
      assists: feed['assists'],
    };
  }

  private buildKillMetadata(total: number): Record<string, unknown> {
    const base: Record<string, unknown> = { totalKills: total, round: this.roundNumber };
    if (this.lastKillFeed && this.isLocalPlayerKill(this.lastKillFeed)) {
      Object.assign(base, this.killFeedMetadata(this.lastKillFeed));
    }
    return base;
  }
}
