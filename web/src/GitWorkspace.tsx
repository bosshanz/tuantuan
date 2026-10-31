import { ArrowLeft, ChevronDown, ChevronUp, FileCode2, FileDiff, GitBranch, LoaderCircle } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  GitStatusDetailResponse,
  GitStatusItem,
  GitStatusResponse,
  GitStatusSection,
} from "../../shared/gitStatus";
import { api } from "./api";
import { translateError, useI18n } from "./i18n";

interface Selection {
  path: string;
  section: GitStatusSection;
}
const keyOf = (value: Selection) => `${value.section}:${value.path}`;
const sectionOrder: GitStatusSection[] = ["unstaged", "staged", "untracked"];
function entriesOf(items: GitStatusItem[]): Selection[] {
  return sectionOrder.flatMap((section) =>
    items.filter((item) => item[section]).map((item) => ({ path: item.path, section })),
  );
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function GitWorkspacePanel(props: { roomId: string; refreshToken: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<GitStatusDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const restoreListFocus = useRef(false);
  const detailId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the current workspace
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api<GitStatusResponse>("GET", `/api/rooms/${encodeURIComponent(props.roomId)}/git-status`)
      .then((value) => {
        if (!live) return;
        if (value.state === "error") {
          setError(value.error || "Git 操作失败");
          setData((previous) => previous || value);
          return;
        }
        setData(value);
        const entries = entriesOf(value.items);
        setSelected((previous) =>
          previous && entries.some((entry) => keyOf(entry) === keyOf(previous)) ? previous : (entries[0] ?? null),
        );
        if (!entries.length) setMobileDetail(false);
      })
      .catch((reason: unknown) => {
        if (live) setError(errorText(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.roomId, props.refreshToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh also reloads the selected file
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setDetailLoading(true);
    setDetailError(null);
    const query = new URLSearchParams({ path: selected.path, section: selected.section });
    api<GitStatusDetailResponse>("GET", `/api/rooms/${encodeURIComponent(props.roomId)}/git-status/detail?${query}`)
      .then((value) => {
        if (live) setDetail(value);
      })
      .catch((reason: unknown) => {
        if (live) setDetailError(errorText(reason));
      })
      .finally(() => {
        if (live) setDetailLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.roomId, selected, props.refreshToken]);

  useEffect(() => {
    if (mobileDetail) detailTitle.current?.focus({ preventScroll: true });
  }, [mobileDetail]);
  useLayoutEffect(() => {
    if (!mobileDetail && restoreListFocus.current) {
      restoreListFocus.current = false;
      if (selected) buttons.current.get(keyOf(selected))?.focus({ preventScroll: true });
    }
  }, [mobileDetail, selected]);

  const available = data && (data.state === "ready" || data.state === "unborn");
  const entries = entriesOf(data?.items ?? []);
  const selectedIndex = selected ? entries.findIndex((entry) => keyOf(entry) === keyOf(selected)) : -1;
  const sectionName = (section: GitStatusSection) =>
    t(section === "staged" ? "已暂存" : section === "unstaged" ? "未暂存" : "未跟踪");
  const select = (value: Selection) => {
    setSelected(value);
    setMobileDetail(true);
  };
  const back = () => {
    restoreListFocus.current = true;
    setMobileDetail(false);
  };
  const displayed = selected && detail && keyOf(selected) === keyOf(detail) ? detail : null;
  const lines =
    displayed?.state === "text" && displayed.section !== "untracked" ? displayed.content?.split("\n") : null;

  return (
    <div className="git-workspace-v2" data-detail={mobileDetail || undefined} aria-busy={loading}>
      <div className="git-scope">
        <GitBranch size={16} aria-hidden="true" />
        <span title={data?.root}>
          {data?.root?.split(/[\\/]/).at(-1) || t("Git 工作区")}
          {data?.scope ? ` / ${data.scope}` : ""}
        </span>
        <span className="git-scope-badge">{t("只读")}</span>
        {data?.state === "unborn" && <span className="git-scope-badge">{t("尚无提交")}</span>}
        {loading && <LoaderCircle size={15} className="conversation-files-spin" aria-label={t("正在加载工作区…")} />}
      </div>
      {error && (
        <div className="git-notice" role="alert">
          {t("工作区加载失败：{reason}", { reason: translateError(error) })}
          {available && ` ${t("下方保留上次已加载的内容。")}`}
        </div>
      )}
      {!data && loading && (
        <div className="conversation-files-status" role="status">
          {t("正在加载工作区…")}
        </div>
      )}
      {data?.state === "not-repository" && (
        <div className="conversation-files-empty">
          <GitBranch size={28} />
          <strong>{t("非 Git 目录")}</strong>
        </div>
      )}
      {available && !entries.length && (
        <div className="conversation-files-empty">
          <FileDiff size={28} />
          <strong>{t("会话目录没有 Git 改动")}</strong>
        </div>
      )}
      {available && entries.length > 0 && (
        <div className="git-browser">
          <nav className="git-browser-files" aria-label={t("Git 工作区改动")}>
            {sectionOrder.map((section) => {
              const files = data.items.filter((file) => file[section]);
              if (!files.length) return null;
              return (
                <section className="git-file-group" key={section}>
                  <h3>
                    <span>{sectionName(section)}</span>
                    <span>{files.length}</span>
                  </h3>
                  {files.map((file) => {
                    const value = { path: file.path, section };
                    const key = keyOf(value);
                    const active = selected && keyOf(selected) === key;
                    const name = file.path.split("/").at(-1);
                    const dir = file.path.slice(0, file.path.length - (name?.length ?? 0)).replace(/\/$/, "");
                    return (
                      <button
                        type="button"
                        className="git-browser-file"
                        key={key}
                        data-selected={active || undefined}
                        aria-pressed={Boolean(active)}
                        ref={(element) => {
                          if (element) buttons.current.set(key, element);
                          else buttons.current.delete(key);
                        }}
                        onClick={() => select(value)}
                        onKeyDown={(event) => {
                          const index = entries.findIndex((entry) => keyOf(entry) === key);
                          const next =
                            event.key === "ArrowDown"
                              ? Math.min(index + 1, entries.length - 1)
                              : event.key === "ArrowUp"
                                ? Math.max(index - 1, 0)
                                : event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? entries.length - 1
                                    : null;
                          if (next === null || !entries[next]) return;
                          event.preventDefault();
                          setSelected(entries[next]);
                          buttons.current.get(keyOf(entries[next]))?.focus({ preventScroll: false });
                        }}
                      >
                        <FileCode2 size={17} aria-hidden="true" />
                        <span className="git-browser-file-text">
                          <strong>{name}</strong>
                          {dir && <span>{dir}</span>}
                        </span>
                        <span className="git-browser-code" data-code={file[section]}>
                          {section === "untracked" ? "+" : file[section]}
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </nav>
          <section className="git-browser-detail" aria-labelledby={detailId}>
            <header className="git-detail-toolbar">
              <button type="button" className="btn ghost git-mobile-back" onClick={back}>
                <ArrowLeft size={18} />
                {t("文件列表")}
              </button>
              <div className="git-detail-title">
                <h3 id={detailId} tabIndex={-1} ref={detailTitle}>
                  {selected?.path}
                </h3>
                <span>
                  {selected?.section === "staged" ? (
                    <>
                      {data?.state === "unborn" ? t("尚无提交") : "HEAD"} <span aria-hidden="true">→</span>{" "}
                      {t("暂存区")}
                    </>
                  ) : selected?.section === "unstaged" ? (
                    <>
                      {t("暂存区")} <span aria-hidden="true">→</span> {t("工作区")}
                    </>
                  ) : (
                    t("未跟踪")
                  )}
                </span>
              </div>
              <div className="git-detail-step">
                <button
                  type="button"
                  className="btn ghost icon"
                  aria-label={t("上一个文件")}
                  disabled={selectedIndex <= 0}
                  onClick={() => {
                    const value = entries[selectedIndex - 1];
                    if (value) setSelected(value);
                  }}
                >
                  <ChevronUp size={18} />
                </button>
                <button
                  type="button"
                  className="btn ghost icon"
                  aria-label={t("下一个文件")}
                  disabled={selectedIndex < 0 || selectedIndex >= entries.length - 1}
                  onClick={() => {
                    const value = entries[selectedIndex + 1];
                    if (value) setSelected(value);
                  }}
                >
                  <ChevronDown size={18} />
                </button>
              </div>
            </header>
            {detailLoading && (
              <div className="git-detail-feedback" role="status">
                <LoaderCircle size={14} className="conversation-files-spin" />
                {t("正在加载改动…")}
              </div>
            )}
            {detailError && (
              <div className="git-notice" role="alert">
                {t("改动加载失败：{reason}", { reason: translateError(detailError) })}
              </div>
            )}
            {/* Keyboard users can scroll long diffs without moving selection. */}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable scroll region for keyboard reading */}
            <section className="git-detail-scroll" tabIndex={0} aria-labelledby={detailId}>
              {displayed?.state === "text" ? (
                <pre className="git-patch">
                  {lines && lines.length <= 3000
                    ? lines.map((line, index) => (
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
                          {index < lines.length - 1 ? "\n" : ""}
                        </span>
                      ))
                    : displayed.content}
                </pre>
              ) : (
                displayed && (
                  <p className="git-unavailable">
                    {displayed.state === "binary"
                      ? t("二进制文件，无法显示文本。")
                      : displayed.state === "too-large"
                        ? t("内容过大，无法显示。")
                        : t("内容不可用，请刷新后重试。")}{" "}
                    {displayed.reason}
                  </p>
                )
              )}
            </section>
          </section>
        </div>
      )}
    </div>
  );
}
