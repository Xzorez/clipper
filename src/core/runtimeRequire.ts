import { createRequire } from 'node:module';

/**
 * Devuelve una funcion `require` valida en el entorno actual.
 *
 * Hace falta porque el mismo codigo se ejecuta en dos contextos distintos:
 *
 *  - En el proceso principal, compilado a CommonJS por tsc, donde `require`
 *    existe de forma nativa.
 *  - En los tests, cargados por Vite como modulos ES, donde no existe.
 *
 * Se evita `import.meta.url` a proposito: TypeScript lo prohibe al compilar a
 * CommonJS. La ruta base solo se usa para resolver, y tanto los modulos
 * integrados de Node como las dependencias del proyecto se resuelven bien
 * partiendo del directorio de trabajo.
 */
export function runtimeRequire(): NodeRequire {
  if (typeof require === 'function') return require;
  const base =
    typeof __filename !== 'undefined' ? __filename : process.cwd() + '/index.cjs';
  return createRequire(base);
}
