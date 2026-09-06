import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatTime } from '../lib/events';
import {
  IconPlay,
  IconPause,
  IconVolume,
  IconMute,
  IconFullscreen,
} from './Icons';

/**
 * Velocidades del segmentado.
 *
 * Las muy lentas estan para lo que se viene a hacer aqui: mirar fotograma a
 * fotograma que paso justo en el momento de una muerte. A 0,1x un segundo de
 * partida dura diez.
 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;
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
  /**
   * Que se pone en pantalla completa.
   *
   * Se prefiere la vista entera y no solo el video: asi se conservan los
   * controles y la linea temporal, que es justo lo que se usa mientras se
   * repasa una jugada. Poner solo el video obligaria a salir para saltar al
   * momento siguiente.
   */
  fullscreenTarget?: React.RefObject<HTMLElement>;
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
  { src, duration, fullscreenTarget, onTimeUpdate, onDurationChange, onError },
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

  /**
   * Bucle de refresco, solo mientras se reproduce.
   *
   * En pausa no hay nada que actualizar, y esta pantalla se deja abierta
   * mientras se repasa una partida: mantener un requestAnimationFrame vivo
   * sesenta veces por segundo para no mover nada seria gastar bateria a
   * cambio de nada.
   */
  useEffect(() => {
    if (!playing) return;
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
  }, [onTimeUpdate, playing]);

  // Al saltar con el video en pausa hay que refrescar igual: si no, el cabezal
  // de la linea temporal se quedaria donde estaba.
  const sync = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setCurrent(video.currentTime);
    onTimeUpdate(video.currentTime);
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

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const target = fullscreenTarget?.current ?? videoRef.current;
    void target?.requestFullscreen().catch(() => undefined);
  }, [fullscreenTarget]);

  // Teclas de toda la vida en un reproductor. Se escuchan en la ventana entera
  // porque el foco casi nunca esta en el video: se llega aqui pulsando un
  // momento de la linea temporal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key) {
        case ' ':
          event.preventDefault();
          toggle();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'ArrowLeft':
          step(-STEP);
          break;
        case 'ArrowRight':
          step(STEP);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step, toggleFullscreen]);

  return (
    <>
      <div className="player__video">
        <video
          ref={videoRef}
          src={src}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeeked={sync}
          onLoadedMetadata={(e) => onDurationChange(e.currentTarget.duration || 0)}
          onError={() =>
            onError(
              'No se ha podido reproducir el video. Puede que el fichero se haya movido, ' +
                'borrado o quedado incompleto tras un cierre inesperado.',
            )
          }
          onClick={toggle}
          onDoubleClick={toggleFullscreen}
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
          title="Pantalla completa (F, o doble clic en el video)"
          onClick={toggleFullscreen}
        >
          <IconFullscreen size={15} />
        </button>
      </div>
    </>
  );
});
