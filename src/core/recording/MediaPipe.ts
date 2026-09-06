import { createServer, Server, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recording');

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** Tope de lo que se guarda esperando a que FFmpeg conecte. */
const MAX_PENDING_CHUNKS = 120;

/**
 * Tuberia con nombre para pasarle a FFmpeg un flujo ya codificado.
 *
 * A diferencia de la del audio, esta no lleva reloj propio ni rellena huecos:
 * lo que entra ya viene empaquetado en matroska, con sus propias marcas de
 * tiempo, y meterle nada por el medio solo lo estropearia. Aqui el trabajo es
 * no perder ni reordenar nada.
 */
export class MediaPipe {
  readonly path: string;
  private server: Server | null = null;
  private socket: Socket | null = null;
  private pending: Buffer[] = [];
  private closed = false;
  private written = 0;

  constructor(id = randomBytes(6).toString('hex')) {
    this.path = PIPE_PREFIX + 'clipper-video-' + id;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        log.info('FFmpeg ha conectado con la tuberia de video');
        this.socket = socket;
        socket.on('error', () => {
          this.socket = null;
        });
        socket.on('close', () => {
          this.socket = null;
        });
        // Lo acumulado durante el arranque va primero y en orden: son la
        // cabecera del contenedor y los primeros fotogramas, y sin ellos
        // FFmpeg no sabria leer el resto.
        for (const chunk of this.pending) this.send(chunk);
        this.pending = [];
      });

      server.on('error', (err) => reject(err));
      server.listen(this.path, () => {
        this.server = server;
        resolve();
      });
    });
  }

  write(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.socket) {
      this.pending.push(chunk);
      // Si nadie conecta, se deja de acumular en lugar de comerse la memoria.
      if (this.pending.length > MAX_PENDING_CHUNKS) this.pending.shift();
      return;
    }
    this.send(chunk);
  }

  /** Bytes entregados. Sirve para saber si llego a grabarse algo. */
  get bytesWritten(): number {
    return this.written;
  }

  private send(chunk: Buffer): void {
    this.socket?.write(chunk);
    this.written += chunk.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
