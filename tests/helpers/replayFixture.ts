import { zstdCompressSync } from 'node:zlib';

/**
 * Constructor de ficheros de repeticion sinteticos de Rainbow Six Siege.
 *
 * No hay repeticiones reales disponibles en el entorno de pruebas (hacen falta
 * partidas jugadas con Match Replay activado), asi que se generan ficheros con
 * el formato exacto que el parser espera. Esto permite verificar de forma
 * determinista la cabecera, la descompresion por tramas, la deteccion de
 * paquetes y la extraccion de eventos.
 *
 * El formato reproducido es el "por bloques" (Y8S4 en adelante): cabecera en
 * texto plano seguida de tramas zstd.
 */

/** Version de codigo por defecto: la mas reciente que cambia los desplazamientos. */
export const CODE_VERSION_Y9S1_UPDATE3 = 8211379;
export const CODE_VERSION_Y8S1 = 7408213;

const PATTERN_MATCH_FEEDBACK = Buffer.from([0x59, 0x34, 0xe5, 0x8b, 0x04]);
const PATTERN_TIME_Y8S1 = Buffer.from([0x1f, 0x07, 0xef, 0xc9]);
const KILL_INDICATOR = Buffer.from([0x22, 0xd9, 0x13, 0x3c, 0xba]);

/** Relleno neutro: no colisiona con el primer byte de ningun patron. */
const FILLER = 0xaa;

export interface FixturePlayer {
  id: string;
  username: string;
  teamIndex: number;
}

export interface FixtureHeader {
  version?: string;
  codeVersion?: number;
  /** Formato AAAA-MM-DD-HH-MM-SS, tal y como lo escribe el juego. */
  datetime: string;
  matchId?: string;
  worldId?: string;
  roundNumber?: number;
  recordingPlayerId: string;
  players: FixturePlayer[];
}

export type FixtureBodyItem =
  | { kind: 'time'; secondsRemaining: number }
  | { kind: 'kill'; killer: string; victim: string; headshot?: boolean }
  /** Muerte sin atacante: el paquete llega con el nombre del asesino vacio. */
  | { kind: 'unattributedDeath'; victim: string };

/**
 * Devuelve una marca temporal en el formato de la cabecera, situada N segundos
 * antes de ahora.
 *
 * Los tests que comprueban la colocacion de los marcadores necesitan que la
 * ronda sea reciente de verdad: el proveedor calcula la antiguedad contra el
 * reloj real del sistema, asi que una fecha fija en el pasado dejaria todos los
 * eventos fuera del video.
 */
export function datetimeSecondsAgo(seconds: number): string {
  const when = new Date(Date.now() - seconds * 1000);
  return [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, '0'),
    String(when.getDate()).padStart(2, '0'),
    String(when.getHours()).padStart(2, '0'),
    String(when.getMinutes()).padStart(2, '0'),
    String(when.getSeconds()).padStart(2, '0'),
  ].join('-');
}

/** Codifica una cadena de cabecera: longitud, siete ceros y contenido. */
function headerString(value: string): Buffer {
  const content = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([content.length]), Buffer.alloc(7, 0), content]);
}

function headerPair(key: string, value: string): Buffer {
  return Buffer.concat([headerString(key), headerString(value)]);
}

/** Cadena del cuerpo: solo un byte de longitud, sin separador. */
function bodyString(value: string): Buffer {
  const content = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([content.length]), content]);
}

