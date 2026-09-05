import { UpdateStatus } from '@shared/types';

/**
 * Aviso de actualizacion en la barra lateral.
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
      <div className="upd">
        <div className="upd__head">
          <span className="upd__spin" />
          <span className="upd__text">Actualizacion</span>
          <span className="upd__pct">{percent}%</span>
        </div>
        <div className="upd__bar">
          <i style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <div className="upd upd--ready">
        <div className="upd__head">
          <span className="upd__text">
            Version {status.version ?? 'nueva'} lista
          </span>
        </div>
        <button className="upd__btn" onClick={onInstall}>
          Reiniciar e instalar
        </button>
      </div>
    );
  }

  return null;
}
