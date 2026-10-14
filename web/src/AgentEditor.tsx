import { useEffect, useState } from "react";
import { type Agent, type AgentInput, api, type McpServer, type McpTool, type Meta } from "./api";

const COLORS = ["#4f6bed", "#e8553e", "#2f9e6e", "#b4589c", "#d4932b", "#3b8ea5", "#6b6f7a"];

function emptyAgent(): AgentInput {
  return {
    name: "",
    color: COLORS[Math.floor(Math.random() * COLORS.length)] as string,
    avatar: "🤖",
    systemPrompt: "",
    tools: [],
    skills: [],
    modelMode: "auto",
    pinnedModel: null,
  };
}

export function AgentEditor(props: {
  meta: Meta;
  agent: Agent | null;
  mcpServers: McpServer[];
  onMcpChange: () => Promise<void>;
  onSaved: (a: Agent) => void;
  onDeleted: () => void;
}) {
  const { meta, agent, mcpServers } = props;
  const [form, setForm] = useState<AgentInput>(() => (agent ? { ...agent } : emptyAgent()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const set = <K extends keyof AgentInput>(k: K, v: AgentInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: "tools" | "skills", v: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { ...form, pinnedModel: form.modelMode === "pinned" ? form.pinnedModel : null };
      const saved = agent
        ? await api<Agent>("PUT", `/api/agents/${agent.id}`, body)
        : await api<Agent>("POST", "/api/agents", body);
      setSavedAt(Date.now());
      props.onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent || !confirm(`删除 Agent「${agent.name}」？它会退出所有群聊，历史消息保留。`)) return;
    try {
      await api("DELETE", `/api/agents/${agent.id}`);
      props.onDeleted();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="panel wide" onSubmit={save}>
      <h2>{agent ? `编辑 Agent：${agent.name}` : "新建 Agent"}</h2>

      <div className="row">
        <label className="grow">
          名称（用于 @，不能含空格或 @）
          <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={32} required />
        </label>
        <label>
          头像
          <input className="short" value={form.avatar} onChange={(e) => set("avatar", e.target.value)} maxLength={4} />
        </label>
        <label>
          颜色
          <input type="color" value={form.color} onChange={(e) => set("color", e.target.value)} />
        </label>
      </div>

      <label>
        系统 Prompt
        <textarea
          rows={6}
          value={form.systemPrompt}
          onChange={(e) => set("systemPrompt", e.target.value)}
          placeholder="描述这个 Agent 的角色、风格和边界。mock 模式下可写 [[reply:固定回复]] 来演示 @ 其他 Agent。"
        />
      </label>

      <fieldset>
        <legend>模型</legend>
        <label className="check">
          <input type="radio" checked={form.modelMode === "auto"} onChange={() => set("modelMode", "auto")} />
          Auto：按任务类型和难度自动选择，失败时回退到下一个候选
        </label>
        <label className="check">
          <input
            type="radio"
            checked={form.modelMode === "pinned"}
            onChange={() =>
              setForm((f) => ({ ...f, modelMode: "pinned", pinnedModel: f.pinnedModel ?? meta.models[0]?.id ?? null }))
            }
          />
          固定模型（不回退）
          <select
            disabled={form.modelMode !== "pinned"}
            value={form.pinnedModel ?? ""}
            onChange={(e) => set("pinnedModel", e.target.value)}
          >
            {meta.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}（成本档 {m.costTier}）
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>内置工具</legend>
        {meta.builtinTools.map((t) => (
          <label key={t.id} className="check">
            <input type="checkbox" checked={form.tools.includes(t.id)} onChange={() => toggleIn("tools", t.id)} />
            <code>{t.name}</code> <span className="muted">{t.description}</span>
          </label>
        ))}
      </fieldset>

      <McpSection
        servers={mcpServers}
        selected={form.tools}
        toggle={(id) => toggleIn("tools", id)}
        onChange={props.onMcpChange}
      />

      <fieldset>
        <legend>Skills（Agent 只看到名称和描述，需要时才加载正文）</legend>
        {meta.skills.length === 0 && <p className="hint">skills 目录下没有可用的 Skill。</p>}
        {meta.skills.map((s) => (
          <label key={s.name} className="check">
            <input type="checkbox" checked={form.skills.includes(s.name)} onChange={() => toggleIn("skills", s.name)} />
            <code>{s.name}</code> <span className="muted">{s.description}</span>
          </label>
        ))}
        {meta.skillErrors.map((e) => (
          <p key={e.dir} className="error-text">
            Skill 加载失败 {e.dir}：{e.error}
          </p>
        ))}
      </fieldset>

      {error && <p className="error-text">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "保存中…" : agent ? "保存修改" : "创建 Agent"}
        </button>
        {savedAt && !error && <span className="muted">已保存</span>}
        {agent && (
          <button type="button" className="danger" onClick={remove}>
            删除
          </button>
        )}
      </div>
    </form>
  );
}

function McpSection(props: {
  servers: McpServer[];
  selected: string[];
  toggle: (toolId: string) => void;
  onChange: () => Promise<void>;
}) {
  const [tools, setTools] = useState<Record<string, McpTool[] | { error: string } | "loading">>({});
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

  // Load tool lists for servers that already have selected tools, so selections are visible.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on server list change
  useEffect(() => {
    for (const s of props.servers)
      if (!tools[s.id] && props.selected.some((t) => t.startsWith(`mcp:${s.id}:`))) void load(s);
  }, [props.servers]);

  const add = async () => {
    setError(null);
    try {
      await api("POST", "/api/mcp-servers", { name: name.trim() || url, url: url.trim() });
      setName("");
      setUrl("");
      await props.onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (s: McpServer) => {
    if (!confirm(`移除 MCP 服务「${s.name}」？引用它的 Agent 将无法再调用这些工具。`)) return;
    try {
      await api("DELETE", `/api/mcp-servers/${s.id}`);
      await props.onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <fieldset>
      <legend>MCP 工具（Streamable HTTP，全局共享）</legend>
      {props.servers.map((s) => {
        const state = tools[s.id];
        const orphaned = props.selected.filter(
          (id) =>
            id.startsWith(`mcp:${s.id}:`) && Array.isArray(state) && !state.some((t) => id === `mcp:${s.id}:${t.name}`),
        );
        return (
          <div key={s.id} className="mcp-server">
            <div className="row">
              <strong>{s.name}</strong>
              <span className="muted grow">{s.url}</span>
              <button type="button" onClick={() => void load(s)}>
                {state === "loading" ? "加载中…" : Array.isArray(state) ? "刷新工具" : "加载工具"}
              </button>
              <button type="button" className="danger" onClick={() => void remove(s)}>
                移除
              </button>
            </div>
            {state && typeof state === "object" && !Array.isArray(state) && <p className="error-text">{state.error}</p>}
            {Array.isArray(state) && state.length === 0 && <p className="hint">该服务没有提供工具。</p>}
            {Array.isArray(state) &&
              state.map((t) => {
                const id = `mcp:${s.id}:${t.name}`;
                return (
                  <label key={id} className="check">
                    <input type="checkbox" checked={props.selected.includes(id)} onChange={() => props.toggle(id)} />
                    <code>{t.name}</code> <span className="muted">{t.description}</span>
                  </label>
                );
              })}
            {orphaned.map((id) => (
              <label key={id} className="check error-text">
                <input type="checkbox" checked onChange={() => props.toggle(id)} />
                {id.split(":").slice(2).join(":")}（服务已不再提供，取消勾选以移除）
              </label>
            ))}
          </div>
        );
      })}
      <div className="row">
        <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="grow"
          placeholder="https://example.com/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="button" onClick={() => void add()} disabled={!url.trim()}>
          添加 MCP 服务
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </fieldset>
  );
}
