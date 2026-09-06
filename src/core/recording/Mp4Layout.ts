import { open } from 'node:fs/promises';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/**
 * Cabecera minima de una caja MP4: 4 bytes de tamano y 4 de tipo.
 */
const HEADER_BYTES = 8;
/** Con tamano 1, los 8 bytes siguientes son el tamano de verdad. */
const LARGE_SIZE_BYTES = 8;
/** Un fichero sano resuelve esto en tres o cuatro cajas. */
const MAX_BOXES = 64;

/**
 * Averigua si una grabacion esta fragmentada.
 *
 * Un MP4 es una lista de cajas, cada una con su tamano y su tipo. Los dos
 * formatos que maneja la aplicacion se distinguen a simple vista en esa lista:
 *
 *   fragmentado   ftyp, moov (vacio), moof, mdat, moof, mdat, ...
 *   reordenado    ftyp, moov (entero), mdat
 *
 * O sea: si hay una caja `moof`, esta fragmentado. Y para saberlo no hace
 * falta leer el fichero, que puede ocupar dos gigas: basta con ir saltando de
 * caja en caja leyendo ocho bytes de cada una. Son tres o cuatro saltos.
 *
 * Ante la duda se responde `false`. Equivocarse por exceso significaria
 * reescribir una grabacion que ya estaba bien, que es trabajo y riesgo a
 * cambio de nada.
 */
export async function isFragmented(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return false;
  }

  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(HEADER_BYTES + LARGE_SIZE_BYTES);
    let offset = 0;
    let seenMoov = false;

    for (let box = 0; box < MAX_BOXES; box++) {
      if (offset + HEADER_BYTES > size) return false;

      const { bytesRead } = await handle.read(header, 0, header.length, offset);
      if (bytesRead < HEADER_BYTES) return false;

      const type = header.toString('latin1', 4, 8);
      if (type === 'moof') return true;
      // El contenido llega antes que el indice de la partida entera: no hay
      // nada mas que mirar, y si ya vimos el indice es que esta reordenado.
      if (type === 'mdat' && seenMoov) return false;
      if (type === 'moov') seenMoov = true;

      let boxSize = header.readUInt32BE(0);
      if (boxSize === 1) {
        if (bytesRead < HEADER_BYTES + LARGE_SIZE_BYTES) return false;
        const large = header.readBigUInt64BE(HEADER_BYTES);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        boxSize = Number(large);
      } else if (boxSize === 0) {
        // La ultima caja, que llega hasta el final del fichero.
        return false;
      }

      if (boxSize < HEADER_BYTES) return false;
      offset += boxSize;
    }

    return false;
  } catch (err) {
    log.debug(`No se ha podido leer la estructura de ${filePath}: ${(err as Error).message}`);
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
