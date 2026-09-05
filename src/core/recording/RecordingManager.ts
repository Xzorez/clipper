import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppSettings,
  GameEvent,
  GameKey,
  RecordingRecord,
  RecordingSummary,
} from '../../shared/types';
import { Database } from '../database/Database';
import { EventManager, emptySummary } from '../events/EventManager';
import { RecordingClock } from '../synchronization/RecordingClock';
import { GameAdapter } from '../games/GameAdapter';
import { ScreenRecorder, StopRecordingResult } from './ScreenRecorder';
import { DiskSpaceGuard } from './DiskSpaceGuard';
import { SidecarStore } from './SidecarStore';
import { ThumbnailService } from '../services/ThumbnailService';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/** Cada cuanto se vuelca el sidecar a disco durante la grabacion. */
const SIDECAR_FLUSH_INTERVAL_MS = 15_000;

/**
 * Quien sabe capturar el sonido y entregarselo al grabador.
 *
 * Se inyecta en lugar de instanciarse aqui porque la captura depende de la
 * ventana de Electron, y el gestor de grabaciones no deberia saber nada de
 * ventanas. En los tests se sustituye por un doble.
 */
export interface AudioSource {
  /** Arranca la captura. Devuelve la tuberia, o null si no habra sonido. */
  begin(settings: AppSettings['recording']): Promise<string | null>;
  end(): Promise<void>;
}

/** Datos necesarios para arrancar una grabacion. */
export interface StartParams {
  adapter: GameAdapter;
  settings: AppSettings;
  gamePid?: number;
  gameProcessName?: string;
  gameIsElevated?: boolean;
  /** Nombre real del juego, para los que no tienen adaptador propio. */
  gameTitle?: string;
}

export interface ActiveRecording {
  id: string;
  game: GameKey;
  filePath: string;
  startedAt: number;
  resolution: string;
  fps: number;
  encoder: string;
}

/**
 * Orquesta una grabacion completa: video + eventos + metadatos.
 *
 * Secuencia de una partida:
 *
 *   1. `start()` comprueba disco, arranca el grabador y crea la fila en la BD.
 *   2. El grabador confirma 'backend-started' -> se fija el ancla del reloj y
 *      se vuelcan los eventos que hubieran llegado antes.
 *   3. Durante la partida los eventos se persisten uno a uno en SQLite y el
 *      sidecar JSON se reescribe cada 15 s como diario de recuperacion.
 *   4. `stop()` detiene el grabador, RECIBE el startTimeEpoch real y ejecuta
 *      la reconciliacion del reloj, que reajusta todos los videoTime tanto en
 *      memoria como en la base de datos y en el sidecar.
 *   5. Se genera la miniatura y la grabacion pasa a estado 'completed'.
 *
 * Ningun fallo de este flujo debe cerrar la aplicacion: cada paso esta
 * envuelto para degradar en lugar de propagar.
 */
export class RecordingManager extends EventEmitter {
  private readonly db: Database;
  private readonly recorder: ScreenRecorder;
  private readonly eventManager: EventManager;
  private readonly recordingClock: RecordingClock;
  private readonly diskGuard: DiskSpaceGuard;
  private readonly thumbnails: ThumbnailService;
  private readonly audio?: AudioSource;

  private active: ActiveRecording | null = null;
  /** Arranque en curso que aun no ha fijado `active`. Ver `start()`. */
  private startInFlight: Promise<ActiveRecording | null> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private anchoredResolver: (() => void) | null = null;

  constructor(deps: {
    db: Database;
    recorder: ScreenRecorder;
    eventManager: EventManager;
    recordingClock: RecordingClock;
    diskGuard: DiskSpaceGuard;
    thumbnails: ThumbnailService;
    /** Opcional: sin el, se graba sin sonido. */
    audio?: AudioSource;
  }) {
    super();
    this.db = deps.db;
    this.recorder = deps.recorder;
    this.eventManager = deps.eventManager;
    this.recordingClock = deps.recordingClock;
    this.diskGuard = deps.diskGuard;
    this.thumbnails = deps.thumbnails;
    this.audio = deps.audio;

    this.wireRecorder();
    this.wireEvents();
    this.wireDisk();
  }

  get current(): ActiveRecording | null {
    return this.active ? { ...this.active } : null;
  }

  get isRecording(): boolean {
    return this.active !== null;
  }

  get elapsedSeconds(): number {
    return this.recordingClock.isArmed ? this.recordingClock.elapsedSeconds() : 0;
  }

  getSummary(): RecordingSummary {
    return this.eventManager.getSummary();
  }

  // -------------------------------------------------------------------------

