import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Shared by Markdown, ACP timeline and tool images; the thumbnail never leaves the message layout. */
export function PreviewImage({
  src,
  alt = "图片",
  title,
  imageClassName = "msg-image",
}: {
  src: string;
  alt?: string;
  title?: string;
  imageClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="image-preview-wrap">
      <button
        ref={trigger}
        type="button"
        className="image-preview-trigger"
        title={title ?? "放大预览"}
        aria-label={`放大预览：${alt || "图片"}`}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <img className={imageClassName} src={src} alt={alt} loading="lazy" />
      </button>
      {open && <ImagePreview src={src} alt={alt} trigger={trigger.current} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ImagePreview({
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
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [original, setOriginal] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = failedSource === src;
  const titleId = useId();
  const backdropPointer = useRef(false);

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
        }
      }}
      onPointerDown={(event) => {
        backdropPointer.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (backdropPointer.current && event.target === event.currentTarget) onClose();
        backdropPointer.current = false;
      }}
    >
      <div className="image-preview-panel">
        <div className="image-preview-toolbar">
          <span id={titleId}>{alt || "图片预览"}</span>
          <button type="button" className="btn" disabled={failed} onClick={() => setOriginal((value) => !value)}>
            {original ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            {original ? "适应窗口" : "原图"}
          </button>
          <button ref={close} type="button" className="icon-btn" aria-label="关闭图片预览" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <section
          className="image-preview-viewport"
          data-original={original || undefined}
          tabIndex={original ? 0 : -1}
          aria-label={original ? "图片原图，可滚动查看" : "图片预览"}
        >
          {failed ? (
            <p role="status">图片加载失败，请关闭预览后重试</p>
          ) : (
            <img src={src} alt={alt} onError={() => setFailedSource(src)} />
          )}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
