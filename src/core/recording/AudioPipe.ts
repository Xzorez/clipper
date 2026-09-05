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
  private pending: Buffer[] = [];
  private pendingBytes = 0;
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
  write(chunk: Buffer): void {
    if (this.closed) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      const dropped = this.pending.shift();
      this.pendingBytes -= dropped ? dropped.length : 0;
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
    let missing = target - this.written;
    if (missing <= 0) return;

    while (missing > 0 && this.pending.length > 0) {
      const head = this.pending[0];
      if (head.length <= missing) {
        this.send(head);
        this.pending.shift();
        this.pendingBytes -= head.length;
        missing -= head.length;
      } else {
        const part = head.subarray(0, align(missing));
        if (part.length === 0) break;
        this.pending[0] = head.subarray(part.length);
        this.pendingBytes -= part.length;
        this.send(part);
        missing -= part.length;
      }
    }

    // Lo que falte va en silencio. Es la pieza que impide que un productor
    // lento arrastre a la captura entera.
    const pad = align(missing);
    if (pad > 0) {
      this.send(Buffer.alloc(pad));
      this.silencePadded += pad;
    }
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
    this.pending = [];

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