  private wireRecorder(): void {
    this.recorder.on('backend-started', () => {
      if (!this.active) return;
      // Fase 1 del anclaje: ancla provisional monotonica.
      this.recordingClock.arm();
      this.eventManager.onRecordingAnchored();
      this.anchoredResolver?.();
      this.anchoredResolver = null;
      this.emit('anchored', this.active);
      log.info('Reloj anclado al inicio del video');
    });

    this.recorder.on('backend-stopped', (result: StopRecordingResult) => {
      // Puede llegar sin que hayamos pedido parar (el juego se cerro, error
      // del encoder, disco lleno). Cerramos ordenadamente en cualquier caso.
      if (this.active && !this.stopping) {
        log.warn('El grabador se detuvo por su cuenta; se cierra la grabacion');
        void this.finalize(result, 'completed');
      }
    });

    this.recorder.on('error', (err: Error) => {
      log.error(`Error del grabador: ${(err as Error).message}`);
      this.emit('error', err);
    });

    this.recorder.on('stats', (stats: unknown) => this.emit('stats', stats));

    // La captura ha dejado de ver imagen a mitad de grabacion. No se reinicia
    // (perderia continuidad y el ancla del reloj); se avisa, que es lo util.
    this.recorder.on('capture-blank', (payload: { message: string }) => {
      this.emit('warning', {
        title: 'La grabacion ha dejado de captar imagen',
        message: payload.message,
      });
    });
  }

  private wireEvents(): void {
    this.eventManager.on('event', (event: GameEvent) => {
      if (!this.active) return;
      try {
        // Persistencia inmediata: si la aplicacion muere, el evento ya esta
        // en SQLite. No esperamos al final de la partida.
        this.db.insertEvent(this.active.id, event);
      } catch (err) {
        log.error(`No se pudo guardar el evento: ${(err as Error).message}`);
      }
      this.emit('event', event);
    });

    this.eventManager.on('event-updated', (event: GameEvent) => {
      if (!this.active) return;
      try {
        this.db.updateEventMetadata(event.id, event.metadata);
      } catch {
        /* la metadata es accesoria: un fallo aqui no importa */
      }
    });

    this.eventManager.on('summary', (summary: RecordingSummary) => {
      this.emit('summary', summary);
    });
  }

