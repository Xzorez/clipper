import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/core/database/Database';
import { GameEvent, GameEventType } from '../src/shared/types';

function makeEvent(type: GameEventType, videoTime: number): GameEvent {
  return {
    id: randomUUID(),
    game: 'valorant',
    type,
    timestamp: Date.now(),
    monotonicNs: String(BigInt(Math.round(videoTime * 1e9))),
    videoTime,
    metadata: { weapon: 'Vandal' },
  };
}

describe('Database', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-db-'));
    db = new Database(join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('crea el esquema con los juegos precargados', () => {
    const recordings = db.listRecordings();
    expect(recordings).toEqual([]);
  });

  it('guarda y recupera una grabacion', () => {
    const id = randomUUID();
    db.createRecording({
      id,
      game: 'valorant',
      filePath: 'C:/videos/partida.mp4',
      startedAt: 1_700_000_000_000,
      resolution: '1920x1080',
      fps: 60,
      encoder: 'jim_nvenc',
    });

    const record = db.getRecording(id);
    expect(record).not.toBeNull();
    expect(record!.game).toBe('valorant');
    expect(record!.status).toBe('recording');
    expect(record!.resolution).toBe('1920x1080');
    expect(record!.fps).toBe(60);
  });

  it('finaliza una grabacion con su duracion', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'lol', filePath: 'a.mp4', startedAt: 1000 });
    db.finalizeRecording(id, { endedAt: 61_000, duration: 60, status: 'completed' });

    const record = db.getRecording(id)!;
    expect(record.status).toBe('completed');
    expect(record.duration).toBe(60);
    expect(record.endedAt).toBe(61_000);
  });

  it('guarda eventos y los devuelve ordenados por tiempo de video', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.insertEvents(id, [
      makeEvent(GameEventType.DEATH, 201.32),
      makeEvent(GameEventType.KILL, 123.42),
      makeEvent(GameEventType.HEADSHOT, 156.91),
    ]);

    const events = db.getEvents(id);
    expect(events.map((e) => e.videoTime)).toEqual([123.42, 156.91, 201.32]);
    expect(events[0].metadata).toEqual({ weapon: 'Vandal' });
  });

  it('filtra eventos por tipo', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.insertEvents(id, [
      makeEvent(GameEventType.KILL, 10),
      makeEvent(GameEventType.DEATH, 20),
      makeEvent(GameEventType.HEADSHOT, 30),
    ]);

    const kills = db.getEvents(id, [GameEventType.KILL, GameEventType.HEADSHOT]);
    expect(kills).toHaveLength(2);
    expect(kills.map((e) => e.type)).toEqual([GameEventType.KILL, GameEventType.HEADSHOT]);
  });

  it('calcula el resumen agregado en la consulta de la biblioteca', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.finalizeRecording(id, { endedAt: 1000, duration: 1, status: 'completed' });
    db.insertEvents(id, [
      makeEvent(GameEventType.KILL, 1),
      makeEvent(GameEventType.KILL, 2),
      makeEvent(GameEventType.KILL, 3),
      makeEvent(GameEventType.DEATH, 4),
      makeEvent(GameEventType.HEADSHOT, 5),
      makeEvent(GameEventType.ASSIST, 6),
    ]);

    const [record] = db.listRecordings();
    expect(record.summary).toMatchObject({ kills: 3, deaths: 1, headshots: 1, assists: 1 });
    expect(record.eventCount).toBe(6);
  });

  // Escenario 11: partida sin eventos.
  it('maneja una grabacion sin ningun evento', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'rainbowsix', filePath: 'a.mp4', startedAt: 0 });
    db.finalizeRecording(id, { endedAt: 1000, duration: 1, status: 'completed' });

    const [record] = db.listRecordings();
    expect(record.eventCount).toBe(0);
    expect(record.summary).toEqual({
      kills: 0,
      deaths: 0,
      headshots: 0,
      assists: 0,
      knockedOut: 0,
      rounds: 0,
    });
    expect(db.getEvents(id)).toEqual([]);
  });

  it('aplica la correccion del reloj a todos los eventos de una grabacion', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.insertEvents(id, [makeEvent(GameEventType.KILL, 10), makeEvent(GameEventType.KILL, 20)]);

    db.applyClockCorrection(id, -0.4);

    const times = db.getEvents(id).map((e) => e.videoTime);
    expect(times[0]).toBeCloseTo(9.6, 3);
    expect(times[1]).toBeCloseTo(19.6, 3);
  });

  it('no produce tiempos negativos al corregir', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.insertEvents(id, [makeEvent(GameEventType.KILL, 0.1)]);

    db.applyClockCorrection(id, -5);
    expect(db.getEvents(id)[0].videoTime).toBe(0);
  });

  it('no duplica al reinsertar el mismo evento', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    const event = makeEvent(GameEventType.KILL, 5);

    db.insertEvent(id, event);
    db.insertEvent(id, event);

    expect(db.countEvents(id)).toBe(1);
  });

  it('actualiza la metadata de un evento', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'rainbowsix', filePath: 'a.mp4', startedAt: 0 });
    const event = makeEvent(GameEventType.DEATH, 5);
    db.insertEvent(id, event);

    db.updateEventMetadata(event.id, { killer: 'uuid-enemigo' });
    expect(db.getEvents(id)[0].metadata).toEqual({ killer: 'uuid-enemigo' });
  });

  it('borra en cascada los eventos al borrar la grabacion', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.insertEvents(id, [makeEvent(GameEventType.KILL, 1)]);

    db.deleteRecording(id);
    expect(db.getRecording(id)).toBeNull();
    expect(db.countEvents(id)).toBe(0);
  });

  it('filtra la biblioteca por juego', () => {
    for (const game of ['valorant', 'lol', 'valorant'] as const) {
      const id = randomUUID();
      db.createRecording({ id, game, filePath: `${id}.mp4`, startedAt: Date.now() });
    }
    expect(db.listRecordings({ game: 'valorant' })).toHaveLength(2);
    expect(db.listRecordings({ game: 'lol' })).toHaveLength(1);
    expect(db.listRecordings()).toHaveLength(3);
  });

  it('ordena la biblioteca de la mas reciente a la mas antigua', () => {
    const older = randomUUID();
    const newer = randomUUID();
    db.createRecording({ id: older, game: 'valorant', filePath: 'a.mp4', startedAt: 1000 });
    db.createRecording({ id: newer, game: 'valorant', filePath: 'b.mp4', startedAt: 5000 });

    expect(db.listRecordings()[0].id).toBe(newer);
  });

  it('gestiona clips ligados a su grabacion', () => {
    const recordingId = randomUUID();
    db.createRecording({ id: recordingId, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });

    const clipId = randomUUID();
    db.createClip({
      id: clipId,
      recordingId,
      filePath: 'clip.mp4',
      thumbnailPath: null,
      title: 'Triple kill',
      startTime: 100,
      endTime: 115,
      createdAt: Date.now(),
    });

    const clips = db.listClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].title).toBe('Triple kill');
    expect(clips[0].game).toBe('valorant');

    db.deleteClip(clipId);
    expect(db.listClips()).toHaveLength(0);
  });

  it('encuentra grabaciones huerfanas de un cierre inesperado', () => {
    const orphan = randomUUID();
    const finished = randomUUID();
    db.createRecording({ id: orphan, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });
    db.createRecording({ id: finished, game: 'valorant', filePath: 'b.mp4', startedAt: 0 });
    db.finalizeRecording(finished, { endedAt: 1, duration: 1, status: 'completed' });

    const orphans = db.findOrphanRecordings();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].id).toBe(orphan);
  });

  it('revierte la transaccion si algo falla a mitad', () => {
    const id = randomUUID();
    db.createRecording({ id, game: 'valorant', filePath: 'a.mp4', startedAt: 0 });

    expect(() =>
      db.transaction(() => {
        db.insertEvent(id, makeEvent(GameEventType.KILL, 1));
        throw new Error('fallo simulado');
      }),
    ).toThrow('fallo simulado');

    expect(db.countEvents(id)).toBe(0);
  });
});
