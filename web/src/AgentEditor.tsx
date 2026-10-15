import type * as acp from "@agentclientprotocol/sdk";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  FolderOpen,
  Laptop,
  Link2,
  Loader2,
  Lock,
  MessageCircle,
  Plug,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  type Project,
} from "./api";
import { ChoiceList, OptIcon, Popover } from "./ConfigChips";
import { describeOptions, type Opt } from "./config";
import { useFolderPicker } from "./FolderPicker";
import { ProjectPicker } from "./NewRoom";
import { type PickItem, PickList } from "./PickList";
import { HARNESS_NAMES, ProviderIcon, type ProviderItem, providerFits } from "./Providers";
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
    configDefaults: {},
    providerId: null,
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
    a.configDefaults ?? {},
    a.providerId ?? null,
    a.providerId && a.harness === "custom" ? null : a.custom,
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
    if (!agent || !confirm(`删除 Agent「${agent.name}」？\n它会退出所有会话；已有的聊天记录会保留。此操作不可撤销。`))
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
            <span className="hide-sm">对话</span>
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
                    set("configDefaults", {});
                    set("providerId", null);
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
              {(form.harness === "claude-code" || form.harness === "codex" || form.harness === "custom") && (
                <ProviderPick
                  harness={form.harness}
                  value={form.providerId ?? null}
                  onChange={(v) => {
                    if (v !== (form.providerId ?? null) && form.configDefaults?.model) {
                      // Model names differ per 服务商: don't carry one over.
                      const { model: _drop, ...rest } = form.configDefaults;
                      set("configDefaults", rest);
                    }
                    set("providerId", v);
                    if (!v && form.harness === "custom" && !form.custom)
                      set("custom", { format: "openai-chat", baseUrl: "", model: "", apiKey: "" });
                  }}
                />
              )}
              {form.harness === "custom" && form.custom && !form.providerId && (
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
              {form.harness && form.harness !== "custom" && (
                <AgentDefaults
                  key={form.providerId ?? "local"}
                  harness={form.harness}
                  providerId={form.providerId ?? null}
                  value={form.configDefaults ?? {}}
                  onChange={(v) => set("configDefaults", v)}
                />
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

          {agent && <SkillsCard agentId={agent.id} harness={agent.harness} />}

          {agent && (
            <section className="card">
              <div className="card-head">
                <h3>危险操作</h3>
              </div>
              <div className="card-body row" style={{ alignItems: "center" }}>
                <span className="grow muted" style={{ fontSize: 13 }}>
                  删除后它会退出所有会话，聊天记录保留。
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
        仅对话；多 Agent 时可交接。无文件与终端。
      </p>
    </>
  );
}

interface SkillItem {
  key: string;
  name: string;
  description: string;
  origin: string;
  label: string;
  enabled: boolean;
  native: boolean;
}
interface RemoteSkill {
  path: string;
  name: string;
  description: string;
}

function SkillText({ sk }: { sk: SkillItem }) {
  return (
    <>
      <span className="skill-text">
        <span className="skill-name">{sk.name}</span>
        {sk.description && <span className="skill-desc">{sk.description}</span>}
      </span>
      <span className={`badge skill-src src-${sk.origin}`}>{sk.label}</span>
    </>
  );
}

function SkillsCard({ agentId, harness }: { agentId: string; harness: string }) {
  const harnessName = HARNESS_NAMES[harness] ?? "Harness";
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<RemoteSkill[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"preview" | "add" | null>(null);
  const folder = useFolderPicker();
  const base = `/api/agents/${agentId}/skills`;

  useEffect(() => {
    void api<Project[]>("GET", "/api/projects").then(setProjects, () => {});
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a refetch
  useEffect(() => {
    let cancelled = false;
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void api<{ items: SkillItem[] }>("GET", `${base}${q}`).then(
      (r) => !cancelled && setItems(r.items),
      (e) => !cancelled && setErr((e as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [base, projectId, tick]);
  const refresh = () => setTick((t) => t + 1);
  const post = (b: object) => api("POST", base, b);

  const toggle = (sk: SkillItem) => {
    setItems((l) => l?.map((x) => (x.key === sk.key ? { ...x, enabled: !x.enabled } : x)) ?? l);
    void post({ action: sk.enabled ? "disable" : "enable", key: sk.key }).then(refresh, (e) => {
      setErr((e as Error).message);
      refresh();
    });
  };
  const doPreview = async () => {
    setBusy("preview");
    setErr(null);
    try {
      const r = await api<{ skills: RemoteSkill[] }>("POST", base, { action: "preview-url", url: url.trim() });
      setPreview(r.skills);
      setChosen(new Set(r.skills.map((x) => x.path)));
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const doAdd = async () => {
    setBusy("add");
    setErr(null);
    try {
      await post({ action: "import-url", url: url.trim(), paths: [...chosen] });
      setPreview(null);
      setUrl("");
      refresh();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const fromFolder = async () => {
    const dir = await folder.pick("选择 Skill 文件夹");
    if (!dir) return;
    setErr(null);
    await post({ action: "import", path: dir }).then(refresh, (e) => setErr((e as Error).message));
  };

  return (
    <section className="card skills-card">
      <div className="card-head row" style={{ alignItems: "center" }}>
        <h3 className="grow">Skills</h3>
        <ProjectPicker
          className="sm"
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          none={{ id: "", label: "不含项目", desc: "只看全局和这个 Agent 的 Skill", hint: "" }}
        />
      </div>
      <div className="card-body skills-body">
        <ul className="skill-list" aria-label="Skill 列表">
          {items === null && <li className="skill-empty muted">…</li>}
          {items?.length === 0 && <li className="skill-empty muted">没有找到 Skill</li>}
          {items &&
            items.length > 0 &&
            (
              [
                ["自动加载", items.filter((x) => x.native)],
                ["可选", items.filter((x) => !x.native)],
              ] as const
            ).map(
              ([title, list]) =>
                list.length > 0 && (
                  <li key={title} className="skill-group">
                    <span className="skill-group-title">{title}</span>
                    <ul className="skill-list">
                      {list.map((sk) => (
                        <li key={sk.key}>
                          {sk.native ? (
                            <div className="skill-row" data-locked title={`由 ${harnessName} 自动加载`}>
                              <Lock size={13} className="skill-lock" aria-hidden />
                              <SkillText sk={sk} />
                            </div>
                          ) : (
                            <label className="skill-row" title={sk.key}>
                              <input
                                type="checkbox"
                                checked={sk.enabled}
                                onChange={() => toggle(sk)}
                                aria-label={sk.name}
                              />
                              <SkillText sk={sk} />
                            </label>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ),
            )}
        </ul>

        <div className="skill-add">
          <input
            className="input grow"
            aria-label="Skill 链接"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (url.trim() && !busy) void doPreview();
            }}
            placeholder="GitHub / git / SKILL.md 链接"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn"
            disabled={!url.trim() || busy !== null}
            onClick={() => void doPreview()}
          >
            {busy === "preview" ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}
            查找
          </button>
          <button type="button" className="btn" onClick={() => void fromFolder()} disabled={folder.busy}>
            <FolderOpen size={14} />
            文件夹
          </button>
        </div>

        {preview && (
          <div className="skill-preview">
            <ul className="skill-list">
              {preview.map((r) => (
                <li key={r.path}>
                  <label className="skill-row">
                    <input
                      type="checkbox"
                      aria-label={`添加 ${r.name}`}
                      checked={chosen.has(r.path)}
                      onChange={() =>
                        setChosen((c) => {
                          const n = new Set(c);
                          if (n.has(r.path)) n.delete(r.path);
                          else n.add(r.path);
                          return n;
                        })
                      }
                    />
                    <span className="skill-text">
                      <span className="skill-name">{r.name}</span>
                      {r.description && <span className="skill-desc">{r.description}</span>}
                    </span>
                    {r.path !== "." && <span className="badge mono skill-src">{r.path}</span>}
                  </label>
                </li>
              ))}
            </ul>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn ghost sm" onClick={() => setPreview(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={chosen.size === 0 || busy !== null}
                onClick={() => void doAdd()}
              >
                {busy === "add" ? <Loader2 size={13} className="spin" /> : null}
                添加 {chosen.size}
              </button>
            </div>
          </div>
        )}
        {err && <div className="error-text">{err}</div>}
      </div>
      {folder.dialog}
    </section>
  );
}

/** Default model / effort / mode… for new conversations, from the harness's own options. */
function AgentDefaults(props: {
  harness: string;
  providerId: string | null;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const [state, setState] = useState<{ opts: Opt[] | null; error: string | null }>({ opts: null, error: null });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick = retry
  useEffect(() => {
    let off = false;
    setState({ opts: null, error: null });
    void api<{ configOptions: acp.SessionConfigOption[]; modes: acp.SessionModeState | null; error: string | null }>(
      "GET",
      `/api/harnesses/${props.harness}/options?${new URLSearchParams({
        ...(tick ? { refresh: "1" } : {}),
        ...(props.providerId ? { provider: props.providerId } : {}),
      })}`,
    ).then(
      (r) => {
        if (off) return;
        const opts = r.error ? null : describeOptions(r.configOptions);
        setState({ opts, error: r.error });
        // A saved model the current 服务商 doesn't offer would silently fail: fall back to the default.
        const model = opts?.find((o) => o.kind === "model");
        const saved = model ? props.value[model.id] : undefined;
        if (model && saved && !model.choices.some((c) => c.value === saved) && !props.providerId) {
          const next = { ...props.value };
          delete next[model.id];
          props.onChange(next);
        }
      },
      (e) => !off && setState({ opts: null, error: (e as Error).message }),
    );
    return () => {
      off = true;
    };
  }, [props.harness, props.providerId, tick]);
  return (
    <div className="field">
      <span className="label">默认设置</span>
      {state.error ? (
        <div className="defaults-note">
          <span className="muted">读取不到选项：{state.error}</span>
          <button type="button" className="quiet-link" onClick={() => setTick((t) => t + 1)}>
            重试
          </button>
        </div>
      ) : !state.opts ? (
        <div className="defaults-note muted">
          <Loader2 size={13} className="spin" />
          正在读取 Harness 选项…
        </div>
      ) : state.opts.length === 0 ? (
        <div className="defaults-note muted">这个 Harness 没有可调的选项</div>
      ) : (
        <div className="defaults-grid">
          {state.opts.map((o) => (
            <DefaultRow
              key={o.id}
              opt={o}
              harness={props.harness}
              custom={o.kind === "model" && !!props.providerId}
              value={props.value[o.id] ?? null}
              onChange={(v) => {
                const next = { ...props.value };
                if (v === null) delete next[o.id];
                else next[o.id] = v;
                props.onChange(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DefaultRow(props: {
  opt: Opt;
  harness: string;
  value: string | null;
  /** Allow typing a model id the 服务商 serves but the harness doesn't list. */
  custom?: boolean;
  onChange: (v: string | null) => void;
}) {
  const { opt } = props;
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const FOLLOW = "\u0000harness";
  const harnessDefault = opt.choices.find((c) => c.value === opt.current);
  const chosen = props.value !== null ? opt.choices.find((c) => c.value === props.value) : undefined;
  const shown: Opt = {
    ...opt,
    current: props.value ?? FOLLOW,
    choices: [
      {
        value: FOLLOW,
        name: "Harness default",
        label: "跟随 Harness",
        description: harnessDefault ? `当前：${harnessDefault.label}` : null,
        danger: false,
        recommended: false,
      },
      ...opt.choices,
    ],
  };
  return (
    <>
      <span className="defaults-label" title={opt.description ?? opt.name}>
        {opt.label}
      </span>
      <button
        ref={btn}
        type="button"
        className="chip-opt defaults-btn"
        data-open={open || undefined}
        data-danger={chosen?.danger || undefined}
        aria-label={`默认${opt.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <OptIcon opt={opt} harness={props.harness} value={props.value ?? opt.current} />
        <span className="chip-value">{chosen?.label ?? props.value ?? "跟随 Harness"}</span>
        <ChevronDown size={12} className="model-chev" />
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} label={`默认${opt.label}`} align="start">
          <ChoiceList
            opt={shown}
            harness={props.harness}
            free={props.custom ? { placeholder: "自定义模型 ID" } : null}
            onPick={(v) => {
              props.onChange(v === FOLLOW ? null : v);
              setOpen(false);
            }}
          />
        </Popover>
      )}
    </>
  );
}

/** 服务商: "本机配置" (inherit the user's own login / env) or a saved profile that fits the harness. */
function ProviderPick(props: { harness: string; value: string | null; onChange: (v: string | null) => void }) {
  const [items, setItems] = useState<ProviderItem[] | null>(null);
  useEffect(() => {
    api<{ items: ProviderItem[] }>("GET", "/api/providers")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  const fits = (items ?? []).filter((p) => providerFits(p, props.harness) || p.id === props.value);
  return (
    <div className="field">
      <span className="label">服务商</span>
      <fieldset className="prov-pick" aria-label="服务商">
        <button type="button" aria-pressed={!props.value} className="preset" onClick={() => props.onChange(null)}>
          <span className="prov-icon local-icon">
            <Laptop size={12} />
          </span>
          <span className="preset-name">本机配置</span>
        </button>
        {fits.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={props.value === p.id}
            className="preset"
            onClick={() => props.onChange(p.id)}
          >
            <ProviderIcon name={p.name} color={p.color} size={20} />
            <span className="preset-name" title={p.name}>
              {p.name}
            </span>
          </button>
        ))}
      </fieldset>
      <span className="help">
        {props.value
          ? "只用于这个 Agent"
          : props.harness === "custom"
            ? "直接填写下面的接口。"
            : "沿用你自己的登录和环境变量。"}{" "}
        <a href="#/providers">管理服务商</a>
      </span>
    </div>
  );
}
