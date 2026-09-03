import { describe, it, expect } from 'vitest';
import { buildFfmpegArgs, FfmpegArgsContext } from '../src/core/recording/FFmpegRecorder';

const context: FfmpegArgsContext = {
  encoder: 'h264_nvenc',
  width: 1920,
  height: 1080,
  fps: 60,
  bitrateKbps: 12000,
};

/** Devuelve el valor que sigue a una bandera. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

describe('buildFfmpegArgs', () => {
  describe('ddagrab (captura por GPU)', () => {
    const args = buildFfmpegArgs('ddagrab', context, 'C:/videos/partida.mp4');

    it('inicializa el dispositivo Direct3D', () => {
      expect(valueAfter(args, '-init_hw_device')).toBe('d3d11va');
    });

    it('usa el filtro como fuente, sin -i', () => {
      // Es la diferencia esencial con gdigrab: ddagrab no es un demuxer de
      // entrada, es un filtro que genera los fotogramas.
      expect(args).not.toContain('-i');
      const filter = valueAfter(args, '-filter_complex');
      expect(filter).toContain('ddagrab=output_idx=0');
    });

    it('pide los fotogramas por segundo configurados', () => {
      expect(valueAfter(args, '-filter_complex')).toContain('framerate=60');
    });

    it('no dibuja el cursor', () => {
      expect(valueAfter(args, '-filter_complex')).toContain('draw_mouse=0');
    });

    it('baja los fotogramas a memoria y los deja en un formato que el encoder acepta', () => {
      const filter = valueAfter(args, '-filter_complex') as string;
      expect(filter).toContain('hwdownload');
      expect(filter).toContain('format=bgra');
      expect(filter).toContain('format=nv12');
    });

    it('escala a la resolucion de salida', () => {
      expect(valueAfter(args, '-filter_complex')).toContain('scale=1920:1080');
    });
  });

  describe('gdigrab (repliegue por CPU)', () => {
    const args = buildFfmpegArgs('gdigrab', context, 'C:/videos/partida.mp4');

    it('captura el escritorio como entrada', () => {
      expect(valueAfter(args, '-f')).toBe('gdigrab');
      expect(valueAfter(args, '-i')).toBe('desktop');
    });

    it('no usa dispositivo de hardware', () => {
      expect(args).not.toContain('-init_hw_device');
      expect(args).not.toContain('-filter_complex');
    });

    it('escala con el filtro de video normal', () => {
      expect(valueAfter(args, '-vf')).toBe('scale=1920:1080:flags=bilinear');
    });

    it('respeta los fotogramas por segundo', () => {
      expect(valueAfter(args, '-framerate')).toBe('60');
    });
  });

  describe('opciones comunes a ambos metodos', () => {
    for (const method of ['ddagrab', 'gdigrab'] as const) {
      describe(method, () => {
        const args = buildFfmpegArgs(method, context, 'C:/videos/partida.mp4');

        it('usa el encoder indicado', () => {
          expect(valueAfter(args, '-c:v')).toBe('h264_nvenc');
        });

        it('aplica el bitrate con techo y buffer coherentes', () => {
          expect(valueAfter(args, '-b:v')).toBe('12000k');
          expect(valueAfter(args, '-maxrate')).toBe('14400k');
          expect(valueAfter(args, '-bufsize')).toBe('24000k');
        });

        /**
         * Un keyframe cada 2 segundos es lo que permite recortar clips por copia
         * de flujos sin recodificar. Si esto cambiara, los clips dejarian de ser
         * instantaneos.
         */
        it('coloca un keyframe cada 2 segundos', () => {
          expect(valueAfter(args, '-g')).toBe('120');
        });

        it('usa un formato de pixel reproducible en Chromium', () => {
          expect(valueAfter(args, '-pix_fmt')).toBe('yuv420p');
        });

        /**
         * Sin esto, un corte de luz a mitad de grabacion dejaria un MP4 sin
         * indice, es decir, irreproducible.
         */
        it('escribe el MP4 de forma fragmentada para sobrevivir a un corte', () => {
          expect(valueAfter(args, '-movflags')).toContain('frag_keyframe');
          expect(valueAfter(args, '-movflags')).toContain('empty_moov');
        });

        it('emite progreso legible para detectar el primer fotograma', () => {
          expect(valueAfter(args, '-progress')).toBe('pipe:1');
        });

        it('termina con el fichero de salida', () => {
          expect(args[args.length - 1]).toBe('C:/videos/partida.mp4');
        });
      });
    }
  });

  it('adapta el keyframe a otros fotogramas por segundo', () => {
    const args = buildFfmpegArgs('ddagrab', { ...context, fps: 30 }, 'x.mp4');
    expect(valueAfter(args, '-g')).toBe('60');
  });

  it('respeta un encoder por software', () => {
    const args = buildFfmpegArgs('gdigrab', { ...context, encoder: 'libx264' }, 'x.mp4');
    expect(valueAfter(args, '-c:v')).toBe('libx264');
  });
});
