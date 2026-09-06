import { ReactNode, useEffect, useState } from 'react';
import {
  AppSettings,
  GAME_DISPLAY_NAMES,
  GameKey,
  LiveStatus,
  LogEntry,
  UpdateStatus,
} from '@shared/types';
import { api } from '../lib/api';
import { useUpdateStatus } from '../lib/useUpdateStatus';

type Tab = 'recording' | 'events' | 'hotkeys' | 'diagnostics';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'recording', label: 'Grabacion' },
  { key: 'events', label: 'Momentos' },
  { key: 'hotkeys', label: 'Atajos' },
  { key: 'diagnostics', label: 'Diagnostico' },
];

export interface SettingsPageProps {
  settings: AppSettings | null;
  status: LiveStatus | null;
  onChange: (patch: unknown) => void;
  onNotify: (title: string, message: string) => void;
}

/* --- Piezas comunes -------------------------------------------------------
   Una fila es siempre lo mismo: que es, por que importa, y el control a la
   derecha. Mantenerlo identico en las cuatro pestanas es lo que evita que
   Ajustes se lea como una parrilla.
-------------------------------------------------------------------------- */

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <div className="row__text">
        <span className="row__l">{label}</span>
        {hint && <span className="row__hint">{hint}</span>}
      </div>
      <div className="row__ctl">{children}</div>
    </div>
  );
}

function Switch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`switch${value ? ' switch--on' : ''}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    />
  );
}

export function SettingsPage({ settings, status, onChange, onNotify }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>('recording');

  if (!settings) {
    return (
      <div className="empty">
        <div className="empty__title">Cargando ajustes</div>
      </div>
    );
  }

  return (
    <>
      <div className="section-h">
        <h1 className="title">Ajustes</h1>
        <div className="hair" />
      </div>

      <div className="tabs">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            className={`chip${tab === key ? ' chip--on' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'recording' && (
        <RecordingTab settings={settings} status={status} onChange={onChange} onNotify={onNotify} />
      )}
      {tab === 'events' && <EventsTab settings={settings} onChange={onChange} />}
      {tab === 'hotkeys' && <HotkeysTab settings={settings} />}
      {tab === 'diagnostics' && <DiagnosticsTab status={status} />}
    </>
  );
}

/* --- Grabacion ----------------------------------------------------------- */

