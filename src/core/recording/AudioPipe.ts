import { createServer, Server, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { AUDIO_BYTES_PER_SECOND } from './captureArgs';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** Si no llega audio durante este tiempo, se rellena con silencio. */
const GAP_TOLERANCE_MS = 300;
/** Cada cuanto se vigila que el flujo siga llegando. */
const WATCHDOG_MS = 200;
/**
 * Tope de lo que se guarda esperando a que FFmpeg conecte.
 *
 * Un segundo y medio basta de sobra para el arranque. Sin tope, si FFmpeg no
 * llegara a abrir la tuberia, la memoria creceria sin freno durante toda la
 * partida.
 */
const MAX_PENDING_BYTES = Math.round(AUDIO_BYTES_PER_SECOND * 1.5);

/**
 * Tuberia con nombre por la que se le pasa el audio a FFmpeg.
 *
 * Windows no expone ningun dispositivo de captura del sonido del sistema, asi
 * que el audio no puede entrar por `-f dshow` como el video entra por ddagrab.
 * Se captura por otro lado y se entrega aqui ya mezclado y en crudo.
 *
 * Lo importante es que el audio nunca frene al video. Si quien produce el
 * sonido se atasca, la tuberia rellena el hueco con silencio en lugar de
 * dejar a FFmpeg esperando: se pierde un instante de sonido, que es mucho
 * mejor que perder la grabacion entera. Y el relleno mantiene la
 * correspondencia entre segundos de audio y segundos de video, que es lo que
 * evita que el sonido se vaya desplazando respecto a la imagen.
 */
export class AudioPipe {
  readonly path: string;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private lastChunkAt = 0;
  private closed = false;
  private silencePadded = 0;

  constructor(id = randomBytes(6).toString('hex')) {
    this.path = PIPE_PREFIX + 'clipper-audio-' + id;
  }

  /** Deja la tuberia escuchando. Hay que llamarlo antes de lanzar FFmpeg. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        log.info('FFmpeg ha conectado con la tuberia de audio');
        this.socket = socket;
        socket.on('error', () => {
          // FFmpeg cierra su extremo al terminar; no es un fallo.
          this.socket = null;
        });
        socket.on('close', () => {
          this.socket = null;
        });
        this.flushPending();
      });

      server.on('error', (err) => reject(err));
      server.listen(this.path, () => {
        this.server = server;
        this.lastChunkAt = Date.now();
        this.watchdog = setInterval(() => this.fillGap(), WATCHDOG_MS);
        resolve();
      });
    });
  }

  /** Entrega un trozo de audio en crudo (PCM 16 bits, 48 kHz, estereo). */
  write(chunk: Buffer): void {
    if (this.closed) return;
    this.lastChunkAt = Date.now();

    if (!this.socket) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
        const dropped = this.pending.shift();
        this.pendingBytes -= dropped ? dropped.length : 0;
      }
      return;
    }
    this.socket.write(chunk);
  }

  /** Silencio escrito para tapar huecos, en milisegundos. Para diagnostico. */
  get paddedSilenceMs(): number {
    return Math.round((this.silencePadded / AUDIO_BYTES_PER_SECOND) * 1000);
  }

  private flushPending(): void {
    if (!this.socket) return;
    for (const chunk of this.pending) this.socket.write(chunk);
    this.pending = [];
    this.pendingBytes = 0;
  }

  /**
   * Tapa con silencio el tiempo que lleva sin llegar audio.
   *
   * Sin esto, un paron de dos segundos no dejaria dos segundos de silencio:
   * dejaria el resto del sonido adelantado dos segundos respecto a la imagen,
   * y el desfase se arrastraria hasta el final de la partida.
   */
  private fillGap(): void {
    if (this.closed || !this.socket) return;
    const gap = Date.now() - this.lastChunkAt;
    if (gap < GAP_TOLERANCE_MS) return;

    const bytes = Math.round((gap / 1000) * AUDIO_BYTES_PER_SECOND);
    // Alineado a muestra completa: media muestra desplazaria los canales.
    const aligned = bytes - (bytes % 4);
    if (aligned <= 0) return;

    this.socket.write(Buffer.alloc(aligned));
    this.silencePadded += aligned;
    this.lastChunkAt = Date.now();
  }

  /** Cierra la tuberia. FFmpeg vera el fin de la entrada y cerrara su pista. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
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
