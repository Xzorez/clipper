import { describe, it, expect } from 'vitest';
import {
  parseLockfile,
  parseClientInfo,
  CLIENT_PLATFORM,
} from '../src/core/providers/valorant/ValorantLocalAuth';
import { extractMatch } from '../src/core/providers/valorant/ValorantMatchApi';
import { ValorantMatchProvider } from '../src/core/providers/valorant/ValorantMatchProvider';
import { RawGameEvent } from '../src/core/games/GameAdapter';
import { ValorantAdapter } from '../src/core/games/ValorantAdapter';
import { EventManager } from '../src/core/events/EventManager';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';
import { FakeClock } from '../src/core/synchronization/MonotonicClock';
import { EventSettings, GameEventType } from '../src/shared/types';

const ME = 'puuid-yo';
const ENEMY = 'puuid-enemigo';
const ALLY = 'puuid-aliado';

const START = 1_756_800_000_000;

function match(kills: unknown[], lengthMs = 1_800_000) {
  return {
    matchInfo: {
      matchId: 'partida-1',
      gameStartMillis: START,
      gameLengthMillis: lengthMs,
      mapId: '/Game/Maps/Ascent/Ascent',
      queueID: 'competitive',
      isCompleted: true,
    },
    players: [
      { subject: ME, gameName: 'Yo', tagLine: 'EUW' },
      { subject: ENEMY, gameName: 'Enemigo', tagLine: 'EUW' },
      { subject: ALLY, gameName: 'Aliado', tagLine: 'EUW' },
    ],
    kills,
  };
}

function kill(gameTime: number, killer: string, victim: string, extra: object = {}) {
  return {
    gameTime,
    roundTime: gameTime % 100_000,
    killer,
    victim,
    assistants: [],
    finishingDamage: { damageType: 'Weapon', damageItem: 'Vandal' },
    ...extra,
  };
}

// ---------------------------------------------------------------------------

describe('ValorantLocalAuth', () => {
  describe('parseLockfile', () => {
    it('lee el formato real del cliente de Riot', () => {
      // Formato verificado contra un lockfile real: nombre:pid:puerto:pass:protocolo
      const parsed = parseLockfile('Riot Client:29884:50063:secreto:https');
      expect(parsed).toEqual({ pid: 29884, port: 50063, password: 'secreto' });
    });

    it('tolera espacios y salto de linea final', () => {
      expect(parseLockfile('Riot Client:1:2:pass:https\n')?.port).toBe(2);
    });

    it('rechaza contenido incompleto o corrupto', () => {
      expect(parseLockfile('')).toBeNull();
      expect(parseLockfile('solo:tres:campos')).toBeNull();
      expect(parseLockfile('Riot Client:1:no-es-puerto:pass:https')).toBeNull();
      expect(parseLockfile('Riot Client:1:50063::https')).toBeNull();
    });
  });

  describe('parseClientInfo', () => {
    it('extrae version y region del registro real del juego', () => {
      // Cadenas tomadas de un ShooterGame.log real.
      const logText = [
        'LogInit: Build: release-13.00-shipping-32-4990475',
        'LogShooter: url https://pd.eu.a.pvp.net/account-xp/v1/players',
        'LogShooter: glz https://glz-eu-1.eu.a.pvp.net',
      ].join('\n');

      expect(parseClientInfo(logText)).toEqual({
        version: 'release-13.00-shipping-32-4990475',
        shard: 'eu',
      });
    });

    it('reconoce otras regiones', () => {
      const text = 'release-13.00-shipping-32-4990475 https://pd.na.a.pvp.net';
      expect(parseClientInfo(text)?.shard).toBe('na');
    });

    it('devuelve null si falta alguno de los dos datos', () => {
      expect(parseClientInfo('sin nada util')).toBeNull();
      expect(parseClientInfo('release-13.00-shipping-32-4990475')).toBeNull();
      expect(parseClientInfo('https://pd.eu.a.pvp.net')).toBeNull();
    });
  });

  it('la cabecera de plataforma es un JSON fijo sin datos del usuario', () => {
    const decoded = JSON.parse(Buffer.from(CLIENT_PLATFORM, 'base64').toString('utf8'));
    expect(decoded).toEqual({
      platformType: 'PC',
      platformOS: 'Windows',
      platformOSVersion: '10.0.19042.1.256.64bit',
      platformChipset: 'Unknown',
    });
  });
});

// ---------------------------------------------------------------------------

