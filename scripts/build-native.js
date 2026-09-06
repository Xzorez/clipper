/**
 * Compila el capturador de sonido del sistema.
 *
 * Envuelve al fichero .bat desde Node en lugar de invocarlo directamente
 * desde package.json: alli la ruta lleva una barra invertida antes de una "b",
 * y JSON la interpreta como un retroceso, con lo que el comando llegaba roto y
 * sin decir por que.
 */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const bat = join(__dirname, 'build-native.bat');
const result = spawnSync('cmd', ['/c', bat], { stdio: 'inherit' });

if (result.error) {
  console.error('No se ha podido compilar el capturador: ' + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
