/**
 * Genera el icono de Windows a partir del SVG.
 *
 * Se rasteriza con el propio Chromium de Electron en lugar de anadir una
 * dependencia nativa como sharp: ya esta instalado, da el mismo resultado y no
 * complica la instalacion del proyecto.
 *
 * Se captura UNA vez a 256 px y se reescala desde ahi. Crear una ventana por
 * tamano no vale: Windows impone un tamano minimo de ventana y las capturas
 * pequenas saldrian con el tamano equivocado.
 *
 * El .ico se empaqueta a mano. El formato admite entradas PNG desde Windows
 * Vista, asi que basta con una cabecera y las imagenes tal cual.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync, mkdirSync, existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const RESOURCES = join(ROOT, 'resources');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const CANVAS = 256;

/** Empaqueta varios PNG en un unico fichero .ico. */
function packIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo 1 = icono
  header.writeUInt16LE(count, 4);

  const entries = [];
  const payloads = [];
  let offset = 6 + count * 16;

  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    // El campo es de un byte: 256 se codifica como 0.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // colores de paleta
    entry.writeUInt8(0, 3); // reservado
    entry.writeUInt16LE(1, 4); // planos
    entry.writeUInt16LE(32, 6); // bits por pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(data);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  // Pagina temporal que referencia el SVG por ruta relativa. Un data: URL
  // anidado dentro de otro data: URL lo bloquea Chromium.
  const shell = join(RESOURCES, '.icon-render.html');
  writeFileSync(
    shell,
    `<!doctype html><html><body style="margin:0;background:transparent">
       <img src="./icon.svg" style="width:${CANVAS}px;height:${CANVAS}px;display:block">
     </body></html>`,
    'utf8',
  );

  const win = new BrowserWindow({
    width: CANVAS,
    height: CANVAS,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });

  try {
    await win.loadFile(shell);
    // Un respiro para que el SVG termine de pintarse antes de capturar.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const capture = await win.webContents.capturePage();
    if (capture.isEmpty()) throw new Error('la captura salio vacia');

    const images = SIZES.map((size) => ({
      size,
      data:
        size === CANVAS
          ? capture.toPNG()
          : capture.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));

    mkdirSync(RESOURCES, { recursive: true });
    writeFileSync(join(RESOURCES, 'icon.ico'), packIco(images));
    // El PNG grande sirve para la ventana y para otras plataformas.
    writeFileSync(join(RESOURCES, 'icon.png'), capture.toPNG());

    console.log('ICONO OK ' + SIZES.join(','));
  } catch (err) {
    console.log('ICONO ERROR ' + err.message);
  } finally {
    win.destroy();
    if (existsSync(shell)) unlinkSync(shell);
    app.exit(0);
  }
});
