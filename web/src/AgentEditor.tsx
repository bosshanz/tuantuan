import { AlertTriangle, Check, ChevronLeft, MessageCircle, Plug, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Agent, type AgentInput, api, type McpServer, type McpTool, type Meta } from "./api";
import { type PickItem, PickList } from "./PickList";
import { AgentAvatar } from "./ui";

const COLORS = ["#2f4a6d", "#b0432a", "#3d6b4f", "#b0812a", "#6d3f5b", "#2f6b6b", "#7a5a3c", "#4f5d63", "#3a3833"];

function emptyAgent(): AgentInput {
  return {
    name: "",
    color: COLORS[0] as string,
    avatar: "",
    systemPrompt: "",
    tools: [],
    skills: [],
    modelMode: "auto",
    pinnedModel: null,
  };
}

const comparable = (a: AgentInput) =>
  JSON.stringify([
    a.name,
    a.color,
    a.avatar,
    a.systemPrompt,
    [...a.tools].sort(),
    [...a.skills].sort(),
    a.modelMode,
    a.modelMode === "pinned" ? a.pinnedModel : null,
  ]);

export function AgentEditor(props: {
  meta: Meta;
  agent: Agent | null;
  mcpServers: McpServer[];
  onBack: () => void;
  onMcpChange: () => Promise<void>;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
  onStartChat: (a: Agent) => void;
}) {
  const { meta, agent } = props;
  const initial = useMemo<AgentInput>(() => (agent ? { ...agent } : emptyAgent()), [agent]);
  const [form, setForm] = useState<AgentInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = comparable(form) !== comparable(initial);
  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => {
    setJustSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const toggleIn = (k: "tools" | "skills", v: string) =>
    set(k, form[k].includes(v) ? form[k].filter((x) => x !== v) : [...form[k], v]);
  const avatar = form.avatar.trim() || form.name.trim().slice(0, 1) || "A";

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { ...form, avatar, pinnedModel: form.modelMode === "pinned" ? form.pinnedModel : null };
      const saved = agent
        ? await api<Agent>("PUT", `/api/agents/${agent.id}`, body)
        : await api<Agent>("POST", "/api/agents", body);
      setJustSaved(true);
      props.onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent || !confirm(`删除 Agent「${agent.name}」？\n它会退出所有群聊；已有的聊天记录会保留。此操作不可撤销。`))
      return;
    try {
      await api("DELETE", `/api/agents/${agent.id}`);
      props.onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pinnedMissing =
    form.modelMode === "pinned" && !!form.pinnedModel && !meta.models.some((m) => m.id === form.pinnedModel);
  return (
    <>
      <header className="main-head">
        <button type="button" className="btn ghost icon back-btn" onClick={props.onBack} aria-label="返回">
          <ChevronLeft size={18} />
        </button>
        <div className="preview-head title">
          <AgentAvatar agent={{ avatar, color: form.color, name: form.name }} size={36} />
          <div style={{ minWidth: 0 }}>
            <h2>{agent ? agent.name : form.name.trim() || "新建 Agent"}</h2>
            <div className="sub">
              {form.modelMode === "auto" ? "Auto 路由" : `固定 ${form.pinnedModel ?? ""}`} · {form.tools.length} 个工具
              · {form.skills.length} 个 Skills
            </div>
          </div>
        </div>
        {agent && (
          <button type="button" className="btn" onClick={() => props.onStartChat(agent)}>
            <MessageCircle size={15} />
            <span className="hide-sm">私聊</span>
          </button>
        )}
      </header>
      <form className="page" onSubmit={save}>
        <div className="page-inner">
          <section className="card">
            <div className="card-head">
              <h3>基本信息</h3>
            </div>
            <div className="card-body">
              <div className="row wrap-sm">
                <label className="field grow">
                  <span className="label">名称</span>
                  <input
                    className="input"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    maxLength={32}
                    required
                    placeholder="例如：产品经理Alice"
                  />
                </label>
                <label className="field" style={{ width: 96 }}>
                  <span className="label">头像字符</span>
                  <input
                    className="input"
                    value={form.avatar}
                    onChange={(e) => set("avatar", e.target.value)}
                    maxLength={4}
                    placeholder={avatar}
                  />
                </label>
              </div>
              <div className="field">
                <span className="label">颜色</span>
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="swatch"
                      style={{ background: c }}
                      aria-pressed={form.color === c}
                      aria-label={`颜色 ${c}`}
                      onClick={() => set("color", c)}
                    />
                  ))}
                  <input
                    type="color"
                    value={form.color}
                    onChange={(e) => set("color", e.target.value)}
                    aria-label="自定义颜色"
                    style={{ width: 28, height: 28, padding: 0, border: "none", background: "none" }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>系统 Prompt</h3>
            </div>
            <div className="card-body">
              <textarea
                className="textarea"
                rows={7}
                value={form.systemPrompt}
                onChange={(e) => set("systemPrompt", e.target.value)}
                aria-label="系统 Prompt"
                placeholder="你是一名严谨的资深工程师……"
              />
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>模型</h3>
            </div>
            <div className="card-body">
              <fieldset className="segmented" aria-label="模型策略">
                <button type="button" aria-pressed={form.modelMode === "auto"} onClick={() => set("modelMode", "auto")}>
                  Auto 路由
                </button>
                <button
                  type="button"
                  aria-pressed={form.modelMode === "pinned"}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      modelMode: "pinned",
                      pinnedModel: f.pinnedModel ?? meta.models[0]?.id ?? null,
                    }))
                  }
                >
                  固定模型
                </button>
              </fieldset>
              {form.modelMode === "pinned" && (
                <label className="field">
                  <span className="label">模型</span>
                  <select
                    className="select"
                    value={form.pinnedModel ?? ""}
                    onChange={(e) => set("pinnedModel", e.target.value)}
                  >
                    {pinnedMissing && (
                      <option value={form.pinnedModel ?? ""} disabled>
                        {form.pinnedModel}（当前未启用）
                      </option>
                    )}
                    {meta.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id} · 成本档 {m.costTier} · {Math.round(m.contextWindow / 1000)}k 上下文
                      </option>
                    ))}
                  </select>
                  {pinnedMissing && (
                    <span className="error-text" role="alert">
                      {form.pinnedModel} 未启用，回复会失败。请换一个模型或改用 Auto。
                    </span>
                  )}
                </label>
              )}
            </div>
          </section>

          <ToolsSection
            meta={meta}
            servers={props.mcpServers}
            selected={form.tools}
            toggle={(id) => toggleIn("tools", id)}
            onMcpChange={props.onMcpChange}
          />

          <section className="card">
            <div className="card-head">
              <h3>Skills</h3>
            </div>
            <div className="card-body">
              <PickList
                searchPlaceholder="搜索 Skill"
                emptyText="skills 目录下没有可用的 Skill"
                groups={[
                  { items: meta.skills.map((s) => ({ id: s.name, title: s.name, description: s.description })) },
                ]}
                selected={form.skills}
                onToggle={(id) => toggleIn("skills", id)}
              />
              {meta.skillErrors.map((e) => (
                <div key={e.dir} className="form-error">
                  <AlertTriangle size={15} /> 未加载 {e.dir}：{e.error}
                </div>
              ))}
            </div>
          </section>

          {agent && (
            <section className="card">
              <div className="card-head">
                <h3>危险操作</h3>
              </div>
              <div className="card-body row" style={{ alignItems: "center" }}>
                <span className="grow muted" style={{ fontSize: 13 }}>
                  删除后它会退出所有群聊，聊天记录保留。
                </span>
                <button type="button" className="btn danger" onClick={remove}>
                  <Trash2 size={15} />
                  删除 Agent
                </button>
              </div>
            </section>
          )}
        </div>
        <div className="save-bar">
          <span className="status" role="status">
            {error ? (
              <span className="error-text" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <AlertTriangle size={14} />
                {error}
              </span>
            ) : dirty ? (
              "有未保存的修改"
            ) : justSaved ? (
              <>
                <Check size={14} color="var(--ok)" />
                已保存
              </>
            ) : agent ? (
              "所有修改已保存"
            ) : (
              "填写名称后即可创建"
            )}
          </span>
          {agent && dirty && (
            <button type="button" className="btn ghost" onClick={() => setForm(initial)}>
              放弃修改
            </button>
          )}
          <button type="submit" className="btn primary" disabled={saving || (!!agent && !dirty) || !form.name.trim()}>
            {saving ? "保存中…" : agent ? "保存修改" : "创建 Agent"}
          </button>
        </div>
      </form>
    </>
  );
}

