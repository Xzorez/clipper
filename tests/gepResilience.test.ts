import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GepProvider } from '../src/core/gep/GepProvider';
import { AdapterRegistry } from '../src/core/games/registry';
import { ProviderState } from '../src/shared/types';
import { RawGameEvent } from '../src/core/games/GameAdapter';

/**
 * Doble del paquete GEP de ow-electron.
 *
 * Reproduce el contrato real verificado en @overwolf/ow-electron-packages-types:
 * eventos 'game-detected', 'new-game-event', 'new-info-update',
 * 'elevated-privileges-required', 'game-exit' y 'error', y los metodos
 * setRequiredFeatures / getInfo / getFeatures.
 */
class FakeGepApi extends EventEmitter {
  setRequiredFeaturesCalls: Array<{ gameId: number; features: string[] | undefined }> = [];
  failuresRemaining = 0;
  getInfoResult: unknown = { me: { player_name: 'test' } };

  async setRequiredFeatures(gameId: number, features: string[] | undefined): Promise<void> {
    this.setRequiredFeaturesCalls.push({ gameId, features });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('GEP todavia no esta listo para este juego');
    }
  }

  async getInfo(): Promise<unknown> {
    return this.getInfoResult;
  }

  async getFeatures(): Promise<string[]> {
    return ['kill', 'death'];
  }
}

/** Doble de app.overwolf.packages. */
class FakePackages extends EventEmitter {
  gep: FakeGepApi;
  constructor(gep: FakeGepApi) {
    super();
    this.gep = gep;
  }
}

/**
 * Prepara un GepProvider conectado a los dobles, sustituyendo el objeto
 * `app` de Electron que el proveedor consulta.
 */
async function setupProvider() {
  const electron = await import('electron');
  const gepApi = new FakeGepApi();
  const packages = new FakePackages(gepApi);
  (electron.app as unknown as Record<string, unknown>).overwolf = { packages };

  const provider = new GepProvider(new AdapterRegistry());
  const states: ProviderState[] = [];
  provider.on('state', (state: ProviderState) => states.push(state));

  return { provider, gepApi, packages, states };
}

/** Simula que Overwolf anuncia que el paquete gep esta listo. */
function announceReady(packages: FakePackages) {
  packages.emit('ready', {}, 'gep', '1.0.0');
}

/** Simula la deteccion de un juego por parte de GEP. */
function detectGame(gepApi: FakeGepApi, gameId: number, name: string, extra: object = {}) {
  const enable = vi.fn();
  gepApi.emit('game-detected', { enable }, gameId, name, extra);
  return enable;
}

