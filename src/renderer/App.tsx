import { useCallback, useEffect, useState } from 'react';
import { AppSettings, DetectionState, LiveStatus, RecordingRecord } from '@shared/types';
import { api } from './lib/api';
import { Logo } from './components/Logo';
import { UpdateIndicator } from './components/UpdateIndicator';
import { useUpdateStatus } from './lib/useUpdateStatus';
import { IconMinimize, IconMaximize, IconClose } from './components/Icons';
import { formatTime } from './lib/events';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { PlayerPage, PlayerHeader } from './pages/PlayerPage';
import { ClipsPage } from './pages/ClipsPage';
import { SettingsPage } from './pages/SettingsPage';

type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'clips' }
  | { name: 'settings' }
  | { name: 'player'; recordingId: string };

interface Toast {
  id: number;
  title: string;
  message: string;
}

const NAV = [
  { name: 'home', label: 'Inicio' },
  { name: 'library', label: 'Partidas' },
  { name: 'clips', label: 'Clips' },
  { name: 'settings', label: 'Ajustes' },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [clipCount, setClipCount] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clipsToken, setClipsToken] = useState(0);
  /**
   * Cabecera del reproductor.
   *
   * En el detalle, la barra superior deja de ser navegacion y pasa a ser la
   * cabecera de la partida: miga de pan, marcador y acciones. Los datos los
   * tiene la pagina, asi que los sube; asi la barra no necesita saber nada de
   * grabaciones.
   */
  const [playerHeader, setPlayerHeader] = useState<PlayerHeader | null>(null);
  const update = useUpdateStatus();

  /**
   * Los avisos son puntuales y se van solos.
   *
   * La aplicacion no muestra nada al entrar: solo aparece algo cuando ocurre
   * de verdad, y desaparece sin que haya que cerrarlo.
   */
  const notify = useCallback((title: string, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((previous) => [...previous, { id, title, message }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((t) => t.id !== id));
    }, 7000);
  }, []);

  const loadRecordings = useCallback(() => {
    void api
      .listRecordings()
      .then(setRecordings)
      .catch((err) => notify('No se ha podido cargar la biblioteca', (err as Error).message));
  }, [notify]);

  useEffect(() => {
    void api.getStatus().then(setStatus).catch(() => undefined);
    void api.getSettings().then(setSettings).catch(() => undefined);
    loadRecordings();

    const unsubscribers = [
      api.onStatus(setStatus),
      api.onLibraryChanged(() => loadRecordings()),
      api.onWarning((warning) => notify(warning.title, warning.message)),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [loadRecordings, notify]);

  // El contador de la navegacion sale de la lista real, no de una suma aparte
  // que podria quedarse vieja.
  useEffect(() => {
    void api
      .listClips()
      .then((clips) => setClipCount(clips.length))
      .catch(() => undefined);
  }, [clipsToken]);

  const updateSettings = useCallback(
    (patch: unknown) => {
      void api
        .updateSettings(patch)
        .then(setSettings)
        .catch((err) => notify('No se ha podido guardar', (err as Error).message));
    },
    [notify],
  );

  const openRecording = useCallback((recordingId: string) => {
    setPlayerHeader(null);
    setRoute({ name: 'player', recordingId });
  }, []);

  const go = useCallback((name: Route['name']) => {
    setPlayerHeader(null);
    setRoute({ name } as Route);
  }, []);

  const recording = status?.state === DetectionState.RECORDING;
  const inPlayer = route.name === 'player';
  const counts: Partial<Record<Route['name'], number>> = {
    library: recordings.length,
    clips: clipCount,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo size={20} />
          <span className="brand__name">Clipper</span>
        </div>

        {inPlayer && playerHeader ? (
          <>
            <div className="crumb">
              <button className="crumb__back" onClick={() => go('library')}>
                PARTIDAS
              </button>
              <span className="crumb__sep">/</span>
              <span className="crumb__here">{playerHeader.title}</span>
            </div>
            <div className="hair" style={{ background: 'transparent' }} />
            <div className="kda">
              <span style={{ color: 'var(--kill)' }}>{playerHeader.kills} K</span>
              <span style={{ color: 'var(--death)' }}>{playerHeader.deaths} D</span>
              <span style={{ color: 'var(--assist)' }}>{playerHeader.assists} A</span>
              <span style={{ color: 'var(--text-2)' }}>{formatTime(playerHeader.duration)}</span>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={playerHeader.onFolder}>
              Carpeta
            </button>
            <button
              className="btn btn--sm"
              onClick={playerHeader.onClip}
              disabled={playerHeader.clipBusy}
            >
              Crear clip · F8
            </button>
          </>
        ) : (
          <>
            <nav className="nav">
              {NAV.map(({ name, label }) => (
                <button
                  key={name}
                  className={`nav__item${route.name === name ? ' nav__item--on' : ''}`}
                  onClick={() => go(name)}
                >
                  {label}
                  {counts[name] ? <span className="nav__n">{counts[name]}</span> : null}
                </button>
              ))}
            </nav>
            <div className="hair" style={{ background: 'transparent' }} />
          </>
        )}

        <UpdateIndicator status={update.status} onInstall={update.install} />

        <div className={`rec-chip${recording ? ' rec-chip--live' : ''}`}>
          <span className="rec-chip__dot" />
          {recording ? `REC ${formatTime(status?.elapsed ?? 0)}` : 'LISTO'}
        </div>

        <div className="wctl">
          <button onClick={() => api.minimizeWindow()} title="Minimizar">
            <IconMinimize />
          </button>
          <button onClick={() => api.toggleMaximizeWindow()} title="Maximizar">
            <IconMaximize />
          </button>
          <button onClick={() => api.closeWindow()} title="Cerrar">
            <IconClose />
          </button>
        </div>
      </header>

      <main className="content">
        <div className={`${inPlayer ? 'page page--flush' : 'page'} rise`} key={route.name}>
          {route.name === 'home' && (
            <HomePage
              status={status}
              settings={settings}
              recent={recordings}
              onOpenRecording={openRecording}
              onNotify={notify}
              onGoToLibrary={() => go('library')}
            />
          )}

          {route.name === 'library' && (
            <LibraryPage
              recordings={recordings}
              onOpenRecording={openRecording}
              onRefresh={loadRecordings}
              onNotify={notify}
            />
          )}

          {route.name === 'player' && (
            <PlayerPage
              recordingId={route.recordingId}
              settings={settings}
              onBack={() => go('library')}
              onNotify={notify}
              onClipCreated={() => setClipsToken((t) => t + 1)}
              onHeader={setPlayerHeader}
            />
          )}

          {route.name === 'clips' && <ClipsPage refreshToken={clipsToken} onNotify={notify} />}

          {route.name === 'settings' && (
            <SettingsPage
              settings={settings}
              status={status}
              onChange={updateSettings}
              onNotify={notify}
            />
          )}
        </div>
      </main>

      <div className="toasts">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            <div className="toast__t">{toast.title}</div>
            <div className="toast__m">{toast.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