function RecordingTab({
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
  const g = settings.general;
  const encoders = status?.recorder.encoders ?? [];

  return (
    <>
      <span className="eyebrow">En segundo plano</span>
      <div className="rows">
        <Row
          label="Arrancar con Windows"
          hint="Se abre sola al iniciar sesion, directamente en la bandeja. Sin esto solo graba si te acuerdas de abrirla despues de cada reinicio."
        >
          <Switch
            value={g.startWithWindows}
            onChange={(v) => onChange({ general: { startWithWindows: v } })}
          />
        </Row>
        <Row
          label="Cerrar la ventana la esconde"
          hint="Sigue vigilando partidas con la ventana cerrada. Para salir de verdad, boton derecho en el icono de la bandeja."
        >
          <Switch
            value={g.closeToTray}
            onChange={(v) => onChange({ general: { closeToTray: v } })}
          />
        </Row>
      </div>

      <span className="eyebrow">Captura</span>
      <div className="rows">
        <Row
          label="Grabacion automatica"
          hint="Empieza a grabar en cuanto detecta un juego."
        >
          <Switch
            value={r.autoRecord}
            onChange={(v) => onChange({ recording: { autoRecord: v } })}
          />
        </Row>

        <Row
          label="Resolucion"
          hint="Nunca se escala hacia arriba: si tu monitor es 1080p, 1440p no anade calidad."
        >
          <select
            className="cap"
            value={r.resolution}
            onChange={(e) => onChange({ recording: { resolution: Number(e.target.value) } })}
          >
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
            <option value={1440}>1440p</option>
            <option value={2160}>2160p</option>
          </select>
        </Row>

        <Row label="Fotogramas por segundo">
          <select
            className="cap"
            value={r.fps}
            onChange={(e) => onChange({ recording: { fps: Number(e.target.value) } })}
          >
            <option value={30}>30</option>
            <option value={60}>60</option>
            <option value={120}>120</option>
          </select>
        </Row>

        <Row label="Calidad" hint="Mas bitrate es mas calidad y mas disco por hora.">
          <input
            className="cap"
            type="number"
            min={2000}
            max={60000}
            step={1000}
            value={r.bitrate}
            onChange={(e) => onChange({ recording: { bitrate: Number(e.target.value) } })}
          />
        </Row>

        <Row label="Codificador" hint="Automatico elige el de tu tarjeta grafica.">
          <select
            className="cap"
            value={r.encoder}
            onChange={(e) => onChange({ recording: { encoder: e.target.value } })}
          >
            <option value="auto">Automatico</option>
            {encoders.map((encoder) => (
              <option key={encoder.id} value={encoder.id}>
                {encoder.label}
              </option>
            ))}
          </select>
        </Row>

        <Row
          label="Que se captura"
          hint="Solo el juego graba unicamente su ventana, asi que cambiar de programa a mitad de partida no sale en el video. Si no encuentra la ventana, graba la pantalla igualmente."
        >
          <select
            className="cap"
            value={r.captureMode}
            onChange={(e) => onChange({ recording: { captureMode: e.target.value } })}
          >
            <option value="game">Solo el juego</option>
            <option value="display">Pantalla completa</option>
          </select>
        </Row>

        <Row
          label="Audio del sistema"
          hint="El sonido del juego y de todo lo que suene, tal como sale por tus altavoces o cascos."
        >
          <Switch
            value={r.captureSystemAudio}
            onChange={(v) => onChange({ recording: { captureSystemAudio: v } })}
          />
        </Row>

        <Row label="Microfono" hint="Tu voz, mezclada con el sonido del juego en la misma pista.">
          <Switch
            value={r.captureMicrophone}
            onChange={(v) => onChange({ recording: { captureMicrophone: v } })}
          />
        </Row>

        <Row label="Carpeta de grabaciones">
          <span className="path" title={r.outputFolder}>
            {r.outputFolder}
          </span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void api.pickFolder().then((folder) => {
                if (folder) onChange({ recording: { outputFolder: folder } });
              })
            }
          >
            Cambiar
          </button>
          <button
            className="btn btn--ghost btn--sm"
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
            className="cap"
            type="number"
            min={1}
            max={500}
            value={r.minFreeSpaceGb}
            onChange={(e) => onChange({ recording: { minFreeSpaceGb: Number(e.target.value) } })}
          />
        </Row>

        <Row
          label="Detener por debajo de"
          hint="Durante la grabacion, si el disco baja de este limite, se corta de forma ordenada para no perder el video."
        >
          <input
            className="cap"
            type="number"
            min={0.5}
            max={r.minFreeSpaceGb}
            step={0.5}
            value={r.stopAtFreeSpaceGb}
            onChange={(e) => onChange({ recording: { stopAtFreeSpaceGb: Number(e.target.value) } })}
          />
        </Row>
      </div>
    </>
  );
}

/* --- Momentos ------------------------------------------------------------ */

