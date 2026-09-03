import { describe, it, expect, beforeEach } from 'vitest';
import {
  AllGameData,
  RiotLiveClientProvider,
  namesMatch,
} from '../src/core/providers/RiotLiveClientProvider';
import { RawGameEvent } from '../src/core/games/GameAdapter';
import { LeagueOfLegendsAdapter } from '../src/core/games/LeagueOfLegendsAdapter';
import { EventManager } from '../src/core/events/EventManager';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';
import { FakeClock } from '../src/core/synchronization/MonotonicClock';
import { EventSettings, GameEventType } from '../src/shared/types';

const ME = 'Jugador#EUW';

function data(events: unknown[], gameTime = 100): AllGameData {
  return {
    activePlayer: { riotId: ME },
    events: { Events: events as never },
    gameData: { gameTime, gameMode: 'CLASSIC' },
  };
}

function championKill(
  id: number,
  killer: string,
  victim: string,
  eventTime: number,
  assisters: string[] = [],
) {
  return {
    EventID: id,
    EventName: 'ChampionKill',
    EventTime: eventTime,
    KillerName: killer,
    VictimName: victim,
    Assisters: assisters,
  };
}

/** Recoge todos los RawGameEvent que emite el proveedor. */
function collect(provider: RiotLiveClientProvider): RawGameEvent[] {
  const received: RawGameEvent[] = [];
  provider.on('raw', (raw: RawGameEvent) => received.push(raw));
  return received;
}

describe('namesMatch', () => {
  it('acepta el nombre exacto', () => {
    expect(namesMatch('Jugador#EUW', 'Jugador#EUW')).toBe(true);
  });

  it('tolera la etiqueta de Riot ID', () => {
    // Riot ha cambiado el formato entre parches: un lado puede traer etiqueta
    // y el otro no.
    expect(namesMatch('Jugador', 'Jugador#EUW')).toBe(true);
    expect(namesMatch('Jugador#EUW', 'Jugador')).toBe(true);
  });

  it('ignora mayusculas y espacios', () => {
    expect(namesMatch(' jugador ', 'Jugador#EUW')).toBe(true);
  });

  it('distingue jugadores distintos', () => {
    expect(namesMatch('Otro', 'Jugador')).toBe(false);
    expect(namesMatch(undefined, 'Jugador')).toBe(false);
    expect(namesMatch('', 'Jugador')).toBe(false);
  });
});

