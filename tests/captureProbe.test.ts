import { describe, it, expect } from 'vitest';
import {
  BLACK_LUMA_THRESHOLD,
  buildCandidates,
  buildProbeArgs,
  candidateKey,
  describeCandidate,
  explainFailure,
  parseLuminance,
  probeCandidate,
  selectCapture,
  CaptureCandidate,
  ProbeResult,
} from '../src/core/recording/CaptureProbe';

/** Salida tipica de FFmpeg midiendo brillo, con un valor por fotograma. */
function ffmpegOutput(values: number[]): string {
  return values
    .map(
      (v, i) =>
        `[Parsed_metadata_1 @ 000001] frame:${i} pts:${i * 100} pts_time:${i * 0.1}\n` +
        `[Parsed_metadata_1 @ 000001] lavfi.signalstats.YAVG=${v}`,
    )
    .join('\n');
}

function runner(output: string) {
  return async () => output;
}

describe('parseLuminance', () => {
  it('extrae la media de los valores medidos', () => {
    // Se descarta el primero: el fotograma inicial suele salir negro mientras
    // arranca la captura.
    expect(parseLuminance(ffmpegOutput([0, 40, 42, 44]))).toBeCloseTo(42, 5);
  });

  it('usa todos los valores si hay muy pocos', () => {
    expect(parseLuminance(ffmpegOutput([30, 50]))).toBeCloseTo(40, 5);
  });

  it('acepta tambien la notacion con dos puntos', () => {
    expect(parseLuminance('lavfi.signalstats.YAVG:33.5')).toBeCloseTo(33.5, 5);
  });

  it('devuelve null si no hay ninguna medida', () => {
    expect(parseLuminance('')).toBeNull();
    expect(parseLuminance('Error: no such device')).toBeNull();
  });
});

describe('buildProbeArgs', () => {
  it('mide sin escribir fichero', () => {
    const args = buildProbeArgs({ method: 'ddagrab', outputIndex: 0 });
    expect(args).toContain('-f');
    expect(args[args.length - 1]).toBe('-');
    expect(args).toContain('null');
  });

  /**
   * La medida viaja en mensajes de nivel informativo: con `-loglevel error`
   * se perderia y el sondeo daria siempre "sin medida".
   */
  it('deja pasar los mensajes informativos', () => {
    const args = buildProbeArgs({ method: 'ddagrab', outputIndex: 0 });
    expect(args[args.indexOf('-loglevel') + 1]).toBe('info');
  });

  it('sondea el monitor indicado', () => {
    const args = buildProbeArgs({ method: 'ddagrab', outputIndex: 2 });
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('ddagrab=output_idx=2');
    expect(filter).toContain('signalstats');
  });

  it('para gdigrab captura el escritorio', () => {
    const args = buildProbeArgs({ method: 'gdigrab', outputIndex: 0 });
    expect(args[args.indexOf('-i') + 1]).toBe('desktop');
    expect(args).not.toContain('-init_hw_device');
  });

  it('respeta la duracion pedida', () => {
    const args = buildProbeArgs({ method: 'gdigrab', outputIndex: 0 }, 2.5);
    expect(args[args.indexOf('-t') + 1]).toBe('2.5');
  });
});

describe('buildCandidates', () => {
  /**
   * Es lo que evita grabar la pantalla equivocada: con dos monitores hay que
   * poder probar el segundo, no dar por hecho que el juego esta en el primero.
   */
  it('incluye todos los monitores antes del respaldo por CPU', () => {
    const candidates = buildCandidates(2, true);
    expect(candidates).toEqual([
      { method: 'ddagrab', outputIndex: 0 },
      { method: 'ddagrab', outputIndex: 1 },
      { method: 'gdigrab', outputIndex: 0 },
    ]);
  });

  it('omite la captura por GPU si no esta disponible', () => {
    expect(buildCandidates(3, false)).toEqual([{ method: 'gdigrab', outputIndex: 0 }]);
  });

  it('siempre prueba al menos un monitor', () => {
    expect(buildCandidates(0, true)[0]).toEqual({ method: 'ddagrab', outputIndex: 0 });
  });
});

describe('probeCandidate', () => {
  const candidate: CaptureCandidate = { method: 'ddagrab', outputIndex: 0 };

  it('acepta una captura con imagen real', async () => {
    const result = await probeCandidate(runner(ffmpegOutput([0, 39, 39, 39])), candidate);
    expect(result.usable).toBe(true);
    expect(result.luminance).toBeCloseTo(39, 1);
  });

  /** El negro puro en rango limitado vale 16: si sale eso, no se ve nada. */
  it('rechaza una captura en negro', async () => {
    const result = await probeCandidate(runner(ffmpegOutput([16, 16, 16, 16])), candidate);
    expect(result.usable).toBe(false);
    expect(result.luminance).toBeCloseTo(16, 1);
  });

  it('rechaza justo por debajo del umbral y acepta justo por encima', async () => {
    const bajo = await probeCandidate(
      runner(ffmpegOutput([16, BLACK_LUMA_THRESHOLD - 0.5, BLACK_LUMA_THRESHOLD - 0.5])),
      candidate,
    );
    const alto = await probeCandidate(
      runner(ffmpegOutput([16, BLACK_LUMA_THRESHOLD + 0.5, BLACK_LUMA_THRESHOLD + 0.5])),
      candidate,
    );
    expect(bajo.usable).toBe(false);
    expect(alto.usable).toBe(true);
  });

  it('marca como inservible una captura que no llega a medir', async () => {
    const result = await probeCandidate(
      runner('Error: Cannot open display\n'),
      candidate,
    );
    expect(result.usable).toBe(false);
    expect(result.luminance).toBeNull();
    expect(result.error).toContain('Cannot open display');
  });
});

