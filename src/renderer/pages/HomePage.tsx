import { useEffect, useMemo, useState } from 'react';
import {
  AppSettings,
  DetectionState,
  GameEvent,
  GameEventType,
  GameKey,
  LiveStatus,
  RecordingRecord,
} from '@shared/types';
import { api } from '../lib/api';
import { EVENT_VISUALS, eventTag, formatTime } from '../lib/events';
import { RecordingCard } from '../components/RecordingCard';
import { GameFilter, GameFilterValue } from '../components/GameFilter';

export interface HomePageProps {
  status: LiveStatus | null;
  settings: AppSettings | null;
  recent: RecordingRecord[];
  onOpenRecording: (id: string) => void;
  onNotify: (title: string, message: string) => void;
  onGoToLibrary: () => void;
}

/** Las cuatro cifras del marcador en vivo, en el orden del diseno. */
const STATS = [
  { key: 'kills', label: 'Kills', color: 'var(--kill)' },
  { key: 'deaths', label: 'Muertes', color: 'var(--death)' },
  { key: 'headshots', label: 'Headshots', color: 'var(--headshot)' },
  { key: 'assists', label: 'Asistencias', color: 'var(--assist)' },
] as const;

/**
 * Pantalla de inicio.
 *
 * Manda la partida en curso: si esta grabando, lo primero que se ve es el
 * tiempo y el marcador, con los momentos que lleva detectados al lado. Si no,
 * el bloque se repliega y el peso pasa al mosaico de partidas.
 *
 * Sin avisos al entrar. Solo se interrumpe cuando algo falla de verdad, y
 * entonces con un aviso puntual que se va solo.
 */
