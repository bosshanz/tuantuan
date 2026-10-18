import { Check, Copy, Download, ExternalLink, Loader2, PlugZap, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Agent, api, type HarnessStatus, type Meta } from "./api";
import { HarnessAuth } from "./HarnessAuth";
import { translateError, useI18n } from "./i18n";
import { RegistryIcon, RegistrySection } from "./Registry";
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
    type: "agent" | "terminal" | "env";
    command: string | null;
    vars?: string[] | null;
    missing?: string[] | null;
  }[];
  needsKey?: boolean;
  secretEnv?: Record<string, string>;
  /** null: couldn'result tell (session/new failed for another reason, see sessionError). */
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
  const { t } = useI18n();
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
    setTests((result) => ({ ...result, [id]: "running" }));
    if (methodId) setAuthing(id);
    const r = await (methodId
      ? api<TestResult>("POST", `/api/harnesses/${id}/authenticate`, { methodId })
      : api<TestResult>("POST", `/api/harnesses/${id}/test`)
    ).catch((e) => ({
      ok: false,
      error: (e as Error).message,
    }));
    setAuthing(null);
    setTests((result) => ({ ...result, [id]: r }));
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
  const curated = (list ?? []).filter((h) => h.curated);
  const changed = async () => {
    await refresh();
    await props.onAgentsChange();
  };
  return (
    <>
      <header className="main-head">
        <PlugZap size={18} />
        <div className="title">
          <h2>{props.onFinish ? t("新手引导") : t("Harness 管理")}</h2>
          <div className="sub">{t("接入编码 Agent（Harness），再把它们分给团团里的 Agent")}</div>
        </div>
        {props.onFinish && (
          <button type="button" className="btn ghost sm" onClick={() => void props.onFinish?.()}>
            {t("跳过")}
          </button>
        )}
        <button type="button" className="btn ghost sm" onClick={() => void refresh()}>
          <RefreshCw size={14} />
          {t("重新检测")}
        </button>
      </header>
      <div className="page">
        <div className="page-inner">
          {error && <div className="form-error">{translateError(error)}</div>}
          <section className="card">
            <div className="card-head">
              <h3>{t("1 · 安装与登录")}</h3>
              <p>
                {t(
                  "你本机装的版本优先；没有时一键装到团团自己的目录，不需要管理员权限。登录优先用 Harness 自带流程，不支持时复制命令到终端。",
                )}
              </p>
            </div>
            <div className="card-body harness-list">
              {!list && <Loader2 size={16} className="spin" />}
              {curated.map((h) => {
                const result = tests[h.id];
                return (
                  <div key={h.id} className="harness-row" data-ok={h.path ? "" : undefined}>
                    <div className="harness-main">
                      <div className="harness-name">
                        {h.path ? (
                          <Check size={14} className="ok-text" />
                        ) : (
                          <TriangleAlert size={14} className="warn-text" />
                        )}
                        <RegistryIcon id={h.registryId} name={h.name} size={16} />
                        <b>{t(h.name)}</b>
                        {h.experimental && <span className="badge warn-badge">{t("实验性")}</span>}
                        {h.version && <span className="badge">{h.version}</span>}
                        {h.source && (
                          <span
                            className="badge source-badge"
                            data-source={h.source}
                            title={
                              h.source === "bundled"
                                ? t("团团内置的适配器")
                                : h.bundledVersion
                                  ? t("用你本机的版本；内置 {version} 作后备", { version: h.bundledVersion })
                                  : undefined
                            }
                          >
                            {t(SOURCE_LABEL[h.source])}
                          </span>
                        )}
                        {h.docs && (
                          <a
                            href={h.docs}
                            target="_blank"
                            rel="noreferrer"
                            className="muted"
                            aria-label={t("{name} 文档", { name: t(h.name) })}
                          >
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                      <div className="harness-sub muted">{h.path ?? translateError(h.error ?? "")}</div>
                      {(!h.command || h.installers.length > 0) && <InstallPanel h={h} onInstalled={changed} />}
                      {(h.updateAvailable || h.source === "managed") && <ManagedActions h={h} onChanged={changed} />}
                      <div className="harness-sub">{t("登录：{auth}", { auth: t(h.auth) })}</div>
                      {h.path && h.login && <CopyLine label={t("登录")} text={h.login} />}
                      <HarnessAuth
                        harnessId={h.id}
                        methods={result && result !== "running" ? result.authMethods : undefined}
                        secretEnv={result && result !== "running" ? (result.secretEnv ?? h.secretEnv) : h.secretEnv}
                        onChanged={async () => {
                          await refresh();
                          await test(h.id);
                        }}
                      />
                      <PathOverride h={h} onSaved={setList} />
                    </div>
                    <div className="harness-side">
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!h.command || result === "running"}
                        onClick={() => void test(h.id)}
                      >
                        {result === "running" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />}
                        {result && result !== "running" ? t("重新检测") : t("握手测试")}
                      </button>
                      {authing === h.id && (
                        <div className="muted harness-test" role="status">
                          {t("等待登录完成…（可能会打开浏览器）")}
                        </div>
                      )}
                      {result && result !== "running" && (
                        <div
                          className={`${result.ok ? (result.loggedIn === true && !result.needsKey ? "ok-text" : "muted") : "error-text"} harness-test`}
                          role="status"
                        >
                          {result.ok
                            ? `ACP v${result.protocolVersion} · ${result.agentInfo?.title ?? result.agentInfo?.name ?? t("已连接")} · ${
                                result.needsKey
                                  ? t("需要 API Key")
                                  : result.loggedIn === true
                                    ? t("已登录")
                                    : result.loggedIn === false
                                      ? t("未登录")
                                      : t("登录状态未知")
                              }`
                            : translateError(result.error ?? "")}
                        </div>
                      )}
                      {result && result !== "running" && result.ok && result.loggedIn === false && (
                        <div className="auth-actions">
                          {result.authError && (
                            <div className="error-text">
                              {t("登录失败：{error}", { error: translateError(result.authError) })}
                            </div>
                          )}
                          {result.authMethods
                            ?.filter((m) => m.type === "agent")
                            .map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                className="btn sm primary"
                                title={m.description ? t(m.description) : undefined}
                                onClick={() => void test(h.id, m.id)}
                              >
                                {t("用「{name}」登录", { name: t(m.name) })}
                              </button>
                            ))}
                        </div>
                      )}
                      {result && result !== "running" && result.ok && result.sessionError && (
                        <div className="error-text harness-test">{translateError(result.sessionError)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <RegistrySection onChanged={changed} />

          <section className="card">
            <div className="card-head">
              <h3>{t("2 · 绑定到 Agent")}</h3>
              <p>{t("每个 Agent 由一个 Harness 驱动。")}</p>
            </div>
            <div className="card-body">
              {installed.length > 0 && (
                <div className="row wrap-sm" style={{ gap: 6, marginBottom: 8 }}>
                  {installed.map((h) => (
                    <button key={h.id} type="button" className="btn sm" onClick={() => void create(h)}>
                      {t("新建 {name} Agent", { name: t(h.name) })}
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
                    aria-label={t("{name} 的 Harness", { name: a.name })}
                    value={a.harness}
                    onChange={(e) => void bind(a, e.target.value)}
                  >
                    <option value="">{t("未绑定")}</option>
                    {props.meta.harnesses.map((h) => (
                      <option key={h.id} value={h.id}>
                        {t(h.name)}
                        {list && !list.find((x) => x.id === h.id)?.path ? t("（未安装）") : ""}
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
                {t("完成")}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Update / uninstall a harness Tuantuan installed from the ACP registry. */
function ManagedActions({ h, onChanged }: { h: HarnessStatus; onChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"update" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = async () => {
    setBusy("update");
    setError(null);
    try {
      await api("POST", `/api/harnesses/${h.id}/install`, { installerId: "registry" });
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const j = await api<InstallJob | null>("GET", `/api/harnesses/${h.id}/install`);
        if (!j || j.state === "running") continue;
        if (j.state === "error") setError(j.error);
        break;
      }
      await onChanged();
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await api("DELETE", `/api/harnesses/${h.id}/managed`);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="install-actions">
      {h.updateAvailable && (
        <button type="button" className="btn sm primary" disabled={!!busy} onClick={() => void update()}>
          {busy === "update" ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
          {t("更新到 {version}", { version: h.latestVersion ?? "" })}
        </button>
      )}
      {h.source === "managed" && (
        <button type="button" className="btn ghost sm" disabled={!!busy} onClick={() => void remove()}>
          {t("卸载团团安装的版本")}
        </button>
      )}
      {error && <span className="error-text">{translateError(error)}</span>}
    </div>
  );
}

export function CopyLine({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-line">
      <span className="muted">{t(label)}</span>
      <code>{text}</code>
      <button
        type="button"
        className="btn ghost sm icon"
        aria-label={t("复制命令：{label}", { label: t(label) })}
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
  const { t } = useI18n();
  const [open, setOpen] = useState(!!h.override);
  const [value, setValue] = useState(h.override ?? "");
  if (!open)
    return (
      <button type="button" className="quiet-link" onClick={() => setOpen(true)}>
        {t("自定义路径")}
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
        placeholder={t("/opt/homebrew/bin/…（留空则按 PATH 查找）")}
        aria-label={t("{name} 路径", { name: t(h.name) })}
        spellCheck={false}
      />
      <button type="submit" className="btn sm">
        {t("保存")}
      </button>
      {!h.override && (
        <button type="button" className="btn ghost sm" onClick={() => setOpen(false)}>
          {t("取消")}
        </button>
      )}
    </form>
  );
}

const SOURCE_LABEL: Record<NonNullable<HarnessStatus["source"]>, string> = {
  bundled: "内置",
  path: "本机",
  override: "自定义路径",
  managed: "团团安装",
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
export function InstallPanel({ h, onInstalled }: { h: HarnessStatus; onInstalled: () => Promise<void> }) {
  const { t } = useI18n();
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
    const result = setInterval(async () => {
      const j = await poll();
      if (j?.state === "done") await onInstalled();
    }, 400);
    return () => clearInterval(result);
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
              title={i.reason ? translateError(i.reason) : i.command}
              onClick={() => void start(i.id)}
            >
              {n === 0 && <Download size={13} />}
              {n === 0 ? t("安装（{label}）", { label: t(i.label) }) : t(i.label)}
            </button>
          ))}
        </div>
      )}
      {running && (
        <div className="install-status" role="status">
          <Loader2 size={13} className="spin" />
          <span>{t("安装中…")}</span>
          <button type="button" className="btn ghost sm" onClick={cancel}>
            <Square size={11} />
            {t("取消")}
          </button>
        </div>
      )}
      {job && log.length > 0 && (
        <pre
          ref={box}
          className="install-log"
          data-state={job.state}
          role="log"
          aria-label={t("{name} 安装日志", { name: t(h.name) })}
        >
          {log.join("\n")}
        </pre>
      )}
      {job?.state === "done" && <div className="ok-text harness-sub">{t("安装完成")}</div>}
      {job?.state === "error" && (
        <div className="error-text harness-sub">
          {t("安装失败：{error}", { error: translateError(job.error ?? "") })}
        </div>
      )}
      {job?.state === "cancelled" && <div className="muted harness-sub">{t("已取消")}</div>}
      {error && <div className="error-text harness-sub">{translateError(error)}</div>}
      {h.command ? null : h.installers.length === 0 ? (
        <CopyLine label={t("安装")} text={t(h.install)} />
      ) : (
        !running && usable.length === 0 && <CopyLine label={t("手动安装")} text={t(h.install)} />
      )}
    </div>
  );
}
