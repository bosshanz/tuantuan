import type { ReactNode } from "react";
import type { AvatarShape } from "../../server/avatars";

/** Hand-authored silhouettes in a 100×100 box; `eyes` is where the face sits (x, y of the midpoint). */
const SHAPES: Record<AvatarShape, { body: ReactNode; eyes: [number, number] }> = {
  orb: { body: <circle cx="50" cy="52" r="40" />, eyes: [50, 46] },
  cloud: {
    body: (
      <>
        <circle cx="32" cy="60" r="22" />
        <circle cx="52" cy="42" r="27" />
        <circle cx="72" cy="58" r="21" />
        <rect x="24" y="52" width="58" height="30" rx="15" />
      </>
    ),
    eyes: [52, 52],
  },
  tile: { body: <rect x="19" y="19" width="62" height="62" rx="13" transform="rotate(-14 50 50)" />, eyes: [50, 50] },
  spark: {
    body: (
      <path
        d="M50 10C56 34 64 42 90 50C64 58 56 66 50 90C44 66 36 58 10 50C36 42 44 34 50 10Z"
        strokeWidth="12"
        strokeLinejoin="round"
        className="ba-stroke"
      />
    ),
    eyes: [50, 50],
  },
  clover: {
    body: (
      <>
        <circle cx="36" cy="36" r="20" />
        <circle cx="64" cy="36" r="20" />
        <circle cx="36" cy="64" r="20" />
        <circle cx="64" cy="64" r="20" />
        <circle cx="50" cy="50" r="22" />
      </>
    ),
    eyes: [50, 48],
  },
  bean: {
    body: <path d="M22 36C34 14 70 12 84 30C96 46 84 70 62 80C40 90 14 80 12 60C11 50 16 44 22 36Z" />,
    eyes: [52, 46],
  },
  flower: {
    body: (
      <>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <circle
            key={a}
            cx={50 + 27 * Math.cos((a * Math.PI) / 180)}
            cy={50 + 27 * Math.sin((a * Math.PI) / 180)}
            r="15"
          />
        ))}
        <circle cx="50" cy="50" r="28" />
      </>
    ),
    eyes: [50, 49],
  },
  drop: { body: <path d="M50 8C64 28 84 44 84 62A34 34 0 0 1 16 62C16 44 36 28 50 8Z" />, eyes: [50, 58] },
  pill: { body: <rect x="10" y="27" width="80" height="48" rx="24" transform="rotate(-10 50 51)" />, eyes: [54, 48] },
  wedge: {
    body: <path d="M28 22L80 48L28 78Z" strokeWidth="20" strokeLinejoin="round" className="ba-stroke" />,
    eyes: [44, 48],
  },
  gem: {
    body: <rect x="19" y="19" width="62" height="62" rx="17" transform="rotate(45 50 50)" />,
    eyes: [50, 50],
  },
  burst: {
    body: (
      <path
        d="M50 8L58 30L80 18L72 41L94 50L72 59L80 82L58 70L50 92L42 70L20 82L28 59L6 50L28 41L20 18L42 30Z"
        strokeWidth="10"
        strokeLinejoin="round"
        className="ba-stroke"
      />
    ),
    eyes: [50, 50],
  },
  hex: {
    body: (
      <path d="M50 10L85 30L85 70L50 90L15 70L15 30Z" strokeWidth="12" strokeLinejoin="round" className="ba-stroke" />
    ),
    eyes: [50, 50],
  },
};

export function BotAvatar({ shape, color, size = 32 }: { shape: AvatarShape; color: string; size?: number }) {
  const s = SHAPES[shape] ?? SHAPES.orb;
  const [x, y] = s.eyes;
  return (
    <svg
      className="bot-avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ ["--c" as string]: color }}
      aria-hidden
    >
      <g className="ba-body">{s.body}</g>
      <g className="ba-eyes">
        <line x1={x - 9} y1={y - 6} x2={x - 11} y2={y + 6} />
        <line x1={x + 9} y1={y - 6} x2={x + 7} y2={y + 6} />
      </g>
    </svg>
  );
}
