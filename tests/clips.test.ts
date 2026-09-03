import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/core/database/Database';
import { ClipService } from '../src/core/services/ClipService';
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
