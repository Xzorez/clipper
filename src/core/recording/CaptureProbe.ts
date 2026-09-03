import { spawn } from 'node:child_process';
import { CaptureMethod } from './captureArgs';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

/**
 * Luminancia media por debajo de la cual se considera que la captura esta
 * ciega.
 *
 * El negro puro en rango limitado (16-235) da exactamente 16. Se deja un
 * margen minimo porque ningun contenido real, ni el mapa mas oscuro, baja de
 * ahi: si sale 16 o casi, es que no se esta capturando nada.
 */
export const BLACK_LUMA_THRESHOLD = 17.5;

/** Duracion de cada sondeo. Suficiente para varios fotogramas, corto para el usuario. */
const PROBE_SECONDS = 1.2;
const PROBE_TIMEOUT_MS = 12_000;

export interface CaptureCandidate {
  method: CaptureMethod;
  /** Indice de salida de ddagrab; irrelevante para gdigrab. */
  outputIndex: number;
}

export interface ProbeResult extends CaptureCandidate {
  /** Luminancia media medida, o null si el sondeo fallo. */
  luminance: number | null;
  usable: boolean;
  error?: string;
}

export function candidateKey(candidate: CaptureCandidate): string {
  return candidate.method === 'ddagrab'
    ? `ddagrab:${candidate.outputIndex}`
    : 'gdigrab';
}

export function describeCandidate(candidate: CaptureCandidate): string {
  return candidate.method === 'ddagrab'
    ? `captura por GPU del monitor ${candidate.outputIndex + 1}`
    : 'captura por CPU del escritorio';
}

/**
 * Construye los argumentos de un sondeo: capturar poco tiempo y medir el brillo
 * medio en lugar de escribir un fichero.
 *
 * `signalstats` publica la luminancia media de cada fotograma como metadato y
 * `metadata=print` la vuelca al registro, de donde se lee.
 */
export function buildProbeArgs(candidate: CaptureCandidate, seconds = PROBE_SECONDS): string[] {
  const measure = 'signalstats,metadata=print:key=lavfi.signalstats.YAVG';

  if (candidate.method === 'ddagrab') {
    return [
      '-hide_banner',
      // El nivel debe permitir mensajes informativos: la medida viaja en ellos.
      '-loglevel', 'info',
      '-init_hw_device', 'd3d11va',
      '-filter_complex',
      `ddagrab=output_idx=${candidate.outputIndex}:framerate=10:draw_mouse=0,` +
        `hwdownload,format=bgra,scale=320:-2,format=nv12,${measure}`,
      '-t', String(seconds),
      '-f', 'null',
      '-',
    ];
  }

  return [
    '-hide_banner',
    '-loglevel', 'info',
    '-f', 'gdigrab',
    '-framerate', '10',
    '-i', 'desktop',
    '-vf', `scale=320:-2,${measure}`,
    '-t', String(seconds),
    '-f', 'null',
    '-',
  ];
}

/**
 * Extrae la luminancia media del registro de FFmpeg.
 *
 * Se descartan los primeros valores porque el primer fotograma de una captura
 * suele salir en negro mientras el pipeline arranca, y tomarlo como
 * representativo daria un falso negativo.
 */
export function parseLuminance(output: string): number | null {
  const values: number[] = [];
  const pattern = /YAVG[:=]\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;

  const usable = values.length > 2 ? values.slice(1) : values;
  const sum = usable.reduce((acc, value) => acc + value, 0);
  return sum / usable.length;
}

export type ProbeRunner = (args: string[]) => Promise<string>;

/** Ejecuta FFmpeg y devuelve todo lo que escribio, sin lanzar. */
export function createProbeRunner(ffmpegPath: string): ProbeRunner {
  return (args: string[]) =>
    new Promise<string>((resolve) => {
      let output = '';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      proc.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      proc.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
      proc.on('close', finish);
      proc.on('error', (err) => {
        output += `\nERROR ${err.message}`;
        finish();
      });

      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignorado */
        }
        finish();
      }, PROBE_TIMEOUT_MS);
    });
}

