import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { runtimeRequire } from '../runtimeRequire';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ClipRecord,
  GameEvent,
  GameEventType,
  GameKey,
  RecordingRecord,
} from '../../shared/types';
import { summarize } from '../events/EventManager';
import { createLogger } from '../logging/Logger';

const log = createLogger('Database');

const SCHEMA_VERSION = 1;

/**
 * Carga `node:sqlite` en tiempo de ejecucion.
 *
 * El import estatico se deja solo para los tipos: los empaquetadores que
 * procesan este codigo (Vite en los tests) intentan resolver el especificador
 * como si fuera un paquete de npm y fallan. Con un require en tiempo de
 * ejecucion el modulo se resuelve contra el Node que ejecuta el proceso, que es
 * donde realmente vive.
 */
type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

function loadDatabaseSync(): DatabaseSyncConstructor {
  const sqlite = runtimeRequire()('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
  if (!sqlite?.DatabaseSync) {
    throw new Error(
      'Este entorno no incluye node:sqlite. Se requiere Node 22.5 o superior ' +
        '(Electron 42 incorpora Node 24).',
    );
  }
  return sqlite.DatabaseSync;
}

/**
 * Capa de persistencia sobre SQLite.
 *
 * Usa `node:sqlite`, el modulo integrado en Node 24 que trae Electron 42
 * (verificado: ow-electron 42.7.1 -> Node 24.18). Esto evita depender de
 * modulos nativos como better-sqlite3, que obligarian a recompilar contra el
 * ABI del fork de Electron en cada actualizacion. Es SQLite real, con
 * transacciones e indices, sin cadena de compilacion.
 */
export class Database {
  private db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    const DatabaseSyncCtor = loadDatabaseSync();
    this.db = new DatabaseSyncCtor(filePath);
    // WAL: permite leer mientras se escribe y sobrevive mucho mejor a un
    // cierre inesperado, que es exactamente nuestro escenario de riesgo.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    log.info(`Base de datos abierta en ${filePath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS games (
        id      TEXT PRIMARY KEY,
        name    TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS recordings (
        id             TEXT PRIMARY KEY,
        game           TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        thumbnail_path TEXT,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        duration       REAL,
        resolution     TEXT,
        fps            INTEGER,
        encoder        TEXT,
        status         TEXT NOT NULL DEFAULT 'recording',
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (game) REFERENCES games(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id            TEXT PRIMARY KEY,
        recording_id  TEXT NOT NULL,
        type          TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        monotonic_ns  TEXT,
        video_time    REAL NOT NULL,
        before_start  INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS clips (
        id             TEXT PRIMARY KEY,
        recording_id   TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        thumbnail_path TEXT,
        title          TEXT NOT NULL,
        start_time     REAL NOT NULL,
        end_time       REAL NOT NULL,
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_recording   ON events(recording_id);
      CREATE INDEX IF NOT EXISTS idx_events_video_time  ON events(video_time);
      CREATE INDEX IF NOT EXISTS idx_events_type        ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_rec_type    ON events(recording_id, type);
      CREATE INDEX IF NOT EXISTS idx_recordings_started ON recordings(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_recordings_game    ON recordings(game);
      CREATE INDEX IF NOT EXISTS idx_clips_recording    ON clips(recording_id);
    `);

    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('version', String(SCHEMA_VERSION));

    const insertGame = this.db.prepare(
      'INSERT OR IGNORE INTO games (id, name, enabled) VALUES (?, ?, 1)',
    );
    insertGame.run('valorant', 'VALORANT');
    insertGame.run('rainbowsix', 'Rainbow Six Siege');
    insertGame.run('lol', 'League of Legends');
    insertGame.run('generic', 'Otros juegos');

    // La columna del titulo se anadio despues de las primeras versiones. No
    // basta con CREATE TABLE IF NOT EXISTS: quien ya tenga la base de datos
    // creada no la recibiria, y las consultas fallarian al leerla.
    this.addColumnIfMissing('recordings', 'title', 'TEXT');
  }

  /**
   * Anade una columna solo si falta.
   *
   * SQLite no tiene ALTER TABLE ADD COLUMN IF NOT EXISTS, asi que se mira
   * antes que columnas hay. Repetirlo en cada arranque no cuesta nada y evita
   * tener que llevar la cuenta de por que version pasa cada instalacion.
   */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    log.info(`Columna ${table}.${column} anadida`);
  }

  private stmt(sql: string): StatementSync {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  // -------------------------------------------------------------------------
  // Grabaciones
  // -------------------------------------------------------------------------

  createRecording(record: {
    id: string;
    game: GameKey;
    filePath: string;
    startedAt: number;
    resolution?: string | null;
    fps?: number | null;
    encoder?: string | null;
    title?: string | null;
  }): void {
    this.stmt(
      `INSERT INTO recordings
         (id, game, title, file_path, thumbnail_path, started_at, ended_at, duration,
          resolution, fps, encoder, status, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, 'recording', ?)`,
    ).run(
      record.id,
      record.game,
      record.title ?? null,
      record.filePath,
      record.startedAt,
      record.resolution ?? null,
      record.fps ?? null,
      record.encoder ?? null,
      Date.now(),
    );
  }

  finalizeRecording(
    id: string,
    data: {
      endedAt: number;
      duration: number | null;
      status: RecordingRecord['status'];
      thumbnailPath?: string | null;
      filePath?: string;
      resolution?: string | null;
      fps?: number | null;
      encoder?: string | null;
    },
  ): void {
    this.stmt(
      `UPDATE recordings SET
         ended_at = ?, duration = ?, status = ?,
         thumbnail_path = COALESCE(?, thumbnail_path),
         file_path      = COALESCE(?, file_path),
         resolution     = COALESCE(?, resolution),
         fps            = COALESCE(?, fps),
         encoder        = COALESCE(?, encoder)
       WHERE id = ?`,
    ).run(
      data.endedAt,
      data.duration,
      data.status,
      data.thumbnailPath ?? null,
      data.filePath ?? null,
      data.resolution ?? null,
      data.fps ?? null,
      data.encoder ?? null,
      id,
    );
  }

  setThumbnail(id: string, thumbnailPath: string): void {
    this.stmt('UPDATE recordings SET thumbnail_path = ? WHERE id = ?').run(thumbnailPath, id);
  }

  deleteRecording(id: string): void {
    this.stmt('DELETE FROM recordings WHERE id = ?').run(id);
  }

  getRecording(id: string): RecordingRecord | null {
    const row = this.stmt('SELECT * FROM recordings WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const record = mapRecording(row);
    record.summary = this.getSummaryFor(id);
    record.eventCount = this.countEvents(id);
    return record;
  }

  /** Devuelve las grabaciones con su resumen ya agregado en SQL. */
  listRecordings(options: { game?: GameKey; limit?: number; offset?: number } = {}): RecordingRecord[] {
    const { game, limit = 200, offset = 0 } = options;
    const where = game ? 'WHERE r.game = ?' : '';
    const sql = `
      SELECT r.*,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id) AS event_count,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'KILL')     AS kills,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'DEATH')    AS deaths,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'HEADSHOT') AS headshots,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'ASSIST')   AS assists,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'KNOCKED_OUT') AS knocked,
        (SELECT COUNT(*) FROM events e WHERE e.recording_id = r.id AND e.type = 'ROUND_START') AS rounds
      FROM recordings r
      ${where}
      ORDER BY r.started_at DESC
      LIMIT ? OFFSET ?`;
    const rows = (
      game ? this.stmt(sql).all(game, limit, offset) : this.stmt(sql).all(limit, offset)
    ) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const record = mapRecording(row);
      record.eventCount = Number(row.event_count ?? 0);
      record.summary = {
        kills: Number(row.kills ?? 0),
        deaths: Number(row.deaths ?? 0),
        headshots: Number(row.headshots ?? 0),
        assists: Number(row.assists ?? 0),
        knockedOut: Number(row.knocked ?? 0),
        rounds: Number(row.rounds ?? 0),
      };
      return record;
    });
  }

  /** Grabaciones que quedaron en estado 'recording' tras un cierre inesperado. */
  findOrphanRecordings(): RecordingRecord[] {
    const rows = this.stmt(
      "SELECT * FROM recordings WHERE status = 'recording'",
    ).all() as Array<Record<string, unknown>>;
    return rows.map(mapRecording);
  }

  // -------------------------------------------------------------------------
  // Eventos
  // -------------------------------------------------------------------------

  /** Inserta un lote de eventos en una sola transaccion. */
  insertEvents(recordingId: string, events: GameEvent[]): void {
    if (events.length === 0) return;
    const insert = this.stmt(
      `INSERT OR REPLACE INTO events
         (id, recording_id, type, timestamp, monotonic_ns, video_time, before_start, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      for (const event of events) {
        insert.run(
          event.id,
          recordingId,
          event.type,
          Math.round(event.timestamp),
          event.monotonicNs ?? null,
          event.videoTime,
          event.beforeRecording ? 1 : 0,
          event.metadata ? JSON.stringify(event.metadata) : null,
        );
      }
    });
  }

  insertEvent(recordingId: string, event: GameEvent): void {
    this.insertEvents(recordingId, [event]);
  }

  updateEventMetadata(eventId: string, metadata: Record<string, unknown> | undefined): void {
    this.stmt('UPDATE events SET metadata_json = ? WHERE id = ?').run(
      metadata ? JSON.stringify(metadata) : null,
      eventId,
    );
  }

  /** Reajusta en bloque los videoTime tras la reconciliacion del reloj. */
  applyClockCorrection(recordingId: string, correctionSec: number): void {
    if (correctionSec === 0) return;
    this.stmt(
      `UPDATE events
         SET video_time = ROUND(MAX(video_time + ?, 0), 3),
             before_start = CASE WHEN video_time + ? < 0 THEN 1 ELSE 0 END
       WHERE recording_id = ?`,
    ).run(correctionSec, correctionSec, recordingId);
  }

  getEvents(recordingId: string, types?: GameEventType[]): GameEvent[] {
    let rows: Array<Record<string, unknown>>;
    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(',');
      rows = this.stmt(
        `SELECT * FROM events WHERE recording_id = ? AND type IN (${placeholders})
         ORDER BY video_time ASC`,
      ).all(recordingId, ...types) as Array<Record<string, unknown>>;
    } else {
      rows = this.stmt(
        'SELECT * FROM events WHERE recording_id = ? ORDER BY video_time ASC',
      ).all(recordingId) as Array<Record<string, unknown>>;
    }
    return rows.map(mapEvent);
  }

  countEvents(recordingId: string): number {
    const row = this.stmt(
      'SELECT COUNT(*) AS n FROM events WHERE recording_id = ?',
    ).get(recordingId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  getSummaryFor(recordingId: string) {
    const rows = this.stmt(
      'SELECT type FROM events WHERE recording_id = ?',
    ).all(recordingId) as Array<{ type: string }>;
    return summarize(rows.map((r) => ({ type: r.type as GameEventType })));
  }

  // -------------------------------------------------------------------------
  // Clips
  // -------------------------------------------------------------------------

  createClip(clip: Omit<ClipRecord, 'game' | 'missingFile'>): void {
    this.stmt(
      `INSERT INTO clips
         (id, recording_id, file_path, thumbnail_path, title, start_time, end_time, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      clip.id,
      clip.recordingId,
      clip.filePath,
      clip.thumbnailPath ?? null,
      clip.title,
      clip.startTime,
      clip.endTime,
      clip.createdAt,
    );
  }

  listClips(): ClipRecord[] {
    const rows = this.stmt(
      `SELECT c.*, r.game AS game FROM clips c
       JOIN recordings r ON r.id = c.recording_id
       ORDER BY c.created_at DESC`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      recordingId: String(row.recording_id),
      filePath: String(row.file_path),
      thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
      title: String(row.title),
      startTime: Number(row.start_time),
      endTime: Number(row.end_time),
      createdAt: Number(row.created_at),
      game: String(row.game) as GameKey,
    }));
  }

  deleteClip(id: string): void {
    this.stmt('DELETE FROM clips WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------

  setGameEnabled(game: GameKey, enabled: boolean): void {
    this.stmt('UPDATE games SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, game);
  }

  /**
   * Ejecuta `fn` dentro de una transaccion.
   *
   * Es REENTRANTE a proposito. Metodos como `insertEvents` abren su propia
   * transaccion, asi que si un llamante superior envuelve varias operaciones
   * tendriamos un BEGIN dentro de otro BEGIN, que SQLite rechaza con
   * "cannot start a transaction within a transaction". Llevando la cuenta de la
   * profundidad, solo la llamada exterior emite BEGIN/COMMIT y las interiores se
   * limitan a ejecutar su trabajo. El resultado es el esperado: si algo falla en
   * cualquier nivel, se revierte todo el bloque exterior.
   */
  transaction(fn: () => void): void {
    if (this.transactionDepth > 0) {
      this.transactionDepth++;
      try {
        fn();
      } finally {
        this.transactionDepth--;
      }
      return;
    }

    this.db.exec('BEGIN');
    this.transactionDepth = 1;
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* el rollback puede fallar si la conexion ya esta rota */
      }
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }

  close(): void {
    try {
      this.statements.clear();
      this.db.close();
    } catch (err) {
      log.warn(`Error al cerrar la base de datos: ${(err as Error).message}`);
    }
  }
}

function mapRecording(row: Record<string, unknown>): RecordingRecord {
  return {
    id: String(row.id),
    game: String(row.game) as GameKey,
    title: row.title ? String(row.title) : null,
    filePath: String(row.file_path),
    thumbnailPath: row.thumbnail_path ? String(row.thumbnail_path) : null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    duration: row.duration === null || row.duration === undefined ? null : Number(row.duration),
    resolution: row.resolution ? String(row.resolution) : null,
    fps: row.fps === null || row.fps === undefined ? null : Number(row.fps),
    encoder: row.encoder ? String(row.encoder) : null,
    status: String(row.status) as RecordingRecord['status'],
    createdAt: Number(row.created_at),
  };
}

function mapEvent(row: Record<string, unknown>): GameEvent {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(String(row.metadata_json));
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: String(row.id),
    game: 'valorant' as GameKey, // se sobrescribe con el juego de la grabacion
    type: String(row.type) as GameEventType,
    timestamp: Number(row.timestamp),
    monotonicNs: row.monotonic_ns ? String(row.monotonic_ns) : '0',
    videoTime: Number(row.video_time),
    beforeRecording: Number(row.before_start) === 1,
    metadata,
  };
}
