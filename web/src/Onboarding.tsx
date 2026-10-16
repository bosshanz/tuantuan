import { Check, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Agent, api, type HarnessStatus, type Room } from "./api";
import { type AuthMethodView, HarnessAuth } from "./HarnessAuth";
import { translateError, useI18n } from "./i18n";
import { RegistryIcon } from "./Registry";
import { CopyLine, InstallPanel } from "./Setup";

interface Probe {
  ok: boolean;
  error?: string;
  loggedIn?: boolean | null;
  needsKey?: boolean;
  secretEnv?: Record<string, string>;
  authMethods?: AuthMethodView[];
}

/** The six first-class harnesses (+ the test harness when TUANTUAN_MOCK_HARNESS=1). */
const FIRST = ["claude-code", "codex", "grok", "opencode", "pi", "minimax", "mock"];
const SHORT: Record<string, string> = { "claude-code": "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/**
 * First launch: one screen, three steps — pick a harness (install if missing), sign in if needed,
 * name the first agent → it is created with a conversation in 草稿, which then opens.
 * Everything else (providers, skills, identity, models) lives on its own pages.
 */
export function Onboarding(props: { agents: Agent[]; onDone: (roomId: string | null) => Promise<void> }) {
  const { t } = useI18n();
  const [list, setList] = useState<HarnessStatus[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | "running" | null>(null);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const l = await api<HarnessStatus[]>("GET", "/api/harnesses").catch(() => null);
    if (l) setList(l);
    return l;
  }, []);
  useEffect(() => {
    void refresh().then((l) => {
      // Preselect the first harness that is already installed.
      const first = l?.filter((h) => FIRST.includes(h.id)).find((h) => h.command);
      if (first) setPick((p) => p ?? first.id);
    });
  }, [refresh]);

  const cards = (list ?? []).filter((h) => FIRST.includes(h.id));
  const h = cards.find((x) => x.id === pick) ?? null;
  const installed = !!h?.command;

  const current = useRef<string | null>(null);
  current.current = pick;
  const check = useCallback(async (id: string, methodId?: string) => {
    setProbe("running");
    const r = await (methodId
      ? api<Probe>("POST", `/api/harnesses/${id}/authenticate`, { methodId })
      : api<Probe>("POST", `/api/harnesses/${id}/test`)
    ).catch((e): Probe => ({ ok: false, error: (e as Error).message }));
    // a late answer for a harness that is no longer picked is dropped
    if (current.current === id) setProbe(r);
  }, []);
  // Handshake as soon as an installed harness is picked.
  useEffect(() => {
    setProbe(null);
    if (pick && installed) void check(pick);
  }, [pick, installed, check]);
  useEffect(() => {
    if (h && !named) setName(SHORT[h.id] ?? h.name.split(/[\s（(]/)[0] ?? h.name);
  }, [h, named]);
  // Signed in from a terminal? Re-check when the window gets focus again.
  const waiting = !!probe && probe !== "running" && probe.ok && (probe.loggedIn === false || !!probe.needsKey);
  useEffect(() => {
    if (!waiting || !pick) return;
    const f = () => void check(pick);
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [waiting, pick, check]);

  const signedIn = !!probe && probe !== "running" && probe.ok && probe.loggedIn !== false && !probe.needsKey;
  const step = !installed ? 1 : signedIn ? 3 : 2;

  const create = async () => {
    if (!h) return;
    setBusy(true);
    setError(null);
    try {
      let n = name.trim() || h.name;
      const base = n;
      for (let i = 2; props.agents.some((a) => a.name.toLowerCase() === n.toLowerCase()); i++) n = `${base}${i}`;
      const a = await api<Agent>("POST", "/api/agents", { name: n, harness: h.id });
      const r = await api<Room>("POST", "/api/rooms", { name: n, agentIds: [a.id] });
      await props.onDone(r.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const login = h?.login ?? "";
  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>{t("开始使用团团")}</h2>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void props.onDone(null)}>
          {t("跳过")}
        </button>
      </header>
      <div className="page">
        <div className="page-inner onb">
          <ol className="onb-steps">
            <li className="onb-step" data-state={step > 1 ? "done" : "active"}>
              <div className="onb-step-head">
                <span className="num">{step > 1 ? <Check size={13} /> : 1}</span>
                <h3>{t("选一个 Harness")}</h3>
              </div>
              <fieldset className="onb-grid" aria-label="Harness">
                {!list && <Loader2 size={16} className="spin" />}
                {cards.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={pick === c.id}
                    className="onb-card"
                    onClick={() => setPick(c.id)}
                  >
                    <RegistryIcon id={c.registryId} name={c.name} size={22} />
                    <span className="onb-card-name">{t(c.name)}</span>
                    <span className={c.command ? "onb-card-state ok-text" : "onb-card-state"}>
                      {c.command ? t("已安装") : t("未安装")}
                    </span>
                  </button>
                ))}
              </fieldset>
              {h && !installed && (
                <div className="onb-detail">
                  <InstallPanel
                    h={h}
                    onInstalled={async () => {
                      await refresh();
                    }}
                  />
                </div>
              )}
            </li>

            <li className="onb-step" data-state={step > 2 ? "done" : step === 2 ? "active" : "todo"}>
              <div className="onb-step-head">
                <span className="num">{step > 2 ? <Check size={13} /> : 2}</span>
                <h3>{t("登录")}</h3>
                {step >= 2 && probe === "running" && <Loader2 size={14} className="spin muted" />}
                {signedIn && <span className="ok-text onb-note">{t("已就绪")}</span>}
              </div>
              {step === 2 && probe && probe !== "running" && (
                <div className="onb-detail">
                  {!probe.ok && (
                    <div className="error-text">
                      {t("连不上：{error}", { error: translateError(probe.error ?? "") })}
                    </div>
                  )}
                  {probe.ok && (probe.loggedIn === false || probe.needsKey) && (
                    <>
                      <div className="row onb-actions">
                        {probe.authMethods
                          ?.filter((m) => m.type === "agent")
                          .map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              className="btn primary sm"
                              onClick={() => pick && void check(pick, m.id)}
                            >
                              <LogIn size={13} />
                              {t("用「{name}」登录", { name: t(m.name) })}
                            </button>
                          ))}
                        <button type="button" className="btn ghost sm" onClick={() => pick && void check(pick)}>
                          <RefreshCw size={13} />
                          {t("重新检测")}
                        </button>
                      </div>
                      <HarnessAuth
                        harnessId={pick ?? ""}
                        methods={probe.authMethods}
                        secretEnv={probe.secretEnv}
                        onChanged={async () => {
                          if (pick) await check(pick);
                        }}
                      />
                      {login && !probe.authMethods?.some((m) => m.type !== "agent") && (
                        <CopyLine label={t("或在终端运行")} text={login} />
                      )}
                    </>
                  )}
                  {probe.ok === false && (
                    <button type="button" className="btn ghost sm" onClick={() => pick && void check(pick)}>
                      <RefreshCw size={13} />
                      {t("重试")}
                    </button>
                  )}
                </div>
              )}
            </li>

            <li className="onb-step" data-state={step === 3 ? "active" : "todo"}>
              <div className="onb-step-head">
                <span className="num">3</span>
                <h3>{t("给第一个 Agent 起名")}</h3>
              </div>
              {step === 3 && (
                <form
                  className="onb-detail row onb-actions"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                  }}
                >
                  <input
                    className="input"
                    aria-label={t("Agent 名称")}
                    value={name}
                    maxLength={32}
                    onChange={(e) => {
                      setNamed(true);
                      setName(e.target.value);
                    }}
                  />
                  <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
                    {busy && <Loader2 size={14} className="spin" />}
                    {t("创建并开始会话")}
                  </button>
                </form>
              )}
              {error && <div className="error-text onb-detail">{translateError(error)}</div>}
            </li>
          </ol>
        </div>
      </div>
    </>
  );
}
