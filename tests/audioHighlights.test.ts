import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PEAK_OPTIONS,
  LoudnessSample,
  buildAnalysisArgs,
  findPeaks,
  parseLoudness,
} from '../src/core/analysis/AudioHighlights';

/** Curva plana con estallidos en instantes concretos, como una partida real. */
function curva(bursts: number[], duracion = 120): LoudnessSample[] {
  const samples: LoudnessSample[] = [];
  for (let t = 0; t < duracion; t += 0.1) {
    const cerca = bursts.some((b) => Math.abs(t - b) < 0.6);
    // Fondo constante con una pizca de variacion, y picos muy por encima.
    samples.push({
      time: Number(t.toFixed(1)),
      loudness: cerca ? -18 : -34 + Math.sin(t) * 0.5,
    });
  }
  return samples;
}

describe('destacados por sonido', () => {
  describe('lectura de la curva', () => {
    it('empareja cada instante con su valor', () => {
      const salida = [
        'frame:0    pts:0       pts_time:0',
        'lavfi.r128.M=-120.7',
        'frame:1    pts:10176   pts_time:0.212',
        'lavfi.r128.M=-23.4',
        'frame:2    pts:14976   pts_time:12.5',
        'lavfi.r128.M=-30',
      ].join('\n');

      expect(parseLoudness(salida)).toEqual([
        { time: 0, loudness: -120.7 },
        { time: 0.212, loudness: -23.4 },
        { time: 12.5, loudness: -30 },
      ]);
    });

    it('descarta el silencio absoluto', () => {
      // FFmpeg escribe -inf antes de que entre el primer sonido; convertirlo
      // en numero contaminaria la referencia.
      const salida = 'pts_time:1\nlavfi.r128.M=-inf\npts_time:2\nlavfi.r128.M=-25';
      expect(parseLoudness(salida)).toEqual([{ time: 2, loudness: -25 }]);
    });

    it('no inventa nada con una salida vacia o rota', () => {
      expect(parseLoudness('')).toEqual([]);
      expect(parseLoudness('lavfi.r128.M=-25')).toEqual([]);
    });
  });

  describe('busqueda de picos', () => {
    it('encuentra los estallidos y solo esos', () => {
      const picos = findPeaks(curva([20, 45, 80]));
      expect(picos).toHaveLength(3);
      // Cae dentro del estallido, no necesariamente en su centro: lo que se
      // marca es el instante mas alto, y un tiroteo empieza fuerte.
      for (const [i, esperado] of [20, 45, 80].entries()) {
        expect(Math.abs(picos[i].time - esperado)).toBeLessThan(1);
      }
    });

    it('devuelve los momentos en orden de tiempo, no de volumen', () => {
      const picos = findPeaks(curva([80, 20, 45]));
      const tiempos = picos.map((p) => p.time);
      expect([...tiempos].sort((a, b) => a - b)).toEqual(tiempos);
    });

    it('deja un solo marcador por rafaga', () => {
      // Un tiroteo largo produce decenas de muestras altas seguidas. Marcarlas
      // todas llenaria la linea temporal de puntos pegados e inutiles.
      const samples: LoudnessSample[] = [];
      for (let t = 0; t < 120; t += 0.1) {
        const dentro = t > 40 && t < 48;
        samples.push({ time: Number(t.toFixed(1)), loudness: dentro ? -18 : -34 });
      }
      expect(findPeaks(samples)).toHaveLength(1);
    });

    it('ignora el principio, donde suelen estar los menus', () => {
      const picos = findPeaks(curva([3, 50]));
      expect(picos).toHaveLength(1);
      expect(Math.abs(picos[0].time - 50)).toBeLessThan(1);
    });

    it('no marca nada cuando el sonido es uniforme', () => {
      // Sin nada que destaque, es preferible una linea temporal vacia a
      // quince marcadores que no significan nada.
      const plano: LoudnessSample[] = [];
      for (let t = 0; t < 120; t += 0.1) plano.push({ time: t, loudness: -30 });
      expect(findPeaks(plano)).toEqual([]);
    });

    it('respeta el tope de marcadores', () => {
      const muchos = Array.from({ length: 40 }, (_, i) => 15 + i * 13);
      const picos = findPeaks(curva(muchos, 600));
      expect(picos.length).toBeLessThanOrEqual(DEFAULT_PEAK_OPTIONS.maxHighlights);
    });

    it('no se deja arrastrar por unos pocos picos muy fuertes', () => {
      // La referencia es la mediana justamente por esto: con la media, tres
      // tiroteos fuertes subirian el liston hasta taparse a si mismos.
      const picos = findPeaks(curva([20, 45, 80]));
      expect(picos.length).toBe(3);
    });

    it('no analiza una grabacion demasiado corta', () => {
      expect(findPeaks([{ time: 1, loudness: -20 }])).toEqual([]);
    });
  });

  describe('argumentos de analisis', () => {
    const args = buildAnalysisArgs('C:/videos/partida.mp4');

    it('no descodifica el video', () => {
      // Descodificar la imagen para medir el sonido multiplicaria el tiempo
      // del analisis sin aportar nada.
      expect(args).toContain('-vn');
    });

    it('pide la sonoridad momentanea por metadatos', () => {
      const filtro = args[args.indexOf('-af') + 1];
      expect(filtro).toContain('ebur128=metadata=1');
      expect(filtro).toContain('lavfi.r128.M');
    });

    it('no escribe ningun fichero', () => {
      expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
    });
  });
});
