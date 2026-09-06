import { describe, it, expect } from 'vitest';
import { findGameWindow } from '../src/main/VideoBridge';

/** Ventanas tal como las devuelve desktopCapturer. */
const ABIERTAS = [
  { id: 'window:1:0', name: 'Discord' },
  { id: 'window:2:0', name: 'Clipper' },
  { id: 'window:3:0', name: 'League of Legends' },
  { id: 'window:4:0', name: 'League of Legends (TM) Client' },
  { id: 'window:5:0', name: 'Porofessor - Desktop' },
];

/**
 * Eleccion de la ventana que se graba.
 *
 * Equivocarse aqui no da un error: da una partida entera grabando el
 * navegador, y no se descubre hasta ir a verla.
 */
describe('ventana del juego', () => {
  it('encuentra la ventana por el nombre del juego', () => {
    expect(findGameWindow(ABIERTAS, ['League of Legends'])).toBe('window:3:0');
  });

  it('prefiere la primera coincidencia y no el cliente', () => {
    // El cliente de League tambien empieza por el nombre del juego. Como la
    // lista llega en orden de Windows, se toma la primera que encaja; grabar
    // el cliente en vez de la partida seria grabar los menus.
    const soloCliente = ABIERTAS.filter((w) => w.name !== 'League of Legends');
    expect(findGameWindow(soloCliente, ['League of Legends'])).toBe('window:4:0');
  });

  it('nunca se graba a si misma', () => {
    // Capturar la propia ventana daria el efecto de dos espejos enfrentados.
    expect(findGameWindow(ABIERTAS, ['Clipper'])).toBeNull();
  });

  it('devuelve null cuando el juego no tiene ventana', () => {
    // Pasa con la pantalla completa exclusiva. Quien llama debe recurrir
    // entonces a la captura de pantalla, no quedarse sin grabar.
    expect(findGameWindow(ABIERTAS, ['VALORANT'])).toBeNull();
  });

  it('acepta varios nombres candidatos', () => {
    // Del juego detectado se conoce el titulo y el nombre del proceso, y no
    // siempre coinciden con el titulo de la ventana.
    expect(findGameWindow(ABIERTAS, ['Machine Party', 'League of Legends'])).toBe('window:3:0');
  });

  it('ignora candidatos demasiado cortos', () => {
    // Un nombre de dos letras encajaria con casi cualquier ventana abierta.
    expect(findGameWindow(ABIERTAS, ['LoL'.slice(0, 2)])).toBeNull();
    expect(findGameWindow(ABIERTAS, [''])).toBeNull();
  });

  it('no distingue mayusculas ni espacios sobrantes', () => {
    expect(findGameWindow(ABIERTAS, ['  league of legends  '])).toBe('window:3:0');
  });

  it('no elige nada si no hay ventanas', () => {
    expect(findGameWindow([], ['League of Legends'])).toBeNull();
  });
});
