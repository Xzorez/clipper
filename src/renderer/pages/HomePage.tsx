import { DetectionState, LiveStatus, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatTime } from '../lib/events';
import { RecordingCard } from '../components/RecordingCard';
import { IconRecord, IconStop, IconFilm } from '../components/Icons';

export interface HomePageProps {
  status: LiveStatus | null;
  recent: RecordingRecord[];
  onOpenRecording: (id: string) => void;
  onNotify: (title: string, message: string) => void;
  onGoToLibrary: () => void;
}

/**
 * Pantalla de inicio.
 *
 * Deliberadamente sin avisos. Al entrar no hay nada que leer ni que cerrar: el
 * estado cabe en una linea, y el detalle vive en Ajustes -> Diagnostico para
 * quien lo quiera. Solo se interrumpe al usuario cuando algo falla de verdad
 * mientras usa la aplicacion, y entonces con un aviso puntual que se va solo.
 */
export function HomePage({
  status,
  recent,
  onOpenRecording,
  onNotify,
  onGoToLibrary,
}: HomePageProps) {
  const recording = status?.state === DetectionState.RECORDING;
  const detected = status?.state === DetectionState.GAME_DETECTED;

  return (
    <div>
      <h1 className="page__title">Inicio</h1>
      <p className="page__sub">Tus partidas, grabadas enteras y con lo importante marcado.</p>

      <div className={`stage${recording ? ' stage--live' : ''}`}>
        <div className="stage__head">
          <div>
            <div className="state">
              <span className={`dot ${recording ? 'dot--live' : detected ? 'dot--ready' : ''}`} />
              {recording ? 'Grabando' : detected ? 'Juego detectado' : 'En espera'}
            </div>

            {recording ? (
              <>
                <div className="timer">{formatTime(status?.elapsed ?? 0)}</div>
                <div className="stage__game">{status?.gameName}</div>
              </>
            ) : (
              <>
                <div className="timer" style={{ color: 'var(--text-3)' }}>
                  {detected ? status?.gameName : '00:00'}
                </div>
                <div className="stage__hint">
                  {detected
                    ? 'Listo para grabar esta partida.'
                    : 'Abre un juego y empezara sola. VALORANT, Rainbow Six Siege y League of Legends ademas marcan los momentos solos.'}
                </div>
              </>
            )}
          </div>

          <div>
            {recording ? (
              <button
                className="btn btn--danger"
                onClick={() =>
                  void api
                    .stopRecording()
                    .catch((err) => onNotify('No se ha podido detener', (err as Error).message))
                }
              >
                <IconStop size={13} />
                Detener
              </button>
            ) : (
              <button
                className="btn btn--primary"
                onClick={() =>
                  void api
                    .startRecording()
                    .catch((err) => onNotify('No se ha podido iniciar', (err as Error).message))
                }
              >
                <IconRecord size={12} />
                Grabar ahora
              </button>
            )}
          </div>
        </div>

        {recording && (
          <div className="stats">
            <Stat label="Kills" value={status?.summary.kills ?? 0} color="var(--kill)" />
            <Stat label="Muertes" value={status?.summary.deaths ?? 0} color="var(--death)" />
            <Stat label="Headshots" value={status?.summary.headshots ?? 0} color="var(--headshot)" />
            <Stat label="Asistencias" value={status?.summary.assists ?? 0} color="var(--assist)" />
          </div>
        )}

        <div className="strip">
          <span>
            Captura <b>{recorderLabel(status)}</b>
          </span>
          <span>
            Eventos <b>{providerLabel(status)}</b>
          </span>
          {typeof status?.diskFreeGb === 'number' && (
            <span>
              Disco <b className="num">{status.diskFreeGb.toFixed(0)} GB</b>
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            <span className="kbd">F8</span> clip <span className="kbd">F9</span> marcador{' '}
            <span className="kbd">F10</span> grabar
          </span>
        </div>
      </div>

      <div className="section">Ultimas partidas</div>

      {recent.length === 0 ? (
        <div className="empty">
          <IconFilm size={34} className="empty__mark" />
          <div className="empty__title">Todavia no hay partidas</div>
          <div className="empty__hint">
            En cuanto abras uno de los juegos soportados, Clipper empezara a grabar por su cuenta.
          </div>
        </div>
      ) : (
        <>
          <div className="grid">
            {recent.slice(0, 4).map((item) => (
              <RecordingCard key={item.id} recording={item} onOpen={onOpenRecording} />
            ))}
          </div>
          {recent.length > 4 && (
            <button className="btn btn--quiet" style={{ marginTop: 16 }} onClick={onGoToLibrary}>
              Ver todas
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="stat__value" style={{ color }}>
        {value}
      </div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

function recorderLabel(status: LiveStatus | null): string {
  if (!status || status.recorder.status === 'checking') return 'comprobando';
  if (status.recorder.status === 'unavailable') return 'no disponible';
  return status.recorder.backend === 'overwolf' ? 'Overwolf' : 'automatica';
}

function providerLabel(status: LiveStatus | null): string {
  if (!status) return 'comprobando';
  const name =
    status.provider.provider === 'riot-live-client'
      ? 'API de Riot'
      : status.provider.provider === 'r6-replay'
        ? 'repeticiones'
        : status.provider.provider === 'valorant-match-api'
          ? 'historial'
          : 'GEP';

  switch (status.provider.status) {
    case 'connected':
      return name;
    case 'connecting':
      return 'conectando';
    case 'disconnected':
      return `${name}, sin juego`;
    case 'elevation-required':
      return 'requiere administrador';
    case 'error':
      return 'error';
    default:
      // Sin GEP cada juego usa su propia fuente, que se activa al detectarlo.
      return 'por juego';
  }
}
