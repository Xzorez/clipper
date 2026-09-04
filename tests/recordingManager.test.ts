import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/database/Database';
import { EventManager } from '../src/core/events/EventManager';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';
import { FakeClock } from '../src/core/synchronization/MonotonicClock';
import { RecordingManager } from '../src/core/recording/RecordingManager';
import { DiskSpaceGuard } from '../src/core/recording/DiskSpaceGuard';
import { ThumbnailService } from '../src/core/services/ThumbnailService';
import { SidecarStore } from '../src/core/recording/SidecarStore';
import { ValorantAdapter } from '../src/core/games/ValorantAdapter';
import { AppSettings, GameEventType } from '../src/shared/types';
import { defaultSettings } from '../src/core/services/SettingsService';
import {
  ScreenRecorder,
  StartRecordingRequest,
  StartRecordingResult,
  StopRecordingResult,
} from '../src/core/recording/ScreenRecorder';

/**
 * Grabador falso: permite simular el ciclo completo (arranque, primer frame,
 * parada, parada inesperada, fallo) sin tocar OBS ni FFmpeg.
 */
class FakeRecorder extends EventEmitter implements ScreenRecorder {
  readonly backend = 'overwolf' as const;
  startCalls: StartRecordingRequest[] = [];
  failOnStart = false;
  stopResult: StopRecordingResult | null = null;
  private filePath = '';

  async probe() {
    return {
      status: 'ready' as const,
      available: true,
      backend: this.backend,
      encoders: [],
      monitors: [],
    };
  }

  async isRecording(): Promise<boolean> {
    return this.filePath !== '';
  }

  /** Simula lo que tarda de verdad el sondeo de captura antes del spawn. */
  startDelayMs = 0;

  async start(request: StartRecordingRequest): Promise<StartRecordingResult> {
    this.startCalls.push(request);
    if (this.startDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
    }
    if (this.failOnStart) throw new Error('el codificador no esta disponible');
    this.filePath = request.outputPathWithoutExt + '.mp4';
    return {
      filePath: this.filePath,
      encoder: 'jim_nvenc',
      resolution: '1920x1080',
      fps: 60,
    };
  }

  /** Simula que el encoder ha escrito el primer frame. */
  emitStarted(): void {
    this.emit('backend-started', { filePath: this.filePath });
  }

  /** Simula que el grabador se detiene por su cuenta (el juego se cerro). */
  emitUnexpectedStop(result: Partial<StopRecordingResult> = {}): void {
    this.emit('backend-stopped', {
      filePath: this.filePath,
      durationMs: 60_000,
      startTimeEpochMs: Date.now() - 60_000,
      hasError: false,
      ...result,
    } satisfies StopRecordingResult);
  }

  async stop(): Promise<StopRecordingResult> {
    const result =
      this.stopResult ??
      ({
        filePath: this.filePath,
        durationMs: 60_000,
        startTimeEpochMs: Date.now() - 60_000,
        hasError: false,
      } satisfies StopRecordingResult);
    this.filePath = '';
    return result;
  }

  dispose(): void {
    this.removeAllListeners();
  }
}

class NoopThumbnails extends ThumbnailService {
  async generate(): Promise<string | null> {
    return null;
  }
}

