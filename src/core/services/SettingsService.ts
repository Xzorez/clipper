import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AppSettings } from '../../shared/types';
import { createLogger } from '../logging/Logger';

const log = createLogger('Settings');

export function defaultSettings(videosDir: string): AppSettings {
  return {
    recording: {
      autoRecord: true,
      quality: 'high',
      resolution: 1080,
      fps: 60,
      bitrate: 12000,
      encoder: 'auto',
      captureMode: 'game',
      outputFolder: join(videosDir, 'Clipper'),
      captureMicrophone: false,
      captureSystemAudio: true,
      minFreeSpaceGb: 5,
      stopAtFreeSpaceGb: 2,
    },
    events: {
      detectKills: true,
      detectDeaths: true,
      detectHeadshots: true,
      detectAssists: true,
      detectRounds: true,
      /**
       * Latencia estimada de deteccion por juego, en milisegundos.
       *
       * GEP no lee memoria del proceso: deriva los eventos de los registros y
       * del estado que el propio juego expone, asi que siempre llega con un
       * pequeno retraso respecto a lo que se ve en pantalla. Estos valores son
       * un punto de partida conservador y el usuario puede calibrarlos desde
       * la pantalla de configuracion viendo si el marcador cae antes o despues
       * de la accion.
       */
      latencyOffsetMs: {
        valorant: 250,
        rainbowsix: 300,
        lol: 400,
        // Los marcadores manuales no llevan compensacion: se ponen justo donde
        // se pulsa la tecla, que es lo que espera quien la pulsa.
        generic: 0,
      },
      // Sin medir contra una partida real no hay forma honesta de estimarlo,
      // asi que se parte de cero y el usuario lo ajusta una vez.
      r6RoundOffsetMs: 0,
    },
    ui: {
      theme: 'dark',
      showIcons: true,
      showLabels: false,
      iconSize: 'medium',
      playFromSecondsBefore: 3,
      playFromBeforeEnabled: true,
    },
    clips: {
      secondsBefore: 10,
      secondsAfter: 5,
    },
    hotkeys: {
      saveClip: 'F8',
      bookmark: 'F9',
      toggleRecording: 'F10',
    },
    games: {
      generic: true,
      valorant: true,
      rainbowsix: true,
      lol: true,
    },
  };
}

/**
 * Configuracion persistida en JSON.
 *
 * Se valida y se fusiona con los valores por defecto en cada carga, asi que un
 * fichero corrupto, incompleto o de una version anterior nunca deja la
 * aplicacion sin arrancar: se completa con lo que falte.
 */
export class SettingsService extends EventEmitter {
  private readonly filePath: string;
  private settings: AppSettings;

  constructor(userDataDir: string, videosDir: string) {
    super();
    this.filePath = join(userDataDir, 'settings.json');
    this.settings = this.load(videosDir);
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  private load(videosDir: string): AppSettings {
    const defaults = defaultSettings(videosDir);
    if (!existsSync(this.filePath)) return defaults;

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>;
      const merged = deepMerge(defaults, raw) as AppSettings;
      return sanitize(merged, defaults);
    } catch (err) {
      log.warn(
        `No se pudo leer la configuracion (${(err as Error).message}); ` +
          'se usan los valores por defecto',
      );
      return defaults;
    }
  }

  /** Aplica un parche parcial y persiste. */
  update(patch: DeepPartial<AppSettings>): AppSettings {
    const merged = deepMerge(this.settings, patch) as AppSettings;
    this.settings = sanitize(merged, this.settings);
    this.persist();
    this.emit('changed', this.get());
    return this.get();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temp = this.filePath + '.tmp';
      writeFileSync(temp, JSON.stringify(this.settings, null, 2), 'utf8');
      renameSync(temp, this.filePath);
    } catch (err) {
      log.error(`No se pudo guardar la configuracion: ${(err as Error).message}`);
    }
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  if (typeof patch !== 'object' || Array.isArray(patch)) return base;

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in result)) continue; // ignora claves desconocidas
    result[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return result as T;
}

/** Acota los valores numericos y enumerados a rangos validos. */
function sanitize(settings: AppSettings, fallback: AppSettings): AppSettings {
  const r = settings.recording;
  const allowedResolutions = [720, 1080, 1440, 2160];
  const allowedFps = [30, 60, 120];

  if (!allowedResolutions.includes(r.resolution)) r.resolution = fallback.recording.resolution;
  if (!allowedFps.includes(r.fps)) r.fps = fallback.recording.fps;
  r.bitrate = clamp(Number(r.bitrate) || fallback.recording.bitrate, 1000, 200000);
  r.minFreeSpaceGb = clamp(Number(r.minFreeSpaceGb) || 5, 1, 500);
  r.stopAtFreeSpaceGb = clamp(Number(r.stopAtFreeSpaceGb) || 2, 0.5, r.minFreeSpaceGb);
  if (r.captureMode !== 'game' && r.captureMode !== 'display') {
    r.captureMode = fallback.recording.captureMode;
  }
  if (!r.outputFolder || typeof r.outputFolder !== 'string') {
    r.outputFolder = fallback.recording.outputFolder;
  }

  settings.ui.playFromSecondsBefore = clamp(Number(settings.ui.playFromSecondsBefore) || 3, 0, 60);
  settings.clips.secondsBefore = clamp(Number(settings.clips.secondsBefore) || 10, 1, 120);
  settings.clips.secondsAfter = clamp(Number(settings.clips.secondsAfter) || 5, 1, 120);

  settings.events.r6RoundOffsetMs = clamp(
    Number(settings.events.r6RoundOffsetMs) || 0,
    -120_000,
    120_000,
  );

  for (const key of Object.keys(settings.events.latencyOffsetMs) as Array<
    keyof AppSettings['events']['latencyOffsetMs']
  >) {
    settings.events.latencyOffsetMs[key] = clamp(
      Number(settings.events.latencyOffsetMs[key]) || 0,
      -5000,
      5000,
    );
  }

  return settings;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
