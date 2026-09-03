import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReplay,
  detectChunkedCompression,
  parseDissectDate,
} from '../src/core/providers/r6/ReplayParser';
import { findPatterns, DissectReader } from '../src/core/providers/r6/DissectReader';
import {
  R6ReplayProvider,
  collectReplayFiles,
  findReplayRoots,
} from '../src/core/providers/r6/R6ReplayProvider';
import {
  buildReplayFile,
  buildLegacyReplayFile,
  FixtureHeader,
  CODE_VERSION_Y8S1,
  datetimeSecondsAgo,
} from './helpers/replayFixture';
import { RawGameEvent } from '../src/core/games/GameAdapter';
import { RainbowSixAdapter } from '../src/core/games/RainbowSixAdapter';
import { EventManager } from '../src/core/events/EventManager';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';
import { FakeClock } from '../src/core/synchronization/MonotonicClock';
import { EventSettings, GameEventType } from '../src/shared/types';

const ME = 'Jugador';
const ME_ID = '1001';

const HEADER: FixtureHeader = {
  datetime: '2026-09-02-21-30-00',
  recordingPlayerId: ME_ID,
  roundNumber: 3,
  players: [
    { id: ME_ID, username: ME, teamIndex: 0 },
    { id: '1002', username: 'Companero', teamIndex: 0 },
    { id: '2001', username: 'Enemigo', teamIndex: 1 },
    { id: '2002', username: 'OtroEnemigo', teamIndex: 1 },
  ],
};

describe('DissectReader', () => {
  it('lee enteros, cadenas y valores de 32 bits', () => {
    const buffer = Buffer.concat([
      Buffer.from([0x07]),
      Buffer.from([0x03]),
      Buffer.from('abc', 'ascii'),
      Buffer.from([0x04, 0x2a, 0x00, 0x00, 0x00]),
    ]);
    const reader = new DissectReader(buffer);

    expect(reader.int()).toBe(7);
    expect(reader.string()).toBe('abc');
    expect(reader.uint32()).toBe(42);
  });

  it('devuelve null al salirse del buffer en lugar de lanzar', () => {
    const reader = new DissectReader(Buffer.from([0x05]));
    expect(reader.bytes(10)).toBeNull();
    expect(reader.string()).toBeNull();
    expect(reader.uint32()).toBeNull();
  });

  it('localiza varios patrones en un solo recorrido', () => {
    const a = Uint8Array.from([0xaa, 0xbb]);
    const b = Uint8Array.from([0xcc, 0xdd, 0xee]);
    const buffer = Buffer.from([0x00, 0xaa, 0xbb, 0x01, 0xcc, 0xdd, 0xee, 0xaa, 0xbb]);

    const matches = findPatterns(buffer, [a, b]);

    // La posicion apunta al ultimo byte de cada coincidencia.
    expect(matches).toEqual([
      { offset: 2, patternIndex: 0 },
      { offset: 6, patternIndex: 1 },
      { offset: 8, patternIndex: 0 },
    ]);
  });

  it('devuelve las coincidencias ordenadas por posicion', () => {
    const buffer = Buffer.concat([
      Buffer.alloc(50, 0),
      Buffer.from([0x01, 0x02]),
      Buffer.alloc(30, 0),
      Buffer.from([0x03, 0x04]),
    ]);
    const matches = findPatterns(buffer, [
      Uint8Array.from([0x03, 0x04]),
      Uint8Array.from([0x01, 0x02]),
    ]);
    expect(matches.map((m) => m.offset)).toEqual([51, 83]);
  });
});

describe('detectChunkedCompression', () => {
  it('reconoce la variante por bloques', () => {
    expect(detectChunkedCompression(Buffer.from('dissect', 'ascii'))).toBe(true);
  });

  it('reconoce la variante comprimida entera', () => {
    expect(detectChunkedCompression(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]))).toBe(false);
  });

  it('rechaza cualquier otra cosa', () => {
    expect(detectChunkedCompression(Buffer.from('no soy una repeticion'))).toBeNull();
    expect(detectChunkedCompression(Buffer.alloc(2))).toBeNull();
  });
});

describe('parseDissectDate', () => {
  it('lee el formato que escribe el juego', () => {
    const parsed = parseDissectDate('2026-09-02-21-30-00');
    expect(parsed).not.toBeNull();
    const date = new Date(parsed as number);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8); // septiembre
    expect(date.getDate()).toBe(2);
    expect(date.getHours()).toBe(21);
    expect(date.getMinutes()).toBe(30);
  });

  it('rechaza valores invalidos', () => {
    expect(parseDissectDate(undefined)).toBeNull();
    expect(parseDissectDate('')).toBeNull();
    expect(parseDissectDate('2026-09-02')).toBeNull();
    expect(parseDissectDate('no-es-una-fecha-x-y-z')).toBeNull();
    expect(parseDissectDate('1800-09-02-21-30-00')).toBeNull();
  });
});

