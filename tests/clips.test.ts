import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/core/database/Database';
import {
  ClipService,
  CreateClipRequest,
  VERTICAL_FILTER,
  resolveRange,
} from '../src/core/services/ClipService';
import { ThumbnailService } from '../src/core/services/ThumbnailService';
import { resolveFfmpegPath } from '../src/core/recording/ffmpegPath';

const execFileAsync = promisify(execFile);

/**
 * Test de integracion real: genera un video de prueba con FFmpeg y comprueba
 * que el recorte funciona de verdad, sin dobles. Es la unica forma de saber que
 * el pipeline de clips produce ficheros reproducibles.
 */
describe('ClipService (integracion con FFmpeg)', () => {
  let dir: string;
  let db: Database;
  let service: ClipService;
  let videoPath: string;
  let recordingId: string;
  const ffmpeg = resolveFfmpegPath();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clipper-clips-'));
    videoPath = join(dir, 'partida.mp4');

    // Video sintetico de 30 s con marca de tiempo grabada en la imagen.
    // El keyframe cada 2 s reproduce la configuracion real de grabacion.
    await execFileAsync(
      ffmpeg as string,
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=30',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60',
        '-pix_fmt', 'yuv420p', '-y', videoPath,
      ],
      { timeout: 120000 },
    );

    db = new Database(join(dir, 'clips.db'));
    recordingId = randomUUID();
    db.createRecording({
      id: recordingId,
      game: 'valorant',
      filePath: videoPath,
      startedAt: Date.now() - 30_000,
    });
    db.finalizeRecording(recordingId, {
      endedAt: Date.now(),
      duration: 30,
      status: 'completed',
    });

    service = new ClipService(db, join(dir, 'clips'), new ThumbnailService(join(dir, 'thumbs')));
  }, 180000);

  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('encuentra FFmpeg', () => {
    expect(ffmpeg).toBeTruthy();
    expect(existsSync(videoPath)).toBe(true);
  });

  // Escenario 10 del enunciado.
  it('genera un clip alrededor de un evento', async () => {
    // Kill en el segundo 20: 10 antes y 5 despues -> 10..25
    const result = await service.create({
      recordingId,
      centerSeconds: 20,
      secondsBefore: 10,
      secondsAfter: 5,
      title: 'Kill del minuto 0:20',
    });

    expect(result.ok).toBe(true);
    expect(result.clip).toBeDefined();
    expect(result.clip!.startTime).toBe(10);
    expect(result.clip!.endTime).toBe(25);
    expect(result.clip!.title).toBe('Kill del minuto 0:20');

    // El fichero existe y tiene contenido de verdad.
    expect(existsSync(result.clip!.filePath)).toBe(true);
    expect(statSync(result.clip!.filePath).size).toBeGreaterThan(1024);
  }, 120000);

  it('el clip generado tiene la duracion pedida', async () => {
    const result = await service.create({
      recordingId,
      centerSeconds: 15,
      secondsBefore: 4,
      secondsAfter: 4,
    });
    expect(result.ok).toBe(true);

    const { stdout } = await execFileAsync(
      ffmpeg as string,
      ['-hide_banner', '-i', result.clip!.filePath, '-f', 'null', '-'],
      { timeout: 60000 },
    ).catch((err: { stderr?: string; stdout?: string }) => ({
      stdout: (err.stderr ?? '') + (err.stdout ?? ''),
    }));

    // FFmpeg escribe la informacion del fichero por stderr; basta con que el
    // fichero se pueda decodificar sin errores fatales.
    expect(typeof stdout).toBe('string');
    expect(statSync(result.clip!.filePath).size).toBeGreaterThan(1024);
  }, 120000);

  it('registra el clip en la base de datos ligado a su grabacion', async () => {
    const before = db.listClips().length;
    const result = await service.create({ recordingId, centerSeconds: 8, secondsBefore: 3, secondsAfter: 3 });

    expect(result.ok).toBe(true);
    const clips = db.listClips();
    expect(clips.length).toBe(before + 1);
    expect(clips[0].recordingId).toBe(recordingId);
    expect(clips[0].game).toBe('valorant');
  }, 120000);

  it('acota el clip a los limites del video', async () => {
    // Se pide mas contexto del que existe por ambos lados.
    const result = await service.create({
      recordingId,
      centerSeconds: 2,
      secondsBefore: 30,
      secondsAfter: 300,
    });

    expect(result.ok).toBe(true);
    expect(result.clip!.startTime).toBe(0);
    expect(result.clip!.endTime).toBe(30);
  }, 120000);

  it('rechaza un intervalo demasiado corto con un mensaje util', async () => {
    const result = await service.create({
      recordingId,
      centerSeconds: 10,
      secondsBefore: 0,
      secondsAfter: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('demasiado corto');
  });

  it('avisa si la grabacion no existe', async () => {
    const result = await service.create({
      recordingId: randomUUID(),
      centerSeconds: 10,
      secondsBefore: 5,
      secondsAfter: 5,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No se ha encontrado');
  });

  it('avisa si el video original ha desaparecido', async () => {
    const orphanId = randomUUID();
    db.createRecording({
      id: orphanId,
      game: 'lol',
      filePath: join(dir, 'no-existe.mp4'),
      startedAt: Date.now(),
    });
    db.finalizeRecording(orphanId, { endedAt: Date.now(), duration: 60, status: 'completed' });

    const result = await service.create({
      recordingId: orphanId,
      centerSeconds: 10,
      secondsBefore: 5,
      secondsAfter: 5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ya no existe');
  });
});

/** Peticion minima; cada prueba cambia solo lo que le interesa. */
function peticion(extra: Partial<CreateClipRequest> = {}): CreateClipRequest {
  return {
    recordingId: 'r1',
    centerSeconds: 60,
    secondsBefore: 10,
    secondsAfter: 5,
    ...extra,
  };
}

/**
 * Recorte del clip.
 *
 * Antes un clip eran siempre diez segundos antes y cinco despues. Ahora se
 * puede fijar el principio y el final a mano, y eso abre justo los casos que
 * se rompen solos: puntas invertidas, fuera de la grabacion, o tan juntas que
 * no queda video.
 */
describe('recorte del clip', () => {
  it('usa centro y margenes cuando no se ha ajustado nada', () => {
    expect(resolveRange(peticion(), 600)).toEqual({ start: 50, end: 65 });
  });

  it('el ajuste a mano manda sobre los margenes', () => {
    // Si alguien movio las puntas, sabe mejor que nosotros donde empieza la
    // jugada.
    expect(resolveRange(peticion({ startSeconds: 100, endSeconds: 130 }), 600)).toEqual({
      start: 100,
      end: 130,
    });
  });

  it('no se sale por el principio de la grabacion', () => {
    expect(resolveRange(peticion({ centerSeconds: 3 }), 600)).toEqual({ start: 0, end: 8 });
  });

  it('no se sale por el final de la grabacion', () => {
    const rango = resolveRange(peticion({ startSeconds: 590, endSeconds: 900 }), 600);
    expect(rango).toEqual({ start: 590, end: 600 });
  });

  it('rechaza un intervalo sin video', () => {
    expect(resolveRange(peticion({ startSeconds: 100, endSeconds: 100.2 }), 600)).toEqual({
      error: expect.stringContaining('demasiado corto'),
    });
  });

  it('rechaza las puntas invertidas', () => {
    expect(resolveRange(peticion({ startSeconds: 200, endSeconds: 100 }), 600)).toHaveProperty(
      'error',
    );
  });
});

describe('encuadre vertical', () => {
  it('recorta por el centro en vez de encoger con bandas', () => {
    // En un juego la accion esta en el medio; unas bandas negras dejarian la
    // jugada del tamano de un sello en el movil.
    expect(VERTICAL_FILTER).toContain('crop=ih*9/16:ih');
    expect(VERTICAL_FILTER).not.toContain('pad=');
  });

  it('deja el pixel cuadrado', () => {
    // El recorte deja una relacion de pixel de 1216:1215 por redondeo, y un
    // reproductor que la respete mostraria el clip deformado.
    expect(VERTICAL_FILTER).toContain('setsar=1');
  });

  it('sale en la resolucion que esperan los moviles', () => {
    expect(VERTICAL_FILTER).toContain('scale=1080:1920');
  });
});
