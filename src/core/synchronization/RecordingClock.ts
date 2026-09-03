import { Clock, SystemClock, nsToSeconds } from './MonotonicClock';
import { createLogger } from '../logging/Logger';

const log = createLogger('Sync');

/**
 * Correccion maxima que aceptamos de la reconciliacion, en segundos.
 * Si el grabador nos devuelve un startTimeEpoch que implica una correccion
 * mayor que esto, asumimos que el dato es basura y conservamos el ancla
 * provisional en lugar de destrozar todos los marcadores.
 */
const MAX_RECONCILE_SECONDS = 30;

export interface AnchorInfo {
  monotonicNs: bigint;
  wallMs: number;
  authoritative: boolean;
  correctionSec: number;
}

export interface ReconcileResult {
  applied: boolean;
  correctionSec: number;
  reason?: string;
}

/**
 * Traduce instantes de eventos a posiciones dentro del video.
 *
 * ## El problema real
 *
 * El API de grabacion de Overwolf (ow-electron `recorder`) emite
 * `recording-started` con un payload `RecordEventArgs` que contiene `filePath`
 * pero NO contiene `startTimeEpoch`. Ese campo solo aparece en
 * `RecordStopEventArgs` / `SplitRecordArgs` / `ReplayVideo`, es decir, al
 * TERMINAR. Verificado en la especificacion de tipos del paquete oficial.
 *
 * Esto significa que en el instante en que empezamos a grabar no conocemos con
 * exactitud el momento del primer frame: entre que pedimos `startRecording()` y
 * que el encoder escribe el primer frame pasan decenas o cientos de
 * milisegundos (arranque de OBS, negociacion del encoder hardware, captura del
 * proceso del juego).
 *
 * ## La solucion: anclaje en dos fases
 *
 * 1. **Ancla provisional.** Al recibir `recording-started` guardamos el par
 *    (monotonico, reloj de pared). Todos los eventos que llegan durante la
 *    partida se posicionan contra ese ancla usando SOLO el reloj monotonico.
 *    Esto ya es suficientemente bueno para la UI en vivo.
 *
 * 2. **Re-anclaje autoritativo.** Al recibir `recording-stopped` obtenemos el
 *    `startTimeEpoch` real del video. Calculamos la desviacion respecto al ancla
 *    provisional y la aplicamos como una correccion constante a TODOS los
 *    eventos ya almacenados. A partir de ahi los timestamps son exactos.
 *
 * La correccion es una constante porque el desfase es un offset de arranque, no
 * una deriva: dentro de una misma grabacion el reloj monotonico y el reloj del
 * encoder avanzan al mismo ritmo.
 *
 * ## Latencia del proveedor de eventos
 *
 * Aparte del offset del video existe la latencia del propio GEP: detecta la kill
 * un poco DESPUES de que ocurra en pantalla (lee logs y estado del juego, no
 * memoria). Se compensa con `latencyOffsetMs`, configurable por juego, que se
 * resta al posicionar el marcador.
 */
