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
}

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

  const source: string[] =
    method === 'ddagrab'
      ? [
          // La captura ocurre en la GPU; hwdownload la trae a memoria para que
          // el encoder la consuma. El filtro ES la fuente: no hay -i.
          '-init_hw_device', 'd3d11va',
          '-filter_complex',
          `ddagrab=output_idx=${outputIndex}:framerate=${fps}:draw_mouse=0,` +
            `hwdownload,format=bgra,scale=${width}:${height}:flags=bilinear,format=nv12`,
        ]
      : [
          '-f', 'gdigrab',
          '-framerate', String(fps),
          '-draw_mouse', '0',
          '-i', 'desktop',
          '-vf', `scale=${width}:${height}:flags=bilinear`,
        ];

  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...source,
    '-c:v', encoder,
    '-b:v', `${bitrateKbps}k`,
    '-maxrate', `${Math.round(bitrateKbps * 1.2)}k`,
    '-bufsize', `${bitrateKbps * 2}k`,
    // Keyframe cada 2 segundos: permite cortar clips sin recodificar.
    '-g', String(fps * 2),
    '-pix_fmt', 'yuv420p',
    // faststart no sirve escribiendo en directo; frag_keyframe deja el fichero
    // legible aunque el proceso muera de forma abrupta.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-progress', 'pipe:1',
    '-y',
    filePath,
  ];
}
