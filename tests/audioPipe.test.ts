import { describe, it, expect, afterEach } from 'vitest';
import { connect, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { AudioPipe } from '../src/core/recording/AudioPipe';
import { AUDIO_BYTES_PER_SECOND } from '../src/core/recording/captureArgs';

/**
 * La tuberia por la que FFmpeg recibe el audio.
 *
 * Lo que se prueba aqui no es que "funcione", sino que no arrastre a la
 * grabacion cuando algo va mal: si el productor de sonido se para, FFmpeg no
 * puede quedarse esperando, y el hueco tiene que ocupar en la pista el mismo
 * tiempo que ocupo en la realidad. Si no, el sonido se adelanta y ya no vuelve
 * a cuadrar con la imagen.
 */
describe('AudioPipe', () => {
  const abiertos: Array<{ pipe: AudioPipe; socket: Socket | null }> = [];

  afterEach(async () => {
    for (const { pipe, socket } of abiertos) {
      socket?.destroy();
      await pipe.close();
    }
    abiertos.length = 0;
  });

  /** Abre la tuberia y conecta un lector, como haria FFmpeg. */
  async function abrir(): Promise<{ pipe: AudioPipe; recibido: () => Buffer }> {
    const pipe = new AudioPipe('test-' + randomBytes(4).toString('hex'));
    await pipe.start();

    const trozos: Buffer[] = [];
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe.path, () => resolve(s));
      s.on('error', reject);
      s.on('data', (d) => trozos.push(d));
    });

    abiertos.push({ pipe, socket });
    // Un respiro para que el servidor registre la conexion.
    await new Promise((r) => setTimeout(r, 30));
    return { pipe, recibido: () => Buffer.concat(trozos) };
  }

  it('entrega intacto lo que se le escribe', async () => {
    const { pipe, recibido } = await abrir();
    const datos = randomBytes(800);
    pipe.write(datos);
    await new Promise((r) => setTimeout(r, 80));
    expect(recibido().equals(datos)).toBe(true);
  });

  it('guarda lo que llega antes de que FFmpeg conecte', async () => {
    const pipe = new AudioPipe('test-' + randomBytes(4).toString('hex'));
    await pipe.start();
    const datos = randomBytes(400);
    // Audio producido antes de que nadie escuche: no puede perderse, o el
    // principio de la grabacion saldria mudo.
    pipe.write(datos);

    const trozos: Buffer[] = [];
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe.path, () => resolve(s));
      s.on('error', reject);
      s.on('data', (d) => trozos.push(d));
    });
    abiertos.push({ pipe, socket });

    await new Promise((r) => setTimeout(r, 100));
    expect(Buffer.concat(trozos).equals(datos)).toBe(true);
  });

  it('rellena con silencio cuando el sonido deja de llegar', async () => {
    const { pipe, recibido } = await abrir();
    pipe.write(randomBytes(100));

    // Medio segundo sin producir nada: por encima de la tolerancia.
    await new Promise((r) => setTimeout(r, 600));

    const total = recibido().length;
    expect(pipe.paddedSilenceMs).toBeGreaterThan(200);
    // El relleno debe corresponderse con el tiempo transcurrido, que es lo que
    // mantiene el audio cuadrado con el video.
    const esperado = (pipe.paddedSilenceMs / 1000) * AUDIO_BYTES_PER_SECOND;
    expect(total - 100).toBeGreaterThan(esperado * 0.8);
  });

  it('escribe el silencio alineado a muestras completas', async () => {
    const { pipe, recibido } = await abrir();
    await new Promise((r) => setTimeout(r, 600));
    // Estereo de 16 bits: 4 bytes por muestra. Media muestra intercambiaria
    // los canales a partir de ahi.
    expect(recibido().length % 4).toBe(0);
  });

  it('no crece sin limite si nadie llega a conectar', async () => {
    const pipe = new AudioPipe('test-' + randomBytes(4).toString('hex'));
    await pipe.start();
    abiertos.push({ pipe, socket: null });

    // Diez segundos de audio sin lector: se descarta lo viejo en lugar de
    // acumularlo durante toda la partida.
    for (let i = 0; i < 100; i++) pipe.write(Buffer.alloc(AUDIO_BYTES_PER_SECOND / 10));

    const trozos: Buffer[] = [];
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe.path, () => resolve(s));
      s.on('error', reject);
      s.on('data', (d) => trozos.push(d));
    });
    abiertos[abiertos.length - 1].socket = socket;
    await new Promise((r) => setTimeout(r, 100));

    expect(Buffer.concat(trozos).length).toBeLessThan(AUDIO_BYTES_PER_SECOND * 2);
  });
});
