import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      // El nucleo solo toca Electron en puntos concretos; en los tests se
      // sustituye por un doble para poder ejecutarlo en Node puro.
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
