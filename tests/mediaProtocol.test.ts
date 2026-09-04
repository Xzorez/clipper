import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, serveLocalFile } from '../src/main/rangeRequest';

/**
 * La reproduccion pasa por un protocolo propio, no por file://. Estas dos
 * cosas son las que la rompen en silencio: extraer mal la ruta de la URL
 * (403 con el fichero intacto en su carpeta) y no responder a los rangos
 * (video que no se puede recorrer).
 */
describe('protocolo de medios', () => {
  describe('ruta extraida de la URL', () => {
    /** Reproduce lo que hace el handler con la URL que construye el preload. */
    function pathFromUrl(filePath: string): string {
      const url = new URL(`clipper-media://local/${encodeURIComponent(filePath)}`);
      return decodeURIComponent(url.pathname).replace(/^\/+/, '');
    }

    it('devuelve la ruta de Windows tal cual', () => {
      const original = String.raw`C:\Users\xzore\Videos\Clipper\lol_2026-09-04T14-31-42-038.mp4`;
      expect(pathFromUrl(original)).toBe(original);
    });

    it('no cuela el host en la ruta', () => {
      // El fallo original: hostname + pathname daba "local/C:\..." y todo
      // terminaba en 403 aunque el fichero estuviera donde debia.
      expect(pathFromUrl(String.raw`C:\Users\x\v.mp4`)).not.toContain('local');
    });

    it('conserva espacios y acentos del nombre', () => {
      const original = String.raw`C:\Users\José\Mis Videos\partida ñ.mp4`;
      expect(pathFromUrl(original)).toBe(original);
    });
  });

  describe('parseRange', () => {
    it('devuelve null cuando no se pide rango', () => {
      expect(parseRange(null, 1000)).toBeNull();
    });

    it('interpreta un rango cerrado', () => {
      expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
    });

    it('completa hasta el final un rango abierto', () => {
      expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    });

    it('interpreta un sufijo como los ultimos bytes', () => {
      expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    });

    it('recorta un final que se pasa del fichero en vez de rechazarlo', () => {
      // Chromium pide el ultimo trozo sin saber donde acaba; rechazarlo
      // cortaria la reproduccion al llegar al final.
      expect(parseRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 });
    });

    it('rechaza un comienzo fuera del fichero', () => {
      expect(parseRange('bytes=1000-', 1000)).toBe('invalid');
    });

    it('rechaza un rango invertido', () => {
      expect(parseRange('bytes=500-100', 1000)).toBe('invalid');
    });

    it('rechaza cabeceras que no entiende', () => {
      expect(parseRange('bytes=abc-def', 1000)).toBe('invalid');
      expect(parseRange('items=0-10', 1000)).toBe('invalid');
      expect(parseRange('bytes=-', 1000)).toBe('invalid');
    });

    it('cubre el fichero entero cuando se pide todo', () => {
      const range = parseRange('bytes=0-', 1_800_000_000);
      expect(range).toEqual({ start: 0, end: 1_799_999_999 });
    });
  });

  describe('serveLocalFile', () => {
    let dir: string;
    let video: string;
    // Contenido reconocible: byte i vale i % 251, asi cualquier desfase salta.
    const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'clipper-media-'));
      video = join(dir, 'partida.mp4');
      writeFileSync(video, body);
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('sirve el fichero entero y anuncia que admite rangos', async () => {
      const res = await serveLocalFile(video, null);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('video/mp4');
      // Sin esta cabecera Chromium ni intenta saltar dentro del video.
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(res.headers.get('Content-Length')).toBe('5000');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(body);
    });

    it('devuelve exactamente el trozo pedido', async () => {
      const res = await serveLocalFile(video, 'bytes=1000-1099');
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe('bytes 1000-1099/5000');
      expect(res.headers.get('Content-Length')).toBe('100');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(body.subarray(1000, 1100));
    });

    it('completa hasta el final un rango abierto', async () => {
      const res = await serveLocalFile(video, 'bytes=4900-');
      expect(res.status).toBe(206);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(body.subarray(4900));
    });

    it('responde 416 a un rango imposible', async () => {
      const res = await serveLocalFile(video, 'bytes=9999-');
      expect(res.status).toBe(416);
      expect(res.headers.get('Content-Range')).toBe('bytes */5000');
    });

    it('responde 404 si el fichero ya no esta', async () => {
      const res = await serveLocalFile(join(dir, 'no-existe.mp4'), null);
      expect(res.status).toBe(404);
    });

    it('sirve las miniaturas con su tipo', async () => {
      const thumb = join(dir, 'm.jpg');
      writeFileSync(thumb, Buffer.alloc(10));
      const res = await serveLocalFile(thumb, null);
      expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    });
  });
});
