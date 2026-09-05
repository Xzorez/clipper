/**
 * Momentos destacados deducidos del sonido de la propia grabacion.
 *
 * Fuera de los tres juegos con adaptador, no hay ninguna fuente de datos de la
 * que sacar kills o muertes, y no se puede inventar: hacerlo supondria mirar
 * dentro del proceso del juego o analizar la pantalla mientras se juega. Pero
 * queda una fuente que si es nuestra por completo, el fichero que acabamos de
 * escribir. Un pico de sonido sobre el nivel de fondo casi siempre coincide
 * con que ha pasado algo: un disparo, una explosion, alguien gritando.
 *
 * Es una conjetura, y por eso estos marcadores tienen tipo propio en lugar de
 * mezclarse con los eventos reales del juego: quien mira la linea temporal
 * tiene que poder distinguir lo que se sabe de lo que se supone.
 *
 * Todo esto ocurre cuando la partida ya ha terminado, sobre un MP4 en disco.
 * No toca el juego de ninguna manera.
 */

/** Un instante de la grabacion con su sonoridad momentanea, en LUFS. */
export interface LoudnessSample {
  /** Segundos desde el principio del video. */
  time: number;
  /** Sonoridad momentanea. Cuanto mas negativo, mas silencio. */
  loudness: number;
}

export interface PeakOptions {
  /** Distancia minima entre dos momentos, para no marcar una rafaga entera. */
  minGapSeconds: number;
  /** Cuanto tiene que destacar sobre el nivel de fondo, en LU. */
  minRiseLu: number;
  /** Tope de marcadores por partida. */
  maxHighlights: number;
  /** Segundos iniciales que se ignoran (menus, carga, tu propia voz de entrada). */
  ignoreFirstSeconds: number;
}

export const DEFAULT_PEAK_OPTIONS: PeakOptions = {
  minGapSeconds: 12,
  minRiseLu: 9,
  maxHighlights: 15,
  ignoreFirstSeconds: 10,
};

/**
 * Por debajo de esto se considera silencio y no cuenta para el nivel de fondo.
 *
 * Sin este filtro, una partida con largos ratos callados bajaria la referencia
 * y cualquier ruido normal pareceria un momentazo.
 */
const SILENCE_FLOOR_LUFS = -70;

/** Argumentos para que FFmpeg escupa la curva de sonoridad y nada mas. */
export function buildAnalysisArgs(filePath: string): string[] {
  return [
    '-hide_banner',
    '-v', 'error',
    '-i', filePath,
    // Sin video: descodificar la imagen para medir el sonido seria tirar el
    // tiempo. Asi una partida de veinte minutos se analiza en segundos.
    '-vn',
    '-af', 'ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=-',
    '-f', 'null',
    '-',
  ];
}

/**
 * Lee la curva que imprime FFmpeg.
 *
 * La salida viene en pares de lineas: primero el instante, luego el valor.
 *
 *   frame:12   pts:576000   pts_time:12.0
 *   lavfi.r128.M=-23.4
 */
export function parseLoudness(output: string): LoudnessSample[] {
  const samples: LoudnessSample[] = [];
  let time: number | null = null;

  for (const line of output.split('\n')) {
    const atTime = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (atTime) {
      time = Number(atTime[1]);
      continue;
    }
    const atValue = /lavfi\.r128\.M=(-?[0-9]+(?:\.[0-9]+)?|-inf)/.exec(line);
    if (atValue && time !== null) {
      const loudness = atValue[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(atValue[1]);
      if (Number.isFinite(loudness)) samples.push({ time, loudness });
      time = null;
    }
  }
  return samples;
}

/** Mediana. Se usa como nivel de fondo por no dejarse arrastrar por los picos. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Encuentra los instantes que destacan sobre el resto de la partida.
 *
 * El nivel de referencia es la mediana y no la media, porque la media la
 * levantan justo los momentos que buscamos: unos cuantos tiroteos fuertes
 * subirian el liston hasta taparse a si mismos.
 *
 * Los candidatos se recorren de mas fuerte a mas flojo y se van quedando los
 * que esten suficientemente lejos de los ya elegidos. Asi una rafaga larga
 * deja un marcador en su punto mas alto en lugar de treinta seguidos.
 */
export function findPeaks(
  samples: LoudnessSample[],
  options: PeakOptions = DEFAULT_PEAK_OPTIONS,
): LoudnessSample[] {
  const audibles = samples.filter(
    (s) => s.loudness > SILENCE_FLOOR_LUFS && s.time >= options.ignoreFirstSeconds,
  );
  if (audibles.length < 10) return [];

  const baseline = median(audibles.map((s) => s.loudness));
  const threshold = baseline + options.minRiseLu;

  const candidates = audibles
    .filter((s) => s.loudness >= threshold)
    .sort((a, b) => b.loudness - a.loudness);

  const chosen: LoudnessSample[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= options.maxHighlights) break;
    const tooClose = chosen.some(
      (kept) => Math.abs(kept.time - candidate.time) < options.minGapSeconds,
    );
    if (!tooClose) chosen.push(candidate);
  }

  return chosen.sort((a, b) => a.time - b.time);
}
