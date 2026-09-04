/**
 * Iconos de linea.
 *
 * Se dibujan a mano en lugar de usar emoji: los emoji cambian de forma segun el
 * sistema, tienen color propio que compite con el acento y rompen la
 * alineacion vertical del texto. Un trazo uniforme de 1.5 px encaja con el
 * peso de la tipografia.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };
}

export function IconHome({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  );
}

export function IconLibrary({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18" />
      <path d="M10 13.5v3l3-1.5z" />
    </svg>
  );
}

export function IconClips({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8.2 8.2 20 18" />
      <path d="M8.2 15.8 20 6" />
    </svg>
  );
}

export function IconSettings({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}

export function IconPlay({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

export function IconPause({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  );
}

export function IconBack({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function IconSkipBack({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M11 6 5 12l6 6" />
      <path d="M19 6l-6 6 6 6" />
    </svg>
  );
}

export function IconSkipFwd({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M13 6l6 6-6 6" />
      <path d="M5 6l6 6-6 6" />
    </svg>
  );
}

export function IconVolume({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M16 9.5a4 4 0 0 1 0 5" />
    </svg>
  );
}

export function IconMute({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" />
      <path d="M16 10l4 4M20 10l-4 4" />
    </svg>
  );
}

export function IconFullscreen({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

export function IconScissors({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8.2 8.2 20 18M8.2 15.8 20 6" />
    </svg>
  );
}

export function IconMore({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="5.5" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="18.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

export function IconFilm({ size = 32, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 12h18" />
    </svg>
  );
}

export function IconRecord({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

export function IconStop({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor" stroke="none">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </svg>
  );
}
