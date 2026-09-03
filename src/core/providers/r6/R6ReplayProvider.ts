import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';
import { GEP_GAME_IDS, ProviderState } from '../../../shared/types';
import { RawGameEvent } from '../../games/GameAdapter';
import { parseReplay, ParsedReplay } from './ReplayParser';
import { createLogger } from '../../logging/Logger';

const log = createLogger('R6Replay');

const POLL_INTERVAL_MS = 5000;

/**
 * Antiguedad minima de un fichero antes de leerlo.
 * Evita leer una repeticion que el juego todavia esta escribiendo.
 */
const MIN_FILE_AGE_MS = 3000;

/** Limite de seguridad para no leer ficheros absurdamente grandes. */
const MAX_FILE_BYTES = 80 * 1024 * 1024;

export interface R6ReplayOptions {
  /**
   * Desfase entre el instante que marca la repeticion y el momento en que el
   * reloj de la ronda empieza a contar, en milisegundos. Calibrable.
   */
  roundOffsetMs: number;
}

/**
 * Proveedor de eventos de Rainbow Six Siege sin Overwolf.
 *
 * Vigila la carpeta de repeticiones que Ubisoft genera con la funcion
 * Match Replay y, cuando aparece el fichero de una ronda terminada, lo lee y
 * emite las kills, muertes y headshots del jugador local.
 *
 * ## Diferencia importante con los otros proveedores
 *
 * GEP y la API de Riot entregan eventos segun ocurren. Este NO: una ronda
 * completa aparece de golpe cuando termina. Los marcadores de una ronda se
 * anaden a la timeline unos segundos despues de acabarla, no durante.
 *
 * Para el objetivo de la aplicacion es indiferente, porque los marcadores se
 * pintan sobre un video que se revisa despues. Lo que si exige es no posicionar
 * los eventos por su hora de llegada: cada uno se situa por su instante REAL,
 * reconstruido a partir de la marca temporal de la ronda y del reloj de partida,
 * y se comunica mediante `latencyHintMs`.
 *
 * ## Requisitos
 *
 * El usuario debe tener activada la funcion Match Replay en el juego. Si no hay
 * carpeta de repeticiones, el proveedor lo indica y no hace nada mas.
 */
