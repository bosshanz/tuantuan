import { Check, Copy, ExternalLink, Loader2, PlugZap, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Agent, api, type HarnessStatus, type Meta } from "./api";
import { AgentAvatar } from "./ui";

interface TestResult {
  ok: boolean;
  error?: string;
  protocolVersion?: number;
  agentInfo?: { name: string; title?: string | null; version: string } | null;
  authMethods?: {
    id: string;
    name: string;
    description: string | null;
    type: "agent" | "terminal";
    command: string | null;
  }[];
  /** null: couldn't tell (session/new failed for another reason, see sessionError). */
  loggedIn?: boolean | null;
  sessionError?: string | null;
  authError?: string | null;
}

/**
 * 新手引导 (first launch, with onFinish) and Harness 管理 (afterwards): find the harness CLIs on this machine, show how to install / log in, check the ACP
 * handshake, and bind harnesses to agents. Tuantuan never runs installers or logins itself.
 */
export function SetupPage(props: {
  meta: Meta;
  agents: Agent[];
  onAgentsChange: () => Promise<void>;
  go: (p: string) => void;
  /** Onboarding mode: 跳过 / 完成 call this. */
  onFinish?: () => Promise<void>;
}) {
  const [list, setList] = useState<HarnessStatus[] | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setList(await api<HarnessStatus[]>("GET", "/api/harnesses"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const [authing, setAuthing] = useState<string | null>(null);
  const test = async (id: string, methodId?: string) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    if (methodId) setAuthing(id);
    const r = await (methodId
      ? api<TestResult>("POST", `/api/harnesses/${id}/authenticate`, { methodId })
      : api<TestResult>("POST", `/api/harnesses/${id}/test`)
    ).catch((e) => ({
      ok: false,
      error: (e as Error).message,
    }));
    setAuthing(null);
    setTests((t) => ({ ...t, [id]: r }));
  };

  const bind = async (agent: Agent, harness: string) => {
    try {
      await api("PUT", `/api/agents/${agent.id}`, { ...agent, harness });
      await props.onAgentsChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = async (h: HarnessStatus) => {
    const base = h.name.split(/\s/)[0] ?? h.id;
    let name = base;
    for (let i = 2; props.agents.some((a) => a.name.toLowerCase() === name.toLowerCase()); i++) name = `${base}${i}`;
    try {
      const a = await api<Agent>("POST", "/api/agents", { name, harness: h.id });
      await props.onAgentsChange();
      props.go(`a/${a.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const installed = (list ?? []).filter((h) => h.path);
  return (
    <>
      <header className="main-head">
        <PlugZap size={18} />
        <div className="title">
          <h2>{props.onFinish ? "新手引导" : "Harness 管理"}</h2>
          <div className="sub">接入编码 Agent（Harness），再把它们分给团团里的 Agent</div>
        </div>
        {props.onFinish && (
          <button type="button" className="btn ghost sm" onClick={() => void props.onFinish?.()}>
            跳过
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={() => void refresh()}>
          <RefreshCw size={14} />
          重新检测
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          {error && <div className="form-error">{error}</div>}
          <section className="card">
            <div className="card-head">
              <h3>1 · 安装与登录</h3>
              <p>安装命令在终端里执行；登录优先用 Harness 自带的登录流程，不支持时复制登录命令到终端。</p>
            </div>
            <div className="card-body harness-list">
              {!list && <Loader2 size={16} className="spin" />}
              {list?.map((h) => {
                const t = tests[h.id];
                return (
                  <div key={h.id} className="harness-row" data-ok={h.path ? "" : undefined}>
                    <div className="harness-main">
                      <div className="harness-name">
                        {h.path ? (
                          <Check size={14} className="ok-text" />
                        ) : (
                          <TriangleAlert size={14} className="warn-text" />
                        )}
                        <b>{h.name}</b>
                        {h.version && <span className="badge">{h.version}</span>}
                        {h.docs && (
                          <a
                            href={h.docs}
                            target="_blank"
                            rel="noreferrer"
                            className="muted"
                            aria-label={`${h.name} 文档`}
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                      <div className="harness-sub muted">{h.path ?? h.error}</div>
                      {!h.path && <CopyLine label="安装" text={h.install} />}
                      <div className="harness-sub">登录：{h.auth}</div>
                      {h.path && h.login && <CopyLine label="登录" text={h.login} />}
                      {t &&
                        t !== "running" &&
                        t.authMethods
                          ?.filter((m) => m.type === "terminal" && m.command)
                          .map((m) => <CopyLine key={m.id} label={m.name} text={m.command as string} />)}
                      <PathOverride h={h} onSaved={setList} />
                    </div>
                    <div className="harness-side">
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!h.path || t === "running"}
                        onClick={() => void test(h.id)}
                      >
                        {t === "running" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />}
                        {t && t !== "running" ? "重新检测" : "握手测试"}
                      </button>
                      {authing === h.id && (
                        <div className="muted harness-test" role="status">
                          等待登录完成…（可能会打开浏览器）
                        </div>
                      )}
                      {t && t !== "running" && (
                        <div className={t.ok ? "ok-text harness-test" : "error-text harness-test"} role="status">
                          {t.ok
                            ? `ACP v${t.protocolVersion} · ${t.agentInfo?.title ?? t.agentInfo?.name ?? "已连接"} · ${
                                t.loggedIn === true ? "已登录" : t.loggedIn === false ? "未登录" : "登录状态未知"
                              }`
                            : t.error}
                        </div>
                      )}
                      {t && t !== "running" && t.ok && t.loggedIn === false && (
                        <div className="auth-actions">
                          {t.authError && <div className="error-text">登录失败：{t.authError}</div>}
                          {t.authMethods
                            ?.filter((m) => m.type === "agent")
                            .map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="btn sm primary"
                                title={m.description ?? undefined}
                                onClick={() => void test(h.id, m.id)}
                              >
                                用「{m.name}」登录
                              </button>
                            ))}
                        </div>
                      )}
                      {t && t !== "running" && t.ok && t.sessionError && (
                        <div className="error-text harness-test">{t.sessionError}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>2 · 绑定到 Agent</h3>
              <p>每个 Agent 由一个 Harness 驱动。</p>
            </div>
            <div className="card-body">
              {installed.length > 0 && (
                <div className="row wrap-sm" style={{ gap: 6, marginBottom: 8 }}>
                  {installed.map((h) => (
                    <button key={h.id} type="button" className="btn sm" onClick={() => void create(h)}>
                      新建 {h.name} Agent
                    </button>
                  ))}
                </div>
              )}
              {props.agents.map((a) => (
                <div key={a.id} className="bind-row">
                  <AgentAvatar agent={a} size={24} />
                  <a href={`#/a/${a.id}`} className="grow">
                    {a.name}
                  </a>
                  <select
                    className="select"
                    aria-label={`${a.name} 的 Harness`}
                    value={a.harness}
                    onChange={(e) => void bind(a, e.target.value)}
                  >
                    <option value="">未绑定</option>
                    {props.meta.harnesses.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                        {list && !list.find((x) => x.id === h.id)?.path ? "（未安装）" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>
          {props.onFinish && (
            <div>
              <button type="button" className="btn primary" onClick={() => void props.onFinish?.()}>
                完成
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-line">
      <span className="muted">{label}</span>
      <code>{text}</code>
      <button
        type="button"
        className="btn ghost sm icon"
        aria-label={`复制${label}命令`}
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function PathOverride({ h, onSaved }: { h: HarnessStatus; onSaved: (l: HarnessStatus[]) => void }) {
  const [open, setOpen] = useState(!!h.override);
  const [value, setValue] = useState(h.override ?? "");
  if (!open)
    return (
      <button type="button" className="linkish" onClick={() => setOpen(true)}>
        指定可执行文件路径…
      </button>
    );
  return (
    <form
      className="row"
      style={{ gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        void api<HarnessStatus[]>("PUT", `/api/harnesses/${h.id}/path`, { path: value.trim() || null }).then(onSaved);
      }}
    >
      <input
        className="input mono grow"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="/opt/homebrew/bin/…（留空则按 PATH 查找）"
        aria-label={`${h.name} 路径`}
        spellCheck={false}
      />
      <button type="submit" className="btn sm">
        保存
      </button>
    </form>
  );
}