describe('RiotLiveClientProvider', () => {
  let provider: RiotLiveClientProvider;
  let payload: AllGameData;
  let shouldFail: NodeJS.ErrnoException | null;

  beforeEach(() => {
    payload = data([]);
    shouldFail = null;
    provider = new RiotLiveClientProvider(async () => {
      if (shouldFail) throw shouldFail;
      return payload;
    });
  });

  it('detecta la partida en el primer sondeo con respuesta', async () => {
    let detected = false;
    provider.on('game-detected', () => {
      detected = true;
    });

    await provider.pollOnce();

    expect(detected).toBe(true);
    expect(provider.isInGame).toBe(true);
    expect(provider.getState().status).toBe('connected');
    expect(provider.getState().provider).toBe('riot-live-client');
  });

  it('no considera un error que el puerto este cerrado sin partida', async () => {
    shouldFail = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await provider.pollOnce();

    expect(provider.isInGame).toBe(false);
    expect(provider.getState().status).toBe('unavailable');
  });

  it('traduce una kill propia al formato que entiende el adaptador', async () => {
    const received = collect(provider);
    payload = data([championKill(1, ME, 'Enemigo', 95)], 100);

    await provider.pollOnce();

    const kill = received.find((r) => r.feature === 'kill');
    expect(kill).toBeDefined();
    expect(kill!.key).toBe('kill');
    expect(kill!.gameId).toBe(5426);
    expect(kill!.kind).toBe('event');
    const value = kill!.value as Record<string, unknown>;
    expect(value.totalKills).toBe(1);
    expect(value.victim).toBe('Enemigo');
  });

  it('traduce una muerte propia y conserva quien te mato', async () => {
    const received = collect(provider);
    payload = data([championKill(1, 'Enemigo', ME, 95)], 100);

    await provider.pollOnce();

    const death = received.find((r) => r.feature === 'death');
    expect(death).toBeDefined();
    const value = death!.value as Record<string, unknown>;
    expect(value.totalDeaths).toBe(1);
    expect(value.killer).toBe('Enemigo');
  });

  it('traduce una asistencia', async () => {
    const received = collect(provider);
    payload = data([championKill(1, 'Aliado', 'Enemigo', 95, [ME])], 100);

    await provider.pollOnce();

    const assist = received.find((r) => r.feature === 'assist');
    expect(assist).toBeDefined();
    expect((assist!.value as Record<string, unknown>).totalAssists).toBe(1);
  });

  it('ignora kills entre terceros', async () => {
    const received = collect(provider);
    payload = data([championKill(1, 'Aliado', 'Enemigo', 95)], 100);

    await provider.pollOnce();

    expect(received).toHaveLength(0);
  });

  /**
   * Es lo que evita duplicar marcadores: el endpoint devuelve el historico
   * completo en cada sondeo, no solo lo nuevo.
   */
  it('no reprocesa eventos ya vistos en sondeos posteriores', async () => {
    const received = collect(provider);

    payload = data([championKill(1, ME, 'Enemigo', 95)], 100);
    await provider.pollOnce();
    expect(received).toHaveLength(1);

    // El mismo evento vuelve a llegar, mas uno nuevo.
    payload = data([championKill(1, ME, 'Enemigo', 95), championKill(2, ME, 'Otro', 130)], 135);
    await provider.pollOnce();

    expect(received).toHaveLength(2);
    expect((received[1].value as Record<string, unknown>).totalKills).toBe(2);
  });

  /**
   * La ventaja de esta fuente sobre GEP: el reloj de la partida dice
   * exactamente cuanto hace que ocurrio el evento, asi que la posicion en el
   * video no depende de cuando llego el sondeo.
   */
  it('calcula la antiguedad exacta del evento con el reloj de la partida', async () => {
    const received = collect(provider);
    // El evento ocurrio en el segundo 95 y el sondeo llega en el 100,4.
    payload = data([championKill(1, ME, 'Enemigo', 95)], 100.4);

    await provider.pollOnce();

    expect(received[0].latencyHintMs).toBe(5400);
  });

  it('nunca produce una antiguedad negativa', async () => {
    const received = collect(provider);
    // Reloj de partida por detras del evento (desincronizacion puntual).
    payload = data([championKill(1, ME, 'Enemigo', 105)], 100);

    await provider.pollOnce();

    expect(received[0].latencyHintMs).toBe(0);
  });

  it('traduce el inicio de partida', async () => {
    const received = collect(provider);
    payload = data([{ EventID: 0, EventName: 'GameStart', EventTime: 0.03 }], 1);

    await provider.pollOnce();

    expect(received[0]).toMatchObject({ feature: 'matchState', key: 'matchStart' });
  });

  it('traduce el fin de partida al announcer que espera el adaptador', async () => {
    const received = collect(provider);
    payload = data([{ EventID: 9, EventName: 'GameEnd', EventTime: 1800, Result: 'Win' }], 1801);

    await provider.pollOnce();

    expect(received[0]).toMatchObject({ feature: 'announcer', key: 'victory' });
  });

  it('mapea la derrota correctamente', async () => {
    const received = collect(provider);
    payload = data([{ EventID: 9, EventName: 'GameEnd', EventTime: 1800, Result: 'Lose' }], 1801);

    await provider.pollOnce();

    expect(received[0].key).toBe('defeat');
  });

  it('ignora eventos de mapa que no son del jugador', async () => {
    const received = collect(provider);
    payload = data(
      [
        { EventID: 1, EventName: 'TurretKilled', EventTime: 300 },
        { EventID: 2, EventName: 'DragonKill', EventTime: 400 },
        { EventID: 3, EventName: 'Ace', EventTime: 500 },
      ],
      600,
    );

    await provider.pollOnce();

    expect(received).toHaveLength(0);
  });

  it('da la partida por terminada tras varios fallos seguidos', async () => {
    let exited = false;
    provider.on('game-exit', () => {
      exited = true;
    });

    await provider.pollOnce();
    expect(provider.isInGame).toBe(true);

    shouldFail = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await provider.pollOnce();
    expect(provider.isInGame).toBe(true); // un fallo suelto no cuenta
    await provider.pollOnce();
    await provider.pollOnce();

    expect(exited).toBe(true);
    expect(provider.isInGame).toBe(false);
  });

  it('vuelve a empezar limpio en la siguiente partida', async () => {
    const received = collect(provider);

    payload = data([championKill(1, ME, 'Enemigo', 95)], 100);
    await provider.pollOnce();

    shouldFail = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await provider.pollOnce();
    await provider.pollOnce();
    await provider.pollOnce();

    // Partida nueva: los IDs vuelven a empezar y no deben descartarse.
    shouldFail = null;
    payload = data([championKill(1, ME, 'Otro', 40)], 45);
    await provider.pollOnce();

    expect(received).toHaveLength(2);
    expect((received[1].value as Record<string, unknown>).totalKills).toBe(1);
  });

  it('soporta que Riot devuelva el nombre sin etiqueta', async () => {
    const received = collect(provider);
    payload = {
      activePlayer: { summonerName: 'Jugador' },
      events: { Events: [championKill(1, 'Jugador#EUW', 'Enemigo', 95)] as never },
      gameData: { gameTime: 100 },
    };

    await provider.pollOnce();

    expect(received.filter((r) => r.feature === 'kill')).toHaveLength(1);
  });

  it('no revienta con payloads incompletos', async () => {
    payload = {} as AllGameData;
    await expect(provider.pollOnce()).resolves.toBeUndefined();

    payload = { events: { Events: [{ EventName: 'ChampionKill' } as never] } };
    await expect(provider.pollOnce()).resolves.toBeUndefined();
  });
});

