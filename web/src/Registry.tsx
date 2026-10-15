import { Check, Download, ExternalLink, FlaskConical, Loader2, PlugZap, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { type AuthMethodView, HarnessAuth } from "./HarnessAuth";

export interface RegistryItem {
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  authors: string[];
  website: string | null;
  repository: string | null;
  hasIcon: boolean;
  kinds: ("npx" | "uvx" | "binary")[];
  platforms: string[];
  installable: boolean;
  harnessId: string;
  curated: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  experimental: boolean;
  note: string | null;
}
export interface RegistryView {
  source: "network" | "cache" | "snapshot";
  fetchedAt: number | null;
  error: string | null;
  platform: string;
  agents: RegistryItem[];
}

/** Registry logo: monochrome SVG used as a mask so it takes the text color (light / dark). */
export function RegistryIcon({ id, name, size = 20 }: { id: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = id ? `/api/registry/icon/${encodeURIComponent(id)}` : null;
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onerror = () => setFailed(true);
    img.src = url;
  }, [url]);
  if (!url || failed)
    return (
      <span className="reg-icon reg-icon-letter" style={{ width: size, height: size }} aria-hidden>
        {[...name][0]?.toUpperCase()}
      </span>
    );
  return (
    <span
      className="reg-icon"
      role="img"
      aria-label={`${name} 图标`}
      style={{ width: size, height: size, maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }}
    />
  );
}

const PLATFORM: Record<string, string> = {
  "darwin-aarch64": "macOS (Apple)",
  "darwin-x86_64": "macOS (Intel)",
  "linux-aarch64": "Linux ARM",
  "linux-x86_64": "Linux",
  "windows-aarch64": "Windows ARM",
  "windows-x86_64": "Windows",
};
const KIND: Record<string, string> = { npx: "npm", uvx: "Python", binary: "二进制" };

interface Job {
  state: "running" | "done" | "error" | "cancelled";
  log: string[];
  error: string | null;
}

/**
 * 更多 Agent: every agent in the official ACP registry (plus clearly-marked experimental extras),
 * searchable, each installable with one click into Tuantuan's own directory.
 */
