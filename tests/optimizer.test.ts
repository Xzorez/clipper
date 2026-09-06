import { describe, it, expect } from 'vitest';
import { isReplacementSound } from '../src/core/recording/Optimizer';

/**
 * La comprobacion previa a sustituir la grabacion.
 *
 * Reordenar el fichero es lo que hace que se abra al instante, pero implica
 * escribir una copia y quedarse con ella. Si la copia salio a medias y se
 * sustituye igualmente, la partida se pierde y no hay vuelta atras: por eso
 * esta decision se comprueba aparte.
 */
describe('sustitucion tras reordenar', () => {
  it('acepta una copia del mismo tamano', () => {
    // Copiar los flujos no recodifica: el tamano apenas varia.
    expect(isReplacementSound(1_000_000, 1_000_400)).toBe(true);
  });

  it('acepta la merma normal de reordenar', () => {
    // Quitar los encabezados de cada fragmento adelgaza un poco el fichero.
    expect(isReplacementSound(1_000_000, 960_000)).toBe(true);
  });

  it('rechaza una copia que se quedo a medias', () => {
    expect(isReplacementSound(1_000_000, 500_000)).toBe(false);
    expect(isReplacementSound(2_000_000_000, 12_000)).toBe(false);
  });

  it('rechaza una copia vacia', () => {
    // FFmpeg puede dejar el fichero creado y sin contenido si falla al abrir.
    expect(isReplacementSound(1_000_000, 0)).toBe(false);
  });

  it('rechaza cuando no se conoce el original', () => {
    expect(isReplacementSound(0, 1_000_000)).toBe(false);
  });
});
