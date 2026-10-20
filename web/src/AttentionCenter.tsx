import { AlertCircle, ArrowUpRight, Check, HelpCircle, KeyRound, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type {
  AttentionFailure,
  AttentionItem,
  AttentionNavigateTarget,
  AttentionRequest,
  AttentionSnapshot,
} from "../../shared/attention";
import { api, type WsEvent } from "./api";
import { translateError, useI18n } from "./i18n";
import "./attention.css";

export interface AttentionState {
  active: AttentionRequest[];
  failures: AttentionFailure[];
  /** Null means no successful snapshot is available. */
  pendingCount: number | null;
  nextCursor: string | null;
  connected: boolean;
  stale: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  dismissPending: ReadonlySet<string>;
  dismissErrors: Readonly<Record<string, string>>;
}

type RequestApi = <T>(method: string, path: string) => Promise<T>;
const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One owner for requests and mutations, so a late page cannot restore a resolved or dismissed item. */
export class AttentionController {
  private state: AttentionState = {
    active: [],
    failures: [],
    pendingCount: null,
    nextCursor: null,
    connected: false,
    stale: true,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    dismissPending: new Set(),
    dismissErrors: {},
  };
  private sequence = 0;
  private listeners = new Set<() => void>();
  private dismissed = new Set<string>();
  private dismissing = new Map<string, Promise<boolean>>();

  constructor(private request: RequestApi = api) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<AttentionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  setConnected = (connected: boolean) => {
    if (this.state.connected === connected) return;
    ++this.sequence;
    this.update({ connected, stale: true, loading: false, loadingMore: false });
    if (connected) void this.refresh();
  };

  private apply(snapshot: AttentionSnapshot, append: boolean) {
    const hidden = snapshot.failures.filter((item) => this.dismissed.has(item.messageId));
    const page = snapshot.failures.filter((item) => !this.dismissed.has(item.messageId));
    const failures = append
      ? [...new Map([...this.state.failures, ...page].map((item) => [item.messageId, item])).values()]
      : page;
    this.update({
      active: snapshot.active,
      failures,
      pendingCount: Math.max(0, snapshot.totalCount - hidden.length),
      nextCursor: snapshot.nextCursor,
      stale: !this.state.connected,
      error: null,
      loading: false,
      loadingMore: false,
      loadMoreError: null,
    });
  }

  refresh = async () => {
    if (!this.state.connected) return;
    const sequence = ++this.sequence;
    this.update({ loading: true, loadingMore: false, stale: true, error: null, loadMoreError: null });
    try {
      const snapshot = await this.request<AttentionSnapshot>("GET", "/api/attention");
      if (sequence === this.sequence) this.apply(snapshot, false);
    } catch (error) {
      if (sequence === this.sequence) this.update({ loading: false, stale: true, error: failureText(error) });
    }
  };

  loadMore = async () => {
    if (!this.state.connected || !this.state.nextCursor || this.state.loading || this.state.loadingMore) return;
    const sequence = this.sequence;
    const cursor = this.state.nextCursor;
    this.update({ loadingMore: true, loadMoreError: null });
    try {
      const snapshot = await this.request<AttentionSnapshot>(
        "GET",
        `/api/attention?cursor=${encodeURIComponent(cursor)}`,
      );
      if (sequence === this.sequence) this.apply(snapshot, true);
    } catch (error) {
      if (sequence === this.sequence) this.update({ loadingMore: false, loadMoreError: failureText(error) });
    }
  };

  dismiss = (messageId: string): Promise<boolean> => {
    const running = this.dismissing.get(messageId);
    if (running) return running;
    if (!this.state.connected || this.dismissed.has(messageId)) return Promise.resolve(false);
    const errors = { ...this.state.dismissErrors };
    delete errors[messageId];
    this.update({
      dismissPending: new Set([...this.state.dismissPending, messageId]),
      dismissErrors: errors,
    });
    const operation = Promise.resolve().then(() => this.submitDismiss(messageId));
    this.dismissing.set(messageId, operation);
    return operation;
  };

  private async submitDismiss(messageId: string): Promise<boolean> {
    try {
      await this.request<{ ok: true }>("POST", `/api/attention/${encodeURIComponent(messageId)}/dismiss`);
      this.dismissed.add(messageId);
      // A snapshot that started before success may still contain this message. Failed mutations
      // do not invalidate refreshes: other Host requests may have resolved while submission waited.
      ++this.sequence;
      const removed = this.state.failures.some((item) => item.messageId === messageId);
      this.update({
        loading: false,
        loadingMore: false,
        failures: this.state.failures.filter((item) => item.messageId !== messageId),
        pendingCount:
          this.state.pendingCount === null ? null : Math.max(0, this.state.pendingCount - (removed ? 1 : 0)),
      });
      void this.refresh();
      return true;
    } catch (error) {
      this.update({ dismissErrors: { ...this.state.dismissErrors, [messageId]: failureText(error) } });
      return false;
    } finally {
      this.dismissing.delete(messageId);
      const pending = new Set(this.state.dismissPending);
      pending.delete(messageId);
      this.update({ dismissPending: pending });
    }
  }
}

export interface AttentionViewController extends AttentionState {
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  dismiss: (messageId: string) => Promise<boolean>;
}

/** Mount once in App so the global entry keeps its count while the panel is closed. */
export function useAttention(props: {
  subscribeEvents: (listener: (event: WsEvent) => void) => () => void;
  connected: boolean;
}): AttentionViewController {
  const [controller] = useState(() => new AttentionController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    return props.subscribeEvents((event) => {
      if (event.type === "attention.changed") void controller.refresh();
    });
  }, [controller, props.subscribeEvents]);
  useEffect(() => {
    controller.setConnected(props.connected);
    return () => controller.setConnected(false);
  }, [controller, props.connected]);
  return { ...state, refresh: controller.refresh, loadMore: controller.loadMore, dismiss: controller.dismiss };
}

