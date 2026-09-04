/**
 * La marca de Clipper.
 *
 * Un anillo con un tramo destacado: el anillo es la grabacion completa y el
 * tramo en color es el momento marcado dentro de ella. Es literalmente lo que
 * hace la aplicacion, que no recorta la partida sino que la conserva entera y
 * senala lo que importa.
 *
 * Se dibuja con `currentColor` en el anillo base para que herede el color del
 * contexto, y con el acento fijo en el tramo, que es la parte que debe
 * reconocerse siempre.
 */
export function Logo({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="Clipper"
      fill="none"
    >
      <circle
        cx="32"
        cy="32"
        r="21"
        stroke="currentColor"
        strokeWidth="5"
        opacity="0.26"
        strokeLinecap="round"
      />
      <circle
        cx="32"
        cy="32"
        r="21"
        stroke="var(--accent)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="38 194"
        transform="rotate(-72 32 32)"
      />
      <circle cx="32" cy="11" r="4.5" fill="var(--accent)" />
    </svg>
  );
}