describe('GepProvider', () => {
  beforeEach(async () => {
    const electron = await import('electron');
    delete (electron.app as unknown as Record<string, unknown>).overwolf;
  });

  // Escenario 14: GEP no disponible / desconectado.
  it('degrada con un mensaje claro cuando los paquetes de Overwolf no existen', () => {
    const provider = new GepProvider(new AdapterRegistry());
    const states: ProviderState[] = [];
    provider.on('state', (s: ProviderState) => states.push(s));

    provider.initialize();

    const state = provider.getState();
    expect(state.status).toBe('unavailable');
    expect(state.message).toContain('ow-electron');
    // Lo importante: no lanza. La app sigue funcionando sin eventos.
  });

  it('pasa a estado disponible cuando el paquete se declara listo', async () => {
    const { provider, packages } = await setupProvider();
    provider.initialize();
    expect(provider.getState().status).toBe('connecting');

    announceReady(packages);
    expect(provider.getState().status).toBe('disconnected');
    expect(provider.getState().message).toContain('juego');
  });

  it('avisa si el paquete no consigue inicializarse', async () => {
    const { provider, packages } = await setupProvider();
    provider.initialize();

    packages.emit('failed-to-initialize', {}, 'gep');

    const state = provider.getState();
    expect(state.status).toBe('unavailable');
    expect(state.message).toContain('Dev Mode');
  });

  it('habilita el juego detectado y registra sus features', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    const enable = detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(gepApi.setRequiredFeaturesCalls.length).toBeGreaterThan(0));

    // Sin enable() GEP no envia nada: es obligatorio llamarlo.
    expect(enable).toHaveBeenCalled();
    expect(gepApi.setRequiredFeaturesCalls[0].gameId).toBe(21640);
    expect(gepApi.setRequiredFeaturesCalls[0].features).toContain('kill');
    expect(gepApi.setRequiredFeaturesCalls[0].features).toContain('death');
  });

  it('ignora los juegos que no soportamos', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    detectGame(gepApi, 21566, 'Apex Legends');
    await new Promise((r) => setTimeout(r, 30));

    expect(gepApi.setRequiredFeaturesCalls).toHaveLength(0);
  });

  /**
   * Escenario 15: reintento y reconexion.
   * La propia documentacion de Overwolf avisa de que setRequiredFeatures puede
   * fallar aunque el juego ya este arrancado, y pide reintentar.
   */
  it('reintenta setRequiredFeatures hasta que tiene exito', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    gepApi.failuresRemaining = 3;
    detectGame(gepApi, 21640, 'VALORANT');

    await vi.waitFor(
      () => {
        expect(provider.getState().status).toBe('connected');
      },
      { timeout: 8000 },
    );

    expect(gepApi.setRequiredFeaturesCalls.length).toBe(4);
  }, 15000);

  it('informa del error si los reintentos se agotan', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    gepApi.failuresRemaining = 99;
    detectGame(gepApi, 5426, 'League of Legends');

    await vi.waitFor(
      () => {
        expect(provider.getState().status).toBe('error');
      },
      { timeout: 25000 },
    );
    expect(provider.getState().message).toContain('grabacion continua');
  }, 35000);

  it('reenvia los eventos y los info updates etiquetados', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    gepApi.emit('new-game-event', {}, 21640, { feature: 'kill', key: 'kill', value: 3 });
    gepApi.emit('new-info-update', {}, 21640, {
      feature: 'kill',
      key: 'kills',
      value: 3,
      category: 'kill',
    });

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ feature: 'kill', key: 'kill', value: 3, kind: 'event' });
    expect(received[1]).toMatchObject({ key: 'kills', kind: 'info', category: 'kill' });
  });

  it('descarta payloads malformados sin romperse', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));

    expect(() => {
      gepApi.emit('new-game-event', {}, 21640, null);
      gepApi.emit('new-game-event', {}, 21640, 'no es un objeto');
      gepApi.emit('new-game-event', {}, 21640, {});
    }).not.toThrow();

    // Solo el objeto vacio pasa, y con campos normalizados a cadena vacia.
    expect(received).toHaveLength(1);
    expect(received[0].feature).toBe('');
  });

  it('detecta que el juego requiere privilegios elevados', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    let notified = false;
    provider.on('elevation-required', () => {
      notified = true;
    });

    gepApi.emit('elevated-privileges-required', {}, 21640, 'VALORANT', 4242);

    const state = provider.getState();
    expect(state.status).toBe('elevation-required');
    expect(state.elevationRequired).toBe(true);
    expect(state.message).toContain('administrador');
    expect(notified).toBe(true);
  });

  it('vuelve a estado de espera cuando el juego se cierra', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    let exited = false;
    provider.on('game-exit', () => {
      exited = true;
    });

    detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(provider.getState().status).toBe('connected'));

    gepApi.emit('game-exit', {}, 21640, 'VALORANT', 4242);

    expect(exited).toBe(true);
    expect(provider.getState().status).toBe('disconnected');
  });

  it('un error puntual con juego activo no invalida la sesion', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(provider.getState().status).toBe('connected'));

    gepApi.emit('error', {}, 21640, 'fallo temporal de lectura');

    // Seguimos conectados: GEP se recupera solo de errores puntuales.
    expect(provider.getState().status).toBe('connected');
  });

  it('soporta una reconexion completa tras cerrar y volver a abrir el juego', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(provider.getState().status).toBe('connected'));
    gepApi.emit('game-exit', {}, 21640, 'VALORANT', 1);
    expect(provider.getState().status).toBe('disconnected');

    // El usuario vuelve a abrir el juego.
    detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(provider.getState().status).toBe('connected'));
    expect(gepApi.setRequiredFeaturesCalls.length).toBe(2);
  });

  it('getInfo devuelve null sin juego activo y el estado con juego activo', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    expect(await provider.getInfo()).toBeNull();

    detectGame(gepApi, 21640, 'VALORANT');
    await vi.waitFor(() => expect(provider.getState().status).toBe('connected'));

    expect(await provider.getInfo()).toEqual({ me: { player_name: 'test' } });
  });

  it('dispose deja de emitir', async () => {
    const { provider, gepApi, packages } = await setupProvider();
    provider.initialize();
    announceReady(packages);

    const received: RawGameEvent[] = [];
    provider.on('raw', (raw: RawGameEvent) => received.push(raw));
    provider.dispose();

    gepApi.emit('new-game-event', {}, 21640, { feature: 'kill', key: 'kill', value: 1 });
    expect(received).toHaveLength(0);
  });
});
