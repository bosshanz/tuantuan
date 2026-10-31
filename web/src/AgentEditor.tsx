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
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AvatarShape, defaultAvatar } from "../../server/avatars";
import { CUSTOM_FORMATS, DEFAULT_BASE_URL } from "../../server/custom";
import { providerSupports, supportsProviderProfiles } from "../../shared/providerSupport";
import { AvatarPicker } from "./AvatarPicker";
import { type Agent, type AgentInput, api, type CustomInput, type McpServer, type Meta, type Project } from "./api";
import { ChoiceList, OptIcon, Popover } from "./ConfigChips";
import { describeOptions, type Opt } from "./config";
import { useFolderPicker } from "./FolderPicker";
import { translate, translateError, useI18n } from "./i18n";
import { ProjectPicker } from "./NewRoom";
import { type PickItem, PickList } from "./PickList";
import { HARNESS_NAMES, ProviderIcon, type ProviderItem } from "./Providers";
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
    useProfile: true,
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
    a.useProfile !== false,
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
  const { t } = useI18n();
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

  const [pendingSkills, setPendingSkills] = useState<Set<string>>(new Set());
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
      if (!agent)
        for (const key of pendingSkills)
          await api(
            "POST",
            `/api/agents/${saved.id}/skills`,
            key.startsWith("plugin:") ? { action: "enable-plugin", key: key.slice(7) } : { action: "enable", key },
          ).catch(() => {});
      setJustSaved(true);
      props.onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (
      !agent ||
      !confirm(
        t("删除 Agent「{name}」？\n它会退出所有会话；已有的聊天记录会保留。此操作不可撤销。", { name: agent.name }),
      )
    )
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
        <button type="button" className="btn ghost icon back-btn" onClick={props.onBack} aria-label={t("返回")}>
          <ChevronLeft size={18} />
        </button>
        <div className="preview-head title">
          <AgentAvatar agent={form} size={28} />
          <div className="editor-title">
            <h2>{agent ? agent.name : form.name.trim() || t("新建 Agent")}</h2>
            <div className="sub">
              {form.harness === "custom" ? t("自定义 API") : harness ? t(harness.name) : t("未绑定 Harness")}
            </div>
          </div>
        </div>
        {agent && (
          <button type="button" className="btn" onClick={() => props.onStartChat(agent)}>
            <MessageCircle size={15} />
            <span className="hide-sm">{t("对话")}</span>
          </button>
        )}
      </header>
      <form className="page" onSubmit={save}>
        <div className="page-inner">
          <section className="card">
            <div className="card-head">
              <h3>{t("基本信息")}</h3>
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
                  <span className="label">{t("名称")}</span>
                  <input
                    className="input"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    maxLength={32}
                    required
                    placeholder={t("例如：产品经理Alice")}
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head card-head-row">
              <h3>Harness</h3>
              <a href="#/harness">{t("检测与登录")}</a>
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
                  <option value="">{t("未绑定")}</option>
                  <option value="custom">{t("自定义 API（BYOK）")}</option>
                  {meta.harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {t(h.name)}
                    </option>
                  ))}
                </select>
              </label>
              {supportsProviderProfiles(form.harness) && (
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
              {form.harness === "custom" && (
                <div>
                  <span className="badge">{t("仅对话（无文件或终端）")}</span>
                </div>
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
                  <span className="label">{t("工具授权")}</span>
                  <fieldset className="segmented" aria-label={t("工具授权")}>
                    <button
                      type="button"
                      aria-pressed={form.permissionPolicy === "ask"}
                      onClick={() => set("permissionPolicy", "ask")}
                    >
                      {t("每次询问")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={form.permissionPolicy === "allow"}
                      onClick={() => set("permissionPolicy", "allow")}
                    >
                      {t("自动允许")}
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
              <h3>{t("身份文档")}</h3>
            </div>
            <div className="card-body">
              <textarea
                className="textarea mono"
                rows={9}
                value={form.identity}
                onChange={(e) => set("identity", e.target.value)}
                aria-label={t("身份文档")}
                placeholder={t("角色、职责和工作约定")}
              />
              <label className="profile-optin">
                <input
                  type="checkbox"
                  className="tg"
                  aria-label={t("附上我的「关于我」")}
                  checked={form.useProfile !== false}
                  onChange={(e) => set("useProfile", e.target.checked)}
                />
                <span>
                  {t("附上我的「关于我」")}
                  <span className="muted">
                    <a href="#/profile">{t("个人资料")}</a>
                    {t(" · 新会话生效")}
                  </span>
                </span>
              </label>
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
              <h3>{t("环境变量")}</h3>
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
                aria-label={t("环境变量")}
                placeholder={"KEY=VALUE\nKEY=VALUE"}
                spellCheck={false}
              />
            </div>
          </section>

          {form.harness !== "custom" && (
            <SkillsCard
              agentId={agent?.id ?? null}
              harness={agent?.harness ?? form.harness}
              pending={pendingSkills}
              onPending={setPendingSkills}
            />
          )}

          {agent && (
            <section className="card">
              <div className="card-head">
                <h3>{t("危险操作")}</h3>
              </div>
              <div className="card-body row" style={{ alignItems: "center" }}>
                <span className="grow muted" style={{ fontSize: 13 }}>
                  {t("删除后它会退出所有会话，聊天记录保留。")}
                </span>
                <button type="button" className="btn danger" onClick={remove}>
                  <Trash2 size={15} />
                  {t("删除 Agent")}
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
                {translateError(error)}
              </span>
            ) : dirty ? (
              t("有未保存的修改")
            ) : justSaved ? (
              <>
                <Check size={14} color="var(--ok)" />
                {t("已保存")}
              </>
            ) : agent ? (
              t("所有修改已保存")
            ) : (
              t("填写名称后即可创建")
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
              {t("放弃修改")}
            </button>
          )}
          <button type="submit" className="btn primary" disabled={saving || (!!agent && !dirty) || !form.name.trim()}>
            {saving ? t("保存中…") : agent ? t("保存修改") : t("创建 Agent")}
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
  const { t } = useI18n();
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
    if (!confirm(t("移除 MCP 服务「{name}」？\n所有 Agent 都将不再拿到它。", { name: s.name }))) return;
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
        title={t("移除此 MCP 服务")}
        aria-label={t("移除 {name}", { name: s.name })}
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
          <h3>{t("MCP 服务")}</h3>
        </div>
        <button type="button" className="btn sm" onClick={() => setAdding((v) => !v)}>
          <Plug size={13} />
          {t("添加")}
        </button>
      </div>
      <div className="card-body">
        {adding && (
          <div className="row wrap-sm" style={{ alignItems: "flex-end" }}>
            <label className="field" style={{ width: 160 }}>
              <span className="label">{t("名称")}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("可选")} />
            </label>
            <label className="field grow">
              <span className="label">{t("Streamable HTTP 地址")}</span>
              <input
                className="input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
            <button type="button" className="btn primary" onClick={() => void add()} disabled={!url.trim()}>
              {t("添加")}
            </button>
          </div>
        )}
        {error && <div className="form-error">{translateError(error)}</div>}
        <PickList
          searchPlaceholder={t("搜索 MCP 服务")}
          emptyText={t("还没有 MCP 服务")}
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
  const { t } = useI18n();
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
        <span className="label">{t("接口格式")}</span>
        <select
          className="select"
          aria-label={t("接口格式")}
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
        <span className="label">API Key{props.keyHint ? t(" · 已保存 {hint}", { hint: props.keyHint }) : ""}</span>
        <input
          className="input mono"
          aria-label="API Key"
          type="password"
          value={c.apiKey ?? ""}
          onChange={(e) => set("apiKey", e.target.value)}
          placeholder={props.keyHint ? t("留空则保持原 Key") : "sk-…"}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="field">
        <span className="label">{t("模型")}</span>
        <input
          className="input mono"
          aria-label={t("模型")}
          value={c.model}
          onChange={(e) => set("model", e.target.value)}
          placeholder="gpt-4.1 / claude-sonnet-4-5"
          spellCheck={false}
        />
      </label>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn sm" disabled={busy || !c.model} onClick={() => void runTest()}>
          {busy ? t("测试中…") : t("测试连接")}
        </button>
        {test && (
          <span className={test.ok ? "muted" : "error-text"} style={{ fontSize: 12 }}>
            {test.ok ? `✓ ${test.text.slice(0, 80)}` : translateError(test.text)}
          </span>
        )}
      </div>
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
  sources?: { key: string; label: string; native: boolean }[];
}
interface RemoteSkill {
  path: string;
  name: string;
  description: string;
}

function skillSourceLabel(source: string): string {
  const project = /^项目 (\.[^\s]+)$/.exec(source);
  return project ? translate("项目 {path}", { path: project[1] ?? "" }) : translate(source);
}

function SkillText({ sk }: { sk: SkillItem }) {
  const { t } = useI18n();
  return (
    <>
      <span className="skill-text">
        <span className="skill-name">{sk.name}</span>
        {sk.description && <span className="skill-desc">{sk.description}</span>}
      </span>
      <span
        className={`badge skill-src src-${sk.origin}`}
        title={(sk.sources ?? [{ key: sk.key, label: sk.label, native: sk.native }])
          .map((source) => `${skillSourceLabel(source.label)}${source.native ? t(" · 原生可用") : ""}: ${source.key}`)
          .join("\n")}
      >
        {skillSourceLabel(sk.label)}
      </span>
    </>
  );
}

interface PluginItem {
  key: string;
  name: string;
  description: string;
  label: string;
  counts?: Record<string, number>;
  support: { level: "yes" | "partial" | "no"; missing: string[] };
  enabled: boolean;
}
const PART_LABEL: Record<string, string> = {
  skills: "Skill",
  commands: "命令",
  agents: "子代理",
  mcp: "MCP",
  hooks: "Hook",
};
export function partsText(c?: Record<string, number>): string {
  if (!c) return "";
  return Object.entries(c)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${translate(PART_LABEL[k] ?? k)}`)
    .join(" · ");
}
function SupportBadge({ s, harnessName }: { s: PluginItem["support"]; harnessName: string }) {
  const { t } = useI18n();
  if (s.level === "yes")
    return (
      <span className="badge ok-badge" title={t("{name} 全部可用", { name: harnessName })}>
        {t("可用")}
      </span>
    );
  const miss = s.missing.map((m) => t(PART_LABEL[m] ?? m)).join(", ");
  return (
    <span
      className={`badge ${s.level === "no" ? "no-badge" : "warn-badge"}`}
      title={t("{name} 不支持：{missing}", { name: harnessName, missing: miss })}
    >
      {s.level === "no" ? t("不支持") : t("部分 · 无{missing}", { missing: miss })}
    </span>
  );
}

/** agentId null = new agent: lists what is on this machine; choices are applied after the first save. */
function SkillsCard({
  agentId,
  harness,
  pending,
  onPending,
}: {
  agentId: string | null;
  harness: string;
  pending?: Set<string>;
  onPending?: (s: Set<string>) => void;
}) {
  const { t } = useI18n();
  const harnessName = t(HARNESS_NAMES[harness] ?? "Harness");
  const [items, setItems] = useState<SkillItem[] | null>(null);
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [q, setQ] = useState("");
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
  const listUrl = agentId ? base : `/api/skills?harness=${encodeURIComponent(harness)}`;

  useEffect(() => {
    void api<Project[]>("GET", "/api/projects").then(setProjects, () => {});
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a refetch
  useEffect(() => {
    let cancelled = false;
    const q = projectId ? `${listUrl.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : "";
    void api<{ items: SkillItem[]; plugins?: PluginItem[] }>("GET", `${listUrl}${q}`).then(
      (r) => {
        if (cancelled) return;
        setItems(r.items);
        setPlugins(r.plugins ?? []);
      },
      (e) => !cancelled && setErr((e as Error).message),
    );
    return () => {
      cancelled = true;
    };
  }, [listUrl, projectId, tick]);
  const refresh = () => setTick((t) => t + 1);
  const post = (b: object) => api("POST", base, b);

  const toggle = (sk: SkillItem) => {
    if (!agentId) {
      const next = new Set(pending);
      if (next.has(sk.key)) next.delete(sk.key);
      else next.add(sk.key);
      onPending?.(next);
      return;
    }
    setItems((l) => l?.map((x) => (x.key === sk.key ? { ...x, enabled: !x.enabled } : x)) ?? l);
    void post({ action: sk.enabled ? "disable" : "enable", key: sk.key }).then(refresh, (e) => {
      setErr((e as Error).message);
      refresh();
    });
  };
  const togglePlugin = (pl: PluginItem) => {
    const key = `plugin:${pl.key}`;
    if (!agentId) {
      const next = new Set(pending);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onPending?.(next);
      return;
    }
    setPlugins((l) => l.map((x) => (x.key === pl.key ? { ...x, enabled: !x.enabled } : x)));
    void post({ action: pl.enabled ? "disable-plugin" : "enable-plugin", key: pl.key }).then(refresh, (e) => {
      setErr((e as Error).message);
      refresh();
    });
  };
  const match = (x: { name: string; description: string; label?: string }) => {
    const t = q.trim().toLowerCase();
    return !t || `${x.name} ${x.description} ${x.label ?? ""}`.toLowerCase().includes(t);
  };
  const shownItems = items?.filter(match) ?? null;
  const shownPlugins = plugins.filter(match);
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
    const dir = await folder.pick(t("选择 Skill 文件夹"));
    if (!dir) return;
    setErr(null);
    await post({ action: "import", path: dir }).then(refresh, (e) => setErr((e as Error).message));
  };

  return (
    <section className="card skills-card">
      <div className="card-head row" style={{ alignItems: "center" }}>
        <h3 className="grow">{t("Skills 与插件")}</h3>
        <ProjectPicker
          className="sm"
          projects={projects}
          value={projectId}
          onChange={setProjectId}
          none={{ id: "", label: t("不含项目"), desc: t("只看全局和这个 Agent 的 Skill"), hint: "" }}
        />
      </div>
      <div className="card-body skills-body">
        <div className="skill-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            aria-label={t("搜索 Skills 与插件")}
            placeholder={t("搜索")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {shownPlugins.length > 0 && (
          <div className="skill-group">
            <span className="skill-group-title">{t("插件")}</span>
            <ul className="skill-list" aria-label={t("插件列表")}>
              {shownPlugins.map((pl) => (
                <li key={pl.key}>
                  <label className="skill-row" title={pl.key} data-off={pl.support.level === "no" || undefined}>
                    <input
                      type="checkbox"
                      checked={agentId ? pl.enabled : !!pending?.has(`plugin:${pl.key}`)}
                      disabled={pl.support.level === "no"}
                      onChange={() => togglePlugin(pl)}
                      aria-label={pl.name}
                    />
                    <span className="skill-text">
                      <span className="skill-name">{pl.name}</span>
                      <span className="skill-desc">
                        {[pl.description, partsText(pl.counts)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <SupportBadge s={pl.support} harnessName={harnessName} />
                    <span className="badge skill-src">{skillSourceLabel(pl.label)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul className="skill-list" aria-label={t("Skill 列表")}>
          {shownItems === null && (
            <li className="skill-empty muted">
              <Loader2 size={14} className="spin" /> {t("正在查找…")}
            </li>
          )}
          {shownItems?.length === 0 && shownPlugins.length === 0 && (
            <li className="skill-empty muted">{q ? t("没有匹配的结果") : t("没有找到 Skill")}</li>
          )}
          {shownItems &&
            shownItems.length > 0 &&
            (
              [
                [t("原生可用"), shownItems.filter((x) => x.native)],
                [t("可选"), shownItems.filter((x) => !x.native)],
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
                            <div
                              className="skill-row"
                              data-locked
                              title={t("由 {name} 从已有目录自动发现，停用请修改对应原生配置或文件", {
                                name: harnessName,
                              })}
                            >
                              <Lock size={13} className="skill-lock" aria-hidden />
                              <SkillText sk={sk} />
                            </div>
                          ) : (
                            <label className="skill-row" title={sk.key}>
                              <input
                                type="checkbox"
                                checked={agentId ? sk.enabled : !!pending?.has(sk.key)}
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

        {!agentId && <div className="muted skill-hint">{t("保存后可以从链接或文件夹添加 Skill")}</div>}
        {agentId && (
          <div className="skill-add">
            <input
              className="input grow"
              aria-label={t("Skill 链接")}
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
              placeholder={t("GitHub / git / SKILL.md 链接")}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn"
              disabled={!url.trim() || busy !== null}
              onClick={() => void doPreview()}
            >
              {busy === "preview" ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}
              {t("查找")}
            </button>
            <button type="button" className="btn" onClick={() => void fromFolder()} disabled={folder.busy}>
              <FolderOpen size={14} />
              {t("文件夹")}
            </button>
          </div>
        )}

        {preview && (
          <div className="skill-preview">
            <ul className="skill-list">
              {preview.map((r) => (
                <li key={r.path}>
                  <label className="skill-row">
                    <input
                      type="checkbox"
                      aria-label={t("添加 {name}", { name: r.name })}
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
                {t("取消")}
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={chosen.size === 0 || busy !== null}
                onClick={() => void doAdd()}
              >
                {busy === "add" ? <Loader2 size={13} className="spin" /> : null}
                {t("添加 {count}", { count: chosen.size })}
              </button>
            </div>
          </div>
        )}
        {err && <div className="error-text">{translateError(err)}</div>}
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
  const { t } = useI18n();
  const [state, setState] = useState<{ opts: acp.SessionConfigOption[] | null; error: string | null }>({
    opts: null,
    error: null,
  });
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
        setState({ opts: r.error ? null : r.configOptions, error: r.error });
        // A saved model the current 服务商 doesn't offer would silently fail: fall back to the default.
        const model = opts?.find((o) => o.kind === "model");
        const saved = model ? props.value[model.id] : undefined;
        if (
          model &&
          saved &&
          !model.choices.some((c) => c.value === saved) &&
          (!props.providerId || props.harness === "opencode" || props.harness === "pi")
        ) {
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
  const options = state.opts ? describeOptions(state.opts) : null;
  return (
    <div className="field">
      <span className="label">{t("默认设置")}</span>
      {state.error ? (
        <div className="defaults-note">
          <span className="muted">{t("读取不到选项：{error}", { error: translateError(state.error) })}</span>
          <button type="button" className="quiet-link" onClick={() => setTick((t) => t + 1)}>
            {t("重试")}
          </button>
        </div>
      ) : !options ? (
        <div className="defaults-note muted">
          <Loader2 size={13} className="spin" />
          {t("正在读取 Harness 选项…")}
        </div>
      ) : options.length === 0 ? (
        <div className="defaults-note muted">{t("这个 Harness 没有可调的选项")}</div>
      ) : (
        <div className="defaults-grid">
          {options.map((o) => (
            <DefaultRow
              key={o.id}
              opt={o}
              harness={props.harness}
              custom={
                o.kind === "model" && !!props.providerId && props.harness !== "opencode" && props.harness !== "pi"
              }
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
  const { t } = useI18n();
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
        label: t("跟随 Harness"),
        description: harnessDefault ? t("当前：{label}", { label: t(harnessDefault.label) }) : null,
        danger: false,
        recommended: false,
      },
      ...opt.choices,
    ],
  };
  return (
    <>
      <span className="defaults-label" title={t(opt.description ?? opt.name)}>
        {t(opt.label)}
      </span>
      <button
        ref={btn}
        type="button"
        className="chip-opt defaults-btn"
        data-open={open || undefined}
        data-danger={chosen?.danger || undefined}
        aria-label={t("默认{label}", { label: t(opt.label) })}
        onClick={() => setOpen((v) => !v)}
      >
        <OptIcon opt={opt} harness={props.harness} value={props.value ?? opt.current} />
        <span className="chip-value">{chosen ? t(chosen.label) : (props.value ?? t("跟随 Harness"))}</span>
        <ChevronDown size={12} className="model-chev" />
      </button>
      {open && (
        <Popover
          anchor={btn.current}
          onClose={() => setOpen(false)}
          label={t("默认{label}", { label: t(opt.label) })}
          align="start"
        >
          <ChoiceList
            opt={shown}
            harness={props.harness}
            free={props.custom ? { placeholder: t("自定义模型 ID") } : null}
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
  const { t } = useI18n();
  const [items, setItems] = useState<ProviderItem[] | null>(null);
  useEffect(() => {
    api<{ items: ProviderItem[] }>("GET", "/api/providers")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  const fits = (items ?? []).filter((p) => providerSupports(p, props.harness) || p.id === props.value);
  return (
    <div className="field">
      <span className="label">{t("服务商")}</span>
      <fieldset className="prov-pick" aria-label={t("服务商")}>
        <button type="button" aria-pressed={!props.value} className="preset" onClick={() => props.onChange(null)}>
          <span className="prov-icon local-icon">
            <Laptop size={12} />
          </span>
          <span className="preset-name">{t(props.harness === "custom" ? "直接填写" : "本机配置")}</span>
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
        <a href="#/providers">{t("管理服务商")}</a>
      </span>
    </div>
  );
}
