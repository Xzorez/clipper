import { GameEventType, GameKey, GEP_GAME_IDS } from '../../shared/types';
import { AdapterOutput, BaseGameAdapter, RawGameEvent, asObject, asString } from './GameAdapter';

/**
 * Adaptador de League of Legends (GEP game id 5426; el PBE es 22848).
 *
 * Formato segun la documentacion oficial:
 *
 *   Feature `kill`
 *     evento: kill  -> JSON: { label, count, totalKills }
 *     info:   kills, doubleKills, tripleKills, quadraKills, pentaKills
 *
 *   Feature `death`
 *     evento: death -> objeto con contador
 *     info:   deaths
 *
 *   Feature `assist`  -> evento assist con contador
 *   Feature `respawn` -> evento respawn (null, discreto)
 *
 *   Feature `matchState`
 *     evento: matchStart
 *     evento: matchEnd  ->  DEPRECADO por Overwolf
 *     info:   matchStarted, matchId, queueId
 *
 * Detalle relevante: la documentacion marca `matchEnd` como deprecado y remite
 * a la feature `announcer`. Por eso el fin de partida se deriva de los eventos
 * `victory` / `defeat` del announcer, y `matchEnd` se mantiene solo como
 * respaldo por si sigue llegando en algunas versiones.
 *
 * League of Legends no tiene headshots: este adaptador nunca emite HEADSHOT.
 */
export class LeagueOfLegendsAdapter extends BaseGameAdapter {
  readonly game: GameKey = 'lol';
  readonly gepGameId = GEP_GAME_IDS.lol;
  readonly displayName = 'League of Legends';
  readonly processNames = ['league of legends.exe'];

  private matchEnded = false;
  private championLevel: number | null = null;

  requiredFeatures(): string[] | null {
    return [
      'kill',
      'death',
      'assist',
      'respawn',
      'matchState',
      'match_info',
      'announcer',
      'summoner_info',
      'level',
    ];
  }

  protected onReset(): void {
    this.matchEnded = false;
    this.championLevel = null;
  }

  normalizeEvent(raw: RawGameEvent): AdapterOutput {
    return raw.kind === 'info' ? this.handleInfo(raw) : this.handleEvent(raw);
  }

  private handleInfo(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'kill' && key === 'kills') {
      this.counters.seed('kill', value);
      return this.none();
    }
    if (feature === 'death' && key === 'deaths') {
      this.counters.seed('death', value);
      return this.none();
    }
    if (feature === 'level' && key === 'level') {
      const n = Number(asString(value));
      if (Number.isFinite(n)) this.championLevel = n;
      return this.none();
    }
    if (feature === 'matchState' && key === 'matchStarted') {
      const started = asString(value);
      if (started === 'false') this.counters.reset();
      return this.none();
    }
    return this.none();
  }

  private handleEvent(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'kill' && key === 'kill') {
      // El value es JSON: { label: 'kill'|'doubleKill'|..., count, totalKills }
      const parsed = asObject(value);
      const label = parsed ? asString(parsed['label']) : undefined;
      // parseCounterValue prioriza totalKills, que es el acumulado real.
      const obs = this.counters.observe('kill', value);
      return this.repeat(GameEventType.KILL, obs.occurrences, {
        totalKills: obs.current,
        label,
        level: this.championLevel,
        // La Live Client Data API de Riot aporta nombres que GEP no expone.
        victim: parsed ? parsed['victim'] : undefined,
        assisters: parsed ? parsed['assisters'] : undefined,
      });
    }

    if (feature === 'death' && key === 'death') {
      const parsedDeath = asObject(value);
      const obs = this.counters.observe('death', value);
      return this.repeat(GameEventType.DEATH, obs.occurrences, {
        totalDeaths: obs.current,
        level: this.championLevel,
        killer: parsedDeath ? parsedDeath['killer'] : undefined,
      });
    }

    if (feature === 'assist' && key === 'assist') {
      const obs = this.counters.observe('assist', value);
      return this.repeat(GameEventType.ASSIST, obs.occurrences, {
        totalAssists: obs.current,
      });
    }

    if (feature === 'respawn' && key === 'respawn') {
      // Discreto, sin contador.
      return this.one(GameEventType.RESPAWN, { level: this.championLevel });
    }

    if (feature === 'matchState') {
      if (key === 'matchStart') {
        this.reset();
        return this.one(GameEventType.MATCH_START, {});
      }
      if (key === 'matchEnd') {
        // Deprecado, pero si llega lo respetamos (una sola vez).
        if (this.matchEnded) return this.none();
        this.matchEnded = true;
        return this.one(GameEventType.MATCH_END, { source: 'matchState' });
      }
    }

    if (feature === 'announcer') {
      // Via recomendada por Overwolf para el fin de partida.
      if (key === 'victory' || key === 'defeat') {
        if (this.matchEnded) return this.none();
        this.matchEnded = true;
        return this.one(GameEventType.MATCH_END, { outcome: key, source: 'announcer' });
      }
    }

    return this.none();
  }
}