export class R6ReplayProvider extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private state: ProviderState = { status: 'unavailable', provider: 'r6-replay' };

  private readonly processed = new Set<string>();
  private sessionStartMs = 0;
  private options: R6ReplayOptions = { roundOffsetMs: 0 };
  private replayRoots: string[] = [];
  private readonly documentsDir?: string;

  /**
   * `documentsDir` solo se usa en los tests, para apuntar a una carpeta de
   * repeticiones sintetica en lugar de a la del usuario.
   */
  constructor(documentsDir?: string) {
    super();
    this.documentsDir = documentsDir;
  }

  getState(): ProviderState {
    return { ...this.state };
  }

  setOptions(options: R6ReplayOptions): void {
    this.options = options;
  }

  /**
   * Empieza a vigilar. Solo se tienen en cuenta las rondas grabadas a partir de
   * `sessionStartMs`, para no importar el historial entero del usuario.
   */
  start(sessionStartMs: number, options?: R6ReplayOptions): void {
    if (options) this.options = options;
    this.sessionStartMs = sessionStartMs;
    this.processed.clear();
    this.replayRoots = findReplayRoots(this.documentsDir);

    if (this.replayRoots.length === 0) {
      this.setState({
        status: 'unavailable',
        provider: 'r6-replay',
        message:
          'No se ha encontrado la carpeta de repeticiones de Rainbow Six Siege. ' +
          'Activa la funcion Match Replay en las opciones del juego para tener marcadores.',
      });
      log.warn('Sin carpeta de repeticiones: no habra eventos de Rainbow Six');
      return;
    }

    log.info(`Vigilando repeticiones en: ${this.replayRoots.join(', ')}`);
    this.setState({
      status: 'connected',
      provider: 'r6-replay',
      message: 'Leyendo las repeticiones de Rainbow Six al terminar cada ronda',
    });

    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.setState({ status: 'unavailable', provider: 'r6-replay' });
  }

  /**
   * Recoge la ultima ronda antes de cerrar la grabacion.
   *
   * El fichero de la ronda final se escribe justo al terminar la partida, es
   * decir, despues de que el juego se cierre. Sin esta espera esos eventos se
   * perderian: llegarian cuando la grabacion ya se ha consolidado.
   */
  async drain(waitMs = 4000): Promise<void> {
    if (this.replayRoots.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    // Se ignora el margen de antiguedad: el juego ya ha cerrado el fichero.
    await this.scan(true);
  }

  /**
   * Una pasada de busqueda. Publico para poder dirigirlo desde los tests.
   */
  async scan(ignoreAge = false): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const root of this.replayRoots) {
        const files = await collectReplayFiles(root);
        for (const file of files) {
          if (this.processed.has(file.path)) continue;
          if (file.mtimeMs < this.sessionStartMs) continue;
          if (!ignoreAge && Date.now() - file.mtimeMs < MIN_FILE_AGE_MS) continue;
          if (file.size > MAX_FILE_BYTES) {
            log.warn(`Repeticion demasiado grande, se omite: ${file.path}`);
            this.processed.add(file.path);
            continue;
          }

          this.processed.add(file.path);
          await this.ingestFile(file.path, file.mtimeMs);
        }
      }
    } catch (err) {
      log.warn(`Fallo al buscar repeticiones: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private async ingestFile(path: string, mtimeMs: number): Promise<void> {
    let parsed: ParsedReplay | null;
    try {
      const contents = await readFile(path);
      parsed = await parseReplay(contents);
    } catch (err) {
      log.warn(`No se pudo leer ${path}: ${(err as Error).message}`);
      return;
    }

    if (!parsed) return;
    if (!parsed.localPlayer) {
      log.warn('No se ha podido identificar al jugador local en la repeticion');
      return;
    }

    log.info(
      `Ronda ${parsed.header.roundNumber} leida: ${parsed.events.length} eventos ` +
        `de ${parsed.localPlayer.username}`,
    );

    for (const raw of this.toRawEvents(parsed, mtimeMs)) {
      this.emit('raw', raw);
    }
    this.emit('round-parsed', {
      roundNumber: parsed.header.roundNumber,
      events: parsed.events.length,
    });
  }

  /**
   * Convierte los eventos de la repeticion en payloads con el formato que
   * espera el adaptador de Rainbow Six.
   *
   * El adaptador trata las kills de R6 como ocurrencias discretas con
   * `value: null`, exactamente igual que las que entrega GEP, asi que no hace
   * falta tocarlo: recibe lo mismo por otra via.
   */
  private toRawEvents(parsed: ParsedReplay, mtimeMs: number): RawGameEvent[] {
    const now = Date.now();
    const anchor = this.computeAnchor(parsed, mtimeMs);
    const result: RawGameEvent[] = [];

    for (const event of parsed.events) {
      const occurredAtMs = absoluteTimeFor(anchor, event.timeRemaining);
      // El evento ya ha ocurrido: se indica cuanto hace, para que se coloque en
      // su sitio del video y no en el instante en que se leyo el fichero.
      const latencyHintMs = Math.max(0, now - occurredAtMs);

      const common = {
        gameId: GEP_GAME_IDS.rainbowsix,
        kind: 'event' as const,
        latencyHintMs,
      };

      if (event.type === 'kill') {
        result.push({ ...common, feature: 'kill', key: 'kill', value: null });
      } else if (event.type === 'headshot') {
        result.push({ ...common, feature: 'kill', key: 'headshot', value: null });
      } else {
        result.push({ ...common, feature: 'death', key: 'death', value: null });
        if (event.killer) {
          result.push({ ...common, feature: 'death', key: 'killer', value: event.killer });
        }
      }
    }

    return result;
  }

  /**
   * Elige el punto de referencia para situar los eventos de la ronda.
   *
   * Ver `computeRoundAnchor` para el razonamiento. Aqui solo se registra la
   * decision y, cuando se puede, la duracion implicita de la fase de
   * preparacion, que sirve para comprobar que el modelo temporal cuadra.
   */
  private computeAnchor(parsed: ParsedReplay, mtimeMs: number): RoundAnchor {
    const anchor = computeRoundAnchor(parsed, mtimeMs, this.options.roundOffsetMs);

    if (anchor.mode === 'end') {
      const roundSpanMs = Math.max(0, parsed.maxTimeRemaining - parsed.lastTimeRemaining) * 1000;
      const impliedPrepMs = mtimeMs - roundSpanMs - parsed.header.timestampMs;
      log.info(
        `Ronda ${parsed.header.roundNumber} anclada por su final. ` +
          `Fase de preparacion implicita: ${Math.round(impliedPrepMs / 1000)}s`,
      );
    } else {
      log.warn(
        `Ronda ${parsed.header.roundNumber}: el anclaje por el final no es fiable ` +
          `(${anchor.reason}); se recurre al inicio con el desfase configurado`,
      );
    }

    return anchor;
  }

  private setState(state: ProviderState): void {
    this.state = state;
    this.emit('state', this.getState());
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}

export interface RoundAnchor {
  /** 'end' usa el final de la ronda; 'start' recurre al inicio con desfase. */
  mode: 'end' | 'start';
  /** Instante absoluto que corresponde a `referenceClock`. */
  referenceMs: number;
  /** Valor del reloj de ronda en ese instante. */
  referenceClock: number;
  reason?: string;
}

/**
 * Duracion maxima plausible de una ronda, incluida la preparacion.
 * Sirve para detectar un mtime que no corresponde al final de la ronda.
 */
const MAX_ROUND_WALL_MS = 30 * 60 * 1000;

/**
 * Decide el punto de referencia temporal de una ronda.
 *
 * ## Por que el final y no el inicio
 *
 * La cabecera dice cuando EMPEZO A GRABARSE la ronda, pero el reloj de ronda no
 * arranca en ese momento: antes va la fase de preparacion, que dura distinto
 * segun el modo de juego. Ese hueco no se puede deducir del fichero, y era lo
 * que obligaba a calibrar a mano.
 *
 * Anclando por el final el problema desaparece. Un evento con el reloj en `C`
 * ocurrio `C - C_final` segundos antes de acabar la ronda, y la ronda acaba
 * cuando el juego termina de escribir el fichero, es decir, su fecha de
 * modificacion. Lo unico que queda sin conocer es el retardo de escritura, de
 * uno o dos segundos, frente a los cuarenta y pico de la preparacion.
 *
 * Hay una segunda ventaja. Siege tiene DOS cuentas atras, la de preparacion y
 * la de accion, y ambas aparecen en el mismo flujo. Medir desde el valor mas
 * alto observado da por hecho que hay una sola cuenta monotonica; medir la
 * diferencia entre dos valores del mismo tramo es inmune a eso.
 *
 * ## Cuando NO se puede usar
 *
 * La fecha de modificacion deja de ser fiable si el fichero se copia o se mueve.
 * Por eso se comprueba que sea coherente con la cabecera: el final de la ronda
 * tiene que caer despues de su inicio y dentro de una duracion plausible. Si no
 * cuadra, se vuelve al anclaje por el inicio con el desfase configurado.
 */
export function computeRoundAnchor(
  parsed: ParsedReplay,
  mtimeMs: number,
  configuredOffsetMs: number,
): RoundAnchor {
  const startAnchor: RoundAnchor = {
    mode: 'start',
    referenceMs: parsed.header.timestampMs + configuredOffsetMs,
    referenceClock: parsed.maxTimeRemaining,
  };

  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return { ...startAnchor, reason: 'sin fecha de modificacion' };
  }

  // Sin reloj util no hay nada que anclar por el final.
  if (parsed.maxTimeRemaining <= 0 || parsed.maxTimeRemaining === parsed.lastTimeRemaining) {
    return { ...startAnchor, reason: 'el reloj de ronda no avanza' };
  }

  const elapsedWallMs = mtimeMs - parsed.header.timestampMs;
  if (elapsedWallMs <= 0) {
    return { ...startAnchor, reason: 'el fichero es anterior a su propia cabecera' };
  }
  if (elapsedWallMs > MAX_ROUND_WALL_MS) {
    return { ...startAnchor, reason: 'la fecha de modificacion queda demasiado lejos' };
  }

  // El tiempo de reloj consumido no puede superar al tiempo real transcurrido.
  const roundSpanMs = (parsed.maxTimeRemaining - parsed.lastTimeRemaining) * 1000;
  if (roundSpanMs > elapsedWallMs + 5000) {
    return { ...startAnchor, reason: 'la duracion del reloj no cabe en el tiempo real' };
  }

  return {
    mode: 'end',
    referenceMs: mtimeMs,
    referenceClock: parsed.lastTimeRemaining,
  };
}

/**
 * Situa un evento en el reloj de pared a partir del ancla de su ronda.
 *
 * El reloj de ronda cuenta hacia atras, asi que un valor mayor que el de
 * referencia significa un instante anterior. La misma formula sirve para los
 * dos modos de anclaje.
 */
export function absoluteTimeFor(anchor: RoundAnchor, timeRemaining: number): number {
  return anchor.referenceMs - (timeRemaining - anchor.referenceClock) * 1000;
}

/**
 * Localiza las carpetas de repeticiones.
 *
 * Siege guarda un directorio por perfil bajo
 * `Documentos\My Games\Rainbow Six - Siege\<perfil>\MatchReplay`.
 * Puede haber varios perfiles, asi que se devuelven todos los existentes.
 */
export function findReplayRoots(documentsDir?: string): string[] {
  const documents = documentsDir ?? safeDocumentsPath();
  const base = join(documents, 'My Games', 'Rainbow Six - Siege');
  if (!existsSync(base)) return [];

  const roots: string[] = [];
  try {
    // Lectura sincrona deliberada: ocurre una vez al detectar el juego.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(base, entry.name, 'MatchReplay');
      if (existsSync(candidate)) roots.push(candidate);
    }
  } catch {
    return [];
  }
  return roots;
}

function safeDocumentsPath(): string {
  try {
    return app.getPath('documents');
  } catch {
    return join(homedir(), 'Documents');
  }
}

export interface ReplayFileInfo {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Recoge los .rec de la carpeta, incluidas las subcarpetas por partida. */
export async function collectReplayFiles(root: string): Promise<ReplayFileInfo[]> {
  const results: ReplayFileInfo[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith('.rec')) {
        try {
          const info = await stat(full);
          results.push({ path: full, mtimeMs: info.mtimeMs, size: info.size });
        } catch {
          /* el fichero puede desaparecer entre el listado y el stat */
        }
      }
    }
  };

  await walk(root, 0);
  return results;
}
