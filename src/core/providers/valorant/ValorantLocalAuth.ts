import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { createLogger } from '../../logging/Logger';

const log = createLogger('Valorant');

/**
 * Cabecera de plataforma que exige la API de Riot.
 * Es un JSON fijo codificado en base64; no contiene datos del usuario.
 */
export const CLIENT_PLATFORM = Buffer.from(
  JSON.stringify({
    platformType: 'PC',
    platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit',
    platformChipset: 'Unknown',
  }),
).toString('base64');

export interface LockfileInfo {
  port: number;
  password: string;
  pid: number;
}

export interface ClientInfo {
  /** Ejemplo real: "release-13.00-shipping-32-4990475". */
  version: string;
  /** Uno de: na, eu, ap, kr, pbe. */
  shard: string;
}

/**
 * Credenciales de la sesion local.
 *
 * ATENCION: `accessToken` y `entitlementsToken` son credenciales de la cuenta
 * del usuario. Nunca deben registrarse en el log, guardarse en la base de datos
 * ni enviarse a ningun sitio que no sean los servidores de Riot. Todo el codigo
 * que las toca esta en este fichero y en ValorantMatchApi.
 */
export interface ValorantSession {
  accessToken: string;
  entitlementsToken: string;
  /** Identificador de cuenta del jugador local. */
  puuid: string;
}

export interface ValorantContext extends ValorantSession, ClientInfo {}

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
}

export function lockfilePath(baseDir?: string): string {
  return join(baseDir ?? localAppData(), 'Riot Games', 'Riot Client', 'Config', 'lockfile');
}

export function shooterGameLogPath(baseDir?: string): string {
  return join(baseDir ?? localAppData(), 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log');
}

/**
 * Lee el lockfile que el cliente de Riot escribe mientras esta en marcha.
 * Formato: `nombre:pid:puerto:contrasena:protocolo`.
 */
export async function readLockfile(baseDir?: string): Promise<LockfileInfo | null> {
  const path = lockfilePath(baseDir);
  if (!existsSync(path)) return null;
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    return parseLockfile(raw);
  } catch (err) {
    log.debug(`No se pudo leer el lockfile: ${(err as Error).message}`);
    return null;
  }
}

export function parseLockfile(raw: string): LockfileInfo | null {
  const parts = raw.trim().split(':');
  if (parts.length < 5) return null;
  const pid = Number(parts[1]);
  const port = Number(parts[2]);
  const password = parts[3];
  if (!Number.isFinite(port) || port <= 0 || !password) return null;
  return { port, password, pid: Number.isFinite(pid) ? pid : 0 };
}

/**
 * Extrae la version del cliente y el shard del registro del juego.
 *
 * Ambos son obligatorios en las cabeceras de la API y no hay forma local de
 * obtenerlos sin el registro. Formatos verificados contra un ShooterGame.log
 * real:
 *   version -> release-13.00-shipping-32-4990475
 *   shard   -> https://pd.eu.a.pvp.net
 */
export async function readClientInfo(baseDir?: string): Promise<ClientInfo | null> {
  const path = shooterGameLogPath(baseDir);
  if (!existsSync(path)) return null;
  try {
    // latin1 evita que un byte suelto invalide la lectura del registro.
    const text = await readFile(path, 'latin1');
    return parseClientInfo(text);
  } catch (err) {
    log.debug(`No se pudo leer el registro de VALORANT: ${(err as Error).message}`);
    return null;
  }
}

export function parseClientInfo(logText: string): ClientInfo | null {
  const version = logText.match(/release-\d+\.\d+-shipping-\d+-\d+/i);
  const shard = logText.match(/https:\/\/pd\.([a-z0-9-]+)\.a\.pvp\.net/i);
  if (!version || !shard) return null;
  return { version: version[0], shard: shard[1].toLowerCase() };
}

