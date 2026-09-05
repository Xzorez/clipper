import { app, BrowserWindow, protocol, shell, session, desktopCapturer } from 'electron';
import { join } from 'node:path';
import { serveLocalFile } from './rangeRequest';
import { AppContext } from './AppContext';
import { AppSettings, DetectionState } from '../shared/types';
import { registerIpcHandlers } from './ipc/handlers';
import { TrayIcon, applyStartWithWindows } from './TrayIcon';
import { loggerRoot, createLogger } from '../core/logging/Logger';

const log = createLogger('Main');

// Instancia unica: dos procesos grabando a la vez se pisarian el encoder,
// los atajos globales y la base de datos.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // `quit()` no es inmediato: el modulo sigue ejecutandose y la instancia
  // sobrante llegaba a abrir la base de datos, registrar los atajos y crear un
  // segundo icono de bandeja antes de morir. Con exit se va en el acto, y de
  // avisar a la instancia buena ya se encarga el evento second-instance.
  app.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;
let tray: TrayIcon | null = null;
/** Distingue cerrar la ventana de salir de verdad. */
let isQuitting = false;

/**
 * Trae la ventana al frente, volviendola a crear si hizo falta.
 *
 * Con la bandeja, la ventana puede estar escondida o no existir; desde fuera
 * se pide "abrir Clipper" sin saber en cual de los dos casos estamos.
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Esquema propio para servir los videos y miniaturas locales.
 *
 * No usamos file:// directamente porque obligaria a desactivar webSecurity en
 * el renderer. Con un protocolo registrado mantenemos el aislamiento activado
 * y solo exponemos las rutas que la aplicacion gestiona.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clipper-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
]);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0d0f14',
    show: false,
    autoHideMenuBar: true,
    title: 'Clipper',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Al arrancar con la sesion se queda en la bandeja: aparecer a pantalla
  // completa en cada inicio de sesion seria insoportable, y lo que se quiere es
  // que vigile, no que se haga notar.
  const arrancaEscondida =
    process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  mainWindow.once('ready-to-show', () => {
    if (!arrancaEscondida) mainWindow?.show();
  });

  // Cerrar la ventana no es salir: la aplicacion tiene que seguir vigilando
  // partidas. Antes, cerrarla mataba el proceso y no se grababa nada mas.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    if (!context?.settings.get().general.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void mainWindow.loadURL(devServer);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname es dist/main/main; el renderer se compila a dist/renderer.
    void mainWindow.loadFile(join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Sirve ficheros locales de forma controlada al renderer.
 *
 * Se atienden las peticiones de rango en lugar de devolver siempre el fichero
 * entero. Sin eso Chromium no puede saltar dentro del video, y saltar al
 * instante exacto de un evento es justo lo que hace esta aplicacion. Con
 * grabaciones de mas de un giga, ademas, mandar el fichero completo para ver
 * un segundo concreto no es una opcion.
 */
function registerMediaProtocol(): void {
  protocol.handle('clipper-media', async (request) => {
    try {
      const url = new URL(request.url);
      // Cuenta solo el pathname. El host ('local') es relleno para que la URL
      // sea valida con un esquema estandar; concatenarlo a la ruta la deja
      // inservible y todo acaba en un 403.
      const filePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

      if (!context?.isPathAllowed(filePath)) {
        log.warn(`Acceso denegado a ${filePath}`);
        return new Response('Forbidden', { status: 403 });
      }

      return serveLocalFile(filePath, request.headers.get('Range'));
    } catch (err) {
      log.error(`Error sirviendo media: ${(err as Error).message}`);
      return new Response('Not found', { status: 404 });
    }
  });
}

/**
 * Permite a la ventana capturar el sonido del sistema.
 *
 * Windows no expone ningun dispositivo con el que FFmpeg pueda grabar lo que
 * suena; solo microfonos. Chromium si sabe hacerlo, pero hay que autorizarlo
 * de forma explicita: `audio: 'loopback'` es lo que le dice que devuelva la
 * mezcla del sistema en lugar de una entrada fisica.
 *
 * Se pide video ademas de audio porque la propia API lo exige. La ventana
 * descarta la pista de video en cuanto la recibe: la imagen la graba FFmpeg,
 * y mantener una segunda captura de pantalla viva mientras se juega solo
 * costaria rendimiento.
 */
function registerAudioCapturePermissions(): void {
  const current = session.defaultSession;

  // Las peticiones vienen de la propia interfaz, que es codigo nuestro y no
  // carga nada de fuera; conceder microfono y captura aqui no abre la puerta a
  // terceros.
  current.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
  current.setPermissionCheckHandler((_contents, permission) =>
    permission === 'media' || permission === 'display-capture',
  );

  current.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (sources.length === 0) {
            log.warn('No hay ninguna pantalla que ofrecer para capturar el sonido');
            callback({});
            return;
          }
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch((err: Error) => {
          log.warn(`No se ha podido preparar la captura de sonido: ${err.message}`);
          callback({});
        });
    },
    // El selector del sistema pediria confirmacion al usuario cada vez; aqui
    // la fuente ya esta decidida y la aplicacion debe arrancar sola.
    { useSystemPicker: false },
  );
}

app.on('second-instance', () => {
  // Abrir la aplicacion otra vez cuando ya esta en la bandeja significa
  // "muestramela", no "arranca otra".
  showMainWindow();
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  loggerRoot.init(join(app.getPath('userData'), 'logs'), 'info');
  log.info(
    `Clipper arrancando | Electron ${process.versions.electron} | ` +
      `Node ${process.versions.node} | ${process.platform}`,
  );

  registerMediaProtocol();
  registerAudioCapturePermissions();

  context = new AppContext();
  await context.initialize();

  registerIpcHandlers(context, () => mainWindow);
  context.attachWindowBridge(() => mainWindow);

  const { general } = context.settings.get();
  applyStartWithWindows(general.startWithWindows, general.startMinimized);
  context.settings.on('changed', (updated: AppSettings) => {
    applyStartWithWindows(updated.general.startWithWindows, updated.general.startMinimized);
  });

  tray = new TrayIcon({
    show: showMainWindow,
    toggleRecording: () => void context?.toggleRecording(),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  tray.create();
  context.onStatus = (status) =>
    tray?.setState(status.state === DetectionState.RECORDING, status.gameName);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Con la bandeja activa la ventana es solo una vista: que no quede ninguna
  // abierta no significa que haya que salir.
  if (context?.settings.get().general.closeToTray) return;
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
  isQuitting = true;
  tray?.destroy();
  event.preventDefault();

  log.info('Cerrando la aplicacion de forma ordenada...');
  void (async () => {
    try {
      await context?.dispose();
    } catch (err) {
      log.error(`Error durante el cierre: ${(err as Error).message}`);
    } finally {
      loggerRoot.close();
      app.exit(0);
    }
  })();
});

// Un fallo no capturado no debe cerrar la aplicacion en mitad de una partida.
process.on('uncaughtException', (err) => {
  log.error(`Excepcion no capturada: ${err.message}\n${err.stack ?? ''}`);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Promesa rechazada sin gestionar: ${String(reason)}`);
});

// Los inicios de sesion se abren fuera; ningun contenido remoto se carga dentro.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer && url.startsWith(devServer)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
  });
});
