import { Bot, Command, MessagesSquare, Plus, Search, Sparkles, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor";
import { type Agent, api, connectWs, type McpServer, type Meta, type Room, type WsEvent } from "./api";
import { ChatView } from "./ChatView";
import { CommandPalette } from "./CommandPalette";
import { NewRoom } from "./NewRoom";
import { RobotPage } from "./robot/RobotPage";
import { AgentAvatar, RoomIcon, roomSubtitle, useHashRoute } from "./ui";

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [userName, setUserName] = useState(() => localStorage.getItem("agent-hub:user") || "我");
  const [route, go] = useHashRoute();
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
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    ws.current = connectWs((e) => {
      for (const l of listeners.current) l(e);
    }, setConnected);
    return () => ws.current?.close();
  }, [reload]);

  useEffect(() => {
    localStorage.setItem("agent-hub:user", userName);
  }, [userName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const section = route[0] === "a" ? "agents" : route[0] === "robot" ? "robot" : "rooms";
  const detailId = route[1] ?? null;
  const roomId = section === "rooms" && detailId && detailId !== "new" ? detailId : null;

  useEffect(() => {
    ws.current?.subscribe(roomId);
  }, [roomId]);

  const subscribeEvents = useCallback((fn: (e: WsEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const room = roomId ? rooms.find((r) => r.id === roomId) : undefined;
  const mobileView = section === "robot" || detailId ? "main" : "list";

  return (
    <div className={`shell ${section === "robot" ? "no-list" : ""}`} data-mobile={mobileView}>
      <nav className="rail" aria-label="主导航">
        <div className="logo" aria-hidden>
          <Sparkles size={18} />
        </div>
        <RailButton
          icon={<MessagesSquare size={20} />}
          label="会话"
          current={section === "rooms"}
          onClick={() => go("c")}
        />
        <RailButton icon={<Bot size={20} />} label="Agents" current={section === "agents"} onClick={() => go("a")} />
        <RailButton icon={<RobotGlyph />} label="机器人" current={section === "robot"} onClick={() => go("robot")} />
        <div className="spacer" />
        <button
          type="button"
          className="rail-btn rail-search"
          title="快速切换（⌘K / Ctrl+K）"
          onClick={() => setPaletteOpen(true)}
        >
          <Search size={18} />
          搜索
        </button>
        <UserButton name={userName} onChange={setUserName} />
        <div className="conn" title={connected ? "实时连接正常" : "实时连接已断开，正在重连…"}>
          <span className={`dot ${connected ? "ok" : "bad"}`} />
          <span className="sr-only">{connected ? "已连接" : "重连中"}</span>
        </div>
      </nav>

      {section === "rooms" && (
        <ListPane
          title="会话"
          action={
            <button
              type="button"
              className="btn sm"
              onClick={() => go("c/new")}
              disabled={agents.length === 0}
              title={agents.length ? "" : "先创建一个 Agent"}
            >
              <Plus size={14} />
              新建
            </button>
          }
          onSearch={() => setPaletteOpen(true)}
        >
          {loaded && rooms.length === 0 && (
            <div className="list-empty">
              {agents.length === 0 ? "先创建一个 Agent，再开始会话。" : "还没有会话。"}
              <button type="button" className="btn primary sm" onClick={() => go(agents.length ? "c/new" : "a/new")}>
                {agents.length ? "新建会话" : "创建第一个 Agent"}
              </button>
            </div>
          )}
          {(
            [
              ["群聊", rooms.filter((r) => r.kind === "group")],
              ["私聊", rooms.filter((r) => r.kind === "dm" && !r.deviceId)],
              ["桌面机器人", rooms.filter((r) => r.deviceId)],
            ] as const
          ).map(
            ([label, list]) =>
              list.length > 0 && (
                <div key={label}>
                  <div className="group-label">{label}</div>
                  {list.map((r) => (
                    <button
                      type="button"
                      key={r.id}
                      className="list-item"
                      aria-current={roomId === r.id ? "page" : undefined}
                      onClick={() => go(`c/${r.id}`)}
                    >
                      <RoomIcon room={r} agents={agents} />
                      <span className="li-body">
                        <span className="li-title">{r.name}</span>
                        <span className="li-sub">{roomSubtitle(r, agents)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ),
          )}
        </ListPane>
      )}

      {section === "agents" && (
        <ListPane
          title="Agents"
          action={
            <button type="button" className="btn sm" onClick={() => go("a/new")}>
              <Plus size={14} />
              新建
            </button>
          }
          onSearch={() => setPaletteOpen(true)}
        >
          {loaded && agents.length === 0 && (
            <div className="list-empty">
              还没有 Agent。
              <button type="button" className="btn primary sm" onClick={() => go("a/new")}>
                创建第一个 Agent
              </button>
            </div>
          )}
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className="list-item"
              aria-current={detailId === a.id ? "page" : undefined}
              onClick={() => go(`a/${a.id}`)}
            >
              <AgentAvatar agent={a} />
              <span className="li-body">
                <span className="li-title">{a.name}</span>
                <span className="li-sub">
                  {a.modelMode === "auto" ? "Auto 路由" : a.pinnedModel} · {a.tools.length} 工具 · {a.skills.length}{" "}
                  Skills
                </span>
              </span>
            </button>
          ))}
        </ListPane>
      )}

      <main className="main">
        {loadError && (
          <div className="form-error" role="alert" style={{ margin: 12 }}>
            加载失败：{loadError}
            <button type="button" className="btn sm" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}
        {section === "rooms" && !detailId && loaded && <Welcome agents={agents} rooms={rooms} meta={meta} go={go} />}
        {section === "rooms" && detailId === "new" && (
          <NewRoom
            agents={agents}
            onBack={() => go("c")}
            onCreated={async (r) => {
              await reload();
              go(`c/${r.id}`);
            }}
          />
        )}
        {section === "rooms" && roomId && loaded && !room && <NotFound what="会话" onBack={() => go("c")} />}
        {room && (
          <ChatView
            key={room.id}
            room={room}
            agents={agents}
            userName={userName}
            subscribeEvents={subscribeEvents}
            onBack={() => go("c")}
            onRoomChange={reload}
            onDeleted={async () => {
              await reload();
              go("c");
            }}
          />
        )}
        {section === "agents" && !detailId && loaded && (
          <div className="empty">
            <div className="empty-icon">
              <Bot size={24} />
            </div>
            <h2>{agents.length ? "选择一个 Agent 进行编辑" : "创建你的第一个 Agent"}</h2>
            <p>Agent = 系统 Prompt + 工具 + Skills + 模型策略。名称就是在群聊里 @ 它的方式。</p>
            <button type="button" className="btn primary" onClick={() => go("a/new")}>
              <Plus size={16} />
              新建 Agent
            </button>
          </div>
        )}
        {section === "agents" && detailId && meta && (detailId === "new" || agents.some((a) => a.id === detailId)) && (
          <AgentEditor
            key={detailId}
            meta={meta}
            agent={detailId === "new" ? null : (agents.find((a) => a.id === detailId) ?? null)}
            mcpServers={mcpServers}
            onBack={() => go("a")}
            onMcpChange={reload}
            onSaved={async (a) => {
              await reload();
              go(`a/${a.id}`);
            }}
            onDeleted={async () => {
              await reload();
              go("a");
            }}
            onStartChat={(a) => {
              const dm = rooms.find((r) => r.kind === "dm" && !r.deviceId && r.agentIds[0] === a.id);
              if (dm) go(`c/${dm.id}`);
              else
                void api<Room>("POST", "/api/rooms", { name: `与 ${a.name} 私聊`, kind: "dm", agentIds: [a.id] }).then(
                  async (r) => {
                    await reload();
                    go(`c/${r.id}`);
                  },
                );
            }}
          />
        )}
        {section === "agents" && detailId && detailId !== "new" && loaded && !agents.some((a) => a.id === detailId) && (
          <NotFound what="Agent" onBack={() => go("a")} />
        )}
        {section === "robot" && loaded && (
          <RobotPage
            agents={agents}
            userName={userName}
            onOpenConversation={(id) => go(`c/${id}`)}
            onConversationCreated={reload}
            goCreateAgent={() => go("a/new")}
          />
        )}
      </main>

      {paletteOpen && (
        <CommandPalette
          agents={agents}
          rooms={rooms}
          onClose={() => setPaletteOpen(false)}
          onGo={(path) => {
            setPaletteOpen(false);
            go(path);
          }}
        />
      )}
    </div>
  );
}

function RailButton(props: { icon: React.ReactNode; label: string; current: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rail-btn"
      aria-current={props.current ? "page" : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

function RobotGlyph() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="3.5" y="6" width="17" height="12" rx="4" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" />
      <path d="M12 6V3.5M9 21h6" />
    </svg>
  );
}

function UserButton({ name, onChange }: { name: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rail-user">
      <button
        type="button"
        className="rail-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="我的显示名"
      >
        <UserRound size={18} />
        {name.slice(0, 4) || "我"}
      </button>
      {open && (
        <div className="popover" style={{ left: 56, bottom: 0, width: 220 }}>
          <label className="field" style={{ padding: 8 }}>
            <span className="label">我的显示名</span>
            <input
              className="input"
              ref={(el) => el?.focus()}
              value={name}
              maxLength={32}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && setOpen(false)}
              onBlur={() => setOpen(false)}
            />
            <span className="help">群聊中其他人和 Agent 看到的名字</span>
          </label>
        </div>
      )}
    </div>
  );
}

function ListPane(props: { title: string; action: React.ReactNode; onSearch: () => void; children: React.ReactNode }) {
  return (
    <aside className="list-pane">
      <div className="pane-head">
        <h1>{props.title}</h1>
        {props.action}
      </div>
      <div className="pane-search">
        <Search size={15} />
        <button
          type="button"
          className="input"
          style={{ textAlign: "left", color: "var(--text-3)", display: "flex", justifyContent: "space-between" }}
          onClick={props.onSearch}
        >
          搜索会话与 Agent
          <span>
            <kbd>
              <Command size={10} />K
            </kbd>
          </span>
        </button>
      </div>
      <div className="pane-scroll">{props.children}</div>
    </aside>
  );
}

function Welcome({
  agents,
  rooms,
  meta,
  go,
}: {
  agents: Agent[];
  rooms: Room[];
  meta: Meta | null;
  go: (p: string) => void;
}) {
  const steps = [
    {
      done: agents.length > 0,
      title: "创建一个 Agent",
      sub: "设置 Prompt，选择工具、Skills 和模型策略",
      cta: "新建 Agent",
      path: "a/new",
    },
    {
      done: rooms.some((r) => !r.deviceId),
      title: "开始一个会话",
      sub: "建群把多个 Agent 拉进来，用 @ 指定谁来回答",
      cta: "新建会话",
      path: "c/new",
      needs: agents.length > 0,
    },
    {
      done: rooms.some((r) => r.deviceId),
      title: "试试桌面机器人",
      sub: "用语音和绑定的 Agent 对话，它会做表情和动作",
      cta: "打开机器人",
      path: "robot",
      needs: agents.length > 0,
    },
  ];
  return (
    <div className="empty" style={{ maxWidth: 560 }}>
      <div className="empty-icon">
        <Sparkles size={24} />
      </div>
      <h2>{agents.length === 0 ? "欢迎使用 Agent Hub" : "选择一个会话"}</h2>
      <p>组合 Prompt、工具和 Skills 创建 Agent，让它们在群聊里协作。</p>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} className={`step ${s.done ? "done" : ""}`}>
            <span className="num">{s.done ? "✓" : i + 1}</span>
            <span className="step-body">
              <div className="step-title">{s.title}</div>
              <div className="step-sub">{s.sub}</div>
            </span>
            <button
              type="button"
              className={`btn sm ${!s.done && s.needs !== false ? "primary" : ""}`}
              disabled={s.needs === false}
              onClick={() => go(s.path)}
            >
              {s.cta}
            </button>
          </li>
        ))}
      </ol>
      {meta && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {meta.configSource === "builtin-mock"
            ? "当前使用内置 mock 模型，无需 API Key"
            : `模型配置：${meta.configSource}`}{" "}
          · 每条消息最多 {meta.limits.maxAgentHops} 次 Agent 互相 @ · <kbd>⌘K</kbd> 快速切换
        </p>
      )}
    </div>
  );
}

function NotFound({ what, onBack }: { what: string; onBack: () => void }) {
  return (
    <div className="empty">
      <h2>{what}不存在</h2>
      <p>它可能已被删除。</p>
      <button type="button" className="btn" onClick={onBack}>
        返回列表
      </button>
    </div>
  );
}
