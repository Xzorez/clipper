import { UpdateStatus } from '@shared/types';

/**
 * Aviso de actualizacion en la barra superior.
 *
 * Solo aparece cuando hay algo que contar: una descarga en curso o una version
 * lista para aplicarse. En reposo no ocupa sitio ni dice nada, que es como
 * debe comportarse algo que corre solo.
 */
export function UpdateIndicator({
  status,
  onInstall,
}: {
  status: UpdateStatus | null;
  onInstall: () => void;
}) {
  if (!status) return null;

  if (status.state === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(status.progress ?? 0)));
    return (
      <div className="upd" title="Descargando la version nueva en segundo plano">
        <span className="upd__spin" />
        <span>ACTUALIZANDO {percent}%</span>
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <div className="upd" title={`La version ${status.version ?? 'nueva'} esta lista`}>
        <span>LISTA {status.version ?? ''}</span>
        <button className="upd__btn" onClick={onInstall}>
          Reiniciar
        </button>
      </div>
    );
  }

  return null;
}
