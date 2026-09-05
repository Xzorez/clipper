import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppSettings,
  GameEvent,
  GameEventType,
  gameLabel,
  RecordingRecord,
} from '@shared/types';
import { api } from '../lib/api';
import {
  DEFAULT_VISIBLE_TYPES,
  EVENT_VISUALS,
  OTHER_TYPES,
  formatDate,
  formatTime,
} from '../lib/events';
import { VideoPlayer, VideoPlayerHandle } from '../components/VideoPlayer';
import { IconBack, IconScissors } from '../components/Icons';
import { ClipEditor, ClipAspect, ClipDraft } from '../components/ClipEditor';
import { Timeline } from '../components/Timeline';

export interface PlayerPageProps {
  recordingId: string;
  settings: AppSettings | null;
  onBack: () => void;
  onNotify: (title: string, message: string) => void;
  onClipCreated: () => void;
}

export function PlayerPage({
  recordingId,
  settings,
  onBack,
  onNotify,
  onClipCreated,
}: PlayerPageProps) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [recording, setRecording] = useState<RecordingRecord | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingClip, setCreatingClip] = useState(false);
  /** Recorte en curso. Mientras no sea null, el editor esta abierto. */
  const [clipDraft, setClipDraft] = useState<ClipDraft | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<GameEventType>>(
    () => new Set(DEFAULT_VISIBLE_TYPES),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [rec, evts] = await Promise.all([
          api.getRecording(recordingId),
          api.getEvents(recordingId),
        ]);
        if (cancelled) return;
        setRecording(rec);
        setEvents(evts);
        if (rec.duration) setDuration(rec.duration);
        if (rec.missingFile) {
          setError(
            'El fichero de video ya no esta en disco. Los eventos de la partida se ' +
              'conservan, pero no hay imagen que reproducir.',
          );
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recordingId]);

  /** Resumen calculado a partir de los eventos guardados, nunca a mano. */
  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, [events]);

  const counts = useMemo(() => {
    const map = new Map<GameEventType, number>();
    for (const event of events) map.set(event.type, (map.get(event.type) ?? 0) + 1);
    return map;
  }, [events]);

  /**
   * Salto al evento. Si la opcion esta activa, se retrocede unos segundos para
   * ver el contexto previo en lugar de caer justo en el instante del disparo.
   */
  const seekToEvent = useCallback(
    (event: GameEvent) => {
      const offset =
        settings?.ui.playFromBeforeEnabled === false ? 0 : (settings?.ui.playFromSecondsBefore ?? 3);
      const target = Math.max(0, event.videoTime - offset);
      playerRef.current?.seek(target, true);
      setActiveEventId(event.id);
    },
    [settings],
  );

  const seekToTime = useCallback((seconds: number) => {
    playerRef.current?.seek(seconds, false);
  }, []);

  const toggleType = useCallback((types: GameEventType[]) => {
    setVisibleTypes((previous) => {
      const next = new Set(previous);
      const allOn = types.every((t) => next.has(t));
      for (const type of types) {
        if (allOn) next.delete(type);
        else next.add(type);
      }
      return next;
    });
  }, []);

  /**
   * Abre el editor alrededor de un instante.
   *
   * Se parte de unos margenes razonables en vez de un punto suelto: casi
   * siempre hay que ajustar poco, y empezar con el clip vacio obligaria a fijar
   * las dos puntas antes de ver nada.
   */
  const openClipEditor = useCallback(
    (centerSeconds: number) => {
      const total = recording?.duration ?? 0;
      setClipDraft({
        start: Math.max(0, centerSeconds - 10),
        end: Math.min(total || centerSeconds + 5, centerSeconds + 5),
      });
    },
    [recording],
  );

  const exportClip = useCallback(
    async (aspect: ClipAspect) => {
      if (!recording || !clipDraft) return;
      setCreatingClip(true);
      try {
        await api.createClip({
          recordingId: recording.id,
          centerSeconds: (clipDraft.start + clipDraft.end) / 2,
          startSeconds: clipDraft.start,
          endSeconds: clipDraft.end,
          aspect,
          title: `minuto ${formatTime(clipDraft.start)}`,
        });
        onNotify('Clip creado', `${(clipDraft.end - clipDraft.start).toFixed(1)}s guardados.`);
        setClipDraft(null);
        onClipCreated();
      } catch (err) {
        onNotify('No se ha podido crear el clip', (err as Error).message);
      } finally {
        setCreatingClip(false);
      }
    },
    [recording, clipDraft, onNotify, onClipCreated],
  );

  if (loading) {
    return <div className="empty">Cargando grabacion...</div>;
  }

  if (!recording) {
    return (
      <div className="empty">
        <div className="empty__title">{error ?? 'No se ha encontrado la grabacion.'}</div>
        <button className="btn" onClick={onBack}>
          Volver
        </button>
      </div>
    );
  }

  const src = api.mediaUrl(recording.filePath);
  const effectiveDuration = duration || recording.duration || 0;

  return (
    <div className="player">
      <div className="bar">
        <button className="btn btn--quiet btn--sm" onClick={onBack}>
          <IconBack size={14} />
          Volver
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn--sm"
          onClick={() => void api.revealPath(recording.filePath).catch(() => undefined)}
        >
          Ver en la carpeta
        </button>
        <button
          className="btn btn--sm"
          disabled={creatingClip}
          onClick={() => openClipEditor(playerRef.current?.getCurrentTime() ?? currentTime)}
        >
          Crear clip aqui
        </button>
      </div>

      {error && (
        <div className="note note--danger">
          <div>
            <b>Problema con el video</b>
            {error}
          </div>
        </div>
      )}

      {recording.status === 'recovered' && (
        <div className="note note--warn">
          <div>
            <b>Grabacion recuperada</b>
            Se recupero tras un cierre inesperado. La duracion es aproximada y pueden faltar los
            ultimos segundos, pero los eventos se conservaron.
          </div>
        </div>
      )}

      <SummaryBar recording={recording} summary={summary} />

      {!recording.missingFile && (
        <VideoPlayer
          ref={playerRef}
          src={src}
          onTimeUpdate={setCurrentTime}
          onDurationChange={setDuration}
          onError={setError}
        />
      )}

      {clipDraft && (
        <ClipEditor
          duration={duration || recording.duration || 0}
          draft={clipDraft}
          currentTime={currentTime}
          busy={creatingClip}
          onChange={setClipDraft}
          onSeek={(seconds) => playerRef.current?.seek(seconds)}
          onCancel={() => setClipDraft(null)}
          onExport={(aspect) => void exportClip(aspect)}
        />
      )}

      <div className="tl">
        <div className="tl__head">
          <div className="chips">
            {DEFAULT_VISIBLE_TYPES.map((type) => {
              const visual = EVENT_VISUALS[type];
              const active = visibleTypes.has(type);
              const count = counts.get(type) ?? 0;
              return (
                <button
                  key={type}
                  className={`chip${active ? ' chip--on' : ''}`}
                  style={active ? { color: visual.color } : undefined}
                  onClick={() => toggleType([type])}
                >
                  <i style={{ background: visual.color }} />
                  {visual.label}
                  <span className="chip__n">{count}</span>
                </button>
              );
            })}
            <button
              className={`chip${
                OTHER_TYPES.every((t) => visibleTypes.has(t)) ? ' chip--on' : ''
              }`}
              onClick={() => toggleType(OTHER_TYPES)}
            >
              <i style={{ background: 'var(--round)' }} />
              Otros
              <span className="chip__n">
                {OTHER_TYPES.reduce((sum, t) => sum + (counts.get(t) ?? 0), 0)}
              </span>
            </button>
          </div>
        </div>

        <Timeline
          events={events}
          duration={effectiveDuration}
          currentTime={currentTime}
          visibleTypes={visibleTypes}
          iconSize={settings?.ui.iconSize ?? 'medium'}
          showLabels={settings?.ui.showLabels ?? false}
          onSeek={seekToTime}
        />
      </div>

      <div className="card">
        <div className="section" style={{ marginTop: 0 }}>
          Eventos de la partida
        </div>
        <EventList
          events={events}
          visibleTypes={visibleTypes}
          activeEventId={activeEventId}
          creatingClip={creatingClip}
          onSelect={seekToEvent}
          onCreateClip={(event) => openClipEditor(event.videoTime)}
        />
      </div>
    </div>
  );
}

