import { describe, it, expect, beforeEach } from 'vitest';
import { GameEventType, GEP_GAME_IDS } from '../src/shared/types';
import { ValorantAdapter } from '../src/core/games/ValorantAdapter';
import { RainbowSixAdapter } from '../src/core/games/RainbowSixAdapter';
import { LeagueOfLegendsAdapter } from '../src/core/games/LeagueOfLegendsAdapter';
import { AdapterRegistry } from '../src/core/games/registry';
import { RawGameEvent } from '../src/core/games/GameAdapter';

function evt(feature: string, key: string, value: unknown, gameId = 0): RawGameEvent {
  return { gameId, feature, key, value, kind: 'event' };
}

function info(feature: string, key: string, value: unknown, gameId = 0): RawGameEvent {
  return { gameId, feature, key, value, kind: 'info' };
}

function types(output: { events: Array<{ type: GameEventType }> }): GameEventType[] {
  return output.events.map((e) => e.type);
}

// ---------------------------------------------------------------------------
describe('ValorantAdapter', () => {
  let adapter: ValorantAdapter;

  beforeEach(() => {
    adapter = new ValorantAdapter();
    adapter.reset();
  });

  it('declara el game id real de GEP', () => {
    expect(adapter.gepGameId).toBe(21640);
    expect(adapter.gepGameId).toBe(GEP_GAME_IDS.valorant);
  });

  // Escenario 1 y 2
  it('traduce el contador de kills a eventos KILL individuales', () => {
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', 1)))).toEqual([GameEventType.KILL]);
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', 2)))).toEqual([GameEventType.KILL]);
  });

  // Escenario 3
  it('no duplica cuando el mismo contador llega dos veces', () => {
    adapter.normalizeEvent(evt('kill', 'kill', 3));
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', 3)))).toEqual([]);
  });

  // Escenario 4
  it('traduce las muertes', () => {
    expect(types(adapter.normalizeEvent(evt('death', 'death', 1)))).toEqual([GameEventType.DEATH]);
    expect(types(adapter.normalizeEvent(evt('death', 'death', 1)))).toEqual([]);
    expect(types(adapter.normalizeEvent(evt('death', 'death', 2)))).toEqual([GameEventType.DEATH]);
  });

  // Escenario 5
  it('traduce los headshots como evento propio', () => {
    const output = adapter.normalizeEvent(evt('kill', 'headshot', 1));
    expect(types(output)).toEqual([GameEventType.HEADSHOT]);
    expect(output.events[0].metadata?.totalHeadshots).toBe(1);
  });

  it('emite kill y headshot por separado en una kill con headshot', () => {
    // VALORANT dispara ambos eventos; los dos marcadores son correctos.
    const kill = adapter.normalizeEvent(evt('kill', 'kill', 1));
    const headshot = adapter.normalizeEvent(evt('kill', 'headshot', 1));
    expect(types(kill)).toEqual([GameEventType.KILL]);
    expect(types(headshot)).toEqual([GameEventType.HEADSHOT]);
  });

  it('traduce las asistencias', () => {
    expect(types(adapter.normalizeEvent(evt('kill', 'assist', 1)))).toEqual([GameEventType.ASSIST]);
  });

  it('usa los info updates como linea base sin generar marcadores', () => {
    expect(types(adapter.normalizeEvent(info('kill', 'kills', 5)))).toEqual([]);
    expect(types(adapter.normalizeEvent(info('death', 'deaths', 3)))).toEqual([]);
    // La sexta kill cuenta como una sola.
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', 6)))).toEqual([GameEventType.KILL]);
  });

  it('marca inicio y fin de partida', () => {
    expect(types(adapter.normalizeEvent(evt('match_info', 'match_start', null)))).toEqual([
      GameEventType.MATCH_START,
    ]);
    const end = adapter.normalizeEvent(evt('match_info', 'match_end', 'victory'));
    expect(types(end)).toEqual([GameEventType.MATCH_END]);
    expect(end.events[0].metadata?.outcome).toBe('victory');
  });

  it('reinicia los contadores al empezar una partida nueva', () => {
    adapter.normalizeEvent(evt('kill', 'kill', 5));
    adapter.normalizeEvent(evt('match_info', 'match_start', null));
    // Tras el reinicio, la kill numero 1 vuelve a contar.
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', 1)))).toEqual([GameEventType.KILL]);
  });

  it('deriva las rondas de las transiciones de round_phase', () => {
    // La primera fase solo establece el estado, sin marcador.
    expect(types(adapter.normalizeEvent(info('match_info', 'round_phase', 'shopping')))).toEqual([]);
    expect(types(adapter.normalizeEvent(info('match_info', 'round_phase', 'combat')))).toEqual([]);
    expect(types(adapter.normalizeEvent(info('match_info', 'round_phase', 'end')))).toEqual([
      GameEventType.ROUND_END,
    ]);
    expect(types(adapter.normalizeEvent(info('match_info', 'round_phase', 'shopping')))).toEqual([
      GameEventType.ROUND_START,
    ]);
  });

  it('no repite marcador si la fase llega dos veces igual', () => {
    adapter.normalizeEvent(info('match_info', 'round_phase', 'shopping'));
    adapter.normalizeEvent(info('match_info', 'round_phase', 'end'));
    expect(types(adapter.normalizeEvent(info('match_info', 'round_phase', 'end')))).toEqual([]);
  });

  it('enriquece la kill con los datos del kill feed', () => {
    adapter.normalizeEvent(
      info('match_info', 'kill_feed', {
        is_local_player_kill: true,
        victim: 'Enemigo',
        weapon: 'Vandal',
        headshot: true,
      }),
    );
    const output = adapter.normalizeEvent(evt('kill', 'kill', 1));
    expect(output.events[0].metadata?.victim).toBe('Enemigo');
    expect(output.events[0].metadata?.weapon).toBe('Vandal');
  });

  it('ignora las kills ajenas del kill feed', () => {
    const output = adapter.normalizeEvent(
      evt('match_info', 'kill_feed', { is_local_player_kill: false, victim: 'Otro' }),
    );
    expect(output.events).toHaveLength(0);
    expect(output.patches ?? []).toHaveLength(0);
  });

  it('reconoce el proceso del juego', () => {
    expect(adapter.detect('VALORANT-Win64-Shipping.exe')).toBe(true);
    expect(adapter.detect('C:\\Riot Games\\VALORANT\\live\\VALORANT.exe')).toBe(true);
    expect(adapter.detect('chrome.exe')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RainbowSixAdapter', () => {
  let adapter: RainbowSixAdapter;

  beforeEach(() => {
    adapter = new RainbowSixAdapter();
    adapter.reset();
  });

  it('declara el game id real de GEP', () => {
    expect(adapter.gepGameId).toBe(10826);
  });

  /**
   * La prueba mas importante de este adaptador: en R6 los eventos llegan con
   * value null. Si aplicaramos diferencia de contadores como en VALORANT,
   * perderiamos todas las kills salvo la primera.
   */
  it('cuenta cada evento discreto como una ocurrencia, aunque el value sea null', () => {
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', null)))).toEqual([GameEventType.KILL]);
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', null)))).toEqual([GameEventType.KILL]);
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', null)))).toEqual([GameEventType.KILL]);
  });

  it('traduce muertes, headshots y derribos', () => {
    expect(types(adapter.normalizeEvent(evt('death', 'death', null)))).toEqual([GameEventType.DEATH]);
    expect(types(adapter.normalizeEvent(evt('kill', 'headshot', null)))).toEqual([
      GameEventType.HEADSHOT,
    ]);
    expect(types(adapter.normalizeEvent(evt('death', 'knockedout', null)))).toEqual([
      GameEventType.KNOCKED_OUT,
    ]);
  });

  it('adjunta el killer a la muerte cuando llega antes', () => {
    adapter.normalizeEvent(evt('death', 'killer', 'uuid-enemigo'));
    const death = adapter.normalizeEvent(evt('death', 'death', null));
    expect(death.events[0].metadata?.killer).toBe('uuid-enemigo');
  });

  it('emite un parche cuando el killer llega despues de la muerte', () => {
    adapter.normalizeEvent(evt('death', 'death', null));
    const output = adapter.normalizeEvent(evt('death', 'killer', 'uuid-enemigo'));
    // No es un marcador propio: es un parche sobre la muerte reciente.
    expect(output.events).toHaveLength(0);
    expect(output.patches?.[0].targetType).toBe(GameEventType.DEATH);
    expect(output.patches?.[0].metadata.killer).toBe('uuid-enemigo');
  });

  it('marca inicio y fin de ronda', () => {
    expect(types(adapter.normalizeEvent(evt('match', 'roundStart', null)))).toEqual([
      GameEventType.ROUND_START,
    ]);
    expect(types(adapter.normalizeEvent(evt('match', 'roundEnd', null)))).toEqual([
      GameEventType.ROUND_END,
    ]);
  });

  it('adjunta el resultado de la ronda como parche, no como marcador', () => {
    const output = adapter.normalizeEvent(evt('match', 'roundOutcome', 'victory'));
    expect(output.events).toHaveLength(0);
    expect(output.patches?.[0].metadata.outcome).toBe('victory');
  });

  it('los contadores del roster no generan marcadores', () => {
    expect(types(adapter.normalizeEvent(info('roster', 'kills', 5)))).toEqual([]);
    expect(types(adapter.normalizeEvent(info('roster', 'deaths', 2)))).toEqual([]);
  });

  it('reconoce el proceso del juego', () => {
    expect(adapter.detect('RainbowSix.exe')).toBe(true);
    expect(adapter.detect('RainbowSix_Vulkan.exe')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('LeagueOfLegendsAdapter', () => {
  let adapter: LeagueOfLegendsAdapter;

  beforeEach(() => {
    adapter = new LeagueOfLegendsAdapter();
    adapter.reset();
  });

  it('declara el game id real de GEP', () => {
    expect(adapter.gepGameId).toBe(5426);
  });

  it('lee el total del JSON de kills', () => {
    const first = adapter.normalizeEvent(
      evt('kill', 'kill', '{"label":"kill","count":1,"totalKills":1}'),
    );
    expect(types(first)).toEqual([GameEventType.KILL]);

    const second = adapter.normalizeEvent(
      evt('kill', 'kill', '{"label":"kill","count":1,"totalKills":2}'),
    );
    expect(types(second)).toEqual([GameEventType.KILL]);

    // Mismo total reenviado: no cuenta.
    const repeated = adapter.normalizeEvent(
      evt('kill', 'kill', '{"label":"kill","count":1,"totalKills":2}'),
    );
    expect(types(repeated)).toEqual([]);
  });

  it('conserva la etiqueta de multikill en la metadata', () => {
    const output = adapter.normalizeEvent(
      evt('kill', 'kill', { label: 'doubleKill', count: 2, totalKills: 4 }),
    );
    expect(output.events[0].metadata?.label).toBe('doubleKill');
  });

  it('cuenta muertes con contador 0 -> 1 -> 2', () => {
    adapter.normalizeEvent(info('death', 'deaths', 0));
    expect(types(adapter.normalizeEvent(evt('death', 'death', 1)))).toEqual([GameEventType.DEATH]);
    expect(types(adapter.normalizeEvent(evt('death', 'death', 2)))).toEqual([GameEventType.DEATH]);
    expect(types(adapter.normalizeEvent(evt('death', 'death', 2)))).toEqual([]);
  });

  it('traduce asistencias y reapariciones', () => {
    expect(types(adapter.normalizeEvent(evt('assist', 'assist', 1)))).toEqual([GameEventType.ASSIST]);
    expect(types(adapter.normalizeEvent(evt('respawn', 'respawn', null)))).toEqual([
      GameEventType.RESPAWN,
    ]);
  });

  it('nunca emite headshots', () => {
    const outputs = [
      adapter.normalizeEvent(evt('kill', 'headshot', 1)),
      adapter.normalizeEvent(evt('kill', 'kill', { totalKills: 1 })),
    ];
    const all = outputs.flatMap((o) => types(o));
    expect(all).not.toContain(GameEventType.HEADSHOT);
  });

  it('deriva el fin de partida del announcer, ya que matchEnd esta deprecado', () => {
    const output = adapter.normalizeEvent(evt('announcer', 'victory', null));
    expect(types(output)).toEqual([GameEventType.MATCH_END]);
    expect(output.events[0].metadata?.outcome).toBe('victory');
  });

  it('no duplica el fin de partida si llegan las dos vias', () => {
    adapter.normalizeEvent(evt('announcer', 'defeat', null));
    expect(types(adapter.normalizeEvent(evt('matchState', 'matchEnd', null)))).toEqual([]);
  });

  it('marca el inicio de partida y reinicia contadores', () => {
    adapter.normalizeEvent(evt('kill', 'kill', { totalKills: 8 }));
    expect(types(adapter.normalizeEvent(evt('matchState', 'matchStart', null)))).toEqual([
      GameEventType.MATCH_START,
    ]);
    expect(types(adapter.normalizeEvent(evt('kill', 'kill', { totalKills: 1 })))).toEqual([
      GameEventType.KILL,
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('AdapterRegistry', () => {
  const registry = new AdapterRegistry();

  it('resuelve por game id de GEP', () => {
    expect(registry.byGepId(21640)?.game).toBe('valorant');
    expect(registry.byGepId(10826)?.game).toBe('rainbowsix');
    expect(registry.byGepId(5426)?.game).toBe('lol');
  });

  it('mapea el PBE de League of Legends al mismo adaptador', () => {
    expect(registry.byGepId(22848)?.game).toBe('lol');
  });

  it('devuelve undefined para juegos no soportados', () => {
    expect(registry.byGepId(21566)).toBeUndefined(); // Apex Legends
  });

  it('resuelve por nombre de proceso', () => {
    expect(registry.byProcess('RainbowSix.exe')?.game).toBe('rainbowsix');
    expect(registry.byProcess('League of Legends.exe')?.game).toBe('lol');
    expect(registry.byProcess('notepad.exe')).toBeUndefined();
  });

  it('incluye los alias en la lista de ids a registrar', () => {
    const ids = registry.gepGameIds();
    expect(ids).toContain(21640);
    expect(ids).toContain(10826);
    expect(ids).toContain(5426);
    expect(ids).toContain(22848);
  });

  it('cada adaptador de GEP expone las features que realmente usa', () => {
    // Los que tienen id de GEP dependen de que Overwolf les active features
    // concretas; pedir una lista vacia los dejaria sin eventos.
    for (const adapter of registry.all().filter((a) => a.gepGameId > 0)) {
      const features = adapter.requiredFeatures();
      expect(features).not.toBeNull();
      expect(features!.length).toBeGreaterThan(0);
    }
  });

  it('el adaptador generico no pide nada a GEP ni normaliza eventos', () => {
    const generico = registry.get('generic');
    expect(generico).toBeDefined();
    // No existe en GEP, asi que queda fuera de la lista que se le pide.
    expect(generico!.gepGameId).toBe(0);
    expect(registry.gepGameIds()).not.toContain(0);
    expect(generico!.requiredFeatures()).toBeNull();
    // Y nunca se autoasigna por nombre de proceso: lo elige el detector.
    expect(generico!.detect('cualquiercosa.exe')).toBe(false);
  });
});
