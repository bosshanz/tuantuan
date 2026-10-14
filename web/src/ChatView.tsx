import {
  AlertTriangle,
  ArrowRightLeft,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  CircleStop,
  History,
  ImagePlus,
  Loader2,
  PanelRight,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyUpdate, emptyTimeline, type ReplayTurn, type Timeline, timelineText } from "../../shared/timeline";
import {
  type Agent,
  api,
  type Message,
  type PermissionAsk,
  type Room,
  type RoomState,
  type SessionView,
  type TerminalSnapshot,
  type WsEvent,
} from "./api";
import { agentActivity, messageExpression } from "./avatarState";
import { PermissionDialog, SessionBar, TimelineView } from "./Harness";
import { mergeMessages, upsertMessage } from "./messageMerge";
import { usePresence } from "./motion";
import { PickList } from "./PickList";
import { AgentAvatar, formatTime, HumanAvatar, MessageMarkdown, RoomIcon, roomSubtitle, useMediaQuery } from "./ui";

const GROUP_GAP_MS = 5 * 60 * 1000;

interface ImageAttachment {
  mimeType: string;
  data: string;
}

function readImage(f: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mimeType: f.type, data: String(r.result).replace(/^data:[^,]*,/, "") });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

export function ChatView(props: {
  room: Room;
  agents: Agent[];
  userName: string;
  harnessName: (id: string) => string;
  subscribeEvents: (fn: (e: WsEvent) => void) => () => void;
  onBack: () => void;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room, agents } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<RoomState>({ activeRunId: null, queued: 0 });
  const [sessions, setSessions] = useState<Record<string, SessionView>>({});
  const [asks, setAsks] = useState<PermissionAsk[]>([]);
  const [terminals, setTerminals] = useState<Record<string, TerminalSnapshot>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replay, setReplay] = useState<ReplayTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1181px)");
  const [panel, setPanel] = useState(false);
  const panelPresence = usePresence(panel, 180);
  const listRef = useRef<HTMLDivElement>(null);
  const members = useMemo(
    () => room.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [room.agentIds, agents],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mentionNames = useMemo(() => [...agents.map((a) => a.name), "所有人", "all", "everyone"], [agents]);
  // The agent the composer talks to by default: the DM partner, or the group's main agent.
  const primary = room.kind === "dm" ? members[0] : (members.find((a) => a.id === room.mainAgentId) ?? members[0]);
  const primaryView = primary ? sessions[primary.id] : undefined;

  useEffect(() => {
    let alive = true;
    setSessions({});
    setAsks([]);
    const load = async () => {
      try {
        const data = await api<{
          messages: Message[];
          state: RoomState;
          sessions: Record<string, SessionView>;
          asks: PermissionAsk[];
        }>("GET", `/api/rooms/${room.id}/messages?limit=200`);
        if (!alive) return;
        // A snapshot can be older than live events that arrived while it was in flight: merge, never replace.
        setMessages((prev) => mergeMessages(data.messages, prev, room.id));
        setState(data.state);
        setSessions((s) => ({ ...data.sessions, ...s }));
        setAsks(data.asks);
        setLoadError(null);
      } catch (e) {
        if (alive) setLoadError((e as Error).message);
      }
    };
    void load();
    const off = props.subscribeEvents((e) => {
      if (e.type === "subscribed" && e.roomId === room.id) {
        setState(e.state);
        void load();
      } else if (e.type === "message" && e.message.roomId === room.id) {
        setMessages((ms) => upsertMessage(ms, e.message));
      } else if (e.type === "update" && e.roomId === room.id) {
        setMessages((ms) =>
          ms.map((m) => {
            if (m.id !== e.messageId) return m;
            const timeline = applyUpdate(m.timeline ?? emptyTimeline(), e.update);
            return { ...m, timeline, content: timelineText(timeline) };
          }),
        );
      } else if (e.type === "session" && e.roomId === room.id) {
        setSessions((s) => ({ ...s, [e.agentId]: e.view }));
      } else if (e.type === "permission" && e.roomId === room.id) {
        const ask = e.ask;
        setAsks((a) => (ask ? [...a.filter((x) => x.id !== ask.id), ask] : a.filter((x) => x.id !== e.resolvedId)));
      } else if (e.type === "terminal" && e.roomId === room.id) {
        setTerminals((t) => ({ ...t, [e.terminal.terminalId]: e.terminal }));
      } else if (e.type === "room.state" && e.roomId === room.id) {
        setState(e.state);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [room.id, props.subscribeEvents]);

  // Warm up the primary agent's session so pickers and slash commands are there before the first message.
  useEffect(() => {
    if (!primary?.harness || sessions[primary.id]) return;
    api<SessionView>("GET", `/api/rooms/${room.id}/agents/${primary.id}/session`).then(
      (v) => setSessions((s) => ({ ...s, [primary.id]: v })),
      () => {}, // errors (not installed / login needed) surface when a message is sent
    );
  }, [room.id, primary?.id, primary?.harness, sessions]);

  // After switching to an older harness session, show what it replayed that this room doesn't have.
  const primarySession = primaryView?.sessionId ?? null;
  const primaryId = primary?.id;
  useEffect(() => {
    setReplay([]);
    if (!primaryId || !primarySession) return;
    api<ReplayTurn[]>("GET", `/api/rooms/${room.id}/agents/${primaryId}/replay`).then(setReplay, () => {});
  }, [room.id, primaryId, primarySession]);

  // Open at the latest message; afterwards stick to the bottom only when the reader is already there.
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on every content change
  useEffect(() => {
    const el = listRef.current;
    if (!el || messages.length === 0) return;
    if (!opened.current || el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
    opened.current = true;
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content && images.length === 0) return;
    setSendError(null);
    setDraft("");
    const imgs = images;
    setImages([]);
    try {
      const sent = await api<Message>("POST", `/api/rooms/${room.id}/messages`, {
        senderName: props.userName,
        content,
        images: imgs,
      });
      // The server's reply is authoritative: show it now even if the socket is slow, reconnecting or raced.
      setMessages((ms) => upsertMessage(ms, sent));
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e) {
      setDraft(content);
      setImages(imgs);
      setSendError(`发送失败：${(e as Error).message}`);
    }
  };

  const cancel = async () => {
    try {
      await api("POST", `/api/rooms/${room.id}/cancel`);
    } catch (e) {
      setSendError(`取消失败：${(e as Error).message}`);
    }
  };

  const answer = useCallback(async (askId: string, optionId: string | null) => {
    setAsks((a) => a.filter((x) => x.id !== askId));
    await api("POST", `/api/permissions/${askId}`, { optionId }).catch(() => {});
  }, []);

  const sessionCall = async (path: string, body: unknown) => {
    if (!primary) return;
    try {
      const v = await api<SessionView>("POST", `/api/rooms/${room.id}/agents/${primary.id}/${path}`, body);
      setSessions((s) => ({ ...s, [primary.id]: v }));
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const openDetails = (id: string) => {
    setSelected((cur) => (cur === id && panel ? null : id));
    setPanel(true);
  };

  const groups = groupMessages(messages);
  const running = state.activeRunId !== null;
  const replying = messages.findLast((m) => m.status === "streaming");
  const selectedMsg = messages.find((m) => m.id === selected);
  const ask = asks[0];

  return (
    <div className="chat-wrap">
      <div className="chat">
        <header className="main-head">
          <button
            type="button"
            className="btn ghost icon back-btn"
            onClick={props.onBack}
            aria-label="返回会话列表"
            data-shot="open-nav"
          >
            <ChevronLeft size={18} />
          </button>
          <RoomIcon room={room} agents={agents} />
          <div className="title">
            <h2>{room.name}</h2>
            <div className="sub">{roomSubtitle(room, agents)}</div>
          </div>
          {!(panel && wide) && (
            <button
              type="button"
              className="btn ghost icon"
              aria-pressed={panel}
              aria-label={panel ? "收起详情面板" : "展开详情面板"}
              title="详情面板"
              onClick={() => {
                setPanel((v) => !v);
                setSelected(null);
              }}
            >
              <PanelRight size={18} />
            </button>
          )}
        </header>

        {loadError && (
          <div className="form-error" role="alert" style={{ margin: 12 }}>
            <AlertTriangle size={15} /> 消息加载失败：{loadError}
          </div>
        )}

        <div className="messages" ref={listRef}>
          {messages.length === 0 && replay.length === 0 && !loadError && (
            <div className="empty">
              <RoomIcon room={room} agents={agents} />
              <h2 style={{ fontSize: 17 }}>
                {room.kind === "group" ? "开始聊天" : `和 ${members[0]?.name ?? "Agent"} 打个招呼`}
              </h2>
              {primary && !primary.harness && (
                <p className="muted">
                  {primary.name} 还没有绑定 Harness，<a href={`#/a/${primary.id}`}>去设置</a>或
                  <a href="#/setup">打开新手引导</a>。
                </p>
              )}
              {room.kind === "group" && members.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                  {members.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="chip-btn"
                      onClick={() => setDraft((d) => `${d}@${a.name} `)}
                    >
                      <AgentAvatar agent={a} size={16} />
                      <span>@{a.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {replay.length > 0 && primary && (
            <ReplayHistory turns={replay} agentName={primary.name} terminals={terminals} />
          )}
          {groups.map((g) =>
            g.kind === "system" ? (
              <div key={g.messages[0]?.id} className="system-line" role="note">
                <span>{g.messages[0]?.content}</span>
              </div>
            ) : (
              <div key={g.messages[0]?.id} className="msg-group">
                {g.kind === "agent" ? (
                  <LiveAvatar agent={agentById.get(g.senderId ?? "")} name={g.senderName} last={g.messages.at(-1)} />
                ) : (
                  <HumanAvatar name={g.senderName} size={36} />
                )}
                <div className="msg-head">
                  <span className="name">{g.senderName}</span>
                  {g.kind === "agent" && !agentById.has(g.senderId ?? "") && <span className="badge">已删除</span>}
                  <span className="time">{formatTime(g.messages[0]?.createdAt ?? 0)}</span>
                </div>
                {g.messages.map((m) => (
                  <MessageItem
                    key={m.id}
                    m={m}
                    terminals={terminals}
                    mentionNames={mentionNames}
                    selected={selected === m.id && panel}
                    onDetails={() => openDetails(m.id)}
                  />
                ))}
              </div>
            ),
          )}
        </div>

        <footer className="composer">
          {(running || state.queued > 0) && (
            <div className="run-bar" role="status">
              <Loader2 size={14} className="spin" />
              <span className="grow">
                {replying ? `${replying.senderName} 正在回复…` : "正在准备回复…"}
                {state.queued > 0 && ` · ${state.queued} 条消息排队中`}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void cancel()}
                disabled={!running}
                title="停止回复"
              >
                <CircleStop size={13} />
                停止
              </button>
            </div>
          )}
          {sendError && (
            <div className="error-text" role="alert" style={{ marginBottom: 6 }}>
              {sendError}
            </div>
          )}
          {primaryView && (
            <SessionBar
              view={primaryView}
              onConfig={(configId, value) => void sessionCall("config", { configId, value })}
              onMode={(modeId) => void sessionCall("mode", { modeId })}
            />
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void send()}
            members={room.kind === "group" ? members : []}
            interrupts={room.kind === "group" && running}
            placeholder={primaryView?.commands.length ? "发消息，/ 查看命令…" : "发消息…"}
            commands={primaryView?.commands ?? []}
            images={images}
            onImages={setImages}
            imageNote={primaryView && !primaryView.capabilities.image ? null : ""}
          />
        </footer>
      </div>

      {ask && (
        <PermissionDialog
          key={ask.id}
          ask={ask}
          agentName={agentById.get(ask.agentId)?.name ?? "Agent"}
          terminals={terminals}
          onAnswer={(optionId) => void answer(ask.id, optionId)}
        />
      )}

      {panelPresence.mounted && (
        <>
          {!wide && (
            // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes the overlay panel; the close button is the keyboard path
            // biome-ignore lint/a11y/useKeyWithClickEvents: see above
            <div className="scrim" data-state={panelPresence.state} onClick={() => setPanel(false)} />
          )}
          <aside className="details" data-state={panelPresence.state} aria-label="详情面板">
            <div className="details-head">
              {selectedMsg && (
                <button
                  type="button"
                  className="btn ghost icon"
                  aria-label="返回会话信息"
                  title="返回会话信息"
                  onClick={() => setSelected(null)}
                >
                  <ChevronLeft size={16} />
                </button>
              )}
              <h3>{selectedMsg ? "回复详情" : "会话信息"}</h3>
              <div className="details-actions">
                <button
                  type="button"
                  className="btn ghost icon"
                  aria-label="关闭详情面板"
                  onClick={() => setPanel(false)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="details-body">
              {selectedMsg ? (
                <MessageDetails
                  m={selectedMsg}
                  agent={agentById.get(selectedMsg.senderId ?? "")}
                  harnessName={props.harnessName}
                />
              ) : (
                <RoomInfo
                  room={room}
                  agents={agents}
                  members={members}
                  messages={messages}
                  sessions={sessions}
                  harnessName={props.harnessName}
                  onRoomChange={props.onRoomChange}
                  onDeleted={props.onDeleted}
                />
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

type Group = { kind: Message["senderKind"]; senderId: string | null; senderName: string; messages: Message[] };

/** Consecutive messages from the same speaker within 5 minutes share one header. */
function groupMessages(messages: Message[]): Group[] {
  const out: Group[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    const prev = last?.messages.at(-1);
    if (
      last &&
      prev &&
      m.senderKind !== "system" &&
      last.kind === m.senderKind &&
      last.senderId === m.senderId &&
      last.senderName === m.senderName &&
      m.createdAt - prev.createdAt < GROUP_GAP_MS
    )
      last.messages.push(m);
    else out.push({ kind: m.senderKind, senderId: m.senderId, senderName: m.senderName, messages: [m] });
  }
  return out;
}

function MessageItem(props: {
  m: Message;
  terminals: Record<string, TerminalSnapshot>;
  mentionNames: string[];
  selected: boolean;
  onDetails: () => void;
}) {
  const { m } = props;
  const streaming = m.status === "streaming";
  const t = withoutHandoffTools(m.timeline);
  const empty = !t || t.parts.length === 0;
  return (
    <div className="msg" data-status={m.status} data-fresh={Date.now() - m.createdAt < 4000 ? "" : undefined}>
      {t?.handoffFrom && (
        <div className="handoff-from">
          <ArrowRightLeft size={12} />
          <span>
            接 <b>@{t.handoffFrom.agentName}</b> 的交接：{t.handoffFrom.task}
          </span>
        </div>
      )}
      {m.senderKind === "human" ? (
        <>
          {m.content && <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />}
          {t && <TimelineView t={t} streaming={false} terminals={props.terminals} mentionNames={props.mentionNames} />}
        </>
      ) : t ? (
        <TimelineView t={t} streaming={streaming} terminals={props.terminals} mentionNames={props.mentionNames} />
      ) : (
        m.content && <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
      )}
      {t?.handoffs?.map((h) => (
        <div key={h.agentId} className="handoff-card" role="note">
          <div className="handoff-title">
            <ArrowRightLeft size={13} />
            交接给 <b>@{h.agentName}</b>
          </div>
          <p>{h.task}</p>
        </div>
      ))}
      {m.senderKind === "agent" && empty && !m.content && streaming && (
        <span className="typing">
          <i />
          <i />
          <i />
          正在思考
        </span>
      )}
      {m.senderKind === "agent" && empty && !m.content && m.status === "done" && (
        <span className="muted">（空回复）</span>
      )}
      {m.status === "error" && (
        <div className="msg-error" role="alert">
          <AlertTriangle size={14} />
          <span>{m.error ?? "回复失败"}</span>
        </div>
      )}
      {m.status === "interrupted" && (
        <div className="msg-error">
          <AlertTriangle size={14} />
          <span>{m.error ?? "回复被中断"}</span>
        </div>
      )}
      {m.senderKind === "agent" && !streaming && (
        <div className="msg-meta">
          {m.status === "cancelled" && (
            <span className="state-tag">
              <CircleSlash size={11} />
              {m.error === "被新消息打断" ? "被新消息打断" : "已停止"}
            </span>
          )}
          <button
            type="button"
            className="trace"
            aria-pressed={props.selected}
            onClick={props.onDetails}
            data-shot="expand"
            title="查看详情"
          >
            {t && Object.keys(t.tools).length > 0 && <span>{Object.keys(t.tools).length} 次工具调用</span>}
            <span>详情</span>
            <ChevronRight size={11} className="chev" />
          </button>
        </div>
      )}
    </div>
  );
}

/** The handoff tool call is shown as a hand-off card instead of a generic tool card. */
function withoutHandoffTools(t: Timeline | null): Timeline | null {
  if (!t?.handoffs?.length) return t;
  const hide = new Set(
    Object.values(t.tools)
      .filter((x) => /handoff/i.test(x.title))
      .map((x) => x.toolCallId),
  );
  if (hide.size === 0) return t;
  return { ...t, parts: t.parts.filter((p) => !(p.kind === "tool" && hide.has(p.toolCallId))) };
}

/** History a harness replayed on session/load that this room never showed (read-only). */
function ReplayHistory(props: { turns: ReplayTurn[]; agentName: string; terminals: Record<string, TerminalSnapshot> }) {
  return (
    <details className="replay" open>
      <summary>
        <History size={13} /> 载入的 Harness 历史 · {props.turns.length} 轮
      </summary>
      {props.turns.map((turn, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: replayed turns have no ids and never reorder
        <div key={i} className="replay-turn">
          {turn.user && (
            <div className="replay-user">
              <span className="name">我</span>
              <MessageMarkdown text={turn.user} mentionNames={[]} />
            </div>
          )}
          <div className="replay-agent">
            <span className="name">{props.agentName}</span>
            <TimelineView t={turn.reply} streaming={false} terminals={props.terminals} mentionNames={[]} />
          </div>
        </div>
      ))}
    </details>
  );
}

const STOP_LABEL: Record<string, string> = {
  end_turn: "正常结束",
  cancelled: "已取消",
  refusal: "拒绝",
  max_tokens: "达到 token 上限",
  max_turn_requests: "达到轮次上限",
};

function MessageDetails(props: { m: Message; agent?: Agent; harnessName: (id: string) => string }) {
  const { m, agent } = props;
  const tools = Object.values(m.timeline?.tools ?? {});
  return (
    <section className="d-section">
      <dl className="kv">
        <dt>Agent</dt>
        <dd>{m.senderName}</dd>
        <dt>Harness</dt>
        <dd>{agent?.harness ? props.harnessName(agent.harness) : "—"}</dd>
        <dt>状态</dt>
        <dd>
          {m.timeline?.stopReason ? (STOP_LABEL[m.timeline.stopReason] ?? m.timeline.stopReason) : m.status}
          {m.error && <div className="error-text">{m.error}</div>}
        </dd>
        <dt>工具</dt>
        <dd>{tools.length === 0 ? "无" : tools.map((t) => t.title).join("、")}</dd>
        <dt>时间</dt>
        <dd>{new Date(m.createdAt).toLocaleString()}</dd>
      </dl>
    </section>
  );
}

/** Harness session controls for one agent: current session, new session, sessions the harness remembers. */
function SessionSection(props: { room: Room; agent: Agent; view?: SessionView; solo: boolean }) {
  const { room, agent, view } = props;
  const [list, setList] = useState<{ sessionId: string; title?: string | null; updatedAt?: string | null }[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const base = `/api/rooms/${room.id}/agents/${agent.id}`;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="d-section">
      <h4 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {props.solo ? "Harness 会话" : `${agent.name} 的会话`}
        <span style={{ display: "flex", gap: 4 }}>
          {view?.capabilities.list && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void run(async () => setList(await api("GET", `${base}/history`)))}
            >
              <History size={13} />
              历史
            </button>
          )}
          <button
            type="button"
            className="btn ghost sm"
            title="开始新的 Harness 会话（聊天记录保留）"
            onClick={() => void run(() => api("POST", `${base}/session`, { sessionId: null }))}
          >
            <Plus size={13} />
            新会话
          </button>
        </span>
      </h4>
      {view ? (
        <dl className="kv">
          <dt>会话</dt>
          <dd>
            <code style={{ fontSize: 11 }}>{view.sessionId}</code>
            {view.title && <div className="muted">{view.title}</div>}
          </dd>
          {view.usage && (
            <>
              <dt>上下文</dt>
              <dd>
                {view.usage.used.toLocaleString()} / {view.usage.size.toLocaleString()}
                {view.usage.cost && ` · ${view.usage.cost.amount.toFixed(4)} ${view.usage.cost.currency}`}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          发第一条消息时启动。
        </p>
      )}
      {list && (
        <div className="session-list">
          {list.length === 0 && <p className="muted">没有可恢复的会话。</p>}
          {list.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              className="pop-item"
              aria-current={s.sessionId === view?.sessionId}
              onClick={() =>
                void run(async () => {
                  await api("POST", `${base}/session`, { sessionId: s.sessionId });
                  setList(null);
                })
              }
            >
              <span>{s.title || s.sessionId}</span>
              {s.updatedAt && <span className="pop-hint muted">{new Date(s.updatedAt).toLocaleDateString()}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

function RoomInfo(props: {
  room: Room;
  agents: Agent[];
  members: Agent[];
  messages: Message[];
  sessions: Record<string, SessionView>;
  harnessName: (id: string) => string;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room } = props;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState(room.cwd);
  useEffect(() => setCwd(room.cwd), [room.cwd]);
  const replyCount = new Map<string, number>();
  for (const m of props.messages)
    if (m.senderKind === "agent" && m.senderId) replyCount.set(m.senderId, (replyCount.get(m.senderId) ?? 0) + 1);
  const patch = async (body: { mainAgentId?: string; cwd?: string }) => {
    try {
      await api("PATCH", `/api/rooms/${room.id}`, body);
      await props.onRoomChange();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = async (id: string) => {
    const next = room.agentIds.includes(id) ? room.agentIds.filter((x) => x !== id) : [...room.agentIds, id];
    try {
      await api("PUT", `/api/rooms/${room.id}/agents`, { agentIds: next });
      await props.onRoomChange();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <section className="d-section">
        <h4 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {room.kind === "group" ? `成员（${props.members.length}）` : "对话 Agent"}
          {room.kind === "group" && (
            <button type="button" className="btn ghost sm" onClick={() => setEditing((v) => !v)}>
              {editing ? "完成" : "管理成员"}
            </button>
          )}
        </h4>
        {editing ? (
          <PickList
            searchPlaceholder="搜索 Agent"
            emptyText="还没有 Agent"
            groups={[
              {
                items: props.agents.map((a) => ({
                  id: a.id,
                  title: a.name,
                  leading: <AgentAvatar agent={a} size={22} />,
                  plain: true,
                })),
              },
            ]}
            selected={room.agentIds}
            onToggle={(id) => void toggle(id)}
          />
        ) : (
          <>
            {props.members.length === 0 && <p className="muted">没有 Agent 成员。</p>}
            {props.members.map((a) => {
              const n = replyCount.get(a.id) ?? 0;
              const doing = agentActivity(a.id, props.messages);
              return (
                <a key={a.id} className="member-row" href={`#/a/${a.id}`} title="编辑这个 Agent">
                  <AgentAvatar agent={a} size={32} expression={doing} animate />
                  <span className="member-body">
                    <span className="member-name">{a.name}</span>
                    <span className="member-sub">
                      {a.harness ? props.harnessName(a.harness) : "未绑定 Harness"}
                      {room.mainAgentId === a.id && " · 主 Agent"}
                    </span>
                  </span>
                  {n > 0 && (
                    <span className="member-count" title="本会话回复数">
                      {n}
                    </span>
                  )}
                </a>
              );
            })}
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </section>
      {room.kind === "group" && (
        <section className="d-section">
          <h4>群设置</h4>
          <label className="field">
            <span className="label">主 Agent（没有 @ 时由它回复）</span>
            <select
              className="select"
              aria-label="主 Agent"
              value={room.mainAgentId ?? ""}
              onChange={(e) => void patch({ mainAgentId: e.target.value })}
            >
              {props.members.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">共享工作目录</span>
            <input
              className="input mono"
              value={cwd}
              placeholder="~（主目录）"
              onChange={(e) => setCwd(e.target.value)}
              onBlur={() => cwd !== room.cwd && void patch({ cwd })}
              spellCheck={false}
            />
          </label>
        </section>
      )}
      {props.members.map((a) =>
        a.harness ? (
          <SessionSection key={a.id} room={room} agent={a} view={props.sessions[a.id]} solo={room.kind === "dm"} />
        ) : null,
      )}
      <section className="d-section" style={{ marginTop: "auto" }}>
        <button
          type="button"
          className="btn danger"
          onClick={async () => {
            if (!confirm(`删除会话「${room.name}」及其全部消息？此操作不可撤销。`)) return;
            await api("DELETE", `/api/rooms/${room.id}`).then(props.onDeleted, (e) => setError((e as Error).message));
          }}
        >
          <Trash2 size={14} />
          删除会话
        </button>
      </section>
    </>
  );
}

const EVERYONE = { id: "__everyone", name: "所有人" } as const;

function Composer(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  members: Agent[];
  /** Group chain running: sending will interrupt it. */
  interrupts: boolean;
  placeholder: string;
  commands: { name: string; description: string }[];
  images: ImageAttachment[];
  onImages: (imgs: ImageAttachment[]) => void;
  /** null = the harness does not take images (button hidden). */
  imageNote: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = async (files: Iterable<File>) => {
    const next = [...props.images];
    for (const f of files) if (f.type.startsWith("image/")) next.push(await readImage(f));
    props.onImages(next.slice(0, 8));
  };
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = /(?:^|\s)@([^\s@]*)$/.exec(props.value.slice(0, caret));
  const q = (query?.[1] ?? "").toLowerCase();
  // "所有人" is offered first in groups with 2+ agents; it matches 所有人 / all / everyone.
  const everyone =
    props.members.length > 1 && ["所有人", "all", "everyone"].some((n) => n.startsWith(q) || n.includes(q));
  const options: (Agent | typeof EVERYONE)[] =
    query && !dismissed
      ? [...(everyone ? [EVERYONE] : []), ...props.members.filter((a) => a.name.toLowerCase().includes(q))]
      : [];
  // Slash commands come from the harness (available_commands_update); typed at the very start.
  const slash = /^\/(\S*)$/.exec(props.value.slice(0, caret));
  const commands =
    slash && !dismissed && options.length === 0
      ? props.commands.filter((c) => c.name.toLowerCase().startsWith((slash[1] ?? "").toLowerCase())).slice(0, 12)
      : [];
  const pickCommand = (name: string) => {
    const v = `/${name} `;
    props.onChange(v + props.value.slice(caret));
    setCaret(v.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(v.length, v.length);
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on value change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [props.value]);

  const pick = (a: Pick<Agent, "name">) => {
    const before = props.value.slice(0, caret).replace(/@[^\s@]*$/, `@${a.name} `);
    props.onChange(before + props.value.slice(caret));
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping images is a shortcut; the image button is the accessible path
    <div
      className="composer-box"
      onDragOver={(e) => props.imageNote !== null && e.preventDefault()}
      onDrop={(e) => {
        if (props.imageNote === null) return;
        e.preventDefault();
        void addFiles(e.dataTransfer.files);
      }}
    >
      {commands.length > 0 && (
        <div className="popover mention-pop slash-pop" role="listbox" aria-label="斜杠命令">
          <div className="pop-title">命令</div>
          {commands.map((c, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active % commands.length}
              key={c.name}
              className="pop-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pickCommand(c.name);
              }}
            >
              <code className="slash-name">/{c.name}</code>
              <span className="muted">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {props.images.length > 0 && (
        <div className="attach-row">
          {props.images.map((img, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments are a short local list
            <span key={i} className="attach">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={`附件 ${i + 1}`} />
              <button
                type="button"
                aria-label="移除图片"
                onClick={() => props.onImages(props.images.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {options.length > 0 && (
        <div className="popover mention-pop" role="listbox" aria-label="选择要 @ 的 Agent">
          <div className="pop-title">提及 Agent</div>
          {options.map((a, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={a.id}
              className="pop-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(a);
              }}
            >
              {a === EVERYONE ? (
                <span className="room-icon" style={{ ["--size" as string]: "22px" }}>
                  <Users size={13} />
                </span>
              ) : (
                <AgentAvatar agent={a as Agent} size={22} />
              )}
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={props.value}
        aria-label="消息输入框"
        placeholder={props.placeholder}
        onChange={(e) => {
          props.onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
          if (files.length > 0 && props.imageNote !== null) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (commands.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
          } else if (commands.length > 0 && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
            const c = commands[active % commands.length] as { name: string };
            if (props.value.trim() !== `/${c.name}`) {
              e.preventDefault();
              pickCommand(c.name);
            } else if (e.key === "Enter") {
              e.preventDefault();
              props.onSubmit();
            }
          } else if (commands.length > 0 && e.key === "Escape") {
            setDismissed(true);
          } else if (options.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (options.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(options[active] ?? (options[0] as Agent));
          } else if (options.length > 0 && e.key === "Escape") {
            setDismissed(true);
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />
      <div className="composer-foot">
        {props.imageNote !== null && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(e.target.files ?? []);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label="添加图片"
              title={props.imageNote || "添加图片"}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={16} />
            </button>
          </>
        )}
        {props.members.length > 0 && props.value.trim() ? (
          <Recipients text={props.value} members={props.members} interrupts={props.interrupts} />
        ) : (
          <span className="grow" />
        )}
        <button
          type="button"
          className="send-btn"
          onClick={props.onSubmit}
          disabled={!props.value.trim() && props.images.length === 0}
          aria-label="发送"
        >
          <ArrowUp size={17} />
        </button>
      </div>
    </div>
  );
}

const EVERYONE_RE = /(^|[^\w.])@(所有人|all|everyone)(?![\w\u4e00-\u9fff])/i;

/** Live preview of who will answer the draft, mirroring the server's group rules. */
function Recipients(props: { text: string; members: Agent[]; interrupts: boolean }) {
  const lower = props.text.toLowerCase();
  const named = props.members.filter((a) => lower.includes(`@${a.name.toLowerCase()}`));
  const everyone = EVERYONE_RE.test(props.text);
  return (
    <span className="recipients" aria-live="polite">
      {everyone ? (
        <span className="rcpt">
          <Users size={12} />
          所有人
        </span>
      ) : (
        named.map((a) => (
          <span key={a.id} className="rcpt" title={`发给 ${a.name}`}>
            <AgentAvatar agent={a} size={14} />
            {a.name}
          </span>
        ))
      )}
      {props.interrupts && (
        <span className="interrupt-note" title="发送会打断当前回复" role="img" aria-label="发送会打断当前回复">
          <CircleStop size={13} />
        </span>
      )}
    </span>
  );
}

/** Message-column avatar: animated only while this group's latest reply is in flight. */
function LiveAvatar(props: { agent?: Agent; name: string; last?: Message }) {
  const state = props.last ? messageExpression(props.last) : { expression: "idle" as const, live: false };
  return (
    <AgentAvatar
      agent={props.agent}
      name={props.name}
      size={36}
      expression={state.expression}
      animate={state.live}
      pulse={state.live ? props.last?.id : undefined}
    />
  );
}
