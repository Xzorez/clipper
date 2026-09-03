import { DetectionState, LiveStatus, RecordingRecord } from '@shared/types';
import { api } from '../lib/api';
import { formatTime } from '../lib/events';
import { RecordingCard } from '../components/RecordingCard';

export interface HomePageProps {
  status: LiveStatus | null;
  recent: RecordingRecord[];
  onOpenRecording: (id: string) => void;
  onNotify: (title: string, message: string) => void;
  onGoToLibrary: () => void;
}

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
      <h1 className="page-title">Inicio</h1>
      <p className="page-subtitle">
        Clipper vigila tus juegos y graba la partida completa con los eventos marcados.
      </p>

      <ProviderBanners status={status} onNotify={onNotify} />

      <div className={`recorder-panel${recording ? ' recorder-panel--live' : ''}`}>
        <div className="recorder-header">
          <div>
            <div className="status-line">
              <span
                className={`dot ${
                  recording ? 'dot--live' : detected ? 'dot--ready' : ''
                }`}
              />
              {recording
                ? 'GRABANDO'
                : detected
                  ? `${status?.gameName} detectado`
                  : 'No grabando'}
            </div>

            {recording && (
              <>
                <div className="timer">{formatTime(status?.elapsed ?? 0)}</div>
                <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{status?.gameName}</div>
                <div className="live-stats">
                  <LiveStat label="Kills" value={status?.summary.kills ?? 0} color="var(--kill)" icon="⚔️" />
                  <LiveStat label="Muertes" value={status?.summary.deaths ?? 0} color="var(--death)" icon="💀" />
                  <LiveStat
                    label="Headshots"
                    value={status?.summary.headshots ?? 0}
                    color="var(--headshot)"
                    icon="🎯"
                  />
                  <LiveStat
                    label="Asistencias"
                    value={status?.summary.assists ?? 0}
                    color="var(--assist)"
                    icon="🤝"
                  />
                </div>
              </>
            )}

            {!recording && (
              <div style={{ color: 'var(--text-2)', marginTop: 8, fontSize: 13 }}>
                {detected
                  ? 'Listo para grabar esta partida.'
                  : 'Deteccion automatica activa. Abre VALORANT, Rainbow Six Siege o League of Legends.'}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            {recording ? (
              <button
                className="btn btn--danger"
                onClick={() =>
                  void api
                    .stopRecording()
                    .catch((err) => onNotify('No se ha podido detener', (err as Error).message))
                }
              >
                ■ Detener grabacion
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
                ● Grabar ahora
              </button>
            )}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 26,
            flexWrap: 'wrap',
            fontSize: 12,
            color: 'var(--text-2)',
          }}
        >
          <span>
            Captura: <strong style={{ color: 'var(--text-1)' }}>{recorderLabel(status)}</strong>
          </span>
          <span>
            Eventos:{' '}
            <strong style={{ color: 'var(--text-1)' }}>{providerLabel(status)}</strong>
          </span>
          {status?.diskFreeGb !== null && status?.diskFreeGb !== undefined && (
            <span>
              Disco libre:{' '}
              <strong style={{ color: 'var(--text-1)' }}>{status.diskFreeGb.toFixed(1)} GB</strong>
            </span>
          )}
          <span>
            Atajos: <span className="kbd">F8</span> clip · <span className="kbd">F9</span> marcador ·{' '}
            <span className="kbd">F10</span> grabar
          </span>
        </div>
      </div>

      <div className="section-title">Ultimas partidas</div>
      {recent.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__icon">🎬</div>
          <div>Todavia no hay grabaciones.</div>
          <div style={{ fontSize: 12 }}>
            Abre uno de los juegos soportados y Clipper empezara a grabar solo.
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
            <button className="btn btn--ghost" style={{ marginTop: 14 }} onClick={onGoToLibrary}>
              Ver todas las partidas →
            </button>
          )}
        </>
      )}
    </div>
  );
}

function LiveStat({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: number;
  color: string;
  icon: string;
}) {
  return (
    <div className="live-stat">
      <span>{icon}</span>
      <span style={{ color }}>{value}</span>
      <span className="live-stat__label">{label}</span>
    </div>
  );
}

function recorderLabel(status: LiveStatus | null): string {
  if (!status || status.recorder.status === 'checking') return 'comprobando...';
  if (status.recorder.status === 'unavailable') return 'no disponible';
  return status.recorder.backend === 'overwolf'
    ? 'Overwolf (OBS, hardware)'
    : 'FFmpeg (pantalla, automatico)';
}

