import { describe, it, expect } from 'vitest';
import { CounterTracker, parseCounterValue } from '../src/core/events/CounterTracker';

describe('parseCounterValue', () => {
  it('acepta numeros', () => {
    expect(parseCounterValue(6)).toBe(6);
    expect(parseCounterValue(0)).toBe(0);
  });

  it('acepta cadenas numericas, que es como GEP suele enviarlas', () => {
    expect(parseCounterValue('6')).toBe(6);
    expect(parseCounterValue(' 12 ')).toBe(12);
  });

  it('extrae el total de un JSON serializado como el de League of Legends', () => {
    expect(parseCounterValue('{"label":"kill","count":1,"totalKills":3}')).toBe(3);
    expect(parseCounterValue({ label: 'doubleKill', count: 2, totalKills: 7 })).toBe(7);
  });

  it('devuelve null cuando no hay contador (eventos discretos de R6)', () => {
    expect(parseCounterValue(null)).toBeNull();
    expect(parseCounterValue(undefined)).toBeNull();
    expect(parseCounterValue('')).toBeNull();
    expect(parseCounterValue('victory')).toBeNull();
    expect(parseCounterValue('{ roto')).toBeNull();
  });
});

describe('CounterTracker', () => {
  // Escenario 1 del enunciado: evento kill individual.
  it('registra una unica kill cuando llega el primer evento', () => {
    const tracker = new CounterTracker();
    const observation = tracker.observe('kill', 1);
    expect(observation.occurrences).toBe(1);
    expect(observation.reason).toBe('first');
  });

  // Escenario 2: contador 1 -> 2 produce exactamente una kill.
  it('convierte un incremento de 1 en un unico evento', () => {
    const tracker = new CounterTracker();
    tracker.observe('kill', 1);
    const observation = tracker.observe('kill', 2);
    expect(observation.occurrences).toBe(1);
    expect(observation.previous).toBe(1);
    expect(observation.current).toBe(2);
    expect(observation.reason).toBe('increment');
  });

  // Escenario 3: el mismo valor repetido no genera nada.
  it('ignora el reenvio del mismo valor', () => {
    const tracker = new CounterTracker();
    tracker.observe('kill', 2);
    const repeated = tracker.observe('kill', 2);
    expect(repeated.occurrences).toBe(0);
    expect(repeated.reason).toBe('duplicate');

    const repeatedAgain = tracker.observe('kill', 2);
    expect(repeatedAgain.occurrences).toBe(0);
  });

  it('no inventa seis kills cuando el valor de partida es 6', () => {
    const tracker = new CounterTracker();
    // Este es el caso concreto del enunciado: value 6 significa "tu total es 6",
    // no "han ocurrido seis kills".
    const first = tracker.observe('kill', 6);
    expect(first.occurrences).toBe(1);

    const next = tracker.observe('kill', 7);
    expect(next.occurrences).toBe(1);
  });

  it('no genera eventos cuando la linea base viene de un info update', () => {
    const tracker = new CounterTracker();
    // La app arranca con la partida ya empezada: el info update dice 5 kills.
    tracker.seed('kill', 5);
    expect(tracker.get('kill')).toBe(5);

    // La siguiente kill real es la sexta, y solo debe contar como una.
    const observation = tracker.observe('kill', 6);
    expect(observation.occurrences).toBe(1);
    expect(observation.previous).toBe(5);
  });

  it('emite tantos eventos como indique el salto cuando se pierde alguno', () => {
    const tracker = new CounterTracker();
    tracker.seed('kill', 4);
    // Si GEP se atasca y salta de 4 a 6, han ocurrido dos kills.
    expect(tracker.observe('kill', 6).occurrences).toBe(2);
  });

  it('limita saltos absurdos en lugar de llenar la timeline', () => {
    const tracker = new CounterTracker();
    tracker.seed('kill', 0);
    const observation = tracker.observe('kill', 500);
    expect(observation.occurrences).toBe(1);
    expect(observation.reason).toBe('clamped');
  });

  it('trata un contador que baja como partida nueva', () => {
    const tracker = new CounterTracker();
    tracker.seed('kill', 12);
    const observation = tracker.observe('kill', 1);
    expect(observation.reason).toBe('reset');
    expect(observation.occurrences).toBe(1);
    // A partir de ahi la cuenta sigue desde el valor nuevo.
    expect(tracker.observe('kill', 2).occurrences).toBe(1);
  });

  it('devuelve una ocurrencia para eventos sin contador', () => {
    const tracker = new CounterTracker();
    // Rainbow Six manda value null: cada mensaje es una ocurrencia real.
    expect(tracker.observe('kill', null).occurrences).toBe(1);
    expect(tracker.observe('kill', null).occurrences).toBe(1);
    expect(tracker.observe('kill', null).occurrences).toBe(1);
  });

  it('mantiene contadores independientes por clave', () => {
    const tracker = new CounterTracker();
    tracker.observe('kill', 1);
    tracker.observe('death', 1);
    expect(tracker.observe('kill', 2).occurrences).toBe(1);
    expect(tracker.observe('death', 1).occurrences).toBe(0);
  });

  it('se limpia al reiniciar', () => {
    const tracker = new CounterTracker();
    tracker.seed('kill', 9);
    tracker.reset();
    expect(tracker.get('kill')).toBeNull();
  });
});
