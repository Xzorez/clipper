import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GameDetectionService } from '../src/core/detection/GameDetectionService';
import { AdapterRegistry } from '../src/core/games/registry';
import { BaseGameAdapter, AdapterOutput } from '../src/core/games/GameAdapter';
import { isNotAGame, pickGame } from '../src/core/detection/GenericGameDetector';
import { DetectionState, GameKey } from '../src/shared/types';

/**
 * Quien manda cuando se detectan dos juegos a la vez.
 *
 * Esto no es un caso de laboratorio. El 6 de septiembre, cinco minutos despues
 * de empezar a grabar una partida de Rainbow Six, el lanzador anti-trampas de
 * Ubisoft abrio su ventana desde la carpeta del juego y el detector generico lo
 * tomo por un juego distinto. La deteccion nueva pisaba el juego activo sin
 * cerrar nada, asi que FFmpeg se quedo escribiendo un fichero que ya no
 * figuraba en ninguna parte: hora y media despues seguia creciendo, con 1,1 GB
 * y sin forma de pararlo desde la aplicacion.
 */

/** Adaptador de mentira, para no arrastrar la logica real de cada juego. */
class FakeAdapter extends BaseGameAdapter {
  readonly gepGameId = 0;

  constructor(
    readonly game: GameKey,
    readonly displayName: string,
    readonly processNames: string[],
  ) {
    super();
  }

  requiredFeatures(): string[] | null {
    return null;
  }

  normalizeEvent(): AdapterOutput {
    return { events: [] };
  }
}

class FakeRecordingManager extends EventEmitter {
  isRecording = false;
  starts: string[] = [];
  stops = 0;

  async start(options: { adapter: { game: string } }): Promise<boolean> {
    this.starts.push(options.adapter.game);
    this.isRecording = true;
    return true;
  }

  async stop(): Promise<void> {
    this.stops++;
    this.isRecording = false;
  }
}

class FakeWatcher extends EventEmitter {
  start(): void {}
  stop(): void {}
  dispose(): void {}
}

class FakeGep extends EventEmitter {
  initialize(): void {}
  dispose(): void {}
}

class FakeGeneric extends EventEmitter {
  setKnownProcessNames(): void {}
  start(): void {}
  dispose(): void {}
}

function setup() {
  const r6 = new FakeAdapter('rainbowsix', 'Rainbow Six Siege', ['rainbowsix.exe']);
  const generic = new FakeAdapter('generic', 'Juego', []);
  const registry = new AdapterRegistry([r6, generic]);

  const recordingManager = new FakeRecordingManager();
  const genericDetector = new FakeGeneric();
  const processWatcher = new FakeWatcher();

  const settings = {
    games: { valorant: true, rainbowsix: true, lol: true, generic: true },
    recording: { autoRecord: true },
    events: { r6RoundOffsetMs: 0 },
  };

  const service = new GameDetectionService(
    registry,
    new FakeGep() as never,
    processWatcher as never,
    { ingest: vi.fn() } as never,
    recordingManager as never,
    { get: () => settings } as never,
    undefined,
    undefined,
    undefined,
    genericDetector as never,
  );

  return { service, recordingManager, genericDetector, processWatcher, r6, generic };
}

/** El lanzador anti-trampas tal y como lo vio el detector generico. */
const LANZADOR = {
  pid: 2,
  processName: 'sen_launcher.exe',
  title: 'Ubisoft Anti-Cheat Launcher',
  path: 'C:/Games/R6/sen_launcher.exe',
};

