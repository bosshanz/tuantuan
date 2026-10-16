import { Check, Copy, Hash, ListTree, MoreHorizontal, Reply } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "./api";
import { Popover } from "./ConfigChips";
import "./MessageActions.css";

type Feedback = { kind: "success" | "error"; text: string } | null;

/** Message operations use the stored body/ID; rendered thoughts, tools and quoted context are never copied. */
export function MessageActions(props: {
  message: Message;
  onQuote?: () => void;
  quoteDisabled?: boolean;
  onDetails?: () => void;
  selected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const copying = useRef(false);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLFieldSetElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const copy = async (kind: "content" | "id") => {
    if (copying.current || (kind === "content" && !props.message.content.trim())) return;
    copying.current = true;
    setPending(true);
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板");
      await navigator.clipboard.writeText(kind === "content" ? props.message.content : props.message.id);
      setFeedback({ kind: "success", text: kind === "content" ? "已复制内容" : "已复制消息 ID" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setFeedback({ kind: "error", text: `复制失败：${reason}。请重试。` });
    } finally {
      copying.current = false;
      setPending(false);
    }
  };

  return (
    <div className="message-actions" data-open={open || undefined}>
      {props.onQuote && (
        <button
          type="button"
          className="message-action-btn"
          aria-label="引用回复"
          title="引用回复"
          disabled={props.quoteDisabled}
          onClick={() => {
            close();
            props.onQuote?.();
          }}
        >
          <Reply size={16} aria-hidden />
        </button>
      )}
      <button
        ref={more}
        type="button"
        className="message-action-btn message-more"
        aria-label="更多消息操作"
        title="更多消息操作"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {open && (
        <Popover
          anchor={more.current}
          onClose={close}
          label="消息操作"
          width={200}
          align={props.message.senderKind === "human" ? "end" : "start"}
        >
          <fieldset
            ref={menu}
            aria-label="消息操作选项"
            className="message-actions-menu"
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || (!event.currentTarget.contains(next) && !more.current?.contains(next)))
                close();
            }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  'button:not(:disabled):not([aria-disabled="true"])',
                ),
              ];
              if (!buttons.length) return;
              event.preventDefault();
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
              buttons[next]?.focus();
            }}
          >
            <button
              type="button"
              className="pop-item"
              disabled={!props.message.content.trim()}
              aria-disabled={pending}
              aria-busy={pending}
              onClick={() => void copy("content")}
            >
              <Copy size={15} aria-hidden />
              <span>复制内容</span>
            </button>
            <button
              type="button"
              className="pop-item"
              aria-disabled={pending}
              aria-busy={pending}
              onClick={() => void copy("id")}
            >
              <Hash size={15} aria-hidden />
              <span>复制消息 ID</span>
            </button>
            {props.onDetails && (
              <button
                type="button"
                className="pop-item"
                aria-pressed={props.selected}
                data-shot="expand"
                onClick={() => {
                  close();
                  more.current?.focus();
                  props.onDetails?.();
                }}
              >
                <ListTree size={15} aria-hidden />
                <span>查看详情</span>
              </button>
            )}
            {pending && (
              <div className="message-action-feedback" role="status">
                正在复制…
              </div>
            )}
            {feedback && (
              <div
                className="message-action-feedback"
                data-error={feedback.kind === "error" || undefined}
                role={feedback.kind === "error" ? "alert" : "status"}
              >
                {feedback.kind === "success" && <Check size={13} aria-hidden />}
                {feedback.text}
              </div>
            )}
          </fieldset>
        </Popover>
      )}
    </div>
  );
}
