import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { resolveFfmpegPath } from './ffmpegPath';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('Recording');

/** Sufijo del fichero temporal mientras se reordena. */
const TEMP_SUFFIX = '.reordenando.mp4';
/** Margen generoso: 2 GB tardan unos cinco segundos, pero un disco lento mas. */
const TIMEOUT_MS = 15 * 60 * 1000;
/** Por debajo de esto no hay partida que reordenar. */
const MIN_SIZE_BYTES = 256 * 1024;

/**
 * Deja la grabacion lista para abrirse al instante.
 *
 * Se graba en MP4 fragmentado a proposito: asi el fichero sigue siendo legible
 * aunque el proceso muera de golpe, que es lo que salva una partida cuando el
 * juego o el equipo se cierran mal. El precio es que no lleva la duracion
 * escrita en ningun sitio, y para averiguarla hay que recorrerse los
 * fragmentos uno a uno.
 *
 * Eso se nota mucho al abrir. Medido sobre una partida de 2,3 GB:
 *
 *   fragmentado   852 ms y 841 peticiones al fichero
 *   reordenado     22 ms y 1 peticion
 *
 * Reordenarlo es copiar los flujos tal cual, sin recodificar y sin perder
 * calidad, y poner el indice al principio. Cuesta unos cinco segundos por cada
 * dos gigas, una sola vez y con la partida ya terminada.
 *
 * Si algo sale mal se conserva el fichero original: se abrira despacio, pero
 * se abrira.
 */
export async function optimizeForPlayback(filePath: string): Promise<boolean> {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg || !existsSync(filePath)) return false;

  let originalSize = 0;
  try {
    originalSize = statSync(filePath).size;
  } catch {
    return false;
  }
  // Nada que reordenar en algo que no puede ser una partida. Ademas evita
  // lanzar FFmpeg contra ficheros de prueba o contra una grabacion que fallo
  // al primer fotograma.
  if (originalSize < MIN_SIZE_BYTES) return false;

  const temp = filePath + TEMP_SUFFIX;

  try {
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-v', 'error',
        '-i', filePath,
        // Copiar, no recodificar: la calidad es exactamente la misma y el
        // trabajo es solo mover bytes.
        '-c', 'copy',
        // El indice al principio, que es lo que permite abrirlo sin leerlo
        // entero.
        '-movflags', '+faststart',
        '-y',
        temp,
      ],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
  } catch (err) {
    log.warn(`No se ha podido reordenar la grabacion: ${(err as Error).message}`);
    safeRemove(temp);
    return false;
  }

  // Comprobacion antes de sustituir nada: un fichero mucho mas pequeno
  // significa que la copia se quedo a medias, y cambiarlo por el bueno seria
  // perder la partida.
  let newSize = 0;
  try {
    newSize = statSync(temp).size;
  } catch {
    return false;
  }
  if (!isReplacementSound(originalSize, newSize)) {
    log.warn(
      `El reordenado salio incompleto (${newSize} de ${originalSize} bytes); ` +
        'se conserva la grabacion original',
    );
    safeRemove(temp);
    return false;
  }

  if (!(await renameWithRetry(temp, filePath))) {
    await safeRemoveWithRetry(temp);
    return false;
  }

  log.info(`Grabacion reordenada para abrirse al instante (${Math.round(newSize / 1048576)} MB)`);
  return true;
}

/**
 * Borra los temporales que hayan quedado de un cierre a destiempo.
 *
 * Sin esto, un corte de luz en mitad del reordenado dejaria un duplicado de
 * varios gigas ocupando disco para siempre, y nadie sabria de donde salio.
 */
export function cleanLeftovers(folder: string): void {
  try {
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(TEMP_SUFFIX)) continue;
      safeRemove(join(folder, name));
      log.info(`Temporal de reordenado eliminado: ${name}`);
    }
  } catch {
    /* la carpeta puede no existir todavia */
  }
}

function safeRemove(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* si no se puede, se limpiara en el siguiente arranque */
  }
}

/** Errores de Windows que significan "ahora mismo no, prueba en un momento". */
export function isTemporaryLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

const RETRY_ATTEMPTS = 5;
const RETRY_WAIT_MS = 400;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sustituye el fichero original por el reordenado, con reintentos.
 *
 * Windows no deja renombrar por encima de un fichero que alguien tiene
 * abierto, y aqui siempre hay alguien: el propio FFmpeg que acaba de terminar
 * tarda un momento en soltar el descriptor. Rendirse al primer intento
 * significaba dejar la partida sin reordenar, o sea tardando cinco segundos en
 * abrirse en vez de abrirse al instante. Un par de esperas cortas convierten
 * casi todos esos casos en un renombrado normal.
 */
async function renameWithRetry(from: string, to: string): Promise<boolean> {
  let last: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      renameSync(from, to);
      if (attempt > 1) log.info(`La grabacion se ha sustituido al intento ${attempt}`);
      return true;
    } catch (err) {
      last = err;
      if (!isTemporaryLock(err)) break;
      if (attempt < RETRY_ATTEMPTS) await wait(RETRY_WAIT_MS);
    }
  }
  log.warn(
    `No se ha podido sustituir la grabacion: ${(last as Error).message}. ` +
      'Se conserva la original, que se abrira mas despacio',
  );
  return false;
}

/** Igual que safeRemove, pero dandole tiempo a Windows a soltar el fichero. */
async function safeRemoveWithRetry(path: string): Promise<void> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      if (existsSync(path)) unlinkSync(path);
      return;
    } catch (err) {
      if (!isTemporaryLock(err) || attempt === RETRY_ATTEMPTS) return;
      await wait(RETRY_WAIT_MS);
    }
  }
}

/**
 * Decide si el fichero reordenado puede sustituir al original.
 *
 * Es la comprobacion que separa "abrir mas rapido" de "perder la partida":
 * copiar los flujos deja un fichero de tamano practicamente identico, asi que
 * cualquier merma seria significa que la copia se quedo a medias. Ante la
 * duda, se conserva el original.
 */
export function isReplacementSound(originalSize: number, newSize: number): boolean {
  if (originalSize <= 0 || newSize <= 0) return false;
  return newSize >= originalSize * 0.9;
}

/** Solo para tests: la carpeta de un fichero. */
export function folderOf(filePath: string): string {
  return dirname(filePath);
}
