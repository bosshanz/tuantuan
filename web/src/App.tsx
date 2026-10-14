import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor";
import { type Agent, api, connectWs, type McpServer, type Meta, type Room, type WsEvent } from "./api";
import { ChatView } from "./ChatView";
import { RoomForm } from "./RoomForm";

type View =
  | { kind: "room"; id: string }
  | { kind: "agent"; id: string | null }
  | { kind: "new-room" }
  | { kind: "home" };

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [connected, setConnected] = useState(false);
  const [userName, setUserName] = useState(() => localStorage.getItem("agent-hub:user") || "我");
  const listeners = useRef(new Set<(e: WsEvent) => void>());
  const ws = useRef<ReturnType<typeof connectWs> | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, a, r, s] = await Promise.all([
        api<Meta>("GET", "/api/meta"),
        api<Agent[]>("GET", "/api/agents"),
        api<Room[]>("GET", "/api/rooms"),
        api<McpServer[]>("GET", "/api/mcp-servers"),
      ]);
      setMeta(m);
      setAgents(a);
      setRooms(r);
      setMcpServers(s);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    ws.current = connectWs((e) => {
      for (const l of listeners.current) l(e);
    }, setConnected);
    return () => ws.current?.close();
  }, [reload]);

  const roomId = view.kind === "room" ? view.id : null;
  useEffect(() => {
    ws.current?.subscribe(roomId);
  }, [roomId]);

  useEffect(() => {
    localStorage.setItem("agent-hub:user", userName);
  }, [userName]);

  const subscribeEvents = useCallback((fn: (e: WsEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const room = roomId ? rooms.find((r) => r.id === roomId) : undefined;
  const agentById = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Agent Hub
          <span
            className={`conn ${connected ? "ok" : "bad"}`}
            title={connected ? "实时连接正常" : "实时连接断开，正在重连"}
          >
            {connected ? "已连接" : "重连中"}
          </span>
        </div>

        <section>
          <div className="section-head">
            <span>会话</span>
            <button type="button" className="link" onClick={() => setView({ kind: "new-room" })}>
              + 新建
            </button>
          </div>
          {rooms.length === 0 && <p className="hint">还没有会话。先创建 Agent，再新建群聊或私聊。</p>}
          {rooms.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`nav-item ${roomId === r.id ? "active" : ""}`}
              onClick={() => setView({ kind: "room", id: r.id })}
            >
              <span className="kind">{r.kind === "dm" ? "私聊" : "群聊"}</span>
              <span className="label">{r.name}</span>
            </button>
          ))}
        </section>

        <section>
          <div className="section-head">
            <span>Agents</span>
            <button type="button" className="link" onClick={() => setView({ kind: "agent", id: null })}>
              + 新建
            </button>
          </div>
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className={`nav-item ${view.kind === "agent" && view.id === a.id ? "active" : ""}`}
              onClick={() => setView({ kind: "agent", id: a.id })}
            >
              <span className="avatar sm" style={{ background: a.color }}>
                {a.avatar}
              </span>
              <span className="label">{a.name}</span>
              <span className="muted">{a.modelMode === "auto" ? "Auto" : a.pinnedModel}</span>
            </button>
          ))}
        </section>

        <label className="me">
          我的显示名
          <input value={userName} maxLength={32} onChange={(e) => setUserName(e.target.value)} />
        </label>
      </aside>

      <main className="main">
        {loadError && (
          <div className="banner error">
            加载失败：{loadError}{" "}
            <button type="button" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}
        {view.kind === "home" && (
          <div className="empty">
            <h2>欢迎使用 Agent Hub</h2>
            <p>1. 在左侧「Agents」新建 Agent：设置 Prompt、勾选工具和 Skills，模型可以选 Auto 或固定。</p>
            <p>2. 新建群聊把多个 Agent 拉进来，用 @名字 让它们回复；Agent 之间也能互相 @。</p>
            {meta && (
              <p className="muted">
                模型配置来源：{meta.configSource === "builtin-mock" ? "内置 mock（无需 API Key）" : meta.configSource}
                ；每条消息最多 {meta.limits.maxAgentHops} 次 Agent 互相 @。
              </p>
            )}
          </div>
        )}
        {view.kind === "agent" && meta && (
          <AgentEditor
            key={view.id ?? "new"}
            meta={meta}
            agent={view.id ? (agentById.get(view.id) ?? null) : null}
            mcpServers={mcpServers}
            onMcpChange={reload}
            onSaved={async (a) => {
              await reload();
              setView({ kind: "agent", id: a.id });
            }}
            onDeleted={async () => {
              await reload();
              setView({ kind: "home" });
            }}
          />
        )}
        {view.kind === "new-room" && (
          <RoomForm
            agents={agents}
            onCreated={async (r) => {
              await reload();
              setView({ kind: "room", id: r.id });
            }}
          />
        )}
        {view.kind === "room" && room && (
          <ChatView
            key={room.id}
            room={room}
            agents={agents}
            userName={userName}
            subscribeEvents={subscribeEvents}
            onRoomChange={reload}
            onDeleted={async () => {
              await reload();
              setView({ kind: "home" });
            }}
          />
        )}
      </main>
    </div>
  );
}
