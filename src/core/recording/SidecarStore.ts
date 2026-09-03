import { writeFileSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { GameEvent, GameKey, RecordingSidecar, RecordingRecord } from '../../shared/types';
import { createLogger } from '../logging/Logger';

const log = createLogger('Recovery');

const SIDECAR_VERSION = 1;

/**
 * Gestiona el fichero `recording.json` que acompana a cada `.mp4`.
 *
 * Cumple dos funciones:
 *
 *  1. **Formato de intercambio.** Es el JSON que pediste: el video y sus
 *     eventos viajan juntos, legibles sin la aplicacion ni la base de datos.
 *
 *  2. **Diario de recuperacion.** Se reescribe periodicamente durante la
 *     grabacion. Si Windows se apaga o la aplicacion muere, los eventos ya
 *     estan en disco y se pueden recuperar al siguiente arranque.
 *
 * La escritura es atomica: se escribe en un fichero temporal y se renombra.
 * Un rename dentro del mismo volumen es atomico en NTFS, asi que nunca queda
 * un JSON a medio escribir aunque el corte llegue en el peor momento.
 */
export class SidecarStore {
  static pathFor(videoPath: string): string {
    return videoPath.replace(/\.[^.]+$/, '') + '.json';
  }

  /** Escritura atomica del sidecar. Nunca lanza: un fallo aqui no debe parar la grabacion. */
  static write(videoPath: string, sidecar: RecordingSidecar): boolean {
    const target = SidecarStore.pathFor(videoPath);
    const temp = target + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(sidecar, null, 2), 'utf8');
      renameSync(temp, target);
      return true;
    } catch (err) {
      log.warn(`No se pudo escribir ${basename(target)}: ${(err as Error).message}`);
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        /* ignorado */
      }
      return false;
    }
  }

  static read(videoPath: string): RecordingSidecar | null {
    const target = SidecarStore.pathFor(videoPath);
    if (!existsSync(target)) return null;
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as RecordingSidecar;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        log.warn(`Sidecar ${basename(target)} con formato invalido`);
        return null;
      }
      return parsed;
    } catch (err) {
      log.warn(`No se pudo leer ${basename(target)}: ${(err as Error).message}`);
      return null;
    }
  }

  static build(params: {
    recordingId: string;
    game: GameKey;
    videoPath: string;
    startedAtMs: number;
    endedAtMs?: number | null;
    durationSec?: number | null;
    resolution?: string | null;
    fps?: number | null;
    encoder?: string | null;
    status: RecordingRecord['status'];
    events: GameEvent[];
  }): RecordingSidecar {
    return {
      version: SIDECAR_VERSION,
      recordingId: params.recordingId,
      game: params.game,
      startTime: new Date(params.startedAtMs).toISOString(),
      startTimeEpochMs: params.startedAtMs,
      endTime: params.endedAtMs ? new Date(params.endedAtMs).toISOString() : undefined,
      duration: params.durationSec ?? undefined,
      resolution: params.resolution ?? undefined,
      fps: params.fps ?? undefined,
      encoder: params.encoder ?? undefined,
      video: basename(params.videoPath),
      status: params.status,
      events: params.events.map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        videoTime: e.videoTime,
        metadata: e.metadata,
      })),
    };
  }
}
