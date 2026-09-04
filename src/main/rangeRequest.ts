import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname } from 'node:path';

/**
 * Interpretacion de la cabecera `Range` de HTTP.
 *
 * Vive aparte del proceso principal para poder verificarse sin arrancar
 * Electron: es logica de bordes (rangos abiertos, sufijos, peticiones
 * imposibles) y ahi es donde se cometen los errores.
 */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Devuelve el rango pedido, `null` si no se pidio ninguno o `'invalid'` si el
 * fichero no puede satisfacerlo (respuesta 416).
 *
 * Solo se admite un rango por peticion. Chromium nunca pide varios para
 * reproducir video, y responder a un multipart sin necesidad seria mas
 * superficie para equivocarse.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  // Sufijo: "bytes=-500" son los ultimos 500 bytes, no los 500 primeros.
  if (rawStart === '') {
    const length = Number(rawEnd);
    if (length <= 0) return 'invalid';
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  // Un final por encima del fichero no invalida la peticion: se recorta. Es lo
  // que hace Chromium al pedir el ultimo trozo sin saber donde acaba.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (!Number.isFinite(start) || start >= size || end < start) return 'invalid';
  return { start, end };
}

/** Tipos MIME de lo unico que sirve la aplicacion. */
export const MEDIA_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * Construye la respuesta para un fichero local, troceada si se pide asi.
 *
 * Vive aqui, y no dentro del handler del protocolo, para poder comprobarse
 * contra ficheros de verdad sin arrancar Electron. Quien llama es responsable
 * de haber autorizado la ruta antes.
 */
export async function serveLocalFile(
  filePath: string,
  rangeHeader: string | null,
): Promise<Response> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const headers: Record<string, string> = {
    'Content-Type': MEDIA_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };

  // Un fichero vacio no admite rangos, pero tampoco es un error: se responde
  // vacio y que el reproductor decida.
  if (size === 0) {
    return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } });
  }

  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);

  const stream = createReadStream(filePath, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers,
  });
}