describe('RecordingManager', () => {
  let dir: string;
  let db: Database;
  let recorder: FakeRecorder;
  let clock: FakeClock;
  let recordingClock: RecordingClock;
  let eventManager: EventManager;
  let diskGuard: DiskSpaceGuard;
  let manager: RecordingManager;
  let settings: AppSettings;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-rm-'));
    db = new Database(join(dir, 'test.db'));
    recorder = new FakeRecorder();
    clock = new FakeClock();
    recordingClock = new RecordingClock(clock);
    eventManager = new EventManager({ clock, recordingClock });
    diskGuard = new DiskSpaceGuard();

    manager = new RecordingManager({
      db,
      recorder,
      eventManager,
      recordingClock,
      diskGuard,
      thumbnails: new NoopThumbnails(join(dir, 'thumbs')),
    });

    settings = defaultSettings(dir);
    settings.recording.outputFolder = join(dir, 'recordings');
    settings.recording.minFreeSpaceGb = 0.0001;
    // Se anula la compensacion de latencia para que estos tests midan solo el
    // anclaje y la reconciliacion; la latencia se prueba en eventManager.test.
    settings.events.latencyOffsetMs = { valorant: 0, rainbowsix: 0, lol: 0 };
  });

  afterEach(async () => {
    await manager.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Crea el fichero de video que el grabador falso dice haber escrito. */
  function materializeVideo(): string {
    const path = recorder.startCalls[0].outputPathWithoutExt + '.mp4';
    writeFileSync(path, Buffer.alloc(50_000));
    return path;
  }

  /**
   * Regresion: dos detecciones simultaneas no pueden abrir dos capturas.
   *
   * El mismo juego lo anuncian hasta tres fuentes independientes (GEP, el
   * vigilante de procesos y la API local de Riot) con milisegundos de
   * diferencia. Cuando el guardia era `if (this.active)` sin mas, ambas lo
   * cruzaban durante los segundos que tarda el arranque y acababan lanzando dos
   * FFmpeg contra la misma ruta: el fichero quedaba ilegible y uno de los dos
   * procesos se perdia de vista, siguiendo a grabar indefinidamente.
   */
  it('ignora un segundo arranque lanzado mientras el primero esta en curso', async () => {
    recorder.startDelayMs = 30;
    const adapter = new ValorantAdapter();

    const [first, second] = await Promise.all([
      manager.start({ adapter, settings }),
      manager.start({ adapter, settings }),
    ]);

    expect(recorder.startCalls).toHaveLength(1);
    expect(db.listRecordings()).toHaveLength(1);
    // La segunda llamada no arranca nada nuevo, pero tampoco miente: devuelve
    // la grabacion que ya existe.
    expect(first?.id).toBeDefined();
    expect(second?.id).toBe(first?.id);
  });

  it('da rutas distintas a dos grabaciones consecutivas del mismo segundo', async () => {
    const adapter = new ValorantAdapter();
    await manager.start({ adapter, settings });
    materializeVideo();
    await manager.stop();
    await manager.start({ adapter, settings });

    expect(recorder.startCalls).toHaveLength(2);
    expect(recorder.startCalls[1].outputPathWithoutExt).not.toBe(
      recorder.startCalls[0].outputPathWithoutExt,
    );
  });

  it('inicia una grabacion y la registra en la base de datos', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });

    expect(active).not.toBeNull();
    expect(manager.isRecording).toBe(true);
    expect(db.getRecording(active!.id)?.status).toBe('recording');
    expect(recorder.startCalls).toHaveLength(1);
  });

  it('ancla el reloj cuando el backend confirma el primer frame', async () => {
    await manager.start({ adapter: new ValorantAdapter(), settings });
    expect(recordingClock.isArmed).toBe(false);

    recorder.emitStarted();
    expect(recordingClock.isArmed).toBe(true);
  });

  it('persiste los eventos segun llegan, sin esperar al final', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();

    clock.advanceMs(15_000);
    eventManager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: 1, kind: 'event' });

    // Ya esta en SQLite antes de detener nada.
    expect(db.countEvents(active!.id)).toBe(1);
  });

  it('pasa el pid del juego para capturar el proceso', async () => {
    await manager.start({ adapter: new ValorantAdapter(), settings, gamePid: 4242 });
    expect(recorder.startCalls[0].gamePid).toBe(4242);
  });

  it('marca el juego como elevado para que el grabador cambie de fuente', async () => {
    await manager.start({ adapter: new ValorantAdapter(), settings, gameIsElevated: true });
    expect(recorder.startCalls[0].gameIsElevated).toBe(true);
  });

  it('completa la grabacion escribiendo video, eventos y sidecar', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    const videoPath = materializeVideo();

    clock.advanceMs(20_000);
    eventManager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: 1, kind: 'event' });

    const record = await manager.stop();

    expect(record).not.toBeNull();
    expect(record!.status).toBe('completed');
    expect(manager.isRecording).toBe(false);

    // El recording.json acompana al video.
    const sidecar = SidecarStore.read(videoPath);
    expect(sidecar).not.toBeNull();
    expect(sidecar!.events).toHaveLength(1);
    expect(sidecar!.events[0].type).toBe(GameEventType.KILL);
  });

  it('aplica la reconciliacion del reloj a los eventos ya guardados', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });

    const anchorWall = clock.wallMs();
    recorder.emitStarted();
    materializeVideo();

    clock.advanceMs(30_000);
    eventManager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: 1, kind: 'event' });
    expect(db.getEvents(active!.id)[0].videoTime).toBeCloseTo(30, 2);

    // El backend informa de que el video empezo 500 ms despues de nuestra ancla.
    recorder.stopResult = {
      filePath: recorder.startCalls[0].outputPathWithoutExt + '.mp4',
      durationMs: 30_000,
      startTimeEpochMs: anchorWall + 500,
      hasError: false,
    };

    await manager.stop();

    // El evento se ha desplazado 500 ms hacia atras, tambien en la base de datos.
    expect(db.getEvents(active!.id)[0].videoTime).toBeCloseTo(29.5, 2);
  });

  /**
   * Escenario 12: el juego se cierra de golpe y el backend deja de grabar por
   * su cuenta. La grabacion debe cerrarse sola, sin perder eventos.
   */
  it('cierra la grabacion cuando el backend se detiene por su cuenta', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    materializeVideo();

    clock.advanceMs(10_000);
    eventManager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: 1, kind: 'event' });

    let stopped = false;
    manager.on('stopped', () => {
      stopped = true;
    });

    recorder.emitUnexpectedStop();
    await new Promise((r) => setTimeout(r, 50));

    expect(stopped).toBe(true);
    expect(manager.isRecording).toBe(false);
    expect(db.getRecording(active!.id)!.status).toBe('completed');
    expect(db.countEvents(active!.id)).toBe(1);
  });

  // Escenario 13: el video no llego a escribirse.
  it('marca como fallida la grabacion si el fichero no existe al terminar', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    // No se crea el fichero a proposito.

    const warnings: Array<{ title: string }> = [];
    manager.on('warning', (w) => warnings.push(w));

    await manager.stop();

    expect(db.getRecording(active!.id)!.status).toBe('failed');
    expect(warnings.some((w) => w.title.includes('no se ha guardado'))).toBe(true);
  });

  /**
   * El grabador ya explica la causa concreta cuando la conoce (por ejemplo, la
   * pantalla completa exclusiva). Ese mensaje debe llegar al usuario intacto,
   * sin diluirlo con texto generico.
   */
  it('deja pasar intacto el motivo por el que no se pudo arrancar', async () => {
    recorder.failOnStart = true;
    const warnings: Array<{ title: string; message: string }> = [];
    manager.on('warning', (w) => warnings.push(w));

    const active = await manager.start({ adapter: new ValorantAdapter(), settings });

    expect(active).toBeNull();
    expect(manager.isRecording).toBe(false);
    expect(warnings[0].title).toContain('No se ha podido iniciar');
    expect(warnings[0].message).toBe('el codificador no esta disponible');
  });

  it('se niega a grabar si no hay espacio suficiente', async () => {
    settings.recording.minFreeSpaceGb = 999_999;
    const warnings: Array<{ message: string }> = [];
    manager.on('warning', (w) => warnings.push(w));

    const active = await manager.start({ adapter: new ValorantAdapter(), settings });

    expect(active).toBeNull();
    expect(warnings[0].message).toContain('GB libres');
  });

  it('detiene la grabacion de forma segura si el disco se queda sin espacio', async () => {
    await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    materializeVideo();

    const warnings: Array<{ title: string }> = [];
    manager.on('warning', (w) => warnings.push(w));

    diskGuard.emit('low-space', { freeGb: 0.5, totalGb: 500 });
    await new Promise((r) => setTimeout(r, 80));

    expect(warnings.some((w) => w.title.includes('Espacio en disco'))).toBe(true);
    expect(manager.isRecording).toBe(false);
  });

  it('ignora una segunda peticion de inicio mientras ya se graba', async () => {
    const first = await manager.start({ adapter: new ValorantAdapter(), settings });
    const second = await manager.start({ adapter: new ValorantAdapter(), settings });

    expect(second!.id).toBe(first!.id);
    expect(recorder.startCalls).toHaveLength(1);
  });

  it('stop no hace nada si no se esta grabando', async () => {
    expect(await manager.stop()).toBeNull();
  });

  // Escenario 11: partida sin ningun evento.
  it('completa una grabacion sin eventos', async () => {
    const active = await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    const videoPath = materializeVideo();

    const record = await manager.stop();

    expect(record!.status).toBe('completed');
    expect(db.countEvents(active!.id)).toBe(0);
    const sidecar = SidecarStore.read(videoPath);
    expect(sidecar!.events).toEqual([]);
  });

  it('escribe el sidecar de forma periodica como diario de recuperacion', async () => {
    await manager.start({ adapter: new ValorantAdapter(), settings });
    recorder.emitStarted();
    const videoPath = materializeVideo();

    clock.advanceMs(5000);
    eventManager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: 1, kind: 'event' });

    // Se fuerza el volcado que el temporizador hace cada 15 s.
    (manager as unknown as { flushSidecar(): void }).flushSidecar();

    expect(existsSync(SidecarStore.pathFor(videoPath))).toBe(true);
    const sidecar = SidecarStore.read(videoPath);
    expect(sidecar!.status).toBe('recording');
    expect(sidecar!.events).toHaveLength(1);
  });
});
