import { AlertTriangle, Check, ChevronLeft, MessageCircle, Plug, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type AvatarShape, defaultAvatar } from "../../server/avatars";
import { CUSTOM_FORMATS, DEFAULT_BASE_URL } from "../../server/custom";
import { AvatarPicker } from "./AvatarPicker";
import {
  type Agent,
  type AgentInput,
  api,
  type CustomInput,
  IDENTITY_DELIVERY,
  type McpServer,
  type Meta,
} from "./api";
import { type PickItem, PickList } from "./PickList";
import { AgentAvatar } from "./ui";

type Form = Omit<AgentInput, "custom"> & { color: string; avatarShape: AvatarShape; custom: CustomInput | null };

/** A new agent gets a random-but-stable look up front so the preview matches what is saved. */
const draftSeed = () => crypto.randomUUID();

function emptyAgent(seed: string): Form {
  const d = defaultAvatar(seed);
  return {
    name: "",
    color: d.color,
    avatarShape: d.shape,
    avatar: "",
    identity: "",
    harness: "",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "ask",
    custom: null,
  };
}

const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

/** KEY=VALUE per line; blank lines and # comments ignored. */
function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1);
    else out[t] = "";
  }
  return out;
}

const comparable = (a: Form) =>
  JSON.stringify([
    a.name,
    a.color,
    a.avatarShape,
    a.identity,
    a.harness,
    a.env,
    [...a.mcpServerIds].sort(),
    a.permissionPolicy,
    a.custom,
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
  const seed = useMemo(() => agent?.id ?? draftSeed(), [agent]);
  const initial = useMemo<Form>(() => {
    if (!agent) return emptyAgent(seed);
    return {
      ...agent,
      custom: agent.custom
        ? { format: agent.custom.format, baseUrl: agent.custom.baseUrl, model: agent.custom.model, apiKey: "" }
        : null,
    };
  }, [agent, seed]);
  const [form, setForm] = useState<Form>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const dirty = comparable(form) !== comparable(initial);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setJustSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const [envText, setEnvText] = useState(() => envToText(initial.env));
  useEffect(() => setEnvText(envToText(initial.env)), [initial]);
  const toggleMcp = (v: string) =>
    set(
      "mcpServerIds",
      form.mcpServerIds.includes(v) ? form.mcpServerIds.filter((x) => x !== v) : [...form.mcpServerIds, v],
    );
  const harness = meta.harnesses.find((h) => h.id === form.harness);

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        ...form,
        avatar: form.avatar.trim() || [...form.name.trim()][0] || "A",
        custom:
          form.harness === "custom" && form.custom
            ? {
                ...form.custom,
                apiKey: form.custom.apiKey?.trim() ? form.custom.apiKey : undefined,
              }
            : null,
      };
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

  return (
    <>
      <header className="main-head">
        <button type="button" className="btn ghost icon back-btn" onClick={props.onBack} aria-label="返回">
          <ChevronLeft size={18} />
        </button>
        <div className="preview-head title">
          <AgentAvatar agent={form} size={28} />
          <div className="editor-title">
            <h2>{agent ? agent.name : form.name.trim() || "新建 Agent"}</h2>
            <div className="sub">
              {form.harness === "custom" ? "自定义 API" : harness ? harness.name : "未绑定 Harness"}
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
              <div className="row wrap-sm" style={{ alignItems: "flex-end" }}>
                <AvatarPicker
                  shape={form.avatarShape}
                  color={form.color}
                  onChange={(shape, color) => setForm((f) => ({ ...f, avatarShape: shape, color }))}
                  onReset={() => {
                    const d = defaultAvatar(seed);
                    setForm((f) => ({ ...f, avatarShape: d.shape, color: d.color }));
                  }}
                />
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
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Harness</h3>
              <p>
                由哪个编码 Agent 来驱动它；也可选自定义 API（仅对话，无文件/终端）。<a href="#/harness">检测与登录</a>
              </p>
            </div>
            <div className="card-body">
              <label className="field">
                <span className="label">Harness</span>
                <select
                  className="select"
                  aria-label="Harness"
                  value={form.harness}
                  onChange={(e) => {
                    const v = e.target.value;
                    set("harness", v);
                    if (v === "custom" && !form.custom)
                      set("custom", { format: "openai-chat", baseUrl: "", model: "", apiKey: "" });
                    if (v !== "custom") set("custom", null);
                  }}
                >
                  <option value="">未绑定</option>
                  <option value="custom">自定义 API（BYOK）</option>
                  {meta.harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
              {form.harness === "custom" && form.custom && (
                <CustomFields
                  value={form.custom}
                  keyHint={agent?.custom?.keyHint ?? ""}
                  onChange={(c) => set("custom", c)}
                  agentId={agent?.id}
                />
              )}
              {form.harness !== "custom" && (
                <div className="field">
                  <span className="label">工具授权</span>
                  <fieldset className="segmented" aria-label="工具授权">
                    <button
                      type="button"
                      aria-pressed={form.permissionPolicy === "ask"}
                      onClick={() => set("permissionPolicy", "ask")}
                    >
                      每次询问
                    </button>
                    <button
                      type="button"
                      aria-pressed={form.permissionPolicy === "allow"}
                      onClick={() => set("permissionPolicy", "allow")}
                    >
                      自动允许
                    </button>
                  </fieldset>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>身份文档</h3>
              <p>
                团团独立维护，不写进项目目录。
                {form.harness === "custom"
                  ? "作为系统提示发送。"
                  : harness && `${harness.name}：${IDENTITY_DELIVERY[harness.identity]}。`}
              </p>
            </div>
            <div className="card-body">
              <textarea
                className="textarea mono"
                rows={9}
                value={form.identity}
                onChange={(e) => set("identity", e.target.value)}
                aria-label="身份文档"
                placeholder={"# 角色\n你是团队里的前端工程师……\n\n# 约定\n- 改动前先说明计划"}
              />
            </div>
          </section>

          <McpSection
            servers={props.mcpServers}
            selected={form.mcpServerIds}
            toggle={toggleMcp}
            onMcpChange={props.onMcpChange}
          />

          <section className="card">
            <div className="card-head">
              <h3>环境变量</h3>
              <p>只给这个 Agent 的 Harness 进程，例如 API Key。每行 KEY=VALUE。</p>
            </div>
            <div className="card-body">
              <textarea
                className="textarea mono"
                rows={3}
                value={envText}
                onChange={(e) => {
                  setEnvText(e.target.value);
                  set("env", textToEnv(e.target.value));
                }}
                aria-label="环境变量"
                placeholder="ANTHROPIC_API_KEY=sk-…"
                spellCheck={false}
              />
            </div>
          </section>

          {agent && <SkillsCard agentId={agent.id} />}

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
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setForm(initial);
                setEnvText(envToText(initial.env));
              }}
            >
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

function McpSection(props: {
  servers: McpServer[];
  selected: string[];
  toggle: (id: string) => void;
  onMcpChange: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    if (!confirm(`移除 MCP 服务「${s.name}」？\n所有 Agent 都将不再拿到它。`)) return;
    try {
      await api("DELETE", `/api/mcp-servers/${s.id}`);
      await props.onMcpChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const items: PickItem[] = props.servers.map((s) => ({
    id: s.id,
    title: s.name,
    description: s.url,
    trailing: (
      <button
        type="button"
        className="btn ghost sm icon danger"
        title="移除此 MCP 服务"
        aria-label={`移除 ${s.name}`}
        onClick={(e) => {
          e.stopPropagation();
          void remove(s);
        }}
      >
        <Trash2 size={12} />
      </button>
    ),
  }));

  return (
    <section className="card">
      <div className="card-head row" style={{ alignItems: "center" }}>
        <div className="grow">
          <h3>MCP 服务</h3>
          <p>新建 Harness 会话时传给它（session/new 的 mcpServers）。</p>
        </div>
        <button type="button" className="btn sm" onClick={() => setAdding((v) => !v)}>
          <Plug size={13} />
          添加
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
          searchPlaceholder="搜索 MCP 服务"
          emptyText="还没有 MCP 服务"
          groups={[{ items }]}
          selected={props.selected}
          onToggle={props.toggle}
        />
      </div>
    </section>
  );
}

const FORMAT_LABEL: Record<(typeof CUSTOM_FORMATS)[number], string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
};

function CustomFields(props: {
  value: CustomInput;
  keyHint: string;
  onChange: (c: CustomInput) => void;
  agentId?: string;
}) {
  const { value: c, onChange } = props;
  const set = <K extends keyof CustomInput>(k: K, v: CustomInput[K]) => onChange({ ...c, [k]: v });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const r = await api<{ ok: boolean; reply?: string; error?: string }>("POST", "/api/custom/test", {
        ...c,
        agentId: props.agentId,
      });
      setTest(r.ok ? { ok: true, text: r.reply || "ok" } : { ok: false, text: r.error || "失败" });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label className="field">
        <span className="label">接口格式</span>
        <select
          className="select"
          aria-label="接口格式"
          value={c.format}
          onChange={(e) => {
            const format = e.target.value as CustomInput["format"];
            onChange({ ...c, format, baseUrl: c.baseUrl || DEFAULT_BASE_URL[format] });
          }}
        >
          {CUSTOM_FORMATS.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABEL[f]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">Base URL</span>
        <input
          className="input mono"
          aria-label="Base URL"
          value={c.baseUrl}
          onChange={(e) => set("baseUrl", e.target.value)}
          placeholder={DEFAULT_BASE_URL[c.format]}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span className="label">API Key{props.keyHint ? ` · 已保存 ${props.keyHint}` : ""}</span>
        <input
          className="input mono"
          aria-label="API Key"
          type="password"
          value={c.apiKey ?? ""}
          onChange={(e) => set("apiKey", e.target.value)}
          placeholder={props.keyHint ? "留空则保持原 Key" : "sk-…"}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="label">模型</span>
        <input
          className="input mono"
          aria-label="模型"
          value={c.model}
          onChange={(e) => set("model", e.target.value)}
          placeholder="gpt-4.1 / claude-sonnet-4-5"
          spellCheck={false}
        />
      </label>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn sm" disabled={busy || !c.model} onClick={() => void runTest()}>
          {busy ? "测试中…" : "测试连接"}
        </button>
        {test && (
          <span className={test.ok ? "muted" : "error-text"} style={{ fontSize: 12 }}>
            {test.ok ? `✓ ${test.text.slice(0, 80)}` : test.text}
          </span>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        仅对话；群聊可交接。无文件与终端。
      </p>
    </>
  );
}

function SkillsCard({ agentId }: { agentId: string }) {
  const [list, setList] = useState<{ name: string; description: string; enabled: boolean; source: string }[]>([]);
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [_tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void api<{ agent: typeof list }>("GET", `/api/agents/${agentId}/skills`).then(
      (r) => {
        if (!cancelled) setList(r.agent);
      },
      (e) => {
        if (!cancelled) setErr((e as Error).message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  const refresh = () => setTick((t) => t + 1);
  return (
    <section className="card">
      <div className="card-head">
        <h3>Skills</h3>
        <p>SKILL.md 约定；可从 .claude / .agents 导入。</p>
      </div>
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            还没有 Skill
          </span>
        )}
        {list.map((sk) => (
          <label key={sk.name} className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={sk.enabled}
              onChange={() =>
                void api("POST", `/api/agents/${agentId}/skills`, {
                  action: sk.enabled ? "disable" : "enable",
                  name: sk.name,
                }).then(refresh)
              }
            />
            <span className="grow">
              <code>{sk.name}</code>
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                {sk.description}
              </span>
            </span>
          </label>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input mono grow"
            aria-label="导入路径"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="~/proj/.agents 或含 skills/ 的目录"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn sm"
            disabled={!path.trim()}
            onClick={() =>
              void api("POST", `/api/agents/${agentId}/skills`, { action: "import", path: path.trim() })
                .then(() => {
                  setPath("");
                  refresh();
                })
                .catch((e) => setErr((e as Error).message))
            }
          >
            导入
          </button>
        </div>
        {err && <div className="error-text">{err}</div>}
      </div>
    </section>
  );
}