/**
 * Prueba de extremo a extremo del camino sin Overwolf: datos crudos de Riot
 * atravesando el adaptador de LoL y el EventManager hasta convertirse en
 * marcadores con su posicion en el video.
 */
describe('Riot -> adaptador -> EventManager', () => {
  const settings: EventSettings = {
    detectKills: true,
    detectDeaths: true,
    detectHeadshots: true,
    detectAssists: true,
    detectRounds: true,
    // Compensacion configurada alta a proposito: la pista del proveedor debe
    // tener prioridad sobre ella.
    latencyOffsetMs: { valorant: 0, rainbowsix: 0, lol: 5000 },
  };

  it('produce marcadores completos sin pasar por GEP', async () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new LeagueOfLegendsAdapter(), settings);
    recordingClock.arm();
    clock.advanceMs(60_000);

    let payload: AllGameData = data([], 100);
    const provider = new RiotLiveClientProvider(async () => payload);
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));

    payload = data(
      [
        championKill(1, ME, 'Enemigo1', 95),
        championKill(2, 'Enemigo2', ME, 97),
        championKill(3, 'Aliado', 'Enemigo3', 98, [ME]),
      ],
      100,
    );
    await provider.pollOnce();

    const events = manager.getEvents();
    const types = events.map((e) => e.type);
    expect(types).toEqual([GameEventType.KILL, GameEventType.DEATH, GameEventType.ASSIST]);

    // Los nombres llegan hasta la metadata final: es lo que GEP no da.
    expect(events[0].metadata?.victim).toBe('Enemigo1');
    expect(events[1].metadata?.killer).toBe('Enemigo2');

    expect(manager.getSummary()).toMatchObject({ kills: 1, deaths: 1, assists: 1 });
  });

  it('la pista de latencia del proveedor gana a la compensacion configurada', async () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new LeagueOfLegendsAdapter(), settings);
    recordingClock.arm();
    clock.advanceMs(60_000);

    const provider = new RiotLiveClientProvider(async () =>
      data([championKill(1, ME, 'Enemigo', 97)], 100),
    );
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));
    await provider.pollOnce();

    // Llega en el segundo 60 de video, pero ocurrio 3 s antes segun el reloj de
    // la partida. Si se hubiera usado la compensacion configurada (5000 ms),
    // caeria en el segundo 55.
    expect(manager.getEvents()[0].videoTime).toBeCloseTo(57, 2);
  });

  it('una partida sin eventos del jugador no genera marcadores', async () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new LeagueOfLegendsAdapter(), settings);
    recordingClock.arm();

    const provider = new RiotLiveClientProvider(async () =>
      data([championKill(1, 'A', 'B', 95), { EventID: 2, EventName: 'DragonKill', EventTime: 96 }], 100),
    );
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));
    await provider.pollOnce();

    expect(manager.getEvents()).toHaveLength(0);
  });
});
