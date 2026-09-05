import { useCallback, useEffect, useState } from 'react';
import { UpdateStatus } from '@shared/types';
import { api } from './api';

export interface UpdateControls {
  status: UpdateStatus | null;
  /** Hay una comprobacion manual en curso. */
  checking: boolean;
  check: () => Promise<void>;
  install: () => void;
}

/**
 * Estado del actualizador, listo para pintar.
 *
 * Se pide una vez al abrir y despues se escucha: si al entrar ya hay una
 * descarga a medias, la interfaz lo refleja desde el primer momento en lugar
 * de esperar al siguiente cambio.
 */
export function useUpdateStatus(): UpdateControls {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .getUpdateStatus()
      .then((initial) => {
        if (alive) setStatus(initial);
      })
      .catch(() => undefined);
    const unsubscribe = api.onUpdateStatus((next) => setStatus(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.checkForUpdate());
    } catch {
      // El propio estado ya cuenta lo que ha pasado; no hay nada que anadir.
    } finally {
      setChecking(false);
    }
  }, []);

  const install = useCallback(() => {
    void api.installUpdate().catch(() => undefined);
  }, []);

  return { status, checking, check, install };
}
