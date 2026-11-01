import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AvatarShape } from "../../server/avatars";
import type { Expression } from "./avatarState";

/** Hand-authored silhouettes in a 100×100 box; the face anchor and spacing fit each silhouette. */
const SHAPES: Record<
  AvatarShape,
  { body: ReactNode; eyes: [number, number]; eyeSpacing?: number; eyeHeight?: number }
> = {
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
        <ellipse cx="34" cy="51" rx="11" ry="14" transform="rotate(24 34 51)" />
        <ellipse cx="66" cy="51" rx="11" ry="14" transform="rotate(-24 66 51)" />
      </>
    ),
    eyes: [51, 51],
    eyeSpacing: 16,
    eyeHeight: 2.5,
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

/** Eyes (and mouth) per expression, drawn around each shape's face anchor. */
function Face({
  e,
  x,
  y,
  eyeSpacing = 9,
  eyeHeight = 6,
  mouthOffset = 16,
}: {
  e: Expression | "curious";
  x: number;
  y: number;
  eyeSpacing?: number;
  eyeHeight?: number;
  mouthOffset?: number;
}) {
  const L = x - 1 - eyeSpacing;
  const R = x - 1 + eyeSpacing;
  switch (e) {
    case "happy":
      return (
        <g className="ba-eyes">
          <path d={`M${L - 4.5} ${y + 2}Q${L - 0.5} ${y - 5} ${L + 4.5} ${y + 1}`} />
          <path d={`M${R - 4.5} ${y + 1}Q${R + 0.5} ${y - 5} ${R + 4.5} ${y + 2}`} />
        </g>
      );
    case "curious":
      return (
        <g className="ba-eyes">
          <path d={`M${L - 4} ${y + 1}Q${L} ${y - 3} ${L + 4} ${y}`} />
          <path d={`M${R + 2} ${y - eyeHeight - 1}Q${R + 4} ${y - 1} ${R - 1} ${y + eyeHeight}`} />
        </g>
      );
    case "awaiting":
      // Looking straight at you, bright round eyes and a small "hey" smile.
      return (
        <>
          <g className="ba-look">
            <g className="ba-eyes">
              <circle className="ba-dot" cx={L} cy={y} r="4.6" />
              <circle className="ba-dot" cx={R} cy={y} r="4.6" />
            </g>
          </g>
          <path
            className="ba-mouth"
            d={`M${x - 5} ${y + mouthOffset - 2}Q${x - 1} ${y + mouthOffset + 3} ${x + 3} ${y + mouthOffset - 2}`}
          />
        </>
      );
    case "sad":
      return (
        <>
          <g className="ba-eyes">
            <path d={`M${L - 1} ${y - 4}Q${L + 1} ${y} ${L + 1} ${y + 5}`} />
            <path d={`M${R + 1} ${y - 4}Q${R - 1} ${y} ${R - 1} ${y + 5}`} />
          </g>
          <path
            className="ba-mouth"
            d={`M${x - 5} ${y + mouthOffset + 2}Q${x - 1} ${y + mouthOffset - 1} ${x + 3} ${y + mouthOffset + 2}`}
          />
        </>
      );
    case "sleepy":
      return (
        <g className="ba-eyes">
          <path d={`M${L - 4} ${y + 2}Q${L} ${y + 5} ${L + 4} ${y + 2}`} />
          <path d={`M${R - 4} ${y + 2}Q${R} ${y + 5} ${R + 4} ${y + 2}`} />
        </g>
      );
    case "working":
      // Focused: eyes lowered to the work, slightly narrowed.
      return (
        <g className="ba-look">
          <g className="ba-eyes">
            <path d={`M${L - 3} ${y + 2}Q${L} ${y + 3} ${L + 3} ${y + 4}`} />
            <path d={`M${R - 3} ${y + 2}Q${R} ${y + 3} ${R + 3} ${y + 4}`} />
          </g>
        </g>
      );
    case "thinking":
      return (
        <g className="ba-look">
          <g className="ba-eyes">
            <path d={`M${L + 3} ${y - eyeHeight + 1}Q${L + 4} ${y - 1} ${L + 1} ${y + 3}`} />
            <path d={`M${R + 3} ${y - eyeHeight - 4}Q${R + 5} ${y - 3} ${R + 2} ${y + 1}`} />
          </g>
        </g>
      );
    default:
      return (
        <>
          <g className="ba-look">
            <g className="ba-eyes">
              <path d={`M${L + 1} ${y - eyeHeight}Q${L + 2} ${y} ${L - 1} ${y + eyeHeight}`} />
              <path d={`M${R + 1} ${y - eyeHeight}Q${R + 2} ${y} ${R - 1} ${y + eyeHeight}`} />
            </g>
          </g>
          {e === "speaking" && (
            <ellipse className="ba-dot ba-mouth ba-talk" cx={x - 1} cy={y + mouthOffset} rx="3.5" ry="2.8" />
          )}
        </>
      );
  }
}

