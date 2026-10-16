import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../../server/avatars";
import type { Expression } from "./avatarState";

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
  cat: {
    body: (
      <>
        <path
          d="M17 50L19 14Q20 9 25 12L46 28Z"
          strokeWidth="6"
          strokeLinejoin="round"
          className="ba-stroke ba-fillstroke"
        />
        <path
          d="M83 50L81 14Q80 9 75 12L54 28Z"
          strokeWidth="6"
          strokeLinejoin="round"
          className="ba-stroke ba-fillstroke"
        />
        <ellipse cx="50" cy="58" rx="38" ry="32" />
      </>
    ),
    eyes: [50, 56],
  },
  dog: {
    body: (
      <>
        <circle cx="50" cy="54" r="34" />
        <ellipse cx="20" cy="46" rx="12" ry="24" transform="rotate(18 20 46)" />
        <ellipse cx="80" cy="46" rx="12" ry="24" transform="rotate(-18 80 46)" />
        <ellipse cx="50" cy="74" rx="16" ry="12" />
      </>
    ),
    eyes: [50, 52],
  },
  rabbit: {
    body: (
      <>
        <rect x="27" y="4" width="17" height="46" rx="8.5" transform="rotate(-10 35 40)" />
        <rect x="56" y="4" width="17" height="46" rx="8.5" transform="rotate(10 65 40)" />
        <ellipse cx="50" cy="64" rx="34" ry="29" />
      </>
    ),
    eyes: [50, 63],
  },
  panda: {
    body: (
      <>
        <circle cx="24" cy="24" r="15" />
        <circle cx="76" cy="24" r="15" />
        <ellipse cx="50" cy="57" rx="39" ry="35" />
        <ellipse className="ba-cutout" cx="50" cy="57" rx="32" ry="28" />
        <ellipse cx="37" cy="51" rx="12" ry="16" transform="rotate(24 37 51)" />
        <ellipse cx="63" cy="51" rx="12" ry="16" transform="rotate(-24 63 51)" />
      </>
    ),
    eyes: [50, 51],
  },
  goat: {
    body: (
      <>
        <path d="M34 36C20 29 18 13 28 6C25 20 34 21 42 29Z" />
        <path d="M66 36C80 29 82 13 72 6C75 20 66 21 58 29Z" />
        <path d="M36 39C24 30 14 34 7 42C15 54 27 56 38 47Z" />
        <path d="M64 39C76 30 86 34 93 42C85 54 73 56 62 47Z" />
        <path d="M39 72Q50 76 61 72L57 87Q50 98 43 87Z" />
        <path d="M30 34Q50 22 70 34Q79 47 67 68L59 79Q50 85 41 79L33 68Q21 47 30 34Z" />
      </>
    ),
    eyes: [50, 50],
  },
  cow: {
    body: (
      <>
        <path d="M31 32C15 32 10 18 17 10C18 22 28 16 36 25Z" />
        <path d="M69 32C85 32 90 18 83 10C82 22 72 16 64 25Z" />
        <ellipse cx="17" cy="43" rx="14" ry="10" transform="rotate(20 17 43)" />
        <ellipse cx="83" cy="43" rx="14" ry="10" transform="rotate(-20 83 43)" />
        <ellipse cx="50" cy="53" rx="31" ry="34" />
        <rect x="24" y="56" width="52" height="35" rx="17" />
        <rect className="ba-detail" x="29" y="62" width="42" height="23" rx="11.5" />
        <ellipse className="ba-cutout" cx="39" cy="73" rx="3" ry="4" />
        <ellipse className="ba-cutout" cx="61" cy="73" rx="3" ry="4" />
      </>
    ),
    eyes: [50, 43],
  },
};

