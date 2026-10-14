import { Bot, Command, MessagesSquare, PlugZap, Plus, Search, Sparkles, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentEditor } from "./AgentEditor";
import { AvatarShowcase } from "./AvatarShowcase";
import { type Agent, api, connectWs, type McpServer, type Meta, type Room, type WsEvent } from "./api";
import { BrandMark } from "./BrandMark";
import { ChatView } from "./ChatView";
import { CommandPalette } from "./CommandPalette";
import { usePresence } from "./motion";
import { NewRoom } from "./NewRoom";
import { SetupPage } from "./Setup";
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
  const palette = usePresence(paletteOpen, 140);
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

  const section = route[0] === "a" ? "agents" : route[0] === "setup" ? "setup" : "rooms";
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
  const mobileView = section === "setup" || detailId ? "main" : "list";
  const harnessName = (id: string) => meta?.harnesses.find((h) => h.id === id)?.name ?? id;

  if (route[0] === "dev" && route[1] === "avatars") return <AvatarShowcase />;
  return (
    <div className={`shell ${section === "setup" ? "no-list" : ""}`} data-mobile={mobileView}>
      <nav className="rail" aria-label="主导航">
        <div className="logo" title="团团 Tuantuan">
          <BrandMark size={32} />
        </div>
        <RailButton
          icon={<MessagesSquare size={20} />}
          label="会话"
          current={section === "rooms"}
          onClick={() => go("c")}
        />
        <RailButton icon={<Bot size={20} />} label="Agents" current={section === "agents"} onClick={() => go("a")} />
        <RailButton
          icon={<PlugZap size={20} />}
          label="引导"
          current={section === "setup"}
          onClick={() => go("setup")}
        />
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
              ["私聊", rooms.filter((r) => r.kind === "dm")],
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
                  {a.harness ? harnessName(a.harness) : <span className="warn-text">未绑定 Harness</span>}
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
            harnessName={harnessName}
            subscribeEvents={subscribeEvents}
            onBack={() => go("c")}
            onRoomChange={reload}
            onDeleted={async () => {
              await reload();
              go("c");
            }}
          />
        )}
        {section === "setup" && meta && <SetupPage meta={meta} agents={agents} onAgentsChange={reload} go={go} />}
        {section === "agents" && !detailId && loaded && (
          <div className="empty">
            <div className="empty-icon">
              <Bot size={24} />
            </div>
            <h2>{agents.length ? "选择一个 Agent 进行编辑" : "创建你的第一个 Agent"}</h2>
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
              const dm = rooms.find((r) => r.kind === "dm" && r.agentIds[0] === a.id);
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
      </main>

      {palette.mounted && (
        <CommandPalette
          state={palette.state}
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

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

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
        <button type="button" className="input search-trigger" onClick={props.onSearch}>
          搜索会话与 Agent
          <kbd className="combo">
            {IS_MAC ? <Command size={10} /> : <span>Ctrl</span>}
            <span>K</span>
          </kbd>
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
      done: agents.some((a) => a.harness),
      title: "接入 Harness，绑定到 Agent",
      cta: "新手引导",
      path: "setup",
    },
    {
      done: rooms.length > 0,
      title: "开始一个会话",
      cta: "新建会话",
      path: "c/new",
      needs: agents.length > 0,
    },
  ];
  return (
    <div className="empty" style={{ maxWidth: 560 }}>
      <div className="empty-icon">
        <Sparkles size={24} />
      </div>
      <h2>{agents.length === 0 ? "欢迎使用团团" : "选择一个会话"}</h2>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.title} className={`step ${s.done ? "done" : ""}`}>
            <span className="num">{s.done ? "✓" : i + 1}</span>
            <span className="step-body">
              <div className="step-title">{s.title}</div>
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
