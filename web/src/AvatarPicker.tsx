import { useEffect, useRef, useState } from "react";
import {
  AVATAR_COLORS,
  type AvatarShape,
  isSelectableAvatarShape,
  SELECTABLE_AVATAR_SHAPES,
  SHAPE_LABEL,
} from "../../server/avatars";
import { EXPRESSIONS, type Expression } from "./avatarState";
import { BotAvatar } from "./BotAvatar";
import { useI18n } from "./i18n";
import { usePresence } from "./motion";

export function nextPickerIndex(
  index: number,
  key: string,
  total: number,
  cols: number,
  hasHeaderSlot = false,
): number | null {
  if (total <= 0 || index < 0 || index >= total) return null;
  if (key === "ArrowRight") return (index + 1) % total;
  if (key === "ArrowLeft") return (index - 1 + total) % total;
  if (!hasHeaderSlot) {
    if (key === "ArrowDown") return (index + cols) % total;
    if (key === "ArrowUp") return (index - cols + total) % total;
    return null;
  }
  const gridCount = total - 1;
  if (gridCount <= 0) return 0;
  const lastRowStart = 1 + Math.floor((gridCount - 1) / cols) * cols;
  if (key === "ArrowDown") {
    if (index === 0) return 1;
    return index + cols < total ? index + cols : 0;
  }
  if (key === "ArrowUp") {
    if (index === 0) return lastRowStart;
    return index - cols >= 1 ? index - cols : 0;
  }
  return null;
}

/** Radio-group keyboard model: arrows move within the group, Tab leaves it. */
function arrowNav(e: React.KeyboardEvent<HTMLDivElement>, cols: number, hasHeaderSlot = false) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = nextPickerIndex(i, e.key, items.length, cols, hasHeaderSlot);
  if (nextIndex === null) return;
  e.preventDefault();
  const next = items[nextIndex];
  next?.focus();
  next?.click();
}

export function AvatarPicker(props: {
  shape: AvatarShape;
  color: string;
  onChange: (shape: AvatarShape, color: string) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
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
  // Keep a retired saved shape visible while the popover stays open so clicking options does not resize it or trap edits.
  const [pinnedRetired, setPinnedRetired] = useState<AvatarShape | null>(() =>
    isSelectableAvatarShape(props.shape) ? null : props.shape,
  );
  useEffect(() => {
    if (!open) {
      setPinnedRetired(isSelectableAvatarShape(props.shape) ? null : props.shape);
      return;
    }
    if (!isSelectableAvatarShape(props.shape)) setPinnedRetired(props.shape);
  }, [open, props.shape]);
  const retired = isSelectableAvatarShape(props.shape) ? pinnedRetired : props.shape;
  const focusShape = props.shape;
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
  const shapeOpt = (s: AvatarShape) => (
    // biome-ignore lint/a11y/useSemanticElements: visual swatch radios; native radio inputs cannot render the shape
    <button
      key={s}
      type="button"
      role="radio"
      aria-checked={props.shape === s}
      aria-label={t(SHAPE_LABEL[s])}
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
  );
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
        aria-label={t("编辑头像")}
        title={t("编辑头像")}
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
          followPointer
          expression={hover ? (EXPRESSIONS[tick % EXPRESSIONS.length] as Expression) : "idle"}
        />
      </button>
      {pop.mounted && (
        <div className="avatar-pop" data-state={pop.state} role="dialog" aria-label={t("编辑头像")}>
          <div className="avatar-pop-head">
            <h4>{t("头像")}</h4>
            <button type="button" className="btn ghost sm" onClick={props.onReset}>
              {t("重置")}
            </button>
          </div>
          <div role="radiogroup" aria-label={t("形状")} onKeyDown={(e) => arrowNav(e, 5, !!retired)}>
            {retired && <div className="shape-current">{shapeOpt(retired)}</div>}
            <div className="shape-grid">{SELECTABLE_AVATAR_SHAPES.map((s) => shapeOpt(s))}</div>
          </div>
          <div className="color-grid" role="radiogroup" aria-label={t("颜色")} onKeyDown={(e) => arrowNav(e, 7)}>
            {AVATAR_COLORS.map((c) => (
              // biome-ignore lint/a11y/useSemanticElements: visual swatch radios; native radio inputs cannot render the colour
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={props.color.toLowerCase() === c}
                aria-label={t("颜色 {color}", { color: c })}
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
