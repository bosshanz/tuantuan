import { useEffect, useRef, useState } from "react";
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarShape, SHAPE_LABEL } from "../../server/avatars";
import { BotAvatar } from "./BotAvatar";

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
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('.shape-opt[aria-checked="true"]')?.focus();
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
      onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), close())}
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
      >
        <BotAvatar shape={props.shape} color={props.color} size={56} />
      </button>
      {open && (
        <div className="avatar-pop" role="dialog" aria-label="编辑头像">
          <div className="avatar-pop-head">
            <h4>头像</h4>
            <button type="button" className="btn ghost sm" onClick={props.onReset}>
              重置
            </button>
          </div>
          <div className="shape-grid" role="radiogroup" aria-label="形状" onKeyDown={(e) => arrowNav(e, 5)}>
            {AVATAR_SHAPES.map((s) => (
              // biome-ignore lint/a11y/useSemanticElements: visual swatch radios; native radio inputs cannot render the shape
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={props.shape === s}
                aria-label={SHAPE_LABEL[s]}
                tabIndex={props.shape === s ? 0 : -1}
                className="shape-opt"
                onClick={() => props.onChange(s, props.color)}
              >
                <BotAvatar shape={s} color={props.color} size={36} />
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