function ToolsSection(props: {
  meta: Meta;
  servers: McpServer[];
  selected: string[];
  toggle: (id: string) => void;
  onMcpChange: () => Promise<void>;
}) {
  const [tools, setTools] = useState<Record<string, McpTool[] | { error: string } | "loading">>({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async (s: McpServer) => {
    setTools((t) => ({ ...t, [s.id]: "loading" }));
    try {
      const list = await api<McpTool[]>("GET", `/api/mcp-servers/${s.id}/tools`);
      setTools((t) => ({ ...t, [s.id]: list }));
    } catch (e) {
      setTools((t) => ({ ...t, [s.id]: { error: (e as Error).message } }));
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: list tools once per server list change
  useEffect(() => {
    for (const s of props.servers) if (!tools[s.id]) void load(s);
  }, [props.servers]);

  const add = async () => {
    setError(null);
    try {
      await api("POST", "/api/mcp-servers", { name: name.trim() || url.trim(), url: url.trim() });
      setName("");
      setUrl("");
      setAdding(false);
      await props.onMcpChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (s: McpServer) => {
    if (!confirm(`移除 MCP 服务「${s.name}」？\n所有引用它的 Agent 都将无法再调用这些工具。`)) return;
    try {
      await api("DELETE", `/api/mcp-servers/${s.id}`);
      await props.onMcpChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const groups: { label: React.ReactNode; items: PickItem[]; footer?: React.ReactNode }[] = [
    {
      label: "内置",
      items: props.meta.builtinTools.map((t) => ({ id: t.id, title: t.name, description: t.description })),
    },
    ...props.servers.map((s) => {
      const state = tools[s.id];
      const listed = Array.isArray(state) ? state : [];
      const known = new Set(listed.map((t) => `mcp:${s.id}:${t.name}`));
      const orphaned = Array.isArray(state)
        ? props.selected.filter((id) => id.startsWith(`mcp:${s.id}:`) && !known.has(id))
        : [];
      return {
        label: (
          <>
            <Plug size={12} />
            {s.name}
            <span className="grow">{s.url}</span>
            <button
              type="button"
              className="btn ghost sm icon"
              title="刷新工具列表"
              aria-label={`刷新 ${s.name}`}
              onClick={() => void load(s)}
            >
              <RefreshCw size={12} className={state === "loading" ? "spin" : ""} />
            </button>
            <button
              type="button"
              className="btn ghost sm icon danger"
              title="移除此 MCP 服务"
              aria-label={`移除 ${s.name}`}
              onClick={() => void remove(s)}
            >
              <Trash2 size={12} />
            </button>
          </>
        ),
        items: [
          ...listed.map((t) => ({ id: `mcp:${s.id}:${t.name}`, title: t.name, description: t.description })),
          ...orphaned.map((id) => ({
            id,
            title: id.split(":").slice(2).join(":"),
            description: "服务已不再提供此工具，取消勾选以移除",
            invalid: true,
          })),
        ],
        footer:
          state === "loading" ? (
            <div className="pick-empty">正在获取工具列表…</div>
          ) : state && !Array.isArray(state) ? (
            <div className="pick-empty error-text">{state.error}</div>
          ) : Array.isArray(state) && state.length === 0 ? (
            <div className="pick-empty">该服务没有提供工具</div>
          ) : undefined,
      };
    }),
  ];

  return (
    <section className="card">
      <div className="card-head row" style={{ alignItems: "center" }}>
        <div className="grow">
          <h3>工具</h3>
          {props.selected.length > 0 && <p>已选 {props.selected.length} 个</p>}
        </div>
        <button type="button" className="btn sm" onClick={() => setAdding((v) => !v)}>
          <Plug size={13} />
          添加 MCP 服务
        </button>
      </div>
      <div className="card-body">
        {adding && (
          <div className="row wrap-sm" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ width: 160 }}>
              <span className="label">名称</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="可选" />
            </label>
            <label className="field grow">
              <span className="label">Streamable HTTP 地址</span>
              <input
                className="input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
            <button type="button" className="btn primary" onClick={() => void add()} disabled={!url.trim()}>
              添加
            </button>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <PickList
          searchPlaceholder="搜索工具"
          emptyText="没有可用工具"
          groups={groups}
          selected={props.selected}
          onToggle={props.toggle}
        />
      </div>
    </section>
  );
}
