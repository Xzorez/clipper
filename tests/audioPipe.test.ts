import { describe, it, expect, afterEach } from 'vitest';
import { connect, Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { AudioPipe } from '../src/core/recording/AudioPipe';
import { AUDIO_BYTES_PER_SECOND } from '../src/core/recording/captureArgs';

/**
 * La tuberia por la que FFmpeg recibe el audio.
 *
 * Lo que se prueba aqui no es que llegue el sonido, sino que llegue *a
 * tiempo*. FFmpeg avanza al ritmo de su entrada mas lenta: si el audio se
 * retrasa, no se retrasa solo el audio, se frena la captura entera y el video
 * pierde imagen. Paso de verdad en una partida de League of Legends, con una
 * cuarta parte de la partida perdida.
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
    await new Promise((r) => setTimeout(r, 30));
    return { pipe, recibido: () => Buffer.concat(trozos) };
  }

  /** Cuantos bytes de audio corresponden a un tiempo dado. */
  const bytesDe = (segundos: number) => segundos * AUDIO_BYTES_PER_SECOND;

  it('entrega a tiempo real aunque el productor vaya lento', async () => {
    // Esta es la prueba del fallo: antes se reenviaba lo que llegaba cuando
    // llegaba, asi que un productor al 60% dejaba a FFmpeg esperando y la
    // captura se comprimia. Ahora el hueco se rellena y el reloj se respeta.
    const { pipe, recibido } = await abrir();

    const lento = setInterval(() => pipe.write(Buffer.alloc(bytesDe(0.06))), 100);
    await new Promise((r) => setTimeout(r, 900));
    clearInterval(lento);

    const entregado = recibido().length;
    // Con margen para la imprecision de los temporizadores, pero muy por
    // encima del 60% que entregaba el productor.
    expect(entregado).toBeGreaterThan(bytesDe(0.7));
    expect(pipe.paddedSilenceMs).toBeGreaterThan(100);
  });

  it('no entrega mas rapido que el tiempo real', async () => {
    // Escribir de mas dejaria la pista de audio mas larga que el video, y el
    // sonido se iria adelantando respecto a la imagen.
    const { pipe, recibido } = await abrir();

    // Diez segundos de audio de golpe, para medio segundo de reloj.
    for (let i = 0; i < 10; i++) pipe.write(Buffer.alloc(bytesDe(1)));
    await new Promise((r) => setTimeout(r, 500));

    expect(recibido().length).toBeLessThan(bytesDe(1));
  });

  it('conserva el contenido cuando el productor va al ritmo', async () => {
    const { pipe, recibido } = await abrir();

    const marca = randomBytes(bytesDe(0.05));
    pipe.write(marca);
    await new Promise((r) => setTimeout(r, 400));

    // Lo entregado empieza por lo que se escribio, sin reordenar ni perder.
    expect(recibido().subarray(0, marca.length).equals(marca)).toBe(true);
  });

  it('guarda lo que llega antes de que FFmpeg conecte', async () => {
    const pipe = new AudioPipe('test-' + randomBytes(4).toString('hex'));
    await pipe.start();
    // Audio producido antes de que nadie escuche: no puede perderse, o el
    // principio de la grabacion saldria mudo.
    const marca = randomBytes(bytesDe(0.05));
    pipe.write(marca);

    const trozos: Buffer[] = [];
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe.path, () => resolve(s));
      s.on('error', reject);
      s.on('data', (d) => trozos.push(d));
    });
    abiertos.push({ pipe, socket });

    await new Promise((r) => setTimeout(r, 400));
    expect(Buffer.concat(trozos).subarray(0, marca.length).equals(marca)).toBe(true);
  });

  it('rellena con silencio cuando el sonido deja de llegar', async () => {
    const { pipe, recibido } = await abrir();
    await new Promise((r) => setTimeout(r, 600));

    expect(pipe.paddedSilenceMs).toBeGreaterThan(300);
    expect(recibido().length).toBeGreaterThan(bytesDe(0.4));
  });

  it('escribe siempre muestras completas', async () => {
    const { pipe, recibido } = await abrir();
    await new Promise((r) => setTimeout(r, 400));
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
    for (let i = 0; i < 100; i++) pipe.write(Buffer.alloc(bytesDe(0.1)));

    const trozos: Buffer[] = [];
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(pipe.path, () => resolve(s));
      s.on('error', reject);
      s.on('data', (d) => trozos.push(d));
    });
    abiertos[abiertos.length - 1].socket = socket;
    await new Promise((r) => setTimeout(r, 300));

    expect(Buffer.concat(trozos).length).toBeLessThan(bytesDe(2));
  });
});
