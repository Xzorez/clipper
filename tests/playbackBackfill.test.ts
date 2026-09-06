import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFragmented } from '../src/core/recording/Mp4Layout';
import { PlaybackBackfill } from '../src/core/services/PlaybackBackfill';

/**
 * Poner al dia las grabaciones de antes.
 *
 * Las partidas se graban en MP4 fragmentado para que sobrevivan a un cierre
 * brusco, y desde hace poco se reordenan al terminar para que se abran al
 * instante. Las anteriores se quedaron fragmentadas y tardan varios segundos
 * en abrirse. Esto las arregla una a una, de fondo, pero solo cuando no
 * estorba: grabar y no llenar el disco van primero.
 */

/** Una caja MP4: cuatro bytes de tamano, cuatro de tipo y el relleno. */
function box(type: string, payloadBytes: number): Buffer {
  const buf = Buffer.alloc(8 + payloadBytes);
  buf.writeUInt32BE(8 + payloadBytes, 0);
  buf.write(type, 4, 'latin1');
  return buf;
}

/** Como escribe FFmpeg una grabacion en curso: indice vacio y fragmentos. */
function fragmentado(bytes = 400_000): Buffer {
  return Buffer.concat([
    box('ftyp', 16),
    box('moov', 200),
    box('moof', 100),
    box('mdat', bytes),
  ]);
}

/** Como queda ya reordenada: el indice entero delante y un solo bloque. */
function reordenado(bytes = 400_000): Buffer {
  return Buffer.concat([box('ftyp', 16), box('moov', 2000), box('mdat', bytes)]);
}

describe('reconocer una grabacion fragmentada', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-mp4-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Escribe un fichero y devuelve su ruta. */
  function escribir(name: string, data: Buffer): string {
    const path = join(dir, name);
    writeFileSync(path, data);
    return path;
  }

  it('reconoce la fragmentada por su caja moof', async () => {
    expect(await isFragmented(escribir('frag.mp4', fragmentado()))).toBe(true);
  });

  it('deja en paz la que ya esta reordenada', async () => {
    // Volver a reescribir una grabacion que ya se abre al instante seria
    // trabajo y riesgo a cambio de nada.
    expect(await isFragmented(escribir('ok.mp4', reordenado()))).toBe(false);
  });

  it('recorre cajas de tamano grande sin perderse', async () => {
    // Con tamano 1, el tamano de verdad va en los ocho bytes siguientes. Es lo
    // que usan los ficheros de mas de cuatro gigas, y leerlo mal seria saltar
    // a un sitio cualquiera del fichero.
    const grande = Buffer.alloc(16 + 300);
    grande.writeUInt32BE(1, 0);
    grande.write('mdat', 4, 'latin1');
    grande.writeBigUInt64BE(BigInt(16 + 300), 8);

    const path = escribir('grande.mp4', Buffer.concat([box('ftyp', 16), grande, box('moof', 50)]));
    expect(await isFragmented(path)).toBe(true);
  });

  it('no se inventa nada con un fichero que no es un MP4', async () => {
    expect(await isFragmented(escribir('basura.mp4', Buffer.alloc(5000, 7)))).toBe(false);
  });

  it('no se inventa nada con un fichero que no existe', async () => {
    expect(await isFragmented(join(dir, 'no-existe.mp4'))).toBe(false);
  });
});

describe('reordenado de las grabaciones antiguas', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-backfill-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Biblioteca de mentira con las grabaciones que se le pasen. */
  function libraryOf(paths: string[]) {
    return {
      listRecordings: () => paths.map((filePath) => ({ status: 'completed', filePath })),
    };
  }

  /** Disco de mentira con el hueco libre que se le diga, en gigas. */
  function diskWith(freeGb: number) {
    return { check: async () => ({ freeGb, totalGb: 500 }) };
  }

  function fragmentedFile(name: string): string {
    const path = join(dir, name);
    writeFileSync(path, fragmentado());
    return path;
  }

  it('no toca el disco mientras se esta grabando una partida', async () => {
    // Reordenar durante una partida seria robarle disco a lo unico que no se
    // puede repetir.
    const backfill = new PlaybackBackfill(
      libraryOf([fragmentedFile('a.mp4')]) as never,
      diskWith(500) as never,
      () => true,
    );

    const report = await backfill.run();
    expect(report.fixed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it('deja para otro momento lo que no cabe en el disco', async () => {
    // Nunca se llena el disco por adelantar trabajo.
    const backfill = new PlaybackBackfill(
      libraryOf([fragmentedFile('b.mp4')]) as never,
      diskWith(0.0001) as never,
      () => false,
    );

    const report = await backfill.run();
    expect(report.skipped).toBe(1);
    expect(report.fixed).toBe(0);
  });

  it('no se mete con las que ya estaban bien', async () => {
    const ok = join(dir, 'c.mp4');
    writeFileSync(ok, reordenado());

    const backfill = new PlaybackBackfill(
      libraryOf([ok]) as never,
      diskWith(500) as never,
      () => false,
    );

    const report = await backfill.run();
    expect(report).toEqual({ fixed: 0, failed: 0, skipped: 0 });
  });

  it('ignora lo que ya no esta en el disco', async () => {
    const backfill = new PlaybackBackfill(
      libraryOf([join(dir, 'borrada.mp4')]) as never,
      diskWith(500) as never,
      () => false,
    );

    expect(await backfill.run()).toEqual({ fixed: 0, failed: 0, skipped: 0 });
  });

  it('se aparta en cuanto se le pide, sin empezar una conversion mas', async () => {
    // Al cerrar la aplicacion no se puede arrancar el reordenado de una partida
    // de dos gigas: lo que quede se hara en el siguiente arranque.
    let backfill: PlaybackBackfill;
    const disco = {
      check: async () => {
        backfill.cancel();
        return { freeGb: 500, totalGb: 500 };
      },
    };

    backfill = new PlaybackBackfill(
      libraryOf([fragmentedFile('d.mp4')]) as never,
      disco as never,
      () => false,
    );

    const report = await backfill.run();
    expect(report).toEqual({ fixed: 0, failed: 0, skipped: 0 });
  });
});
