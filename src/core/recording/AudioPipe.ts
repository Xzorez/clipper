import { createServer, Server, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { AUDIO_BYTES_PER_SECOND } from './captureArgs';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

const PIPE_PREFIX = '\\\\.\\pipe\\';

/**
 * Cada cuanto se entrega audio a FFmpeg.
 *
 * Corto a proposito: FFmpeg avanza al ritmo de su entrada mas lenta, asi que
 * cualquier retraso aqui se convierte en imagen perdida.
 */
const PUMP_INTERVAL_MS = 100;
/**
 * Tope de lo que se guarda esperando a que FFmpeg conecte.
 *
 * Un segundo y medio basta de sobra para el arranque. Sin tope, si FFmpeg no
 * llegara a abrir la tuberia, la memoria creceria sin freno durante toda la
 * partida.
 */
const MAX_PENDING_BYTES = Math.round(AUDIO_BYTES_PER_SECOND * 1.5);

/** De donde viene cada trozo de audio. */
export type AudioTrack = 'system' | 'mic';

/** Redondea a muestra completa: media muestra intercambiaria los canales. */
function align(bytes: number): number {
  return Math.max(0, bytes - (bytes % 4));
}

/**
 * Tuberia con nombre por la que se le pasa el audio a FFmpeg.
 *
 * Windows no expone ningun dispositivo de captura del sonido del sistema, asi
 * que el audio no puede entrar por `-f dshow` como el video entra por ddagrab.
 * Se captura por otro lado y se entrega aqui ya mezclado y en crudo.
 *
 * ## Por que esto entrega a reloj y no segun llega
 *
 * FFmpeg avanza al ritmo de su entrada mas lenta. Si el audio llega tarde, no
 * se retrasa solo el sonido: se frena la captura entera y el video pierde
 * fotogramas. Medido en esta maquina, con el audio llegando al 77% del tiempo
 * real, cuarenta y cinco segundos de partida dejaron treinta y cinco de video.
 * Le paso a una partida de League of Legends de verdad: dos mil doscientos
 * sesenta y nueve segundos jugados, mil setecientos treinta grabados, y una
 * cuarta parte de la partida perdida.
 *
 * Y llega tarde con facilidad, porque quien captura el sonido es la ventana, y
 * la ventana suele estar escondida en la bandeja mientras se juega: Chromium
 * frena lo que no se ve.
 *
 * Por eso la tuberia no reenvia lo que le dan cuando se lo dan. Lleva su
 * propio reloj y entrega exactamente los bytes que corresponden al tiempo
 * transcurrido: si el productor va corto, completa con silencio; si va
 * sobrado, se queda esperando. FFmpeg nunca espera por el audio, y un segundo
 * de grabacion ocupa siempre un segundo de pista.
 */
export class AudioPipe {
  readonly path: string;
  private server: Server | null = null;
  private socket: Socket | null = null;
  /**
   * Una cola por fuente.
   *
   * El sonido del sistema y el microfono llegan por caminos distintos y a su
   * propio ritmo, asi que no se pueden encadenar en una sola cola: hay que
   * juntarlos muestra a muestra en el momento de entregarlos.
   */
  private readonly pending: Record<AudioTrack, Buffer[]> = { system: [], mic: [] };
  private readonly pendingBytes: Record<AudioTrack, number> = { system: 0, mic: 0 };
  private pump: NodeJS.Timeout | null = null;
  private closed = false;
  private silencePadded = 0;
  /** Instante en que FFmpeg empezo a leer. Origen del reloj de la pista. */
  private startedAt = 0;
  /** Bytes ya entregados. Comparado con el reloj, dice si vamos cortos. */
  private written = 0;

  constructor(id = randomBytes(6).toString('hex')) {
    this.path = PIPE_PREFIX + 'clipper-audio-' + id;
  }

  /** Deja la tuberia escuchando. Hay que llamarlo antes de lanzar FFmpeg. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        log.info('FFmpeg ha conectado con la tuberia de audio');
        this.socket = socket;
        // El reloj de la pista empieza cuando FFmpeg empieza a leer, no cuando
        // la tuberia se pone a escuchar: entre las dos cosas puede pasar un
        // segundo largo de arranque que no forma parte del video.
        this.startedAt = Date.now();
        this.written = 0;
        socket.on('error', () => {
          // FFmpeg cierra su extremo al terminar; no es un fallo.
          this.socket = null;
        });
        socket.on('close', () => {
          this.socket = null;
        });
      });

      server.on('error', (err) => reject(err));
      server.listen(this.path, () => {
        this.server = server;
        this.pump = setInterval(() => this.deliver(), PUMP_INTERVAL_MS);
        resolve();
      });
    });
  }

  /**
   * Encola un trozo de audio en crudo (PCM 16 bits, 48 kHz, estereo).
   *
   * No se manda en el acto: lo entrega el reloj. Aqui solo se guarda, y se
   * descarta lo mas viejo si nadie lo consume, para que un productor
   * desbocado o un FFmpeg que nunca conecta no se coman la memoria.
   */
  write(chunk: Buffer, track: AudioTrack = 'system'): void {
    if (this.closed) return;
    this.pending[track].push(chunk);
    this.pendingBytes[track] += chunk.length;
    while (this.pendingBytes[track] > MAX_PENDING_BYTES && this.pending[track].length > 1) {
      const dropped = this.pending[track].shift();
      this.pendingBytes[track] -= dropped ? dropped.length : 0;
    }
  }

  /** Silencio escrito para tapar huecos, en milisegundos. Para diagnostico. */
  get paddedSilenceMs(): number {
    return Math.round((this.silencePadded / AUDIO_BYTES_PER_SECOND) * 1000);
  }

  /**
   * Entrega el audio que corresponde al tiempo transcurrido.
   *
   * Se calcula cuantos bytes deberian haberse escrito ya y se completa la
   * diferencia: primero con lo que haya encolado y, si no llega, con silencio.
   * Nunca se escribe de mas, porque la pista quedaria mas larga que el video.
   */
  private deliver(): void {
    if (this.closed || !this.socket) return;

    const elapsedMs = Date.now() - this.startedAt;
    const target = align(Math.round((elapsedMs / 1000) * AUDIO_BYTES_PER_SECOND));
    const missing = target - this.written;
    if (missing <= 0) return;

    const system = this.take('system', missing);
    const mic = this.take('mic', missing);

    if (system.empty && mic.empty) {
      // Nada que entregar: silencio, que es lo que mantiene el audio cuadrado
      // con la imagen cuando quien produce se atasca.
      this.silencePadded += missing;
      this.send(Buffer.alloc(missing));
      return;
    }

    this.send(system.empty ? mic.data : mic.empty ? system.data : mixInto(system.data, mic.data));
  }

  /**
   * Saca exactamente `bytes` de una fuente, rellenando con silencio lo que
   * falte.
   *
   * Devolver siempre el tamano pedido es lo que permite sumar las dos fuentes
   * sin comprobaciones por medio, y que una fuente muda no arrastre a la otra.
   */
  private take(track: AudioTrack, bytes: number): { data: Buffer; empty: boolean } {
    const queue = this.pending[track];
    if (queue.length === 0) return { data: EMPTY, empty: true };

    const out = Buffer.alloc(bytes);
    let filled = 0;
    while (filled < bytes && queue.length > 0) {
      const head = queue[0];
      const take = Math.min(head.length, bytes - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      this.pendingBytes[track] -= take;
      if (take === head.length) queue.shift();
      else queue[0] = head.subarray(take);
    }
    return { data: out, empty: false };
  }

  private send(chunk: Buffer): void {
    this.socket?.write(chunk);
    this.written += chunk.length;
  }

  /** Cierra la tuberia. FFmpeg vera el fin de la entrada y cerrara su pista. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pump) clearInterval(this.pump);
    this.pump = null;
    this.pending.system = [];
    this.pending.mic = [];

    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        /* ya cerrado */
      }
      this.socket = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}

/** Bufer vacio reutilizable: evita reservar memoria en cada ciclo. */
const EMPTY = Buffer.alloc(0);

/**
 * Suma dos pistas muestra a muestra.
 *
 * Se recorta en los extremos en lugar de bajar el volumen: mezclar el juego y
 * la voz rara vez satura, y atenuar siempre por si acaso dejaria toda la
 * grabacion mas baja de lo que deberia.
 */
function mixInto(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i + 1 < a.length; i += 2) {
    const sum = a.readInt16LE(i) + b.readInt16LE(i);
    out.writeInt16LE(sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum, i);
  }
  return out;
}