describe('extractMatch', () => {
  it('convierte una kill propia usando el instante absoluto', () => {
    const parsed = extractMatch(match([kill(30_000, ME, ENEMY)]), ME);

    expect(parsed).not.toBeNull();
    expect(parsed!.events).toHaveLength(1);
    expect(parsed!.events[0]).toMatchObject({
      type: 'kill',
      // Inicio de partida mas el desplazamiento de la kill: exacto, sin estimar.
      occurredAtMs: START + 30_000,
      opponent: 'Enemigo#EUW',
      weapon: 'Vandal',
    });
  });

  it('convierte una muerte propia y resuelve quien nos mato', () => {
    const parsed = extractMatch(match([kill(45_000, ENEMY, ME)]), ME);
    expect(parsed!.events[0]).toMatchObject({
      type: 'death',
      occurredAtMs: START + 45_000,
      opponent: 'Enemigo#EUW',
    });
  });

  it('convierte una asistencia propia', () => {
    const parsed = extractMatch(
      match([kill(60_000, ALLY, ENEMY, { assistants: [ME] })]),
      ME,
    );
    expect(parsed!.events).toHaveLength(1);
    expect(parsed!.events[0].type).toBe('assist');
  });

  it('no cuenta asistencia cuando la kill ya es nuestra', () => {
    const parsed = extractMatch(
      match([kill(60_000, ME, ENEMY, { assistants: [ME] })]),
      ME,
    );
    expect(parsed!.events.map((e) => e.type)).toEqual(['kill']);
  });

  it('ignora las kills entre terceros', () => {
    const parsed = extractMatch(
      match([kill(10_000, ALLY, ENEMY), kill(20_000, ENEMY, ALLY)]),
      ME,
    );
    expect(parsed!.events).toEqual([]);
  });

  it('ordena los eventos cronologicamente', () => {
    const parsed = extractMatch(
      match([
        kill(90_000, ME, ENEMY),
        kill(15_000, ENEMY, ME),
        kill(50_000, ME, ENEMY),
      ]),
      ME,
    );
    const times = parsed!.events.map((e) => e.occurredAtMs);
    expect(times).toEqual([START + 15_000, START + 50_000, START + 90_000]);
  });

  /**
   * El detalle repite las kills en la raiz y dentro de cada ronda; sin
   * deduplicar saldrian marcadores dobles.
   */
  it('no duplica las kills que aparecen en la raiz y en las rondas', () => {
    const shared = kill(30_000, ME, ENEMY);
    const raw = {
      ...match([shared]),
      roundResults: [
        { roundNum: 2, playerStats: [{ subject: ME, kills: [shared] }] },
      ],
    };
    const parsed = extractMatch(raw, ME);
    expect(parsed!.events).toHaveLength(1);
  });

  it('recoge kills que solo estan dentro de las rondas', () => {
    const raw = {
      ...match([]),
      roundResults: [
        { roundNum: 1, playerStats: [{ subject: ME, kills: [kill(12_000, ME, ENEMY)] }] },
      ],
    };
    const parsed = extractMatch(raw, ME);
    expect(parsed!.events).toHaveLength(1);
    expect(parsed!.events[0].round).toBe(1);
  });

  it('calcula el fin de partida con la duracion', () => {
    const parsed = extractMatch(match([], 1_234_000), ME);
    expect(parsed!.startedAtMs).toBe(START);
    expect(parsed!.endedAtMs).toBe(START + 1_234_000);
  });

  it('devuelve null si falta el instante de inicio', () => {
    expect(extractMatch({ matchInfo: {} }, ME)).toBeNull();
    expect(extractMatch({}, ME)).toBeNull();
    expect(extractMatch({ matchInfo: { gameStartMillis: 0 } }, ME)).toBeNull();
  });

  it('descarta kills sin marca temporal', () => {
    const parsed = extractMatch(match([{ killer: ME, victim: ENEMY }]), ME);
    expect(parsed!.events).toEqual([]);
  });

  it('sobrevive a una partida sin jugadores ni kills', () => {
    const parsed = extractMatch({ matchInfo: { gameStartMillis: START } }, ME);
    expect(parsed).not.toBeNull();
    expect(parsed!.events).toEqual([]);
  });

  /** Esta via no entrega el dato, y deducirlo seria inventarselo. */
  it('nunca emite headshots', () => {
    const parsed = extractMatch(
      match([kill(30_000, ME, ENEMY, { finishingDamage: { damageType: 'Weapon', damageItem: 'Vandal' } })]),
      ME,
    );
    expect(parsed!.events.map((e) => e.type)).not.toContain('headshot');
  });
});

// ---------------------------------------------------------------------------

