import { EventEmitter } from 'node:events';
import {
  AppSettings,
  DetectionState,
  GAME_DISPLAY_NAMES,
  GameKey,
  ProviderState,
} from '../../shared/types';
import { GepProvider, GepGameDetectedInfo } from '../gep/GepProvider';
import { ProcessWatcher, DetectedProcess } from './ProcessWatcher';
import { AdapterRegistry } from '../games/registry';
import { GameAdapter, RawGameEvent } from '../games/GameAdapter';
import { EventManager } from '../events/EventManager';
import { RecordingManager } from '../recording/RecordingManager';
import { SettingsService } from '../services/SettingsService';
import { RiotLiveClientProvider } from '../providers/RiotLiveClientProvider';
import { R6ReplayProvider } from '../providers/r6/R6ReplayProvider';
import { ValorantMatchProvider } from '../providers/valorant/ValorantMatchProvider';
import { createLogger } from '../logging/Logger';

const log = createLogger('GameDetection');

/** Estados de los que GEP no se recupera solo y obligan a usar el respaldo. */
function isTerminal(status: ProviderState['status']): boolean {
  return status === 'unavailable' || status === 'error';
}

/**
 * Espera antes de cortar la grabacion cuando el juego se cierra.
 * Da margen para que lleguen los ultimos eventos (match_end, resultado) y para
 * que el encoder termine de escribir.
 */
const STOP_GRACE_MS = 2500;

export interface DetectionSnapshot {
  state: DetectionState;
  game: GameKey | null;
  gameName: string | null;
  elevationRequired: boolean;
  lastError: string | null;
}

/**
 * Maquina de estados que coordina deteccion, eventos y grabacion.
 *
 *   IDLE ──game-detected──> GAME_DETECTED ──grabacion iniciada──> RECORDING
 *     ^                            │                                  │
 *     │                            └────────── fallo ─────> ERROR     │
 *     └──────────── GAME_ENDED <──────── game-exit ────────────────────┘
 *
 * Dos fuentes de deteccion, con prioridad:
 *   1. GEP (`game-detected`): fiable, trae pid y si el juego corre elevado.
 *   2. ProcessWatcher: respaldo cuando GEP no esta disponible.
 *
 * Si GEP esta operativo, el vigilante de procesos se apaga para no duplicar.
 */
