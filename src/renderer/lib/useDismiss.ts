import { useEffect } from 'react';

/**
 * Cierra un menu flotante al pulsar fuera o al pulsar Escape.
 *
 * Sin esto, el menu de opciones de una tarjeta se quedaba abierto hasta volver
 * a pulsar su boton: se abria otro encima, se cambiaba de pantalla con el menu
 * puesto, y no habia forma evidente de deshacerse de el.
 */
export function useDismiss(open: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!open) return;

    // En la fase de captura: asi se cierra aunque el clic caiga sobre otro
    // boton que detenga la propagacion.
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-menu]')) return;
      onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };

    document.addEventListener('mousedown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onDismiss]);
}