function EventsTab({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (patch: unknown) => void;
}) {
  const e = settings.events;
  const ui = settings.ui;
  const c = settings.clips;

  const detectors: Array<[keyof typeof e, string]> = [
    ['detectKills', 'Detectar kills'],
    ['detectDeaths', 'Detectar muertes'],
    ['detectHeadshots', 'Detectar headshots'],
    ['detectAssists', 'Detectar asistencias'],
    ['detectRounds', 'Detectar rondas'],
  ];

  return (
    <>
      <span className="eyebrow">Que se marca</span>
      <div className="rows">
        {detectors.map(([key, label]) => (
          <Row key={key} label={label}>
            <Switch
              value={Boolean(e[key])}
              onChange={(v) => onChange({ events: { [key]: v } })}
            />
          </Row>
        ))}
        <Row
          label="Destacados por sonido"
          hint="Al terminar de grabar, busca en el audio los momentos que destacan sobre el resto. Solo en partidas sin eventos del juego, y solo si se grabo sonido."
        >
          <Switch
            value={e.audioHighlights}
            onChange={(v) => onChange({ events: { audioHighlights: v } })}
          />
        </Row>
      </div>

      <span className="eyebrow">Juegos vigilados</span>
      <div className="rows">
        {(Object.keys(settings.games) as GameKey[]).map((game) => (
          <Row
            key={game}
            label={GAME_DISPLAY_NAMES[game]}
            hint={
              game === 'generic'
                ? 'Cualquier otro juego que detecte. Se graba entero, pero sin marcadores automaticos: esos los pones tu con el atajo.'
                : undefined
            }
          >
            <Switch
              value={settings.games[game]}
              onChange={(v) => onChange({ games: { [game]: v } })}
            />
          </Row>
        ))}
      </div>

      <span className="eyebrow">Al reproducir y recortar</span>
      <div className="rows">
        <Row
          label="Empezar unos segundos antes"
          hint="Al saltar a un momento, el video arranca un poco antes para ver como llegaste."
        >
          <Switch
            value={ui.playFromBeforeEnabled}
            onChange={(v) => onChange({ ui: { playFromBeforeEnabled: v } })}
          />
          <input
            className="cap"
            type="number"
            min={0}
            max={30}
            value={ui.playFromSecondsBefore}
            onChange={(e2) => onChange({ ui: { playFromSecondsBefore: Number(e2.target.value) } })}
          />
        </Row>
        <Row label="Segundos antes del momento" hint="Margen por defecto al crear un clip.">
          <input
            className="cap"
            type="number"
            min={0}
            max={60}
            value={c.secondsBefore}
            onChange={(e2) => onChange({ clips: { secondsBefore: Number(e2.target.value) } })}
          />
        </Row>
        <Row label="Segundos despues del momento">
          <input
            className="cap"
            type="number"
            min={0}
            max={60}
            value={c.secondsAfter}
            onChange={(e2) => onChange({ clips: { secondsAfter: Number(e2.target.value) } })}
          />
        </Row>
      </div>

      <span className="eyebrow">Calibracion de sincronizacion</span>
      <div className="rows">
        {(Object.keys(e.latencyOffsetMs) as GameKey[])
          // Los juegos genericos no tienen marcadores automaticos que
          // compensar: los pone quien juega, justo donde pulsa.
          .filter((game) => game !== 'generic')
          .map((game) => (
            <Row
              key={game}
              label={GAME_DISPLAY_NAMES[game]}
              hint={
                game === 'lol'
                  ? 'Solo se usa con Overwolf. Con la API de Riot la latencia se calcula sola.'
                  : 'Desplaza los marcadores hacia atras para compensar el retraso del proveedor de eventos.'
              }
            >
              <input
                className="cap"
                type="number"
                min={0}
                max={3000}
                step={50}
                value={e.latencyOffsetMs[game]}
                onChange={(e2) =>
                  onChange({ events: { latencyOffsetMs: { [game]: Number(e2.target.value) } } })
                }
              />
            </Row>
          ))}
      </div>
    </>
  );
}

/* --- Atajos -------------------------------------------------------------- */

function HotkeysTab({ settings }: { settings: AppSettings }) {
  const h = settings.hotkeys;
  const rows: Array<[string, string, string]> = [
    ['Guardar clip', h.saveClip, 'Recorta alrededor de este instante sin volver a grabar nada.'],
    ['Marcar momento', h.bookmark, 'Deja una marca en la linea temporal para repasarla despues.'],
    ['Grabar o detener', h.toggleRecording, 'Fuerza el inicio o el final de la grabacion.'],
  ];

  return (
    <>
      <div className="rows">
        {rows.map(([label, key, hint]) => (
          <Row key={label} label={label} hint={hint}>
            <span className="kbd">{key}</span>
          </Row>
        ))}
      </div>

      <div className="note">
        <div>
          <b>Sobre los atajos globales</b>
          Funcionan con el juego en primer plano. Si otro programa ya usa la misma tecla, Windows
          se la da al primero que la registro y aqui dejara de responder.
        </div>
      </div>
    </>
  );
}