export class GameDetectionService extends EventEmitter {
  private state: DetectionState = DetectionState.IDLE;
  private activeAdapter: GameAdapter | null = null;
  private activePid: number | undefined;
  private activeProcessName: string | undefined;
  private activeIsElevated = false;
  private elevationRequired = false;
  private lastError: string | null = null;
  /** Arranque de grabacion en curso, compartido por todas las detecciones. */
  private beginInFlight: Promise<boolean> | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private gepUsable = false;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly gep: GepProvider,
    private readonly processWatcher: ProcessWatcher,
    private readonly eventManager: EventManager,
    private readonly recordingManager: RecordingManager,
    private readonly settingsService: SettingsService,
    private readonly riot?: RiotLiveClientProvider,
    private readonly r6Replay?: R6ReplayProvider,
    private readonly valorant?: ValorantMatchProvider,
  ) {
    super();
    this.wire();
  }

  getSnapshot(): DetectionSnapshot {
    return {
      state: this.state,
      game: this.activeAdapter?.game ?? null,
      gameName: this.activeAdapter?.displayName ?? null,
      elevationRequired: this.elevationRequired,
      lastError: this.lastError,
    };
  }

  start(): void {
    this.gep.initialize();
    // El vigilante de procesos arranca siempre: si GEP acaba estando
    // disponible, se apaga solo al recibir el primer game-detected de GEP.
    this.processWatcher.start();
    // El sondeo de Riot es barato (una conexion local que falla al instante
    // cuando no hay partida) y no depende de Overwolf en absoluto.
    this.riot?.start();
  }

  /**
   * Decide si los eventos nativos de Riot deben usarse en este momento.
   *
   * Prioridad: GEP manda cuando esta conectado, porque es el proveedor
   * configurado como principal y cubre los tres juegos. La API de Riot entra
   * cuando GEP no esta disponible, que es justo el caso de no tener
   * credenciales de Overwolf. Nunca se alimentan los dos a la vez: se
   * duplicarian las kills.
   */
  private get riotShouldFeed(): boolean {
    return !this.gepUsable;
  }

  // -------------------------------------------------------------------------

  private wire(): void {
    this.gep.on('state', (state: ProviderState) => {
      // Solo consideramos GEP utilizable cuando esta realmente conectado o
      // esperando juego. 'connecting' no basta: si el paquete acaba sin
      // cargarse, apagar el vigilante de procesos nos dejaria sin ninguna
      // deteccion. Es lo que ocurre al ejecutar sin credenciales de Dev Mode.
      const usable = state.status === 'connected' || state.status === 'disconnected';

      if (usable && !this.gepUsable) {
        this.gepUsable = true;
        log.info('GEP operativo: se desactiva el vigilante de procesos de respaldo');
        this.processWatcher.stop();
      } else if (!usable && this.gepUsable && isTerminal(state.status)) {
        // GEP se ha caido o nunca llego a cargarse: recuperamos el respaldo
        // para no quedarnos sin detectar partidas.
        this.gepUsable = false;
        log.warn('GEP no disponible: se reactiva el vigilante de procesos de respaldo');
        this.processWatcher.start();
      }

      if (state.elevationRequired) {
        this.elevationRequired = true;
      }
      this.emit('provider-state', state);
      this.emitChange();
    });

    this.gep.on('game-detected', (info: GepGameDetectedInfo) => {
      const adapter = this.registry.byGepId(info.gepGameId);
      if (!adapter) return;
      this.gepUsable = true;
      this.processWatcher.stop();
      this.activeIsElevated = Boolean(info.isElevated);
      void this.onGameDetected(adapter, info.pid, undefined);
    });

    this.gep.on('elevation-required', () => {
      this.elevationRequired = true;
      this.emitChange();
    });

    this.gep.on('raw', (raw: RawGameEvent) => {
      // Solo aceptamos eventos del juego que estamos grabando.
      const adapter = this.registry.byGepId(raw.gameId);
      if (!adapter || adapter.game !== this.activeAdapter?.game) return;
      this.eventManager.ingest(raw);
    });

    this.gep.on('game-exit', () => void this.onGameExit());

    this.processWatcher.on('game-detected', (found: DetectedProcess) => {
      if (this.gepUsable) return;
      void this.onGameDetected(found.adapter, found.pid, found.processName);
    });

    this.processWatcher.on('game-exit', () => {
      if (this.gepUsable) return;
      void this.onGameExit();
    });

    if (this.riot) {
      this.riot.on('game-detected', () => {
        if (!this.riotShouldFeed) return;
        const adapter = this.registry.get('lol');
        if (!adapter) return;
        log.info('League of Legends detectado por la API local de Riot');
        void this.onGameDetected(adapter, undefined, adapter.processNames[0]);
      });

      this.riot.on('game-exit', () => {
        if (!this.riotShouldFeed) return;
        if (this.activeAdapter?.game !== 'lol') return;
        void this.onGameExit();
      });

      this.riot.on('raw', (raw: RawGameEvent) => {
        if (!this.riotShouldFeed) return;
        if (this.activeAdapter?.game !== 'lol') return;
        this.eventManager.ingest(raw);
      });

      this.riot.on('state', (state: ProviderState) => {
        this.emit('riot-state', state);
        this.emitChange();
      });
    }

    if (this.r6Replay) {
      this.r6Replay.on('raw', (raw: RawGameEvent) => {
        if (this.gepUsable) return;
        if (this.activeAdapter?.game !== 'rainbowsix') return;
        this.eventManager.ingest(raw);
      });

      this.r6Replay.on('state', (state: ProviderState) => {
        this.emit('r6-state', state);
        this.emitChange();
      });
    }

    if (this.valorant) {
      this.valorant.on('raw', (raw: RawGameEvent) => {
        if (this.gepUsable) return;
        if (this.activeAdapter?.game !== 'valorant') return;
        this.eventManager.ingest(raw);
      });

      this.valorant.on('state', (state: ProviderState) => {
        this.emit('valorant-state', state);
        this.emitChange();
      });
    }

    this.recordingManager.on('warning', (warning: { title: string; message: string }) => {
      this.lastError = `${warning.title}: ${warning.message}`;
      this.emit('warning', warning);
      this.emitChange();
    });
  }

  // -------------------------------------------------------------------------

  private async onGameDetected(
    adapter: GameAdapter,
    pid: number | undefined,
    processName: string | undefined,
  ): Promise<void> {
    // Ya estamos con este juego: nada que hacer.
    //
    // Exigir RECORDING no basta. El estado no pasa a RECORDING hasta el final
    // de beginRecording(), y hasta entonces sigue en GAME_DETECTED: una segunda
    // deteccion que llegue durante el arranque atravesaria el filtro. Y llegan,
    // porque hay hasta tres fuentes independientes (GEP, vigilante de procesos
    // y la API local de Riot) que detectan el mismo juego casi a la vez.
    if (
      this.activeAdapter?.game === adapter.game &&
      (this.state === DetectionState.RECORDING || this.state === DetectionState.GAME_DETECTED)
    ) {
      return;
    }

    this.cancelStopTimer();

    const settings = this.settingsService.get();
    if (!settings.games[adapter.game]) {
      log.info(`${adapter.displayName} esta desactivado en la configuracion; se ignora`);
      return;
    }

    this.activeAdapter = adapter;
    this.activePid = pid;
    this.activeProcessName = processName;
    this.lastError = null;
    this.setState(DetectionState.GAME_DETECTED);
    log.info(`${adapter.displayName} detectado`);

    await adapter.start();

    // Rainbow Six sin Overwolf: los eventos vienen de las repeticiones que
    // escribe el propio juego al terminar cada ronda.
    if (adapter.game === 'rainbowsix' && !this.gepUsable && this.r6Replay) {
      this.r6Replay.start(Date.now(), { roundOffsetMs: settings.events.r6RoundOffsetMs });
    }

    // VALORANT sin Overwolf: el historial personal de partidas de Riot, que se
    // consulta al terminar cada partida.
    if (adapter.game === 'valorant' && !this.gepUsable && this.valorant) {
      this.valorant.start(Date.now());
    }

    if (!settings.recording.autoRecord) {
      log.info('La grabacion automatica esta desactivada; se espera accion manual');
      return;
    }

    await this.beginRecording();
  }

  /**
   * Arranca la grabacion para el juego activo.
   *
   * Las llamadas concurrentes comparten el mismo arranque en lugar de iniciar
   * uno cada una: se memoriza la promesa, no el resultado.
   */
  async beginRecording(): Promise<boolean> {
    if (this.beginInFlight) return this.beginInFlight;
    const run = this.runBeginRecording();
    this.beginInFlight = run;
    try {
      return await run;
    } finally {
      this.beginInFlight = null;
    }
  }

  private async runBeginRecording(): Promise<boolean> {
    if (!this.activeAdapter) {
      this.lastError = 'No hay ningun juego detectado que grabar.';
      this.emitChange();
      return false;
    }
    if (this.recordingManager.isRecording) return true;

    const settings = this.settingsService.get();
    const started = await this.recordingManager.start({
      adapter: this.activeAdapter,
      settings,
      gamePid: this.activePid,
      gameProcessName: this.activeProcessName ?? this.activeAdapter.processNames[0],
      gameIsElevated: this.activeIsElevated,
    });

    if (!started) {
      this.setState(DetectionState.ERROR);
      return false;
    }

    this.setState(DetectionState.RECORDING);
    return true;
  }

  /** Detiene la grabacion manualmente. */
  async endRecording(): Promise<void> {
    if (!this.recordingManager.isRecording) return;
    await this.recordingManager.stop();
    this.setState(
      this.activeAdapter ? DetectionState.GAME_DETECTED : DetectionState.IDLE,
    );
  }

  private async onGameExit(): Promise<void> {
    if (!this.activeAdapter) return;
    const adapter = this.activeAdapter;
    log.info(`${adapter.displayName} se ha cerrado`);
    this.setState(DetectionState.GAME_ENDED);

    // Margen para los ultimos eventos antes de cortar.
    this.cancelStopTimer();
    this.stopTimer = setTimeout(() => {
      void this.finishSession(adapter);
    }, STOP_GRACE_MS);
  }

  private async finishSession(adapter: GameAdapter): Promise<void> {
    this.stopTimer = null;
    try {
      // La ultima ronda de Rainbow Six se escribe en disco despues de que el
      // juego cierre, asi que hay que esperarla antes de consolidar el video.
      if (adapter.game === 'rainbowsix' && !this.gepUsable && this.r6Replay) {
        await this.r6Replay.drain();
        this.r6Replay.stop();
      }

      // Lo mismo para VALORANT: la partida aparece en el historial cuando ha
      // terminado, con el juego ya cerrandose.
      if (adapter.game === 'valorant' && !this.gepUsable && this.valorant) {
        await this.valorant.drain();
        this.valorant.stop();
      }

      if (this.recordingManager.isRecording) {
        await this.recordingManager.stop();
      }
      await adapter.stop();
    } catch (err) {
      log.error(`Error al cerrar la sesion: ${(err as Error).message}`);
      this.lastError = (err as Error).message;
    }

    this.activeAdapter = null;
    this.activePid = undefined;
    this.activeProcessName = undefined;
    this.activeIsElevated = false;
    this.setState(DetectionState.IDLE);

    // Si GEP no esta disponible, volvemos a vigilar procesos.
    if (!this.gepUsable) this.processWatcher.start();
  }

  private cancelStopTimer(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private setState(state: DetectionState): void {
    if (this.state === state) return;
    this.state = state;
    log.info(`Estado: ${state}`);
    this.emitChange();
  }

  private emitChange(): void {
    this.emit('changed', this.getSnapshot());
  }

  displayNameFor(game: GameKey): string {
    return GAME_DISPLAY_NAMES[game];
  }

  async dispose(): Promise<void> {
    this.cancelStopTimer();
    this.riot?.dispose();
    this.r6Replay?.dispose();
    this.valorant?.dispose();
    this.processWatcher.dispose();
    this.gep.dispose();
    this.removeAllListeners();
  }
}
