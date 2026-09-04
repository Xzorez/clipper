import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatTime } from '../lib/events';
import {
  IconPlay,
  IconPause,
  IconSkipBack,
  IconSkipFwd,
  IconVolume,
  IconMute,
  IconFullscreen,
} from './Icons';

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

export interface VideoPlayerHandle {
  /** Salta a un instante y opcionalmente reproduce. */
  seek: (seconds: number, play?: boolean) => void;
  getCurrentTime: () => number;
}

export interface VideoPlayerProps {
  src: string;
  onTimeUpdate: (seconds: number) => void;
  onDurationChange: (seconds: number) => void;
  onError: (message: string) => void;
}

/**
 * Reproductor de video.
 *
 * Se apoya en el elemento <video> nativo de Chromium en lugar de una libreria:
 * grabamos H.264 en MP4 precisamente para que la reproduccion sea nativa,
 * acelerada por hardware y sin dependencias.
 *
 * El tiempo se propaga hacia arriba con requestAnimationFrame en vez de con el
 * evento timeupdate, que solo se dispara unas 4 veces por segundo y haria que
 * el cabezal de la timeline avanzara a tirones.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { src, onTimeUpdate, onDurationChange, onError },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);

  useImperativeHandle(ref, () => ({
    seek: (seconds: number, play = false) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(seconds, video.duration || seconds));
      setCurrent(video.currentTime);
      onTimeUpdate(video.currentTime);
      if (play) void video.play().catch(() => undefined);
    },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  }));

  // Bucle de animacion: mantiene el cabezal fluido mientras se reproduce.
  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      if (video && !video.paused) {
        setCurrent(video.currentTime);
        onTimeUpdate(video.currentTime);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [onTimeUpdate]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const skip = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.currentTime + delta, video.duration || 0));
    setCurrent(video.currentTime);
    onTimeUpdate(video.currentTime);
  }, [onTimeUpdate]);

  // Atajos de teclado dentro del reproductor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          skip(event.shiftKey ? -1 : -5);
          break;
        case 'ArrowRight':
          skip(event.shiftKey ? 1 : 5);
          break;
        case 'm':
          setMuted((m) => !m);
          break;
        case 'f':
          void videoRef.current?.requestFullscreen().catch(() => undefined);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, skip]);

  return (
    <div className="video">
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        muted={muted}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          const value = e.currentTarget.duration;
          if (Number.isFinite(value)) {
            setDuration(value);
            onDurationChange(value);
          }
        }}
        onError={() => {
          onError(
            'No se ha podido reproducir el video. Puede que el fichero se haya movido, ' +
              'borrado o quedado incompleto tras un cierre inesperado.',
          );
        }}
      />

      <div className="controls">
        <button className="ctl" onClick={togglePlay} title="Reproducir / Pausa (Espacio)">
          {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
        </button>
        <button className="ctl" onClick={() => skip(-5)} title="Atras 5s (←)">
          <IconSkipBack size={15} />
        </button>
        <button className="ctl" onClick={() => skip(5)} title="Adelante 5s (→)">
          <IconSkipFwd size={15} />
        </button>

        <span className="time">
          {formatTime(current)} / {formatTime(duration)}
        </span>

        <input
          className="scrub"
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={current}
          onChange={(e) => {
            const video = videoRef.current;
            if (!video) return;
            const value = Number(e.target.value);
            video.currentTime = value;
            setCurrent(value);
            onTimeUpdate(value);
          }}
        />

        <button
          className="ctl"
          onClick={() => setMuted((m) => !m)}
          title="Silenciar (M)"
        >
          {muted || volume === 0 ? <IconMute size={15} /> : <IconVolume size={15} />}
        </button>
        <input
          className="vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const value = Number(e.target.value);
            setVolume(value);
            setMuted(value === 0);
            if (videoRef.current) videoRef.current.volume = value;
          }}
        />

        <select
          className="select"
          value={speed}
          onChange={(e) => {
            const value = Number(e.target.value);
            setSpeed(value);
            if (videoRef.current) videoRef.current.playbackRate = value;
          }}
          title="Velocidad de reproduccion"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>

        <button
          className="ctl"
          onClick={() => void videoRef.current?.requestFullscreen().catch(() => undefined)}
          title="Pantalla completa (F)"
        >
          <IconFullscreen size={15} />
        </button>
      </div>
    </div>
  );
});
