import { useEffect, useRef, useState } from "react";
import { AVATAR_COLORS, type AvatarShape, SELECTABLE_AVATAR_SHAPES, SHAPE_LABEL } from "../../server/avatars";
import { EXPRESSIONS, type Expression } from "./avatarState";
import { BotAvatar } from "./BotAvatar";
import { usePresence } from "./motion";

/** Radio-group keyboard model: arrows move within the group, Tab leaves it. */
function arrowNav(e: React.KeyboardEvent<HTMLDivElement>, cols: number) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
  if (!d) return;
  e.preventDefault();
  const next = items[(i + d + items.length) % items.length];
  next?.focus();
  next?.click();
}

export function AvatarPicker(props: {
  shape: AvatarShape;
  color: string;
  onChange: (shape: AvatarShape, color: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, 140);
  // Hovering the preview cycles through the expressions so the choice is seen alive.
  const [hover, setHover] = useState(false);
  const [tick, setTick] = useState(0);
  const [hoverShape, setHoverShape] = useState<AvatarShape | null>(null);
  useEffect(() => {
    if (!hover) return;
    const t = setInterval(() => setTick((n) => n + 1), 1400);
    return () => clearInterval(t);
  }, [hover]);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusShape = SELECTABLE_AVATAR_SHAPES.find((s) => s === props.shape) ?? SELECTABLE_AVATAR_SHAPES[0];
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('.shape-opt[tabindex="0"]')?.focus();
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the popover; controls inside are buttons
    <div
      className="avatar-edit"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="avatar-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="编辑头像"
        title="编辑头像"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => {
          setHover(false);
          setTick(0);
        }}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <BotAvatar
          shape={props.shape}
          color={props.color}
          size={56}
          animate
          expression={hover ? (EXPRESSIONS[tick % EXPRESSIONS.length] as Expression) : "idle"}
        />
      </button>
      {pop.mounted && (
        <div className="avatar-pop" data-state={pop.state} role="dialog" aria-label="编辑头像">
          <div className="avatar-pop-head">
            <h4>头像</h4>
            <button type="button" className="btn ghost sm" onClick={props.onReset}>
              重置
            </button>
          </div>
          <div className="shape-grid" role="radiogroup" aria-label="形状" onKeyDown={(e) => arrowNav(e, 5)}>
            {SELECTABLE_AVATAR_SHAPES.map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: visual swatch radios; native radio inputs cannot render the shape
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={props.shape === s}
                aria-label={SHAPE_LABEL[s]}
                tabIndex={focusShape === s ? 0 : -1}
                className="shape-opt"
                onClick={() => props.onChange(s, props.color)}
                onMouseEnter={() => setHoverShape(s)}
                onMouseLeave={() => setHoverShape(null)}
              >
                <BotAvatar
                  shape={s}
                  color={props.color}
                  size={36}
                  animate={hoverShape === s}
                  expression={hoverShape === s ? "happy" : "idle"}
                  pulse={hoverShape === s ? s : undefined}
                />
              </button>
            ))}
          </div>
          <div className="color-grid" role="radiogroup" aria-label="颜色" onKeyDown={(e) => arrowNav(e, 7)}>
            {AVATAR_COLORS.map((c) => (
              // biome-ignore lint/a11y/useSemanticElements: visual swatch radios; native radio inputs cannot render the colour
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={props.color.toLowerCase() === c}
                aria-label={`颜色 ${c}`}
                tabIndex={
                  props.color.toLowerCase() === c ||
                  (!AVATAR_COLORS.some((x) => x === props.color.toLowerCase()) && c === AVATAR_COLORS[0])
                    ? 0
                    : -1
                }
                className="color-opt"
                style={{ background: c }}
                onClick={() => props.onChange(props.shape, c)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