const kindLabels: Record<AttentionItem["kind"], string> = {
  permission: "等待批准",
  question: "等待回答",
  auth: "需要登录或 Key",
  error: "请求失败",
  interrupted: "请求中断",
};
const kindIcons = {
  permission: ShieldCheck,
  question: HelpCircle,
  auth: KeyRound,
  error: AlertCircle,
  interrupted: AlertCircle,
};

export function AttentionCenter(props: {
  open: boolean;
  onClose: () => void;
  controller: AttentionViewController;
  onNavigate: (target: AttentionNavigateTarget) => void;
}) {
  const { t } = useI18n();
  const { controller: view } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element || !props.open) return;
    const previous = document.activeElement;
    element.showModal();
    closeButton.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [props.open]);
  const items: AttentionItem[] = [...view.active, ...view.failures];
  const navigate = (item: AttentionItem) => {
    props.onNavigate(
      "askId" in item
        ? { kind: item.kind, roomId: item.roomId, askId: item.askId }
        : { kind: item.kind, roomId: item.roomId, messageId: item.messageId },
    );
    props.onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="attention-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          props.onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <div className="attention-panel">
        <header className="attention-header">
          <div className="attention-heading">
            <h2 id={titleId}>{t("需要我处理")}</h2>
            <span className="attention-count">
              {view.pendingCount === null ? "—" : view.pendingCount}
              {view.stale && view.pendingCount !== null && <span>{t("待确认")}</span>}
            </span>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="btn ghost icon"
            aria-label={t("关闭")}
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="attention-intro">
          <p>{t("汇总所有项目中等待你的批准、回答和未处理的失败。")}</p>
          <button
            type="button"
            className="btn sm ghost"
            disabled={!view.connected || view.loading}
            onClick={() => void view.refresh()}
          >
            <RefreshCw size={13} className={view.loading ? "attention-spinning" : undefined} />
            {t("刷新")}
          </button>
        </div>
        {(!view.connected || view.error) && (
          <div className="attention-warning" role="status">
            <AlertCircle size={15} />
            <span>
              {!view.connected
                ? t("连接已断开，待办状态尚未确认。重新连接后会自动刷新。")
                : t("待办加载失败：{reason}", { reason: translateError(view.error ?? "") })}
              {items.length > 0 && ` ${t("下方保留上次已加载的内容。")}`}
            </span>
            {view.connected && (
              <button type="button" className="btn sm" disabled={view.loading} onClick={() => void view.refresh()}>
                {t("重试")}
              </button>
            )}
          </div>
        )}
        <div className="attention-list" aria-busy={view.loading || view.loadingMore}>
          {view.loading && view.pendingCount === null && (
            <p className="attention-empty" role="status">
              {t("正在加载待办…")}
            </p>
          )}
          {!view.loading && !view.stale && view.pendingCount === 0 && (
            <div className="attention-empty">
              <Check size={24} />
              <p>{t("暂时没有需要你处理的事项")}</p>
            </div>
          )}
          {items.length > 0 && (
            <ul>
              {items.map((item) => {
                const Icon = kindIcons[item.kind];
                const messageId = "messageId" in item ? item.messageId : null;
                const pending = messageId !== null && view.dismissPending.has(messageId);
                const error = messageId ? view.dismissErrors[messageId] : null;
                return (
                  <li className="attention-item" key={item.id} data-kind={item.kind}>
                    <span className="attention-kind-icon">
                      <Icon size={17} />
                    </span>
                    <div className="attention-item-content">
                      <div className="attention-item-heading">
                        <strong>{item.agentName}</strong>
                        <span className="badge">{t(kindLabels[item.kind])}</span>
                      </div>
                      <div className="attention-location">
                        <span>{item.projectName ?? t("未归属项目")}</span>
                        <span aria-hidden="true">/</span>
                        <span>{item.roomName}</span>
                      </div>
                      <p className="attention-reason">
                        {["permission", "question"].includes(item.kind) ? t(item.reason) : translateError(item.reason)}
                      </p>
                      <div className="attention-actions">
                        <button type="button" className="btn sm" onClick={() => navigate(item)}>
                          <ArrowUpRight size={13} />
                          {t("查看")}
                        </button>
                        {messageId && (
                          <button
                            type="button"
                            className="btn sm ghost"
                            disabled={pending || !view.connected}
                            onClick={() => void view.dismiss(messageId)}
                          >
                            <Check size={13} />
                            {pending ? t("提交中…") : t("标为已处理")}
                          </button>
                        )}
                      </div>
                      {error && (
                        <p className="attention-dismiss-error" role="alert">
                          {t("标记失败：{reason}。请重试。", { reason: translateError(error) })}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {view.loadMoreError && (
            <p className="attention-dismiss-error" role="alert">
              {t("更多待办加载失败：{reason}", { reason: translateError(view.loadMoreError) })}
            </p>
          )}
          {view.nextCursor && (
            <div className="attention-more">
              <button
                type="button"
                className="btn"
                disabled={view.loading || view.loadingMore || !view.connected}
                onClick={() => void view.loadMore()}
              >
                {view.loadingMore ? t("加载中…") : view.loadMoreError ? t("重试加载更多") : t("加载更多待办")}
              </button>
            </div>
          )}
        </div>
        <footer className="attention-footer">
          {t("批准和回答请在会话中完成。标为已处理只隐藏失败待办，原消息仍会保留。")}
        </footer>
      </div>
    </dialog>
  );
}
