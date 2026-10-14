import { useEffect, useMemo, useRef, useState } from "react";
import { type Agent, api, type Message, type Room, type RoomState, type RoutingDecision, type WsEvent } from "./api";

const STATUS_LABEL: Record<Message["status"], string> = {
  streaming: "回复中",
  done: "",
  error: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function ChatView(props: {
  room: Room;
  agents: Agent[];
  userName: string;
  subscribeEvents: (fn: (e: WsEvent) => void) => () => void;
  onRoomChange: () => Promise<void>;
  onDeleted: () => void;
}) {
  const { room } = props;
  const [messages, setMessages] = useState<Message[]>([]);
  const [routing, setRouting] = useState<Record<string, RoutingDecision>>({});
  const [state, setState] = useState<RoomState>({ activeRunId: null, queued: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [editingMembers, setEditingMembers] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const members = useMemo(
    () => room.agentIds.map((id) => props.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [room.agentIds, props.agents],
  );
  const agentColor = (id: string | null) => props.agents.find((a) => a.id === id)?.color ?? "#8a8f98";
  const agentAvatar = (m: Message) => props.agents.find((a) => a.id === m.senderId)?.avatar ?? m.senderName.slice(0, 1);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = await api<{ messages: Message[]; routing: RoutingDecision[]; state: RoomState }>(
          "GET",
          `/api/rooms/${room.id}/messages?limit=200`,
        );
        if (!alive) return;
        setMessages(data.messages);
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
        void load(); // catch up on anything missed while disconnected
      }
      if (!("roomId" in e) && e.type !== "message") return;
      if (e.type === "message") {
        if (e.message.roomId !== room.id) return;
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever content changes
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    setSendError(null);
    setDraft("");
    try {
      await api("POST", `/api/rooms/${room.id}/messages`, { senderName: props.userName, content });
    } catch (e) {
      setDraft(content); // keep the user's text on failure
      setSendError((e as Error).message);
    }
  };

  const cancel = async () => {
    try {
      await api("POST", `/api/rooms/${room.id}/cancel`);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const running = state.activeRunId !== null;

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h2>{room.name}</h2>
          <div className="members">
            <span className="muted">{room.kind === "dm" ? "私聊" : "群聊"} ·</span>
            {members.length === 0 && <span className="error-text">没有 Agent 成员</span>}
            {members.map((a) => (
              <button
                type="button"
                key={a.id}
                className="chip"
                style={{ borderColor: a.color }}
                title={room.kind === "group" ? "点击插入 @" : a.name}
                onClick={() =>
                  room.kind === "group" && setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${a.name} `)
                }
              >
                {a.avatar} {a.name}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          {room.kind === "group" && (
            <button type="button" onClick={() => setEditingMembers((v) => !v)}>
              {editingMembers ? "完成" : "管理成员"}
            </button>
          )}
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!confirm(`删除会话「${room.name}」及其全部消息？此操作不可撤销。`)) return;
              await api("DELETE", `/api/rooms/${room.id}`).then(props.onDeleted, (e) =>
                setSendError((e as Error).message),
              );
            }}
          >
            删除会话
          </button>
        </div>
      </header>

      {editingMembers && <MemberEditor room={room} agents={props.agents} onSaved={props.onRoomChange} />}
      {loadError && <div className="banner error">消息加载失败：{loadError}</div>}

      <div className="messages" ref={listRef}>
        {messages.length === 0 && !loadError && (
          <p className="hint center">
            {room.kind === "group" ? "发送消息并 @ 某个 Agent 开始对话。" : "直接发送消息开始对话。"}
          </p>
        )}
        {messages.map((m) =>
          m.senderKind === "system" ? (
            <div key={m.id} className="system-msg">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={`msg ${m.senderKind}`} data-status={m.status}>
              <span
                className="avatar"
                style={{ background: m.senderKind === "human" ? "#555b66" : agentColor(m.senderId) }}
              >
                {m.senderKind === "human" ? m.senderName.slice(0, 1) : agentAvatar(m)}
              </span>
              <div className="bubble-wrap">
                <div className="meta">
                  <strong>{m.senderName}</strong>
                  {m.hop >= 2 && <span className="tag">Agent 互相 @ 第 {m.hop - 1} 跳</span>}
                  {STATUS_LABEL[m.status] && <span className={`tag status-${m.status}`}>{STATUS_LABEL[m.status]}</span>}
                  <span className="muted">{new Date(m.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                </div>
                {m.toolCalls.length > 0 && <ToolCalls calls={m.toolCalls} />}
                <div className="bubble">
                  {m.content ||
                    (m.status === "streaming" ? (
                      <span className="typing">思考中…</span>
                    ) : (
                      <span className="muted">（无内容）</span>
                    ))}
                </div>
                {m.error && <div className="error-text">{m.error}</div>}
                {routing[m.id] && <RoutingInfo d={routing[m.id] as RoutingDecision} />}
              </div>
            </div>
          ),
        )}
      </div>

      <footer className="composer">
        {(running || state.queued > 0) && (
          <div className="run-state">
            <span>
              {running ? "Agent 正在回复" : ""}
              {state.queued > 0 ? `，${state.queued} 条消息排队中` : ""}
            </span>
            <button type="button" className="danger" onClick={() => void cancel()} disabled={!running}>
              取消
            </button>
            <span className="muted">取消会停止当前回复（已生成内容保留）并丢弃排队消息</span>
          </div>
        )}
        {sendError && <div className="error-text">{sendError}</div>}
        <MentionInput
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          members={room.kind === "group" ? members : []}
        />
      </footer>
    </div>
  );
}

function ToolCalls({ calls }: { calls: Message["toolCalls"] }) {
  return (
    <div className="tools">
      {calls.map((c) => (
        <details key={c.id} className={`tool tool-${c.status}`}>
          <summary>
            🔧 {c.name} · {c.status === "running" ? "执行中…" : c.status === "ok" ? "成功" : "失败"}
          </summary>
          <div className="tool-body">
            <div className="muted">参数</div>
            <pre>{c.arguments || "{}"}</pre>
            {c.result !== undefined && (
              <>
                <div className="muted">结果</div>
                <pre>{c.result}</pre>
              </>
            )}
            {c.error && (
              <>
                <div className="muted">错误（已原样返回给模型）</div>
                <pre className="error-text">{c.error}</pre>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  chat: "闲聊",
  coding: "编程",
  reasoning: "推理",
  long_context: "长上下文",
  tool_heavy: "工具密集",
  vision: "视觉",
};
const DIFF_LABEL: Record<string, string> = { easy: "简单", medium: "中等", hard: "困难" };

function RoutingInfo({ d }: { d: RoutingDecision }) {
  const c = d.plan.classification;
  const fellBack = d.attempts.some((a) => !a.ok);
  const summary =
    d.plan.mode === "pinned"
      ? `固定模型 ${d.plan.candidates[0] ?? "（不存在）"}`
      : `${c ? `${TYPE_LABEL[c.taskType]}·${DIFF_LABEL[c.difficulty]}` : ""} → ${d.chosenModel ?? (d.attempts.length ? "全部失败" : "路由中…")}`;
  return (
    <details className="routing">
      <summary>
        路由：{summary}
        {fellBack && " · 发生回退"}
      </summary>
      <dl>
        {c && (
          <>
            <dt>分类</dt>
            <dd>
              {c.source === "llm" ? `模型分类（${c.classifierModel}）` : "规则分类"}
              {c.classifierError && <span className="error-text">；分类模型失败：{c.classifierError}</span>}
            </dd>
          </>
        )}
        <dt>输入</dt>
        <dd>
          约 {d.plan.signals.contextTokens} token 上下文，{d.plan.signals.toolCount} 个工具
        </dd>
        <dt>理由</dt>
        <dd>{d.plan.reason}</dd>
        <dt>候选顺序</dt>
        <dd>{d.plan.candidates.join(" → ") || "无"}</dd>
        <dt>尝试</dt>
        <dd>
          {d.attempts.length === 0
            ? "进行中"
            : d.attempts.map((a) => (
                <div key={a.modelId} className={a.ok ? "" : "error-text"}>
                  {a.ok ? "✓" : "✗"} {a.modelId}
                  {a.error && `：${a.error}`}
                </div>
              ))}
        </dd>
      </dl>
    </details>
  );
}

function MentionInput(props: { value: string; onChange: (v: string) => void; onSubmit: () => void; members: Agent[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const query = /(?:^|\s)@([^\s@]*)$/.exec(props.value.slice(0, caret));
  const options = query
    ? props.members.filter((a) => a.name.toLowerCase().startsWith((query[1] ?? "").toLowerCase()))
    : [];

  const pick = (a: Agent) => {
    const before = props.value.slice(0, caret).replace(/@[^\s@]*$/, `@${a.name} `);
    const next = before + props.value.slice(caret);
    props.onChange(next);
    setCaret(before.length);
    requestAnimationFrame(() => ref.current?.setSelectionRange(before.length, before.length));
  };

  return (
    <div className="mention-input">
      {options.length > 0 && (
        <ul className="mention-pop">
          {options.map((a, i) => (
            <li key={a.id}>
              <button
                type="button"
                className={i === active ? "on" : ""}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pick(a);
                }}
              >
                {a.avatar} {a.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        rows={3}
        value={props.value}
        placeholder={
          props.members.length
            ? "输入消息，@ 选择 Agent；Enter 发送，Shift+Enter 换行"
            : "输入消息；Enter 发送，Shift+Enter 换行"
        }
        onChange={(e) => {
          props.onChange(e.target.value);
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (options.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (options.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            pick(options[active] ?? (options[0] as Agent));
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
      />
      <button type="button" className="primary" onClick={props.onSubmit} disabled={!props.value.trim()}>
        发送
      </button>
    </div>
  );
}

function MemberEditor({ room, agents, onSaved }: { room: Room; agents: Agent[]; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const toggle = async (id: string) => {
    const next = room.agentIds.includes(id) ? room.agentIds.filter((x) => x !== id) : [...room.agentIds, id];
    try {
      await api("PUT", `/api/rooms/${room.id}/agents`, { agentIds: next });
      await onSaved();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="member-editor">
      {agents.map((a) => (
        <label key={a.id} className="check">
          <input type="checkbox" checked={room.agentIds.includes(a.id)} onChange={() => void toggle(a.id)} />
          {a.avatar} {a.name}
        </label>
      ))}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
