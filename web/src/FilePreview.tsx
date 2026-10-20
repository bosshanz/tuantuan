import { Check, Copy, Download, FileText, LoaderCircle, RotateCw, WrapText, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationFile } from "../../shared/conversationFiles";
import { FILE_PREVIEW_MAX_BYTES, type FilePreviewContent, getFilePreviewType } from "../../shared/filePreview";
import { formatAttachmentSize } from "./composerAttachments";
import { readConversationFile, saveConversationFile } from "./conversationFileDownload";
import { highlightedSourceLines, staticHtmlDocument } from "./filePreviewContent";
import { translateError, useI18n } from "./i18n";
import { highlightCode } from "./ui";
import "./filePreview.css";

const HIGHLIGHT_MAX_BYTES = 100 * 1024;
const SOURCE_ROWS_MAX = 3000;
const markdownPlugins = [remarkGfm];

function canHighlight(text: string, size?: number) {
  return (
    (size ?? new TextEncoder().encode(text).length) <= HIGHLIGHT_MAX_BYTES && text.split("\n").length <= SOURCE_ROWS_MAX
  );
}

function PreviewMarkdown({ text }: { text: string }) {
  const { t } = useI18n();
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href }) => (
        <span className="file-preview-inert-link" title={href}>
          {children}
        </span>
      ),
      img: ({ alt }) => (
        <span className="file-preview-image-placeholder">{t("图片未加载：{name}", { name: alt || t("图片") })}</span>
      ),
      code: ({ children, className }) => {
        const source = String(children ?? "");
        const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
        const highlighted = canHighlight(source) ? highlightCode(source, language) : null;
        return highlighted ? (
          <code
            className={className}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes source; only its registered token spans are inserted
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className={className}>{children}</code>
        );
      },
    }),
    [t],
  );
  return (
    <div className="md file-preview-markdown">
      <Markdown remarkPlugins={markdownPlugins} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

function SourceView({ content, wrap }: { content: FilePreviewContent; wrap: boolean }) {
  const lineCount = useMemo(() => content.text.split("\n").length, [content.text]);
  const rows = useMemo(() => {
    if (lineCount > SOURCE_ROWS_MAX) return null;
    const language = content.kind === "html" ? "xml" : content.language;
    return highlightedSourceLines(
      content.text,
      canHighlight(content.text, content.size) ? highlightCode(content.text, language) : null,
    );
  }, [content, lineCount]);
  const { t } = useI18n();
  const numbers = useMemo(
    () => (rows ? "" : Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")),
    [lineCount, rows],
  );
  return (
    <section
      className="file-preview-source"
      data-wrap={(wrap && !!rows) || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: source region receives focus for keyboard scrolling
      tabIndex={0}
      aria-label={t("文件源码")}
    >
      {rows ? (
        <pre className="file-preview-code">
          <code>
            {rows.map((tokens, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: source lines are immutable within a preview response
              <span className="file-preview-code-line" key={index}>
                <span className="file-preview-line-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="file-preview-line-content">
                  {tokens.length
                    ? tokens.map((token, tokenIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: highlight tokens are immutable within a source line
                        <span key={tokenIndex} className={token.className}>
                          {token.text}
                        </span>
                      ))
                    : "\u200b"}
                </span>
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <div className="file-preview-plain-source">
          <pre className="file-preview-number-gutter" aria-hidden="true">
            {numbers}
          </pre>
          <pre>
            <code>{content.text || "\u200b"}</code>
          </pre>
        </div>
      )}
    </section>
  );
}

export function FilePreview(props: {
  roomId: string;
  file: ConversationFile;
  trigger: HTMLButtonElement;
  fallbackTrigger?: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { file, roomId } = props;
  const type = getFilePreviewType(file.name, file.mimeType);
  const [view, setView] = useState<"render" | "source">(
    type?.kind === "markdown" || type?.kind === "html" ? "render" : "source",
  );
  const [content, setContent] = useState<FilePreviewContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [copyPending, setCopyPending] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
    reason?: string;
    name?: string;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const downloadRequest = useRef<AbortController | null>(null);
  const copying = useRef(false);
  const backdropPointer = useRef(false);
  const titleId = useId();
  const pathId = useId();
  const manyLines = content ? content.text.split("\n").length > SOURCE_ROWS_MAX : false;
  const source = content && (view === "source" || !["markdown", "html"].includes(content.kind));
  const html = useMemo(() => {
    if (content?.kind !== "html" || view !== "render") return { document: "", error: null };
    try {
      return { document: staticHtmlDocument(content.text), error: null };
    } catch (failure) {
      return { document: "", error: failure instanceof Error ? failure.message : String(failure) };
    }
  }, [content, view]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    alive.current = true;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      downloadRequest.current?.abort();
      element.close();
      const target = props.trigger.isConnected ? props.trigger : props.fallbackTrigger;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [props.trigger, props.fallbackTrigger]);

  useEffect(() => {
    if (!html.document) return;
    const frame = iframe.current;
    if (!frame) return;
    let timer = 0;
    const reclaimFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        // Opaque sandbox frames cannot forward Escape. Keep keyboard focus in the modal;
        // pointer input and wheel scrolling inside the static document remain available.
        if (document.activeElement === frame && document.hasFocus()) close.current?.focus({ preventScroll: true });
      }, 0);
    };
    window.addEventListener("blur", reclaimFocus);
    frame.addEventListener("focus", reclaimFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", reclaimFocus);
      frame.removeEventListener("focus", reclaimFocus);
    };
  }, [html.document]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry intentionally reloads this exact persisted file
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setContent(null);
    setError(null);
    const load = async () => {
      try {
        const response = await fetch(
          `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.id)}/preview`,
          { signal: controller.signal },
        );
        const data = (await response.json()) as FilePreviewContent & { error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (
          !["markdown", "html", "code", "text"].includes(data.kind) ||
          typeof data.text !== "string" ||
          typeof data.size !== "number"
        )
          throw new Error("文件预览内容无效");
        if (data.size > FILE_PREVIEW_MAX_BYTES || new TextEncoder().encode(data.text).length > FILE_PREVIEW_MAX_BYTES)
          throw new Error("文件超过 1 MiB 预览上限");
        if (!controller.signal.aborted) setContent(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [roomId, file.id, attempt]);

  const copy = async () => {
    if (!content || copying.current) return;
    copying.current = true;
    setCopyPending(true);
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板");
      await navigator.clipboard.writeText(content.text);
      if (alive.current) setFeedback({ kind: "success", text: "已复制源码" });
    } catch (failure) {
      if (alive.current)
        setFeedback({
          kind: "error",
          text: "复制失败：{reason}。请重试。",
          reason: failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      copying.current = false;
      if (alive.current) setCopyPending(false);
    }
  };
  const download = async () => {
    if (downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloadPending(true);
    setFeedback(null);
    try {
      const bytes = await readConversationFile(roomId, file, controller.signal);
      if (!controller.signal.aborted) {
        saveConversationFile(bytes, file.name);
        setFeedback({ kind: "success", text: "已开始下载 {name}", name: file.name });
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setFeedback({
          kind: "error",
          text: "下载失败：{reason}",
          reason: failure instanceof Error ? failure.message : String(failure),
        });
    } finally {
      if (downloadRequest.current === controller) downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloadPending(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialog}
      className="file-preview"
      aria-label={t("文件预览")}
      aria-describedby={pathId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']"),
        ];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onPointerDown={(event) => {
        backdropPointer.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (backdropPointer.current && event.target === event.currentTarget) props.onClose();
        backdropPointer.current = false;
      }}
    >
      <div className="file-preview-panel">
        <header className="file-preview-head">
          <FileText size={22} aria-hidden="true" />
          <div className="file-preview-heading">
            <h2 id={titleId} title={file.name}>
              {file.name}
            </h2>
            <p id={pathId} title={file.path}>
              {file.path || t(file.source === "attachment" ? "用户附件" : "Agent 文件")}
            </p>
          </div>
          <div className="file-preview-head-actions">
            <button
              type="button"
              className="btn ghost icon"
              disabled={downloadPending || file.state !== "available"}
              aria-label={t("下载文件 {name}", { name: file.name })}
              title={t("下载")}
              onClick={() => void download()}
            >
              {downloadPending ? (
                <LoaderCircle size={18} className="file-preview-spin" aria-hidden="true" />
              ) : (
                <Download size={18} aria-hidden="true" />
              )}
            </button>
            <button
              ref={close}
              type="button"
              className="btn ghost icon"
              aria-label={t("关闭文件预览")}
              onClick={props.onClose}
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="file-preview-toolbar">
          <fieldset className="file-preview-modes" aria-label={t("预览模式")}>
            {(type?.kind === "markdown" || type?.kind === "html") && (
              <button
                type="button"
                className="btn ghost sm"
                aria-pressed={view === "render"}
                onClick={() => setView("render")}
              >
                {type.kind === "markdown" ? t("阅读视图") : t("静态页面")}
              </button>
            )}
            <button
              type="button"
              className="btn ghost sm"
              aria-pressed={view === "source"}
              onClick={() => setView("source")}
            >
              {t("源码")}
            </button>
          </fieldset>
          <div className="file-preview-source-actions">
            {view === "source" && (
              <button
                type="button"
                className="btn ghost sm"
                aria-pressed={wrap && !manyLines}
                disabled={manyLines}
                onClick={() => setWrap((previous) => !previous)}
              >
                <WrapText size={15} aria-hidden="true" />
                {t("自动换行")}
              </button>
            )}
            <button
              type="button"
              className="btn ghost sm"
              disabled={!content || copyPending}
              onClick={() => void copy()}
            >
              {copyPending ? (
                <LoaderCircle size={15} className="file-preview-spin" aria-hidden="true" />
              ) : feedback?.text === "已复制源码" ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {t("复制源码")}
            </button>
          </div>
        </div>
        {feedback && (
          <div
            className="file-preview-feedback"
            data-kind={feedback.kind}
            role={feedback.kind === "error" ? "alert" : "status"}
          >
            {t(feedback.text, { reason: translateError(feedback.reason ?? ""), name: feedback.name ?? "" })}
          </div>
        )}
        <div className="file-preview-content" aria-busy={loading}>
          {loading ? (
            <div className="file-preview-status" role="status">
              <LoaderCircle size={22} className="file-preview-spin" aria-hidden="true" />
              <p>{t("正在加载预览…")}</p>
            </div>
          ) : error ? (
            <div className="file-preview-status file-preview-error" role="alert">
              <p>{t("预览失败：{reason}", { reason: translateError(error) })}</p>
              <button type="button" className="btn sm" onClick={() => setAttempt((previous) => previous + 1)}>
                <RotateCw size={15} aria-hidden="true" />
                {t("重试预览")}
              </button>
            </div>
          ) : (
            content &&
            (source ? (
              <SourceView content={content} wrap={wrap} />
            ) : content.kind === "markdown" ? (
              <PreviewMarkdown text={content.text} />
            ) : html.error ? (
              <div className="file-preview-status file-preview-error" role="alert">
                <p>{t("预览失败：{reason}", { reason: translateError(html.error) })}</p>
                <button type="button" className="btn sm" onClick={() => setView("source")}>
                  {t("查看源码")}
                </button>
              </div>
            ) : (
              <iframe
                ref={iframe}
                className="file-preview-html"
                title={t("HTML 静态预览")}
                sandbox=""
                tabIndex={-1}
                referrerPolicy="no-referrer"
                srcDoc={html.document}
              />
            ))
          )}
        </div>
        <footer className="file-preview-foot">
          <span>
            {content?.kind === "html" && view === "render"
              ? t("单文件静态预览；脚本和外部资源未加载")
              : content?.kind === "markdown" && view === "render"
                ? t("Markdown 预览不加载图片，链接不可跳转")
                : manyLines
                  ? t("行数较多，已关闭高亮和自动换行")
                  : content && !canHighlight(content.text, content.size)
                    ? t("文件较大，已关闭语法高亮")
                    : t("预览最多支持 1 MiB 的 UTF-8 文本")}
          </span>
          <span>
            {content ? formatAttachmentSize(content.size) : file.size === null ? "" : formatAttachmentSize(file.size)}
            <kbd>Esc</kbd> {t("关闭")}
          </span>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
