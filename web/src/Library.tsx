import { Blocks, Bot, FileText, Loader2, Package, RefreshCw, Search, SquareSlash, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { partsText } from "./AgentEditor";
import { api, type Meta } from "./api";

type Support = "yes" | "partial" | "no";
interface LibItem {
  id: string;
  kind: "skill" | "plugin" | "command" | "agent";
  name: string;
  description: string;
  source: string;
  format: string;
  managed: boolean;
  packageId: string | null;
  version?: string | null;
  counts?: Record<string, number>;
  support: Record<string, { level: Support; missing: string[] }>;
}
interface LibPackage {
  id: string;
  url: string;
  name: string;
  updatedAt: number;
  items: number;
}

const KINDS = [
  { id: "all", label: "全部" },
  { id: "skill", label: "Skill" },
  { id: "plugin", label: "插件" },
  { id: "command", label: "命令" },
  { id: "agent", label: "子代理" },
] as const;
const PART: Record<string, string> = { skills: "Skill", commands: "命令", agents: "子代理", mcp: "MCP", hooks: "Hook" };
const SHORT: Record<string, string> = {
  "claude-code": "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  pi: "Pi",
  minimax: "MiniMax",
  custom: "自定义 API",
};
const KIND_ICON = { skill: FileText, plugin: Blocks, command: SquareSlash, agent: Bot } as const;

export function LibraryPage({ meta }: { meta: Meta }) {
  const [data, setData] = useState<{ items: LibItem[]; packages: LibPackage[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api("GET", "/api/library"));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await f();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const doImport = () =>
    run("import", async () => {
      await api("POST", "/api/library", { url: url.trim() });
      setUrl("");
    });
  const t = q.trim().toLowerCase();
  const shown = (data?.items ?? []).filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (!t || `${i.name} ${i.description} ${i.source} ${i.format}`.toLowerCase().includes(t)),
  );
  const count = (k: string) => (data?.items ?? []).filter((i) => k === "all" || i.kind === k).length;
  const harnessName = (h: string) => SHORT[h] ?? meta.harnesses.find((x) => x.id === h)?.name ?? h;

  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>Skills 与插件</h2>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => void load()} title="重新扫描本机目录">
          <RefreshCw size={14} />
          刷新
        </button>
      </header>
      <div className="page">
        <div className="page-inner lib">
          {err && <div className="form-error">{err}</div>}
          <section className="card">
            <div className="card-head">
              <h3>导入</h3>
              <p>从 git 仓库或链接导入到团团自己的目录；本机的 ~/.claude、~/.codex 只读，不会改动。</p>
            </div>
            <div className="card-body">
              <div className="lib-import">
                <input
                  className="input grow"
                  aria-label="导入链接"
                  placeholder="GitHub / git / SKILL.md 链接"
                  value={url}
                  spellCheck={false}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && url.trim() && !busy) {
                      e.preventDefault();
                      void doImport();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={!url.trim() || !!busy}
                  onClick={() => void doImport()}
                >
                  {busy === "import" ? <Loader2 size={14} className="spin" /> : <Package size={14} />}
                  导入
                </button>
              </div>
              {data && data.packages.length > 0 && (
                <ul className="lib-pkgs" aria-label="已导入">
                  {data.packages.map((p) => (
                    <li key={p.id} className="lib-pkg">
                      <Package size={15} className="muted" aria-hidden />
                      <span className="lib-pkg-text">
                        <b>{p.name}</b>
                        <small title={p.url}>{p.url}</small>
                      </span>
                      <span className="badge">{p.items} 项</span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="重新拉取最新版本"
                        disabled={!!busy}
                        onClick={() => void run(`u-${p.id}`, () => api("POST", `/api/library/${p.id}/update`))}
                      >
                        {busy === `u-${p.id}` ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                        更新
                      </button>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        aria-label={`删除 ${p.name}`}
                        title="删除"
                        disabled={!!busy}
                        onClick={() => {
                          if (confirm(`删除「${p.name}」？用到它的 Agent 会自动不再加载。`))
                            void run(`d-${p.id}`, () => api("DELETE", `/api/library/${p.id}`));
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head card-head-row lib-head">
              <div className="segmented" role="tablist" aria-label="类型">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    role="tab"
                    aria-selected={kind === k.id}
                    onClick={() => setKind(k.id)}
                  >
                    {k.label}
                    <span className="lib-count">{data ? count(k.id) : ""}</span>
                  </button>
                ))}
              </div>
              <div className="skill-search lib-search">
                <Search size={14} aria-hidden />
                <input
                  className="input"
                  aria-label="搜索库"
                  placeholder="搜索"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>
            <div className="card-body">
              {!data && !err && (
                <div className="muted lib-empty">
                  <Loader2 size={14} className="spin" /> 正在扫描…
                </div>
              )}
              {data && shown.length === 0 && (
                <div className="muted lib-empty">{t || kind !== "all" ? "没有匹配的结果" : "还没有 Skill 或插件"}</div>
              )}
              <ul className="lib-list">
                {shown.map((i, n) => {
                  const Icon = KIND_ICON[i.kind];
                  return (
                    <li
                      key={`${i.kind}:${i.id}`}
                      className="lib-item"
                      style={{ ["--i" as string]: Math.min(n, 12) }}
                      data-testid={`lib-${i.name}`}
                    >
                      <span className="lib-icon" data-kind={i.kind}>
                        <Icon size={16} />
                      </span>
                      <div className="lib-main">
                        <div className="lib-title">
                          <b>{i.name}</b>
                          {i.version && <span className="muted lib-ver">v{i.version}</span>}
                          <span className="badge">{i.format}</span>
                          <span className="badge lib-src" title={i.id}>
                            {i.source}
                          </span>
                        </div>
                        {(i.description || i.counts) && (
                          <div className="lib-desc">
                            {[partsText(i.counts), i.description].filter(Boolean).join(" · ")}
                          </div>
                        )}
                        <div className="lib-support">
                          {Object.entries(i.support).map(([h, s]) => (
                            <span
                              key={h}
                              className="lib-chip"
                              data-level={s.level}
                              title={
                                s.level === "yes"
                                  ? `${harnessName(h)} 可用`
                                  : s.level === "no"
                                    ? `${harnessName(h)} 不支持`
                                    : `${harnessName(h)} 不支持：${s.missing.map((m) => PART[m] ?? m).join("、")}`
                              }
                            >
                              {s.level === "yes" ? "✓" : s.level === "no" ? "✕" : "◐"} {harnessName(h)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
