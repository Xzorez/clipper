import { createZstdDecompress } from 'node:zlib';
import { DissectReader, findPatterns } from './DissectReader';
import { createLogger } from '../../logging/Logger';

const log = createLogger('R6Replay');

/** Firma que abre todo fichero de repeticion sin comprimir en bloque. */
const DISSECT_MAGIC = Buffer.from('dissect', 'ascii');
/** Firma de trama zstd. */
const ZSTD_MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Separador que precede a cada cadena de la cabecera: siete bytes a cero. */
const HEADER_STRING_SEPARATOR = Buffer.alloc(7, 0);

/**
 * Firmas de los paquetes que nos interesan, verificadas contra la
 * implementacion de referencia r6-dissect (MIT).
 */
const PATTERN_MATCH_FEEDBACK = Uint8Array.from([0x59, 0x34, 0xe5, 0x8b, 0x04]);
const PATTERN_TIME_Y8S1 = Uint8Array.from([0x1f, 0x07, 0xef, 0xc9]);
const PATTERN_TIME_LEGACY = Uint8Array.from([0x1e, 0xf1, 0x11, 0xab]);

/** Marca que confirma que un paquete de feedback es realmente una eliminacion. */
const KILL_INDICATOR = Uint8Array.from([0x22, 0xd9, 0x13, 0x3c, 0xba]);
/** Marca usada por las versiones antiguas para llegar al bloque de actividad. */
const ACTIVITY_MARKER = Uint8Array.from([0x00, 0x00, 0x00, 0x22, 0xe3, 0x09, 0x00, 0x79]);

/** Versiones de codigo que cambian el formato de los paquetes de feedback. */
const CODE_Y8S1 = 7408213;
const CODE_Y9S1 = 8111697;
const CODE_Y9S1_UPDATE3 = 8211379;

export interface ReplayPlayer {
  id: string;
  username: string;
  teamIndex: number;
}

export interface ReplayHeader {
  gameVersion: string;
  codeVersion: number;
  /** Instante en que empezo a grabarse la ronda, en epoch ms. */
  timestampMs: number;
  matchId: string;
  mapId: string;
  roundNumber: number;
  /** Id del jugador que grabo la repeticion: nosotros. */
  recordingPlayerId: string;
  players: ReplayPlayer[];
}

export type ReplayEventType = 'kill' | 'death' | 'headshot';

export interface ReplayEvent {
  type: ReplayEventType;
  /** Segundos que quedaban en el reloj de la ronda. Cuenta hacia atras. */
  timeRemaining: number;
  killer?: string;
  victim?: string;
  headshot?: boolean;
}

export interface ParsedReplay {
  header: ReplayHeader;
  /** Eventos del jugador local, en orden cronologico. */
  events: ReplayEvent[];
  /** Mayor valor del reloj observado: el origen de la ronda. */
  maxTimeRemaining: number;
  /**
   * Ultimo valor del reloj en orden de fichero: el instante en que acabo la
   * ronda. Es la referencia preferida para situar los eventos, porque el final
   * de la ronda si tiene un equivalente en el reloj de pared (el momento en que
   * el juego cierra el fichero), mientras que el inicio del reloj no lo tiene.
   */
  lastTimeRemaining: number;
  localPlayer: ReplayPlayer | null;
}

/**
 * Lee un fichero de repeticion de Rainbow Six Siege.
 *
 * ## Por que esto existe
 *
 * Rainbow Six no expone ninguna API en tiempo real. Overwolf GEP obtiene sus
 * eventos por vias propias, asi que sin Overwolf no habria marcadores. Ubisoft,
 * en cambio, incluye la funcion Match Replay, que escribe un fichero `.rec` por
 * ronda con lo que ocurrio en ella. Leer esos ficheros es completamente
 * legitimo: son datos que el juego deja en el disco del usuario, no hay
 * inyeccion, ni lectura de memoria, ni contacto con el proceso.
 *
 * La contrapartida es que NO es tiempo real: el fichero de una ronda aparece
 * cuando la ronda termina. Para nuestro caso da igual, porque los marcadores se
 * pintan sobre un video ya grabado.
 *
 * ## Formato
 *
 * Dos variantes de compresion:
 *
 *  - **Por bloques** (Y8S4 en adelante). El fichero empieza con la cadena
 *    "dissect" y una cabecera en texto plano; despues vienen varias tramas zstd
 *    concatenadas, posiblemente con huecos entre ellas.
 *  - **Entera** (anterior). Todo el fichero es una unica trama zstd y la
 *    cabecera esta dentro.
 *
 * Un detalle que obliga a leer trama a trama: `zstdDecompressSync` de Node se
 * detiene al terminar la PRIMERA trama e ignora el resto. Se usa por eso el
 * decompresor en flujo, cuyo `bytesWritten` indica cuantos bytes consumio esa
 * trama y permite localizar la siguiente.
 *
 * Las firmas de paquete y los desplazamientos estan verificados contra
 * r6-dissect (MIT, Benjamin Ryan), que es la referencia del formato.
 */
