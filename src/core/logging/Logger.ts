import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { LogEntry } from '../../shared/types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_BUFFER = 500;

/**
 * Logger estructurado con etiqueta por subsistema.
 *
 * Salida: consola + fichero rotado + buffer en memoria que el renderer puede
 * consultar para la pantalla de diagnostico. El usuario final no ve estos logs
 * salvo que abra el panel de diagnostico.
 */
class LoggerRoot extends EventEmitter {
  private stream: WriteStream | null = null;
  private logPath: string | null = null;
  private minLevel: LogLevel = 'info';
  private buffer: LogEntry[] = [];

  /** Inicializa la escritura a disco. Si falla, seguimos logueando a consola. */
  init(logDir: string, minLevel: LogLevel = 'info'): void {
    this.minLevel = minLevel;
    try {
      mkdirSync(logDir, { recursive: true });
      this.logPath = join(logDir, 'clipper.log');
      this.rotateIfNeeded();
      this.stream = createWriteStream(this.logPath, { flags: 'a' });
      this.stream.on('error', (err) => {
        console.error('[Logger] no se pudo escribir el log:', err.message);
        this.stream = null;
      });
    } catch (err) {
      console.error('[Logger] init fallido:', (err as Error).message);
    }
  }

  private rotateIfNeeded(): void {
    if (!this.logPath || !existsSync(this.logPath)) return;
    try {
      if (statSync(this.logPath).size > MAX_LOG_BYTES) {
        renameSync(this.logPath, this.logPath + '.1');
      }
    } catch {
      /* rotacion best-effort, nunca debe tumbar la app */
    }
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }

  write(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const time = Date.now();
    const extra = args.length ? ' ' + args.map(safeStringify).join(' ') : '';
    const full = message + extra;
    const line = `${new Date(time).toISOString()} [${level.toUpperCase()}] [${tag}] ${full}`;

    // eslint-disable-next-line no-console
    (console[level === 'debug' ? 'log' : level] as (...a: unknown[]) => void)(
      `[${tag}] ${full}`,
    );

    try {
      this.stream?.write(line + '\n');
    } catch {
      /* ignorado a proposito: un fallo de log jamas debe romper la grabacion */
    }

    const entry: LogEntry = { time, level, tag, message: full };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.emit('entry', entry);
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignorado */
    }
    this.stream = null;
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const loggerRoot = new LoggerRoot();

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Crea un logger etiquetado.
 * Etiquetas en uso: GameDetection, Recording, GEP, EventManager, Sync,
 * Database, Playback, Clips, Hotkeys, Settings, Recovery.
 */
export function createLogger(tag: string): Logger {
  return {
    debug: (m, ...a) => loggerRoot.write('debug', tag, m, ...a),
    info: (m, ...a) => loggerRoot.write('info', tag, m, ...a),
    warn: (m, ...a) => loggerRoot.write('warn', tag, m, ...a),
    error: (m, ...a) => loggerRoot.write('error', tag, m, ...a),
  };
}