export function RegistrySection(props: { onChanged: () => Promise<void> }) {
  const [view, setView] = useState<RegistryView | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setView(await api<RegistryView>("GET", "/api/registry")), []);
  useEffect(() => void load(), [load]);
  const refresh = async () => {
    setBusy(true);
    try {
      setView(await api<RegistryView>("POST", "/api/registry/refresh"));
    } finally {
      setBusy(false);
    }
  };
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = (view?.agents ?? []).filter((a) => !a.curated);
    const hit = s
      ? all.filter((a) => `${a.name} ${a.id} ${a.description} ${a.authors.join(" ")}`.toLowerCase().includes(s))
      : all;
    // installed first, then experimental last, then by name
    return [...hit].sort(
      (a, b) =>
        Number(!!b.installedVersion) - Number(!!a.installedVersion) ||
        Number(a.experimental) - Number(b.experimental) ||
        a.name.localeCompare(b.name),
    );
  }, [view, q]);
  const when = view?.fetchedAt
    ? new Date(view.fetchedAt).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <section className="card registry-card">
      <div className="card-head row" style={{ alignItems: "center" }}>
        <div className="grow">
          <h3>更多 Agent</h3>
          <p>
            来自{" "}
            <a href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer">
              ACP 官方 Registry
            </a>
            ，{view ? `${view.agents.filter((a) => !a.curated).length} 个` : "…"}
            {view &&
              (view.source === "network"
                ? ` · ${when} 更新`
                : view.source === "cache"
                  ? ` · ${when} 的缓存`
                  : " · 离线快照")}
          </p>
        </div>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="刷新 Registry"
        >
          {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          刷新
        </button>
      </div>
      <div className="card-body">
        {view?.error && <div className="muted harness-sub">{view.error}，先用已有的列表</div>}
        <label className="reg-search">
          <Search size={14} />
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索名称、作者、描述"
            aria-label="搜索 Agent"
          />
        </label>
        <div className="reg-grid">
          {!view && <Loader2 size={16} className="spin" />}
          {view && list.length === 0 && <div className="muted">没有匹配的 Agent</div>}
          {list.map((a) => (
            <RegistryCard
              key={a.id}
              a={a}
              platform={view?.platform ?? ""}
              onChanged={async () => {
                await load();
                await props.onChanged();
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function RegistryCard({
  a,
  platform,
  onChanged,
}: {
  a: RegistryItem;
  platform: string;
  onChanged: () => Promise<void>;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [test, setTest] = useState<
    | { ok: boolean; text: string; methods?: AuthMethodView[]; secretEnv?: Record<string, string>; needsKey?: boolean }
    | "running"
    | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const hid = encodeURIComponent(a.harnessId);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);
  const install = async () => {
    setErr(null);
    try {
      setJob(await api<Job>("POST", `/api/registry/install/${encodeURIComponent(a.id)}`));
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    timer.current = setInterval(async () => {
      const j = await api<Job | null>("GET", `/api/harnesses/${hid}/install`).catch(() => null);
      if (!j) return;
      setJob(j);
      if (j.state !== "running") {
        if (timer.current) clearInterval(timer.current);
        if (j.state === "done") await onChanged();
      }
    }, 400);
  };
  const remove = async () => {
    setErr(null);
    try {
      await api("DELETE", `/api/harnesses/${hid}/managed`);
      setJob(null);
      setTest(null);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const probe = async () => {
    setTest("running");
    type Probe = {
      ok: boolean;
      error?: string;
      protocolVersion?: number;
      agentInfo?: { name: string; title?: string; version: string };
      authMethods?: AuthMethodView[];
      loggedIn?: boolean | null;
      needsKey?: boolean;
      secretEnv?: Record<string, string>;
    };
    const r = await api<Probe>("POST", `/api/harnesses/${hid}/test`).catch(
      (e): Probe => ({ ok: false, error: (e as Error).message }),
    );
    const auth = r.authMethods?.length
      ? ` · 登录：${r.authMethods.map((m) => (m.vars?.length ? `${m.name}（${m.vars.join("、")}）` : m.name)).join(" / ")}`
      : "";
    setTest(
      r.ok
        ? {
            ok: true,
            text: `ACP v${r.protocolVersion} · ${r.agentInfo?.title ?? r.agentInfo?.name ?? "已连接"} · ${
              r.needsKey ? "需要 API Key" : r.loggedIn ? "可以用了" : r.loggedIn === false ? "需要登录" : "已连接"
            }${auth}`,
            methods: r.authMethods,
            secretEnv: r.secretEnv,
            needsKey: r.needsKey,
          }
        : { ok: false, text: r.error ?? "握手失败" },
    );
  };
  const running = job?.state === "running";
  const installed = !!a.installedVersion && !running;
  const here = a.platforms.includes("all") || a.platforms.includes(platform);
  return (
    <article className="reg-item" data-installed={installed || undefined} aria-label={a.name}>
      <div className="reg-head">
        <RegistryIcon id={a.hasIcon ? a.id : null} name={a.name} size={22} />
        <div className="reg-title">
          <b>{a.name}</b>
          <span className="muted">
            {a.version}
            {a.license && ` · ${a.license}`}
          </span>
        </div>
        {a.experimental && (
          <span className="badge warn-badge" title={a.note ?? "实验性"}>
            <FlaskConical size={11} />
            实验性
          </span>
        )}
        {(a.website || a.repository) && (
          <a
            href={a.website ?? a.repository ?? ""}
            target="_blank"
            rel="noreferrer"
            className="muted"
            aria-label={`${a.name} 主页`}
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
      <p className="reg-desc" title={a.description}>
        {a.description}
      </p>
      <div className="reg-tags">
        {a.kinds.map((k) => (
          <span key={k} className="tag">
            {KIND[k]}
          </span>
        ))}
        {!a.platforms.includes("all") && (
          <span className="tag" title={a.platforms.map((p) => PLATFORM[p] ?? p).join("、")}>
            {here ? "支持本机" : "本机不支持"} · {a.platforms.length} 个平台
          </span>
        )}
      </div>
      <div className="reg-actions">
        {running ? (
          <span className="muted row" style={{ gap: 6 }}>
            <Loader2 size={13} className="spin" />
            {job?.log.at(-1)?.slice(0, 40) ?? "安装中…"}
          </span>
        ) : installed ? (
          <>
            <span className="ok-text row" style={{ gap: 4 }}>
              <Check size={13} />
              已安装 {a.installedVersion}
            </span>
            {a.updateAvailable && (
              <button type="button" className="btn sm primary" onClick={() => void install()}>
                更新到 {a.version}
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => void probe()} disabled={test === "running"}>
              {test === "running" ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />}
              握手
            </button>
            <button
              type="button"
              className="btn ghost sm icon"
              aria-label={`卸载 ${a.name}`}
              title="卸载"
              onClick={() => void remove()}
            >
              <Trash2 size={13} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn sm"
            disabled={!a.installable}
            title={a.installable ? "装到团团自己的目录，不需要管理员权限" : "没有适合这台电脑的安装包"}
            onClick={() => void install()}
          >
            <Download size={13} />
            安装
          </button>
        )}
      </div>
      {job?.state === "error" && <div className="error-text harness-sub">安装失败：{job.error}</div>}
      {err && <div className="error-text harness-sub">{err}</div>}
      {test && test !== "running" && (
        <div className={test.ok && !test.needsKey ? "ok-text harness-sub" : "error-text harness-sub"} role="status">
          {test.text}
        </div>
      )}
      {test && test !== "running" && test.ok && hid && (
        <HarnessAuth harnessId={a.harnessId} methods={test.methods} secretEnv={test.secretEnv} onChanged={probe} />
      )}
    </article>
  );
}
