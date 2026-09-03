import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/core/database/Database';
import { SidecarStore } from '../src/core/recording/SidecarStore';
import { RecoveryService } from '../src/core/services/RecoveryService';
import { ThumbnailService } from '../src/core/services/ThumbnailService';
import { GameEvent, GameEventType } from '../src/shared/types';

function makeEvent(type: GameEventType, videoTime: number): GameEvent {
  return {
    id: randomUUID(),
    game: 'valorant',
    type,
    timestamp: 1_700_000_000_000 + videoTime * 1000,
    monotonicNs: String(BigInt(Math.round(videoTime * 1e9))),
    videoTime,
  };
}

/** Miniaturas desactivadas: estos tests no deben depender de FFmpeg. */
class NoopThumbnails extends ThumbnailService {
  async generate(): Promise<string | null> {
    return null;
  }
}

describe('SidecarStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-sidecar-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deriva la ruta del sidecar a partir del video', () => {
    expect(SidecarStore.pathFor('C:/videos/partida.mp4')).toBe('C:/videos/partida.json');
  });

  // Escenario 9 del enunciado: escribir y cargar recording.json.
  it('escribe y vuelve a leer el recording.json', () => {
    const video = join(dir, 'partida.mp4');
    const events = [
      makeEvent(GameEventType.KILL, 123.42),
      makeEvent(GameEventType.HEADSHOT, 156.91),
      makeEvent(GameEventType.DEATH, 201.32),
    ];

    const sidecar = SidecarStore.build({
      recordingId: 'rec-1',
      game: 'valorant',
      videoPath: video,
      startedAtMs: 1_700_000_000_000,
      endedAtMs: 1_700_000_600_000,
      durationSec: 600,
      resolution: '1920x1080',
      fps: 60,
      encoder: 'jim_nvenc',
      status: 'completed',
      events,
    });

    expect(SidecarStore.write(video, sidecar)).toBe(true);

    const loaded = SidecarStore.read(video);
    expect(loaded).not.toBeNull();
    expect(loaded!.game).toBe('valorant');
    expect(loaded!.video).toBe('partida.mp4');
    expect(loaded!.duration).toBe(600);
    expect(loaded!.events).toHaveLength(3);
    expect(loaded!.events[0]).toMatchObject({ type: 'KILL', videoTime: 123.42 });
    expect(loaded!.events[2]).toMatchObject({ type: 'DEATH', videoTime: 201.32 });
  });

  it('produce la estructura del enunciado', () => {
    const video = join(dir, 'p.mp4');
    SidecarStore.write(
      video,
      SidecarStore.build({
        recordingId: 'r',
        game: 'valorant',
        videoPath: video,
        startedAtMs: Date.now(),
        status: 'completed',
        events: [makeEvent(GameEventType.KILL, 12.5)],
      }),
    );

    const raw = JSON.parse(readFileSync(SidecarStore.pathFor(video), 'utf8'));
    expect(raw).toHaveProperty('game');
    expect(raw).toHaveProperty('startTime');
    expect(raw).toHaveProperty('events');
    expect(raw.events[0]).toHaveProperty('type');
    expect(raw.events[0]).toHaveProperty('timestamp');
    expect(raw.events[0]).toHaveProperty('videoTime');
  });

  it('devuelve null si el sidecar no existe', () => {
    expect(SidecarStore.read(join(dir, 'no-existe.mp4'))).toBeNull();
  });

  // Escenario 13: metadatos corruptos.
  it('no revienta con un JSON corrupto', () => {
    const video = join(dir, 'roto.mp4');
    writeFileSync(SidecarStore.pathFor(video), '{ esto no es json valido', 'utf8');
    expect(SidecarStore.read(video)).toBeNull();
  });

  it('rechaza un JSON valido pero con forma incorrecta', () => {
    const video = join(dir, 'forma.mp4');
    writeFileSync(SidecarStore.pathFor(video), JSON.stringify({ hola: 'mundo' }), 'utf8');
    expect(SidecarStore.read(video)).toBeNull();
  });

  it('no deja ficheros temporales tras una escritura correcta', () => {
    const video = join(dir, 'atomico.mp4');
    SidecarStore.write(
      video,
      SidecarStore.build({
        recordingId: 'r',
        game: 'lol',
        videoPath: video,
        startedAtMs: Date.now(),
        status: 'completed',
        events: [],
      }),
    );
    expect(existsSync(SidecarStore.pathFor(video) + '.tmp')).toBe(false);
  });

  it('devuelve false en lugar de lanzar si la ruta no se puede escribir', () => {
    const impossible = join(dir, 'no', 'existe', 'esta', 'ruta.mp4');
    const sidecar = SidecarStore.build({
      recordingId: 'r',
      game: 'lol',
      videoPath: impossible,
      startedAtMs: Date.now(),
      status: 'completed',
      events: [],
    });
    expect(SidecarStore.write(impossible, sidecar)).toBe(false);
  });
});

