import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { ProviderState } from '../../shared/types';
import { RawGameEvent } from '../games/GameAdapter';
import { AdapterRegistry } from '../games/registry';
import { createLogger } from '../logging/Logger';

const log = createLogger('GEP');

/**
 * Forma del payload que entrega GEP en `new-game-event` y `new-info-update`.
 * Corresponde a `gep.GameEvent` / `gep.InfoUpdate` del paquete oficial, pero se
 * declara aqui para no depender de un namespace global que solo existe cuando
 * los tipos de ow-electron estan cargados: asi el nucleo compila y se puede
 * testear sin el fork de Electron.
 */
interface GepPayload {
  gameId?: number;
  feature?: string;
  key?: string;
  value?: unknown;
  category?: string;
}

/**
 * Reintentos de setRequiredFeatures.
 *
 * La documentacion oficial es explicita al respecto:
 * "This call may fail, even if the game was already started, and it should be
 *  retried several times until it succeeds."
 * Ademas avisa de que cuanto mas se tarde en registrar GEP tras arrancar el
 * juego, mayor es la probabilidad de perder datos. Por eso reintentamos rapido
 * y con backoff corto.
 */
const FEATURE_RETRY_DELAYS_MS = [0, 500, 1000, 2000, 3000, 5000, 8000];

export interface GepGameDetectedInfo {
  gepGameId: number;
  name: string;
  pid?: number;
  isElevated?: boolean;
}

/**
 * Envoltura sobre `app.overwolf.packages.gep`.
 *
 * Overwolf GEP no existe como SDK independiente: solo esta disponible dentro
 * del ecosistema de Overwolf, es decir, en una app Overwolf (.opk) o en
 * ow-electron. Este proveedor asume ow-electron y degrada de forma explicita
 * cuando el paquete no esta cargado, que es lo que ocurre si se ejecuta con
 * Electron estandar o sin credenciales de Dev Mode.
 *
 * Eventos emitidos hacia arriba:
 *   'state'         -> ProviderState (para pintar el estado en la UI)
 *   'game-detected' -> GepGameDetectedInfo
 *   'game-exit'     -> gepGameId
 *   'raw'           -> RawGameEvent (evento o info ya etiquetado)
 */