describe('parseReplay', () => {
  it('lee la cabecera completa', async () => {
    const file = buildReplayFile(HEADER, [{ kind: 'time', secondsRemaining: 180 }]);
    const parsed = await parseReplay(file);

    expect(parsed).not.toBeNull();
    expect(parsed!.header.roundNumber).toBe(3);
    expect(parsed!.header.matchId).toBe('match-fixture');
    expect(parsed!.header.recordingPlayerId).toBe(ME_ID);
    expect(parsed!.header.players).toHaveLength(4);
    expect(parsed!.header.players[0]).toEqual({
      id: ME_ID,
      username: ME,
      teamIndex: 0,
    });
    expect(parsed!.header.players[2].teamIndex).toBe(1);
  });

  it('identifica al jugador local por el id de grabacion', async () => {
    const file = buildReplayFile(HEADER, []);
    const parsed = await parseReplay(file);
    expect(parsed!.localPlayer?.username).toBe(ME);
  });

  it('extrae una kill propia con headshot', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 180 },
      { kind: 'time', secondsRemaining: 150 },
      { kind: 'kill', killer: ME, victim: 'Enemigo', headshot: true },
    ]);

    const parsed = await parseReplay(file);
    const kills = parsed!.events.filter((e) => e.type === 'kill');
    const headshots = parsed!.events.filter((e) => e.type === 'headshot');

    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ killer: ME, victim: 'Enemigo', timeRemaining: 150 });
    // El headshot es un evento propio, igual que hace GEP.
    expect(headshots).toHaveLength(1);
  });

  it('no genera headshot cuando la bandera esta a cero', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 170 },
      { kind: 'kill', killer: ME, victim: 'Enemigo', headshot: false },
    ]);
    const parsed = await parseReplay(file);
    expect(parsed!.events.filter((e) => e.type === 'headshot')).toHaveLength(0);
  });

  it('extrae una muerte propia y conserva quien nos mato', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 120 },
      { kind: 'kill', killer: 'Enemigo', victim: ME },
    ]);

    const parsed = await parseReplay(file);
    const deaths = parsed!.events.filter((e) => e.type === 'death');

    expect(deaths).toHaveLength(1);
    expect(deaths[0].killer).toBe('Enemigo');
    expect(deaths[0].timeRemaining).toBe(120);
  });

  it('trata una muerte sin atacante como muerte propia', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 90 },
      { kind: 'unattributedDeath', victim: ME },
    ]);

    const parsed = await parseReplay(file);
    expect(parsed!.events).toHaveLength(1);
    expect(parsed!.events[0].type).toBe('death');
    expect(parsed!.events[0].killer).toBeUndefined();
  });

  it('ignora las kills entre terceros', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 100 },
      { kind: 'kill', killer: 'Companero', victim: 'Enemigo' },
      { kind: 'kill', killer: 'Enemigo', victim: 'Companero' },
    ]);

    const parsed = await parseReplay(file);
    expect(parsed!.events).toHaveLength(0);
  });

  it('asigna a cada evento el reloj vigente en ese momento', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 180 },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
      { kind: 'time', secondsRemaining: 140 },
      { kind: 'kill', killer: ME, victim: 'OtroEnemigo' },
      { kind: 'time', secondsRemaining: 95 },
      { kind: 'kill', killer: 'Enemigo', victim: ME },
    ]);

    const parsed = await parseReplay(file);
    const times = parsed!.events.map((e) => e.timeRemaining);

    // Ordenados cronologicamente: el reloj cuenta hacia atras.
    expect(times).toEqual([180, 140, 95]);
    expect(parsed!.maxTimeRemaining).toBe(180);
  });

  it('descarta paquetes de eliminacion repetidos', async () => {
    const file = buildReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 160 },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
    ]);

    const parsed = await parseReplay(file);
    expect(parsed!.events.filter((e) => e.type === 'kill')).toHaveLength(1);
  });

  it('lee un cuerpo repartido en varias tramas zstd', async () => {
    const file = buildReplayFile(
      HEADER,
      [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
        { kind: 'time', secondsRemaining: 120 },
        { kind: 'kill', killer: ME, victim: 'OtroEnemigo' },
      ],
      { frames: 3 },
    );

    const parsed = await parseReplay(file);
    expect(parsed!.events.filter((e) => e.type === 'kill')).toHaveLength(2);
  });

  /**
   * El avance por tramas usa los bytes consumidos, no la busqueda de la
   * siguiente firma, precisamente para tolerar huecos.
   */
  it('tolera bytes ajenos entre tramas', async () => {
    const file = buildReplayFile(
      HEADER,
      [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
        { kind: 'time', secondsRemaining: 100 },
        { kind: 'kill', killer: 'Enemigo', victim: ME },
      ],
      { frames: 4, gapBetweenFrames: true },
    );

    const parsed = await parseReplay(file);
    expect(parsed!.events.filter((e) => e.type === 'kill')).toHaveLength(1);
    expect(parsed!.events.filter((e) => e.type === 'death')).toHaveLength(1);
  });

  it('lee la variante antigua comprimida entera', async () => {
    const file = buildLegacyReplayFile(HEADER, [
      { kind: 'time', secondsRemaining: 180 },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
    ]);

    const parsed = await parseReplay(file);
    expect(parsed).not.toBeNull();
    expect(parsed!.header.roundNumber).toBe(3);
    expect(parsed!.events.filter((e) => e.type === 'kill')).toHaveLength(1);
  });

  it('devuelve null ante un fichero que no es una repeticion', async () => {
    expect(await parseReplay(Buffer.from('esto es un mp4 cualquiera'))).toBeNull();
    expect(await parseReplay(Buffer.alloc(0))).toBeNull();
  });

  it('devuelve null ante una cabecera truncada', async () => {
    const file = buildReplayFile(HEADER, []);
    expect(await parseReplay(file.subarray(0, 40))).toBeNull();
  });

  it('no revienta si el cuerpo esta corrupto', async () => {
    const file = buildReplayFile(HEADER, [{ kind: 'time', secondsRemaining: 180 }]);
    // Se destroza todo lo que va despues de la cabecera.
    const corrupted = Buffer.concat([file.subarray(0, 300), Buffer.alloc(500, 0x7f)]);
    const parsed = await parseReplay(corrupted);
    // O devuelve null o devuelve una lectura vacia, pero nunca lanza.
    if (parsed) expect(parsed.events).toEqual([]);
  });

  it('respeta la version antigua del paquete de reloj', async () => {
    const file = buildReplayFile({ ...HEADER, codeVersion: CODE_VERSION_Y8S1 }, [
      { kind: 'time', secondsRemaining: 175 },
      { kind: 'kill', killer: ME, victim: 'Enemigo' },
    ]);
    const parsed = await parseReplay(file);
    expect(parsed).not.toBeNull();
    // Con codeVersion >= Y8S1 se usa el patron moderno de reloj.
    expect(parsed!.maxTimeRemaining).toBe(175);
  });
});

