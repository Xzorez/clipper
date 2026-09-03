/**
 * Cursor de lectura sobre el cuerpo descomprimido de un fichero de repeticion
 * de Rainbow Six Siege (formato "dissect").
 *
 * El formato no lleva indice ni tabla de contenidos: es una secuencia de
 * paquetes que se localizan buscando firmas de bytes conocidas y, a partir de
 * ahi, leyendo valores con longitudes fijas o prefijadas. Esta clase aporta
 * solo las primitivas de lectura; el significado lo pone ReplayParser.
 *
 * Todos los metodos devuelven null en lugar de lanzar cuando se sale del
 * buffer. Un fichero truncado o de una version futura es un escenario normal,
 * no excepcional: se descarta ese paquete y se sigue.
 */
export class DissectReader {
  private readonly buffer: Buffer;
  private cursor = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get offset(): number {
    return this.cursor;
  }

  set offset(value: number) {
    this.cursor = value;
  }

  get length(): number {
    return this.buffer.length;
  }

  get data(): Buffer {
    return this.buffer;
  }

  /** Avanza n bytes. Devuelve false si se sale del buffer. */
  skip(n: number): boolean {
    if (this.cursor + n > this.buffer.length || n < 0) {
      this.cursor = this.buffer.length;
      return false;
    }
    this.cursor += n;
    return true;
  }

  /** Lee n bytes crudos. */
  bytes(n: number): Buffer | null {
    if (n < 0 || this.cursor + n > this.buffer.length) return null;
    const slice = this.buffer.subarray(this.cursor, this.cursor + n);
    this.cursor += n;
    return slice;
  }

  /** Lee un byte como entero sin signo. */
  int(): number | null {
    if (this.cursor >= this.buffer.length) return null;
    return this.buffer[this.cursor++];
  }

  /**
   * Lee una cadena con prefijo de longitud de un byte.
   * Es el formato del cuerpo, distinto al de la cabecera.
   */
  string(): string | null {
    const size = this.int();
    if (size === null) return null;
    const raw = this.bytes(size);
    if (raw === null) return null;
    return raw.toString('utf8');
  }

  /**
   * Lee un entero de 32 bits little-endian.
   * Va precedido de un byte de tamano que se descarta: ya conocemos la anchura.
   */
  uint32(): number | null {
    if (!this.skip(1)) return null;
    const raw = this.bytes(4);
    if (raw === null) return null;
    return raw.readUInt32LE(0);
  }

  /** Comprueba si en la posicion dada empieza el patron indicado. */
  matchesAt(position: number, pattern: Uint8Array): boolean {
    if (position + pattern.length > this.buffer.length) return false;
    for (let i = 0; i < pattern.length; i++) {
      if (this.buffer[position + i] !== pattern[i]) return false;
    }
    return true;
  }

  /** Busca el patron desde la posicion actual y deja el cursor justo despues. */
  seek(pattern: Uint8Array): boolean {
    const index = this.buffer.indexOf(Buffer.from(pattern), this.cursor);
    if (index === -1) {
      this.cursor = this.buffer.length;
      return false;
    }
    this.cursor = index + pattern.length;
    return true;
  }
}

/**
 * Localiza todas las apariciones de varios patrones en un solo recorrido.
 *
 * Se hace en una pasada porque el cuerpo descomprimido de una ronda ronda los
 * megabytes y recorrerlo una vez por patron seria innecesariamente costoso.
 * Devuelve las coincidencias ordenadas por posicion, que es como hay que
 * procesarlas: el reloj de la ronda llega intercalado entre las kills y hay que
 * respetar ese orden para asignar bien los tiempos.
 */
export function findPatterns(
  buffer: Buffer,
  patterns: Uint8Array[],
  from = 0,
): Array<{ offset: number; patternIndex: number }> {
  const matches: Array<{ offset: number; patternIndex: number }> = [];
  // Progreso de coincidencia parcial de cada patron, como en un automata simple.
  const progress = new Array<number>(patterns.length).fill(0);

  for (let i = from; i < buffer.length; i++) {
    const byte = buffer[i];
    for (let p = 0; p < patterns.length; p++) {
      const pattern = patterns[p];
      if (byte === pattern[progress[p]]) {
        progress[p]++;
        if (progress[p] === pattern.length) {
          progress[p] = 0;
          // La posicion apunta al ultimo byte del patron, igual que en la
          // implementacion de referencia: los lectores continuan desde ahi + 1.
          matches.push({ offset: i, patternIndex: p });
        }
      } else {
        // Reinicio simple. Basta porque las firmas del formato no tienen
        // prefijos propios repetidos.
        progress[p] = byte === pattern[0] ? 1 : 0;
      }
    }
  }

  return matches;
}
