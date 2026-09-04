import { app, BrowserWindow, protocol, shell } from 'electron';
import { join } from 'node:path';
import { serveLocalFile } from './rangeRequest';
import { AppContext } from './AppContext';
import { registerIpcHandlers } from './ipc/handlers';
import { loggerRoot, createLogger } from '../core/logging/Logger';

const log = createLogger('Main');

// Instancia unica: dos procesos grabando a la vez se pisarian el encoder,
// los atajos globales y la base de datos.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;

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

  mainWindow.once('ready-to-show', () => mainWindow?.show());

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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  loggerRoot.init(join(app.getPath('userData'), 'logs'), 'info');
  log.info(
    `Clipper arrancando | Electron ${process.versions.electron} | ` +
      `Node ${process.versions.node} | ${process.platform}`,
  );

  registerMediaProtocol();

  context = new AppContext();
  await context.initialize();

  registerIpcHandlers(context, () => mainWindow);
  context.attachWindowBridge(() => mainWindow);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let shuttingDown = false;
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  shuttingDown = true;
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