// ---------------------------------------------------------------------------

describe('R6ReplayProvider', () => {
  let documents: string;
  let replayDir: string;

  beforeEach(() => {
    documents = mkdtempSync(join(tmpdir(), 'clipper-r6-'));
    replayDir = join(documents, 'My Games', 'Rainbow Six - Siege', 'perfil-1', 'MatchReplay');
    mkdirSync(replayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(documents, { recursive: true, force: true });
  });

  /** Escribe una repeticion y la envejece para saltar el margen de antiguedad. */
  function writeReplay(name: string, file: Buffer, ageMs = 10_000): string {
    const path = join(replayDir, name);
    writeFileSync(path, file);
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it('encuentra la carpeta de repeticiones de cada perfil', () => {
    const roots = findReplayRoots(documents);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(replayDir);
  });

  it('no encuentra nada si el juego no ha creado la carpeta', () => {
    const empty = mkdtempSync(join(tmpdir(), 'clipper-r6-vacio-'));
    expect(findReplayRoots(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it('recoge los .rec incluidos los de subcarpetas por partida', async () => {
    const sub = join(replayDir, 'Match-2026-09-02');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'ronda1.rec'), Buffer.alloc(10));
    writeFileSync(join(replayDir, 'suelta.rec'), Buffer.alloc(10));
    writeFileSync(join(replayDir, 'ignorame.txt'), Buffer.alloc(10));

    const files = await collectReplayFiles(replayDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.path.endsWith('.rec'))).toBe(true);
  });

  it('avisa cuando no hay carpeta de repeticiones', () => {
    const empty = mkdtempSync(join(tmpdir(), 'clipper-r6-sin-'));
    const provider = new R6ReplayProvider(empty);
    provider.start(Date.now());

    const state = provider.getState();
    expect(state.status).toBe('unavailable');
    expect(state.message).toContain('Match Replay');

    provider.dispose();
    rmSync(empty, { recursive: true, force: true });
  });

  it('emite los eventos de una ronda con el formato del adaptador', async () => {
    writeReplay(
      'ronda1.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo', headshot: true },
        { kind: 'time', secondsRemaining: 100 },
        { kind: 'kill', killer: 'OtroEnemigo', victim: ME },
      ]),
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(0);
    await provider.scan();

    const keys = received.map((r) => `${r.feature}/${r.key}`);
    expect(keys).toContain('kill/kill');
    expect(keys).toContain('kill/headshot');
    expect(keys).toContain('death/death');
    expect(keys).toContain('death/killer');

    // Formato identico al de GEP: ocurrencias discretas con value null.
    const kill = received.find((r) => r.key === 'kill');
    expect(kill?.value).toBeNull();
    expect(kill?.gameId).toBe(10826);

    // El nombre de quien nos mato viaja como valor del evento killer.
    expect(received.find((r) => r.key === 'killer')?.value).toBe('OtroEnemigo');

    provider.dispose();
  });

  /**
   * Es lo que impide que todos los marcadores de una ronda se apilen en el
   * instante en que se leyo el fichero.
   */
  it('calcula la antiguedad real de cada evento en vez de usar la de lectura', async () => {
    // Ronda que empezo hace exactamente 10 minutos.
    const roundStart = new Date(Date.now() - 600_000);
    const datetime = [
      roundStart.getFullYear(),
      String(roundStart.getMonth() + 1).padStart(2, '0'),
      String(roundStart.getDate()).padStart(2, '0'),
      String(roundStart.getHours()).padStart(2, '0'),
      String(roundStart.getMinutes()).padStart(2, '0'),
      String(roundStart.getSeconds()).padStart(2, '0'),
    ].join('-');

    writeReplay(
      'ronda2.rec',
      buildReplayFile({ ...HEADER, datetime }, [
        { kind: 'time', secondsRemaining: 180 },
        // A los 30 s de ronda.
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
        { kind: 'time', secondsRemaining: 150 },
        { kind: 'time', secondsRemaining: 60 },
        // A los 120 s de ronda.
        { kind: 'kill', killer: ME, victim: 'OtroEnemigo' },
      ]),
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(0, { roundOffsetMs: 0 });
    await provider.scan();

    const kills = received.filter((r) => r.key === 'kill');
    expect(kills).toHaveLength(2);

    // Primera kill: 600 s desde el inicio de ronda, menos 0 s transcurridos.
    expect(kills[0].latencyHintMs).toBeGreaterThan(590_000);
    // Segunda kill: 120 s mas tarde dentro de la ronda, luego mas reciente.
    expect(kills[1].latencyHintMs).toBeLessThan(kills[0].latencyHintMs!);
    const separation = kills[0].latencyHintMs! - kills[1].latencyHintMs!;
    expect(separation).toBeCloseTo(120_000, -3);

    provider.dispose();
  });

  it('aplica el desfase de calibracion', async () => {
    writeReplay(
      'ronda3.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
      ]),
    );

    const sinDesfase = new R6ReplayProvider(documents);
    const a: RawGameEvent[] = [];
    sinDesfase.on('raw', (raw: RawGameEvent) => a.push(raw));
    sinDesfase.start(0, { roundOffsetMs: 0 });
    await sinDesfase.scan();

    const conDesfase = new R6ReplayProvider(documents);
    const b: RawGameEvent[] = [];
    conDesfase.on('raw', (raw: RawGameEvent) => b.push(raw));
    conDesfase.start(0, { roundOffsetMs: 45_000 });
    await conDesfase.scan();

    // Un desfase de 45 s hace que el evento se considere 45 s mas reciente.
    const diff = a[0].latencyHintMs! - b[0].latencyHintMs!;
    expect(diff).toBeCloseTo(45_000, -3);

    sinDesfase.dispose();
    conDesfase.dispose();
  });

  it('no procesa dos veces el mismo fichero', async () => {
    writeReplay(
      'ronda4.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
      ]),
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(0);
    await provider.scan();
    const first = received.length;
    await provider.scan();
    await provider.scan();

    expect(received.length).toBe(first);
    provider.dispose();
  });

  it('ignora las rondas anteriores al inicio de la sesion', async () => {
    // Repeticion de hace una hora: pertenece a una sesion previa.
    writeReplay(
      'antigua.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
      ]),
      3_600_000,
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(Date.now() - 60_000);
    await provider.scan();

    expect(received).toHaveLength(0);
    provider.dispose();
  });

  it('salta ficheros que el juego todavia esta escribiendo', async () => {
    // Recien escrito: no ha pasado el margen de antiguedad.
    writeReplay(
      'reciente.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
      ]),
      0,
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(0);
    await provider.scan();
    expect(received).toHaveLength(0);

    // El drenado final si lo recoge: el juego ya ha cerrado el fichero.
    await provider.scan(true);
    expect(received.length).toBeGreaterThan(0);

    provider.dispose();
  });

  it('descarta ficheros ilegibles sin romper el resto', async () => {
    writeReplay('roto.rec', Buffer.from('esto no es una repeticion'));
    writeReplay(
      'bueno.rec',
      buildReplayFile(HEADER, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
      ]),
    );

    const provider = new R6ReplayProvider(documents);
    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    provider.start(0);
    await provider.scan();

    expect(received.filter((r) => r.key === 'kill')).toHaveLength(1);
    provider.dispose();
  });
});

