import { describe, it, expect, beforeEach } from 'vitest';
import { EventManager, summarize } from '../src/core/events/EventManager';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';
import { FakeClock } from '../src/core/synchronization/MonotonicClock';
import { ValorantAdapter } from '../src/core/games/ValorantAdapter';
import { RainbowSixAdapter } from '../src/core/games/RainbowSixAdapter';
import { EventSettings, GameEvent, GameEventType } from '../src/shared/types';
import { RawGameEvent } from '../src/core/games/GameAdapter';

function settings(overrides: Partial<EventSettings> = {}): EventSettings {
  return {
    detectKills: true,
    detectDeaths: true,
    detectHeadshots: true,
    detectAssists: true,
    detectRounds: true,
    latencyOffsetMs: { valorant: 0, rainbowsix: 0, lol: 0 },
    ...overrides,
  };
}

function evt(feature: string, key: string, value: unknown): RawGameEvent {
  return { gameId: 21640, feature, key, value, kind: 'event' };
}

describe('EventManager', () => {
  let clock: FakeClock;
  let recordingClock: RecordingClock;
  let manager: EventManager;

  beforeEach(() => {
    clock = new FakeClock();
    recordingClock = new RecordingClock(clock);
    manager = new EventManager({ clock, recordingClock });
  });

  it('sella cada evento con su posicion dentro del video', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();

    clock.advanceMs(12_500);
    const created = manager.ingest(evt('kill', 'kill', 1));

    expect(created).toHaveLength(1);
    expect(created[0].type).toBe(GameEventType.KILL);
    expect(created[0].videoTime).toBeCloseTo(12.5, 3);
    expect(created[0].game).toBe('valorant');
    expect(created[0].id).toBeTruthy();
    expect(created[0].monotonicNs).toBeTruthy();
  });

  /**
   * El juego se detecta y GEP empieza a emitir antes de que el encoder haya
   * escrito el primer frame. Esos eventos no se pueden tirar: se guardan con su
   * marca monotonica y se colocan en cuanto existe el ancla.
   */
  it('bufferiza los eventos anteriores al primer frame y los vuelca al anclar', () => {
    manager.begin(new ValorantAdapter(), settings());

    // Llega una kill antes de que arranque el video.
    expect(manager.ingest(evt('kill', 'kill', 1))).toHaveLength(0);
    expect(manager.getEvents()).toHaveLength(0);

    clock.advanceMs(800);
    recordingClock.arm();
    manager.onRecordingAnchored();

    const events = manager.getEvents();
    expect(events).toHaveLength(1);
    // El evento precede al video: se conserva marcado y fijado a 0.
    expect(events[0].beforeRecording).toBe(true);
    expect(events[0].videoTime).toBe(0);
  });

  it('respeta los filtros de la configuracion', () => {
    manager.begin(new ValorantAdapter(), settings({ detectHeadshots: false, detectAssists: false }));
    recordingClock.arm();

    manager.ingest(evt('kill', 'kill', 1));
    manager.ingest(evt('kill', 'headshot', 1));
    manager.ingest(evt('kill', 'assist', 1));
    manager.ingest(evt('death', 'death', 1));

    const kinds = manager.getEvents().map((e) => e.type);
    expect(kinds).toEqual([GameEventType.KILL, GameEventType.DEATH]);
  });

  it('mantiene el resumen agregado al dia', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();

    manager.ingest(evt('kill', 'kill', 1));
    manager.ingest(evt('kill', 'kill', 2));
    manager.ingest(evt('kill', 'headshot', 1));
    manager.ingest(evt('death', 'death', 1));

    expect(manager.getSummary()).toMatchObject({ kills: 2, deaths: 1, headshots: 1, assists: 0 });
  });

  it('aplica la compensacion de latencia por juego', () => {
    manager.begin(new ValorantAdapter(), settings({ latencyOffsetMs: { valorant: 300, rainbowsix: 0, lol: 0 } }));
    recordingClock.arm();
    clock.advanceMs(20_000);

    const created = manager.ingest(evt('kill', 'kill', 1));
    expect(created[0].videoTime).toBeCloseTo(19.7, 3);
  });

  it('reajusta todos los eventos cuando llega la correccion del reloj', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();

    clock.advanceMs(10_000);
    manager.ingest(evt('kill', 'kill', 1));
    clock.advanceMs(10_000);
    manager.ingest(evt('kill', 'kill', 2));

    manager.applyClockCorrection(-0.4);

    const times = manager.getEvents().map((e) => e.videoTime);
    expect(times[0]).toBeCloseTo(9.6, 3);
    expect(times[1]).toBeCloseTo(19.6, 3);
  });

  it('no deja tiempos negativos tras la correccion', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();
    clock.advanceMs(100);
    manager.ingest(evt('kill', 'kill', 1));

    manager.applyClockCorrection(-2);
    const event = manager.getEvents()[0];
    expect(event.beforeRecording).toBe(true);
  });

  /** Caso del `killer` de Rainbow Six: dato que llega en un mensaje aparte. */
  it('aplica parches de metadata al evento reciente correspondiente', () => {
    manager.begin(new RainbowSixAdapter(), settings());
    recordingClock.arm();

    manager.ingest({ gameId: 10826, feature: 'death', key: 'death', value: null, kind: 'event' });
    manager.ingest({ gameId: 10826, feature: 'death', key: 'killer', value: 'uuid-x', kind: 'event' });

    const death = manager.getEvents().find((e) => e.type === GameEventType.DEATH);
    expect(death?.metadata?.killer).toBe('uuid-x');
  });

  it('no aplica un parche a un evento demasiado antiguo', () => {
    manager.begin(new RainbowSixAdapter(), settings());
    recordingClock.arm();

    manager.ingest({ gameId: 10826, feature: 'death', key: 'death', value: null, kind: 'event' });
    // La ventana del parche del killer es de 3 s.
    clock.advanceMs(10_000);
    manager.ingest({ gameId: 10826, feature: 'death', key: 'killer', value: 'tarde', kind: 'event' });

    const death = manager.getEvents().find((e) => e.type === GameEventType.DEATH);
    expect(death?.metadata?.killer).toBeUndefined();
  });

  /** Escenario 12 del enunciado: datos inesperados no deben tumbar nada. */
  it('sobrevive a payloads con forma inesperada', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();

    expect(() => {
      manager.ingest({ gameId: 21640, feature: '', key: '', value: undefined, kind: 'event' });
      manager.ingest({ gameId: 21640, feature: 'kill', key: 'kill', value: { raro: true }, kind: 'event' });
      manager.ingest({ gameId: 21640, feature: 'desconocida', key: 'nueva', value: [1, 2], kind: 'event' });
    }).not.toThrow();
  });

  it('ignora eventos si la sesion no esta activa', () => {
    recordingClock.arm();
    expect(manager.ingest(evt('kill', 'kill', 1))).toHaveLength(0);
  });

  it('permite anadir marcadores manuales', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();
    clock.advanceMs(45_000);

    const marker = manager.addBookmark('Jugada buena');
    expect(marker?.type).toBe(GameEventType.BOOKMARK);
    expect(marker?.videoTime).toBeCloseTo(45, 3);
    expect(marker?.metadata?.label).toBe('Jugada buena');
  });

  it('no permite marcadores si no se esta grabando', () => {
    manager.begin(new ValorantAdapter(), settings());
    expect(manager.addBookmark()).toBeNull();
  });

  // Escenario 11 del enunciado.
  it('termina correctamente una partida sin ningun evento', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();
    const events = manager.end();

    expect(events).toEqual([]);
    expect(manager.getSummary()).toEqual({
      kills: 0,
      deaths: 0,
      headshots: 0,
      assists: 0,
      knockedOut: 0,
      rounds: 0,
    });
  });

  it('reinicia el estado entre sesiones', () => {
    manager.begin(new ValorantAdapter(), settings());
    recordingClock.arm();
    manager.ingest(evt('kill', 'kill', 1));
    manager.end();

    manager.begin(new ValorantAdapter(), settings());
    expect(manager.getEvents()).toHaveLength(0);
    expect(manager.getSummary().kills).toBe(0);
  });
});

describe('summarize', () => {
  it('cuenta por tipo', () => {
    const events = [
      { type: GameEventType.KILL },
      { type: GameEventType.KILL },
      { type: GameEventType.DEATH },
      { type: GameEventType.HEADSHOT },
      { type: GameEventType.ASSIST },
      { type: GameEventType.KNOCKED_OUT },
      { type: GameEventType.ROUND_START },
      { type: GameEventType.MATCH_START },
    ] as Array<Pick<GameEvent, 'type'>>;

    expect(summarize(events)).toEqual({
      kills: 2,
      deaths: 1,
      headshots: 1,
      assists: 1,
      knockedOut: 1,
      rounds: 1,
    });
  });

  it('devuelve ceros para una lista vacia', () => {
    expect(summarize([])).toEqual({
      kills: 0,
      deaths: 0,
      headshots: 0,
      assists: 0,
      knockedOut: 0,
      rounds: 0,
    });
  });
});
