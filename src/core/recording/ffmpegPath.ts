import { existsSync } from 'node:fs';
import { runtimeRequire } from '../runtimeRequire';
import { join, dirname } from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

let cached: string | null | undefined;

/**
 * Localiza el binario de FFmpeg.
 *
 * Orden de busqueda:
 *  1. Variable de entorno CLIPPER_FFMPEG (escape para usuarios avanzados).
 *  2. El paquete ffmpeg-static, corrigiendo la ruta cuando esta dentro de
 *     app.asar (un ejecutable no se puede lanzar desde dentro del archivo asar,
 *     hay que apuntar a app.asar.unpacked).
 *  3. resources/ffmpeg.exe junto a la aplicacion empaquetada.
 *  4. ffmpeg en el PATH del sistema.
 */
export function resolveFfmpegPath(): string | null {
  if (cached !== undefined) return cached;
  cached = detect();
  if (cached) log.info(`FFmpeg localizado en ${cached}`);
  else log.warn('No se ha encontrado FFmpeg');
  return cached;
}

function detect(): string | null {
  const fromEnv = process.env.CLIPPER_FFMPEG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  try {
    // El require se resuelve en tiempo de ejecucion para que este modulo
    // funcione tanto en el bundle CommonJS del proceso principal como bajo un
    // cargador ESM (los tests).
    const staticPath: string = runtimeRequire()('ffmpeg-static');
    if (staticPath) {
      const unpacked = staticPath.replace('app.asar', 'app.asar.unpacked');
      if (existsSync(unpacked)) return unpacked;
      if (existsSync(staticPath)) return staticPath;
    }
  } catch {
    /* ffmpeg-static no instalado: seguimos buscando */
  }

  try {
    const resourcesCandidates = [
      join(process.resourcesPath ?? '', 'ffmpeg.exe'),
      join(dirname(app.getPath('exe')), 'resources', 'ffmpeg.exe'),
    ];
    for (const candidate of resourcesCandidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  } catch {
    /* app puede no estar lista en tests */
  }

  // Ultimo recurso: confiar en el PATH.
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** Solo para tests. */
export function resetFfmpegPathCache(): void {
  cached = undefined;
}