describe('selectCapture', () => {
  const candidates = buildCandidates(2, true);

  /** Simula que solo un candidato concreto devuelve imagen. */
  function selective(usableKey: string) {
    return async (args: string[]) => {
      const filter = args[args.indexOf('-filter_complex') + 1];
      const key = filter?.includes('ddagrab')
        ? `ddagrab:${/output_idx=(\d+)/.exec(filter)?.[1]}`
        : 'gdigrab';
      return ffmpegOutput(key === usableKey ? [16, 40, 40] : [16, 16, 16]);
    };
  }

  it('se queda con el primero que devuelve imagen', async () => {
    const { candidate } = await selectCapture(selective('ddagrab:0'), candidates);
    expect(candidate).toEqual({ method: 'ddagrab', outputIndex: 0 });
  });

  /** El caso del juego en la pantalla secundaria. */
  it('pasa al segundo monitor si el primero sale en negro', async () => {
    const { candidate, attempts } = await selectCapture(selective('ddagrab:1'), candidates);
    expect(candidate).toEqual({ method: 'ddagrab', outputIndex: 1 });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].usable).toBe(false);
  });

  it('recurre a la captura por CPU si la de GPU no ve nada', async () => {
    const { candidate } = await selectCapture(selective('gdigrab'), candidates);
    expect(candidate).toEqual({ method: 'gdigrab', outputIndex: 0 });
  });

  it('devuelve null cuando ninguno sirve', async () => {
    const { candidate, attempts } = await selectCapture(
      runner(ffmpegOutput([16, 16, 16])),
      candidates,
    );
    expect(candidate).toBeNull();
    expect(attempts).toHaveLength(3);
  });

  /**
   * Lo que hace que solo haya que sondear una vez: a partir de la segunda
   * partida se acierta al primer intento.
   */
  it('prueba primero lo que funciono la vez anterior', async () => {
    const probed: string[] = [];
    const run = async (args: string[]) => {
      const filter = args[args.indexOf('-filter_complex') + 1];
      probed.push(filter?.includes('ddagrab') ? `ddagrab:${/output_idx=(\d+)/.exec(filter)?.[1]}` : 'gdigrab');
      return ffmpegOutput([16, 40, 40]);
    };

    const { candidate } = await selectCapture(run, candidates, {
      method: 'ddagrab',
      outputIndex: 1,
    });

    expect(probed).toEqual(['ddagrab:1']);
    expect(candidate).toEqual({ method: 'ddagrab', outputIndex: 1 });
  });

  it('no repite el candidato preferido dentro de la lista', async () => {
    const probed: string[] = [];
    const run = async (args: string[]) => {
      const filter = args[args.indexOf('-filter_complex') + 1];
      probed.push(filter?.includes('ddagrab') ? `ddagrab:${/output_idx=(\d+)/.exec(filter)?.[1]}` : 'gdigrab');
      return ffmpegOutput([16, 16, 16]);
    };

    await selectCapture(run, candidates, { method: 'ddagrab', outputIndex: 1 });

    expect(probed).toEqual(['ddagrab:1', 'ddagrab:0', 'gdigrab']);
  });
});

describe('explainFailure', () => {
  /**
   * Es el unico caso en que el usuario tiene que hacer algo, asi que el mensaje
   * debe decir exactamente que, no dar un error generico.
   */
  it('senala la pantalla completa exclusiva cuando todo sale en negro', () => {
    const attempts: ProbeResult[] = [
      { method: 'ddagrab', outputIndex: 0, luminance: 16, usable: false },
      { method: 'gdigrab', outputIndex: 0, luminance: 16, usable: false },
    ];
    const message = explainFailure(attempts);
    expect(message).toContain('pantalla completa');
    expect(message).toContain('sin bordes');
  });

  it('da un mensaje generico si el fallo no fue por imagen negra', () => {
    const attempts: ProbeResult[] = [
      { method: 'ddagrab', outputIndex: 0, luminance: null, usable: false, error: 'boom' },
    ];
    expect(explainFailure(attempts)).toContain('ningun metodo');
  });
});

describe('identificacion de candidatos', () => {
  it('distingue monitores en la clave', () => {
    expect(candidateKey({ method: 'ddagrab', outputIndex: 0 })).toBe('ddagrab:0');
    expect(candidateKey({ method: 'ddagrab', outputIndex: 1 })).toBe('ddagrab:1');
    expect(candidateKey({ method: 'gdigrab', outputIndex: 0 })).toBe('gdigrab');
  });

  it('describe el metodo en lenguaje comprensible', () => {
    expect(describeCandidate({ method: 'ddagrab', outputIndex: 1 })).toContain('monitor 2');
    expect(describeCandidate({ method: 'gdigrab', outputIndex: 0 })).toContain('CPU');
  });
});