let seq = 0;

/** Size tiers: full pose + motion, face + quiet loops only, or a still face with a status badge. */
export function avatarTier(size: number): "full" | "subtle" | "static" {
  if (size >= 28) return "full";
  if (size > 18) return "subtle";
  return "static";
}

/** States that must stay legible when the avatar is too small for its face to read. */
const BADGE: Partial<Record<Expression, string>> = { awaiting: "ba-badge-awaiting", sad: "ba-badge-error" };

/**
 * Bot avatar. Every state is one coordinated pose: the face (eyes / mouth) and a body motion applied
 * to the whole silhouette group, so all shapes share the same behaviour. Loops run only while
 * `animate` (a live agent) and the avatar is visible; one-shots (finish celebration, error shake,
 * `pulse` hop) play once. Motion is tiered by size (see `avatarTier`), and under
 * prefers-reduced-motion the poses stay but nothing loops. CSS keys off data-expr / data-tier / data-anim.
 */
export function BotAvatar({
  shape,
  color,
  size = 32,
  expression = "idle",
  animate = false,
  reactToHover = false,
  pulse,
}: {
  shape: AvatarShape;
  color: string;
  size?: number;
  expression?: Expression;
  animate?: boolean;
  reactToHover?: boolean;
  /** Change this value to play the squash-and-stretch hop once (e.g. a new reply or hand-off). */
  pulse?: unknown;
}) {
  const s = SHAPES[shape] ?? SHAPES.orb;
  const [x, y] = s.eyes;
  const ref = useRef<SVGSVGElement>(null);
  // Per-instance offsets so a row of avatars never blinks in unison.
  const [offset] = useState(() => (seq++ * 1.7) % 5);
  const [shown, setShown] = useState<Expression>(expression);
  // A run that just ended plays its one-shot (celebration hop / error shake) even though it is no longer live.
  const [settling, setSettling] = useState(false);
  const [hop, setHop] = useState(animate && pulse !== undefined ? 1 : 0);
  const prev = useRef(expression);
  // Remember whether the agent was live, so the finishing celebration plays even though animate drops now.
  const wasLive = useRef(animate);
  useEffect(() => {
    if (animate) wasLive.current = true;
  }, [animate]);
  useEffect(() => {
    // A finished run earns a short celebration hop with happy eyes, then settles to the target state.
    const was = prev.current;
    prev.current = expression;
    const ran = was === "speaking" || was === "working" || was === "thinking";
    if (ran && wasLive.current && (expression === "idle" || expression === "sad")) {
      wasLive.current = false;
      setShown(expression === "idle" ? "happy" : "sad");
      setSettling(true);
      const t = setTimeout(() => {
        setShown(expression);
        setSettling(false);
      }, 1400);
      return () => clearTimeout(t);
    }
    setSettling(false);
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
  const tier = avatarTier(size);
  const badge = tier === "static" ? BADGE[shown] : undefined;
  const mouthOffset = shape === "cow" ? 28 : 16;
  const face = { x, y, eyeSpacing: s.eyeSpacing, eyeHeight: s.eyeHeight, mouthOffset };
  return (
    <svg
      ref={ref}
      className="bot-avatar"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      data-shape={shape}
      data-expr={shown}
      data-tier={tier}
      data-anim={animate || settling ? "" : undefined}
      style={{ ["--c" as string]: color, ["--blink-delay" as string]: `${offset}s` }}
      aria-hidden
    >
      {/* pose: the state's resting posture (transitioned); root: its loop / one-shot (restarted by `pulse`) */}
      <g className="ba-pose">
        <g className="ba-root" key={hop} data-hop={hop > 0 ? "" : undefined}>
          <g className="ba-body">{s.body}</g>
          {/* keyed by state so the new face fades in instead of snapping */}
          <g className="ba-face" key={shown}>
            {reactToHover && !animate && shown === "idle" ? (
              <>
                <g className="ba-face-rest">
                  <Face e={shown} {...face} />
                </g>
                <g className="ba-face-curious">
                  <Face e="curious" {...face} mouthOffset={16} />
                </g>
              </>
            ) : (
              <Face e={shown} {...face} />
            )}
          </g>
        </g>
      </g>
      {badge && <circle className={`ba-badge ${badge}`} cx="84" cy="84" r="15" />}
    </svg>
  );
}
