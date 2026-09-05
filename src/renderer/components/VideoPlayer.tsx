import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatTime } from '../lib/events';
import {
  IconPlay,
  IconPause,
  IconVolume,
  IconMute,
  IconFullscreen,
} from './Icons';

/** Velocidades del segmentado. Tres bastan; el resto era relleno. */
const SPEEDS = [0.5, 1, 2] as const;
/** Salto de los botones de retroceso y avance, en segundos. */
const STEP = 5;

export interface VideoPlayerHandle {
  /** Salta a un instante y opcionalmente reproduce. */
  seek: (seconds: number, play?: boolean) => void;
  getCurrentTime: () => number;
}

export interface VideoPlayerProps {
  src: string;
  duration: number;
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
 * evento timeupdate, que solo se dispara unas cuatro veces por segundo y haria
 * que el cabezal de la linea temporal avanzara a tirones.
 *
 * La barra de progreso no esta aqui: vive en la linea temporal de abajo, que
 * es la regla de la pantalla. Tener dos barras compitiendo era parte de lo que
 * hacia que todo pesara igual.
 */
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { src, duration, onTimeUpdate, onDurationChange, onError },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [current, setCurrent] = useState(0);

  useImperativeHandle(ref, () => ({
    seek: (seconds: number, play = false) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, seconds);
      if (play) void video.play().catch(() => undefined);
    },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  }));

  // Bucle de refresco: solo mientras se reproduce, para no gastar en balde.
  useEffect(() => {
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        setCurrent(video.currentTime);
        onTimeUpdate(video.currentTime);
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [onTimeUpdate]);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const step = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = Math.max(0, video.currentTime + delta);
  }, []);

  const changeSpeed = useCallback((value: number) => {
    setSpeed(value);
    if (videoRef.current) videoRef.current.playbackRate = value;
  }, []);

  return (
    <>
      <div className="player__video">
        <video
          ref={videoRef}
          src={src}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => onDurationChange(e.currentTarget.duration || 0)}
          onError={() =>
            onError(
              'No se ha podido reproducir el video. Puede que el fichero se haya movido, ' +
                'borrado o quedado incompleto tras un cierre inesperado.',
            )
          }
          onClick={toggle}
        />
      </div>

      <div className="controls">
        <button className="ctl ctl--play" onClick={toggle} title="Reproducir o pausar">
          {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
        </button>
        <button className="ctl" onClick={() => step(-STEP)} title={`Atras ${STEP}s`}>
          −{STEP}
        </button>
        <button className="ctl" onClick={() => step(STEP)} title={`Adelante ${STEP}s`}>
          +{STEP}
        </button>

        <span className="ctl__time">
          {formatTime(current)} / {formatTime(duration)}
        </span>

        <div className="hair" style={{ background: 'transparent' }} />

        <span className="live__label">Velocidad</span>
        <div className="seg">
          {SPEEDS.map((value) => (
            <button
              key={value}
              className={speed === value ? 'on' : ''}
              onClick={() => changeSpeed(value)}
            >
              {value}×
            </button>
          ))}
        </div>

        <button
          className="ctl"
          title={muted ? 'Activar sonido' : 'Silenciar'}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            setMuted(video.muted);
          }}
        >
          {muted ? <IconMute size={15} /> : <IconVolume size={15} />}
        </button>
        <button
          className="ctl"
          title="Pantalla completa"
          onClick={() => void videoRef.current?.requestFullscreen().catch(() => undefined)}
        >
          <IconFullscreen size={15} />
        </button>
      </div>
    </>
  );
});
