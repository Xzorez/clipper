import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveFfmpegPath } from '../recording/ffmpegPath';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('Playback');

/**
 * Genera miniaturas con FFmpeg.
 *
 * Se guardan fuera de la carpeta de grabaciones (en userData) para que borrar
 * un video no deje basura y para no ensuciar la carpeta que ve el usuario.
 */
export class ThumbnailService {
  private readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
      log.warn(`No se pudo crear la carpeta de miniaturas: ${(err as Error).message}`);
    }
  }

  /**
   * Extrae un fotograma en el segundo indicado.
   * Devuelve la ruta del PNG, o null si no se pudo generar.
   */
  async generate(videoPath: string, atSeconds: number, width = 480): Promise<string | null> {
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) return null;
    if (!existsSync(videoPath)) {
      log.warn(`No existe el video para la miniatura: ${videoPath}`);
      return null;
    }

    const hash = createHash('sha1')
      .update(videoPath + ':' + Math.round(atSeconds))
      .digest('hex')
      .slice(0, 16);
    const output = join(this.cacheDir, `${hash}.jpg`);

    if (existsSync(output) && safeSize(output) > 0) return output;

    const seek = Math.max(0, atSeconds).toFixed(3);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      // -ss antes de -i hace busqueda rapida por keyframe: instantaneo incluso
      // en videos de una hora.
      '-ss', seek,
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', '4',
      '-y',
      output,
    ];

    try {
      await execFileAsync(ffmpeg, args, { timeout: 30000 });
      if (existsSync(output) && safeSize(output) > 0) return output;
      log.warn(`FFmpeg no genero miniatura para ${basename(videoPath)}`);
      return null;
    } catch (err) {
      log.warn(`Fallo al generar la miniatura: ${(err as Error).message}`);
      return null;
    }
  }
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
