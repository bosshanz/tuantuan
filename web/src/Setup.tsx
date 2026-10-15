import { Check, Copy, Download, ExternalLink, Loader2, PlugZap, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * handshake, and bind harnesses to agents. Installers run only when the user clicks one (InstallPanel).
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

  const installed = (list ?? []).filter((h) => h.command);
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
              <p>Claude Code、Codex 已内置；其他可一键安装。登录优先用 Harness 自带流程，不支持时复制命令到终端。</p>
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
                        {h.source && (
                          <span
                            className="badge source-badge"
                            data-source={h.source}
                            title={
                              h.source === "bundled"
                                ? "团团内置的适配器"
                                : h.bundledVersion
                                  ? `用你本机的版本；内置 ${h.bundledVersion} 作后备`
                                  : undefined
                            }
                          >
                            {SOURCE_LABEL[h.source]}
                          </span>
                        )}
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
                      {(!h.command || h.installers.length > 0) && <InstallPanel h={h} onInstalled={refresh} />}
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
                        disabled={!h.command || t === "running"}
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

const SOURCE_LABEL: Record<NonNullable<HarnessStatus["source"]>, string> = {
  bundled: "内置",
  path: "本机",
  override: "自定义路径",
};

interface InstallJob {
  installerId: string;
  command: string;
  state: "running" | "done" | "error" | "cancelled";
  log: string[];
  lines: number;
  from: number;
  error: string | null;
}

/** One-click install: runs the harness's official installer on click, streams its log, re-detects when done. */
function InstallPanel({ h, onInstalled }: { h: HarnessStatus; onInstalled: () => Promise<void> }) {
  const [job, setJob] = useState<InstallJob | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(0);
  const box = useRef<HTMLPreElement>(null);

  const poll = useCallback(async () => {
    const j = await api<InstallJob | null>("GET", `/api/harnesses/${h.id}/install?since=${seen.current}`).catch(
      () => null,
    );
    if (!j) return null;
    if (j.from < seen.current || seen.current === 0) setLog(j.log);
    else setLog((l) => [...l, ...j.log].slice(-400));
    seen.current = j.lines;
    setJob(j);
    return j;
  }, [h.id]);

  // Resume a running install (e.g. after a reload); finished ones from earlier are not shown again.
  useEffect(() => {
    void poll().then((j) => {
      if (j && j.state !== "running") {
        setJob(null);
        setLog([]);
      }
    });
  }, [poll]);
  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const j = await poll();
      if (j?.state === "done") await onInstalled();
    }, 400);
    return () => clearInterval(t);
  }, [running, poll, onInstalled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the log as it grows
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const start = async (installerId: string) => {
    setError(null);
    seen.current = 0;
    setLog([]);
    try {
      setJob({ ...(await api<InstallJob>("POST", `/api/harnesses/${h.id}/install`, { installerId })), from: 0 });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const cancel = () => void api("DELETE", `/api/harnesses/${h.id}/install`).then(() => poll());

  const usable = h.installers.filter((i) => i.available);
  // Installed: keep showing the finished job's log, otherwise nothing to offer.
  if (h.command && !job) return null;
  return (
    <div className="install-panel">
      {h.installers.length > 0 && !running && !h.command && (
        <div className="install-actions">
          {h.installers.map((i, n) => (
            <button
              key={i.id}
              type="button"
              className={`btn sm ${i.available && i.id === usable[0]?.id ? "primary" : ""}`}
              disabled={!i.available}
              title={i.reason ?? i.command}
              onClick={() => void start(i.id)}
            >
              {n === 0 && <Download size={13} />}
              {n === 0 ? `安装（${i.label}）` : i.label}
            </button>
          ))}
        </div>
      )}
      {running && (
        <div className="install-status" role="status">
          <Loader2 size={13} className="spin" />
          <span>安装中…</span>
          <button type="button" className="btn ghost sm" onClick={cancel}>
            <Square size={11} />
            取消
          </button>
        </div>
      )}
      {job && log.length > 0 && (
        <pre ref={box} className="install-log" data-state={job.state} role="log" aria-label={`${h.name} 安装日志`}>
          {log.join("\n")}
        </pre>
      )}
      {job?.state === "done" && <div className="ok-text harness-sub">安装完成</div>}
      {job?.state === "error" && <div className="error-text harness-sub">安装失败：{job.error}</div>}
      {job?.state === "cancelled" && <div className="muted harness-sub">已取消</div>}
      {error && <div className="error-text harness-sub">{error}</div>}
      {h.command ? null : h.installers.length === 0 ? (
        <CopyLine label="安装" text={h.install} />
      ) : (
        !running && usable.length === 0 && <CopyLine label="手动安装" text={h.install} />
      )}
    </div>
  );
}