function SummaryBar({
  recording,
  summary,
}: {
  recording: RecordingRecord;
  summary: Record<string, number>;
}) {
  const isLol = recording.game === 'lol';
  const stats: Array<{ label: string; value: number; color: string }> = [
    { label: 'Kills', value: summary[GameEventType.KILL] ?? 0, color: 'var(--kill)' },
    { label: 'Muertes', value: summary[GameEventType.DEATH] ?? 0, color: 'var(--death)' },
  ];
  if (isLol) {
    stats.push({ label: 'Asistencias', value: summary[GameEventType.ASSIST] ?? 0, color: 'var(--assist)' });
  } else {
    stats.push({ label: 'Headshots', value: summary[GameEventType.HEADSHOT] ?? 0, color: 'var(--headshot)' });
    if ((summary[GameEventType.KNOCKED_OUT] ?? 0) > 0) {
      stats.push({
        label: 'Derribos',
        value: summary[GameEventType.KNOCKED_OUT] ?? 0,
        color: 'var(--knocked)',
      });
    }
  }

  return (
    <div className="summary">
      <div>
        <div className="summary__game">{gameLabel(recording.game, recording.title)}</div>
        <div style={{ color: 'var(--text-2)', fontSize: 12 }}>
          {formatDate(recording.startedAt)} · {formatTime(recording.duration ?? 0)}
          {recording.resolution && ` · ${recording.resolution}`}
          {recording.fps && ` · ${recording.fps} fps`}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      {stats.map((stat) => (
        <div className="stat" key={stat.label}>
          <span className="stat__value" style={{ color: stat.color }}>
            {stat.value}
          </span>
          <span className="stat__label">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

function EventList({
  events,
  visibleTypes,
  activeEventId,
  creatingClip,
  onSelect,
  onCreateClip,
}: {
  events: GameEvent[];
  visibleTypes: Set<GameEventType>;
  activeEventId: string | null;
  creatingClip: boolean;
  onSelect: (event: GameEvent) => void;
  onCreateClip: (event: GameEvent) => void;
}) {
  const filtered = events.filter((event) => visibleTypes.has(event.type));

  if (filtered.length === 0) {
    return (
      <div className="empty" style={{ padding: '32px 16px' }}>
        <div>
          {events.length === 0
            ? 'Esta grabacion no tiene eventos. Puede que el proveedor de eventos no estuviera activo durante la partida.'
            : 'Ningun evento coincide con los filtros seleccionados.'}
        </div>
      </div>
    );
  }

  return (
    <div className="events">
      {filtered.map((event) => {
        const visual = EVENT_VISUALS[event.type];
        return (
          <div
            key={event.id}
            className={`ev${event.id === activeEventId ? ' ev--on' : ''}`}
          >
            <span className="ev__dot" style={{ background: visual.color }} />
            <button
              className="ev__name"
              style={{ background: 'none', textAlign: 'left' }}
              onClick={() => onSelect(event)}
            >
              {visual.label}
            </button>
            <span className="ev__t">{formatTime(event.videoTime)}</span>
            <button
              className="btn btn--sm btn--quiet"
              disabled={creatingClip}
              onClick={() => onCreateClip(event)}
              title="Crear un clip alrededor de este evento"
            >
              <IconScissors size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
