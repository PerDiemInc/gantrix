/** One small set of line icons, drawn on a 24px grid with a 2px stroke, so every icon matches. */
const PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  play: 'M8 5.5v13l10.5-6.5z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  hand: 'M12 3v9m0 0l-3-3m3 3l3-3M5 15v2a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-2',
  alert:
    'M12 8v5m0 3.5v.5M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  dot: 'M12 12h.01',
  chat: 'M4 5h16v11H9l-5 4z',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-6 10a6 6 0 0 1 12 0m1-10a3.5 3.5 0 1 0 0-7m2 17a6 6 0 0 0-3-5.2',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  plus: 'M12 5v14M5 12h14',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  stop: 'M7 7h10v10H7z',
  gavel: 'M14 4l6 6M11 7l6 6M8 10l5-5 6 6-5 5zM10 14l-6 6',
  send: 'M4 12l16-8-6 16-3-7z',
  arrowLeft: 'M19 12H5m6-6l-6 6 6 6',
  pause: 'M8 5v14M16 5v14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  hash: 'M9 4L7 20M17 4l-2 16M4 9h16M3 15h16',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  /** Set it when the icon carries meaning on its own; otherwise it's hidden from screen readers. */
  label?: string;
  className?: string;
}) {
  const common = {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `icon ${className ?? ''}`,
  };
  return label ? (
    <svg {...common} role="img">
      <title>{label}</title>
      <path d={PATHS[name]} />
    </svg>
  ) : (
    <svg {...common} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The icon that goes with each project and task status, so status never relies on colour. */
export const STATUS_ICON: Record<string, IconName> = {
  planning: 'list',
  running: 'play',
  awaiting_approval: 'hand',
  delegating: 'users',
  succeeded: 'check',
  failed: 'x',
  needs_attention: 'alert',
  cancelled: 'stop',
  pending: 'clock',
  queued: 'clock',
  judging: 'gavel',
  superseded: 'arrowLeft',
};
