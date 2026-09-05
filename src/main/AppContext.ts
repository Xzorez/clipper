import { app, BrowserWindow } from 'electron';
import { join, resolve, sep } from 'node:path';
import {
  AppSettings,
  DetectionState,
  GAME_DISPLAY_NAMES,
  GameEvent,
  LiveStatus,
  ProviderState,
  RecorderCapabilities,
  UpdateStatus,
  emptyRecorderCapabilities,
} from '../shared/types';
import { IPC } from '../shared/channels';
import { Database } from '../core/database/Database';
import { SettingsService } from '../core/services/SettingsService';
import { ThumbnailService } from '../core/services/ThumbnailService';
import { ClipService } from '../core/services/ClipService';
import { HotkeyService, HotkeyAction } from '../core/services/HotkeyService';
import { RecoveryService } from '../core/services/RecoveryService';
import { UpdateService } from '../core/services/UpdateService';
import { AudioBridge } from './AudioBridge';
import { HighlightService } from '../core/services/HighlightService';
import { AdapterRegistry } from '../core/games/registry';
import { GepProvider } from '../core/gep/GepProvider';
import { RiotLiveClientProvider } from '../core/providers/RiotLiveClientProvider';
import { R6ReplayProvider } from '../core/providers/r6/R6ReplayProvider';
import { ValorantMatchProvider } from '../core/providers/valorant/ValorantMatchProvider';
import { ProcessWatcher } from '../core/detection/ProcessWatcher';
import { GenericGameDetector } from '../core/detection/GenericGameDetector';
import { GameDetectionService } from '../core/detection/GameDetectionService';
import { EventManager, emptySummary } from '../core/events/EventManager';
import { RecordingClock } from '../core/synchronization/RecordingClock';
import { RecordingManager } from '../core/recording/RecordingManager';
import { RecorderProxy } from '../core/recording/RecorderProxy';
import { DiskSpaceGuard } from '../core/recording/DiskSpaceGuard';
import { createLogger, loggerRoot } from '../core/logging/Logger';

const log = createLogger('Main');

type WindowGetter = () => BrowserWindow | null;

/**
 * Raiz de composicion: crea y conecta todos los subsistemas.
 *
 * Todo el cableado vive aqui para que cada servicio pueda construirse en los
 * tests con dependencias falsas, sin arrastrar Electron.
 */
export class AppContext {
  settings!: SettingsService;
  db!: Database;
  thumbnails!: ThumbnailService;
  clips!: ClipService;
  hotkeys!: HotkeyService;
  recovery!: RecoveryService;
  updates!: UpdateService;
  registry!: AdapterRegistry;
  gep!: GepProvider;
  riot!: RiotLiveClientProvider;
  r6Replay!: R6ReplayProvider;
  valorant!: ValorantMatchProvider;
  processWatcher!: ProcessWatcher;
  eventManager!: EventManager;
  recordingClock!: RecordingClock;
  recorder!: RecorderProxy;
  recordingManager!: RecordingManager;
  detection!: GameDetectionService;

  private getWindow: WindowGetter = () => null;
  private recorderCapabilities: RecorderCapabilities = emptyRecorderCapabilities();
  private providerState: ProviderState = { status: 'unavailable', provider: 'none' };
  private riotState: ProviderState = { status: 'unavailable', provider: 'riot-live-client' };
  private r6State: ProviderState = { status: 'unavailable', provider: 'r6-replay' };
  private valorantState: ProviderState = { status: 'unavailable', provider: 'valorant-match-api' };
  private lastWarning: string | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private diskFreeGb: number | null = null;

  async initialize(): Promise<void> {
    const userData = app.getPath('userData');
    const videos = app.getPath('videos');

    this.settings = new SettingsService(userData, videos);
    const settings = this.settings.get();

    this.db = new Database(join(userData, 'clipper.db'));
    this.thumbnails = new ThumbnailService(join(userData, 'thumbnails'));
    this.clips = new ClipService(
      this.db,
      join(settings.recording.outputFolder, 'clips'),
      this.thumbnails,
    );

    this.registry = new AdapterRegistry();
    this.recordingClock = new RecordingClock();
    this.eventManager = new EventManager({ recordingClock: this.recordingClock });

    this.recorder = new RecorderProxy();
    this.recorder.initialize();

    const diskGuard = new DiskSpaceGuard();
    diskGuard.on('status', (status: { freeGb: number }) => {
      this.diskFreeGb = status.freeGb;
    });

    this.recordingManager = new RecordingManager({
      db: this.db,
      recorder: this.recorder,
      eventManager: this.eventManager,
      recordingClock: this.recordingClock,
      diskGuard,
      thumbnails: this.thumbnails,
      audio: new AudioBridge(() => this.getWindow()),
      highlights: new HighlightService(),
    });

    this.gep = new GepProvider(this.registry);
    this.riot = new RiotLiveClientProvider();
    this.r6Replay = new R6ReplayProvider();
    this.valorant = new ValorantMatchProvider();
    this.processWatcher = new ProcessWatcher(this.registry);
    this.detection = new GameDetectionService(
      this.registry,
      this.gep,
      this.processWatcher,
      this.eventManager,
      this.recordingManager,
      this.settings,
      this.riot,
      this.r6Replay,
      this.valorant,
      new GenericGameDetector(),
    );

    this.hotkeys = new HotkeyService();
    this.recovery = new RecoveryService(this.db, this.thumbnails);
    this.updates = new UpdateService();

    this.wireEvents();

    // Recuperacion de grabaciones que quedaron abiertas por un cierre brusco.
    const report = await this.recovery.run();
    if (report.recovered > 0 || report.discarded > 0) {
      this.notifyWarning(
        'Se han recuperado grabaciones',
        `${report.recovered} grabacion(es) recuperadas tras un cierre inesperado` +
          (report.discarded ? `, ${report.discarded} sin video utilizable.` : '.'),
      );
    }

    this.registerHotkeys(settings);
    this.detection.start();
    // Silenciosa por diseno: descarga sola y se aplica al cerrar.
    this.updates.start();

    // Sondeo de capacidades en segundo plano: no bloquea el arranque.
    void this.refreshRecorderCapabilities();

    this.statusTimer = setInterval(() => this.broadcastStatus(), 1000);
    log.info('Contexto de la aplicacion inicializado');
  }

