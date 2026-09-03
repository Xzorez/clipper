/**
 * Reloj monotonico.
 *
 * Por que no basta con Date.now():
 * una grabacion puede durar 40 minutos y durante ese tiempo el reloj de pared
 * puede saltar (sincronizacion NTP, cambio de horario, ajuste manual del usuario).
 * Si anclamos los eventos al reloj de pared, un salto de 2 segundos desplaza
 * TODOS los marcadores posteriores. process.hrtime.bigint() es monotonico y de
 * resolucion en nanosegundos, asi que lo usamos como fuente de verdad para
 * calcular posiciones dentro del video.
 *
 * El reloj de pared se sigue registrando, pero solo para (a) mostrar la hora real
 * al usuario y (b) hacer una unica reconciliacion contra el startTimeEpoch que
 * devuelve el grabador al terminar.
 */
export interface Clock {
  /** Nanosegundos monotonicos. No tiene relacion con la hora real. */
  monotonicNs(): bigint;
  /** Epoch en milisegundos. */
  wallMs(): number;
}

export class SystemClock implements Clock {
  monotonicNs(): bigint {
    return process.hrtime.bigint();
  }

  wallMs(): number {
    return Date.now();
  }
}

/** Reloj controlable, usado en los tests para simular el paso del tiempo. */
export class FakeClock implements Clock {
  private mono: bigint;
  private wall: number;

  constructor(startMonoNs = 0n, startWallMs = 1_700_000_000_000) {
    this.mono = startMonoNs;
    this.wall = startWallMs;
  }

  monotonicNs(): bigint {
    return this.mono;
  }

  wallMs(): number {
    return this.wall;
  }

  /** Avanza ambos relojes de forma coherente. */
  advanceMs(ms: number): void {
    this.mono += BigInt(Math.round(ms * 1_000_000));
    this.wall += ms;
  }

  /** Simula un salto del reloj de pared sin que avance el monotonico (NTP). */
  jumpWallMs(ms: number): void {
    this.wall += ms;
  }
}

export const NS_PER_SECOND = 1_000_000_000n;

/** Convierte una diferencia en nanosegundos a segundos con decimales. */
export function nsToSeconds(ns: bigint): number {
  // Se hace en dos pasos para no perder precision al convertir a Number:
  // separamos la parte entera de segundos del resto en nanosegundos.
  const whole = ns / NS_PER_SECOND;
  const rest = ns % NS_PER_SECOND;
  return Number(whole) + Number(rest) / 1e9;
}
