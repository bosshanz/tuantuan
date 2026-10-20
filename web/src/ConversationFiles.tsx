import { ArrowUpRight, Download, File, FolderOpen, Image, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IMAGE_MIME_TYPES } from "../../shared/attachments";
import {
  CONVERSATION_FILE_DOWNLOAD_MAX_BYTES,
  type ConversationFile,
  type ConversationFilesPage,
} from "../../shared/conversationFiles";
import { api } from "./api";
import { formatAttachmentSize } from "./composerAttachments";
import { ImagePreview } from "./ImagePreview";
import { intlLocale, translateError, useI18n } from "./i18n";
import "./conversationFiles.css";

interface FilesState extends ConversationFilesPage {
  loading: boolean;
  error: string | null;
  failedPage: "first" | "more" | null;
}

const emptyFiles: FilesState = {
  items: [],
  nextCursor: null,
  loading: true,
  error: null,
  failedPage: null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConversationFiles(props: {
  roomId: string;
  roomName: string;
  revision: string;
  onClose: () => void;
  onSelectMessage: (messageId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [files, setFiles] = useState<FilesState>(emptyFiles);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<Record<string, "preview" | "download">>({});
  const [actionErrors, setActionErrors] = useState<Record<string, { action: "preview" | "download"; reason: string }>>(
    {},
  );
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ url: string; name: string; trigger: HTMLButtonElement } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(document.activeElement);
  const generation = useRef(0);
  const requestInFlight = useRef(false);
  const actions = useRef(new Map<string, AbortController>());
  const backdropPointer = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const roomId = props.roomId;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    const activeActions = actions.current;
    const previous = returnFocus.current;
    return () => {
      ++generation.current;
      for (const controller of activeActions.values()) controller.abort();
      activeActions.clear();
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and completed-message revision restart the first page
  useEffect(() => {
    const token = ++generation.current;
    requestInFlight.current = true;
    setFiles((previous) => ({ ...previous, loading: true, error: null, failedPage: null }));
    api<ConversationFilesPage>("GET", `/api/rooms/${encodeURIComponent(roomId)}/files?limit=30`)
      .then((page) => {
        if (generation.current === token) setFiles({ ...page, loading: false, error: null, failedPage: null });
      })
      .catch((error: unknown) => {
        if (generation.current === token)
          setFiles((previous) => ({ ...previous, loading: false, error: errorText(error), failedPage: "first" }));
      })
      .finally(() => {
        if (generation.current === token) requestInFlight.current = false;
      });
    return () => {
      ++generation.current;
    };
  }, [roomId, refresh, props.revision]);

  const loadMore = async () => {
    if (!files.nextCursor || requestInFlight.current) return;
    const token = generation.current;
    requestInFlight.current = true;
    setFiles((previous) => ({ ...previous, loading: true, error: null, failedPage: null }));
    const params = new URLSearchParams({ limit: "30", cursor: files.nextCursor });
    try {
      const page = await api<ConversationFilesPage>("GET", `/api/rooms/${encodeURIComponent(roomId)}/files?${params}`);
      if (generation.current !== token) return;
      setFiles((previous) => {
        const seen = new Set(previous.items.map((item) => item.id));
        return {
          items: [...previous.items, ...page.items.filter((item) => !seen.has(item.id))],
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
          failedPage: null,
        };
      });
    } catch (error) {
      if (generation.current === token)
        setFiles((previous) => ({ ...previous, loading: false, error: errorText(error), failedPage: "more" }));
    } finally {
      if (generation.current === token) requestInFlight.current = false;
    }
  };

  const openFile = async (file: ConversationFile, action: "preview" | "download", trigger: HTMLButtonElement) => {
    if (!file.downloadUrl || file.state !== "available" || actions.current.has(file.id)) return;
    const controller = new AbortController();
    actions.current.set(file.id, controller);
    setPending((previous) => ({ ...previous, [file.id]: action }));
    setActionErrors((previous) => {
      const next = { ...previous };
      delete next[file.id];
      return next;
    });
    setNotice("");
    try {
      const url = new URL(file.downloadUrl, location.origin);
      const expected = `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.id)}/content`;
      if (url.origin !== location.origin || url.pathname !== expected) throw new Error("文件下载地址无效");
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      if (controller.signal.aborted) return;
      // Only known raster types enter the image viewer. All downloads stay inert binary bytes.
      const image = file.image && (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType);
      if (action === "preview" && !image) throw new Error("此文件不支持图片预览");
      const blob = new Blob([bytes], { type: action === "preview" ? file.mimeType : "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      if (action === "preview") setPreview({ url: objectUrl, name: file.name, trigger });
      else {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = file.name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setNotice(t("已开始下载 {name}", { name: file.name }));
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setActionErrors((previous) => ({ ...previous, [file.id]: { action, reason: errorText(error) } }));
    } finally {
      if (actions.current.get(file.id) === controller) {
        actions.current.delete(file.id);
        if (!controller.signal.aborted)
          setPending((previous) => {
            const next = { ...previous };
            delete next[file.id];
            return next;
          });
      }
    }
  };

  return createPortal(
    <>
      <dialog
        ref={dialog}
        className="conversation-files"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
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
        <div className="conversation-files-panel">
          <header className="conversation-files-head">
            <div className="conversation-files-heading">
              <h2 id={titleId}>{t("会话文件")}</h2>
              <p title={props.roomName}>{props.roomName}</p>
            </div>
            <div className="conversation-files-head-actions">
              <button
                type="button"
                className="btn ghost icon"
                aria-label={t("刷新文件列表")}
                title={t("刷新文件列表")}
                disabled={files.loading}
                onClick={() => setRefresh((previous) => previous + 1)}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
              <button
                ref={close}
                type="button"
                className="btn ghost icon"
                aria-label={t("关闭会话文件")}
                onClick={props.onClose}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          </header>
          <p id={descriptionId} className="conversation-files-description">
            {t("用户上传的附件与 Agent 明确引用的文件，最新的在前。")}
            <span>{t("附件保留发送时的原件，项目文件下载当前内容。")}</span>
          </p>
          <div className="conversation-files-list" aria-busy={files.loading}>
            {files.items.length > 0 && (
              <ul aria-label={t("会话文件列表")}>
                {files.items.map((file) => {
                  const canRead = file.state === "available" && !!file.downloadUrl;
                  const image = file.image && (IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType);
                  const running = pending[file.id];
                  const error = actionErrors[file.id];
                  return (
                    <li key={file.id} className="conversation-file-row" data-file-id={file.id}>
                      <span className="conversation-file-icon" aria-hidden="true">
                        {image ? <Image size={20} /> : <File size={20} />}
                      </span>
                      <div className="conversation-file-body">
                        <div className="conversation-file-name" title={file.name}>
                          {file.name}
                        </div>
                        <div className="conversation-file-meta">
                          <span className="conversation-file-source">
                            {file.source === "attachment" ? t("用户附件") : t("Agent 文件")}
                          </span>
                          <span className="conversation-file-sender" title={file.senderName}>
                            {file.senderName}
                          </span>
                          <time dateTime={new Date(file.createdAt).toISOString()}>
                            {new Date(file.createdAt).toLocaleString(intlLocale(locale), {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                          <span>{file.size === null ? t("大小未知") : formatAttachmentSize(file.size)}</span>
                        </div>
                        {file.path && (
                          <div className="conversation-file-path" title={file.path}>
                            {file.path}
                          </div>
                        )}
                        {file.state !== "available" && (
                          <p className="conversation-file-unavailable">
                            {file.state === "missing"
                              ? t("文件已不存在")
                              : file.size !== null && file.size > CONVERSATION_FILE_DOWNLOAD_MAX_BYTES
                                ? t("文件超过 100 MiB 下载上限")
                                : t("文件不可用：位于工作区外或无法读取")}
                          </p>
                        )}
                        <div className="conversation-file-actions">
                          {image && (
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={!canRead || !!running}
                              aria-label={t("预览图片 {name}", { name: file.name })}
                              onClick={(event) => void openFile(file, "preview", event.currentTarget)}
                            >
                              {running === "preview" ? (
                                <LoaderCircle size={14} className="conversation-files-spin" aria-hidden="true" />
                              ) : (
                                <Image size={14} aria-hidden="true" />
                              )}
                              {t("预览")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={!canRead || !!running}
                            aria-label={t("下载文件 {name}", { name: file.name })}
                            onClick={(event) => void openFile(file, "download", event.currentTarget)}
                          >
                            {running === "download" ? (
                              <LoaderCircle size={14} className="conversation-files-spin" aria-hidden="true" />
                            ) : (
                              <Download size={14} aria-hidden="true" />
                            )}
                            {t("下载")}
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm conversation-file-origin"
                            onClick={() => props.onSelectMessage(file.messageId)}
                          >
                            <ArrowUpRight size={14} aria-hidden="true" />
                            {t("查看来源消息")}
                          </button>
                        </div>
                        {error && (
                          <p className="conversation-file-error" role="alert">
                            {t(error.action === "preview" ? "预览失败：{reason}" : "下载失败：{reason}", {
                              reason: translateError(error.reason),
                            })}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {!files.items.length && !files.nextCursor && !files.loading && !files.error && (
              <div className="conversation-files-empty">
                <FolderOpen size={30} strokeWidth={1.4} aria-hidden="true" />
                <strong>{t("还没有会话文件")}</strong>
                <p>{t("发送附件后，或 Agent 在回复中引用文件后，可在这里查看。")}</p>
              </div>
            )}
            {!files.items.length && files.nextCursor && !files.loading && !files.error && (
              <p className="conversation-files-status">{t("继续加载以查看更早的文件")}</p>
            )}
            {files.loading && (
              <div className="conversation-files-status" role="status">
                <LoaderCircle size={16} className="conversation-files-spin" aria-hidden="true" />
                {t("正在加载文件…")}
              </div>
            )}
            {files.error && (
              <div className="conversation-files-error" role="alert">
                <span>{t("文件列表加载失败：{reason}", { reason: translateError(files.error) })}</span>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    files.failedPage === "more" ? void loadMore() : setRefresh((previous) => previous + 1)
                  }
                >
                  {t("重试")}
                </button>
              </div>
            )}
            {files.nextCursor && !files.loading && !files.error && (
              <button type="button" className="btn conversation-files-more" onClick={() => void loadMore()}>
                {t("加载更早的文件")}
              </button>
            )}
          </div>
          <footer className="conversation-files-foot">
            <span>{t("已加载 {count} 个文件", { count: files.items.length })}</span>
            <span>
              <kbd>Esc</kbd> {t("关闭")}
            </span>
          </footer>
          <div className="sr-only" role="status">
            {notice}
          </div>
        </div>
      </dialog>
      {preview && (
        <ImagePreview src={preview.url} alt={preview.name} trigger={preview.trigger} onClose={() => setPreview(null)} />
      )}
    </>,
    document.body,
  );
}