export function buildHeaderBytes(header: FixtureHeader): Buffer {
  const parts: Buffer[] = [];

  // Firma y bloque de versionado. El lector avanza hasta haber pasado dos
  // secuencias de siete bytes a cero, asi que se colocan catorce seguidos.
  parts.push(Buffer.from('dissect', 'ascii'));
  parts.push(Buffer.from([0x01, 0x02, 0x03]));
  parts.push(Buffer.alloc(14, 0));

  parts.push(headerPair('version', header.version ?? 'Y9S1'));
  parts.push(headerPair('code', String(header.codeVersion ?? CODE_VERSION_Y9S1_UPDATE3)));
  parts.push(headerPair('datetime', header.datetime));
  parts.push(headerPair('matchtype', '2'));
  parts.push(headerPair('worldid', header.worldId ?? '355496559878'));
  parts.push(headerPair('recordingplayerid', header.recordingPlayerId));
  parts.push(headerPair('gamemodeid', '327933806'));
  parts.push(headerPair('roundspermatch', '9'));
  parts.push(headerPair('roundspermatchovertime', '3'));
  parts.push(headerPair('roundnumber', String(header.roundNumber ?? 1)));
  parts.push(headerPair('overtimeroundnumber', '0'));
  parts.push(headerPair('matchid', header.matchId ?? 'match-fixture'));

  for (const player of header.players) {
    parts.push(headerPair('playerid', player.id));
    parts.push(headerPair('playername', player.username));
    parts.push(headerPair('team', String(player.teamIndex)));
  }

  // Cierra el bloque de jugadores.
  parts.push(headerPair('playlistcategory', '2'));
  parts.push(headerPair('teamname0', 'AZUL'));
  parts.push(headerPair('teamname1', 'NARANJA'));
  parts.push(headerPair('teamscore0', '3'));
  // teamscore1 es la ultima propiedad: marca el fin de la cabecera.
  parts.push(headerPair('teamscore1', '2'));

  return Buffer.concat(parts);
}

/** Paquete de reloj de ronda: patron, byte de tamano y entero de 32 bits. */
function timePacket(secondsRemaining: number): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(secondsRemaining, 0);
  return Buffer.concat([PATTERN_TIME_Y8S1, Buffer.from([0x04]), value]);
}

/**
 * Paquete de eliminacion con la estructura de Y9S1 Update 3 en adelante:
 * patron, 38 bytes sin documentar, byte de tamano a cero, marca de kill,
 * nombre del asesino, 15 bytes, nombre de la victima, 56 bytes y bandera de
 * headshot.
 */
function killPacket(killer: string, victim: string, headshot: boolean): Buffer {
  return Buffer.concat([
    PATTERN_MATCH_FEEDBACK,
    Buffer.alloc(38, FILLER),
    Buffer.from([0x00]),
    KILL_INDICATOR,
    bodyString(killer),
    Buffer.alloc(15, FILLER),
    bodyString(victim),
    Buffer.alloc(56, FILLER),
    Buffer.from([headshot ? 0x01 : 0x00]),
  ]);
}

export function buildBodyBytes(items: FixtureBodyItem[]): Buffer {
  const parts: Buffer[] = [Buffer.alloc(16, FILLER)];

  for (const item of items) {
    if (item.kind === 'time') {
      parts.push(timePacket(item.secondsRemaining));
    } else if (item.kind === 'kill') {
      parts.push(killPacket(item.killer, item.victim, item.headshot ?? false));
    } else {
      // Sin asesino: el nombre llega vacio y el parser lo trata como muerte.
      parts.push(killPacket('', item.victim, false));
    }
    parts.push(Buffer.alloc(8, FILLER));
  }

  return Buffer.concat(parts);
}

export interface FixtureOptions {
  /** Divide el cuerpo en varias tramas zstd, como hacen las versiones nuevas. */
  frames?: number;
  /** Intercala bytes ajenos entre tramas, para probar el avance del lector. */
  gapBetweenFrames?: boolean;
}

/**
 * Genera un fichero de repeticion completo con compresion por bloques.
 */
export function buildReplayFile(
  header: FixtureHeader,
  items: FixtureBodyItem[],
  options: FixtureOptions = {},
): Buffer {
  const body = buildBodyBytes(items);
  const frames = Math.max(1, options.frames ?? 1);

  const chunks: Buffer[] = [];
  const chunkSize = Math.ceil(body.length / frames);
  for (let i = 0; i < body.length; i += chunkSize) {
    chunks.push(zstdCompressSync(body.subarray(i, i + chunkSize)));
    if (options.gapBetweenFrames && i + chunkSize < body.length) {
      chunks.push(Buffer.from([0x11, 0x22, 0x33]));
    }
  }

  return Buffer.concat([buildHeaderBytes(header), ...chunks]);
}

/**
 * Genera la variante antigua: el fichero entero es una unica trama zstd que
 * contiene tambien la cabecera.
 */
export function buildLegacyReplayFile(
  header: FixtureHeader,
  items: FixtureBodyItem[],
): Buffer {
  const plain = Buffer.concat([buildHeaderBytes(header), buildBodyBytes(items)]);
  return zstdCompressSync(plain);
}
