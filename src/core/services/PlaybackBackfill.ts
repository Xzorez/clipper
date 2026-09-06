import { existsSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Database } from '../database/Database';
import { DiskSpaceGuard } from '../recording/DiskSpaceGuard';
import { isFragmented } from '../recording/Mp4Layout';
import { optimizeForPlayback } from '../recording/Optimizer';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/** Margen sobre el tamano del video: hace falta sitio para la copia temporal. */
const SPACE_MARGIN = 1.15;
/** Descanso entre partidas, para no acaparar el disco al arrancar. */
const PAUSE_BETWEEN_MS = 3000;
/** Por debajo de esto no hay partida que reordenar. */
const MIN_SIZE_BYTES = 256 * 1024;

export interface BackfillReport {
  /** Partidas que se han reordenado y ya se abren al instante. */
  fixed: number;
  /** Partidas que estaban fragmentadas y no se han podido arreglar. */
  failed: number;
  /** Partidas que se han dejado para otro momento (sin sitio, o llego una partida). */
  skipped: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reordena las grabaciones antiguas para que tambien se abran al instante.
 *
 * Las partidas se graban en MP4 fragmentado a proposito, porque asi sobreviven
 * a un cierre brusco, y desde hace poco se reordenan al terminar. Las de antes
 * no: siguen tardando varios segundos en abrirse, y son justo las que mas hay.
 * Esto las pone al dia una a una.
 *
 * Tres reglas, todas por el mismo motivo (esto es un lujo, y un lujo no puede
 * costarle nada a nadie):
 *
 *   - Si hay una partida en marcha, no se toca el disco. Grabar manda.
 *   - Si no hay sitio de sobra para la copia, esa partida se queda para otro
 *     dia. Nunca se llena el disco por adelantar trabajo.
 *   - Si algo falla, se conserva el fichero original. Se abrira despacio, pero
 *     se abrira.
 *
 * Se empieza por las mas recientes, que son las que uno va a abrir.
 */
export class PlaybackBackfill extends EventEmitter {
  private running = false;
  private cancelled = false;

  constructor(
    private readonly db: Database,
    private readonly disk: DiskSpaceGuard,
    /** Dice si hay una grabacion en curso. Mientras la haya, esto no trabaja. */
    private readonly isRecording: () => boolean,
  ) {
    super();
  }

  /** Corta la pasada en curso; lo que quede se hara en otro arranque. */
  cancel(): void {
    this.cancelled = true;
  }

  async run(): Promise<BackfillReport> {
    const report: BackfillReport = { fixed: 0, failed: 0, skipped: 0 };
    if (this.running) return report;
    this.running = true;
    this.cancelled = false;

    try {
      const pending = await this.findPending();
      if (pending.length === 0) return report;

      log.info(`${pending.length} grabacion(es) antiguas por reordenar`);

      for (const filePath of pending) {
        if (this.cancelled) break;
        if (this.isRecording()) {
          // Reordenar mientras se graba seria robarle disco a la partida en
          // curso, que es lo unico que no se puede repetir.
          log.info('Hay una partida grabandose; el reordenado sigue en otro momento');
          report.skipped += pending.length - report.fixed - report.failed - report.skipped;
          break;
        }

        if (!(await this.hasRoomFor(filePath))) {
          report.skipped++;
          continue;
        }

        // Consultar el disco lleva su tiempo, y en ese rato puede haber
        // llegado la orden de parar. Empezar una conversion de dos gigas justo
        // ahora retrasaria el cierre de la aplicacion para nada.
        if (this.cancelled) break;

        if (await optimizeForPlayback(filePath)) {
          report.fixed++;
          this.emit('recording-optimized', filePath);
        } else {
          report.failed++;
        }

        await wait(PAUSE_BETWEEN_MS);
      }

      log.info(
        `Reordenado de grabaciones antiguas terminado: ${report.fixed} arregladas, ` +
          `${report.failed} sin arreglar, ${report.skipped} para otro momento`,
      );
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * Las grabaciones que de verdad hace falta reordenar, de la mas nueva a la
   * mas vieja.
   *
   * Se mira la estructura de cada fichero en lugar de fiarse de la fecha: hay
   * partidas recientes que se quedaron sin reordenar porque el renombrado
   * fallo, y no tendria sentido saltarselas por ser nuevas.
   */
  private async findPending(): Promise<string[]> {
    let recordings;
    try {
      recordings = this.db.listRecordings({ limit: 1000 });
    } catch (err) {
      log.warn(`No se ha podido consultar la biblioteca: ${(err as Error).message}`);
      return [];
    }

    const pending: string[] = [];
    for (const recording of recordings) {
      if (this.cancelled) break;
      if (recording.status !== 'completed') continue;
      if (!recording.filePath || !existsSync(recording.filePath)) continue;

      try {
        if (statSync(recording.filePath).size < MIN_SIZE_BYTES) continue;
      } catch {
        continue;
      }

      if (await isFragmented(recording.filePath)) pending.push(recording.filePath);
    }
    return pending;
  }

  /** True si queda sitio para la copia temporal con margen. */
  private async hasRoomFor(filePath: string): Promise<boolean> {
    let needed = 0;
    try {
      needed = statSync(filePath).size * SPACE_MARGIN;
    } catch {
      return false;
    }

    const status = await this.disk.check(filePath);
    if (!status) return false;

    const freeBytes = status.freeGb * 1024 * 1024 * 1024;
    if (freeBytes >= needed) return true;

    log.info(
      `Sin sitio para reordenar ${filePath} (hacen falta ${Math.round(needed / 1048576)} MB ` +
        `y hay ${Math.round(freeBytes / 1048576)} MB); se deja para otro momento`,
    );
    return false;
  }
}
