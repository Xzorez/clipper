import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('GameDetection');

/**
 * Se sondea mas despacio que los juegos conocidos.
 *
 * Esta consulta cuesta bastante mas (hay que arrancar PowerShell para obtener
 * las rutas, que `tasklist` no da), y unos segundos de mas al empezar una
 * partida no se notan.
 */
const POLL_INTERVAL_MS = 10_000;

export interface DetectedGame {
  pid: number;
  processName: string;
  /** Nombre presentable, tal como se guardara en la biblioteca. */
  title: string;
  path: string;
}

export interface RunningWindow {
  Id: number;
  ProcessName: string;
  MainWindowTitle: string | null;
  Path: string | null;
}

/**
 * Carpetas donde las tiendas instalan sus juegos.
 *
 * Se busca el fragmento dentro de la ruta en lugar de una raiz concreta,
 * porque casi todo el mundo reparte los juegos entre varios discos y ninguna
 * lista de unidades acertaria. Da igual si esta en C: o en D:; lo que importa
 * es que cuelgue de una biblioteca de juegos.
 */
export const GAME_LIBRARY_MARKERS = [
  '/steamapps/common/',
  '/epic games/',
  '/gog galaxy/games/',
  '/gog games/',
  '/riot games/',
  '/ubisoft game launcher/',
  '/ubisoft/',
  '/origin games/',
  '/ea games/',
  '/electronic arts/',
  '/battle.net/',
  '/xboxgames/',
  '/games/',
];

/**
 * Programas que viven dentro de esas carpetas sin ser juegos.
 *
 * Sin esta lista, abrir Steam bastaria para que la aplicacion se pusiera a
 * grabar el escritorio: el propio cliente esta dentro de la carpeta de Steam.
 */
export const NOT_GAMES = [
  'steam',
  'steamwebhelper',
  'steamservice',
  'gameoverlayui',
  'epicgameslauncher',
  'epicwebhelper',
  'battle.net',
  'agent',
  'galaxyclient',
  'galaxyclienthelper',
  'ubisoftconnect',
  'upc',
  'uplaywebcore',
  'eadesktop',
  'eabackgroundservice',
  'origin',
  'riotclientservices',
  'riotclientux',
  'riotclientuxrender',
  'rockstarservice',
  'launcher',
  'crashhandler',
  'crashreporter',
  'unitycrashhandler64',
  'unitycrashhandler32',
];

/**
 * Ficheros que acompanan a un juego y a casi nada mas.
 *
 * Este es el criterio bueno. Las carpetas de biblioteca solo aciertan con
 * quien instala todo desde una tienda; en cuanto alguien guarda sus juegos en
 * "B:/Juegos" o los descomprime donde le apetece, la ruta no dice nada. Lo que
 * si dice mucho es lo que hay al lado del ejecutable: la biblioteca de Steam,
 * el motor de Unity o el empaquetado de Godot no aparecen junto a un navegador
 * ni junto a un reproductor de musica.
 */
export const ENGINE_FILE_MARKERS = [
  'steam_api.dll',
  'steam_api64.dll',
  'steamoverlay64.dll',
  'unityplayer.dll',
  'gameassembly.dll',
  'monobleedingedge',
  'openal32.dll',
  'fmod.dll',
  'fmodstudio.dll',
  'binkw32.dll',
  'binkw64.dll',
  'galaxy.dll',
  'galaxy64.dll',
  'eossdk-win64-shipping.dll',
];

/**
 * Terminaciones tipicas de los datos empaquetados de un juego.
 *
 * `.pak` no esta, aunque sea el formato de Unreal: tambien es el de los
 * recursos de Chromium, asi que lo tiene al lado cualquier aplicacion hecha
 * con Electron. Comprobado en esta misma maquina: Discord, Spotify, Hydra y el
 * overlay de NVIDIA colaban como juegos por sus `resources.pak`. Los juegos de
 * Unreal se reconocen por el nombre del ejecutable, y sus `.pak` de verdad
 * viven en Content/Paks, no junto al binario.
 */
