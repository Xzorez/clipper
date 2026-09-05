import { app, Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { createLogger } from '../core/logging/Logger';

const log = createLogger('Main');

export interface TrayActions {
  /** Trae la ventana al frente, creandola si hizo falta cerrarla. */
  show: () => void;
  /** Empieza o detiene la grabacion, segun el estado actual. */
  toggleRecording: () => void;
  /** Sale de verdad, con el cierre ordenado. */
  quit: () => void;
}

/**
 * Icono de la bandeja del sistema.
 *
 * Es lo que permite que la aplicacion siga trabajando con la ventana cerrada.
 * Antes, cerrar la ventana mataba el proceso entero: quien cerraba la ventana
 * despues de ver una partida se quedaba sin grabar la siguiente, y quien
 * reiniciaba el ordenador se quedaba sin grabar nada hasta que se acordaba de
 * abrirla a mano. Un grabador que solo funciona mientras lo miras no sirve.
 *
 * El menu tambien dice si esta grabando y que juego, porque desde fuera no hay
 * otra forma de saberlo sin abrir la ventana.
 */
export class TrayIcon {
  private tray: Tray | null = null;
  private recording = false;
  private gameName: string | null = null;

  constructor(private readonly actions: TrayActions) {}

  create(): void {
    if (this.tray) return;

    // Vale tanto en desarrollo como empaquetado: getAppPath apunta a la raiz
    // del proyecto en el primero y al asar en el segundo, y el icono va dentro
    // de los ficheros empaquetados.
    const image = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.ico'));
    if (image.isEmpty()) {
      log.warn('No se ha podido cargar el icono de la bandeja');
    }

    this.tray = new Tray(image);
    // Doble clic es lo que espera la gente en Windows; el simple tambien, para
    // no obligar a acertar dos veces.
    this.tray.on('click', () => this.actions.show());
    this.tray.on('double-click', () => this.actions.show());
    this.refresh();
    log.info('Icono de bandeja creado');
  }

  /** Actualiza lo que se ve al pasar el raton y en el menu. */
  setState(recording: boolean, gameName: string | null): void {
    if (recording === this.recording && gameName === this.gameName) return;
    this.recording = recording;
    this.gameName = gameName;
    this.refresh();
  }

  private refresh(): void {
    if (!this.tray) return;

    const estado = this.recording
      ? `Grabando${this.gameName ? ` ${this.gameName}` : ''}`
      : 'En espera';

    this.tray.setToolTip(`Clipper - ${estado}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Clipper - ${estado}`, enabled: false },
        { type: 'separator' },
        { label: 'Abrir', click: () => this.actions.show() },
        {
          label: this.recording ? 'Detener grabacion' : 'Grabar ahora',
          click: () => this.actions.toggleRecording(),
        },
        { type: 'separator' },
        { label: 'Salir', click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

/**
 * Pone o quita la aplicacion del arranque de Windows.
 *
 * Se abre escondida en la bandeja: aparecer a pantalla completa en cada inicio
 * de sesion seria insoportable, y lo que se quiere es que este vigilando, no
 * que se haga notar.
 */
export function applyStartWithWindows(enabled: boolean, startMinimized: boolean): void {
  // En desarrollo apuntaria al ejecutable de Electron, no a la aplicacion, y
  // dejaria una entrada de arranque rota en el sistema de quien programa.
  if (!app.isPackaged) return;

  try {
    const current = app.getLoginItemSettings();
    if (current.openAtLogin === enabled) return;
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: startMinimized,
      args: startMinimized ? ['--hidden'] : [],
    });
    log.info(`Arranque con Windows ${enabled ? 'activado' : 'desactivado'}`);
  } catch (err) {
    // No es motivo para impedir que la aplicacion funcione: como mucho, habra
    // que abrirla a mano.
    log.warn(`No se ha podido cambiar el arranque con Windows: ${(err as Error).message}`);
  }
}