  private wireDisk(): void {
    this.diskGuard.on('low-space', () => {
      if (!this.active) return;
      log.error('Espacio en disco critico: se detiene la grabacion de forma segura');
      this.emit('warning', {
        title: 'Espacio en disco insuficiente',
        message:
          'La grabacion se ha detenido para evitar perder el video. ' +
          'Libera espacio antes de volver a grabar.',
      });
      void this.stop();
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Inicia una grabacion. Devuelve null si no se pudo (con motivo emitido).
   *
   * `this.active` no se fija hasta despues de comprobar el disco y arrancar el
   * grabador, varios segundos mas tarde. Comprobarlo a secas dejaria una
   * ventana en la que dos llamadas simultaneas arrancarian dos capturas sobre
   * la misma ruta, asi que se memoriza la promesa del arranque, no su
   * resultado: quien llegue durante esa ventana espera al mismo arranque y
   * recibe la misma grabacion, en lugar de un null que pareceria un fallo.
   */
  async start(params: StartParams): Promise<ActiveRecording | null> {
    if (this.active) {
      log.warn('Ya hay una grabacion en curso');
      return this.current;
    }
    if (this.startInFlight) {
      log.warn('Ya hay una grabacion arrancando; se comparte el arranque en curso');
      return this.startInFlight;
    }
    const run = this.runStart(params);
    this.startInFlight = run;
    try {
      return await run;
    } finally {
      this.startInFlight = null;
    }
  }

  private async runStart(params: StartParams): Promise<ActiveRecording | null> {
    const { adapter, settings } = params;
    const folder = settings.recording.outputFolder;

    try {
      mkdirSync(folder, { recursive: true });
    } catch (err) {
      this.fail(
        'No se ha podido crear la carpeta de grabaciones',
        `${folder}: ${(err as Error).message}`,
      );
      return null;
    }

    const spaceError = await this.diskGuard.ensureSpaceForRecording(
      folder,
      settings.recording.minFreeSpaceGb,
    );
    if (spaceError) {
      this.fail('No se ha podido iniciar la captura', spaceError);
      return null;
    }

    const id = randomUUID();
    // Con resolucion de segundos, dos arranques en el mismo segundo generan la
    // misma ruta. Los milisegundos hacen imposible la colision.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const outputBase = join(folder, `${adapter.game}_${stamp}`);

    this.recordingClock.reset();
    this.eventManager.begin(adapter, settings.events);

    // El sonido se prepara antes que el video para poder pasarle la tuberia al
    // grabador. Si falla, se sigue adelante sin audio: una partida muda vale
    // mucho mas que ninguna partida.
    let audioPipePath: string | null = null;
    if (this.audio) {
      try {
        audioPipePath = await this.audio.begin(settings.recording);
      } catch (err) {
        log.warn(`No se ha podido capturar el sonido: ${(err as Error).message}`);
        audioPipePath = null;
      }
    }

    let started;
    try {
      started = await this.recorder.start({
        outputPathWithoutExt: outputBase,
        settings: settings.recording,
        audioPipePath,
        gamePid: params.gamePid,
        gameProcessName: params.gameProcessName,
        gameIsElevated: params.gameIsElevated,
      });
    } catch (err) {
      this.eventManager.end();
      await this.audio?.end().catch(() => undefined);
      // El mensaje del grabador ya explica que hacer cuando la causa es
      // conocida (por ejemplo, pantalla completa exclusiva). No se le anade
      // texto generico que lo diluya.
      this.fail('No se ha podido iniciar la captura', (err as Error).message);
      return null;
    }

    const startedAt = Date.now();
    this.active = {
      id,
      game: adapter.game,
      filePath: started.filePath,
      startedAt,
      resolution: started.resolution,
      fps: started.fps,
      encoder: started.encoder,
    };

    try {
      this.db.createRecording({
        id,
        game: adapter.game,
        title: params.gameTitle ?? null,
        filePath: started.filePath,
        startedAt,
        resolution: started.resolution,
        fps: started.fps,
        encoder: started.encoder,
      });
    } catch (err) {
      // Que falle la BD no debe impedir grabar: el sidecar JSON sigue siendo
      // una copia completa y permite recuperar la partida despues.
      log.error(`No se pudo registrar la grabacion en la base de datos: ${(err as Error).message}`);
      this.emit('warning', {
        title: 'Aviso de base de datos',
        message:
          'La grabacion continua, pero no se ha podido registrar en la biblioteca. ' +
          'Los eventos se guardaran junto al video.',
      });
    }

    this.diskGuard.startWatching(folder, settings.recording.stopAtFreeSpaceGb);
    this.startSidecarFlush();
    this.stopping = false;

    log.info(`Grabacion ${id} iniciada para ${adapter.displayName} en ${started.filePath}`);
    this.emit('started', this.current);
    return this.current;
  }

  /** Promesa que se resuelve cuando el video ha empezado de verdad. */
  waitForAnchor(timeoutMs = 10000): Promise<void> {
    if (this.recordingClock.isArmed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.anchoredResolver = null;
        resolve();
      }, timeoutMs);
      this.anchoredResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Detiene la grabacion en curso y consolida todo. */
  async stop(): Promise<RecordingRecord | null> {
    if (!this.active || this.stopping) return null;
    this.stopping = true;

    let result: StopRecordingResult;
    try {
      result = await this.recorder.stop();
    } catch (err) {
      log.error(`Error al detener el grabador: ${(err as Error).message}`);
      result = {
        filePath: this.active.filePath,
        durationMs: null,
        startTimeEpochMs: null,
        hasError: true,
        error: (err as Error).message,
      };
    }

    return this.finalize(result, result.hasError ? 'failed' : 'completed');
  }

  // -------------------------------------------------------------------------

  private async finalize(
    result: StopRecordingResult,
    status: RecordingRecord['status'],
  ): Promise<RecordingRecord | null> {
    // Se corta el sonido en cuanto termina el video, pase lo que pase: aqui
    // desembocan tanto la parada normal como el cierre inesperado del juego.
    await this.audio?.end().catch(() => undefined);

    const active = this.active;
    if (!active) return null;

    this.stopping = true;
    this.stopSidecarFlush();
    this.diskGuard.stopWatching();

    // --- Fase 2 del anclaje: reconciliacion con el inicio real del video ---
    const drift = this.recordingClock.measureWallDriftMs();
    if (drift !== null && Math.abs(drift) > 1000) {
      log.warn(
        `El reloj del sistema se desvio ${drift.toFixed(0)}ms durante la grabacion. ` +
          'Los eventos siguen siendo correctos porque se anclan al reloj monotonico.',
      );
    }

    const reconciliation = this.recordingClock.reconcile(result.startTimeEpochMs);
    if (reconciliation.applied && reconciliation.correctionSec !== 0) {
      this.eventManager.applyClockCorrection(reconciliation.correctionSec);
      try {
        this.db.applyClockCorrection(active.id, reconciliation.correctionSec);
      } catch (err) {
        log.error(`No se pudo reajustar los eventos en la base de datos: ${(err as Error).message}`);
      }
    }

    const events = this.eventManager.end();
    const endedAt = Date.now();

    // La duracion del backend es la fuente preferente; si no la hay, se
    // calcula con el reloj monotonico, que es fiable.
    const durationSec =
      result.durationMs !== null && result.durationMs > 0
        ? result.durationMs / 1000
        : Math.max(0, (endedAt - active.startedAt) / 1000);

    const filePath = result.filePath ?? active.filePath;
    const fileExists = safeExists(filePath);
    const finalStatus: RecordingRecord['status'] = fileExists ? status : 'failed';

    if (!fileExists) {
      log.error(`El fichero de video no existe al finalizar: ${filePath}`);
      this.emit('warning', {
        title: 'La grabacion no se ha guardado',
        message:
          'No se ha encontrado el fichero de video. Los eventos detectados se han ' +
          'conservado, pero no hay imagen asociada.',
      });
    }

    // Sidecar definitivo (el recording.json).
    try {
      SidecarStore.write(
        filePath,
        SidecarStore.build({
          recordingId: active.id,
          game: active.game,
          videoPath: filePath,
          startedAtMs: result.startTimeEpochMs ?? active.startedAt,
          endedAtMs: endedAt,
          durationSec,
          resolution: active.resolution,
          fps: active.fps,
          encoder: active.encoder,
          status: finalStatus,
          events,
        }),
      );
    } catch (err) {
      log.error(`No se pudo escribir el sidecar: ${(err as Error).message}`);
    }

    try {
      this.db.finalizeRecording(active.id, {
        endedAt,
        duration: durationSec,
        status: finalStatus,
        filePath,
      });
    } catch (err) {
      log.error(`No se pudo finalizar la grabacion en la base de datos: ${(err as Error).message}`);
    }

    // Miniatura: si falla, la biblioteca muestra un marcador de posicion.
    if (fileExists) {
      void this.generateThumbnail(active.id, filePath, durationSec, events);
    }

    log.info(
      `Grabacion ${active.id} finalizada: ${durationSec.toFixed(1)}s, ` +
        `${events.length} eventos, estado ${finalStatus}`,
    );

    this.active = null;
    this.stopping = false;
    this.recordingClock.reset();

    const record = this.safeGetRecording(active.id);
    this.emit('stopped', record);
    return record;
  }

  private async generateThumbnail(
    recordingId: string,
    filePath: string,
    durationSec: number,
    events: GameEvent[],
  ): Promise<void> {
    try {
      // Preferimos un instante interesante: la primera kill. Si no hay
      // eventos, un punto temprano pero no el frame 0 (suele ser negro).
      const firstKill = events.find((e) => e.type === 'KILL' && e.videoTime > 1);
      const at = firstKill ? Math.max(0, firstKill.videoTime - 1) : Math.min(10, durationSec * 0.1);
      const thumb = await this.thumbnails.generate(filePath, at);
      if (thumb) {
        this.db.setThumbnail(recordingId, thumb);
        this.emit('thumbnail', { recordingId, path: thumb });
      }
    } catch (err) {
      log.warn(`No se pudo generar la miniatura: ${(err as Error).message}`);
    }
  }

  private safeGetRecording(id: string): RecordingRecord | null {
    try {
      return this.db.getRecording(id);
    } catch (err) {
      log.error(`No se pudo leer la grabacion ${id}: ${(err as Error).message}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------

  private startSidecarFlush(): void {
    this.stopSidecarFlush();
    this.flushTimer = setInterval(() => this.flushSidecar(), SIDECAR_FLUSH_INTERVAL_MS);
  }

  private stopSidecarFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Volcado periodico: el diario que permite recuperar tras un cierre brusco. */
  private flushSidecar(): void {
    const active = this.active;
    if (!active) return;
    SidecarStore.write(
      active.filePath,
      SidecarStore.build({
        recordingId: active.id,
        game: active.game,
        videoPath: active.filePath,
        startedAtMs: active.startedAt,
        durationSec: this.elapsedSeconds,
        resolution: active.resolution,
        fps: active.fps,
        encoder: active.encoder,
        status: 'recording',
        events: this.eventManager.getEvents(),
      }),
    );
  }

  private fail(title: string, message: string): void {
    log.error(`${title}: ${message}`);
    this.emit('warning', { title, message });
  }

  async dispose(): Promise<void> {
    this.stopSidecarFlush();
    if (this.active) {
      try {
        await this.stop();
      } catch {
        /* cierre best-effort */
      }
    }
    this.diskGuard.dispose();
    this.removeAllListeners();
  }
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export { emptySummary };