describe('RecoveryService', () => {
  let dir: string;
  let db: Database;
  let recovery: RecoveryService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-recovery-'));
    db = new Database(join(dir, 'test.db'));
    recovery = new RecoveryService(db, new NoopThumbnails(join(dir, 'thumbs')));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no hace nada si no hay grabaciones huerfanas', async () => {
    const report = await recovery.run();
    expect(report).toEqual({ recovered: 0, discarded: 0, details: [] });
  });

  /**
   * Escenario 12: el juego (o Windows) se cierra de golpe y la grabacion queda
   * en estado 'recording'. El video existe, asi que se recupera.
   */
  it('recupera una grabacion cuyo video sobrevivio', async () => {
    const id = randomUUID();
    const video = join(dir, 'partida.mp4');
    writeFileSync(video, Buffer.alloc(50_000)); // video con contenido

    db.createRecording({ id, game: 'valorant', filePath: video, startedAt: Date.now() - 120_000 });

    SidecarStore.write(
      video,
      SidecarStore.build({
        recordingId: id,
        game: 'valorant',
        videoPath: video,
        startedAtMs: Date.now() - 120_000,
        durationSec: 118,
        status: 'recording',
        events: [makeEvent(GameEventType.KILL, 30), makeEvent(GameEventType.DEATH, 90)],
      }),
    );

    const report = await recovery.run();
    expect(report.recovered).toBe(1);
    expect(report.discarded).toBe(0);

    const record = db.getRecording(id)!;
    expect(record.status).toBe('recovered');
    expect(record.duration).toBeCloseTo(118, 0);
  });

  it('reimporta del sidecar los eventos que no llegaron a la base de datos', async () => {
    const id = randomUUID();
    const video = join(dir, 'partida.mp4');
    writeFileSync(video, Buffer.alloc(50_000));

    db.createRecording({ id, game: 'valorant', filePath: video, startedAt: Date.now() - 60_000 });

    // Solo uno de los tres eventos llego a SQLite antes del corte.
    const events = [
      makeEvent(GameEventType.KILL, 10),
      makeEvent(GameEventType.KILL, 20),
      makeEvent(GameEventType.DEATH, 30),
    ];
    db.insertEvent(id, events[0]);

    SidecarStore.write(
      video,
      SidecarStore.build({
        recordingId: id,
        game: 'valorant',
        videoPath: video,
        startedAtMs: Date.now() - 60_000,
        durationSec: 58,
        status: 'recording',
        events,
      }),
    );

    await recovery.run();

    // Los tres eventos estan, sin duplicar el que ya existia.
    expect(db.countEvents(id)).toBe(3);
  });

  // Escenario 13: grabacion corrupta o inexistente.
  it('marca como fallida la grabacion cuyo video no existe', async () => {
    const id = randomUUID();
    db.createRecording({
      id,
      game: 'lol',
      filePath: join(dir, 'jamas-escrito.mp4'),
      startedAt: Date.now(),
    });

    const report = await recovery.run();
    expect(report.discarded).toBe(1);
    expect(db.getRecording(id)!.status).toBe('failed');
  });

  it('trata un video de 0 bytes como fallido', async () => {
    const id = randomUUID();
    const video = join(dir, 'vacio.mp4');
    writeFileSync(video, '');
    db.createRecording({ id, game: 'lol', filePath: video, startedAt: Date.now() });

    const report = await recovery.run();
    expect(report.discarded).toBe(1);
    expect(db.getRecording(id)!.status).toBe('failed');
  });

  it('conserva los eventos aunque el video se haya perdido', async () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: join(dir, 'perdido.mp4'), startedAt: 0 });
    db.insertEvents(id, [makeEvent(GameEventType.KILL, 5), makeEvent(GameEventType.DEATH, 15)]);

    await recovery.run();

    expect(db.getRecording(id)!.status).toBe('failed');
    // Perder el video no debe borrar lo que sabemos de la partida.
    expect(db.countEvents(id)).toBe(2);
  });

  it('recupera varias grabaciones en una pasada', async () => {
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const video = join(dir, `p${i}.mp4`);
      writeFileSync(video, Buffer.alloc(20_000));
      db.createRecording({ id, game: 'valorant', filePath: video, startedAt: Date.now() - 10_000 });
    }

    const report = await recovery.run();
    expect(report.recovered).toBe(3);
    expect(db.findOrphanRecordings()).toHaveLength(0);
  });

  it('recupera sin sidecar, estimando la duracion', async () => {
    const id = randomUUID();
    const video = join(dir, 'sin-sidecar.mp4');
    writeFileSync(video, Buffer.alloc(30_000));
    db.createRecording({ id, game: 'rainbowsix', filePath: video, startedAt: Date.now() - 45_000 });

    const report = await recovery.run();
    expect(report.recovered).toBe(1);
    expect(db.getRecording(id)!.duration).toBeGreaterThan(0);
  });
});
