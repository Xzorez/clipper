import { describe, it, expect } from 'vitest';
import {
  isGamePath,
  isNotAGame,
  isSystemPath,
  isUnrealExe,
  looksLikeGameFolder,
  pickGame,
  titleFor,
  RunningWindow,
} from '../src/core/detection/GenericGameDetector';

/** Construye una ventana como la que devuelve PowerShell. */
function win(partial: Partial<RunningWindow>): RunningWindow {
  return {
    Id: 1000,
    ProcessName: 'algo',
    MainWindowTitle: '',
    Path: null,
    ...partial,
  };
}

/**
 * Deteccion de juegos sin adaptador propio.
 *
 * El riesgo aqui no es dejar escapar un juego raro, sino lo contrario: ponerse
 * a grabar el escritorio porque alguien abrio Discord. Casi todo lo que se
 * prueba son casos reales tomados de una maquina con juegos de verdad.
 */
describe('deteccion de otros juegos', () => {
  describe('rutas', () => {
    it('reconoce las bibliotecas de las tiendas', () => {
      expect(isGamePath('D:\\SteamLibrary\\steamapps\\common\\Hades\\Hades.exe')).toBe(true);
      expect(isGamePath('C:\\Program Files\\Epic Games\\Fortnite\\game.exe')).toBe(true);
      expect(isGamePath('C:\\XboxGames\\Forza\\Content\\forza.exe')).toBe(true);
    });

    it('no confunde una carpeta cualquiera con una biblioteca', () => {
      expect(isGamePath('C:\\Users\\x\\Downloads\\instalador.exe')).toBe(false);
      expect(isGamePath(null)).toBe(false);
    });

    it('descarta el sistema y las apps empaquetadas de Windows', () => {
      expect(isSystemPath('C:\\Windows\\Explorer.EXE')).toBe(true);
      expect(isSystemPath('C:\\Windows\\system32\\ApplicationFrameHost.exe')).toBe(true);
      expect(isSystemPath('C:\\Program Files\\WindowsApps\\Algo\\app.exe')).toBe(true);
      expect(isSystemPath('B:\\Juegos\\Cosa\\cosa.exe')).toBe(false);
    });

    it('trata la ruta desconocida como no apta', () => {
      // Sin ruta no hay forma de saber que es: mejor no grabar.
      expect(isSystemPath(null)).toBe(true);
    });
  });

  describe('contenido de la carpeta', () => {
    it('reconoce un juego por lo que tiene al lado', () => {
      // Caso real: Machine Party, en B:/Juegos, fuera de toda biblioteca.
      expect(
        looksLikeGameFolder([
          'Machine Party.exe',
          'Machine Party.pck',
          'steam_api64.dll',
          'winmm.dll',
        ]),
      ).toBe(true);
      expect(looksLikeGameFolder(['juego.exe', 'UnityPlayer.dll', 'juego_Data'])).toBe(true);
    });

    it('no toma por juego una aplicacion de Electron', () => {
      // Este fue un falso positivo real: .pak es tambien el formato de los
      // recursos de Chromium, asi que Discord, Spotify, el lanzador Hydra y el
      // overlay de NVIDIA colaban todos como juegos.
      const electron = [
        'Discord.exe',
        'chrome_100_percent.pak',
        'chrome_200_percent.pak',
        'resources.pak',
        'ffmpeg.dll',
        'icudtl.dat',
      ];
      expect(looksLikeGameFolder(electron)).toBe(false);
    });

    it('no dice nada de una carpeta corriente', () => {
      expect(looksLikeGameFolder(['brave.exe', 'chrome_elf.dll'])).toBe(false);
      expect(looksLikeGameFolder([])).toBe(false);
    });

    it('reconoce el nombre de ejecutable de Unreal', () => {
      expect(isUnrealExe('D:\\Games\\Lies\\Binaries\\Win64\\Lies-Win64-Shipping.exe')).toBe(true);
      expect(isUnrealExe('C:\\app\\normal.exe')).toBe(false);
    });
  });

  describe('lanzadores', () => {
    it('descarta los clientes de las tiendas', () => {
      // Sin esto, abrir Steam bastaria para empezar a grabar el escritorio.
      expect(isNotAGame('Steam.exe')).toBe(true);
      expect(isNotAGame('EpicGamesLauncher.exe')).toBe(true);
      expect(isNotAGame('RiotClientServices.exe')).toBe(true);
      expect(isNotAGame('Hades.exe')).toBe(false);
    });
  });

  describe('eleccion', () => {
    const carpetas: Record<string, string[]> = {
      'B:\\Juegos\\Machine Party\\Machine Party.exe': ['Machine Party.pck', 'steam_api64.dll'],
      'C:\\Users\\x\\AppData\\Local\\Discord\\Discord.exe': ['resources.pak'],
      'C:\\Program Files\\Brave\\brave.exe': ['chrome_elf.dll'],
    };
    const listar = (p: string) => carpetas[p] ?? [];

    it('elige el juego y deja pasar lo demas', () => {
      const elegido = pickGame(
        [
          win({ Id: 1, ProcessName: 'brave', Path: 'C:\\Program Files\\Brave\\brave.exe' }),
          win({
            Id: 2,
            ProcessName: 'Discord',
            Path: 'C:\\Users\\x\\AppData\\Local\\Discord\\Discord.exe',
          }),
          win({
            Id: 3,
            ProcessName: 'Machine Party',
            MainWindowTitle: 'Machine Party',
            Path: 'B:\\Juegos\\Machine Party\\Machine Party.exe',
          }),
        ],
        [],
        listar,
      );

      expect(elegido?.pid).toBe(3);
      expect(elegido?.title).toBe('Machine Party');
      expect(elegido?.processName).toBe('Machine Party.exe');
    });

    it('se aparta cuando corre un juego con adaptador propio', () => {
      // VALORANT tiene su propia deteccion y sus eventos. Tratarlo como
      // generico cambiaria marcadores automaticos por ninguno.
      const elegido = pickGame(
        [
          win({
            Id: 3,
            ProcessName: 'Machine Party',
            Path: 'B:\\Juegos\\Machine Party\\Machine Party.exe',
          }),
          win({ Id: 4, ProcessName: 'VALORANT-Win64-Shipping', Path: 'C:\\Riot\\v.exe' }),
        ],
        ['VALORANT-Win64-Shipping.exe'],
        listar,
      );

      expect(elegido).toBeNull();
    });

    it('no elige nada cuando solo hay programas normales', () => {
      const elegido = pickGame(
        [
          win({ Id: 1, ProcessName: 'brave', Path: 'C:\\Program Files\\Brave\\brave.exe' }),
          win({ Id: 5, ProcessName: 'explorer', Path: 'C:\\Windows\\Explorer.EXE' }),
        ],
        [],
        listar,
      );
      expect(elegido).toBeNull();
    });
  });

  describe('nombre de la partida', () => {
    it('usa el titulo de la ventana', () => {
      expect(titleFor(win({ MainWindowTitle: 'Hollow Knight', ProcessName: 'hk' }))).toBe(
        'Hollow Knight',
      );
    });

    it('recurre a la carpeta cuando el titulo no sirve', () => {
      const nombre = titleFor(
        win({
          MainWindowTitle: '',
          ProcessName: 'game',
          Path: 'D:\\SteamLibrary\\steamapps\\common\\Dead Cells\\game.exe',
        }),
      );
      expect(nombre).toBe('dead cells');
    });

    it('descarta un titulo que es solo el nombre del ejecutable', () => {
      const nombre = titleFor(
        win({
          MainWindowTitle: 'game.exe',
          ProcessName: 'game',
          Path: 'D:\\SteamLibrary\\steamapps\\common\\Celeste\\game.exe',
        }),
      );
      expect(nombre).toBe('celeste');
    });
  });
});
