import { EventEmitter } from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logging/Logger';

const log = createLogger('Audio');

const EXE = 'clipper-loopback.exe';

/**
 * Localiza el capturador de sonido del sistema.
 *
 * Viaja dentro de la aplicacion, como FFmpeg: quien la instala no tiene que
 * poner nada aparte.
 */
export function resolveLoopbackPath(): string | null {
  const candidates: string[] = [];

  if (process.env.CLIPPER_LOOPBACK) candidates.push(process.env.CLIPPER_LOOPBACK);

  try {
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'native', EXE));
      candidates.push(join(process.resourcesPath, EXE));
    }
    candidates.push(join(dirname(app.getPath('exe')), 'resources', 'native', EXE));
  } catch {
    /* app puede no estar lista en los tests */
  }

  // En desarrollo, tal cual lo deja el script de compilacion.
  candidates.push(join(process.cwd(), 'resources', 'native', EXE));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Sonido del sistema, capturado por WASAPI.
 *
 * Windows no ofrece ningun dispositivo con el que FFmpeg pueda grabar lo que
 * suena, y el bucle de Chromium falla en algunas maquinas sin que haya nada
 * que tocar desde aqui: se probaron siete variantes y dos banderas, todas con
 * el mismo NotReadableError. Asi que lo hace un programa propio, minusculo,
 * que pide a Windows una copia de lo que ya esta sonando por la salida
 * predeterminada. Es la misma via que usa cualquier grabador para el "audio de
 * escritorio", y no toca ningun otro proceso.
 *
 * Entrega PCM de 16 bits a 48 kHz en estereo, que es lo que espera la tuberia.
 */
export class SystemAudioCapture extends EventEmitter {
  private proc: ChildProcess | null = null;
  private bytes = 0;

  /** True si hay capturador disponible en esta instalacion. */
  static isAvailable(): boolean {
    return process.platform === 'win32' && resolveLoopbackPath() !== null;
  }

  /** Arranca la captura. Devuelve false si no se ha podido. */
  start(): boolean {
    if (this.proc) return true;

    const exe = resolveLoopbackPath();
    if (!exe) {
      log.warn('No se ha encontrado el capturador de sonido del sistema');
      return false;
    }

    try {
      this.proc = spawn(exe, [], { windowsHide: true });
    } catch (err) {
      log.warn(`No se pudo arrancar el capturador: ${(err as Error).message}`);
      this.proc = null;
      return false;
    }

    this.bytes = 0;
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      this.emit('data', chunk);
    });

    // El capturador cuenta por la salida de error que dispositivo abrio y a que
    // formato: es la unica forma de saber despues por que sono raro.
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.info(`Sonido del sistema: ${text}`);
    });

    this.proc.on('error', (err) => {
      log.warn(`El capturador de sonido fallo: ${err.message}`);
      this.proc = null;
    });

    this.proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        log.warn(`El capturador de sonido termino con codigo ${code}`);
      }
      this.proc = null;
    });

    return true;
  }

  /** Bytes entregados. Sirve para saber si llego a captar algo. */
  get bytesCaptured(): number {
    return this.bytes;
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* ya estaba muerto */
    }
    this.proc = null;
    this.removeAllListeners('data');
  }
}