/** Sondea un candidato y decide si sirve. */
export async function probeCandidate(
  run: ProbeRunner,
  candidate: CaptureCandidate,
): Promise<ProbeResult> {
  const output = await run(buildProbeArgs(candidate));
  const luminance = parseLuminance(output);

  if (luminance === null) {
    return {
      ...candidate,
      luminance: null,
      usable: false,
      error: extractError(output),
    };
  }

  return {
    ...candidate,
    luminance,
    usable: luminance > BLACK_LUMA_THRESHOLD,
  };
}

function extractError(output: string): string {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  return line ? line.slice(0, 160) : 'sin salida';
}

/**
 * Lista de candidatos a probar, en orden de preferencia.
 *
 * La captura por GPU va primero porque consume mucho menos y se comporta mejor
 * a pantalla completa. Se incluyen TODOS los monitores: con varias pantallas,
 * fijar la primera grabaria la equivocada si el juego esta en la otra. La
 * captura por CPU cierra la lista como ultimo recurso, porque funciona en
 * configuraciones donde la duplicacion de escritorio falla (por ejemplo con dos
 * tarjetas graficas).
 */
export function buildCandidates(monitorCount: number, supportsDdagrab: boolean): CaptureCandidate[] {
  const candidates: CaptureCandidate[] = [];
  if (supportsDdagrab) {
    const total = Math.max(1, monitorCount);
    for (let index = 0; index < total; index++) {
      candidates.push({ method: 'ddagrab', outputIndex: index });
    }
  }
  candidates.push({ method: 'gdigrab', outputIndex: 0 });
  return candidates;
}

export interface CaptureSelection {
  candidate: CaptureCandidate | null;
  attempts: ProbeResult[];
}

/**
 * Elige automaticamente como capturar.
 *
 * Prueba los candidatos en orden y se queda con el primero que devuelve imagen
 * de verdad. Es lo que evita las dos formas de grabar en balde: la pantalla
 * equivocada cuando hay varios monitores, y el video en negro cuando el metodo
 * no puede ver el juego.
 *
 * Si `preferred` viene informado se prueba primero: es lo que se aprendio la
 * ultima vez con ese juego, y normalmente acierta a la primera.
 */
export async function selectCapture(
  run: ProbeRunner,
  candidates: CaptureCandidate[],
  preferred?: CaptureCandidate | null,
): Promise<CaptureSelection> {
  const ordered = preferred
    ? [preferred, ...candidates.filter((c) => candidateKey(c) !== candidateKey(preferred))]
    : candidates;

  const attempts: ProbeResult[] = [];

  for (const candidate of ordered) {
    const result = await probeCandidate(run, candidate);
    attempts.push(result);

    if (result.usable) {
      log.info(
        `Metodo de captura elegido: ${describeCandidate(candidate)} ` +
          `(brillo medio ${result.luminance?.toFixed(1)})`,
      );
      return { candidate, attempts };
    }

    log.debug(
      `Descartado ${describeCandidate(candidate)}: ` +
        (result.luminance === null
          ? `sin medida (${result.error})`
          : `imagen en negro (brillo ${result.luminance.toFixed(1)})`),
    );
  }

  return { candidate: null, attempts };
}

/**
 * Mensaje para el usuario cuando ningun metodo consigue imagen.
 *
 * Es el unico caso en que hace falta que haga algo, y conviene decirle
 * exactamente que, no un error generico. La causa casi siempre es la misma: el
 * juego esta en pantalla completa exclusiva y se niega a ser capturado.
 */
export function explainFailure(attempts: ProbeResult[]): string {
  const allBlack =
    attempts.length > 0 &&
    attempts.every((a) => a.luminance !== null && a.luminance <= BLACK_LUMA_THRESHOLD);

  if (allBlack) {
    return (
      'La captura sale en negro. Suele pasar cuando el juego esta en pantalla completa ' +
      'exclusiva, un modo que impide grabarlo desde fuera. Cambia en las opciones del juego ' +
      'a "Pantalla completa sin bordes" y volvera a funcionar sin tocar nada mas aqui.'
    );
  }

  return (
    'No se ha podido capturar la pantalla con ningun metodo disponible. ' +
    'Revisa que ningun otro programa este bloqueando la captura.'
  );
}
