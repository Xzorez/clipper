import { GameKey } from '../../shared/types';
import { AdapterOutput, BaseGameAdapter, RawGameEvent } from './GameAdapter';

/**
 * Adaptador para cualquier juego que no tenga uno propio.
 *
 * No traduce eventos porque no hay nada que traducir: fuera de VALORANT,
 * Rainbow Six y League of Legends no existe ninguna fuente de datos legitima
 * de la que sacar kills o muertes. Inventarse una supondria mirar dentro del
 * proceso del juego o leer la pantalla, y ninguna de las dos cosas entra aqui.
 *
 * Lo que si aporta es todo lo demas: la partida se graba entera, con su
 * sincronizacion, su recuperacion ante cierres y su linea temporal. Los
 * momentos los marca quien juega con el atajo de marcador, y esos marcadores
 * se guardan y se navegan igual que un kill detectado solo.
 *
 * El nombre del juego no vive aqui: este adaptador es unico y compartido por
 * todos, asi que el titulo concreto viaja con cada grabacion.
 */
export class GenericGameAdapter extends BaseGameAdapter {
  readonly game: GameKey = 'generic';
  /** No existe en GEP. El registro descarta este cero al pedirle juegos. */
  readonly gepGameId = 0;
  readonly displayName = 'Juego';
  /**
   * Vacio a proposito: a este adaptador no se llega buscando por nombre de
   * proceso, sino porque el detector generico decidio que lo que hay delante
   * es un juego. Si tuviera nombres, competiria con los adaptadores propios.
   */
  readonly processNames: string[] = [];

  /** Nunca se autoasigna: siempre lo elige el detector generico. */
  detect(): boolean {
    return false;
  }

  requiredFeatures(): string[] | null {
    return null;
  }

  normalizeEvent(_raw: RawGameEvent): AdapterOutput {
    return this.none();
  }
}