describe('ValorantMatchProvider', () => {
  const context = {
    accessToken: 'token',
    entitlementsToken: 'ent',
    puuid: ME,
    version: 'release-13.00-shipping-32-4990475',
    shard: 'eu',
  };

  function makeProvider(options: {
    history?: Array<{ matchId: string; gameStartMillis: number; queueId: string }>;
    details?: Record<string, ReturnType<typeof extractMatch>>;
    context?: typeof context | null;
    now?: number;
  }) {
    const received: RawGameEvent[] = [];
    const provider = new ValorantMatchProvider({
      buildContext: async () => (options.context === undefined ? context : options.context),
      fetchHistory: async () => options.history ?? [],
      fetchDetails: async (_ctx, id) => options.details?.[id] ?? null,
      now: () => options.now ?? START + 1_000_000,
    });
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));
    return { provider, received };
  }

  it('queda a la espera si el cliente no expone credenciales', async () => {
    const { provider } = makeProvider({ context: null });
    provider.start(0);
    await provider.poll();

    // Es el caso del cliente de Riot en segundo plano: no es un error.
    expect(provider.hasSession).toBe(false);
    expect(provider.getState().status).toBe('connecting');
    expect(provider.getState().message).toContain('cliente de Riot');
    provider.dispose();
  });

  it('se conecta cuando el cliente ya tiene sesion', async () => {
    const { provider } = makeProvider({});
    provider.start(0);
    await new Promise((r) => setTimeout(r, 10));

    expect(provider.hasSession).toBe(true);
    expect(provider.getState().status).toBe('connected');
    provider.dispose();
  });

  it('emite los eventos de una partida con el formato del adaptador', async () => {
    const details = extractMatch(
      match([kill(30_000, ME, ENEMY), kill(60_000, ENEMY, ME)]),
      ME,
    );
    const { provider, received } = makeProvider({
      history: [{ matchId: 'partida-1', gameStartMillis: START, queueId: 'competitive' }],
      details: { 'partida-1': details },
    });

    provider.start(0);
    await provider.poll();

    const keys = received.map((r) => `${r.feature}/${r.key}`);
    expect(keys).toContain('match_info/match_start');
    expect(keys).toContain('kill/kill');
    expect(keys).toContain('death/death');
    expect(keys).toContain('match_info/match_end');

    // Contadores acumulados, igual que los entrega GEP.
    expect(received.find((r) => r.key === 'kill')?.value).toBe(1);
    expect(received.find((r) => r.key === 'death')?.value).toBe(1);
    expect(received.find((r) => r.key === 'kill')?.gameId).toBe(21640);

    provider.dispose();
  });

  it('entrega contadores crecientes para varias kills', async () => {
    const details = extractMatch(
      match([kill(10_000, ME, ENEMY), kill(20_000, ME, ENEMY), kill(30_000, ME, ENEMY)]),
      ME,
    );
    const { provider, received } = makeProvider({
      history: [{ matchId: 'p', gameStartMillis: START, queueId: 'q' }],
      details: { p: details },
    });

    provider.start(0);
    await provider.poll();

    expect(received.filter((r) => r.key === 'kill').map((r) => r.value)).toEqual([1, 2, 3]);
    provider.dispose();
  });

  /** Sin esto, todos los marcadores caerian donde se leyo el historial. */
  it('calcula la antiguedad real de cada evento', async () => {
    const now = START + 600_000;
    const details = extractMatch(
      match([kill(30_000, ME, ENEMY), kill(90_000, ME, ENEMY)]),
      ME,
    );
    const { provider, received } = makeProvider({
      history: [{ matchId: 'p', gameStartMillis: START, queueId: 'q' }],
      details: { p: details },
      now,
    });

    provider.start(0);
    await provider.poll();

    const kills = received.filter((r) => r.key === 'kill');
    expect(kills[0].latencyHintMs).toBe(570_000); // 600s - 30s
    expect(kills[1].latencyHintMs).toBe(510_000); // 600s - 90s
    // La separacion de 60 s dentro de la partida se conserva.
    expect(kills[0].latencyHintMs! - kills[1].latencyHintMs!).toBe(60_000);

    provider.dispose();
  });

  it('ignora partidas anteriores al inicio de la sesion', async () => {
    const details = extractMatch(match([kill(10_000, ME, ENEMY)]), ME);
    const { provider, received } = makeProvider({
      history: [{ matchId: 'vieja', gameStartMillis: START, queueId: 'q' }],
      details: { vieja: details },
    });

    provider.start(START + 500_000);
    await provider.poll();

    expect(received).toHaveLength(0);
    provider.dispose();
  });

  it('no procesa dos veces la misma partida', async () => {
    const details = extractMatch(match([kill(10_000, ME, ENEMY)]), ME);
    const { provider, received } = makeProvider({
      history: [{ matchId: 'p', gameStartMillis: START, queueId: 'q' }],
      details: { p: details },
    });

    provider.start(0);
    await provider.poll();
    const first = received.length;
    await provider.poll();
    await provider.poll();

    expect(received.length).toBe(first);
    provider.dispose();
  });

  it('renueva las credenciales si el historial deja de responder', async () => {
    // Las credenciales de Riot caducan; un historial que deja de responder es
    // la senal de que hay que volver a pedirlas.
    let historyWorks = true;
    let contextBuilds = 0;

    const provider = new ValorantMatchProvider({
      buildContext: async () => {
        contextBuilds++;
        return context;
      },
      fetchHistory: async () => (historyWorks ? [] : null),
      fetchDetails: async () => null,
      now: () => START,
    });

    provider.start(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.hasSession).toBe(true);
    expect(contextBuilds).toBe(1);

    // El token caduca y la API deja de responder.
    historyWorks = false;
    await provider.poll();
    expect(provider.hasSession).toBe(false);

    // El siguiente ciclo vuelve a pedirlas por su cuenta.
    historyWorks = true;
    await provider.poll();
    expect(contextBuilds).toBe(2);
    expect(provider.hasSession).toBe(true);

    provider.dispose();
  });

  it('no emite nada si la partida no tiene eventos nuestros', async () => {
    const details = extractMatch(match([kill(10_000, ALLY, ENEMY)]), ME);
    const { provider, received } = makeProvider({
      history: [{ matchId: 'p', gameStartMillis: START, queueId: 'q' }],
      details: { p: details },
    });

    provider.start(0);
    await provider.poll();

    expect(received).toHaveLength(0);
    provider.dispose();
  });
});

