import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Loader2,
  PanelRight,
  Route,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, api, type Message, type Room, type RoomState, type RoutingDecision, type WsEvent } from "./api";
import { PickList } from "./PickList";
import { AgentAvatar, formatTime, HumanAvatar, MessageMarkdown, RoomIcon, roomSubtitle, useMediaQuery } from "./ui";

const TYPE_LABEL: Record<string, string> = {
  chat: "闲聊",
  coding: "编程",
  reasoning: "推理",
  long_context: "长上下文",
  tool_heavy: "工具",
  vision: "视觉",
};
const DIFF_LABEL: Record<string, string> = { easy: "简单", medium: "中等", hard: "困难" };
const GROUP_GAP_MS = 5 * 60 * 1000;

export function ChatView(props: {
  room: Room;
  agents: Agent[];
  userName: string;
  subscribeEvents: (fn: (e: WsEvent) => void) => () => void;
  onBack: () => void;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room, agents } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [routing, setRouting] = useState<Record<string, RoutingDecision>>({});
  const [state, setState] = useState<RoomState>({ activeRunId: null, queued: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const wide = useMediaQuery("(min-width: 1181px)");
  const [panel, setPanel] = useState<boolean>(wide);
  const listRef = useRef<HTMLDivElement>(null);
  const members = useMemo(
    () => room.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [room.agentIds, agents],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const mentionNames = useMemo(() => agents.map((a) => a.name), [agents]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api<{ messages: Message[]; routing: RoutingDecision[]; state: RoomState }>(
          "GET",
          `/api/rooms/${room.id}/messages?limit=200`,
        );
        if (!alive) return;
        // Keep text streamed so far for messages the server has not finished persisting.
        setMessages((prev) =>
          data.messages.map((m) => (m.status === "streaming" ? (prev.find((p) => p.id === m.id) ?? m) : m)),
        );
        setRouting(Object.fromEntries(data.routing.map((r) => [r.messageId, r])));
        setState(data.state);
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
        setMessages((ms) => {
          const i = ms.findIndex((m) => m.id === e.message.id);
          if (i < 0) return [...ms, e.message];
          const copy = [...ms];
          copy[i] = e.message;
          return copy;
        });
      } else if (e.type === "delta" && e.roomId === room.id) {
        setMessages((ms) => ms.map((m) => (m.id === e.messageId ? { ...m, content: m.content + e.text } : m)));
      } else if (e.type === "tools" && e.roomId === room.id) {
        setMessages((ms) => ms.map((m) => (m.id === e.messageId ? { ...m, toolCalls: e.toolCalls } : m)));
      } else if (e.type === "routing" && e.roomId === room.id) {
        setRouting((r) => ({ ...r, [e.decision.messageId]: e.decision }));
      } else if (e.type === "room.state" && e.roomId === room.id) {
        setState(e.state);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [room.id, props.subscribeEvents]);

  // Stick to the bottom only when the reader is already there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on every content change
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    setSendError(null);
    setDraft("");
    try {
      await api("POST", `/api/rooms/${room.id}/messages`, { senderName: props.userName, content });
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch (e) {
      setDraft(content);
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

  const openDetails = (id: string) => {
    setSelected((cur) => (cur === id && panel ? null : id));
    setPanel(true);
  };

  const groups = groupMessages(messages);
  const running = state.activeRunId !== null;
  const replying = messages.findLast((m) => m.status === "streaming");
  const selectedMsg = messages.find((m) => m.id === selected);

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
        </header>

        {loadError && (
          <div className="form-error" role="alert" style={{ margin: 12 }}>
            <AlertTriangle size={15} /> 消息加载失败：{loadError}
          </div>
        )}

        <div className="messages" ref={listRef}>
          {messages.length === 0 && !loadError && (
            <div className="empty">
              <RoomIcon room={room} agents={agents} />
              <h2 style={{ fontSize: 17 }}>
                {room.kind === "group" ? "在群里 @ 一个 Agent 开始吧" : `和 ${members[0]?.name ?? "Agent"} 打个招呼`}
              </h2>
              <p style={{ fontSize: 13 }}>
                {room.kind === "group"
                  ? "只有被 @ 的 Agent 会回复；它们也可以互相 @ 接力。"
                  : "私聊中每条消息都会交给这个 Agent。"}
              </p>
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
          {groups.map((g) =>
            g.kind === "system" ? (
              <div key={g.messages[0]?.id} className="system-line" role="note">
                <span>{g.messages[0]?.content}</span>
              </div>
            ) : (
              <div key={g.messages[0]?.id} className="msg-group">
                {g.kind === "agent" ? (
                  <AgentAvatar agent={agentById.get(g.senderId ?? "")} name={g.senderName} size={36} />
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
                    routing={routing[m.id]}
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
                title="停止当前回复（保留已生成内容），并丢弃排队消息"
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
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => void send()}
            members={room.kind === "group" ? members : []}
            placeholder={
              room.kind === "group"
                ? `发消息到 ${room.name}，用 @ 指定 Agent`
                : `发消息给 ${members[0]?.name ?? "Agent"}`
            }
          />
        </footer>
      </div>

      {panel && (
        <>
          {!wide && (
            // biome-ignore lint/a11y/noStaticElementInteractions: scrim closes the overlay panel; the close button is the keyboard path
            // biome-ignore lint/a11y/useKeyWithClickEvents: see above
            <div className="scrim" onClick={() => setPanel(false)} />
          )}
          <aside className="details" aria-label="详情面板">
            <div className="details-head">
              <h3>{selectedMsg ? "回复详情" : "会话信息"}</h3>
              <div style={{ display: "flex", gap: 4 }}>
                {selectedMsg && (
                  <button type="button" className="btn ghost sm" onClick={() => setSelected(null)}>
                    会话信息
                  </button>
                )}
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
                <MessageDetails m={selectedMsg} d={routing[selectedMsg.id]} />
              ) : (
                <RoomInfo
                  room={room}
                  agents={agents}
                  members={members}
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
  routing?: RoutingDecision;
  mentionNames: string[];
  selected: boolean;
  onDetails: () => void;
}) {
  const { m, routing: d } = props;
  const streaming = m.status === "streaming";
  const fellBack = d?.attempts.some((a) => !a.ok);
  return (
    <div className="msg" data-status={m.status}>
      {m.toolCalls.length > 0 && (
        <div className="tool-list">
          {m.toolCalls.map((c) => (
            <details key={c.id} className="tool">
              <summary>
                <ChevronRight size={14} className="chev" />
                <Wrench size={13} />
                <span className="tool-name">{c.name}</span>
                <span className="tool-args">{c.arguments}</span>
                <ToolStatus status={c.status} />
              </summary>
              <div className="tool-body">
                <span className="k">参数</span>
                <pre>{prettyJson(c.arguments)}</pre>
                {c.result !== undefined && (
                  <>
                    <span className="k">结果</span>
                    <pre>{c.result}</pre>
                  </>
                )}
                {c.error && (
                  <>
                    <span className="k">错误（已原样返回给模型）</span>
                    <pre className="error-text">{c.error}</pre>
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
      {m.content ? (
        <div className={streaming ? "caret-wrap" : undefined}>
          <MessageMarkdown text={m.content} mentionNames={props.mentionNames} />
        </div>
      ) : streaming ? (
        <span className="typing">
          <i />
          <i />
          <i />
          {m.toolCalls.some((c) => c.status === "running") ? "正在调用工具" : "正在思考"}
        </span>
      ) : m.status === "done" ? (
        <span className="muted">（空回复）</span>
      ) : null}
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
      {(m.senderKind === "agent" || m.hop >= 2) && (
        <div className="msg-meta">
          {m.status === "cancelled" && <span className="badge warn">已停止</span>}
          {m.hop >= 2 && <span className="badge accent">Agent 接力 · 第 {m.hop - 1} 跳</span>}
          {d && (
            <button
              type="button"
              className="chip-btn"
              aria-pressed={props.selected}
              onClick={props.onDetails}
              data-shot="expand"
              title="查看路由与工具详情"
            >
              <Route size={11} />
              <span>
                {d.plan.mode === "pinned"
                  ? "固定"
                  : d.plan.classification
                    ? `${TYPE_LABEL[d.plan.classification.taskType]}·${DIFF_LABEL[d.plan.classification.difficulty]}`
                    : "路由"}
                {" → "}
                {d.chosenModel ?? (d.attempts.length ? "全部失败" : "选择中…")}
              </span>
              {fellBack && <span style={{ color: "var(--warn)" }}>· 已回退</span>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStatus({ status }: { status: "running" | "ok" | "error" }) {
  if (status === "running")
    return (
      <span className="tool-status running">
        <Loader2 size={12} className="spin" />
        执行中
      </span>
    );
  if (status === "ok")
    return (
      <span className="tool-status ok">
        <Check size={12} />
        成功
      </span>
    );
  return (
    <span className="tool-status error">
      <X size={12} />
      失败
    </span>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s || "{}";
  }
}

function MessageDetails({ m, d }: { m: Message; d?: RoutingDecision }) {
  const c = d?.plan.classification;
  return (
    <>
      <section className="d-section">
        <h4>模型路由</h4>
        {!d ? (
          <p className="muted">这条消息没有路由记录。</p>
        ) : (
          <dl className="kv">
            <dt>策略</dt>
            <dd>{d.plan.mode === "pinned" ? "固定模型（不回退）" : "Auto 路由"}</dd>
            {c && (
              <>
                <dt>任务</dt>
                <dd>
                  {TYPE_LABEL[c.taskType]} · {DIFF_LABEL[c.difficulty]}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {c.source === "systemone"
                      ? `由决策模型 ${c.decision?.model ?? ""} 分类`
                      : c.source === "llm"
                        ? `由 ${c.classifierModel} 分类`
                        : "规则分类"}
                  </div>
                  {c.decision && !c.decision.error && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.decision.taskType && (
                        <>
                          类型 {c.decision.taskType.choice} 置信度 {c.decision.taskType.confidence.toFixed(2)}
                          {c.decision.taskType.used ? "" : "（未采用）"}
                        </>
                      )}
                      {c.decision.difficulty && (
                        <>
                          {" · "}难度 {c.decision.difficulty.score.toFixed(2)} 置信度{" "}
                          {c.decision.difficulty.confidence.toFixed(2)}
                          {c.decision.difficulty.used ? "" : "（未采用）"}
                        </>
                      )}
                      {c.decision.needsTools !== undefined && <> · 需工具 {c.decision.needsTools.toFixed(2)}</>}
                      {c.decision.latencyMs !== undefined && <> · {Math.round(c.decision.latencyMs)}ms</>}
                    </div>
                  )}
                  {c.fallbackReason && <div className="warn-text">{c.fallbackReason}</div>}
                  {c.note && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.note}
                    </div>
                  )}
                  {c.classifierError && <div className="error-text">分类模型失败，已改用规则：{c.classifierError}</div>}
                </dd>
              </>
            )}
            <dt>最终模型</dt>
            <dd>
              {d.chosenModel ? (
                <span className="badge ok">{d.chosenModel}</span>
              ) : (
                <span className="badge danger">{d.attempts.length ? "全部失败" : "进行中"}</span>
              )}
            </dd>
            <dt>候选顺序</dt>
            <dd className="cand">
              {d.plan.candidates.length === 0
                ? "无"
                : d.plan.candidates.map((id, i) => (
                    <Fragment key={id}>
                      {i > 0 && <ChevronRight size={12} className="muted" />}
                      <code style={{ fontSize: 12 }}>{id}</code>
                    </Fragment>
                  ))}
            </dd>
            <dt>理由</dt>
            <dd>{d.plan.reason}</dd>
            <dt>输入</dt>
            <dd>
              约 {d.plan.signals.contextTokens} token 上下文 · {d.plan.signals.toolCount} 个工具
            </dd>
            <dt>尝试</dt>
            <dd>
              {d.attempts.length === 0 ? (
                <span className="muted">进行中</span>
              ) : (
                <ul className="attempts">
                  {d.attempts.map((a, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: attempts are append-only
                    <li key={i}>
                      {a.ok ? <Check size={13} color="var(--ok)" /> : <X size={13} color="var(--danger)" />}
                      <span>
                        <code style={{ fontSize: 12 }}>{a.modelId}</code>
                        {a.error && <div className="error-text">{a.error}</div>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        )}
      </section>
      <section className="d-section">
        <h4>工具调用（{m.toolCalls.length}）</h4>
        {m.toolCalls.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            没有调用工具。
          </p>
        ) : (
          <div className="tool-list">
            {m.toolCalls.map((t) => (
              <details key={t.id} className="tool" open={t.status === "error"}>
                <summary>
                  <ChevronRight size={14} className="chev" />
                  <span className="tool-name">{t.name}</span>
                  <span className="tool-args" />
                  <ToolStatus status={t.status} />
                </summary>
                <div className="tool-body">
                  <span className="k">参数</span>
                  <pre>{prettyJson(t.arguments)}</pre>
                  {t.result !== undefined && (
                    <>
                      <span className="k">结果</span>
                      <pre>{t.result}</pre>
                    </>
                  )}
                  {t.error && (
                    <>
                      <span className="k">错误</span>
                      <pre className="error-text">{t.error}</pre>
                    </>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function RoomInfo(props: {
  room: Room;
  agents: Agent[];
  members: Agent[];
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room } = props;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            {props.members.map((a) => (
              <div key={a.id} className="member-row">
                <AgentAvatar agent={a} size={24} />
                <span className="grow">{a.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {a.modelMode === "auto" ? "Auto" : a.pinnedModel}
                </span>
              </div>
            ))}
          </>
        )}
        {error && <div className="error-text">{error}</div>}
      </section>
      <section className="d-section">
        <h4>提示</h4>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          点击 Agent 回复下方的路由标签，可以在这里查看模型选择理由、回退和工具调用。
        </p>
      </section>
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

function Composer(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  members: Agent[];
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = /(?:^|\s)@([^\s@]*)$/.exec(props.value.slice(0, caret));
  const options =
    query && !dismissed
      ? props.members.filter((a) => a.name.toLowerCase().includes((query[1] ?? "").toLowerCase()))
      : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on value change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [props.value]);

  const pick = (a: Agent) => {
    const before = props.value.slice(0, caret).replace(/@[^\s@]*$/, `@${a.name} `);
    props.onChange(before + props.value.slice(caret));
    setCaret(before.length);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(before.length, before.length);
    });
  };

  return (
    <div className="composer-box">
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
              <AgentAvatar agent={a} size={22} />
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
        onKeyDown={(e) => {
          if (options.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
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
        <span className="hint">
          <span>
            <kbd>Enter</kbd> 发送
          </span>
          <span>
            <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          </span>
          {props.members.length > 0 && (
            <span>
              <kbd>@</kbd> 提及 Agent
            </span>
          )}
        </span>
        <button
          type="button"
          className="send-btn"
          onClick={props.onSubmit}
          disabled={!props.value.trim()}
          aria-label="发送"
        >
          <ArrowUp size={17} />
        </button>
      </div>
    </div>
  );
}