describe('prioridad entre juegos detectados a la vez', () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  /** Detecta Rainbow Six como lo haria el vigilante de procesos. */
  function detectarRainbowSix() {
    env.processWatcher.emit('game-detected', {
      adapter: env.r6,
      pid: 1,
      processName: 'RainbowSix.exe',
    });
  }

  async function grabarRainbowSix() {
    detectarRainbowSix();
    await vi.waitFor(() => expect(env.recordingManager.isRecording).toBe(true));
  }

  it('un juego generico no le quita la grabacion al que se esta jugando', async () => {
    await grabarRainbowSix();

    env.genericDetector.emit('game-detected', LANZADOR);
    await new Promise((r) => setTimeout(r, 20));

    // Una sola grabacion, la de Rainbow Six, y sigue viva y a su nombre.
    expect(env.recordingManager.starts).toEqual(['rainbowsix']);
    expect(env.recordingManager.stops).toBe(0);
    expect(env.service.getSnapshot().game).toBe('rainbowsix');
    expect(env.service.getSnapshot().state).toBe(DetectionState.RECORDING);
  });

  it('tampoco se la quita si llega mientras la grabacion esta arrancando', async () => {
    // La ventana entre "juego detectado" y "grabando" es justo donde caia
    // antes: el estado todavia no era RECORDING y el filtro no veia nada.
    detectarRainbowSix();
    env.genericDetector.emit('game-detected', LANZADOR);

    await vi.waitFor(() => expect(env.recordingManager.isRecording).toBe(true));
    await new Promise((r) => setTimeout(r, 20));

    expect(env.recordingManager.starts).toEqual(['rainbowsix']);
    expect(env.service.getSnapshot().game).toBe('rainbowsix');
  });

  it('un juego con marcadores si releva a uno generico, cerrando el video anterior', async () => {
    // Al reves si compensa: el generico solo graba y Rainbow Six trae
    // marcadores. Pero el relevo tiene que cerrar la grabacion en curso, no
    // abandonarla.
    env.genericDetector.emit('game-detected', {
      pid: 2,
      processName: 'otrojuego.exe',
      title: 'Otro juego',
      path: 'C:/Games/Otro/otrojuego.exe',
    });
    await vi.waitFor(() => expect(env.recordingManager.starts).toEqual(['generic']));

    detectarRainbowSix();
    await vi.waitFor(() => expect(env.recordingManager.starts.length).toBe(2));

    expect(env.recordingManager.starts).toEqual(['generic', 'rainbowsix']);
    // Lo importante: la primera se cerro antes de abrir la segunda.
    expect(env.recordingManager.stops).toBe(1);
    expect(env.service.getSnapshot().game).toBe('rainbowsix');
  });

  it('el estado dice RECORDING cuando se vuelve a detectar el juego que ya se graba', async () => {
    await grabarRainbowSix();

    // Antes se quedaba en GAME_DETECTED con la grabacion en marcha, y la
    // ventana anunciaba "LISTO" durante toda la partida.
    await env.service.beginRecording();
    expect(env.service.getSnapshot().state).toBe(DetectionState.RECORDING);
  });
});

describe('lanzadores y anti-trampas no son juegos', () => {
  it('descarta el lanzador anti-trampas de Ubisoft', () => {
    expect(isNotAGame('sen_launcher.exe')).toBe(true);
  });

  it('descarta cualquier lanzador y cualquier anti-trampas', () => {
    expect(isNotAGame('MiJuegoLauncher.exe')).toBe(true);
    expect(isNotAGame('EasyAntiCheat.exe')).toBe(true);
    expect(isNotAGame('EasyAntiCheat_EOS.exe')).toBe(true);
  });

  it('sigue aceptando un juego normal', () => {
    expect(isNotAGame('Hades.exe')).toBe(false);
    expect(isNotAGame('RainbowSix.exe')).toBe(false);
  });

  it('no elige el lanzador aunque viva en la carpeta del juego', () => {
    const found = pickGame(
      [
        {
          Id: 2,
          ProcessName: 'sen_launcher',
          MainWindowTitle: 'Ubisoft Anti-Cheat Launcher',
          Path: 'C:/Steam/steamapps/common/Rainbow Six Siege/sen_launcher.exe',
        },
      ],
      [],
    );
    expect(found).toBeNull();
  });
});