function providerLabel(status: LiveStatus | null): string {
  if (!status) return 'comprobando...';
  const name =
    status.provider.provider === 'riot-live-client'
      ? 'API de Riot'
      : status.provider.provider === 'r6-replay'
        ? 'Repeticiones de R6'
        : status.provider.provider === 'valorant-match-api'
          ? 'Historial de VALORANT'
          : 'GEP';
  switch (status.provider.status) {
    case 'connected':
      return `${name} conectado`;
    case 'connecting':
      return 'conectando...';
    case 'disconnected':
      return `${name} listo, sin juego`;
    case 'elevation-required':
      return 'requiere administrador';
    case 'error':
      return 'error';
    default:
      // Que GEP no este no significa quedarse sin eventos: cada juego tiene su
      // via nativa, que se activa al detectarlo. Decir "no disponible" aqui
      // asustaba sin motivo.
      return 'vias nativas, por juego';
  }
}

/**
 * Avisos de estado.
 *
 * Es la parte que evita el "fallo silencioso" del que hablabas: si GEP no esta
 * disponible o el juego corre elevado, se dice claramente y se explica que
 * hacer, en lugar de grabar partidas sin marcadores sin que el usuario sepa
 * por que.
 */
function ProviderBanners({
  status,
  onNotify,
}: {
  status: LiveStatus | null;
  onNotify: (title: string, message: string) => void;
}) {
  if (!status) return null;
  const banners = [];

  if (status.provider.status === 'elevation-required') {
    banners.push(
      <div className="banner banner--error" key="elevation">
        <span style={{ fontSize: 17 }}>🛡</span>
        <div>
          <div className="banner__title">El juego se ejecuta como administrador</div>
          <div className="banner__body">
            {status.provider.message ??
              'Reinicia Clipper como administrador para poder recibir los eventos del juego.'}{' '}
            Mientras tanto la partida se grabara, pero sin marcadores de kills ni muertes.
            Los atajos globales tampoco funcionaran con el juego en primer plano.
          </div>
          <div className="banner__actions">
            <button
              className="btn btn--sm"
              onClick={() =>
                void api.restartAsAdmin().then((r) =>
                  onNotify('Reiniciar como administrador', r.instructions),
                )
              }
            >
              Como hacerlo
            </button>
          </div>
        </div>
      </div>,
    );
  } else if (status.provider.status === 'unavailable') {
    banners.push(
      <div className="banner banner--info" key="gep">
        <span style={{ fontSize: 17 }}>ℹ</span>
        <div>
          <div className="banner__title">Funcionando sin Overwolf</div>
          <div className="banner__body">
            Los tres juegos tienen marcadores igualmente, usando las fuentes que ellos mismos
            exponen: la API local de Riot en League of Legends, las repeticiones del juego en
            Rainbow Six (requiere tener activado Match Replay) y el historial de partidas en
            VALORANT. Frente a Overwolf solo se pierden dos cosas: los marcadores de Rainbow Six
            y VALORANT aparecen al terminar la partida en vez de en directo, y VALORANT no
            distingue headshots. No hay nada que configurar.
          </div>
        </div>
      </div>,
    );
  }

  if (status.recorder.status === 'ready' && status.recorder.backend === 'ffmpeg') {
    banners.push(
      <div className="banner banner--info" key="ffmpeg">
        <span style={{ fontSize: 17 }}>ℹ</span>
        <div>
          <div className="banner__title">Grabando con FFmpeg</div>
          <div className="banner__body">
            Se captura la pantalla en lugar del proceso del juego. Clipper elige solo el monitor
            y el metodo, comprobando que se vea imagen de verdad, asi que no tienes que
            configurar nada.
          </div>
        </div>
      </div>,
    );
  }

  // Solo se avisa cuando la comprobacion ha TERMINADO sin encontrar nada.
  // Mientras esta en curso no se puede afirmar que no haya sistema de captura.
  if (status.recorder.status === 'unavailable') {
    banners.push(
      <div className="banner banner--error" key="norecorder">
        <span style={{ fontSize: 17 }}>⛔</span>
        <div>
          <div className="banner__title">No hay ningun sistema de captura disponible</div>
          <div className="banner__body">
            {status.recorder.message ??
              'No se ha encontrado ningun codificador de video utilizable.'}
          </div>
        </div>
      </div>,
    );
  }

  return <>{banners}</>;
}