/**
 * Pide al cliente de Riot las credenciales de la sesion actual.
 *
 * Devuelve null cuando el cliente esta abierto pero sin sesion util. Es un caso
 * habitual y NO un error: mientras el cliente esta en segundo plano expone una
 * API minima y este endpoint responde 404. Verificado empiricamente: con solo
 * `RiotClientServices` en marcha, `/help` lista siete funciones y ninguna ruta
 * de sesion existe.
 */
export async function fetchSession(lock: LockfileInfo): Promise<ValorantSession | null> {
  const auth = 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64');

  const response = await localRequest(lock.port, '/entitlements/v1/token', auth);
  if (!response) return null;

  if (response.status !== 200) {
    log.debug(
      `El cliente de Riot todavia no expone credenciales (HTTP ${response.status}). ` +
        'Es normal si VALORANT no esta en marcha.',
    );
    return null;
  }

  try {
    const parsed = JSON.parse(response.body) as {
      accessToken?: string;
      token?: string;
      subject?: string;
    };
    if (!parsed.accessToken || !parsed.token || !parsed.subject) return null;
    // Solo se registra la presencia, jamas el contenido.
    log.info('Credenciales de la sesion de VALORANT obtenidas del cliente local');
    return {
      accessToken: parsed.accessToken,
      entitlementsToken: parsed.token,
      puuid: parsed.subject,
    };
  } catch {
    return null;
  }
}

/**
 * Reune todo lo necesario para hablar con la API: credenciales, version y shard.
 */
export async function buildContext(baseDir?: string): Promise<ValorantContext | null> {
  const lock = await readLockfile(baseDir);
  if (!lock) return null;

  const info = await readClientInfo(baseDir);
  if (!info) {
    log.debug('No se ha podido determinar version y region desde el registro de VALORANT');
    return null;
  }

  const session = await fetchSession(lock);
  if (!session) return null;

  return { ...session, ...info };
}

interface LocalResponse {
  status: number;
  body: string;
}

/**
 * Peticion al endpoint local del cliente de Riot.
 * Usa un certificado autofirmado, asi que la verificacion se desactiva solo
 * para esta conexion a 127.0.0.1.
 */
function localRequest(port: number, path: string, auth: string): Promise<LocalResponse | null> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Authorization: auth },
        rejectUnauthorized: false,
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

export interface ValorantDiagnostics {
  lockfile: boolean;
  gameLog: boolean;
  version: string | null;
  shard: string | null;
  session: boolean;
  hint: string;
}

/**
 * Comprobacion de estado para la pantalla de diagnostico.
 *
 * Existe porque el flujo solo se puede verificar del todo con VALORANT abierto:
 * con el cliente de Riot en segundo plano la API de sesion aun no existe. Esto
 * permite al usuario confirmar en un vistazo que su equipo cumple los
 * requisitos, sin tener que leer registros.
 *
 * No devuelve ningun token ni identificador de cuenta: solo si estan presentes.
 */
export async function diagnoseValorant(baseDir?: string): Promise<ValorantDiagnostics> {
  const lock = await readLockfile(baseDir);
  const info = await readClientInfo(baseDir);
  const session = lock ? await fetchSession(lock) : null;

  let hint: string;
  if (!info) {
    hint =
      'No se ha encontrado el registro de VALORANT. Abre el juego al menos una vez ' +
      'para que se genere.';
  } else if (!lock) {
    hint = 'El cliente de Riot no esta en marcha. Abrelo para poder leer tu historial.';
  } else if (!session) {
    hint =
      'El cliente de Riot esta abierto pero todavia no expone la sesion. ' +
      'Suele ocurrir hasta que inicias VALORANT.';
  } else {
    hint = 'Todo listo: se marcaran los eventos al terminar cada partida.';
  }

  return {
    lockfile: lock !== null,
    gameLog: info !== null,
    version: info?.version ?? null,
    shard: info?.shard ?? null,
    session: session !== null,
    hint,
  };
}
