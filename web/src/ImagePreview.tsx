import { Maximize2, Minimize2, Minus, Plus, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";

/** Shared by Markdown, ACP timeline and tool images; the thumbnail never leaves the message layout. */
export function PreviewImage({
  src,
  alt,
  title,
  imageClassName = "msg-image",
}: {
  src: string;
  alt?: string;
  title?: string;
  imageClassName?: string;
}) {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const imageAlt = alt ?? tr("图片");
  return (
    <span className="image-preview-wrap">
      <button
        ref={trigger}
        type="button"
        className="image-preview-trigger"
        title={title ?? tr("放大预览")}
        aria-label={tr("放大预览：{name}", { name: imageAlt || tr("图片") })}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <img className={imageClassName} src={src} alt={imageAlt} loading="lazy" />
      </button>
      {open && <ImagePreview src={src} alt={imageAlt} trigger={trigger.current} onClose={() => setOpen(false)} />}
    </span>
  );
}

type Size = { width: number; height: number };
type View = { scale: number | null; x: number; y: number };
type ImageState = { source: string; attempt: number } & (
  | { status: "loaded"; width: number; height: number }
  | { status: "failed" }
);
const MAX_SCALE = 5;
const ZOOM_STEP = 1.25;
const EMPTY_SIZE: Size = { width: 0, height: 0 };
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

function boundedPan(x: number, y: number, scale: number, image: Size, viewport: Size) {
  return {
    x: clamp(x, Math.max(0, (image.width * scale - viewport.width) / 2)),
    y: clamp(y, Math.max(0, (image.height * scale - viewport.height) / 2)),
  };
}

export function ImagePreview({
  src,
  alt,
  trigger,
  onClose,
}: {
  src: string;
  alt: string;
  trigger: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ scale: null, x: 0, y: 0 });
  const [imageState, setImageState] = useState<ImageState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const titleId = useId();
  const backdropPointer = useRef(false);
  const imagePointer = useRef(false);
  const pointerStart = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const current = imageState?.source === src && imageState.attempt === attempt ? imageState : null;
  const failed = current?.status === "failed";
  const natural = current?.status === "loaded" ? current : EMPTY_SIZE;
  const ready = natural.width > 0 && natural.height > 0 && viewportSize.width > 0 && viewportSize.height > 0;
  const fitScale = ready ? Math.min(1, viewportSize.width / natural.width, viewportSize.height / natural.height) : 1;
  // Very long images must remain able to fit, even when that is less than 10%.
  const minScale = Math.min(0.1, fitScale);
  const scale = view.scale ?? fitScale;
  const pan = boundedPan(view.x, view.y, scale, natural, viewportSize);
  const pannable =
    ready && (natural.width * scale > viewportSize.width || natural.height * scale > viewportSize.height);
  const original = view.scale === 1;
  const isBackdrop = (target: EventTarget | null) =>
    target === dialog.current || target === panel.current || target === viewport.current;

  const constrainView = useCallback(
    (next: View) => {
      const nextScale = next.scale === null ? fitScale : Math.max(minScale, Math.min(MAX_SCALE, next.scale));
      const nextPan = boundedPan(next.x, next.y, nextScale, natural, viewportSize);
      const nextValue = { scale: next.scale === null ? null : nextScale, ...nextPan };
      return nextValue.scale === next.scale && nextValue.x === next.x && nextValue.y === next.y ? next : nextValue;
    },
    [fitScale, minScale, natural, viewportSize],
  );
  const zoomTo = useCallback(
    (requested: number | ((previous: number) => number), point = { x: 0, y: 0 }) => {
      if (!ready) return;
      setView((previous) => {
        const previousScale = previous.scale ?? fitScale;
        const nextScale = Math.max(
          minScale,
          Math.min(MAX_SCALE, typeof requested === "number" ? requested : requested(previousScale)),
        );
        if (typeof requested === "function" && nextScale === previousScale) return previous;
        const previousPan = boundedPan(previous.x, previous.y, previousScale, natural, viewportSize);
        const ratio = nextScale / previousScale;
        return constrainView({
          scale: nextScale,
          x: point.x - (point.x - previousPan.x) * ratio,
          y: point.y - (point.y - previousPan.y) * ratio,
        });
      });
    },
    [ready, fitScale, minScale, natural, viewportSize, constrainView],
  );
  const fit = () => {
    if (ready) setView({ scale: null, x: 0, y: 0 });
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = (width: number, height: number) =>
      setViewportSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    update(element.clientWidth, element.clientHeight);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ready) setView(constrainView);
  }, [ready, constrainView]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      zoomTo((previous) => previous * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      });
    };
    // React wheel listeners are passive; this listener keeps zoom from scrolling the page.
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoomTo]);

  const finishDrag = (pointerId: number) => {
    if (drag.current?.pointerId !== pointerId) return;
    suppressClick.current = drag.current.moved;
    drag.current = null;
    setDragging(false);
    if (viewport.current?.hasPointerCapture(pointerId)) viewport.current.releasePointerCapture(pointerId);
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="image-preview"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        // Keep application-level shortcuts out of the modal, including Escape from parent dialogs.
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']"),
          ];
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus({ preventScroll: true });
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus({ preventScroll: true });
          }
        } else if (ready && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 160 : 64;
          setView((previous) =>
            constrainView({
              ...previous,
              x: previous.x + (event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0),
              y: previous.y + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
            }),
          );
        } else if (event.key === "+" || event.key === "=" || event.key === "-") {
          event.preventDefault();
          zoomTo((previous) => previous * (event.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP));
        }
      }}
      onPointerDown={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY };
        suppressClick.current = false;
        imagePointer.current = event.target === image.current;
        backdropPointer.current = event.button === 0 && isBackdrop(event.target);
      }}
      onPointerUp={(event) => {
        if (Math.hypot(event.clientX - pointerStart.current.x, event.clientY - pointerStart.current.y) > 4)
          backdropPointer.current = false;
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!suppressClick.current && backdropPointer.current && isBackdrop(event.target)) onClose();
        backdropPointer.current = false;
      }}
    >
      <div ref={panel} className="image-preview-panel">
        <div className="image-preview-toolbar">
          <div className="image-preview-heading">
            <span id={titleId} className="image-preview-title">
              {alt || tr("图片预览")}
            </span>
            {current?.status === "loaded" && (
              <span className="image-preview-dimensions">
                {current.width} × {current.height}
              </span>
            )}
          </div>
          <button
            ref={close}
            type="button"
            className="image-preview-action image-preview-close"
            aria-label={tr("关闭图片预览")}
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <section
          ref={viewport}
          className="image-preview-viewport"
          data-original={original || undefined}
          data-pannable={pannable || undefined}
          data-dragging={dragging || undefined}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The image viewport receives focus for keyboard panning.
          tabIndex={0}
          aria-label={tr("图片预览，可缩放和拖动")}
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target !== image.current) return;
            viewport.current?.focus({ preventScroll: true });
            if (!pannable) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              ...pan,
              moved: false,
            };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (!active || active.pointerId !== event.pointerId || !ready) return;
            const dx = event.clientX - active.startX;
            const dy = event.clientY - active.startY;
            if (Math.hypot(dx, dy) > 4) active.moved = true;
            if (active.moved) setView((previous) => constrainView({ ...previous, x: active.x + dx, y: active.y + dy }));
          }}
          onPointerUp={(event) => finishDrag(event.pointerId)}
          onPointerCancel={(event) => {
            finishDrag(event.pointerId);
            backdropPointer.current = false;
          }}
          onLostPointerCapture={(event) => finishDrag(event.pointerId)}
          onDoubleClick={(event) => {
            // Pointer capture can retarget an image double-click to the viewport.
            if (!imagePointer.current || suppressClick.current || !ready) return;
            event.preventDefault();
            event.stopPropagation();
            if (view.scale !== null) fit();
            else {
              const bounds = event.currentTarget.getBoundingClientRect();
              zoomTo(fitScale === 1 ? 2 : 1, {
                x: event.clientX - bounds.left - bounds.width / 2,
                y: event.clientY - bounds.top - bounds.height / 2,
              });
            }
          }}
        >
          <img
            key={`${attempt}:${src}`}
            ref={image}
            src={src}
            alt={alt}
            draggable={false}
            style={{
              width: natural.width * scale,
              height: natural.height * scale,
              visibility: ready ? "visible" : "hidden",
              transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            }}
            onLoad={(event) => {
              if (event.currentTarget !== image.current) return;
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setImageState(
                width > 0 && height > 0
                  ? { source: src, attempt, status: "loaded", width, height }
                  : { source: src, attempt, status: "failed" },
              );
            }}
            onError={(event) => {
              if (event.currentTarget === image.current) setImageState({ source: src, attempt, status: "failed" });
            }}
          />
          {!ready && (
            <div className="image-preview-status" role="status">
              <p>{failed ? tr("图片加载失败") : tr("正在加载图片…")}</p>
              {failed && (
                <button
                  type="button"
                  className="image-preview-action image-preview-action-label"
                  onClick={() => {
                    viewport.current?.focus({ preventScroll: true });
                    setAttempt((previous) => previous + 1);
                  }}
                >
                  <RotateCw size={16} aria-hidden="true" />
                  {tr("重试")}
                </button>
              )}
            </div>
          )}
        </section>
        <div className="image-preview-footer">
          {/* Native disabled would drop focus while a theme redraw replaces the image source. */}
          <fieldset className="image-preview-controls" aria-label={tr("图片缩放控制")}>
            <div className="image-preview-zoom">
              <button
                type="button"
                className="image-preview-action"
                aria-label={tr("缩小")}
                title={tr("缩小")}
                aria-disabled={!ready || scale <= minScale}
                onClick={() => zoomTo((previous) => previous / ZOOM_STEP)}
              >
                <Minus size={18} aria-hidden="true" />
              </button>
              <output className="image-preview-scale" aria-label={tr("缩放比例")}>
                {ready
                  ? new Intl.NumberFormat(locale, {
                      style: "percent",
                      maximumFractionDigits: scale < 0.01 ? 2 : scale < 0.1 ? 1 : 0,
                    }).format(scale)
                  : "—"}
              </output>
              <button
                type="button"
                className="image-preview-action"
                aria-label={tr("放大")}
                title={tr("放大")}
                aria-disabled={!ready || scale >= MAX_SCALE}
                onClick={() => zoomTo((previous) => previous * ZOOM_STEP)}
              >
                <Plus size={18} aria-hidden="true" />
              </button>
            </div>
            <span className="image-preview-divider" aria-hidden="true" />
            <div className="image-preview-modes">
              <button
                type="button"
                className="image-preview-action image-preview-action-label"
                aria-pressed={view.scale === null}
                aria-disabled={!ready}
                onClick={fit}
              >
                <Minimize2 size={16} aria-hidden="true" />
                {tr("适应窗口")}
              </button>
              <button
                type="button"
                className="image-preview-action image-preview-action-label"
                aria-pressed={original}
                aria-disabled={!ready}
                onClick={() => zoomTo(1)}
              >
                <Maximize2 size={16} aria-hidden="true" />
                {tr("原图")}
              </button>
            </div>
          </fieldset>
          <p className="image-preview-hint">{tr("滚轮缩放 · 双击切换 · 拖动或方向键平移 · Esc 关闭")}</p>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
