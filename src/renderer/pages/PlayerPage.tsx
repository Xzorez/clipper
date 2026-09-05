import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppSettings,
  GameEvent,
  GameEventType,
  gameLabel,
  RecordingRecord,
} from '@shared/types';
import { api } from '../lib/api';
import { DEFAULT_VISIBLE_TYPES, formatDate, formatTime, gameShort } from '../lib/events';
import { VideoPlayer, VideoPlayerHandle } from '../components/VideoPlayer';
import { ClipEditor, ClipAspect, ClipDraft } from '../components/ClipEditor';
import { Timeline } from '../components/Timeline';

/** Lo que la pagina le presta a la barra superior mientras esta abierta. */
export interface PlayerHeader {
  title: string;
  kills: number;
  deaths: number;
  assists: number;
  duration: number;
  clipBusy: boolean;
  onFolder: () => void;
  onClip: () => void;
}

export interface PlayerPageProps {
  recordingId: string;
  settings: AppSettings | null;
  onBack: () => void;
  onNotify: (title: string, message: string) => void;
  onClipCreated: () => void;
  onHeader: (header: PlayerHeader | null) => void;
}

/**
 * Detalle de una partida.
 *
 * Tres zonas con pesos distintos: el video manda, el editor de clip vive al
 * lado porque sacar clips es lo que se viene a hacer, y la linea temporal
 * ocupa el ancho completo abajo, que es donde se lee la partida.
 */
export function PlayerPage({
  recordingId,
  settings,
  onBack,
  onNotify,
  onClipCreated,
  onHeader,
}: PlayerPageProps) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const [recording, setRecording] = useState<RecordingRecord | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [aspect, setAspect] = useState<ClipAspect>('original');
  const [draft, setDraft] = useState<ClipDraft>({ start: 0, end: 15 });
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
        if (rec?.duration) {
          setDuration(rec.duration);
          setDraft({ start: 0, end: Math.min(15, rec.duration) });
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

  const seek = useCallback(
    (seconds: number, play = false) => {
      const lead =
        settings?.ui.playFromBeforeEnabled ? settings.ui.playFromSecondsBefore : 0;
      playerRef.current?.seek(Math.max(0, seconds - lead), play);
    },
    [settings],
  );

  const exportClip = useCallback(async () => {
    if (!recording) return;
    setBusy(true);
    try {
      await api.createClip({
        recordingId: recording.id,
        centerSeconds: (draft.start + draft.end) / 2,
        startSeconds: draft.start,
        endSeconds: draft.end,
        aspect,
        title: `${gameLabel(recording.game, recording.title)} ${formatTime(draft.start)}`,
      });
      onNotify('Clip guardado', `${(draft.end - draft.start).toFixed(1)}s en la carpeta de clips.`);
      onClipCreated();
    } catch (err) {
      onNotify('No se ha podido crear el clip', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [recording, draft, aspect, onNotify, onClipCreated]);

  const openFolder = useCallback(() => {
    if (recording) void api.revealPath(recording.filePath).catch(() => undefined);
  }, [recording]);

  // La barra superior se convierte en la cabecera de esta partida mientras
  // dura la visita, y se limpia al salir.
  useEffect(() => {
    if (!recording) return;
    const summary = recording.summary;
    onHeader({
      title: `${gameShort(recording.game).toUpperCase()} · ${formatDate(recording.startedAt)}`,
      kills: summary?.kills ?? 0,
      deaths: summary?.deaths ?? 0,
      assists: summary?.assists ?? 0,
      duration: recording.duration ?? duration,
      clipBusy: busy,
      onFolder: openFolder,
      onClip: () => void exportClip(),
    });
    return () => onHeader(null);
  }, [recording, duration, busy, onHeader, openFolder, exportClip]);

  const toggleType = useCallback((type: GameEventType) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const visibleEvents = useMemo(
    () => events.filter((event) => !event.beforeRecording),
    [events],
  );

  if (loading) {
    return (
      <div className="empty">
        <div className="empty__title">Cargando partida</div>
      </div>
    );
  }

  if (!recording) {
    return (
      <div className="empty">
        <div className="empty__title">No se ha encontrado la grabacion</div>
        <button className="btn btn--quiet" onClick={onBack}>
          Volver a partidas
        </button>
      </div>
    );
  }

  return (
    <div className="player">
      <div className="player__top">
        <div className="player__main">
          {/* Una partida recuperada tras un cierre inesperado no es una partida
              normal: la duracion es aproximada y pueden faltar los ultimos
              segundos. Callarlo haria pensar que el video esta mal cortado. */}
          {recording.status === 'recovered' && (
            <div className="note note--warn">
              <div>
                <b>Grabacion recuperada</b>
                Se recupero tras un cierre inesperado. La duracion es aproximada y pueden faltar
                los ultimos segundos, pero los momentos se conservaron.
              </div>
            </div>
          )}
          {error ? (
            <div className="note note--danger">
              <div>
                <b>Problema con el video</b>
                {error}
              </div>
            </div>
          ) : (
            <VideoPlayer
              ref={playerRef}
              src={api.mediaUrl(recording.filePath)}
              duration={duration}
              onTimeUpdate={setCurrentTime}
              onDurationChange={(d) => d > 0 && setDuration(d)}
              onError={setError}
            />
          )}
        </div>

        <ClipEditor
          duration={duration}
          draft={draft}
          currentTime={currentTime}
          events={visibleEvents}
          busy={busy}
          aspect={aspect}
          onAspect={setAspect}
          onChange={setDraft}
          onSeek={(seconds) => seek(seconds)}
          onExport={() => void exportClip()}
        />
      </div>

      {visibleEvents.length === 0 ? (
        <div className="lanes">
          <div className="lanes__head">
            <span className="eyebrow">Linea temporal</span>
            <div className="hair" />
          </div>
          <div className="note">
            <div>
              {recording.game === 'generic'
                ? 'Este juego no da eventos automaticos. Los momentos los marcas tu con el atajo mientras juegas, y tambien pueden salir del sonido al terminar.'
                : 'Esta partida no tiene momentos guardados.'}
            </div>
          </div>
        </div>
      ) : (
        <Timeline
          events={visibleEvents}
          duration={duration || recording.duration || 0}
          currentTime={currentTime}
          visibleTypes={visibleTypes}
          onToggleType={toggleType}
          onSeek={(seconds) => seek(seconds, true)}
        />
      )}
    </div>
  );
}
