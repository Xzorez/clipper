import { useCallback, useEffect, useState } from 'react';
import { AppSettings, DetectionState, LiveStatus, RecordingRecord } from '@shared/types';
import { api } from './lib/api';
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
  { name: 'home', icon: '⌂', label: 'Inicio' },
  { name: 'library', icon: '▤', label: 'Mis partidas' },
  { name: 'clips', icon: '✂', label: 'Clips' },
  { name: 'settings', icon: '⚙', label: 'Configuracion' },
] as const;

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [recordings, setRecordings] = useState<RecordingRecord[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [clipsToken, setClipsToken] = useState(0);

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

  // Carga inicial y suscripciones al proceso principal.
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
        <div className="sidebar__brand">
          <span className="sidebar__logo">◉</span>
          Clipper
        </div>

        {NAV.map((item) => (
          <button
            key={item.name}
            className={`nav-item${route.name === item.name ? ' nav-item--active' : ''}`}
            onClick={() => setRoute({ name: item.name } as Route)}
          >
            <span className="nav-item__icon">{item.icon}</span>
            {item.label}
          </button>
        ))}

        <div className="sidebar__spacer" />

        <div className="sidebar__status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <span className={`dot ${recording ? 'dot--live' : status ? 'dot--ready' : 'dot--warn'}`} />
            <strong style={{ color: 'var(--text-0)', fontSize: 12.5 }}>
              {recording ? 'Grabando' : 'En espera'}
            </strong>
          </div>
          {recording && status?.gameName && (
            <div style={{ fontSize: 11.5 }}>{status.gameName}</div>
          )}
          {!recording && (
            <div style={{ fontSize: 11.5, lineHeight: 1.4 }}>
              Deteccion automatica activa
            </div>
          )}
        </div>
      </aside>

      <main className="content">
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
      </main>

      <div className="toast-stack">
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
