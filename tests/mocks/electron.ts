/**
 * Doble de Electron para los tests.
 *
 * El nucleo se ha escrito para no depender de Electron salvo en los puntos
 * inevitables (rutas del sistema, atajos globales, pantallas). Este doble cubre
 * esos puntos para que la logica de negocio se pueda probar en Node puro, sin
 * arrancar la aplicacion.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = join(tmpdir(), 'clipper-tests');

export const app = {
  getPath: (name: string) => join(base, name),
  getName: () => 'clipper-test',
  on: () => undefined,
  once: () => undefined,
  whenReady: async () => undefined,
  exit: () => undefined,
};

export const screen = {
  getAllDisplays: () => [
    { id: 1, label: 'Test Display', size: { width: 1920, height: 1080 }, scaleFactor: 1 },
  ],
  getPrimaryDisplay: () => ({
    id: 1,
    label: 'Test Display',
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  }),
};

export const globalShortcut = {
  register: () => true,
  unregister: () => undefined,
  unregisterAll: () => undefined,
};

export const ipcMain = { handle: () => undefined, on: () => undefined };
export const shell = { openPath: async () => '', showItemInFolder: () => undefined };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
export const BrowserWindow = class {};
export const protocol = { registerSchemesAsPrivileged: () => undefined, handle: () => undefined };
export const net = { fetch: async () => new Response('') };

export default { app, screen, globalShortcut, ipcMain, shell, dialog, BrowserWindow, protocol, net };
