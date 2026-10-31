import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  File,
  FileDiff,
  FileText,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  Maximize2,
  RotateCw,
  Users,
  WrapText,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IMAGE_MIME_TYPES } from "../../shared/attachments";
import { CONVERSATION_FILE_DOWNLOAD_MAX_BYTES, type ConversationFile } from "../../shared/conversationFiles";
import { FILE_PREVIEW_MAX_BYTES, type FilePreviewContent, getFilePreviewType } from "../../shared/filePreview";
import type { GitStatusDetailResponse, GitStatusItem, GitStatusSection } from "../../shared/gitStatus";
import type { SessionChangeDetailResponse, SessionFileChange } from "../../shared/sessionChanges";
import { api } from "./api";
import { formatAttachmentSize } from "./composerAttachments";
import { readConversationFile, readWorkspaceFile, saveConversationFile } from "./conversationFileDownload";
import { PreviewMarkdown, SourceView } from "./FilePreview";
import { staticHtmlDocument } from "./filePreviewContent";
import { DiffView } from "./Harness";
import { ImagePreview } from "./ImagePreview";
import { intlLocale, translateError, useI18n } from "./i18n";

const HIGHLIGHT_MAX_BYTES = 100 * 1024;
const SOURCE_ROWS_MAX = 3000;

