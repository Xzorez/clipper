import { AUDIO_FORMAT, AudioCaptureRequest, AudioCaptureResult } from '@shared/audio';
import { api } from './api';

interface ActiveCapture {
  context: AudioContext;
  streams: MediaStream[];
  processor: ScriptProcessorNode;
}

let active: ActiveCapture | null = null;

/**
 * Captura de sonido para las grabaciones.
 *
 * Windows no ofrece ningun dispositivo con el que FFmpeg pueda grabar lo que
 * suena en el sistema; solo ve microfonos. Chromium si sabe hacerlo, y esta
 * ventana es Chromium. Aqui se abren las fuentes, se mezclan y se mandan al
 * proceso principal en crudo, que es quien se lo pasa a FFmpeg.
 *
 * Cada fuente se abre por separado y se da por perdida por separado: que no
 * haya microfono no puede impedir grabar el sonido del juego, ni al reves.
 */
export function installAudioCapture(): void {
  api.onAudioStart((request) => {
    void start(request).then((result) => api.audioReady(result));
  });
  api.onAudioStop(() => stop());
}

async function start(request: AudioCaptureRequest): Promise<AudioCaptureResult> {
  stop();

  const result: AudioCaptureResult = { system: false, microphone: false };
  const context = new AudioContext({ sampleRate: AUDIO_FORMAT.sampleRate });
  const mixer = context.createGain();
  const streams: MediaStream[] = [];

  if (request.system) {
    try {
      // Pide video ademas de audio porque asi lo exige getDisplayMedia; el
      // proceso principal responde con el audio del sistema y la pista de
      // video se descarta acto seguido, para no dejar una segunda captura de
      // pantalla corriendo junto a la del grabador.
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getVideoTracks().forEach((track) => track.stop());
      if (stream.getAudioTracks().length === 0) throw new Error('sin pista de audio');
      context.createMediaStreamSource(stream).connect(mixer);
      streams.push(stream);
      result.system = true;
    } catch (err) {
      result.systemError = describe(err);
    }
  }

  if (request.microphone) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Sin procesado: son efectos pensados para llamadas, y aqui deforman
        // la voz y muerden el sonido del juego que entra por el mismo sitio.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      context.createMediaStreamSource(stream).connect(mixer);
      streams.push(stream);
      result.microphone = true;
    } catch (err) {
      result.microphoneError = describe(err);
    }
  }

  if (!result.system && !result.microphone) {
    void context.close();
    return result;
  }

  const { channels, blockSize } = AUDIO_FORMAT;
  const processor = context.createScriptProcessor(blockSize, channels, channels);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer;
    const frames = input.length;
    const pcm = new Int16Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
      // Un solo canal de entrada (un microfono mono) se copia a los dos.
      const data = input.getChannelData(Math.min(channel, input.numberOfChannels - 1));
      for (let i = 0; i < frames; i++) {
        const sample = Math.max(-1, Math.min(1, data[i]));
        pcm[i * channels + channel] = Math.round(sample * 32767);
      }
    }
    api.sendAudioChunk(pcm.buffer);
  };

  // El nodo de proceso solo corre si su salida llega a algun sitio, pero esa
  // salida no debe oirse: reproducir lo capturado por los altavoces crearia
  // un bucle de realimentacion. Va a volumen cero.
  const silent = context.createGain();
  silent.gain.value = 0;
  mixer.connect(processor);
  processor.connect(silent).connect(context.destination);

  active = { context, streams, processor };
  return result;
}

function stop(): void {
  if (!active) return;
  active.processor.onaudioprocess = null;
  active.processor.disconnect();
  active.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  void active.context.close();
  active = null;
}

function describe(err: unknown): string {
  const error = err as { name?: string; message?: string };
  return error?.name ? `${error.name}: ${error.message ?? ''}`.trim() : String(err);
}
