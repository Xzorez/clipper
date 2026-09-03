import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdapterRegistry } from '../games/registry';
import { GameAdapter } from '../games/GameAdapter';
import { createLogger } from '../logging/Logger';

const execFileAsync = promisify(execFile);
const log = createLogger('GameDetection');

const POLL_INTERVAL_MS = 5000;

export interface DetectedProcess {
  adapter: GameAdapter;
  pid: number;
  processName: string;
}

/**
 * Deteccion de juego por lista de procesos.
 *
 * Es el mecanismo de RESPALDO. La via principal es el evento `game-detected`
 * de GEP, que es mas fiable porque Overwolf mantiene una lista de juegos
 * actualizada y sabe distinguir el juego de su lanzador.
 *
 * Este vigilante existe para que la aplicacion siga detectando partidas cuando
 * GEP no esta disponible (Electron estandar, o sin credenciales de Dev Mode).
 * En ese modo se graba el video, pero sin marcadores de kills.
 *
 * Importante sobre seguridad: esto solo LISTA procesos con `tasklist`, una
 * herramienta estandar de Windows. No abre handles del proceso del juego, no
 * lee su memoria y no interactua con el de ninguna forma. Es equivalente a
 * mirar el Administrador de tareas.
 */
export class ProcessWatcher extends EventEmitter {
  private readonly registry: AdapterRegistry;
  private timer: NodeJS.Timeout | null = null;
  private currentPid: number | null = null;
  private currentGame: string | null = null;
  private polling = false;

  constructor(registry: AdapterRegistry) {
    super();
    this.registry = registry;
  }

  start(): void {
    if (this.timer) return;
    log.info('Vigilante de procesos iniciado (modo de respaldo)');
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentPid = null;
    this.currentGame = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const processes = await listProcesses();
      const found = this.findGame(processes);

      if (found && found.pid !== this.currentPid) {
        this.currentPid = found.pid;
        this.currentGame = found.adapter.game;
        log.info(`Proceso de juego detectado: ${found.processName} (pid ${found.pid})`);
        this.emit('game-detected', found);
      } else if (!found && this.currentPid !== null) {
        const game = this.currentGame;
        this.currentPid = null;
        this.currentGame = null;
        log.info('El proceso del juego ha desaparecido');
        this.emit('game-exit', game);
      }
    } catch (err) {
      log.debug(`No se pudo listar procesos: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private findGame(processes: Array<{ name: string; pid: number }>): DetectedProcess | null {
    for (const proc of processes) {
      const adapter = this.registry.byProcess(proc.name);
      if (adapter) {
        return { adapter, pid: proc.pid, processName: proc.name };
      }
    }
    return null;
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }
}

/** Lista los procesos con tasklist en formato CSV. */
async function listProcesses(): Promise<Array<{ name: string; pid: number }>> {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  const result: Array<{ name: string; pid: number }> = [];
  for (const line of stdout.split('\n')) {
    // Formato: "nombre.exe","1234","Console","1","12.345 KB"
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (!match) continue;
    result.push({ name: match[1], pid: Number(match[2]) });
  }
  return result;
}