/* --- Diagnostico --------------------------------------------------------- */

function DiagnosticsTab({ status }: { status: LiveStatus | null }) {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    void api.getDiagnostics().then(setInfo).catch(() => undefined);
    void api.getLogs().then(setLogs).catch(() => undefined);
    return api.onLog((entry) => setLogs((prev) => [...prev.slice(-400), entry]));
  }, []);

  const captura = status?.recorder.backend === 'overwolf' ? 'Overwolf' : 'FFmpeg';
  const eventos = status?.provider.provider === 'gep' ? 'GEP' : 'nativo';
  const disco = status?.diskFreeGb != null ? `${Math.round(status.diskFreeGb)} GB libres` : null;

  return (
    <>
      <div className="diag">
        <span className="diag__dot" />
        <span>
          Captura {captura} · eventos {eventos}
          {disco ? ` · ${disco}` : ''}
        </span>
      </div>

      <div className="rows">
        <UpdateRow />
        <Row label="Proveedor de eventos" hint={status?.provider.message ?? ''}>
          <span className="cap">{status?.provider.status ?? 'desconocido'}</span>
        </Row>
        <Row label="Sistema de captura" hint={status?.recorder.message ?? ''}>
          <span className="cap">{status?.recorder.backend ?? 'ninguno'}</span>
        </Row>
        <Row label="Codificadores detectados">
          <span className="row__hint">
            {status?.recorder.encoders.map((e) => e.label).join(', ') || 'ninguno'}
          </span>
        </Row>
        {info &&
          (['electron', 'node', 'chrome', 'platform', 'isElevated'] as const).map((key) => (
            <Row key={key} label={labelFor(key)}>
              <span className="cap">{String(info[key])}</span>
            </Row>
          ))}
      </div>

      <span className="eyebrow">Registro</span>
      <div className="log">
        {logs.length === 0
          ? 'Sin entradas todavia.'
          : logs
              .map(
                (entry) =>
                  `${new Date(entry.time).toLocaleTimeString('es-ES')} [${entry.tag}] ${entry.message}`,
              )
              .join('\n')}
      </div>
    </>
  );
}

/**
 * Version instalada y control manual de la actualizacion.
 *
 * El actualizador trabaja solo, pero eso no puede significar que no se sepa
 * que esta haciendo.
 */
function UpdateRow() {
  const { status, checking, check, install } = useUpdateStatus();

  return (
    <Row label="Version" hint={updateHint(status)}>
      <span className="cap">{status?.current ?? '...'}</span>
      {status?.state === 'ready' ? (
        <button className="btn btn--sm" onClick={install}>
          Reiniciar e instalar
        </button>
      ) : (
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => void check()}
          disabled={checking || status?.state === 'downloading'}
        >
          {checking || status?.state === 'checking'
            ? 'Comprobando...'
            : status?.state === 'downloading'
              ? `Descargando ${Math.round(status.progress ?? 0)}%`
              : 'Buscar'}
        </button>
      )}
    </Row>
  );
}

function updateHint(status: UpdateStatus | null): string {
  switch (status?.state) {
    case 'downloading':
      return 'Descargando en segundo plano. Se aplicara al cerrar la aplicacion.';
    case 'ready':
      return `La version ${status.version ?? 'nueva'} se aplicara al cerrar, o ahora si reinicias.`;
    case 'unavailable':
      return 'Estas en la ultima version.';
    case 'error':
      return `No se ha podido comprobar: ${status.error ?? 'error desconocido'}`;
    case 'disabled':
      return 'Las actualizaciones solo funcionan en la aplicacion instalada.';
    default:
      return 'Las actualizaciones se descargan solas y se aplican al cerrar la aplicacion.';
  }
}

function labelFor(key: string): string {
  const labels: Record<string, string> = {
    electron: 'Version de Electron',
    node: 'Version de Node',
    chrome: 'Version de Chromium',
    platform: 'Plataforma',
    isElevated: 'Ejecutando como administrador',
  };
  return labels[key] ?? key;
}