/** Eyes (and mouth) per expression, drawn around the face midpoint (x, y). */
function Face({ e, x, y }: { e: Expression; x: number; y: number }) {
  const L = x - 10;
  const R = x + 8;
  switch (e) {
    case "happy":
      return (
        <g className="ba-eyes">
          <path d={`M${L - 6} ${y + 3}Q${L} ${y - 7} ${L + 6} ${y + 3}`} />
          <path d={`M${R - 6} ${y + 3}Q${R} ${y - 7} ${R + 6} ${y + 3}`} />
        </g>
      );
    case "surprised":
      return (
        <>
          <g className="ba-eyes">
            <circle className="ba-dot" cx={L} cy={y - 1} r="5.5" />
            <circle className="ba-dot" cx={R} cy={y - 1} r="5.5" />
          </g>
          <circle className="ba-dot ba-mouth" cx={x - 1} cy={y + 15} r="3.5" />
        </>
      );
    case "sad":
      return (
        <>
          <g className="ba-eyes">
            <line x1={L - 3} y1={y - 1} x2={L + 1} y2={y + 8} />
            <line x1={R + 3} y1={y - 1} x2={R - 1} y2={y + 8} />
          </g>
          <path className="ba-mouth" d={`M${x - 8} ${y + 20}Q${x - 1} ${y + 14} ${x + 6} ${y + 20}`} />
        </>
      );
    case "sleepy":
      return (
        <g className="ba-eyes">
          <line x1={L - 5} y1={y + 3} x2={L + 5} y2={y + 3} />
          <line x1={R - 5} y1={y + 3} x2={R + 5} y2={y + 3} />
        </g>
      );
    case "working":
      // Focused: eyes lowered to the work, slightly narrowed.
      return (
        <g className="ba-look">
          <g className="ba-eyes">
            <line x1={L - 3} y1={y + 3} x2={L + 3} y2={y + 4} />
            <line x1={R - 3} y1={y + 4} x2={R + 3} y2={y + 3} />
          </g>
        </g>
      );
    case "thinking":
      return (
        <g className="ba-look">
          <g className="ba-eyes">
            <line x1={L + 4} y1={y - 10} x2={L + 2} y2={y + 1} />
            <line x1={R + 4} y1={y - 10} x2={R + 2} y2={y + 1} />
          </g>
        </g>
      );
    default:
      return (
        <>
          <g className="ba-look">
            <g className="ba-eyes">
              <line x1={L + 1} y1={y - 6} x2={L - 1} y2={y + 6} />
              <line x1={R + 1} y1={y - 6} x2={R - 1} y2={y + 6} />
            </g>
          </g>
          {e === "speaking" && <ellipse className="ba-dot ba-mouth ba-talk" cx={x - 1} cy={y + 16} rx="5" ry="3.5" />}
        </>
      );
  }
}

let seq = 0;

/**
 * Bot avatar. Static unless `animate` (blink, breathing, glance and the expression's own loop);
 * `pulse` changes trigger a one-shot hop. Animations pause offscreen / in hidden tabs and are off
 * under prefers-reduced-motion. Below 32px only the blink runs.
 */
export function BotAvatar({
  shape,
  color,
  size = 32,
  expression = "idle",
  animate = false,
  pulse,
}: {
  shape: AvatarShape;
  color: string;
  size?: number;
  expression?: Expression;
  animate?: boolean;
  /** Change this value to play the squash-and-stretch hop once (e.g. a new reply or hand-off). */
  pulse?: unknown;
}) {
  const s = SHAPES[shape] ?? SHAPES.orb;
  const [x, y] = s.eyes;
  const ref = useRef<SVGSVGElement>(null);
  // Per-instance offsets so a row of avatars never blinks in unison.
  const [offset] = useState(() => (seq++ * 1.7) % 5);
  const [shown, setShown] = useState<Expression>(expression);
  const [hop, setHop] = useState(animate && pulse !== undefined ? 1 : 0);
  const prev = useRef(expression);
  // Remember whether the reply was live, so the finishing smile plays even though animate drops now.
  const wasLive = useRef(animate);
  useEffect(() => {
    if (animate) wasLive.current = true;
  }, [animate]);
  useEffect(() => {
    // Finishing a reply earns a brief smile before settling back to the target expression.
    const was = prev.current;
    prev.current = expression;
    if ((was === "speaking" || was === "working" || was === "thinking") && expression === "idle" && wasLive.current) {
      setShown("happy");
      wasLive.current = false;
      const t = setTimeout(() => setShown("idle"), 1600);
      return () => clearTimeout(t);
    }
    setShown(expression);
  }, [expression]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pulse !== undefined) setHop((h) => h + 1);
  }, [pulse]);
  useEffect(() => {
    const el = ref.current;
    if (!animate || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      el.dataset.offscreen = entry?.isIntersecting ? "false" : "true";
    });
    io.observe(el);
    return () => io.disconnect();
  }, [animate]);
  return (
    <svg
      ref={ref}
      className="bot-avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      data-shape={shape}
      data-expr={shown}
      data-anim={animate || shown === "happy" ? (size >= 24 ? "full" : "blink") : undefined}
      style={{ ["--c" as string]: color, ["--blink-delay" as string]: `${offset}s` }}
      aria-hidden
    >
      <g className="ba-root" key={hop} data-hop={hop > 0 ? "" : undefined}>
        <g className="ba-body">{s.body}</g>
        <g className="ba-face">
          <Face e={shown} x={x} y={y} />
        </g>
      </g>
    </svg>
  );
}
