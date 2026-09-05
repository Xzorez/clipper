import { useCallback, useEffect, useState } from 'react';
import { AppSettings, DetectionState, LiveStatus, RecordingRecord } from '@shared/types';
import { api } from './lib/api';
import { Logo } from './components/Logo';
import { UpdateIndicator } from './components/UpdateIndicator';
import { useUpdateStatus } from './lib/useUpdateStatus';
import { IconHome, IconLibrary, IconClips, IconSettings } from './components/Icons';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { PlayerPage } from './pages/PlayerPage';
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
  { name: 'home', label: 'Inicio', Icon: IconHome },
  { name: 'library', label: 'Mis partidas', Icon: IconLibrary },
  { name: 'clips', label: 'Clips', Icon: IconClips },
  { name: 'settings', label: 'Ajustes', Icon: IconSettings },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clipsToken, setClipsToken] = useState(0);
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
    setRoute({ name: 'player', recordingId });
  }, []);

  const recording = status?.state === DetectionState.RECORDING;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={26} className="brand__mark" />
          <span className="brand__name">Clipper</span>
        </div>

        <nav className="nav">
          {NAV.map(({ name, label, Icon }) => (
            <button
              key={name}
              className={`nav__item${route.name === name ? ' nav__item--on' : ''}`}
              onClick={() => setRoute({ name } as Route)}
            >
              <Icon size={16} className="nav__icon" />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar__gap" />

        <UpdateIndicator status={update.status} onInstall={update.install} />

        <div className={`pill${recording ? ' pill--live' : ''}`}>
          <span className={`dot ${recording ? 'dot--live' : 'dot--ready'}`} />
          {recording ? status?.gameName ?? 'Grabando' : 'Listo'}
        </div>
      </aside>

      <main className="content">
        <div className="page rise" key={route.name}>
          {route.name === 'home' && (
            <HomePage
              status={status}
              recent={recordings}
              onOpenRecording={openRecording}
              onNotify={notify}
              onGoToLibrary={() => setRoute({ name: 'library' })}
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
              onBack={() => setRoute({ name: 'library' })}
              onNotify={notify}
              onClipCreated={() => setClipsToken((t) => t + 1)}
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
            <div className="toast__title">{toast.title}</div>
            <div className="toast__body">{toast.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