export class GepProvider extends EventEmitter {
  private gepApi: overwolf.packages.OverwolfPackageManager['gep'] | null = null;
  private state: ProviderState = { status: 'unavailable', provider: 'gep' };
  private activeGameId = 0;
  private readonly registry: AdapterRegistry;
  private retryTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(registry: AdapterRegistry) {
    super();
    this.registry = registry;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  /**
   * Engancha el listener de 'ready' del gestor de paquetes.
   * Debe llamarse pronto, antes de que el paquete se cargue.
   */
  initialize(): void {
    const overwolfApp = app as unknown as {
      overwolf?: { packages?: EventEmitter & Record<string, unknown> };
    };

    const packages = overwolfApp.overwolf?.packages;
    if (!packages || typeof packages.on !== 'function') {
      this.setState({
        status: 'unavailable',
        provider: 'gep',
        message:
          'Los paquetes de Overwolf no estan disponibles. Ejecuta la aplicacion con ' +
          'ow-electron para recibir eventos de juego.',
      });
      log.warn('app.overwolf.packages no disponible: se ejecuta sin GEP');
      return;
    }

    this.setState({ status: 'connecting', provider: 'gep', message: 'Esperando al paquete GEP...' });

    packages.on('ready', (_event: unknown, name: string, version: string) => {
      if (name !== 'gep') return;
      log.info(`Paquete GEP listo (version ${version})`);
      this.onPackageReady();
    });

    // Si el paquete falla al cargar, Overwolf emite 'failed-to-initialize'.
    packages.on(
      'failed-to-initialize' as never,
      ((_event: unknown, name: string) => {
        if (name !== 'gep') return;
        this.setState({
          status: 'unavailable',
          provider: 'gep',
          message:
            'El paquete GEP no pudo inicializarse. Comprueba las credenciales de ' +
            'Overwolf Dev Mode (OW_CLI_EMAIL / OW_CLI_API_KEY) o la firma de la aplicacion.',
        });
        log.error('El paquete GEP no pudo inicializarse');
      }) as never,
    );

    // Aviso si tras un tiempo prudencial el paquete nunca llego a estar listo.
    setTimeout(() => {
      if (!this.gepApi && !this.disposed) {
        this.setState({
          status: 'unavailable',
          provider: 'gep',
          message:
            'El paquete GEP no se ha cargado. Sin credenciales de Overwolf Dev Mode los ' +
            'paquetes de juego permanecen inactivos: la grabacion manual funciona, pero no ' +
            'se detectaran kills ni muertes.',
        });
        log.warn('Tiempo de espera agotado para el paquete GEP');
      }
    }, 15000);
  }

  private onPackageReady(): void {
    const overwolfApp = app as unknown as {
      overwolf: { packages: overwolf.packages.OverwolfPackageManager };
    };
    this.gepApi = overwolfApp.overwolf.packages.gep;
    if (!this.gepApi) {
      this.setState({ status: 'error', provider: 'gep', message: 'gep no expuesto por el paquete' });
      return;
    }

    this.registerListeners();
    this.setState({ status: 'disconnected', provider: 'gep', message: 'A la espera de un juego' });
  }

  private registerListeners(): void {
    const gep = this.gepApi;
    if (!gep) return;

    gep.removeAllListeners();

    gep.on('game-detected', (event, gameId, name, ...args) => {
      const adapter = this.registry.byGepId(gameId);
      if (!adapter) {
        // Juego soportado por GEP pero no por nosotros: no lo habilitamos.
        log.debug(`Juego ignorado: ${name} (${gameId})`);
        return;
      }

      const info = (args[0] ?? {}) as { pid?: number; isElevated?: boolean };
      log.info(`Juego detectado: ${name} (${gameId})`);

      try {
        // Sin enable() GEP no envia nada para este juego.
        event.enable();
      } catch (err) {
        log.error(`No se pudo habilitar GEP para ${name}: ${(err as Error).message}`);
        this.setState({
          status: 'error',
          provider: 'gep',
          message: `No se pudo habilitar los eventos de ${name}.`,
        });
        return;
      }

      this.activeGameId = gameId;
      this.setState({ status: 'connecting', provider: 'gep', message: `Conectando con ${name}...` });
      this.emit('game-detected', {
        gepGameId: gameId,
        name,
        pid: info.pid,
        isElevated: info.isElevated,
      } satisfies GepGameDetectedInfo);

      void this.setRequiredFeaturesWithRetry(gameId);
    });

    gep.on('elevated-privileges-required', (_event, gameId, name, pid) => {
      log.warn(`Privilegios elevados requeridos para ${name} (pid ${pid})`);
      this.setState({
        status: 'elevation-required',
        provider: 'gep',
        elevationRequired: true,
        message:
          `${name} se esta ejecutando con privilegios de administrador. ` +
          'Reinicia Clipper como administrador para poder recibir los eventos del juego.',
      });
      this.emit('elevation-required', { gepGameId: gameId, name, pid });
    });

    gep.on('new-game-event', (_event, gameId, data) => {
      this.forward(data as GepPayload, gameId, 'event');
    });

    gep.on('new-info-update', (_event, gameId, data) => {
      this.forward(data as GepPayload, gameId, 'info');
    });

    gep.on('error', (_event, gameId, error, ...args) => {
      log.error(`Error de GEP (juego ${gameId}): ${error}`, ...args);
      // Un error puntual no invalida la sesion: GEP se recupera solo. Solo
      // marcamos error si no habia juego activo.
      if (this.activeGameId === 0) {
        this.setState({ status: 'error', provider: 'gep', message: String(error) });
      }
    });

    gep.on('game-exit', (_event, gameId, gameName) => {
      log.info(`El juego ha terminado: ${gameName} (${gameId})`);
      if (this.activeGameId === gameId) this.activeGameId = 0;
      this.clearRetry();
      this.setState({ status: 'disconnected', provider: 'gep', message: 'A la espera de un juego' });
      this.emit('game-exit', gameId);
    });
  }

  /**
   * Reintenta el registro de features hasta que tenga exito.
   * Ver el comentario de FEATURE_RETRY_DELAYS_MS: la propia documentacion de
   * Overwolf recomienda reintentar.
   */
  private async setRequiredFeaturesWithRetry(gameId: number, attempt = 0): Promise<void> {
    if (this.disposed || !this.gepApi) return;

    const adapter = this.registry.byGepId(gameId);
    const features = adapter?.requiredFeatures() ?? null;

    try {
      // Pasar null equivale a "todas las features soportadas", tal y como hace
      // el ejemplo oficial. Nosotros pedimos las que realmente usamos para
      // reducir el volumen de mensajes.
      await this.gepApi.setRequiredFeatures(gameId, features ?? undefined);
      log.info(
        `Features registradas para el juego ${gameId}: ` +
          `${features ? features.join(', ') : 'todas'}`,
      );
      this.setState({
        status: 'connected',
        provider: 'gep',
        message: adapter ? `Recibiendo eventos de ${adapter.displayName}` : 'Conectado',
      });
      this.emit('features-registered', gameId);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (attempt >= FEATURE_RETRY_DELAYS_MS.length - 1) {
        log.error(`No se pudieron registrar las features tras ${attempt + 1} intentos: ${message}`);
        this.setState({
          status: 'error',
          provider: 'gep',
          message:
            'No se han podido registrar los eventos del juego. La grabacion continua, ' +
            'pero puede que no se marquen kills ni muertes.',
        });
        return;
      }
      const delay = FEATURE_RETRY_DELAYS_MS[attempt + 1];
      log.warn(`setRequiredFeatures fallo (intento ${attempt + 1}): ${message}. Reintentando en ${delay}ms`);
      this.clearRetry();
      this.retryTimer = setTimeout(() => {
        void this.setRequiredFeaturesWithRetry(gameId, attempt + 1);
      }, delay);
    }
  }

  private forward(data: GepPayload, gameId: number, kind: 'event' | 'info'): void {
    if (!data || typeof data !== 'object') return;
    const raw: RawGameEvent = {
      gameId,
      feature: String(data.feature ?? ''),
      key: String(data.key ?? ''),
      value: data.value,
      category: data.category,
      kind,
    };
    // Nota: no se loguea el value. La documentacion de Overwolf pide
    // explicitamente no volcar datos de GEP a los ficheros de log.
    this.emit('raw', raw);
  }

  /** Consulta el estado actual del juego. Util para sembrar contadores. */
  async getInfo(gameId?: number): Promise<unknown | null> {
    const id = gameId ?? this.activeGameId;
    if (!this.gepApi || id === 0) return null;
    try {
      return await this.gepApi.getInfo(id);
    } catch (err) {
      log.warn(`getInfo fallo: ${(err as Error).message}`);
      return null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setState(state: ProviderState): void {
    this.state = state;
    this.emit('state', this.getState());
  }

  dispose(): void {
    this.disposed = true;
    this.clearRetry();
    try {
      this.gepApi?.removeAllListeners();
    } catch {
      /* ignorado */
    }
    this.removeAllListeners();
  }
}
