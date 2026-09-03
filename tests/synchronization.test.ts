import { describe, it, expect } from 'vitest';
import { FakeClock, nsToSeconds } from '../src/core/synchronization/MonotonicClock';
import { RecordingClock } from '../src/core/synchronization/RecordingClock';

/** Convierte milisegundos a nanosegundos para construir instantes en los tests. */
const ms = (value: number) => BigInt(Math.round(value * 1_000_000));

describe('nsToSeconds', () => {
  it('convierte sin perder precision en duraciones largas', () => {
    // Una hora y 27,605 ms. Un Number ingenuo perderia decimales aqui.
    const oneHour = 3600n * 1_000_000_000n;
    expect(nsToSeconds(oneHour + ms(27605))).toBeCloseTo(3627.605, 6);
  });

  it('maneja el caso trivial', () => {
    expect(nsToSeconds(0n)).toBe(0);
    expect(nsToSeconds(ms(1500))).toBeCloseTo(1.5, 9);
  });
});

describe('RecordingClock', () => {
  // Escenario 6 y 7 del enunciado.
  it('convierte el instante de un evento en su posicion dentro del video', () => {
    const clock = new FakeClock(0n, Date.parse('2026-09-02T10:32:15.125Z'));
    const recordingClock = new RecordingClock(clock);

    // La grabacion empieza a las 10:32:15.125
    recordingClock.arm();

    // La kill ocurre a las 10:32:42.730, es decir 27,605 s despues.
    clock.advanceMs(27605);
    const videoTime = recordingClock.videoTimeFor(clock.monotonicNs());

    expect(videoTime).toBeCloseTo(27.605, 3);
  });

  it('compensa la latencia del proveedor restandola', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    recordingClock.arm();
    clock.advanceMs(30_000);

    // GEP detecta la kill 250 ms despues de ocurrir en pantalla.
    const videoTime = recordingClock.videoTimeFor(clock.monotonicNs(), 250);
    expect(videoTime).toBeCloseTo(29.75, 3);
  });

  it('devuelve -Infinity si todavia no hay ancla, para que el evento se bufferice', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    expect(recordingClock.isArmed).toBe(false);
    expect(recordingClock.videoTimeFor(clock.monotonicNs())).toBe(Number.NEGATIVE_INFINITY);
  });

  /**
   * La prueba que justifica todo el diseno: si nos hubieramos anclado al reloj
   * de pared, un salto de NTP a mitad de partida desplazaria todos los
   * marcadores posteriores.
   */
  it('no se ve afectado por un salto del reloj del sistema', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    recordingClock.arm();

    clock.advanceMs(10_000);
    // El sistema sincroniza con NTP y adelanta 3 segundos de golpe.
    clock.jumpWallMs(3000);
    clock.advanceMs(5000);

    // Han pasado 15 s reales de video, no 18.
    expect(recordingClock.videoTimeFor(clock.monotonicNs())).toBeCloseTo(15, 3);
  });

  it('detecta y reporta la desviacion del reloj de pared', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    recordingClock.arm();
    clock.advanceMs(10_000);
    clock.jumpWallMs(2500);

    expect(recordingClock.measureWallDriftMs()).toBeCloseTo(2500, 0);
  });

  describe('reconciliacion en dos fases', () => {
    /**
     * El grabador de Overwolf no entrega startTimeEpoch al arrancar, solo al
     * parar. Entre nuestra ancla provisional y el primer frame real pasa un
     * tiempo (arranque del encoder). Al terminar corregimos.
     */
    it('corrige el desfase cuando el video empezo despues del ancla', () => {
      const startWall = Date.parse('2026-09-02T10:32:15.125Z');
      const clock = new FakeClock(0n, startWall);
      const recordingClock = new RecordingClock(clock);
      recordingClock.arm();

      clock.advanceMs(27605);
      const provisional = recordingClock.videoTimeFor(clock.monotonicNs());
      expect(provisional).toBeCloseTo(27.605, 3);

      // El encoder tardo 400 ms en escribir el primer frame.
      const result = recordingClock.reconcile(startWall + 400);
      expect(result.applied).toBe(true);
      expect(result.correctionSec).toBeCloseTo(-0.4, 6);

      // El mismo instante ahora cae 400 ms antes dentro del video.
      expect(recordingClock.videoTimeFor(clock.monotonicNs())).toBeCloseTo(27.205, 3);
    });

    it('corrige tambien si el video empezo antes del ancla', () => {
      const startWall = Date.parse('2026-09-02T10:32:15.125Z');
      const clock = new FakeClock(0n, startWall);
      const recordingClock = new RecordingClock(clock);
      recordingClock.arm();

      const result = recordingClock.reconcile(startWall - 250);
      expect(result.applied).toBe(true);
      expect(result.correctionSec).toBeCloseTo(0.25, 6);
    });

    it('conserva el ancla provisional si el backend no da el dato', () => {
      const clock = new FakeClock();
      const recordingClock = new RecordingClock(clock);
      recordingClock.arm();

      expect(recordingClock.reconcile(null).applied).toBe(false);
      expect(recordingClock.reconcile(undefined).applied).toBe(false);
      expect(recordingClock.reconcile(0).applied).toBe(false);
      expect(recordingClock.reconcile(NaN).applied).toBe(false);
    });

    /**
     * Si el backend devolviera un epoch absurdo (0, una fecha de 1970, un valor
     * corrupto), aplicar la correccion destrozaria todos los marcadores.
     * Preferimos un ancla provisional imperfecta a una correccion demencial.
     */
    it('rechaza correcciones fuera de rango', () => {
      const startWall = Date.parse('2026-09-02T10:32:15.125Z');
      const clock = new FakeClock(0n, startWall);
      const recordingClock = new RecordingClock(clock);
      recordingClock.arm();

      // Un epoch de hace un dia implicaria una correccion de 86400 s.
      const result = recordingClock.reconcile(startWall - 86_400_000);
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('out-of-range');
      expect(recordingClock.anchor?.correctionSec).toBe(0);
    });

    it('no reconcilia si el reloj nunca se armo', () => {
      const recordingClock = new RecordingClock(new FakeClock());
      const result = recordingClock.reconcile(Date.now());
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('clock-not-armed');
    });
  });

  it('mide los segundos transcurridos para el contador en vivo', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    expect(recordingClock.elapsedSeconds()).toBe(0);

    recordingClock.arm();
    clock.advanceMs(125_400);
    expect(recordingClock.elapsedSeconds()).toBeCloseTo(125.4, 3);
  });

  it('se limpia al reiniciar', () => {
    const clock = new FakeClock();
    const recordingClock = new RecordingClock(clock);
    recordingClock.arm();
    recordingClock.reset();
    expect(recordingClock.isArmed).toBe(false);
    expect(recordingClock.anchor).toBeNull();
  });
});