  attachWindowBridge(getWindow: WindowGetter): void {
    this.getWindow = getWindow;
  }

  // -------------------------------------------------------------------------

  private wireEvents(): void {
    this.gep.on('state', (state: ProviderState) => {
      this.providerState = state;
      this.broadcastStatus();
    });

    this.detection.on('changed', () => this.broadcastStatus());

    this.detection.on('riot-state', (state: ProviderState) => {
      this.riotState = state;
      this.broadcastStatus();
    });

    this.detection.on('valorant-state', (state: ProviderState) => {
      this.valorantState = state;
      this.broadcastStatus();
    });

    this.detection.on('r6-state', (state: ProviderState) => {
      this.r6State = state;
      // Si el usuario no tiene activadas las repeticiones no habra marcadores
      // de Rainbow Six, y conviene decirlo en vez de dejarlo pasar.
      if (state.status === 'unavailable' && state.message) {
        this.notifyWarning('Rainbow Six sin marcadores', state.message);
      }
      this.broadcastStatus();
    });

    this.detection.on('warning', (warning: { title: string; message: string }) => {
      this.notifyWarning(warning.title, warning.message);
    });

    this.recordingManager.on('event', (event: GameEvent) => {
      this.send(IPC.ON_EVENT, event);
    });

    // La ventana refleja lo que hace el actualizador en vez de tener que
    // preguntar: al entrar se ve si hay una descarga en curso.
    this.updates.on('status', (status: UpdateStatus) => {
      this.send(IPC.ON_UPDATE_STATUS, status);
    });

    // Los destacados llegan despues de que la partida se haya guardado; la
    // biblioteca tiene que enterarse para dejar de mostrar cero eventos.
    this.recordingManager.on('events-added', () => {
      this.send(IPC.ON_LIBRARY_CHANGED, null);
    });

    this.recordingManager.on('stopped', () => {
      this.send(IPC.ON_LIBRARY_CHANGED, null);
      this.broadcastStatus();
    });

    this.recordingManager.on('thumbnail', () => {
      this.send(IPC.ON_LIBRARY_CHANGED, null);
    });

    this.recordingManager.on('warning', (warning: { title: string; message: string }) => {
      this.notifyWarning(warning.title, warning.message);
    });

    this.recorder.on('backend-selected', () => {
      void this.refreshRecorderCapabilities();
    });

    this.settings.on('changed', (settings: AppSettings) => {
      this.eventManager.updateSettings(settings.events);
      this.r6Replay.setOptions({ roundOffsetMs: settings.events.r6RoundOffsetMs });
      this.registerHotkeys(settings);
    });

    this.hotkeys.on('hotkey', (action: HotkeyAction) => void this.onHotkey(action));

    loggerRoot.on('entry', (entry) => this.send(IPC.ON_LOG, entry));
  }

  private registerHotkeys(settings: AppSettings): void {
    const result = this.hotkeys.register(settings.hotkeys);
    if (result.failed.length > 0) {
      this.notifyWarning(
        'Algunos atajos no se han podido activar',
        `No se han podido registrar: ${result.failed
          .map((f) => f.accelerator)
          .join(', ')}. Es probable que otra aplicacion los este usando.`,
      );
    }
  }

