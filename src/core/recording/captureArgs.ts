/** Metodo de captura de pantalla. */
export type CaptureMethod = 'ddagrab' | 'gdigrab';

export interface FfmpegArgsContext {
  encoder: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  /**
   * Monitor a capturar con ddagrab.
   *
   * Se eligio no fijarlo a cero: con varias pantallas, el juego puede estar en
   * la secundaria y se grabaria la equivocada. El valor lo determina el sondeo
   * automatico de CaptureProbe.
   */
  outputIndex?: number;
  /**
   * Tuberia con nombre de la que FFmpeg lee el audio en crudo, o null si se
   * graba sin sonido.
   *
   * Windows no ofrece ningun dispositivo de captura del sonido del sistema:
   * FFmpeg solo ve microfonos. El audio se captura por otra via y llega aqui
   * ya mezclado, como PCM de 16 bits a 48 kHz en estereo.
   */
  audioPipe?: string | null;
}

/** Formato del audio que se envia por la tuberia. Fijo a proposito. */
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_BYTES_PER_SAMPLE = 2;
/** Bytes de un segundo de audio. Sirve para ritmar el envio y rellenar huecos. */
export const AUDIO_BYTES_PER_SECOND =
  AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE;

/**
 * Construye la linea de comandos de FFmpeg para grabar.
 *
 * Se expone como funcion pura para poder verificar en los tests que cada metodo
 * produce los argumentos correctos, sin lanzar procesos.
 *
 * Diferencia clave entre ambos: con ddagrab el filtro ES la fuente y no hay
 * `-i`; con gdigrab la fuente es `-i desktop` y el escalado va en `-vf`.
 */
export function buildFfmpegArgs(
  method: CaptureMethod,
  context: FfmpegArgsContext,
  filePath: string,
): string[] {
  const { encoder, width, height, fps, bitrateKbps } = context;
  const outputIndex = context.outputIndex ?? 0;
  const audioPipe = context.audioPipe ?? null;

  // El audio se declara antes que el video para que sea siempre la entrada 0.
  // Con ddagrab no hay entrada de video (el filtro es la fuente), asi que
  // numerar el audio el ultimo obligaria a cambiar los mapeos segun el metodo.
  const audioInput: string[] = audioPipe
    ? [
        // Sin cola propia, un tiron del productor de audio frenaria tambien la
        // captura de video.
        '-thread_queue_size', '1024',
        '-f', 's16le',
        '-ar', String(AUDIO_SAMPLE_RATE),
        '-ac', String(AUDIO_CHANNELS),
        '-i', audioPipe,
      ]
    : [];

  const source: string[] =
    method === 'ddagrab'
      ? [
          // La captura ocurre en la GPU; hwdownload la trae a memoria para que
          // el encoder la consuma. El filtro ES la fuente: no hay -i de video.
          '-init_hw_device', 'd3d11va',
          '-filter_complex',
          `ddagrab=output_idx=${outputIndex}:framerate=${fps}:draw_mouse=0,` +
            `hwdownload,format=bgra,scale=${width}:${height}:flags=bilinear,format=nv12` +
            (audioPipe ? '[v]' : ''),
        ]
      : [
          '-f', 'gdigrab',
          '-framerate', String(fps),
          '-draw_mouse', '0',
          '-i', 'desktop',
          '-vf', `scale=${width}:${height}:flags=bilinear`,
        ];

  // Con dos entradas hay que decir explicitamente que se coge de cada una; el
  // mapeo automatico solo acierta cuando hay una sola.
  const mapping: string[] = audioPipe
    ? method === 'ddagrab'
      ? ['-map', '[v]', '-map', '0:a']
      : ['-map', '1:v', '-map', '0:a']
    : [];

  const audioOutput: string[] = audioPipe
    ? ['-c:a', 'aac', '-b:a', '160k', '-ar', String(AUDIO_SAMPLE_RATE), '-ac', String(AUDIO_CHANNELS)]
    : ['-an'];

  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...audioInput,
    ...source,
    ...mapping,
    '-c:v', encoder,
    '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${Math.round(bitrateKbps * 1.2)}k`,
    '-bufsize', `${bitrateKbps * 2}k`,
    // Keyframe cada 2 segundos: permite cortar clips sin recodificar.
    '-g', String(fps * 2),
    '-pix_fmt', 'yuv420p',
    ...audioOutput,
    // faststart no sirve escribiendo en directo; frag_keyframe deja el fichero
    // legible aunque el proceso muera de forma abrupta.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-progress', 'pipe:1',
    '-y',
    filePath,
  ];
}
