import type { ClipperApi } from '@shared/api';

declare global {
  interface Window {
    clipper: ClipperApi;
  }
}

/**
 * Puente tipado con el proceso principal.
 *
 * Si `window.clipper` no existe (por ejemplo al abrir el bundle del renderer
 * en un navegador suelto durante el desarrollo de la interfaz), devolvemos un
 * doble vacio en lugar de reventar con "cannot read property of undefined".
 */
export const api: ClipperApi =
  typeof window !== 'undefined' && window.clipper
    ? window.clipper
    : (createNullApi() as unknown as ClipperApi);

function createNullApi(): Record<string, unknown> {
  const notAvailable = async () => {
    throw new Error('El puente con la aplicacion no esta disponible.');
  };
  const noop = () => () => undefined;
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop.startsWith('on')) return noop;
        if (prop === 'mediaUrl') return (p: string) => p;
        return notAvailable;
      },
    },
  );
}
