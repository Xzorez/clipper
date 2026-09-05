/**
 * Publica una version en GitHub.
 *
 * Sustituye a `electron-builder --publish always`, que fallaba con un 422 en
 * las tres publicaciones anteriores dejando cada vez ficheros distintos sin
 * subir: una vez solo el blockmap, otra solo el instalador. Peor todavia, el
 * `latest.yml` que quedaba arriba era el de la version anterior, asi que las
 * copias instaladas seguian sin ver la actualizacion y nadie se enteraba.
 *
 * Aqui la construccion y la publicacion van separadas: se compila sin publicar,
 * se genera el indice a partir del instalador que hay de verdad en el disco, se
 * suben los tres ficheros con `gh` (que reintenta y admite sobrescribir) y al
 * final se comprueba desde fuera, sin credenciales, que es lo que veran los
 * demas. Si algo no cuadra, el script termina con error en vez de dejar una
 * publicacion a medias que parece correcta.
 */
const { execFileSync, execSync } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync, statSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const https = require('node:https');

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const target = pkg.build.publish[0];
const repo = target.owner + '/' + target.repo;

const installer = 'Clipper-Setup-' + version + '.exe';
const releaseDir = join(root, 'release');
const installerPath = join(releaseDir, installer);

function step(message) {
  process.stdout.write('\n> ' + message + '\n');
}

function run(command, options = {}) {
  return execSync(command, { cwd: root, stdio: 'inherit', ...options });
}

function capture(command) {
  return execSync(command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Descarga un recurso publico sin cabeceras de autenticacion. */
function fetchAnonymous(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('demasiadas redirecciones'));
    https
      .get(url, { headers: { 'User-Agent': 'clipper-release-check' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchAnonymous(res.headers.location, redirects + 1));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      })
      .on('error', reject);
  });
}

/** Comprueba el estado de una descarga sin traerse el cuerpo entero. */
function headAnonymous(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('demasiadas redirecciones'));
    const request = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'clipper-release-check' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(headAnonymous(res.headers.location, redirects + 1));
      }
      res.resume();
      resolve({ status: res.statusCode, length: Number(res.headers['content-length'] || 0) });
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  step('Comprobando el estado del repositorio');
  if (capture('git status --porcelain')) {
    throw new Error('hay cambios sin confirmar; confirma o descarta antes de publicar');
  }

  step('Subiendo commits y etiquetas');
  run('git push origin HEAD --follow-tags');

  step('Construyendo el instalador (sin publicar)');
  run('npm run dist');

  if (!existsSync(installerPath)) {
    throw new Error('no se ha generado ' + installer);
  }

  step('Generando latest.yml a partir del instalador construido');
  // Se calcula sobre el fichero real en vez de reutilizar lo que dejara
  // electron-builder: ese es justo el fallo que dejaba el indice apuntando a la
  // version anterior.
  const bytes = readFileSync(installerPath);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const yml =
    [
      'version: ' + version,
      'files:',
      '  - url: ' + installer,
      '    sha512: ' + sha512,
      '    size: ' + bytes.length,
      'path: ' + installer,
      'sha512: ' + sha512,
      "releaseDate: '" + new Date().toISOString() + "'",
    ].join('\n') + '\n';
  writeFileSync(join(releaseDir, 'latest.yml'), yml);
  console.log('  version ' + version + ', ' + bytes.length + ' bytes');

  step('Preparando la publicacion ' + tag);
  let exists = true;
  try {
    capture('gh release view ' + tag + ' --repo ' + repo);
  } catch {
    exists = false;
  }
  if (!exists) {
    execFileSync('gh', ['release', 'create', tag, '--repo', repo, '--title', tag, '--notes', 'Clipper ' + version], {
      cwd: root,
      stdio: 'inherit',
    });
  } else {
    console.log('  ya existia; se reutiliza');
  }

  step('Subiendo los ficheros');
  const assets = [installerPath, installerPath + '.blockmap', join(releaseDir, 'latest.yml')].filter((file) => {
    if (existsSync(file)) return true;
    console.log('  aviso: no se ha encontrado ' + file);
    return false;
  });
  run('gh release upload ' + tag + ' ' + assets.map((a) => JSON.stringify(a)).join(' ') + ' --repo ' + repo + ' --clobber');

  step('Verificando lo que veran los demas (sin credenciales)');
  const base = 'https://github.com/' + repo + '/releases/latest/download/';

  const index = await fetchAnonymous(base + 'latest.yml');
  if (index.status !== 200) throw new Error('latest.yml devuelve HTTP ' + index.status);
  const published = /version:\s*(\S+)/.exec(index.body);
  if (!published || published[1] !== version) {
    throw new Error('latest.yml publica la version ' + (published ? published[1] : '?') + ' y no ' + version);
  }
  if (!index.body.includes(sha512)) {
    throw new Error('el sha512 publicado no coincide con el instalador construido');
  }
  console.log('  latest.yml: version ' + version + ' y sha512 correcto');

  const download = await headAnonymous(base + installer);
  if (download.status !== 200) throw new Error('el instalador devuelve HTTP ' + download.status);
  if (download.length !== bytes.length) {
    throw new Error('el instalador publicado mide ' + download.length + ' y no ' + bytes.length);
  }
  console.log('  instalador: HTTP 200 y ' + download.length + ' bytes');

  step('Publicada ' + tag);
  console.log('  https://github.com/' + repo + '/releases/latest\n');
}

main().catch((err) => {
  console.error('\nLa publicacion ha fallado: ' + err.message);
  console.error('Nada queda a medias en silencio: revisa el mensaje y vuelve a ejecutar npm run release.\n');
  process.exit(1);
});