function canHighlight(text: string, size?: number) {
  return (
    (size ?? new TextEncoder().encode(text).length) <= HIGHLIGHT_MAX_BYTES && text.split("\n").length <= SOURCE_ROWS_MAX
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type WorkbenchSelection =
  | {
      kind: "workspace";
      path: string;
      name: string;
      size: number | null;
      image: boolean;
      previewable: boolean;
      initialLens?: "content" | "git" | "edits";
      gitSection?: GitStatusSection;
    }
  | {
      kind: "chat";
      file: ConversationFile;
    };

export function selectionIdentity(selection: WorkbenchSelection | null): string {
  if (!selection) return "";
  if (selection.kind === "chat") return `chat:${selection.file.id}`;
  return `ws:${selection.path}`;
}

export function FileViewerPane(props: {
  roomId: string;
  selection: WorkbenchSelection | null;
  gitItem?: GitStatusItem | null;
  /** Repository-root prefix of the conversation directory; Git detail requests re-prefix it. */
  gitScope?: string;
  gitUnborn?: boolean;
  gitStepPrev?: (() => void) | null;
  gitStepNext?: (() => void) | null;
  agentChange?: SessionFileChange | null;
  revision: string;
  refreshToken: number;
  compact: boolean;
  detailFocusTick: number;
  onBack: () => void;
  onSelectMessage: (messageId: string) => void;
  onSelectGitSection?: (section: GitStatusSection) => void;
}) {
  const { t, locale } = useI18n();
  const { roomId, selection, gitItem, agentChange } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const downloadController = useRef<AbortController | null>(null);
  const copying = useRef(false);
  const headingId = useId();

  const gitSections = useMemo<GitStatusSection[]>(() => {
    if (!gitItem) return [];
    return (["unstaged", "staged", "untracked"] as const).filter((section) => Boolean(gitItem[section]));
  }, [gitItem]);

  const preferredLens =
    selection?.kind === "workspace"
      ? (selection.initialLens ??
        (gitItem && (gitItem.unstaged === "D" || (gitItem.staged === "D" && !gitItem.unstaged)) ? "git" : "content"))
      : "content";

  const [lens, setLens] = useState<"content" | "git" | "edits">(preferredLens);
  const [activeGitSection, setActiveGitSection] = useState<GitStatusSection>(
    (selection?.kind === "workspace" && selection.gitSection) || gitSections[0] || "unstaged",
  );

  const previewMime = selection?.kind === "chat" ? selection.file.mimeType : "";
  const previewName = selection?.kind === "chat" ? selection.file.name : (selection?.name ?? "");
  const previewType = selection ? getFilePreviewType(previewName, previewMime) : null;
  const isRasterImage =
    selection?.kind === "chat"
      ? selection.file.image && (IMAGE_MIME_TYPES as readonly string[]).includes(selection.file.mimeType)
      : Boolean(selection?.image);

  const [contentView, setContentView] = useState<"render" | "source">(
    previewType?.kind === "markdown" || previewType?.kind === "html" ? "render" : "source",
  );
  const [wrap, setWrap] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<FilePreviewContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  // Which identity produced `content` / `editsDetail`; stale payloads never render under a new name.
  const contentFor = useRef<string | null>(null);
  const editsFor = useRef<string | null>(null);

  const [gitDetail, setGitDetail] = useState<GitStatusDetailResponse | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  const [editsDetail, setEditsDetail] = useState<SessionChangeDetailResponse | null>(null);
  const [editsLoading, setEditsLoading] = useState(false);
  const [editsError, setEditsError] = useState<string | null>(null);

  const [downloadPending, setDownloadPending] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
    reason?: string;
    name?: string;
  } | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [imageError, setImageError] = useState(false);

  const identity = selectionIdentity(selection);
  const requestedLens = selection?.kind === "workspace" ? selection.initialLens : undefined;
  const requestedGitSection = selection?.kind === "workspace" ? selection.gitSection : undefined;

  // Reset per-file UI state when switching to a different file or explicit lens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset when target file or requested lens changes
  useEffect(() => {
    setFeedback(null);
    setZoomOpen(false);
    setImageError(false);
    const nextType = selection
      ? getFilePreviewType(
          selection.kind === "chat" ? selection.file.name : selection.name,
          selection.kind === "chat" ? selection.file.mimeType : "",
        )
      : null;
    setContentView(nextType?.kind === "markdown" || nextType?.kind === "html" ? "render" : "source");
    if (selection?.kind === "workspace") {
      const nextLens =
        selection.initialLens ??
        (gitItem && (gitItem.unstaged === "D" || (gitItem.staged === "D" && !gitItem.unstaged)) ? "git" : "content");
      setLens(nextLens);
      const nextSection =
        selection.gitSection && gitSections.includes(selection.gitSection)
          ? selection.gitSection
          : (gitSections[0] ?? selection.gitSection ?? "unstaged");
      setActiveGitSection(nextSection);
    } else {
      setLens("content");
    }
  }, [identity, requestedLens, requestedGitSection]);

  // Keep activeGitSection valid if gitSections updates after refresh.
  useEffect(() => {
    if (lens === "git" && gitSections.length > 0 && !gitSections.includes(activeGitSection)) {
      setActiveGitSection(gitSections[0] as GitStatusSection);
    }
  }, [lens, gitSections, activeGitSection]);

  useEffect(() => {
    if (props.compact && props.detailFocusTick > 0) {
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [props.compact, props.detailFocusTick]);

  useEffect(() => {
    return () => {
      downloadController.current?.abort();
    };
  }, []);

  const effectiveLens =
    selection?.kind === "workspace"
      ? lens === "git" && !gitSections.length && selection.initialLens !== "git"
        ? "content"
        : lens === "edits" && !agentChange && selection.initialLens !== "edits"
          ? "content"
          : lens
      : "content";

  // Load text/Markdown/HTML preview when in content lens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry/refresh reloads preview content
  useEffect(() => {
    if (!selection || effectiveLens !== "content" || isRasterImage || !previewType) {
      setContent(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }
    if (selection.kind === "chat" && selection.file.state !== "available") {
      setContent(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }
    const controller = new AbortController();
    // Keep the previous preview only while refreshing the exact same target.
    const sameTarget = contentFor.current === identity && Boolean(content);
    contentFor.current = identity;
    if (!sameTarget) setContent(null);
    setContentLoading(true);
    setContentError(null);
    const url =
      selection.kind === "chat"
        ? `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(selection.file.id)}/preview`
        : `/api/rooms/${encodeURIComponent(roomId)}/workspace-file/preview?path=${encodeURIComponent(selection.path)}`;
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
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
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setContent(null);
          setContentError(errorText(failure));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setContentLoading(false);
      });
    return () => controller.abort();
  }, [roomId, identity, effectiveLens, isRasterImage, Boolean(previewType), attempt, props.refreshToken]);

  // Selection paths are conversation-directory relative; the Git API takes repository-root paths.
  const gitScope = props.gitScope ?? "";
  const gitRepoPath =
    selection?.kind === "workspace" ? (gitScope ? `${gitScope}/${selection.path}` : selection.path) : "";

  // Load Git diff detail when in git lens (preserving previous detail during refresh so scrollTop never resets).
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads active Git diff in place
  useEffect(() => {
    if (selection?.kind !== "workspace" || effectiveLens !== "git") {
      setGitDetail(null);
      setGitError(null);
      setGitLoading(false);
      return;
    }
    let live = true;
    setGitLoading(true);
    setGitError(null);
    const query = new URLSearchParams({ path: gitRepoPath, section: activeGitSection });
    api<GitStatusDetailResponse>("GET", `/api/rooms/${encodeURIComponent(roomId)}/git-status/detail?${query}`)
      .then((value) => {
        if (live) setGitDetail(value);
      })
      .catch((reason: unknown) => {
        if (live) setGitError(errorText(reason));
      })
      .finally(() => {
        if (live) setGitLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    roomId,
    gitRepoPath,
    selection?.kind === "workspace" ? selection.path : "",
    effectiveLens,
    activeGitSection,
    props.refreshToken,
  ]);

  // Load Agent edit detail when in edits lens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and refresh reload Agent edit history
  useEffect(() => {
    if (selection?.kind !== "workspace" || effectiveLens !== "edits") {
      setEditsDetail(null);
      setEditsError(null);
      setEditsLoading(false);
      return;
    }
    if (editsFor.current !== selection.path) {
      editsFor.current = selection.path;
      setEditsDetail(null);
    }
    let live = true;
    setEditsLoading(true);
    setEditsError(null);
    api<SessionChangeDetailResponse>(
      "GET",
      `/api/rooms/${encodeURIComponent(roomId)}/changes/detail?path=${encodeURIComponent(selection.path)}`,
    )
      .then((value) => {
        if (live) setEditsDetail(value);
      })
      .catch((reason: unknown) => {
        if (live) {
          setEditsDetail(null);
          setEditsError(errorText(reason));
        }
      })
      .finally(() => {
        if (live) setEditsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    roomId,
    selection?.kind === "workspace" ? selection.path : "",
    effectiveLens,
    props.revision,
    props.refreshToken,
  ]);

  const html = useMemo(() => {
    if (effectiveLens !== "content" || content?.kind !== "html" || contentView !== "render") {
      return { document: "", error: null };
    }
    try {
      return { document: staticHtmlDocument(content.text), error: null };
    } catch (failure) {
      return { document: "", error: errorText(failure) };
    }
  }, [effectiveLens, content, contentView]);

  // Reclaim focus from opaque sandbox iframe so Escape continues to work on the workbench.
  useEffect(() => {
    if (!html.document) return;
    const frame = iframeRef.current;
    if (!frame) return;
    let timer = 0;
    const reclaimFocus = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.activeElement === frame && document.hasFocus()) {
          headingRef.current?.focus({ preventScroll: true });
        }
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

  if (!selection) {
    return (
      <section className="file-viewer-pane file-viewer-empty" aria-label={t("文件预览")}>
        <FileText size={28} strokeWidth={1.4} aria-hidden="true" />
        <p>{t("选择左侧文件查看内容或改动")}</p>
      </section>
    );
  }

  const fileName = selection.kind === "chat" ? selection.file.name : selection.name;
  const filePath =
    selection.kind === "chat"
      ? selection.file.path || t(selection.file.source === "attachment" ? "用户附件" : "Agent 文件")
      : selection.path;
  const canDownload =
    selection.kind === "chat"
      ? selection.file.state === "available" && Boolean(selection.file.downloadUrl)
      : !(gitItem && gitItem.unstaged === "D" && !gitItem.staged);

  const inlineImageUrl = isRasterImage
    ? selection.kind === "chat"
      ? `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(selection.file.id)}/content?inline=1&r=${props.refreshToken}`
      : `/api/rooms/${encodeURIComponent(roomId)}/workspace-file/content?path=${encodeURIComponent(selection.path)}&inline=1&r=${props.refreshToken}`
    : null;

  const manyLines = content ? content.text.split("\n").length > SOURCE_ROWS_MAX : false;
  const showingSource = Boolean(content && (contentView === "source" || !["markdown", "html"].includes(content.kind)));

  const copySource = async () => {
    if (!content || copying.current) return;
    copying.current = true;
    setCopyPending(true);
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境无法访问剪贴板");
      await navigator.clipboard.writeText(content.text);
      setFeedback({ kind: "success", text: "已复制源码" });
    } catch (failure) {
      setFeedback({ kind: "error", text: "复制失败：{reason}。请重试。", reason: errorText(failure) });
    } finally {
      copying.current = false;
      setCopyPending(false);
    }
  };

  const downloadFile = async () => {
    if (!canDownload || downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadPending(true);
    setFeedback(null);
    try {
      const bytes =
        selection.kind === "chat"
          ? await readConversationFile(roomId, selection.file, controller.signal)
          : await readWorkspaceFile(roomId, selection.path, controller.signal);
      if (!controller.signal.aborted) {
        saveConversationFile(bytes, fileName);
        setFeedback({ kind: "success", text: "已开始下载 {name}", name: fileName });
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setFeedback({ kind: "error", text: "下载失败：{reason}", reason: errorText(failure) });
      }
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
      if (!controller.signal.aborted) setDownloadPending(false);
    }
  };

  const displayedGit =
    selection.kind === "workspace" &&
    gitDetail &&
    gitDetail.path === gitRepoPath &&
    gitDetail.section === activeGitSection
      ? gitDetail
      : null;
  const displayedEdits =
    selection.kind === "workspace" && editsDetail && editsDetail.path === selection.path ? editsDetail : null;
  const patchLines =
    displayedGit?.state === "text" && displayedGit.section !== "untracked" ? displayedGit.content?.split("\n") : null;

  const showToolbar =
    (selection.kind === "workspace" && (gitSections.length > 0 || Boolean(agentChange))) ||
    (effectiveLens === "content" && Boolean(previewType));

  const sizeBytes =
    effectiveLens === "content" && content
      ? content.size
      : selection.kind === "chat"
        ? selection.file.size
        : selection.size;

  return (
    <section className="file-viewer-pane" aria-labelledby={headingId}>
      <header className="file-viewer-head">
        {props.compact && (
          <button type="button" className="btn ghost sm file-viewer-back" onClick={props.onBack}>
            <ArrowLeft size={15} aria-hidden="true" />
            {t("文件列表")}
          </button>
        )}
        <div className="file-viewer-heading">
          <h3 id={headingId} ref={headingRef} tabIndex={-1} title={fileName}>
            {fileName}
          </h3>
          <p title={filePath}>
            {effectiveLens === "git" ? (
              <>
                <span>{filePath}</span>
                {" · "}
                {activeGitSection === "staged" ? (
                  <>
                    {props.gitUnborn ? t("尚无提交") : "HEAD"} <span aria-hidden="true">→</span> {t("暂存区")}
                  </>
                ) : activeGitSection === "unstaged" ? (
                  <>
                    {t("暂存区")} <span aria-hidden="true">→</span> {t("工作区")}
                  </>
                ) : (
                  t("未跟踪")
                )}
              </>
            ) : (
              filePath
            )}
          </p>
        </div>
        <div className="file-viewer-head-actions">
          {effectiveLens === "git" && (props.gitStepPrev || props.gitStepNext) && (
            <div className="file-viewer-step">
              <button
                type="button"
                className="btn ghost icon"
                aria-label={t("上一个文件")}
                title={t("上一个文件")}
                disabled={!props.gitStepPrev}
                onClick={() => props.gitStepPrev?.()}
              >
                <ChevronUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="btn ghost icon"
                aria-label={t("下一个文件")}
                title={t("下一个文件")}
                disabled={!props.gitStepNext}
                onClick={() => props.gitStepNext?.()}
              >
                <ChevronDown size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {selection.kind === "chat" && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => props.onSelectMessage(selection.file.messageId)}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              {t("查看来源消息")}
            </button>
          )}
          {isRasterImage && canDownload && (
            <button
              ref={zoomTriggerRef}
              type="button"
              className="btn ghost icon"
              aria-label={t("预览图片 {name}", { name: fileName })}
              title={t("预览")}
              onClick={() => setZoomOpen(true)}
            >
              <Maximize2 size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="btn ghost icon"
            disabled={!canDownload || downloadPending}
            aria-label={t("下载文件 {name}", { name: fileName })}
            title={t("下载")}
            onClick={() => void downloadFile()}
          >
            {downloadPending ? (
              <LoaderCircle size={16} className="file-preview-spin" aria-hidden="true" />
            ) : (
              <Download size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {showToolbar && (
        <div className="file-viewer-toolbar">
          <fieldset className="file-preview-modes" aria-label={t("预览模式")}>
            {effectiveLens === "content" && (previewType?.kind === "markdown" || previewType?.kind === "html") ? (
              <>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-pressed={contentView === "render"}
                  onClick={() => setContentView("render")}
                >
                  {previewType.kind === "markdown" ? t("阅读视图") : t("静态页面")}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-pressed={contentView === "source"}
                  onClick={() => setContentView("source")}
                >
                  {t("源码")}
                </button>
              </>
            ) : previewType ? (
              <button
                type="button"
                className="btn ghost sm"
                aria-pressed={effectiveLens === "content"}
                onClick={() => setLens("content")}
              >
                {effectiveLens === "content" ? t("源码") : t("文件内容")}
              </button>
            ) : (
              selection.kind === "workspace" && (
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-pressed={effectiveLens === "content"}
                  onClick={() => setLens("content")}
                >
                  {t("文件内容")}
                </button>
              )
            )}
            {selection.kind === "workspace" &&
              gitSections.map((section) => (
                <button
                  key={section}
                  type="button"
                  className="btn ghost sm"
                  aria-pressed={effectiveLens === "git" && activeGitSection === section}
                  onClick={() => {
                    setLens("git");
                    setActiveGitSection(section);
                    props.onSelectGitSection?.(section);
                  }}
                >
                  <GitBranch size={13} aria-hidden="true" />
                  {gitSections.length > 1
                    ? t(section === "staged" ? "已暂存" : section === "unstaged" ? "未暂存" : "未跟踪")
                    : t("Git 变更")}
                </button>
              ))}
            {selection.kind === "workspace" && agentChange && (
              <button
                type="button"
                className="btn ghost sm"
                aria-pressed={effectiveLens === "edits"}
                onClick={() => setLens("edits")}
              >
                <FileDiff size={13} aria-hidden="true" />
                {t("Agent 改动")} ({agentChange.editCount})
              </button>
            )}
          </fieldset>

          {effectiveLens === "content" && showingSource && (
            <div className="file-preview-source-actions">
              <button
                type="button"
                className="btn ghost sm"
                aria-pressed={wrap && !manyLines}
                disabled={manyLines}
                onClick={() => setWrap((previous) => !previous)}
              >
                <WrapText size={14} aria-hidden="true" />
                {t("自动换行")}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!content || copyPending}
                onClick={() => void copySource()}
              >
                {copyPending ? (
                  <LoaderCircle size={14} className="file-preview-spin" aria-hidden="true" />
                ) : feedback?.text === "已复制源码" ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                {t("复制源码")}
              </button>
            </div>
          )}
          {effectiveLens === "content" && !showingSource && content && (
            <div className="file-preview-source-actions">
              <button type="button" className="btn ghost sm" disabled={copyPending} onClick={() => void copySource()}>
                {copyPending ? (
                  <LoaderCircle size={14} className="file-preview-spin" aria-hidden="true" />
                ) : feedback?.text === "已复制源码" ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                {t("复制源码")}
              </button>
            </div>
          )}
        </div>
      )}

      {feedback && (
        <div
          className="file-preview-feedback"
          data-kind={feedback.kind}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {t(feedback.text, { reason: translateError(feedback.reason ?? ""), name: feedback.name ?? "" })}
        </div>
      )}

      <div className="file-viewer-body" aria-busy={contentLoading || gitLoading || editsLoading}>
        {effectiveLens === "git" ? (
          <>
            {gitLoading && (
              <div className="file-viewer-inline-status" role="status">
                <LoaderCircle size={14} className="file-preview-spin" aria-hidden="true" />
                {t("正在加载改动…")}
              </div>
            )}
            {gitError && (
              <div className="file-viewer-alert" role="alert">
                {t("改动加载失败：{reason}", { reason: translateError(gitError) })}
              </div>
            )}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region for keyboard reading */}
            <section className="git-detail-scroll" tabIndex={0} aria-labelledby={headingId}>
              {displayedGit?.state === "text" ? (
                <pre className="git-patch">
                  {patchLines && patchLines.length <= 3000
                    ? patchLines.map((line, index) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: immutable patch text
                          key={index}
                          data-op={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "+"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "-"
                                : line.startsWith("@@")
                                  ? "hunk"
                                  : undefined
                          }
                        >
                          {line}
                          {index < patchLines.length - 1 ? "\n" : ""}
                        </span>
                      ))
                    : displayedGit.content}
                </pre>
              ) : (
                displayedGit && (
                  <p className="git-unavailable">
                    {displayedGit.state === "binary"
                      ? t("二进制文件，无法显示文本。")
                      : displayedGit.state === "too-large"
                        ? t("内容过大，无法显示。")
                        : t("内容不可用，请刷新后重试。")}{" "}
                    {displayedGit.reason}
                  </p>
                )
              )}
            </section>
          </>
        ) : effectiveLens === "edits" ? (
          <div className="file-viewer-edits">
            {agentChange?.overlap && (
              <div className="file-viewer-overlap-banner">
                <Users size={14} aria-hidden="true" />
                <span>{t("多位 Agent 改过同一文件")}</span>
              </div>
            )}
            {editsLoading && !displayedEdits && (
              <div className="file-preview-status" role="status">
                <LoaderCircle size={20} className="file-preview-spin" aria-hidden="true" />
                <p>{t("正在加载改动…")}</p>
              </div>
            )}
            {editsError && (
              <div className="file-viewer-alert" role="alert">
                {t("改动加载失败：{reason}", { reason: translateError(editsError) })}
              </div>
            )}
            {displayedEdits?.edits.map((edit) => (
              <article key={`${edit.messageId}:${edit.toolCallId}:${edit.path}`} className="session-change-edit">
                <header className="session-change-edit-head">
                  <strong>{edit.senderName}</strong>
                  {edit.replyStatus !== "done" && (
                    <span className="session-change-status">
                      {t(
                        edit.replyStatus === "error"
                          ? "回复失败"
                          : edit.replyStatus === "cancelled"
                            ? "已取消"
                            : "已中断",
                      )}
                    </span>
                  )}
                  <time dateTime={new Date(edit.createdAt).toISOString()}>
                    {new Date(edit.createdAt).toLocaleString(intlLocale(locale), {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <button type="button" className="btn ghost sm" onClick={() => props.onSelectMessage(edit.messageId)}>
                    <ArrowUpRight size={14} aria-hidden="true" />
                    {t("查看来源消息")}
                  </button>
                </header>
                {edit.oldText !== null || edit.newText !== null ? (
                  <DiffView path={edit.path} oldText={edit.oldText} newText={edit.newText ?? ""} />
                ) : (
                  <p className="session-change-nodiff muted">{t("这次编辑没有附带 diff。")}</p>
                )}
              </article>
            ))}
          </div>
        ) : selection.kind === "chat" && selection.file.state !== "available" ? (
          <div className="file-preview-status file-preview-error" role="status">
            <File size={24} aria-hidden="true" />
            <p>
              {selection.file.state === "missing"
                ? t("文件已不存在")
                : selection.file.size !== null && selection.file.size > CONVERSATION_FILE_DOWNLOAD_MAX_BYTES
                  ? t("文件超过 100 MiB 下载上限")
                  : t("文件不可用：位于工作区外或无法读取")}
            </p>
          </div>
        ) : isRasterImage && inlineImageUrl ? (
          <div className="file-viewer-image-stage">
            {imageError ? (
              <div className="file-preview-status file-preview-error" role="alert">
                <ImageIcon size={24} aria-hidden="true" />
                <p>{t("图片加载失败")}</p>
              </div>
            ) : (
              <button
                type="button"
                className="file-viewer-image-btn"
                title={t("放大预览")}
                aria-label={t("放大预览：{name}", { name: fileName })}
                onClick={() => setZoomOpen(true)}
              >
                <img src={inlineImageUrl} alt={fileName} onError={() => setImageError(true)} />
              </button>
            )}
          </div>
        ) : !previewType ? (
          <div className="file-preview-status">
            <File size={26} strokeWidth={1.5} aria-hidden="true" />
            <p>{t("此文件类型不支持预览")}</p>
            {canDownload && (
              <button type="button" className="btn sm" disabled={downloadPending} onClick={() => void downloadFile()}>
                <Download size={14} aria-hidden="true" />
                {t("下载")}
              </button>
            )}
          </div>
        ) : contentLoading && !content ? (
          <div className="file-preview-status" role="status">
            <LoaderCircle size={20} className="file-preview-spin" aria-hidden="true" />
            <p>{t("正在加载预览…")}</p>
          </div>
        ) : contentError ? (
          <div className="file-preview-status file-preview-error" role="alert">
            <p>{t("预览失败：{reason}", { reason: translateError(contentError) })}</p>
            <button type="button" className="btn sm" onClick={() => setAttempt((previous) => previous + 1)}>
              <RotateCw size={14} aria-hidden="true" />
              {t("重试预览")}
            </button>
          </div>
        ) : (
          content &&
          (showingSource ? (
            <SourceView content={content} wrap={wrap} />
          ) : content.kind === "markdown" ? (
            <PreviewMarkdown text={content.text} />
          ) : html.error ? (
            <div className="file-preview-status file-preview-error" role="alert">
              <p>{t("预览失败：{reason}", { reason: translateError(html.error) })}</p>
              <button type="button" className="btn sm" onClick={() => setContentView("source")}>
                {t("查看源码")}
              </button>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
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

      <footer className="file-viewer-foot">
        <span>
          {effectiveLens === "git"
            ? t("已暂存对比 HEAD，未暂存对比暂存区；未跟踪显示当前文件内容。")
            : effectiveLens === "edits"
              ? t("仅显示 Agent 通过 edit 工具报告的改动，不含 shell 或格式化。")
              : content?.kind === "html" && contentView === "render"
                ? t("单文件静态预览；脚本和外部资源未加载")
                : content?.kind === "markdown" && contentView === "render"
                  ? t("Markdown 预览不加载图片，链接不可跳转")
                  : manyLines
                    ? t("行数较多，已关闭高亮和自动换行")
                    : content && !canHighlight(content.text, content.size)
                      ? t("文件较大，已关闭语法高亮")
                      : isRasterImage
                        ? t("点击图片可放大缩放")
                        : t("预览最多支持 1 MiB 的 UTF-8 文本")}
        </span>
        {sizeBytes !== null && sizeBytes !== undefined && <span>{formatAttachmentSize(sizeBytes)}</span>}
      </footer>

      {zoomOpen && inlineImageUrl && (
        <ImagePreview
          src={inlineImageUrl}
          alt={fileName}
          trigger={zoomTriggerRef.current}
          onClose={() => setZoomOpen(false)}
        />
      )}
    </section>
  );
}
