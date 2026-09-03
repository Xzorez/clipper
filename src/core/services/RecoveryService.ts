import { existsSync, statSync } from 'node:fs';
import { Database } from '../database/Database';
import { SidecarStore } from '../recording/SidecarStore';
import { ThumbnailService } from './ThumbnailService';
import { GameEvent, RecordingRecord } from '../../shared/types';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recovery');

export interface RecoveryReport {
  recovered: number;
  discarded: number;
  details: Array<{ id: string; outcome: 'recovered' | 'discarded'; reason: string }>;
}

/**
 * Recuperacion tras un cierre inesperado.
 *
 * Escenario: el usuario apaga el PC de golpe, Windows se actualiza a la fuerza,
 * o la aplicacion muere. Al arrancar quedan filas en estado 'recording' que
 * nunca se finalizaron.
 *
 * Que hacemos con cada una:
 *
 *  - Si el video existe y tiene contenido, se recupera. La duracion se estima
 *    a partir del sidecar (que se volcaba cada 15 s) o de la marca temporal del
 *    fichero, y los eventos que faltaran en la base de datos se reimportan del
 *    sidecar. Queda marcada como 'recovered' para que el usuario sepa que la
 *    duracion es aproximada.
 *
 *  - Si el video no existe o esta vacio, se marca como 'failed'. Los eventos se
 *    conservan igualmente: perder el video no deberia borrar la informacion de
 *    la partida.
 */
export class RecoveryService {
  private readonly db: Database;
  private readonly thumbnails: ThumbnailService;

  constructor(db: Database, thumbnails: ThumbnailService) {
    this.db = db;
    this.thumbnails = thumbnails;
  }

  async run(): Promise<RecoveryReport> {
    const report: RecoveryReport = { recovered: 0, discarded: 0, details: [] };

    let orphans: RecordingRecord[];
    try {
      orphans = this.db.findOrphanRecordings();
    } catch (err) {
      log.error(`No se pudo consultar las grabaciones huerfanas: ${(err as Error).message}`);
      return report;
    }

    if (orphans.length === 0) return report;
    log.info(`Se han encontrado ${orphans.length} grabaciones sin finalizar`);

    for (const recording of orphans) {
      try {
        const outcome = await this.recoverOne(recording);
        report.details.push({ id: recording.id, ...outcome });
        if (outcome.outcome === 'recovered') report.recovered++;
        else report.discarded++;
      } catch (err) {
        log.error(`Fallo al recuperar ${recording.id}: ${(err as Error).message}`);
        report.discarded++;
        report.details.push({
          id: recording.id,
          outcome: 'discarded',
          reason: (err as Error).message,
        });
      }
    }

    log.info(`Recuperacion terminada: ${report.recovered} recuperadas, ${report.discarded} descartadas`);
    return report;
  }

  private async recoverOne(
    recording: RecordingRecord,
  ): Promise<{ outcome: 'recovered' | 'discarded'; reason: string }> {
    const sidecar = SidecarStore.read(recording.filePath);

    // Reimportamos los eventos del sidecar que no llegaron a la base de datos.
    if (sidecar && sidecar.events.length > 0) {
      const existing = new Set(
        this.db.getEvents(recording.id).map((e) => e.id),
      );
      const missing: GameEvent[] = sidecar.events
        .filter((e) => !existing.has(e.id))
        .map((e) => ({
          id: e.id,
          game: recording.game,
          type: e.type,
          timestamp: e.timestamp,
          monotonicNs: '0',
          videoTime: e.videoTime,
          metadata: e.metadata,
        }));
      if (missing.length > 0) {
        this.db.insertEvents(recording.id, missing);
        log.info(`Reimportados ${missing.length} eventos de ${recording.id} desde el sidecar`);
      }
    }

    const videoOk = fileHasContent(recording.filePath);
    if (!videoOk) {
      this.db.finalizeRecording(recording.id, {
        endedAt: recording.startedAt,
        duration: 0,
        status: 'failed',
      });
      return {
        outcome: 'discarded',
        reason: 'El fichero de video no existe o esta vacio',
      };
    }

    // Estimacion de la duracion, en orden de fiabilidad decreciente.
    const duration =
      sidecar?.duration ??
      estimateDurationFromFile(recording.filePath, recording.startedAt) ??
      0;

    const endedAt = recording.startedAt + Math.round(duration * 1000);

    this.db.finalizeRecording(recording.id, {
      endedAt,
      duration,
      status: 'recovered',
    });

    if (!recording.thumbnailPath) {
      const thumb = await this.thumbnails.generate(
        recording.filePath,
        Math.min(10, Math.max(1, duration * 0.1)),
      );
      if (thumb) this.db.setThumbnail(recording.id, thumb);
    }

    return {
      outcome: 'recovered',
      reason: `Recuperada con duracion estimada de ${duration.toFixed(0)}s`,
    };
  }
}

function fileHasContent(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 1024;
  } catch {
    return false;
  }
}

/**
 * Estima la duracion con la marca de ultima modificacion del fichero.
 * Es aproximada, y por eso la grabacion queda marcada como 'recovered'.
 */
function estimateDurationFromFile(path: string, startedAt: number): number | null {
  try {
    const stats = statSync(path);
    const seconds = (stats.mtimeMs - startedAt) / 1000;
    return seconds > 0 && seconds < 24 * 3600 ? seconds : null;
  } catch {
    return null;
  }
}
