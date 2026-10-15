import { Bell, BellRing } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { defaultAvatar } from "../../server/avatars";
import { type GlobalEvent, NOTIFY_KINDS, NOTIFY_LABEL, type NotifyKind } from "../../shared/notify";
import type { Agent, Room, WsEvent } from "./api";
import { BotAvatar } from "./BotAvatar";
import {
  avatarIcon,
  bridge,
  bumpUnread,
  loadNotifySettings,
  type NotifySettings,
  notifySupport,
  saveNotifySettings,
  setBadge,
  shouldNotify,
  showNotification,
  totalUnread,
} from "./notifications";

const iconCache = new Map<string, Promise<string | undefined>>();
function agentIcon(agent: Agent | undefined): Promise<string | undefined> {
  if (!agent) return Promise.resolve(undefined);
  const fb = defaultAvatar(agent.name);
  const shape = agent.avatarShape ?? fb.shape;
  const color = agent.color || fb.color;
  const key = `${shape}:${color}`;
  let p = iconCache.get(key);
  if (!p) {
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() => root.render(<BotAvatar shape={shape} color={color} size={128} />));
    p = avatarIcon(host.querySelector("svg"), color).finally(() => root.unmount());
    iconCache.set(key, p);
  }
  return p;
}

/**
 * Global activity: sidebar busy flags, desktop/web notifications, unread counts and the dock badge.
 * Suppressed while the window is focused and that conversation is open.
 */
export function useNotifications(o: {
  subscribe: (fn: (e: WsEvent) => void) => () => void;
  agents: Agent[];
  openRoomId: string | null;
  open: (roomId: string) => void;
  setRooms: React.Dispatch<React.SetStateAction<Room[]>>;
}) {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const ctx = useRef(o);
  ctx.current = o;
  const seen = useRef(new Set<string>());
  useEffect(
    () =>
      o.subscribe((e) => {
        if (e.type === "activity") {
          ctx.current.setRooms((rs) => rs.map((r) => (r.id === e.roomId ? { ...r, busy: e.busy } : r)));
          return;
        }
        if (e.type !== "notify" || seen.current.has(`${e.kind}:${e.id}`)) return;
        seen.current.add(`${e.kind}:${e.id}`);
        const focused = document.hasFocus() && !document.hidden;
        const settings = loadNotifySettings();
        const looking = focused && ctx.current.openRoomId === e.roomId;
        if (!looking) setUnread((u) => bumpUnread(u, e.roomId));
        if (!shouldNotify(e, { settings, focused, openRoomId: ctx.current.openRoomId })) return;
        const agent = ctx.current.agents.find((a) => a.id === e.agentId);
        void agentIcon(agent).then((icon) =>
          showNotification({ title: titleFor(e), body: e.text, roomId: e.roomId, icon }, (id) => ctx.current.open(id)),
        );
      }),
    [o.subscribe],
  );
  // Opening (and looking at) a conversation clears its unread count.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the open conversation changes
  useEffect(() => {
    const clear = () => {
      const id = ctx.current.openRoomId;
      if (id && document.hasFocus()) setUnread((u) => (u[id] ? { ...u, [id]: 0 } : u));
    };
    clear();
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, [o.openRoomId]);
  useEffect(() => setBadge(totalUnread(unread)), [unread]);
  useEffect(() => bridge()?.onOpenRoom?.((id) => ctx.current.open(id)), []);
  return unread;
}

function titleFor(e: Extract<GlobalEvent, { type: "notify" }>): string {
  if (e.kind === "permission") return `${e.agentName} · 需要你批准`;
  if (e.kind === "auth") return `${e.agentName} · 需要登录或 Key`;
  if (e.kind === "error") return `${e.agentName} · 出错了`;
  return e.agentName;
}

const KIND_HINT: Record<NotifyKind, string> = {
  reply: "Agent 回复完成时",
  permission: "Agent 要执行操作、等你批准时",
  error: "回复失败时",
  auth: "需要登录或 API Key 时",
};

export function NotificationsPage() {
  const [s, setS] = useState<NotifySettings>(loadNotifySettings);
  const [test, setTest] = useState<string | null>(null);
  const support = notifySupport();
  const update = useCallback((patch: Partial<NotifySettings>) => {
    setS((cur) => {
      const next = { ...cur, ...patch };
      saveNotifySettings(next);
      return next;
    });
  }, []);
  const sendTest = async () => {
    setTest(null);
    const r = await showNotification({ title: "团团", body: "这是一条测试通知", roomId: "" }, () => {}).catch(
      () => "unsupported" as const,
    );
    setTest(
      r === "shown"
        ? "已发送。没看到的话，检查系统设置里团团的通知权限。"
        : r === "denied"
          ? "浏览器拒绝了通知权限，可在地址栏左侧的站点设置里打开。"
          : "这个环境不支持系统通知。",
    );
  };
  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>通知</h2>
        </div>
      </header>
      <div className="page">
        <div className="page-inner">
          <section className="card">
            <div className="card-head">
              <h3>系统通知</h3>
              <p>
                {support === "desktop"
                  ? "团团在后台或你没在看那个会话时提醒你。第一次发送时 macOS 会询问权限。"
                  : support === "web"
                    ? "浏览器里用网页通知；第一次发送时浏览器会询问权限。"
                    : "这个环境不支持系统通知。"}
              </p>
            </div>
            <div className="card-body notify-list">
              <label className="notify-row">
                <span className="notify-ico">
                  <BellRing size={15} />
                </span>
                <span className="grow">
                  <b>开启通知</b>
                </span>
                <input
                  type="checkbox"
                  className="tg"
                  aria-label="开启通知"
                  checked={s.enabled}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
              </label>
              {NOTIFY_KINDS.map((k) => (
                <label key={k} className="notify-row" data-off={!s.enabled || undefined}>
                  <span className="notify-ico">
                    <Bell size={14} />
                  </span>
                  <span className="grow">
                    <b>{NOTIFY_LABEL[k]}</b>
                    <span className="muted">{KIND_HINT[k]}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="tg"
                    aria-label={NOTIFY_LABEL[k]}
                    disabled={!s.enabled}
                    checked={s[k]}
                    onChange={(e) => update({ [k]: e.target.checked } as Partial<NotifySettings>)}
                  />
                </label>
              ))}
              <div className="notify-foot">
                <button type="button" className="btn" disabled={support === "none"} onClick={() => void sendTest()}>
                  发送测试通知
                </button>
                {test && (
                  <span className="muted" role="status">
                    {test}
                  </span>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
