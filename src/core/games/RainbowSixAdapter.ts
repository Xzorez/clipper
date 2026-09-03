import { GameEventType, GameKey, GEP_GAME_IDS } from '../../shared/types';
import { AdapterOutput, BaseGameAdapter, RawGameEvent, asObject, asString } from './GameAdapter';

/**
 * Adaptador de Rainbow Six Siege (GEP game id 10826).
 *
 * DIFERENCIA CRITICA CON VALORANT Y LOL:
 * en R6 los eventos de combate son DISCRETOS y llegan con `value: null`.
 * La documentacion oficial lo indica explicitamente:
 *
 *   Feature `kill`   -> eventos: kill (null), headshot (null)
 *   Feature `death`  -> eventos: knockedout (null), death (null), killer (UUID)
 *
 * Por tanto aqui NO se aplica diferencia de contadores. Si la aplicaramos,
 * como el value es siempre null, o bien perderiamos todas las kills o bien
 * registrariamos una por cada reenvio. Cada mensaje equivale a una ocurrencia.
 *
 * Los contadores acumulados si existen, pero en la feature `roster`
 * (kills / deaths del jugador), y los usamos solo como verificacion cruzada,
 * nunca como fuente de marcadores.
 *
 * El evento `killer` no es un marcador: es el UUID de quien te ha matado y
 * llega en un mensaje aparte del `death`. Se adjunta como metadata a la muerte
 * mas reciente mediante un parche con ventana temporal.
 */
export class RainbowSixAdapter extends BaseGameAdapter {
  readonly game: GameKey = 'rainbowsix';
  readonly gepGameId = GEP_GAME_IDS.rainbowsix;
  readonly displayName = 'Rainbow Six Siege';
  readonly processNames = ['rainbowsix.exe', 'rainbowsix_vulkan.exe', 'rainbowsix_be.exe'];

  private roundNumber: string | null = null;
  private pendingKiller: string | null = null;
  /** Contadores del roster, solo para verificacion cruzada en los logs. */
  private rosterKills: number | null = null;
  private rosterDeaths: number | null = null;

  requiredFeatures(): string[] | null {
    return ['kill', 'death', 'match', 'match_info', 'roster', 'me'];
  }

  protected onReset(): void {
    this.roundNumber = null;
    this.pendingKiller = null;
    this.rosterKills = null;
    this.rosterDeaths = null;
  }

  normalizeEvent(raw: RawGameEvent): AdapterOutput {
    return raw.kind === 'info' ? this.handleInfo(raw) : this.handleEvent(raw);
  }

  private handleInfo(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'match' && key === 'number') {
      this.roundNumber = asString(value) ?? null;
      return this.none();
    }

    if (feature === 'roster') {
      // Solo verificacion cruzada: no genera eventos.
      if (key === 'kills') {
        const n = Number(asString(value));
        if (Number.isFinite(n)) this.rosterKills = n;
      } else if (key === 'deaths') {
        const n = Number(asString(value));
        if (Number.isFinite(n)) this.rosterDeaths = n;
      }
      return this.none();
    }

    return this.none();
  }

  private handleEvent(raw: RawGameEvent): AdapterOutput {
    const { feature, key, value } = raw;

    if (feature === 'kill') {
      if (key === 'kill') {
        return this.one(GameEventType.KILL, {
          round: this.roundNumber,
          rosterKills: this.rosterKills,
        });
      }
      if (key === 'headshot') {
        return this.one(GameEventType.HEADSHOT, { round: this.roundNumber });
      }
      return this.none();
    }

    if (feature === 'death') {
      if (key === 'death') {
        const killer = this.pendingKiller;
        this.pendingKiller = null;
        return this.one(GameEventType.DEATH, {
          round: this.roundNumber,
          killer: killer ?? undefined,
          rosterDeaths: this.rosterDeaths,
        });
      }

      if (key === 'knockedout') {
        // Estado de derribo: evento propio, distinto de la muerte definitiva.
        return this.one(GameEventType.KNOCKED_OUT, { round: this.roundNumber });
      }

      if (key === 'killer') {
        // No es un marcador. Se guarda por si la muerte llega despues, y se
        // emite un parche por si ya habia llegado.
        const killer = asString(value);
        if (!killer) return this.none();
        this.pendingKiller = killer;
        return {
          events: [],
          patches: [
            {
              targetType: GameEventType.DEATH,
              withinMs: 3000,
              metadata: { killer },
            },
          ],
        };
      }
      return this.none();
    }

    if (feature === 'match') {
      switch (key) {
        case 'roundStart':
          this.pendingKiller = null;
          return this.one(GameEventType.ROUND_START, { round: this.roundNumber });
        case 'roundEnd':
          return this.one(GameEventType.ROUND_END, { round: this.roundNumber });
        case 'roundOutcome':
          // Resultado de la ronda: enriquece el ROUND_END recien emitido.
          return {
            events: [],
            patches: [
              {
                targetType: GameEventType.ROUND_END,
                withinMs: 5000,
                metadata: { outcome: asString(value) },
              },
            ],
          };
        case 'matchOutcome':
          return {
            events: [],
            patches: [
              {
                targetType: GameEventType.MATCH_END,
                withinMs: 10000,
                metadata: { outcome: asString(value) },
              },
            ],
          };
      }
      return this.none();
    }

    if (feature === 'match_info') {
      if (key === 'match_start') {
        this.reset();
        return this.one(GameEventType.MATCH_START, {});
      }
      if (key === 'match_end') {
        return this.one(GameEventType.MATCH_END, {});
      }
      if (key === 'kill_log' || key === 'death_log' || key === 'ko_log') {
        // Los *_log son cadenas crudas del juego. No generan marcadores porque
        // duplicarian los eventos de las features kill/death, pero los
        // conservamos como metadata de diagnostico del ultimo evento afin.
        const parsed = asObject(value);
        if (!parsed) return this.none();
        const target =
          key === 'kill_log'
            ? GameEventType.KILL
            : key === 'death_log'
              ? GameEventType.DEATH
              : GameEventType.KNOCKED_OUT;
        return {
          events: [],
          patches: [{ targetType: target, withinMs: 3000, metadata: { log: parsed } }],
        };
      }
    }

    return this.none();
  }
}