// ---------------------------------------------------------------------------

/**
 * Cadena completa sin Overwolf: repeticion del juego -> proveedor ->
 * adaptador de Rainbow Six -> EventManager -> marcadores con su posicion.
 */
describe('Repeticion -> adaptador -> EventManager', () => {
  let documents: string;
  let replayDir: string;

  const settings: EventSettings = {
    detectKills: true,
    detectDeaths: true,
    detectHeadshots: true,
    detectAssists: true,
    detectRounds: true,
    // Alta a proposito: la pista del proveedor debe tener prioridad.
    latencyOffsetMs: { valorant: 0, rainbowsix: 9999, lol: 0 },
    r6RoundOffsetMs: 0,
  };

  beforeEach(() => {
    documents = mkdtempSync(join(tmpdir(), 'clipper-r6e2e-'));
    replayDir = join(documents, 'My Games', 'Rainbow Six - Siege', 'perfil-1', 'MatchReplay');
    mkdirSync(replayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(documents, { recursive: true, force: true });
  });

  it('produce marcadores de kill, headshot y muerte', async () => {
    const path = join(replayDir, 'ronda.rec');
    writeFileSync(
      path,
      buildReplayFile({ ...HEADER, datetime: datetimeSecondsAgo(600) }, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo', headshot: true },
        { kind: 'time', secondsRemaining: 120 },
        { kind: 'kill', killer: 'OtroEnemigo', victim: ME },
      ]),
    );
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);

    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new RainbowSixAdapter(), settings);
    recordingClock.arm();
    // La grabacion lleva una hora; la ronda empezo hace diez minutos, asi que
    // sus eventos caen dentro del video.
    clock.advanceMs(3_600_000);

    const provider = new R6ReplayProvider(documents);
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));
    provider.start(0);
    await provider.scan();

    const types = manager.getEvents().map((e) => e.type);
    expect(types).toContain(GameEventType.KILL);
    expect(types).toContain(GameEventType.HEADSHOT);
    expect(types).toContain(GameEventType.DEATH);

    expect(manager.getSummary()).toMatchObject({ kills: 1, deaths: 1, headshots: 1 });

    // El killer llega como parche sobre la muerte, igual que con GEP.
    const death = manager.getEvents().find((e) => e.type === GameEventType.DEATH);
    expect(death?.metadata?.killer).toBe('OtroEnemigo');

    provider.dispose();
  });

  it('separa los marcadores segun cuando ocurrieron dentro de la ronda', async () => {
    const path = join(replayDir, 'ronda.rec');
    writeFileSync(
      path,
      buildReplayFile({ ...HEADER, datetime: datetimeSecondsAgo(600) }, [
        { kind: 'time', secondsRemaining: 180 },
        { kind: 'kill', killer: ME, victim: 'Enemigo' },
        { kind: 'time', secondsRemaining: 120 },
        { kind: 'kill', killer: ME, victim: 'OtroEnemigo' },
      ]),
    );
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);

    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    const manager = new EventManager({ clock, recordingClock });
    manager.begin(new RainbowSixAdapter(), settings);
    recordingClock.arm();
    clock.advanceMs(3_600_000);

    const provider = new R6ReplayProvider(documents);
    provider.on('raw', (raw: RawGameEvent) => manager.ingest(raw));
    provider.start(0);
    await provider.scan();

    const kills = manager.getEvents().filter((e) => e.type === GameEventType.KILL);
    expect(kills).toHaveLength(2);

    // Las dos kills estan separadas 60 s dentro de la ronda, y esa separacion
    // debe conservarse en la timeline aunque hayan llegado a la vez.
    expect(kills[1].videoTime - kills[0].videoTime).toBeCloseTo(60, 0);

    provider.dispose();
  });
});