// ---------------------------------------------------------------------------

/**
 * Cadena completa sin Overwolf: historial de Riot -> proveedor -> adaptador de
 * VALORANT -> EventManager -> marcadores colocados en el video.
 */
describe('Historial -> adaptador -> EventManager', () => {
  const settings: EventSettings = {
    detectKills: true,
    detectDeaths: true,
    detectHeadshots: true,
    detectAssists: true,
    detectRounds: true,
    // Alta a proposito: la pista del proveedor debe imponerse.
    latencyOffsetMs: { valorant: 9999, rainbowsix: 0, lol: 0 },
    r6RoundOffsetMs: 0,
  };

  it('produce kills, muertes y asistencias con su posicion', async () => {
    const details = extractMatch(
      match([
        kill(30_000, ME, ENEMY),
        kill(90_000, ENEMY, ME),
        kill(150_000, ALLY, ENEMY, { assistants: [ME] }),
      ]),
      ME,
    );

    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new ValorantAdapter(), settings);
    recordingClock.arm();
    clock.advanceMs(900_000);

    const provider = new ValorantMatchProvider({
      buildContext: async () => ({
        accessToken: 't',
        entitlementsToken: 'e',
        puuid: ME,
        version: 'v',
        shard: 'eu',
      }),
      fetchHistory: async () => [
        { matchId: 'p', gameStartMillis: START, queueId: 'competitive' },
      ],
      fetchDetails: async () => details,
      now: () => START + 600_000,
    });
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));

    provider.start(0);
    await provider.poll();

    const types = manager.getEvents().map((e) => e.type);
    expect(types).toContain(GameEventType.KILL);
    expect(types).toContain(GameEventType.DEATH);
    expect(types).toContain(GameEventType.ASSIST);
    expect(manager.getSummary()).toMatchObject({ kills: 1, deaths: 1, assists: 1 });

    provider.dispose();
  });

  it('separa los marcadores segun cuando ocurrieron en la partida', async () => {
    const details = extractMatch(
      match([kill(30_000, ME, ENEMY), kill(90_000, ME, ENEMY)]),
      ME,
    );

    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new ValorantAdapter(), settings);
    recordingClock.arm();
    clock.advanceMs(900_000);

    const provider = new ValorantMatchProvider({
      buildContext: async () => ({
        accessToken: 't',
        entitlementsToken: 'e',
        puuid: ME,
        version: 'v',
        shard: 'eu',
      }),
      fetchHistory: async () => [{ matchId: 'p', gameStartMillis: START, queueId: 'q' }],
      fetchDetails: async () => details,
      now: () => START + 600_000,
    });
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));

    provider.start(0);
    await provider.poll();

    const kills = manager.getEvents().filter((e) => e.type === GameEventType.KILL);
    expect(kills).toHaveLength(2);
    // Sesenta segundos de separacion real, conservados en la timeline.
    expect(kills[1].videoTime - kills[0].videoTime).toBeCloseTo(60, 1);

    provider.dispose();
  });
});
