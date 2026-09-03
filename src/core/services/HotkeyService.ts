import { EventEmitter } from 'node:events';
import { globalShortcut } from 'electron';
import { HotkeySettings } from '../../shared/types';
import { createLogger } from '../logging/Logger';

const log = createLogger('Hotkeys');

export type HotkeyAction = 'saveClip' | 'bookmark' | 'toggleRecording';

export interface HotkeyRegistrationResult {
  registered: Record<HotkeyAction, boolean>;
  failed: Array<{ action: HotkeyAction; accelerator: string }>;
}

/**
 * Atajos globales de teclado.
 *
 * Implementacion: `globalShortcut` de Electron, que por debajo usa la API
 * `RegisterHotKey` de Win32. Es la via correcta en Windows porque el atajo se
 * registra a nivel de sistema y funciona aunque el foco lo tenga el juego,
 * incluido pantalla completa exclusiva. No requiere ningun hook de teclado de
 * bajo nivel, que es justo lo que queremos evitar: un hook global tipo
 * WH_KEYBOARD_LL se parece demasiado a un keylogger y los anticheat lo miran
 * con lupa. RegisterHotKey es una API publica, pasiva y sin relacion con el
 * proceso del juego.
 *
 * Limitacion real y honesta: si el juego se ejecuta como administrador y
 * nosotros no, Windows aplica aislamiento de privilegios (UIPI) y el atajo no
 * llegara mientras el juego tenga el foco. Es exactamente la misma causa que
 * obliga a ejecutar la aplicacion como administrador para recibir eventos GEP,
 * asi que la solucion es la misma y la avisamos una sola vez.
 */
export class HotkeyService extends EventEmitter {
  private registered = new Set<string>();

  /**
   * Registra los atajos. Devuelve cuales han fallado para poder avisar al
   * usuario: un atajo que no se registra suele significar que otra aplicacion
   * (a menudo otro grabador) ya lo tiene cogido.
   */
  register(settings: HotkeySettings): HotkeyRegistrationResult {
    this.unregisterAll();

    const bindings: Array<{ action: HotkeyAction; accelerator: string }> = [
      { action: 'saveClip', accelerator: settings.saveClip },
      { action: 'bookmark', accelerator: settings.bookmark },
      { action: 'toggleRecording', accelerator: settings.toggleRecording },
    ];

    const result: HotkeyRegistrationResult = {
      registered: { saveClip: false, bookmark: false, toggleRecording: false },
      failed: [],
    };

    for (const { action, accelerator } of bindings) {
      if (!accelerator) continue;
      try {
        const ok = globalShortcut.register(accelerator, () => {
          log.info(`Atajo activado: ${accelerator} -> ${action}`);
          this.emit('hotkey', action);
        });
        if (ok) {
          this.registered.add(accelerator);
          result.registered[action] = true;
        } else {
          result.failed.push({ action, accelerator });
          log.warn(`No se pudo registrar ${accelerator} (probablemente ya esta en uso)`);
        }
      } catch (err) {
        result.failed.push({ action, accelerator });
        log.warn(`Error al registrar ${accelerator}: ${(err as Error).message}`);
      }
    }

    log.info(
      `Atajos activos: ${[...this.registered].join(', ') || 'ninguno'}` +
        (result.failed.length ? ` | fallidos: ${result.failed.map((f) => f.accelerator).join(', ')}` : ''),
    );
    return result;
  }

  unregisterAll(): void {
    for (const accelerator of this.registered) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* ignorado */
      }
    }
    this.registered.clear();
  }

  dispose(): void {
    this.unregisterAll();
    this.removeAllListeners();
  }
}
