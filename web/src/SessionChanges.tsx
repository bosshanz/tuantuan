import { ArrowUpRight, FileDiff, LoaderCircle, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  SessionChangeDetailResponse,
  SessionChangesResponse,
  SessionFileChange,
} from "../../shared/sessionChanges";
import { api } from "./api";
import { DiffView } from "./Harness";
import { intlLocale, translateError, useI18n } from "./i18n";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SessionChangesPanel(props: {
  roomId: string;
  revision: string;
  refreshToken: number;
  onSelectMessage: (messageId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<SessionFileChange[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionChangeDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const generation = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision / refresh restart the list
  useEffect(() => {
    const token = ++generation.current;
    setLoading(true);
    setError(null);
    api<SessionChangesResponse>("GET", `/api/rooms/${encodeURIComponent(props.roomId)}/changes`)
      .then((page) => {
        if (generation.current !== token) return;
        setItems(page.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (generation.current !== token) return;
        setError(errorText(err));
        setLoading(false);
      });
    return () => {
      ++generation.current;
    };
  }, [props.roomId, props.revision, props.refreshToken]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision / refresh reload the open detail
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let live = true;
    setDetailLoading(true);
    setDetailError(null);
    api<SessionChangeDetailResponse>(
      "GET",
      `/api/rooms/${encodeURIComponent(props.roomId)}/changes/detail?path=${encodeURIComponent(selected)}`,
    )
      .then((body) => {
        if (!live) return;
        setDetail(body);
        setDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setDetail(null);
        setDetailError(errorText(err));
        setDetailLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.roomId, selected, props.revision, props.refreshToken]);

  return (
    <div className="session-changes" aria-busy={loading}>
      <p className="conversation-files-description">
        {t("仅显示 Agent 通过 edit 工具报告的改动，不含 shell 或格式化。")}
        <span>{t("只读汇总，不表示全部磁盘改动。")}</span>
      </p>
      <div className="conversation-files-list session-changes-list">
        {items.length > 0 && (
          <ul aria-label={t("会话改动列表")}>
            {items.map((file) => {
              const open = selected === file.path;
              return (
                <li key={file.path} className="conversation-file-row session-change-row" data-path={file.path}>
                  <span className="conversation-file-icon" aria-hidden="true">
                    <FileDiff size={20} />
                  </span>
                  <div className="conversation-file-body">
                    <div className="conversation-file-name" title={file.name}>
                      {file.name}
                      {file.overlap && (
                        <span className="session-change-overlap" title={t("多位 Agent 改过同一文件")}>
                          <Users size={12} aria-hidden="true" />
                          {t("重叠")}
                        </span>
                      )}
                    </div>
                    <div className="conversation-file-meta">
                      <span className="conversation-file-source">{t("{count} 次改动", { count: file.editCount })}</span>
                      <span
                        className="conversation-file-sender"
                        title={file.authors.map((a) => a.agentName).join(", ")}
                      >
                        {t("{count} 位作者", { count: file.authors.length })}
                        {" · "}
                        {file.authors.map((a) => a.agentName).join(", ")}
                      </span>
                      <time dateTime={new Date(file.lastAt).toISOString()}>
                        {new Date(file.lastAt).toLocaleString(intlLocale(locale), {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    <div className="conversation-file-path" title={file.path}>
                      {file.path}
                    </div>
                    <div className="conversation-file-actions">
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-expanded={open}
                        onClick={() => setSelected(open ? null : file.path)}
                      >
                        <FileDiff size={14} aria-hidden="true" />
                        {open ? t("收起 diff") : t("查看 diff")}
                      </button>
                    </div>
                    {open && (
                      <div className="session-change-detail">
                        {detailLoading && (
                          <div className="conversation-files-status" role="status">
                            <LoaderCircle size={16} className="conversation-files-spin" aria-hidden="true" />
                            {t("正在加载改动…")}
                          </div>
                        )}
                        {detailError && (
                          <p className="conversation-file-error" role="alert">
                            {t("改动加载失败：{reason}", { reason: translateError(detailError) })}
                          </p>
                        )}
                        {detail &&
                          !detailLoading &&
                          detail.edits.map((edit) => (
                            <article
                              key={`${edit.messageId}:${edit.toolCallId}:${edit.path}`}
                              className="session-change-edit"
                            >
                              <header className="session-change-edit-head">
                                <strong>{edit.senderName}</strong>
                                <time dateTime={new Date(edit.createdAt).toISOString()}>
                                  {new Date(edit.createdAt).toLocaleString(intlLocale(locale), {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </time>
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  onClick={() => props.onSelectMessage(edit.messageId)}
                                >
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
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!items.length && !loading && !error && (
          <div className="conversation-files-empty">
            <FileDiff size={30} strokeWidth={1.4} aria-hidden="true" />
            <strong>{t("还没有报告的改动")}</strong>
            <p>{t("Agent 用 edit 工具改文件后，会按路径汇总出现在这里。")}</p>
          </div>
        )}
        {loading && (
          <div className="conversation-files-status" role="status">
            <LoaderCircle size={16} className="conversation-files-spin" aria-hidden="true" />
            {t("正在加载改动…")}
          </div>
        )}
        {error && (
          <div className="conversation-files-error" role="alert">
            <span>{t("改动列表加载失败：{reason}", { reason: translateError(error) })}</span>
          </div>
        )}
      </div>
      <footer className="conversation-files-foot">
        <span>{t("已汇总 {count} 个文件", { count: items.length })}</span>
        <span>
          <kbd>Esc</kbd> {t("关闭")}
        </span>
      </footer>
    </div>
  );
}
