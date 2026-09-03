import { GameKey, GEP_GAME_ID_ALIASES } from '../../shared/types';
import { GameAdapter } from './GameAdapter';
import { ValorantAdapter } from './ValorantAdapter';
import { RainbowSixAdapter } from './RainbowSixAdapter';
import { LeagueOfLegendsAdapter } from './LeagueOfLegendsAdapter';

/**
 * Registro de adaptadores. Es el unico sitio donde se conocen los tres juegos
 * a la vez; a partir de aqui todo el codigo trabaja contra la interfaz
 * GameAdapter sin saber a que juego pertenece.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<GameKey, GameAdapter>();

  constructor(adapters?: GameAdapter[]) {
    const list = adapters ?? [
      new ValorantAdapter(),
      new RainbowSixAdapter(),
      new LeagueOfLegendsAdapter(),
    ];
    for (const adapter of list) this.adapters.set(adapter.game, adapter);
  }

  all(): GameAdapter[] {
    return [...this.adapters.values()];
  }

  get(game: GameKey): GameAdapter | undefined {
    return this.adapters.get(game);
  }

  /** Resuelve un adaptador a partir del game id de GEP (incluye alias como el PBE). */
  byGepId(gepGameId: number): GameAdapter | undefined {
    const key = GEP_GAME_ID_ALIASES[gepGameId];
    if (key) return this.adapters.get(key);
    return this.all().find((a) => a.gepGameId === gepGameId);
  }

  /** Resuelve un adaptador a partir del nombre o la ruta del proceso. */
  byProcess(processName: string): GameAdapter | undefined {
    return this.all().find((a) => a.detect(processName));
  }

  /** Todos los game ids de GEP que nos interesan, incluidos los alias. */
  gepGameIds(): number[] {
    const ids = new Set<number>();
    for (const adapter of this.all()) ids.add(adapter.gepGameId);
    for (const [id, key] of Object.entries(GEP_GAME_ID_ALIASES)) {
      if (this.adapters.has(key)) ids.add(Number(id));
    }
    return [...ids];
  }
}
