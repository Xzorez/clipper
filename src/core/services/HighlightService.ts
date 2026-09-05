import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { GameEvent, GameEventType, GameKey } from '../../shared/types';
import {
  DEFAULT_PEAK_OPTIONS,
  PeakOptions,
  buildAnalysisArgs,
  findPeaks,
  parseLoudness,
} from '../analysis/AudioHighlights';
import { resolveFfmpegPath } from '../recording/ffmpegPath';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('Highlights');

/** Tope de la salida de FFmpeg. Una hora de partida cabe de sobra. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Si el analisis tarda mas que esto, se abandona sin mas. */
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Tipos de evento que vienen de datos reales del juego.
 *
 * Si una grabacion ya tiene alguno, no hace falta adivinar nada: los eventos
 * de verdad son mejores que cualquier conjetura, y mezclar las dos cosas solo
 * llenaria la linea temporal de ruido.
 */
const REAL_GAME_EVENTS = new Set<GameEventType>([
  GameEventType.KILL,
  GameEventType.DEATH,
  GameEventType.HEADSHOT,
  GameEventType.ASSIST,
  GameEventType.KNOCKED_OUT,
]);

export interface AnalyzeParams {
  game: GameKey;
  filePath: string;
  /** Eventos que ya tiene la grabacion. Decide si merece la pena analizar. */
  existingEvents: GameEvent[];
  /** Epoch del primer frame, para fechar los destacados. */
  startedAtMs: number;
  options?: Partial<PeakOptions>;
}

/**
 * Deduce momentos destacados del sonido de una grabacion ya terminada.
 *
 * Se hace despues, sobre el MP4 en disco, y nunca durante la partida: no toca
 * el proceso del juego, no lee su memoria y no mira la pantalla. El material
 * analizado es un fichero nuestro.
 *
 * Solo entra en juego cuando no hay nada mejor. Una partida de VALORANT ya
 * trae kills y muertes de verdad; anadirle suposiciones sacadas del volumen
 * seria empeorarla.
 */
export class HighlightService {
  /**
   * Devuelve los destacados encontrados, o una lista vacia.
   *
   * Nunca lanza: esto es un extra que corre al terminar de grabar, y que falle
   * no puede afectar a una partida que ya esta guardada.
   */
  async analyze(params: AnalyzeParams): Promise<GameEvent[]> {
    const { game, filePath, existingEvents, startedAtMs } = params;

    if (existingEvents.some((event) => REAL_GAME_EVENTS.has(event.type))) {
      log.debug('La grabacion ya tiene eventos reales del juego; no se analiza el sonido');
      return [];
    }

    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) return [];

    let output: string;
    try {
      const result = await execFileAsync(ffmpeg, buildAnalysisArgs(filePath), {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: ANALYSIS_TIMEOUT_MS,
        windowsHide: true,
      });
      output = result.stdout;
    } catch (err) {
      log.warn(`No se ha podido analizar el sonido: ${(err as Error).message}`);
      return [];
    }

    const samples = parseLoudness(output);
    if (samples.length === 0) {
      // Lo normal cuando la grabacion salio muda: sin pista de audio no hay
      // nada que deducir.
      log.info('La grabacion no tiene sonido analizable; sin destacados');
      return [];
    }

    const options: PeakOptions = { ...DEFAULT_PEAK_OPTIONS, ...params.options };
    const peaks = findPeaks(samples, options);
    if (peaks.length === 0) {
      log.info('El sonido no destaca en ningun momento; sin destacados');
      return [];
    }

    log.info(`${peaks.length} momentos destacados deducidos del sonido`);

    return peaks.map((peak) => ({
      id: randomUUID(),
      game,
      type: GameEventType.HIGHLIGHT,
      timestamp: startedAtMs + Math.round(peak.time * 1000),
      // El instante sale del propio video, asi que no hay reloj que conciliar
      // ni latencia que compensar: por construccion cae donde suena.
      monotonicNs: String(Math.round(peak.time * 1e9)),
      videoTime: peak.time,
      metadata: {
        source: 'audio',
        loudnessLufs: Number(peak.loudness.toFixed(1)),
      },
    }));
  }
}
