import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ClipRecord } from '../../shared/types';
import { Database } from '../database/Database';
import { ThumbnailService } from './ThumbnailService';
import { resolveFfmpegPath } from '../recording/ffmpegPath';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('Clips');

export interface CreateClipRequest {
  recordingId: string;
  /** Centro del clip, en segundos de video. */
  centerSeconds: number;
  secondsBefore: number;
  secondsAfter: number;
  title?: string;
}

export interface ClipResult {
  ok: boolean;
  clip?: ClipRecord;
  error?: string;
}

/**
 * Extrae clips de una grabacion ya existente.
 *
 * Estrategia en dos pasos:
 *
 *  1. **Copia directa de flujos** (`-c copy`). No recodifica, asi que un clip
 *     de 15 segundos se genera en decimas de segundo y sin perdida de calidad.
 *     El coste es que el corte se alinea al keyframe anterior. Como grabamos
 *     con un keyframe cada 2 segundos, el desfase maximo es de 2 segundos, y
 *     siempre hacia atras, que es el lado inofensivo: se ve algo mas de
 *     contexto antes de la kill, nunca menos.
 *
 *  2. **Recodificacion** si la copia falla o produce un fichero invalido.
 *     Es mas lenta pero da un corte exacto al fotograma.
 *
 * Nunca se vuelve a grabar: siempre se parte del video existente, tal y como
 * pediste.
 */
export class ClipService {
  private readonly db: Database;
  private readonly outputDir: string;
  private readonly thumbnails: ThumbnailService;

  constructor(db: Database, outputDir: string, thumbnails: ThumbnailService) {
    this.db = db;
    this.outputDir = outputDir;
    this.thumbnails = thumbnails;
  }

  async create(request: CreateClipRequest): Promise<ClipResult> {
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) {
      return { ok: false, error: 'FFmpeg no esta disponible, no se pueden crear clips.' };
    }

    const recording = this.db.getRecording(request.recordingId);
    if (!recording) {
      return { ok: false, error: 'No se ha encontrado la grabacion.' };
    }
    if (!existsSync(recording.filePath)) {
      return {
        ok: false,
        error: 'El fichero de video original ya no existe. No se puede crear el clip.',
      };
    }

    const duration = recording.duration ?? Number.MAX_SAFE_INTEGER;
    const start = Math.max(0, request.centerSeconds - request.secondsBefore);
    const end = Math.min(duration, request.centerSeconds + request.secondsAfter);

    if (end - start < 0.5) {
      return { ok: false, error: 'El intervalo del clip es demasiado corto.' };
    }

    try {
      mkdirSync(this.outputDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `No se ha podido crear la carpeta de clips: ${(err as Error).message}`,
      };
    }

    const id = randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = join(this.outputDir, `clip_${recording.game}_${stamp}_${id.slice(0, 8)}.mp4`);
    const length = end - start;

    const copied = await this.tryStreamCopy(ffmpeg, recording.filePath, start, length, outputPath);
    if (!copied) {
      log.info('La copia directa fallo; se recurre a recodificacion');
      const encoded = await this.tryReEncode(ffmpeg, recording.filePath, start, length, outputPath);
      if (!encoded) {
        return { ok: false, error: 'No se ha podido generar el clip. Revisa el registro para mas detalle.' };
      }
    }

    const title =
      request.title ??
      `${recording.game} ${formatTime(request.centerSeconds)}`;

    const thumbnail = await this.thumbnails.generate(outputPath, Math.min(request.secondsBefore, length / 2));

    const clip: ClipRecord = {
      id,
      recordingId: recording.id,
      filePath: outputPath,
      thumbnailPath: thumbnail,
      title,
      startTime: start,
      endTime: end,
      createdAt: Date.now(),
      game: recording.game,
    };

    try {
      this.db.createClip(clip);
    } catch (err) {
      log.error(`No se pudo registrar el clip: ${(err as Error).message}`);
      return { ok: false, error: 'El clip se ha creado pero no se ha podido registrar.' };
    }

    log.info(`Clip creado: ${outputPath} (${length.toFixed(1)}s)`);
    return { ok: true, clip };
  }

  private async tryStreamCopy(
    ffmpeg: string,
    input: string,
    start: number,
    length: number,
    output: string,
  ): Promise<boolean> {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-i', input,
      '-t', length.toFixed(3),
      '-c', 'copy',
      // Evita timestamps negativos que dejarian el clip sin reproducir.
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y',
      output,
    ];
    return this.run(ffmpeg, args, output);
  }

  private async tryReEncode(
    ffmpeg: string,
    input: string,
    start: number,
    length: number,
    output: string,
  ): Promise<boolean> {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', start.toFixed(3),
      '-i', input,
      '-t', length.toFixed(3),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y',
      output,
    ];
    return this.run(ffmpeg, args, output);
  }

  private async run(ffmpeg: string, args: string[], output: string): Promise<boolean> {
    try {
      await execFileAsync(ffmpeg, args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    } catch (err) {
      log.warn(`FFmpeg fallo: ${(err as Error).message}`);
      this.cleanup(output);
      return false;
    }
    if (!existsSync(output) || safeSize(output) < 1024) {
      this.cleanup(output);
      return false;
    }
    return true;
  }

  private cleanup(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignorado */
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

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