export async function parseReplay(fileContents: Buffer): Promise<ParsedReplay | null> {
  try {
    const chunked = detectChunkedCompression(fileContents);
    if (chunked === null) {
      log.debug('El fichero no tiene formato de repeticion reconocible');
      return null;
    }

    let header: ReplayHeader;
    let body: Buffer;

    if (chunked) {
      const reader = new DissectReader(fileContents);
      if (!skipHeaderMagic(reader)) return null;
      const parsedHeader = readHeader(reader);
      if (!parsedHeader) return null;
      header = parsedHeader;
      body = await decompressFrames(fileContents, reader.offset);
    } else {
      const decompressed = await decompressFrames(fileContents, 0);
      const reader = new DissectReader(decompressed);
      if (!skipHeaderMagic(reader)) return null;
      const parsedHeader = readHeader(reader);
      if (!parsedHeader) return null;
      header = parsedHeader;
      body = decompressed.subarray(reader.offset);
    }

    if (body.length === 0) {
      log.warn('El cuerpo de la repeticion esta vacio');
      return {
        header,
        events: [],
        maxTimeRemaining: 0,
        lastTimeRemaining: 0,
        localPlayer: findLocalPlayer(header),
      };
    }

    const localPlayer = findLocalPlayer(header);
    const { events, maxTimeRemaining, lastTimeRemaining } = readEvents(body, header, localPlayer);

    return { header, events, maxTimeRemaining, lastTimeRemaining, localPlayer };
  } catch (err) {
    log.warn(`No se pudo leer la repeticion: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Distingue las dos variantes de compresion mirando los primeros bytes.
 * Devuelve null si no es un fichero de repeticion.
 */
export function detectChunkedCompression(buffer: Buffer): boolean | null {
  if (buffer.length < 4) return null;
  if (buffer.subarray(0, 4).equals(Buffer.from(ZSTD_MAGIC))) return false;
  if (buffer.subarray(0, 4).toString('ascii') === 'diss') return true;
  return null;
}

/**
 * Descomprime las tramas zstd a partir de `from`, concatenando su contenido.
 *
 * Se avanza usando los bytes que consume cada trama, no buscando la siguiente
 * firma a ciegas: la firma puede aparecer por azar dentro de datos comprimidos
 * y produciria bloques basura.
 */
async function decompressFrames(buffer: Buffer, from: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let position = findZstdFrame(buffer, from);
  let frames = 0;

  while (position !== -1 && position < buffer.length) {
    const result = await decompressOneFrame(buffer.subarray(position));
    if (!result || result.consumed <= 0) {
      // Firma falsa o trama ilegible: se busca la siguiente a partir del
      // byte siguiente para no quedarse en bucle.
      position = findZstdFrame(buffer, position + 1);
      continue;
    }
    parts.push(result.data);
    frames++;
    position = findZstdFrame(buffer, position + result.consumed);
  }

  log.debug(`Repeticion descomprimida en ${frames} tramas`);
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

function findZstdFrame(buffer: Buffer, from: number): number {
  if (from >= buffer.length) return -1;
  return buffer.indexOf(Buffer.from(ZSTD_MAGIC), from);
}

/**
 * Descomprime una unica trama y devuelve cuantos bytes de entrada consumio.
 * El decompresor en flujo se detiene al final de la trama, y `bytesWritten`
 * revela donde termino.
 */
function decompressOneFrame(
  input: Buffer,
): Promise<{ data: Buffer; consumed: number } | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = createZstdDecompress();
    let settled = false;

    const done = (value: { data: Buffer; consumed: number } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      done({ data: Buffer.concat(chunks), consumed: stream.bytesWritten });
    });
    stream.on('error', () => {
      // Una trama corrupta no invalida el resto del fichero: si se leyo algo,
      // se aprovecha.
      if (chunks.length > 0) {
        done({ data: Buffer.concat(chunks), consumed: stream.bytesWritten });
      } else {
        done(null);
      }
    });

    stream.end(input);
  });
}

/**
 * Valida la firma "dissect" y avanza hasta el inicio de las propiedades.
 *
 * Tras la firma hay un bloque de versionado sin documentar; se salta contando
 * dos secuencias de siete bytes a cero, que es donde empiezan las cadenas.
 */
export function skipHeaderMagic(reader: DissectReader): boolean {
  const magic = reader.bytes(7);
  if (!magic || !magic.equals(DISSECT_MAGIC)) return false;

  let zeros = 0;
  let runs = 0;
  while (runs !== 2) {
    const byte = reader.int();
    if (byte === null) return false;
    if (byte === 0x00) {
      if (zeros !== 6) zeros++;
      else {
        zeros = 0;
        runs++;
      }
    } else if (zeros > 0) {
      zeros = 0;
    }
  }
  return true;
}

/**
 * Lee una cadena de la cabecera.
 * Formato: un byte de longitud, siete bytes a cero, y los caracteres.
 */
function readHeaderString(reader: DissectReader): string | null {
  const size = reader.int();
  if (size === null) return null;
  const separator = reader.bytes(7);
  if (!separator || !separator.equals(HEADER_STRING_SEPARATOR)) return null;
  const raw = reader.bytes(size);
  if (raw === null) return null;
  return raw.toString('utf8');
}

/**
 * Lee la cabecera como pares clave-valor.
 * Termina al aparecer `teamscore1`, que es la ultima propiedad del bloque.
 */
export function readHeader(reader: DissectReader): ReplayHeader | null {
  const props = new Map<string, string>();
  const players: ReplayPlayer[] = [];
  let current: Partial<ReplayPlayer> | null = null;
  let guard = 0;

  while (!props.has('teamscore1')) {
    // Cortafuegos: una cabecera corrupta no debe girar indefinidamente.
    if (guard++ > 5000) {
      log.warn('Cabecera de repeticion demasiado larga; se aborta');
      return null;
    }

    const key = readHeaderString(reader);
    if (key === null) return null;
    const value = readHeaderString(reader);
    if (value === null) return null;

    if (key === 'playerid') {
      if (current) players.push(normalizePlayer(current));
      current = { id: value };
      continue;
    }

    if ((key === 'playlistcategory' || key === 'id') && current) {
      players.push(normalizePlayer(current));
      current = null;
    }

    if (current) {
      if (key === 'playername') current.username = value;
      else if (key === 'team') current.teamIndex = Number(value) || 0;
      continue;
    }

    props.set(key, value);
  }

  if (current) players.push(normalizePlayer(current));

  const timestampMs = parseDissectDate(props.get('datetime'));
  if (timestampMs === null) {
    log.warn('La repeticion no trae fecha utilizable');
    return null;
  }

  return {
    gameVersion: props.get('version') ?? '',
    codeVersion: Number(props.get('code')) || 0,
    timestampMs,
    matchId: props.get('matchid') ?? '',
    mapId: props.get('worldid') ?? '',
    roundNumber: Number(props.get('roundnumber')) || 0,
    recordingPlayerId: props.get('recordingplayerid') ?? '',
    players,
  };
}

function normalizePlayer(partial: Partial<ReplayPlayer>): ReplayPlayer {
  return {
    id: partial.id ?? '',
    username: partial.username ?? '',
    teamIndex: partial.teamIndex ?? 0,
  };
}

/**
 * Convierte la fecha de la cabecera, con formato `AAAA-MM-DD-HH-MM-SS`.
 * Se interpreta como hora local porque el juego la escribe sin zona horaria.
 */
export function parseDissectDate(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split('-').map((part) => Number(part));
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null;
  const [year, month, day, hour, minute, second] = parts;
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function findLocalPlayer(header: ReplayHeader): ReplayPlayer | null {
  if (!header.recordingPlayerId) return null;
  return header.players.find((p) => p.id === header.recordingPlayerId) ?? null;
}

/**
 * Recorre el cuerpo buscando paquetes de reloj y de eliminacion.
 *
 * Se procesan en orden de aparicion porque el reloj llega intercalado: el valor
 * vigente cuando aparece una kill es el del ultimo paquete de tiempo leido.
 */
function readEvents(
  body: Buffer,
  header: ReplayHeader,
  localPlayer: ReplayPlayer | null,
): { events: ReplayEvent[]; maxTimeRemaining: number; lastTimeRemaining: number } {
  const usesModernTime = header.codeVersion >= CODE_Y8S1;
  const timePattern = usesModernTime ? PATTERN_TIME_Y8S1 : PATTERN_TIME_LEGACY;
  const patterns = [PATTERN_MATCH_FEEDBACK, timePattern];

  const matches = findPatterns(body, patterns);
  const reader = new DissectReader(body);

  const events: ReplayEvent[] = [];
  const seen = new Set<string>();
  let currentTime = 0;
  let maxTimeRemaining = 0;
  let lastTimeRemaining = 0;

  for (const match of matches) {
    reader.offset = match.offset + 1;

    if (match.patternIndex === 1) {
      const time = usesModernTime ? reader.uint32() : parseLegacyTime(reader.string());
      if (time !== null && time >= 0 && time < 10_000) {
        currentTime = time;
        lastTimeRemaining = time;
        if (time > maxTimeRemaining) maxTimeRemaining = time;
      }
      continue;
    }

    const feedback = readMatchFeedback(reader, header.codeVersion);
    if (!feedback) continue;

    // Solo interesan los eventos del jugador local.
    const involvesUs =
      localPlayer !== null &&
      (namesEqual(feedback.killer, localPlayer.username) ||
        namesEqual(feedback.victim, localPlayer.username));
    if (!involvesUs) continue;

    const signature = `${feedback.killer ?? ''}>${feedback.victim ?? ''}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    if (namesEqual(feedback.victim, localPlayer!.username)) {
      events.push({
        type: 'death',
        timeRemaining: currentTime,
        killer: feedback.killer,
        victim: feedback.victim,
      });
      continue;
    }

    events.push({
      type: 'kill',
      timeRemaining: currentTime,
      killer: feedback.killer,
      victim: feedback.victim,
      headshot: feedback.headshot,
    });

    if (feedback.headshot) {
      events.push({
        type: 'headshot',
        timeRemaining: currentTime,
        killer: feedback.killer,
        victim: feedback.victim,
      });
    }
  }

  // Del reloj mayor al menor: el orden cronologico es el inverso del contador.
  events.sort((a, b) => b.timeRemaining - a.timeRemaining);
  return { events, maxTimeRemaining, lastTimeRemaining };
}

interface FeedbackResult {
  killer?: string;
  victim?: string;
  headshot?: boolean;
}

/**
 * Lee un paquete de feedback de partida.
 *
 * Los desplazamientos dependen de la version del juego: Ubisoft ha cambiado la
 * estructura varias veces. Los tres casos estan tomados de la implementacion de
 * referencia y se aplican segun `codeVersion` de la cabecera.
 */
function readMatchFeedback(reader: DissectReader, codeVersion: number): FeedbackResult | null {
  if (codeVersion >= CODE_Y9S1_UPDATE3) {
    if (!reader.skip(38)) return null;
  } else if (codeVersion >= CODE_Y9S1) {
    if (!reader.skip(9)) return null;
    if (reader.int() !== 4) return null;
    if (!reader.skip(24)) return null;
  } else {
    if (!reader.skip(1)) return null;
    if (!reader.seek(ACTIVITY_MARKER)) return null;
  }

  const size = reader.int();
  // Solo el tamano cero corresponde a una eliminacion; el resto son mensajes.
  if (size !== 0) return null;

  const trace = reader.bytes(5);
  if (!trace || !trace.equals(Buffer.from(KILL_INDICATOR))) return null;

  const killer = reader.string();
  if (killer === null) return null;

  // Quince bytes sin documentar entre los dos nombres.
  if (!reader.skip(15)) return null;

  const victim = reader.string();
  if (victim === null) return null;

  if (killer.length === 0) {
    // Sin atacante: es una muerte no atribuida (caida, gas, suicidio).
    return victim.length > 0 ? { victim } : null;
  }

  // El indicador de headshot esta bastante mas adelante en el paquete.
  let headshot: boolean | undefined;
  if (reader.skip(56)) {
    const flag = reader.int();
    if (flag !== null) headshot = flag === 1;
  }

  return { killer, victim, headshot };
}

/** Formato antiguo del reloj: "M:SS" o segundos sueltos. */
function parseLegacyTime(value: string | null): number | null {
  if (!value) return null;
  const parts = value.split(':');
  if (parts.length === 1) {
    const seconds = Number(parts[0]);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return minutes * 60 + seconds;
}

function namesEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