export const ENGINE_SUFFIX_MARKERS = ['_data', '.pck', '.assets', '.uproject'];

/** Como termina el ejecutable de un juego de Unreal Engine. */
export const UNREAL_EXE_SUFFIXES = ['-win64-shipping.exe', '-wingdk-shipping.exe'];

/** True si el ejecutable sigue la convencion de nombres de Unreal Engine. */
export function isUnrealExe(path: string | null | undefined): boolean {
  if (!path) return false;
  const name = normalizePath(path).split('/').pop() ?? '';
  return UNREAL_EXE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Sitios donde no vive ningun juego.
 *
 * Ademas de evitar falsos positivos, ahorra listar carpetas enormes como
 * System32 en cada sondeo.
 */
export const SYSTEM_PATH_MARKERS = [
  'c:/windows/',
  '/windowsapps/',
  '/system32/',
  '/syswow64/',
];

/** Pasa una ruta de Windows a minusculas y barras normales, para comparar. */
export function normalizePath(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/');
}

/** True si el ejecutable es del sistema o de una app empaquetada de Windows. */
export function isSystemPath(path: string | null | undefined): boolean {
  if (!path) return true;
  const normalized = normalizePath(path);
  return SYSTEM_PATH_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Decide si el contenido de una carpeta es el de un juego.
 *
 * Recibe la lista de nombres ya leida en lugar de leerla, para poder
 * comprobarse con carpetas inventadas y sin tocar el disco.
 */
export function looksLikeGameFolder(entries: string[]): boolean {
  return entries.some((entry) => {
    const name = entry.toLowerCase();
    if (ENGINE_FILE_MARKERS.includes(name)) return true;
    return ENGINE_SUFFIX_MARKERS.some((suffix) => name.endsWith(suffix));
  });
}

/** True si el ejecutable cuelga de una biblioteca de juegos conocida. */
export function isGamePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const normalized = normalizePath(path);
  return GAME_LIBRARY_MARKERS.some((marker) => normalized.includes(marker));
}

/** Quita la extension y las mayusculas, para comparar nombres de proceso. */
function bareName(processName: string): string {
  return processName.toLowerCase().replace(/[.]exe$/, '');
}

/** True si el ejecutable es un lanzador o un servicio, no un juego. */
export function isNotAGame(processName: string): boolean {
  return NOT_GAMES.includes(bareName(processName));
}

/**
 * Nombre que se le va a poner a la partida.
 *
 * Se prefiere el titulo de la ventana, que suele ser el nombre comercial del
 * juego. Cuando esta vacio o es basura tecnica, se recurre a la carpeta que
 * cuelga de la biblioteca, que en la practica es el nombre de la instalacion.
 */
export function titleFor(win: RunningWindow): string {
  const raw = (win.MainWindowTitle ?? '').trim();
  if (raw && raw.length <= 60 && !/^[a-z0-9_ .-]+[.]exe$/i.test(raw)) return raw;

  const path = normalizePath(win.Path ?? '');
  for (const marker of GAME_LIBRARY_MARKERS) {
    const at = path.indexOf(marker);
    if (at < 0) continue;
    const folder = path.slice(at + marker.length).split('/')[0];
    if (folder) return folder.replace(/[_-]+/g, ' ').trim();
  }
  return win.ProcessName;
}

/**
 * Elige que ventana de las que hay abiertas es un juego.
 *
 * `knownProcessNames` son los procesos de los juegos con adaptador propio. Si
 * uno de ellos esta corriendo, este detector se aparta por completo: tienen su
 * propia deteccion y sus eventos, y tratarlos como genericos seria cambiar
 * marcadores automaticos por ninguno.
 */
export function pickGame(
  windows: RunningWindow[],
  knownProcessNames: string[],
  listFolder: (exePath: string) => string[] = () => [],
): DetectedGame | null {
  const known = new Set(knownProcessNames.map(bareName));
  if (windows.some((win) => known.has(bareName(win.ProcessName)))) return null;

  for (const win of windows) {
    if (isNotAGame(win.ProcessName)) continue;
    if (!win.Path || isSystemPath(win.Path)) continue;
    // Basta con una de las dos senales: estar en una biblioteca conocida, o
    // tener al lado lo que solo tiene un juego.
    const esJuego =
      isGamePath(win.Path) || isUnrealExe(win.Path) || looksLikeGameFolder(listFolder(win.Path));
    if (!esJuego) continue;
    return {
      pid: win.Id,
      processName: `${win.ProcessName}.exe`,
      title: titleFor(win),
      path: win.Path as string,
    };
  }
  return null;
}

/**
 * Detecta juegos que no tienen adaptador propio.
 *
 * La senal es la ruta del ejecutable: si cuelga de una biblioteca de juegos y
 * tiene ventana, es un juego. Es una heuristica, pero de las honestas: no mira
 * dentro del proceso ni analiza la pantalla, solo lee la lista de ventanas
 * abiertas y de donde salio cada una. Equivale a mirar el Administrador de
 * tareas.
 *
 * Prefiere quedarse corto antes que pasarse: es mejor que un juego raro se
 * quede fuera a que la aplicacion se ponga a grabar porque alguien abrio el
 * navegador.
 */
export class GenericGameDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private currentPid: number | null = null;
  private knownProcessNames: string[] = [];
  private readonly folderCache = new Map<string, string[]>();

  setKnownProcessNames(names: string[]): void {
    this.knownProcessNames = names;
  }

  start(): void {
    if (this.timer) return;
    log.info('Deteccion de otros juegos iniciada');
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.currentPid = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const windows = await listWindows();
      const found = pickGame(windows, this.knownProcessNames, (exePath) =>
        this.folderOf(exePath),
      );

      if (found && found.pid !== this.currentPid) {
        // Cerrar un juego y abrir otro entre dos sondeos se veria como un solo
        // cambio de pid. Sin avisar del relevo, la grabacion anterior se
        // quedaria abierta con el nombre equivocado.
        if (this.currentPid !== null) this.emit('game-exit', null);
        this.currentPid = found.pid;
        log.info(`Otro juego detectado: ${found.title} (${found.processName}, pid ${found.pid})`);
        this.emit('game-detected', found);
      } else if (!found && this.currentPid !== null) {
        this.currentPid = null;
        log.info('El otro juego se ha cerrado');
        this.emit('game-exit', null);
      }
    } catch (err) {
      log.debug(`No se pudieron listar las ventanas: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Nombres de la carpeta donde vive un ejecutable.
   *
   * Se recuerda el resultado por ruta: los mismos programas siguen abiertos
   * sondeo tras sondeo y no tiene sentido releer sus carpetas cada diez
   * segundos. Si la carpeta no se puede leer, se responde vacio y el candidato
   * simplemente no cuela como juego.
   */
  private folderOf(exePath: string): string[] {
    const cached = this.folderCache.get(exePath);
    if (cached) return cached;
    let entries: string[] = [];
    try {
      entries = readdirSync(dirname(exePath));
    } catch {
      entries = [];
    }
    this.folderCache.set(exePath, entries);
    return entries;
  }

  dispose(): void {
    this.stop();
    this.folderCache.clear();
    this.removeAllListeners();
  }
}

/**
 * Lista los procesos con ventana y de donde salio cada ejecutable.
 *
 * `tasklist` no da la ruta, y sin ella no hay forma de distinguir un juego de
 * cualquier otro programa. PowerShell si la da. Los procesos protegidos del
 * sistema fallan al pedirles la ruta; se ignoran en silencio, porque ninguno
 * de ellos va a ser un juego.
 */
async function listWindows(): Promise<RunningWindow[]> {
  if (process.platform !== 'win32') return [];
  const script =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    '@(Get-Process -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.MainWindowHandle -ne 0 } | ' +
    'Select-Object Id, ProcessName, MainWindowTitle, Path) | ' +
    'ConvertTo-Json -Compress -Depth 2';

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 8000 },
  );

  const text = stdout.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? (parsed as RunningWindow[]) : [parsed as RunningWindow];
}
