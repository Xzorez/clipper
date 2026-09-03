import { useEffect, useState } from 'react';
import { AppSettings, GAME_DISPLAY_NAMES, GameKey, LiveStatus, LogEntry } from '@shared/types';
import { api } from '../lib/api';

export interface SettingsPageProps {
  settings: AppSettings | null;
  status: LiveStatus | null;
  onChange: (patch: unknown) => void;
  onNotify: (title: string, message: string) => void;
}

type Tab = 'recording' | 'events' | 'interface' | 'hotkeys' | 'diagnostics';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'recording', label: 'Grabacion' },
  { key: 'events', label: 'Eventos' },
  { key: 'interface', label: 'Interfaz' },
  { key: 'hotkeys', label: 'Atajos' },
  { key: 'diagnostics', label: 'Diagnostico' },
];

export function SettingsPage({ settings, status, onChange, onNotify }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>('recording');

  if (!settings) return <div className="empty-state">Cargando configuracion...</div>;

  return (
    <div>
      <h1 className="page-title">Configuracion</h1>
      <p className="page-subtitle">Los cambios se guardan al instante.</p>

      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={`tab${tab === item.key ? ' tab--active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'recording' && (
        <RecordingSettings settings={settings} status={status} onChange={onChange} onNotify={onNotify} />
      )}
      {tab === 'events' && <EventSettings settings={settings} onChange={onChange} />}
      {tab === 'interface' && <InterfaceSettings settings={settings} onChange={onChange} />}
      {tab === 'hotkeys' && <HotkeySettings settings={settings} onChange={onChange} />}
      {tab === 'diagnostics' && <Diagnostics status={status} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RecordingSettings({
  settings,
  status,
  onChange,
  onNotify,
}: {
  settings: AppSettings;
  status: LiveStatus | null;
  onChange: (patch: unknown) => void;
  onNotify: (title: string, message: string) => void;
}) {
  const r = settings.recording;
  const encoders = status?.recorder.encoders ?? [];

  return (
    <div className="card">
      <div className="settings-group">
        <Row label="Grabacion automatica" hint="Empieza a grabar en cuanto se detecta un juego soportado.">
          <Switch value={r.autoRecord} onChange={(v) => onChange({ recording: { autoRecord: v } })} />
        </Row>

        <Row label="Resolucion" hint="Nunca se escala hacia arriba: si tu monitor es 1080p, 1440p no anade calidad.">
          <select
            className="select"
            value={r.resolution}
            onChange={(e) => onChange({ recording: { resolution: Number(e.target.value) } })}
          >
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
            <option value={1440}>1440p</option>
            <option value={2160}>2160p (4K)</option>
          </select>
        </Row>

        <Row label="Fotogramas por segundo">
          <select
            className="select"
            value={r.fps}
            onChange={(e) => onChange({ recording: { fps: Number(e.target.value) } })}
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
            <option value={120}>120 fps</option>
          </select>
        </Row>

        <Row label="Bitrate" hint="En kbps. Mas bitrate es mas calidad y mas espacio en disco.">
          <input
            className="input input--narrow"
            type="number"
            min={1000}
            max={200000}
            step={1000}
            value={r.bitrate}
            onChange={(e) => onChange({ recording: { bitrate: Number(e.target.value) } })}
          />
        </Row>

        <Row
          label="Codificador"
          hint={
            encoders.length > 0
              ? `Detectados: ${encoders.map((e) => e.label).join(', ')}`
              : 'Todavia no se han detectado codificadores.'
          }
        >
          <select
            className="select"
            value={r.encoder}
            onChange={(e) => onChange({ recording: { encoder: e.target.value } })}
          >
            <option value="auto">Automatico (prefiere hardware)</option>
            {encoders.map((encoder) => (
              <option key={encoder.id} value={encoder.id}>
                {encoder.label}
                {encoder.hardware ? '' : ' — software'}
              </option>
            ))}
          </select>
        </Row>

        <Row
          label="Modo de captura"
          hint="La captura del proceso consume menos recursos. Si el juego corre como administrador, se cambia a pantalla automaticamente."
        >
          <select
            className="select"
            value={r.captureMode}
            onChange={(e) => onChange({ recording: { captureMode: e.target.value } })}
          >
            <option value="game">Proceso del juego</option>
            <option value="display">Pantalla completa</option>
          </select>
        </Row>

        <Row label="Audio del sistema">
          <Switch
            value={r.captureSystemAudio}
            onChange={(v) => onChange({ recording: { captureSystemAudio: v } })}
          />
        </Row>

        <Row label="Microfono">
          <Switch
            value={r.captureMicrophone}
            onChange={(v) => onChange({ recording: { captureMicrophone: v } })}
          />
        </Row>

        <Row label="Carpeta de grabaciones">
          <span className="path-display" title={r.outputFolder}>
            {r.outputFolder}
          </span>
          <button
            className="btn btn--sm"
            onClick={() =>
              void api.pickFolder().then((folder) => {
                if (folder) onChange({ recording: { outputFolder: folder } });
              })
            }
          >
            Cambiar
          </button>
          <button
            className="btn btn--sm btn--ghost"
            onClick={() =>
              void api
                .openPath(r.outputFolder)
                .catch((err) => onNotify('No se ha podido abrir', (err as Error).message))
            }
          >
            Abrir
          </button>
        </Row>

        <Row
          label="Espacio minimo para empezar"
          hint="Si hay menos espacio libre que esto, no se inicia la grabacion."
        >
          <input
            className="input input--narrow"
            type="number"
            min={1}
            max={500}
            value={r.minFreeSpaceGb}
            onChange={(e) => onChange({ recording: { minFreeSpaceGb: Number(e.target.value) } })}
          />
          <span style={{ color: 'var(--text-2)' }}>GB</span>
        </Row>

        <Row
          label="Detener grabacion por debajo de"
          hint="Durante la grabacion, si el disco baja de este limite, se corta de forma ordenada para no perder el video."
        >
          <input
            className="input input--narrow"
            type="number"
            min={0.5}
            max={r.minFreeSpaceGb}
            step={0.5}
            value={r.stopAtFreeSpaceGb}
            onChange={(e) => onChange({ recording: { stopAtFreeSpaceGb: Number(e.target.value) } })}
          />
          <span style={{ color: 'var(--text-2)' }}>GB</span>
        </Row>
      </div>
    </div>
  );
}

function EventSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: unknown) => void;
}) {
  const e = settings.events;
  return (
    <>
      <div className="card">
        <div className="settings-group">
          <Row label="Detectar kills">
            <Switch value={e.detectKills} onChange={(v) => onChange({ events: { detectKills: v } })} />
          </Row>
          <Row label="Detectar muertes">
            <Switch value={e.detectDeaths} onChange={(v) => onChange({ events: { detectDeaths: v } })} />
          </Row>
          <Row label="Detectar headshots" hint="VALORANT y Rainbow Six Siege. League of Legends no tiene headshots.">
            <Switch
              value={e.detectHeadshots}
              onChange={(v) => onChange({ events: { detectHeadshots: v } })}
            />
          </Row>
          <Row label="Detectar asistencias">
            <Switch value={e.detectAssists} onChange={(v) => onChange({ events: { detectAssists: v } })} />
          </Row>
          <Row label="Detectar rondas" hint="Marcadores de inicio y fin de ronda.">
            <Switch value={e.detectRounds} onChange={(v) => onChange({ events: { detectRounds: v } })} />
          </Row>
        </div>
      </div>

      <div className="section-title">Calibracion de sincronizacion</div>
      <div className="card">
        <p style={{ color: 'var(--text-1)', fontSize: 13, marginTop: 0, lineHeight: 1.6 }}>
          El proveedor de eventos detecta las acciones con un pequeno retraso respecto a lo
          que ves en pantalla, porque lee el estado que expone el juego en lugar de su memoria.
          Este ajuste desplaza los marcadores hacia atras para compensarlo. Si al pulsar una
          kill el video empieza <em>despues</em> de la accion, sube el valor; si empieza
          demasiado pronto, bajalo.
        </p>
        <div className="settings-group">
          {(Object.keys(e.latencyOffsetMs) as GameKey[]).map((game) => (
            <Row
              key={game}
              label={GAME_DISPLAY_NAMES[game]}
              hint={
                game === 'lol'
                  ? 'Solo se usa con Overwolf. Con la API de Riot la latencia se calcula sola.'
                  : undefined
              }
            >
              <input
                className="input input--narrow"
                type="number"
                min={-5000}
                max={5000}
                step={50}
                value={e.latencyOffsetMs[game]}
                onChange={(ev) =>
                  onChange({
                    events: { latencyOffsetMs: { [game]: Number(ev.target.value) } },
                  })
                }
              />
              <span style={{ color: 'var(--text-2)' }}>ms</span>
            </Row>
          ))}

          <Row
            label="Desfase de las repeticiones de Rainbow Six"
            hint={
              'Solo aplica cuando los eventos de Rainbow Six vienen de las repeticiones del ' +
              'juego, sin Overwolf. Compensa la fase de preparacion: si los marcadores caen ' +
              'antes de la accion, sube el valor. Es una constante, se calibra una sola vez.'
            }
          >
            <input
              className="input input--narrow"
              type="number"
              min={-120000}
              max={120000}
              step={1000}
              value={e.r6RoundOffsetMs}
              onChange={(ev) =>
                onChange({ events: { r6RoundOffsetMs: Number(ev.target.value) } })
              }
            />
            <span style={{ color: 'var(--text-2)' }}>ms</span>
          </Row>
        </div>
      </div>

      <div className="section-title">Juegos vigilados</div>
      <div className="card">
        <div className="settings-group">
          {(Object.keys(settings.games) as GameKey[]).map((game) => (
            <Row key={game} label={GAME_DISPLAY_NAMES[game]}>
              <Switch
                value={settings.games[game]}
                onChange={(v) => onChange({ games: { [game]: v } })}
              />
            </Row>
          ))}
        </div>
      </div>
    </>
  );
}

function InterfaceSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: unknown) => void;
}) {
  const ui = settings.ui;
  const clips = settings.clips;
  return (
    <>
      <div className="card">
        <div className="settings-group">
          <Row label="Mostrar iconos en la timeline">
            <Switch value={ui.showIcons} onChange={(v) => onChange({ ui: { showIcons: v } })} />
          </Row>
          <Row label="Tamano de los iconos">
            <select
              className="select"
              value={ui.iconSize}
              onChange={(ev) => onChange({ ui: { iconSize: ev.target.value } })}
            >
              <option value="small">Pequeno</option>
              <option value="medium">Mediano</option>
              <option value="large">Grande</option>
            </select>
          </Row>
          <Row
            label="Reproducir desde antes del evento"
            hint="Al hacer clic en un marcador, retrocede unos segundos para ver el contexto."
          >
            <Switch
              value={ui.playFromBeforeEnabled}
              onChange={(v) => onChange({ ui: { playFromBeforeEnabled: v } })}
            />
          </Row>
          <Row label="Segundos de contexto">
            <input
              className="input input--narrow"
              type="number"
              min={0}
              max={60}
              value={ui.playFromSecondsBefore}
              onChange={(ev) => onChange({ ui: { playFromSecondsBefore: Number(ev.target.value) } })}
            />
            <span style={{ color: 'var(--text-2)' }}>s</span>
          </Row>
        </div>
      </div>

      <div className="section-title">Clips</div>
      <div className="card">
        <div className="settings-group">
          <Row label="Segundos antes del evento">
            <input
              className="input input--narrow"
              type="number"
              min={1}
              max={120}
              value={clips.secondsBefore}
              onChange={(ev) => onChange({ clips: { secondsBefore: Number(ev.target.value) } })}
            />
          </Row>
          <Row label="Segundos despues del evento">
            <input
              className="input input--narrow"
              type="number"
              min={1}
              max={120}
              value={clips.secondsAfter}
              onChange={(ev) => onChange({ clips: { secondsAfter: Number(ev.target.value) } })}
            />
          </Row>
        </div>
      </div>
    </>
  );
}

function HotkeySettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: unknown) => void;
}) {
  const h = settings.hotkeys;
  const rows: Array<{ key: keyof typeof h; label: string; hint: string }> = [
    { key: 'saveClip', label: 'Marcar para clip', hint: 'Marca el momento actual para recortarlo despues.' },
    { key: 'bookmark', label: 'Marcar momento', hint: 'Anade un marcador manual a la timeline.' },
    { key: 'toggleRecording', label: 'Iniciar / detener grabacion', hint: '' },
  ];

  return (
    <>
      <div className="card">
        <div className="settings-group">
          {rows.map((row) => (
            <Row key={row.key} label={row.label} hint={row.hint}>
              <input
                className="input input--narrow"
                value={h[row.key]}
                onChange={(ev) => onChange({ hotkeys: { [row.key]: ev.target.value } })}
                placeholder="F8"
              />
            </Row>
          ))}
        </div>
      </div>
      <div className="banner banner--info" style={{ marginTop: 16 }}>
        <span>ℹ</span>
        <div>
          <div className="banner__title">Sobre los atajos globales</div>
          <div className="banner__body">
            Se registran en el sistema, asi que funcionan con el juego en primer plano, incluso
            a pantalla completa. La unica excepcion es un juego ejecutado como administrador:
            en ese caso Windows bloquea la entrada de procesos sin privilegios y hay que abrir
            Clipper tambien como administrador. Acepta combinaciones como{' '}
            <span className="kbd">F8</span>, <span className="kbd">Ctrl+Shift+S</span> o{' '}
            <span className="kbd">Alt+X</span>.
          </div>
        </div>
      </div>
    </>
  );
}

function Diagnostics({ status }: { status: LiveStatus | null }) {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    void api.getDiagnostics().then(setInfo).catch(() => undefined);
    void api.getLogs().then(setLogs).catch(() => undefined);
    const unsubscribe = api.onLog((entry) => {
      setLogs((previous) => [...previous.slice(-400), entry]);
    });
    return unsubscribe;
  }, []);

  return (
    <>
      <div className="card">
        <div className="settings-group">
          <Row label="Proveedor de eventos" hint={status?.provider.message ?? ''}>
            <strong>{status?.provider.status ?? 'desconocido'}</strong>
          </Row>
          <Row label="Sistema de captura" hint={status?.recorder.message ?? ''}>
            <strong>{status?.recorder.backend ?? 'ninguno'}</strong>
          </Row>
          <Row label="Codificadores detectados">
            <span style={{ color: 'var(--text-1)', fontSize: 12 }}>
              {status?.recorder.encoders.map((e) => e.label).join(', ') || 'ninguno'}
            </span>
          </Row>
          {info?.valorant ? <ValorantDiagnostics data={info.valorant as Record<string, unknown>} /> : null}
          {info &&
            Object.entries(info)
              .filter(([key]) => ['electron', 'node', 'chrome', 'platform', 'isElevated'].includes(key))
              .map(([key, value]) => (
                <Row key={key} label={labelFor(key)}>
                  <span style={{ color: 'var(--text-1)', fontSize: 12 }}>{String(value)}</span>
                </Row>
              ))}
        </div>
      </div>

      <div className="section-title">Registro</div>
      <div className="log-view">
        {logs.length === 0 ? (
          <div style={{ color: 'var(--text-2)' }}>Sin entradas todavia.</div>
        ) : (
          logs.slice(-250).map((entry, index) => (
            <div key={index} className={`log-line--${entry.level}`}>
              {new Date(entry.time).toLocaleTimeString('es-ES')}{' '}
              <span className="log-tag">[{entry.tag}]</span> {entry.message}
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * Estado de la via nativa de VALORANT.
 *
 * El flujo solo queda confirmado con el juego abierto, asi que conviene que el
 * usuario pueda comprobarlo de un vistazo en lugar de adivinar.
 */
function ValorantDiagnostics({ data }: { data: Record<string, unknown> }) {
  const ok = (value: unknown) => (value ? 'si' : 'no');
  return (
    <>
      <Row label="VALORANT: registro del juego" hint="Necesario para saber tu region y version.">
        <span style={{ color: 'var(--text-1)', fontSize: 12 }}>
          {ok(data.gameLog)}
          {data.version ? ` (${String(data.version)})` : ''}
        </span>
      </Row>
      <Row label="VALORANT: cliente de Riot abierto">
        <span style={{ color: 'var(--text-1)', fontSize: 12 }}>{ok(data.lockfile)}</span>
      </Row>
      <Row label="VALORANT: sesion disponible" hint={String(data.hint ?? '')}>
        <span
          style={{
            color: data.session ? 'var(--success)' : 'var(--warning)',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {ok(data.session)}
          {data.shard ? ` · region ${String(data.shard)}` : ''}
        </span>
      </Row>
    </>
  );
}

function labelFor(key: string): string {
  const map: Record<string, string> = {
    electron: 'Version de Electron',
    node: 'Version de Node',
    chrome: 'Version de Chromium',
    platform: 'Plataforma',
    isElevated: 'Ejecutando como administrador',
  };
  return map[key] ?? key;
}

// --- Controles reutilizables ------------------------------------------------

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row__info">
        <div className="setting-row__label">{label}</div>
        {hint && <div className="setting-row__hint">{hint}</div>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

function Switch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      className={`switch${value ? ' switch--on' : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
    >
      <span className="switch__knob" />
    </button>
  );
}