  private async onHotkey(action: HotkeyAction): Promise<void> {
    try {
      switch (action) {
        case 'toggleRecording':
          if (this.recordingManager.isRecording) {
            await this.detection.endRecording();
          } else {
            await this.detection.beginRecording();
          }
          break;

        case 'bookmark': {
          const marker = this.eventManager.addBookmark('Marcador manual');
          if (marker) {
            log.info(`Marcador anadido en ${marker.videoTime.toFixed(2)}s`);
          } else {
            this.notifyWarning(
              'No hay ninguna grabacion activa',
              'El marcador solo se puede anadir mientras se esta grabando.',
            );
          }
          break;
        }

        case 'saveClip': {
          const active = this.recordingManager.current;
          if (!active) {
            this.notifyWarning(
              'No hay ninguna grabacion activa',
              'Los clips instantaneos requieren una grabacion en curso.',
            );
            break;
          }
          // Se registra un marcador ahora; el clip se extraera al terminar la
          // grabacion, porque el MP4 todavia se esta escribiendo.
          const marker = this.eventManager.addBookmark('Clip solicitado');
          this.notifyWarning(
            'Momento marcado',
            marker
              ? `Se ha marcado el minuto ${formatTime(marker.videoTime)}. ` +
                'Podras crear el clip desde la grabacion cuando termine la partida.'
              : 'No se ha podido marcar el momento.',
          );
          break;
        }
      }
    } catch (err) {
      log.error(`Error al procesar el atajo ${action}: ${(err as Error).message}`);
    }
  }

  async refreshRecorderCapabilities(): Promise<RecorderCapabilities> {
    try {
      this.recorderCapabilities = await this.recorder.probe();
    } catch (err) {
      log.error(`No se pudo sondear el grabador: ${(err as Error).message}`);
      this.recorderCapabilities = {
        status: 'unavailable',
        available: false,
        backend: 'none',
        encoders: [],
        monitors: [],
        message: (err as Error).message,
      };
    }
    this.broadcastStatus();
    return this.recorderCapabilities;
  }

  getRecorderCapabilities(): RecorderCapabilities {
    return this.recorderCapabilities;
  }

  // -------------------------------------------------------------------------

  buildStatus(): LiveStatus {
    const snapshot = this.detection.getSnapshot();
    const active = this.recordingManager.current;
    return {
      state: snapshot.state,
      game: snapshot.game,
      gameName: snapshot.game ? GAME_DISPLAY_NAMES[snapshot.game] : null,
      recordingId: active?.id ?? null,
      elapsed: this.recordingManager.elapsedSeconds,
      summary: this.recordingManager.isRecording
        ? this.recordingManager.getSummary()
        : emptySummary(),
      provider: this.effectiveProvider(),
      recorder: this.recorderCapabilities,
      lastError: snapshot.lastError ?? this.lastWarning,
      diskFreeGb: this.diskFreeGb,
    };
  }

  /**
   * Devuelve el proveedor de eventos que realmente esta sirviendo datos.
   *
   * GEP tiene prioridad cuando funciona. Si no esta disponible (lo habitual sin
   * credenciales de Overwolf) pero la API local de Riot si, se informa de esa,
   * porque es la que esta marcando los eventos de League of Legends. Asi la
   * interfaz nunca dice "sin eventos" mientras en realidad los hay.
   */
  private effectiveProvider(): ProviderState {
    const gepWorks =
      this.providerState.status === 'connected' || this.providerState.status === 'disconnected';
    if (gepWorks) return this.providerState;
    // Solo se antepone un proveedor nativo cuando esta sirviendo datos de
    // verdad. Si solo esta "esperando partida" hay que seguir mostrando el
    // estado de GEP, porque es el que explica que juegos se quedan sin
    // marcadores.
    if (this.riotState.status === 'connected') return this.riotState;
    if (this.r6State.status === 'connected') return this.r6State;
    if (this.valorantState.status === 'connected') return this.valorantState;
    return this.providerState;
  }

  /**
   * Aviso de cambio de estado para quien no vive dentro de la ventana.
   *
   * La bandeja tiene que poder decir si se esta grabando aunque la ventana
   * este cerrada, que es justo cuando la ventana no puede contarselo.
   */
  onStatus: ((status: LiveStatus) => void) | null = null;

  private broadcastStatus(): void {
    const status = this.buildStatus();
    this.send(IPC.ON_STATUS, status);
    this.onStatus?.(status);
  }

  /** Empieza o detiene la grabacion, segun lo que haya ahora mismo. */
  async toggleRecording(): Promise<void> {
    if (this.recordingManager.isRecording) {
      await this.detection.endRecording();
    } else {
      await this.detection.beginRecording();
    }
  }

  notifyWarning(title: string, message: string): void {
    this.lastWarning = `${title}: ${message}`;
    log.warn(`${title} - ${message}`);
    this.send(IPC.ON_WARNING, { title, message });
  }

  private send(channel: string, payload: unknown): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch {
      /* la ventana puede estar cerrandose */
    }
  }

  /**
   * Comprueba que una ruta pertenece a las carpetas que la aplicacion gestiona.
   * Evita que el renderer pueda pedir cualquier fichero del disco a traves del
   * protocolo clipper-media.
   */
  isPathAllowed(filePath: string): boolean {
    try {
      const target = resolve(filePath);
      const settings = this.settings.get();
      const allowed = [
        resolve(settings.recording.outputFolder),
        resolve(join(app.getPath('userData'), 'thumbnails')),
      ];
      return allowed.some(
        (root) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep),
      );
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.hotkeys?.dispose();
    this.updates?.dispose();
    await this.detection?.dispose();
    await this.recordingManager?.dispose();
    this.recorder?.dispose();
    this.db?.close();
    log.info('Contexto liberado');
  }
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export { DetectionState };
