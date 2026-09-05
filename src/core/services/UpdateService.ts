import { EventEmitter } from 'node:events';
import { app } from 'electron';
import { createLogger } from '../logging/Logger';
import { UpdateStatus } from '../../shared/types';

export type { UpdateState, UpdateStatus } from '../../shared/types';

const log = createLogger('Update');

/** Cada cuanto se vuelve a mirar si hay version nueva. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Margen tras el arranque, para no competir con la carga inicial. */
const FIRST_CHECK_DELAY_MS = 20_000;

/**
 * Actualizaciones automaticas, en silencio.
 *
 * El comportamiento es deliberadamente invisible: comprueba, descarga en
 * segundo plano y aplica la version nueva al cerrar la aplicacion. No pregunta,
 * no interrumpe y no muestra ningun dialogo. La unica senal es una linea
 * discreta en Ajustes para quien quiera saber en que version esta.
 *
 * Se apaga sola en desarrollo y cuando no hay un destino de publicacion
 * configurado, en lugar de llenar el registro de errores.
 */
export class UpdateService extends EventEmitter {
  private status: UpdateStatus = { state: 'idle', current: '0.0.0' };
  private timer: NodeJS.Timeout | null = null;
  private updater: import('electron-updater').AppUpdater | null = null;

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  get currentVersion(): string {
    try {
      return app.getVersion();
    } catch {
      return '0.0.0';
    }
  }

  /**
   * Arranca la vigilancia. No hace nada si la aplicacion se esta ejecutando sin
   * empaquetar: ahi no hay instalador que reemplazar.
   */
  start(): void {
    if (!app.isPackaged) {
      this.setStatus({ state: 'disabled' });
      log.info('Actualizaciones desactivadas: la aplicacion no esta empaquetada');
      return;
    }

    let autoUpdater: import('electron-updater').AppUpdater;
    try {
      // Carga diferida: en desarrollo no se necesita y evita su coste.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      autoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
    } catch (err) {
      this.setStatus({ state: 'disabled' });
      log.warn(`No se pudo cargar el actualizador: ${(err as Error).message}`);
      return;
    }

    this.updater = autoUpdater;

    // Descarga sola, pero no reinicia por su cuenta: la version nueva entra al
    // cerrar. Interrumpir a alguien en mitad de una partida seria peor que
    // esperar.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }));

    autoUpdater.on('update-available', (info: { version: string }) => {
      log.info(`Version nueva disponible: ${info.version}`);
      this.setStatus({ state: 'downloading', version: info.version, progress: 0 });
    });

    autoUpdater.on('update-not-available', () => {
      this.setStatus({ state: 'unavailable', version: this.currentVersion });
    });

    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      this.setStatus({
        state: 'downloading',
        version: this.status.version,
        progress: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      log.info(`Version ${info.version} lista; se aplicara al cerrar`);
      this.setStatus({ state: 'ready', version: info.version });
    });

    autoUpdater.on('error', (err: Error) => {
      // Un fallo de red o una configuracion incompleta no son motivo para
      // molestar a nadie por su cuenta: se registra y se reintenta en el
      // siguiente ciclo. El estado si queda como error para que quien haya
      // pulsado el boton de comprobar reciba una respuesta y no un silencio.
      log.warn(`Comprobacion de actualizaciones fallida: ${err.message}`);
      this.setStatus({ state: 'error', error: err.message });
    });

    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  async check(): Promise<void> {
    if (!this.updater) return;
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      log.warn(`No se pudo comprobar si hay actualizaciones: ${(err as Error).message}`);
    }
  }

  /**
   * Comprobacion pedida a mano desde los ajustes.
   *
   * A diferencia de la automatica, esta si contesta: quien pulsa un boton
   * espera saber que ha pasado, aunque la respuesta sea que no hay nada nuevo
   * o que no hay conexion.
   */
  async checkNow(): Promise<UpdateStatus> {
    if (!this.updater) return this.getStatus();
    this.setStatus({ state: 'checking' });
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.setStatus({ state: 'error', error: (err as Error).message });
    }
    return this.getStatus();
  }

  /**
   * Aplica ahora una version ya descargada, cerrando la aplicacion.
   *
   * Solo tiene efecto con la descarga terminada; si no, se ignora en lugar de
   * cerrar la aplicacion para nada.
   */
  installNow(): boolean {
    if (!this.updater || this.status.state !== 'ready') return false;
    log.info('Aplicando la actualizacion a peticion del usuario');
    // Fuera del ciclo actual, para que la respuesta llegue a la ventana antes
    // de que la aplicacion se cierre.
    setImmediate(() => {
      try {
        this.updater?.quitAndInstall();
      } catch (err) {
        log.error(`No se pudo aplicar la actualizacion: ${(err as Error).message}`);
      }
    });
    return true;
  }

  private setStatus(status: Omit<UpdateStatus, 'current'>): void {
    this.status = { ...status, current: this.currentVersion };
    this.emit('status', this.getStatus());
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.removeAllListeners();
  }
}