export class RecordingClock {
  private anchorMonoNs: bigint | null = null;
  private anchorWallMs: number | null = null;
  private authoritative = false;
  private correctionSec = 0;
  private readonly clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.clock = clock;
  }

  /** true si ya se ha fijado el ancla (la grabacion ha empezado de verdad). */
  get isArmed(): boolean {
    return this.anchorMonoNs !== null;
  }

  get anchor(): AnchorInfo | null {
    if (this.anchorMonoNs === null || this.anchorWallMs === null) return null;
    return {
      monotonicNs: this.anchorMonoNs,
      wallMs: this.anchorWallMs,
      authoritative: this.authoritative,
      correctionSec: this.correctionSec,
    };
  }

  /**
   * Fase 1: fija el ancla provisional. Se llama al recibir `recording-started`.
   */
  arm(): AnchorInfo {
    this.anchorMonoNs = this.clock.monotonicNs();
    this.anchorWallMs = this.clock.wallMs();
    this.authoritative = false;
    this.correctionSec = 0;
    log.info(
      `Ancla provisional fijada en ${new Date(this.anchorWallMs).toISOString()}`,
    );
    return this.anchor as AnchorInfo;
  }

  /**
   * Fase 2: reconciliacion con el instante real del primer frame.
   * Se llama al recibir `recording-stopped` con su `startTimeEpoch`.
   *
   * @param videoStartEpochMs epoch del primer frame segun el grabador
   * @returns la correccion en segundos que hay que SUMAR a los videoTime
   *          calculados previamente
   */
  reconcile(videoStartEpochMs: number | undefined | null): ReconcileResult {
    if (this.anchorWallMs === null) {
      return { applied: false, correctionSec: 0, reason: 'clock-not-armed' };
    }
    if (
      typeof videoStartEpochMs !== 'number' ||
      !Number.isFinite(videoStartEpochMs) ||
      videoStartEpochMs <= 0
    ) {
      log.warn(
        'El grabador no devolvio startTimeEpoch valido; se conserva el ancla provisional',
      );
      return { applied: false, correctionSec: 0, reason: 'no-epoch' };
    }

    // Si el video empezo DESPUES de nuestra ancla, los videoTime provisionales
    // son demasiado grandes y hay que restarles la diferencia.
    const correctionSec = (this.anchorWallMs - videoStartEpochMs) / 1000;

    if (Math.abs(correctionSec) > MAX_RECONCILE_SECONDS) {
      log.warn(
        `Correccion de ${correctionSec.toFixed(3)}s fuera de rango ` +
          `(limite ${MAX_RECONCILE_SECONDS}s); se descarta por considerarse dato erroneo`,
      );
      return { applied: false, correctionSec: 0, reason: 'out-of-range' };
    }

    this.correctionSec = correctionSec;
    this.authoritative = true;
    log.info(
      `Reconciliacion aplicada: ${correctionSec >= 0 ? '+' : ''}` +
        `${correctionSec.toFixed(3)}s (video real empezo en ` +
        `${new Date(videoStartEpochMs).toISOString()})`,
    );
    return { applied: true, correctionSec };
  }

  /**
   * Calcula la posicion dentro del video para un instante monotonico dado.
   *
   * @param monoNs         instante monotonico en que se recibio el evento
   * @param latencyOffsetMs latencia del proveedor a compensar (se resta)
   */
  videoTimeFor(monoNs: bigint, latencyOffsetMs = 0): number {
    if (this.anchorMonoNs === null) {
      // Todavia no hay video: devolvemos un valor negativo relativo a nada.
      // El EventManager se encarga de bufferizar estos eventos.
      return Number.NEGATIVE_INFINITY;
    }
    const elapsed = nsToSeconds(monoNs - this.anchorMonoNs);
    return elapsed - latencyOffsetMs / 1000 + this.correctionSec;
  }

  /**
   * Segundos transcurridos desde el ancla hasta ahora. Para el contador en vivo.
   */
  elapsedSeconds(): number {
    if (this.anchorMonoNs === null) return 0;
    return nsToSeconds(this.clock.monotonicNs() - this.anchorMonoNs);
  }

  /**
   * Diagnostico: compara el avance del reloj monotonico con el de pared.
   * Una divergencia grande indica que el reloj del sistema salto durante la
   * grabacion, lo que confirma que hicimos bien en no depender de el.
   */
  measureWallDriftMs(): number | null {
    if (this.anchorMonoNs === null || this.anchorWallMs === null) return null;
    const monoElapsedMs = nsToSeconds(this.clock.monotonicNs() - this.anchorMonoNs) * 1000;
    const wallElapsedMs = this.clock.wallMs() - this.anchorWallMs;
    return wallElapsedMs - monoElapsedMs;
  }

  reset(): void {
    this.anchorMonoNs = null;
    this.anchorWallMs = null;
    this.authoritative = false;
    this.correctionSec = 0;
  }
}
