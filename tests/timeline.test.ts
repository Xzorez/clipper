import { describe, it, expect } from 'vitest';
import { clusterEvents, computeTicks } from '../src/shared/timeline';
import { GameEvent, GameEventType } from '../src/shared/types';

let counter = 0;
function event(type: GameEventType, videoTime: number): GameEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    game: 'valorant',
    type,
    timestamp: 1_700_000_000_000 + videoTime * 1000,
    monotonicNs: String(videoTime * 1e9),
    videoTime,
  };
}

describe('clusterEvents', () => {
  it('devuelve una lista vacia si no hay eventos', () => {
    expect(clusterEvents([], 900, 600, 20)).toEqual([]);
  });

  it('coloca cada evento en su posicion proporcional', () => {
    const events = [event(GameEventType.KILL, 0), event(GameEventType.KILL, 300)];
    const clusters = clusterEvents(events, 1000, 600, 20);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].x).toBeCloseTo(0, 6);
    // La mitad de la duracion cae a la mitad del ancho.
    expect(clusters[1].x).toBeCloseTo(500, 6);
  });

  it('agrupa los eventos que caerian demasiado juntos', () => {
    // Tres eventos en el mismo segundo de un video de 20 minutos.
    const events = [
      event(GameEventType.KILL, 120),
      event(GameEventType.HEADSHOT, 120.2),
      event(GameEventType.ASSIST, 120.4),
    ];
    const clusters = clusterEvents(events, 900, 1200, 20);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(3);
  });

  it('separa los mismos eventos cuando hay zoom suficiente', () => {
    const events = [
      event(GameEventType.KILL, 120),
      event(GameEventType.HEADSHOT, 122),
      event(GameEventType.ASSIST, 124),
    ];
    // Con la pista 20 veces mas ancha ya no se solapan.
    const clusters = clusterEvents(events, 900 * 20, 1200, 20);
    expect(clusters).toHaveLength(3);
  });

  it('elige como dominante el tipo de mayor prioridad visual', () => {
    // Una muerte pesa mas que una kill: el grupo debe pintarse como muerte.
    const events = [event(GameEventType.KILL, 100), event(GameEventType.DEATH, 100.1)];
    const clusters = clusterEvents(events, 900, 1200, 20);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].dominant).toBe(GameEventType.DEATH);
  });

  it('ordena los eventos aunque lleguen desordenados', () => {
    const events = [
      event(GameEventType.KILL, 500),
      event(GameEventType.DEATH, 100),
      event(GameEventType.KILL, 300),
    ];
    const clusters = clusterEvents(events, 1000, 600, 20);
    const times = clusters.map((c) => c.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('usa el tiempo del primer evento del grupo como destino del salto', () => {
    const events = [event(GameEventType.KILL, 200), event(GameEventType.KILL, 200.3)];
    const clusters = clusterEvents(events, 900, 1200, 20);
    expect(clusters[0].time).toBe(200);
  });

  /**
   * El escenario que motiva la agrupacion: cientos de eventos no deben
   * producir cientos de nodos en el DOM.
   */
  it('reduce drasticamente los nodos con cientos de eventos', () => {
    const events: GameEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(event(GameEventType.KILL, i * 4));
    }
    const clusters = clusterEvents(events, 900, 2000, 20);

    expect(events).toHaveLength(500);
    expect(clusters.length).toBeLessThan(60);
    // Ningun evento se pierde por el camino.
    const total = clusters.reduce((sum, c) => sum + c.events.length, 0);
    expect(total).toBe(500);
  });

  it('no falla con duracion cero', () => {
    const events = [event(GameEventType.KILL, 0)];
    expect(() => clusterEvents(events, 900, 0, 20)).not.toThrow();
  });

  it('acota los eventos que caen mas alla del final del video', () => {
    // Puede pasar si la reconciliacion desplaza un evento del final.
    const events = [event(GameEventType.KILL, 9999)];
    const clusters = clusterEvents(events, 900, 600, 20);
    expect(clusters[0].x).toBeLessThanOrEqual(900);
  });
});

describe('computeTicks', () => {
  it('usa intervalos redondos', () => {
    const ticks = computeTicks(600, 900);
    const interval = ticks[1].time - ticks[0].time;
    expect([1, 2, 5, 10, 15, 30, 60, 120, 300, 600]).toContain(interval);
  });

  it('empieza en cero y no se pasa de la duracion', () => {
    const ticks = computeTicks(1834, 1200);
    expect(ticks[0].time).toBe(0);
    expect(ticks[ticks.length - 1].time).toBeLessThanOrEqual(1834);
  });

  it('genera mas marcas cuando la pista es mas ancha', () => {
    const few = computeTicks(3600, 900);
    const many = computeTicks(3600, 9000);
    expect(many.length).toBeGreaterThan(few.length);
  });

  it('no falla con duracion cero', () => {
    expect(() => computeTicks(0, 900)).not.toThrow();
  });
});
