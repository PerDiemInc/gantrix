/**
 * Built-in agent avatars: Gant, the three-bar mascot, in different colours and outfits.
 * Drawn here as SVG, so they need no files and stay crisp at any size.
 */

type Accessory = 'none' | 'glasses' | 'antenna' | 'headset' | 'crown' | 'shield' | 'beret' | 'bow';

interface Preset {
  id: string;
  label: string;
  bg: string;
  bars: [string, string, string];
  accessory: Accessory;
}

const BLUE = '#4f7cff';
const GREEN = '#2ed18a';
const AMBER = '#ffb627';
const PINK = '#ff5ea8';
const PURPLE = '#8b6cff';
const TEAL = '#21b8c9';

export const PRESETS: Preset[] = [
  {
    id: 'gant-classic',
    label: 'Gant',
    bg: '#fff6df',
    bars: [BLUE, GREEN, AMBER],
    accessory: 'none',
  },
  {
    id: 'gant-glasses',
    label: 'Engineer',
    bg: '#e8eeff',
    bars: [BLUE, TEAL, PURPLE],
    accessory: 'glasses',
  },
  {
    id: 'gant-headset',
    label: 'Marketer',
    bg: '#ffe4f0',
    bars: [PINK, AMBER, BLUE],
    accessory: 'headset',
  },
  {
    id: 'gant-crown',
    label: 'Closer',
    bg: '#fff1d6',
    bars: [AMBER, GREEN, PINK],
    accessory: 'crown',
  },
  {
    id: 'gant-shield',
    label: 'Guardian',
    bg: '#e2f8ee',
    bars: [GREEN, TEAL, BLUE],
    accessory: 'shield',
  },
  {
    id: 'gant-antenna',
    label: 'Planner',
    bg: '#efe8ff',
    bars: [PURPLE, BLUE, GREEN],
    accessory: 'antenna',
  },
  {
    id: 'gant-beret',
    label: 'Designer',
    bg: '#ffe9e0',
    bars: [PINK, PURPLE, AMBER],
    accessory: 'beret',
  },
  { id: 'gant-bow', label: 'Editor', bg: '#e3f6f9', bars: [TEAL, PINK, GREEN], accessory: 'bow' },
  {
    id: 'gant-night',
    label: 'Night owl',
    bg: '#2a2740',
    bars: [BLUE, PINK, AMBER],
    accessory: 'glasses',
  },
  {
    id: 'gant-mint',
    label: 'Researcher',
    bg: '#e2f8ee',
    bars: [GREEN, BLUE, AMBER],
    accessory: 'antenna',
  },
  { id: 'gant-sunny', label: 'Sunny', bg: '#fff3c4', bars: [AMBER, PINK, TEAL], accessory: 'none' },
  {
    id: 'gant-grape',
    label: 'Analyst',
    bg: '#efe8ff',
    bars: [PURPLE, AMBER, GREEN],
    accessory: 'headset',
  },
];

const INK = '#1d1a33';

function Accessory({ kind }: { kind: Accessory }) {
  const ink = {
    stroke: INK,
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'glasses':
      return (
        <g fill="none" {...ink}>
          <circle cx="27" cy="33" r="5.5" />
          <circle cx="41" cy="33" r="5.5" />
          <path d="M32.5 33h3" />
        </g>
      );
    case 'antenna':
      return (
        <g {...ink}>
          <path d="M24 17l-3-7M36 17l4-8" fill="none" />
          <circle cx="21" cy="9" r="2.6" fill={PINK} />
          <circle cx="40" cy="8" r="2.6" fill={AMBER} />
        </g>
      );
    case 'headset':
      return (
        <g fill="none" {...ink}>
          <path d="M17 32a17 17 0 0 1 34 0" />
          <rect x="13" y="30" width="6" height="9" rx="2.5" fill={INK} />
          <path d="M16 39c0 6 5 8 11 8" />
        </g>
      );
    case 'crown':
      return <path d="M19 16l4-8 6 6 5-8 5 8 6-6 3 8z" fill={AMBER} {...ink} />;
    case 'shield':
      return <path d="M46 40l7-3 7 3v6c0 5-3 8-7 10-4-2-7-5-7-10z" fill={GREEN} {...ink} />;
    case 'beret':
      return (
        <g {...ink}>
          <ellipse cx="30" cy="16" rx="15" ry="5.5" fill={PINK} />
          <path d="M30 10.5v-3" fill="none" />
        </g>
      );
    case 'bow':
      return <path d="M44 15l7-4v10zM44 15l-7-4v10z" fill={PINK} {...ink} />;
    default:
      return null;
  }
}

export function PresetAvatar({ id, size }: { id: string; size: number }) {
  const p = PRESETS.find((x) => x.id === id) ?? (PRESETS[0] as Preset);
  const ink = { stroke: INK, strokeWidth: 2.5 };
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="avatar-svg">
      <circle cx="32" cy="32" r="32" fill={p.bg} />
      {/* three Gantt bars: the body */}
      <rect x="12" y="20" width="30" height="11" rx="5.5" fill={p.bars[0]} {...ink} />
      <rect x="20" y="29" width="34" height="13" rx="6.5" fill={p.bars[1]} {...ink} />
      <rect x="15" y="42" width="22" height="10" rx="5" fill={p.bars[2]} {...ink} />
      {/* the face lives on the middle bar */}
      <circle cx="32" cy="35" r="3.4" fill="#fff" {...ink} strokeWidth={2} />
      <circle cx="42" cy="35" r="3.4" fill="#fff" {...ink} strokeWidth={2} />
      <circle cx="33" cy="35.5" r="1.4" fill={INK} />
      <circle cx="43" cy="35.5" r="1.4" fill={INK} />
      <path
        d="M34.5 39.5q3 2.2 6 0"
        fill="none"
        stroke={INK}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <Accessory kind={p.accessory} />
    </svg>
  );
}

/** The default for an agent without a chosen avatar: stable for its name. */
export function defaultPresetFor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (PRESETS[h % PRESETS.length] as Preset).id;
}

/** What the built-in team starts with. */
export const ROLE_PRESETS: Record<string, string> = {
  cto: 'gant-glasses',
  cmo: 'gant-headset',
  cro: 'gant-crown',
  ciso: 'gant-shield',
  cpo: 'gant-antenna',
  designer: 'gant-beret',
  researcher: 'gant-mint',
  editor: 'gant-bow',
  analyst: 'gant-grape',
};

export type AvatarChoice =
  | { kind: 'preset'; id: string }
  | { kind: 'image'; src: string }
  | { kind: 'initials' };

export function avatarChoice(name: string, avatar: string | null | undefined): AvatarChoice {
  if (avatar?.startsWith('preset:')) return { kind: 'preset', id: avatar.slice('preset:'.length) };
  if (avatar?.startsWith('data:image/')) return { kind: 'image', src: avatar };
  if (avatar === 'initials') return { kind: 'initials' };
  return { kind: 'preset', id: ROLE_PRESETS[name] ?? defaultPresetFor(name) };
}