export function HomePage({
  status,
  settings,
  recent,
  onOpenRecording,
  onNotify,
  onGoToLibrary,
}: HomePageProps) {
  const [live, setLive] = useState<GameEvent[]>([]);
  const [filter, setFilter] = useState<GameFilterValue>('all');
  const [busy, setBusy] = useState(false);

  const recording = status?.state === DetectionState.RECORDING;
  const recordingId = status?.recordingId ?? null;

  // Los momentos de la partida en curso llegan segun ocurren; al empezar otra
  // se vacian, para no arrastrar los de la anterior.
  useEffect(() => setLive([]), [recordingId]);
  useEffect(() => api.onEvent((event) => setLive((prev) => [...prev, event])), []);

  const filtered = useMemo(
    () => (filter === 'all' ? recent : recent.filter((r) => r.game === filter)),
    [recent, filter],
  );

  const elapsed = status?.elapsed ?? 0;
  const summary = status?.summary;

  async function run(action: () => Promise<unknown>, error: string) {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      onNotify(error, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="home-top">
        <section className="panel hero">
          <div className="hero__head">
            <span className="eyebrow">Partida en curso</span>
            <span
              className={`hero__auto${settings?.recording.autoRecord ? '' : ' hero__auto--off'}`}
            >
              Auto · {settings?.recording.autoRecord ? 'on' : 'off'}
            </span>
          </div>

          <div className="hero__main">
            <div className={`timer${recording ? '' : ' timer--idle'}`}>
              {formatTime(recording ? elapsed : 0)}
            </div>
            <div className="hero__game">
              <span className="hero__name">
                {status?.gameName ?? (status?.state === DetectionState.GAME_DETECTED
                  ? 'Juego detectado'
                  : 'En espera')}
              </span>
              <span className="hero__sub">
                {recording
                  ? `${status?.recorder.backend === 'overwolf' ? 'Captura del juego' : 'Captura de pantalla'} · ${settings?.recording.resolution ?? 1080}p${settings?.recording.fps ?? 60}`
                  : 'Abre un juego y empezara sola. VALORANT, Rainbow Six y League of Legends marcan los momentos solos.'}
              </span>
            </div>
          </div>

          {/* Sin grabar no hay marcador que ensenar: cuatro ceros enormes solo
              hacen que la pantalla parezca vacia. */}
          {recording && summary && (
            <div className="stats">
              {STATS.map(({ key, label, color }) => (
                <div className="stats__cell" key={key}>
                  <span className="stats__n" style={{ color }}>
                    {summary[key]}
                  </span>
                  <span className="stats__l">{label}</span>
                </div>
              ))}
            </div>
          )}

          <div className="hero__actions">
            {recording ? (
              <>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const ok = await api.addBookmark();
                      if (ok) onNotify('Momento marcado', 'Lo encontraras en la linea temporal.');
                    }, 'No se ha podido marcar')
                  }
                >
                  Marcar momento · {settings?.hotkeys.bookmark ?? 'F9'}
                </button>
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() => void run(() => api.stopRecording(), 'No se ha podido detener')}
                >
                  Detener
                </button>
              </>
            ) : (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void run(() => api.startRecording(), 'No se ha podido grabar')}
              >
                Grabar ahora
              </button>
            )}
          </div>

          <div className="hero__foot">
            {recording && (
              <div className="live">
                <span className="live__label">En vivo</span>
                <div className="live__track">
                  {live.map((event) => (
                    <span
                      key={event.id}
                      className="live__mark"
                      title={`${EVENT_VISUALS[event.type].label} · ${formatTime(event.videoTime)}`}
                      style={{
                        left: `${elapsed > 0 ? Math.min(98, (event.videoTime / elapsed) * 100) : 0}%`,
                        background: EVENT_VISUALS[event.type].color,
                      }}
                    />
                  ))}
                  <span className="live__now" />
                </div>
                <span className="live__n">{live.length} mom.</span>
              </div>
            )}

            <div className="hero__status">
              <span>
                Captura <b>{status?.recorder.backend === 'overwolf' ? 'Overwolf' : 'FFmpeg'}</b>
              </span>
              <span>
                Eventos <b>{status?.provider.provider === 'gep' ? 'GEP' : 'Nativo'}</b>
              </span>
              {status?.diskFreeGb != null && (
                <span>
                  Disco <b className="mono">{Math.round(status.diskFreeGb)} GB</b>
                </span>
              )}
              <div className="hair" style={{ background: 'transparent' }} />
              <span className="hero__keys">
                <b className="kbd">{settings?.hotkeys.saveClip ?? 'F8'}</b> clip
                <b className="kbd">{settings?.hotkeys.bookmark ?? 'F9'}</b> marcador
              </span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="moments__head eyebrow">Momentos de esta partida</div>
          <div className="moments__list">
            {live.length === 0 ? (
              <div className="empty" style={{ padding: '24px 12px' }}>
                <div className="empty__hint">
                  {recording
                    ? 'Todavia no ha pasado nada. Los que marques con el atajo apareceran aqui.'
                    : 'Aqui se iran apuntando los momentos de la partida mientras juegas.'}
                </div>
              </div>
            ) : (
              [...live]
                .reverse()
                .map((event) => (
                  <button
                    key={event.id}
                    className="moment"
                    style={{ borderLeftColor: EVENT_VISUALS[event.type].color }}
                    onClick={() => recordingId && onOpenRecording(recordingId)}
                  >
                    <span className="moment__t">{formatTime(event.videoTime)}</span>
                    <span className="moment__l">{EVENT_VISUALS[event.type].label}</span>
                    <span className="moment__tag">{eventTag(event.type)}</span>
                  </button>
                ))
            )}
          </div>
          <div className="moments__foot">
            <button
              className="btn btn--quiet btn--wide"
              disabled={!recordingId}
              onClick={() => recordingId && onOpenRecording(recordingId)}
            >
              Abrir la partida entera
            </button>
          </div>
        </section>
      </div>

      <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="section-h">
          <h2>Mis partidas</h2>
          <div className="hair" />
          <GameFilter recordings={recent} value={filter} onChange={setFilter} />
        </div>

        {filtered.length === 0 ? (
          <div className="empty">
            <div className="empty__title">Todavia no hay partidas</div>
            <div className="empty__hint">
              Abre un juego y Clipper empezara a grabar sola.
            </div>
          </div>
        ) : (
          <div className="grid-recs">
            {filtered.slice(0, 8).map((recording) => (
              <RecordingCard
                key={recording.id}
                recording={recording}
                onOpen={() => onOpenRecording(recording.id)}
              />
            ))}
          </div>
        )}

        {filtered.length > 8 && (
          <button className="btn btn--quiet" onClick={onGoToLibrary}>
            Ver las {filtered.length} partidas
          </button>
        )}
      </section>
    </>
  );
}

/** Tipos que cuentan como "momento" en la tira en vivo. */
export const MOMENT_TYPES: GameEventType[] = [
  GameEventType.KILL,
  GameEventType.DEATH,
  GameEventType.HEADSHOT,
  GameEventType.ASSIST,
  GameEventType.BOOKMARK,
  GameEventType.HIGHLIGHT,
];

export type { GameKey };
