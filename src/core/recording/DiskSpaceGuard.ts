import { EventEmitter } from 'node:events';
import { statfs } from 'node:fs/promises';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

const BYTES_PER_GB = 1024 ** 3;
const CHECK_INTERVAL_MS = 20_000;

export interface DiskStatus {
  freeGb: number;
  totalGb: number;
}

/**
 * Vigilante de espacio en disco.
 *
 * Dos funciones:
 *  1. Antes de grabar: comprobar que hay margen suficiente y negarse con un
 *     mensaje util si no lo hay.
 *  2. Durante la grabacion: si el espacio baja del umbral critico, avisar para
 *     que la grabacion se detenga de forma ORDENADA. Es la diferencia entre
 *     terminar con un MP4 valido y sus eventos guardados, o con un fichero
 *     corrupto porque el disco se lleno a mitad de escritura.
 *
 * Emite 'low-space' con el estado cuando se cruza el umbral critico.
 */
export class DiskSpaceGuard extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private watchedPath: string | null = null;
  private threshold = 2;
  private warned = false;

  /** Consulta puntual del espacio libre. Devuelve null si no se puede leer. */
  async check(path: string): Promise<DiskStatus | null> {
    try {
      const stats = await statfs(path);
      const blockSize = Number(stats.bsize);
      const freeGb = (Number(stats.bavail) * blockSize) / BYTES_PER_GB;
      const totalGb = (Number(stats.blocks) * blockSize) / BYTES_PER_GB;
      return { freeGb, totalGb };
    } catch (err) {
      log.warn(`No se pudo consultar el espacio en disco de ${path}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Comprueba si hay espacio para empezar.
   * Devuelve un mensaje de error legible, o null si todo esta bien.
   */
  async ensureSpaceForRecording(path: string, minFreeGb: number): Promise<string | null> {
    const status = await this.check(path);
    if (!status) {
      // No poder leer el espacio no debe impedir grabar: solo lo registramos.
      return null;
    }
    if (status.freeGb < minFreeGb) {
      return (
        `No se ha podido iniciar la captura: quedan ${status.freeGb.toFixed(1)} GB libres y ` +
        `se necesitan al menos ${minFreeGb} GB. Libera espacio o cambia la carpeta de grabaciones.`
      );
    }
    return null;
  }

  /** Empieza a vigilar durante una grabacion. */
  startWatching(path: string, stopThresholdGb: number): void {
    this.stopWatching();
    this.watchedPath = path;
    this.threshold = stopThresholdGb;
    this.warned = false;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (!this.watchedPath) return;
    const status = await this.check(this.watchedPath);
    if (!status) return;

    this.emit('status', status);

    if (status.freeGb < this.threshold && !this.warned) {
      this.warned = true;
      log.error(
        `Espacio critico: ${status.freeGb.toFixed(2)} GB libres ` +
          `(umbral ${this.threshold} GB). Se detendra la grabacion.`,
      );
      this.emit('low-space', status);
    }
  }

  stopWatching(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watchedPath = null;
    this.warned = false;
  }

  dispose(): void {
    this.stopWatching();
    this.removeAllListeners();
  }
}
