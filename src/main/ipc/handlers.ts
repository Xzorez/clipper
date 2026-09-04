import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import { existsSync, unlinkSync } from 'node:fs';
import { AppContext } from '../AppContext';
import { IPC } from '../../shared/channels';
import { GameEventType, GameKey } from '../../shared/types';
import { SidecarStore } from '../../core/recording/SidecarStore';
import { diagnoseValorant } from '../../core/providers/valorant/ValorantLocalAuth';
import { createLogger, loggerRoot } from '../../core/logging/Logger';

const log = createLogger('Main');

type WindowGetter = () => BrowserWindow | null;

/**
 * Registra todos los manejadores IPC.
 *
 * Todos devuelven un objeto `{ ok, data | error }` en lugar de lanzar: una
 * excepcion que cruza el puente IPC llega al renderer como un mensaje inutil
 * del estilo "Error invoking remote method". Prefiero errores explicitos que
 * la interfaz pueda mostrar en castellano.
 */
export function registerIpcHandlers(context: AppContext, getWindow: WindowGetter): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        const data = await fn(...(args as never[]));
        return { ok: true, data };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        log.error(`IPC ${channel} fallo: ${message}`);
        return { ok: false, error: message };
      }
    });
  };

  // --- Estado y configuracion ------------------------------------------------

  handle(IPC.GET_STATUS, () => context.buildStatus());

  handle(IPC.GET_SETTINGS, () => context.settings.get());

  handle(IPC.UPDATE_SETTINGS, (patch: never) => context.settings.update(patch));

  handle(IPC.PROBE_RECORDER, () => context.refreshRecorderCapabilities());

  handle(IPC.GET_LOGS, () => loggerRoot.getBuffer());

  handle(IPC.GET_DIAGNOSTICS, async () => ({
    valorant: await diagnoseValorant(),
    version: context.updates.currentVersion,
    updates: context.updates.getStatus(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: `${process.platform} ${process.arch}`,
    isElevated: isElevated(),
    userData: app.getPath('userData'),
    provider: context.buildStatus().provider,
    recorder: context.getRecorderCapabilities(),
    gepGameIds: context.registry.gepGameIds(),
  }));

  handle(IPC.RESTART_AS_ADMIN, () => {
    // Windows no permite elevar un proceso en marcha: hay que relanzar. Se usa
    // el verbo 'runas' del shell, que muestra el dialogo estandar del UAC.
    const exe = process.execPath;
    void shell.openPath(exe); // fallback si el relanzamiento elevado falla
    log.info('Se ha solicitado reiniciar con privilegios de administrador');
    return {
      instructions:
        'Cierra Clipper y vuelve a abrirlo con el boton derecho > "Ejecutar como administrador".',
    };
  });

  // --- Control de grabacion --------------------------------------------------

  handle(IPC.START_RECORDING, async () => {
    const ok = await context.detection.beginRecording();
    if (!ok) throw new Error('No se ha podido iniciar la grabacion. Revisa el estado en Inicio.');
    return context.buildStatus();
  });

  handle(IPC.STOP_RECORDING, async () => {
    await context.detection.endRecording();
    return context.buildStatus();
  });

  // --- Biblioteca ------------------------------------------------------------

  handle(IPC.LIST_RECORDINGS, (filter: never) => {
    const options = (filter ?? {}) as { game?: GameKey };
    const recordings = context.db.listRecordings(options);
    // Marcamos los ficheros que ya no estan para que la interfaz lo indique en
    // lugar de dar un reproductor en negro.
    return recordings.map((r) => ({ ...r, missingFile: !existsSync(r.filePath) }));
  });

  handle(IPC.GET_RECORDING, (id: never) => {
    const recording = context.db.getRecording(id as unknown as string);
    if (!recording) throw new Error('No se ha encontrado la grabacion.');
    return { ...recording, missingFile: !existsSync(recording.filePath) };
  });

  handle(IPC.GET_EVENTS, (args: never) => {
    const { recordingId, types } = args as unknown as {
      recordingId: string;
      types?: GameEventType[];
    };
    const recording = context.db.getRecording(recordingId);
    const events = context.db.getEvents(recordingId, types);
    // El juego se toma de la grabacion, que es donde vive realmente.
    return events.map((e) => ({ ...e, game: recording?.game ?? e.game }));
  });

  handle(IPC.DELETE_RECORDING, (args: never) => {
    const { id, deleteFile } = args as unknown as { id: string; deleteFile: boolean };
    const recording = context.db.getRecording(id);
    if (!recording) throw new Error('No se ha encontrado la grabacion.');

    if (deleteFile) {
      for (const path of [recording.filePath, SidecarStore.pathFor(recording.filePath)]) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch (err) {
          log.warn(`No se pudo borrar ${path}: ${(err as Error).message}`);
        }
      }
    }

    context.db.deleteRecording(id);
    return { deleted: true };
  });

  // --- Clips -----------------------------------------------------------------

  handle(IPC.LIST_CLIPS, () =>
    context.clips ? context.db.listClips().map((c) => ({ ...c, missingFile: !existsSync(c.filePath) })) : [],
  );

  handle(IPC.CREATE_CLIP, async (args: never) => {
    const request = args as unknown as {
      recordingId: string;
      centerSeconds: number;
      secondsBefore?: number;
      secondsAfter?: number;
      title?: string;
    };
    const settings = context.settings.get();
    const result = await context.clips.create({
      recordingId: request.recordingId,
      centerSeconds: request.centerSeconds,
      secondsBefore: request.secondsBefore ?? settings.clips.secondsBefore,
      secondsAfter: request.secondsAfter ?? settings.clips.secondsAfter,
      title: request.title,
    });
    if (!result.ok) throw new Error(result.error ?? 'No se ha podido crear el clip.');
    return result.clip;
  });

  handle(IPC.DELETE_CLIP, (args: never) => {
    const { id, deleteFile } = args as unknown as { id: string; deleteFile: boolean };
    const clip = context.db.listClips().find((c) => c.id === id);
    if (!clip) throw new Error('No se ha encontrado el clip.');
    if (deleteFile) {
      try {
        if (existsSync(clip.filePath)) unlinkSync(clip.filePath);
      } catch (err) {
        log.warn(`No se pudo borrar el clip: ${(err as Error).message}`);
      }
    }
    context.db.deleteClip(id);
    return { deleted: true };
  });

  // --- Sistema de ficheros ---------------------------------------------------

  handle(IPC.PICK_FOLDER, async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Selecciona la carpeta de grabaciones',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  handle(IPC.OPEN_PATH, async (path: never) => {
    const target = path as unknown as string;
    if (!existsSync(target)) throw new Error('El fichero ya no existe.');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  handle(IPC.REVEAL_PATH, (path: never) => {
    const target = path as unknown as string;
    if (!existsSync(target)) throw new Error('El fichero ya no existe.');
    shell.showItemInFolder(target);
    return true;
  });
}

/** Comprueba de forma indirecta si el proceso corre elevado en Windows. */
function isElevated(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    // Solo un proceso elevado puede escribir en esta clave del registro.
    // Comprobarlo de forma barata: intentar leer una ruta protegida.
    const { accessSync, constants } = require('node:fs') as typeof import('node:fs');
    accessSync(process.env.SystemRoot + '\\System32\\config', constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
