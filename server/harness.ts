import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Harnesses Tuantuan knows how to drive over ACP. Each agent picks one; the registry owns how to
 * find, launch, install and log in to it, and how the agent's identity doc reaches it
 * (docs/plan-harness-acp.md §3.4).
 */
export type IdentityDelivery =
  /** claude-agent-acp: session/new `_meta.systemPrompt = { append }`. */
  | "claude-meta"
  /** grok agent stdio: session/new `_meta.rules`. */
  | "grok-meta"
  /** codex-acp: process env CODEX_CONFIG={"developer_instructions": …}. */
  | "codex-env"
  /** Anything else: prepended to the first prompt of each new session. */
  | "first-prompt";

export interface HarnessSpec {
  id: string;
  name: string;
  /** Executable looked up on the login-shell PATH unless the user set an absolute override. */
  bin: string;
  args: string[];
  versionArgs: string[];
  install: string;
  auth: string;
  /** Terminal command that logs in, shown with a copy button when ACP `authenticate` can't do it. */
  login: string;
  docs: string;
  identity: IdentityDelivery;
  /** Test-only harness, listed only when TUANTUAN_MOCK_HARNESS=1. */
  dev?: boolean;
  /** ACP adapter shipped as a Tuantuan dependency; used when the user has none on PATH. */
  bundled?: { pkg: string; bin: string };
  /** One-click installs offered on the Harness page, in order of preference (user-level first). */
  installers?: InstallerSpec[];
}

export type InstallTool = "curl" | "bun" | "brew" | "npm" | "sh";
export interface InstallerSpec {
  id: string;
  label: string;
  tool: InstallTool;
  /** Run with bash -c in the login-shell env; `{bun}` is replaced by Tuantuan's own bun. */
  command: string;
}

export const MOCK_INSTALLER_PATH = resolve(import.meta.dir, "mock-installer.ts");

export const MOCK_AGENT_PATH = resolve(import.meta.dir, "mock-agent.ts");

export const HARNESSES: HarnessSpec[] = [
  {
    id: "claude-code",
    login: "claude",
    name: "Claude Code",
    bin: "claude-agent-acp",
    args: [],
    versionArgs: ["--version"],
    install: "已随团团内置（@agentclientprotocol/claude-agent-acp）",
    bundled: { pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
    auth: "运行下面的登录命令完成 /login；或设置 ANTHROPIC_API_KEY",
    docs: "https://github.com/agentclientprotocol/claude-agent-acp",
    identity: "claude-meta",
  },
  {
    id: "codex",
    login: "codex login",
    name: "Codex",
    bin: "codex-acp",
    args: [],
    versionArgs: ["--version"],
    install: "已随团团内置（@agentclientprotocol/codex-acp）",
    bundled: { pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
    auth: "运行 codex login（ChatGPT 账号）；或设置 OPENAI_API_KEY / CODEX_API_KEY",
    docs: "https://github.com/agentclientprotocol/codex-acp",
    identity: "codex-env",
  },
  {
    id: "grok",
    login: "grok login",
    name: "Grok Build",
    bin: "grok",
    args: ["agent", "stdio"],
    versionArgs: ["--version"],
    install: "curl -fsSL https://x.ai/cli/install.sh | bash",
    installers: [
      { id: "script", label: "官方脚本", tool: "curl", command: "curl -fsSL https://x.ai/cli/install.sh | bash" },
    ],
    auth: "运行 grok login；或设置 XAI_API_KEY",
    docs: "https://github.com/xai-org/grok-build",
    identity: "grok-meta",
  },
  {
    id: "opencode",
    login: "opencode auth login",
    name: "OpenCode",
    bin: "opencode",
    args: ["acp"],
    versionArgs: ["--version"],
    install: "curl -fsSL https://opencode.ai/install | bash",
    installers: [
      { id: "script", label: "官方脚本", tool: "curl", command: "curl -fsSL https://opencode.ai/install | bash" },
      { id: "bun", label: "bun", tool: "bun", command: '"{bun}" add -g opencode-ai' },
      { id: "brew", label: "Homebrew", tool: "brew", command: "brew install anomalyco/tap/opencode" },
      { id: "npm", label: "npm", tool: "npm", command: "npm i -g opencode-ai" },
    ],
    auth: "运行 opencode auth login 选择模型提供方",
    docs: "https://opencode.ai/docs/acp/",
    identity: "first-prompt",
  },
  {
    id: "mock",
    login: "",
    name: "Mock（测试）",
    bin: process.execPath,
    args: [MOCK_AGENT_PATH],
    versionArgs: ["--version"],
    install: "内置，仅用于测试",
    auth: "无需登录",
    docs: "",
    identity: "first-prompt",
    dev: true,
  },
  {
    id: "mock-cli",
    login: "",
    name: "Mock CLI（安装测试）",
    get bin() {
      return join(process.env.TUANTUAN_MOCK_INSTALL_DIR || join(tmpdir(), "tuantuan-mock-install"), "mock-cli");
    },
    args: [],
    versionArgs: ["--version"],
    install: "bun server/mock-installer.ts",
    auth: "无需登录",
    docs: "",
    identity: "first-prompt",
    dev: true,
    installers: [{ id: "script", label: "脚本", tool: "sh", command: `"{bun}" "${MOCK_INSTALLER_PATH}"` }],
  },
];

export function harnessSpec(id: string): HarnessSpec | null {
  return HARNESSES.find((h) => h.id === id) ?? null;
}

export function visibleHarnesses(): HarnessSpec[] {
  return HARNESSES.filter((h) => !h.dev || process.env.TUANTUAN_MOCK_HARNESS === "1");
}

let loginEnv: Promise<Record<string, string>> | null = null;

/** Test-only: drop the cached login-shell env so a new ANTHROPIC_* / CODEX_* is picked up. */
export function resetLoginShellEnv() {
  loginEnv = null;
}

/**
 * GUI apps on macOS start with a bare PATH, so harness CLIs installed via npm/brew/curl are not found.
 * Ask the user's login shell once for its environment and merge it over ours.
 */
export function loginShellEnv(): Promise<Record<string, string>> {
  loginEnv ??= (async () => {
    const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] != null));
    const shell = process.env.SHELL || "/bin/bash";
    try {
      const p = Bun.spawn([shell, "-ilc", "env -0"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => p.kill(), 5000);
      const out = await new Response(p.stdout).text();
      clearTimeout(timer);
      const env = { ...base };
      for (const kv of out.split("\0")) {
        const i = kv.indexOf("=");
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      // Common install dirs the login profile may not export (e.g. installers that only touch .bashrc).
      const home = env.HOME ?? "";
      const extra = [
        `${home}/.local/bin`,
        `${home}/.grok/bin`,
        `${home}/.opencode/bin`,
        `${home}/.bun/bin`,
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ];
      env.PATH = [...(env.PATH ?? "").split(delimiter), ...extra]
        .filter((d, i, a) => d && a.indexOf(d) === i)
        .join(delimiter);
      return env;
    } catch {
      return base;
    }
  })();
  return loginEnv;
}

export function which(bin: string, path: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of path.split(delimiter)) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export type HarnessSource = "override" | "path" | "bundled";

export interface InstallerStatus {
  id: string;
  label: string;
  command: string;
  available: boolean;
  /** Why it can't run here (tool missing, needs sudo). */
  reason: string | null;
}

export interface HarnessStatus {
  id: string;
  name: string;
  install: string;
  auth: string;
  login: string;
  docs: string;
  /** Resolved executable (or the bundled adapter's script), or null when not found. */
  path: string | null;
  /** How Tuantuan launches it: `command ...args`. */
  command: string | null;
  args: string[];
  /** Where it came from: the user's override, their PATH (wins), or Tuantuan's bundled copy. */
  source: HarnessSource | null;
  /** Bundled adapter is available as a fallback even when PATH wins. */
  bundledVersion: string | null;
  version: string | null;
  override: string | null;
  error: string | null;
  installers: InstallerStatus[];
}

const req = createRequire(import.meta.url);

/** Script path of a bundled adapter from Tuantuan's own node_modules (bun dev and packaged builds). */
export function bundledAdapter(spec: HarnessSpec): { script: string; version: string } | null {
  if (!spec.bundled || process.env.TUANTUAN_NO_BUNDLED === "1") return null;
  const roots = [req, createRequire(join(process.cwd(), "package.json"))];
  for (const r of roots) {
    try {
      const pkgPath = r.resolve(`${spec.bundled.pkg}/package.json`);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        version: string;
        bin: string | Record<string, string>;
      };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[spec.bundled.bin];
      if (!rel) continue;
      const script = join(dirname(pkgPath), rel);
      if (existsSync(script)) return { script, version: pkg.version };
    } catch {
      // try the next root
    }
  }
  return null;
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Which one-click installers can run here without sudo. */
export async function installerStatuses(spec: HarnessSpec, env: Record<string, string>): Promise<InstallerStatus[]> {
  const path = env.PATH ?? "";
  const out: InstallerStatus[] = [];
  for (const i of spec.installers ?? []) {
    let reason: string | null = null;
    if (i.tool === "curl") {
      if (!which("curl", path)) reason = "没有 curl";
      else if (!which("bash", path)) reason = "没有 bash";
    } else if (i.tool === "brew") {
      if (!which("brew", path)) reason = "没有 Homebrew";
    } else if (i.tool === "npm") {
      const npm = which("npm", path);
      if (!npm) reason = "没有 npm";
      else {
        const p = Bun.spawn([npm, "config", "get", "prefix"], {
          env,
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        });
        const prefix = (await new Response(p.stdout).text()).trim();
        if (!prefix || !canWrite(prefix)) reason = "npm 全局目录需要 sudo";
      }
    }
    out.push({
      id: i.id,
      label: i.label,
      command: i.command.replaceAll('"{bun}"', "bun"),
      available: reason === null,
      reason,
    });
  }
  return out;
}

export async function detectHarness(spec: HarnessSpec, override: string | null): Promise<HarnessStatus> {
  const env = await loginShellEnv();
  const bundled = bundledAdapter(spec);
  const base = {
    id: spec.id,
    name: spec.name,
    install: spec.install,
    auth: spec.auth,
    login: loginCommand(spec, env),
    docs: spec.docs,
    override,
    bundledVersion: bundled?.version ?? null,
    installers: await installerStatuses(spec, env),
  };
  const onPath = override ? (existsSync(override) ? override : null) : which(spec.bin, env.PATH ?? "");
  if (!onPath && bundled && !override)
    return {
      ...base,
      path: bundled.script,
      command: process.execPath,
      args: [bundled.script, ...spec.args],
      source: "bundled",
      version: bundled.version,
      error: null,
    };
  if (!onPath)
    return {
      ...base,
      path: null,
      command: null,
      args: [],
      source: null,
      version: null,
      error: override ? `找不到 ${override}` : `PATH 中没有 ${spec.bin}`,
    };
  const found = {
    ...base,
    path: onPath,
    command: onPath,
    args: spec.args,
    source: (override ? "override" : "path") as HarnessSource,
  };
  if (spec.dev) return { ...found, version: "mock", error: null };
  try {
    const p = Bun.spawn([onPath, ...spec.versionArgs], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 8000);
    const out = (await new Response(p.stdout).text()).trim();
    clearTimeout(timer);
    return { ...found, version: out.split("\n")[0]?.slice(0, 80) || null, error: null };
  } catch (e) {
    return { ...found, version: null, error: (e as Error).message };
  }
}

/**
 * Login command to show. With only the bundled adapter, the user may have no `claude` / `codex` on
 * PATH: point at the engine that ships inside the adapter instead.
 */
function loginCommand(spec: HarnessSpec, env: Record<string, string>): string {
  const path = env.PATH ?? "";
  if (spec.id === "claude-code" && !which("claude", path)) {
    const bin = bundledClaudeBinary();
    if (bin) return `"${bin}"`;
  }
  if (spec.id === "codex" && !which("codex", path)) {
    try {
      const codexAcp = createRequire(req.resolve("@agentclientprotocol/codex-acp/package.json"));
      return `"${process.execPath}" "${codexAcp.resolve("@openai/codex/bin/codex.js")}" login`;
    } catch {
      // not bundled
    }
  }
  return spec.login;
}

/** The Claude Code binary the bundled claude-agent-acp runs (Agent SDK platform package). */
export function bundledClaudeBinary(): string | null {
  try {
    const acp = createRequire(req.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
    const sdk = createRequire(acp.resolve("@anthropic-ai/claude-agent-sdk/package.json"));
    const names =
      process.platform === "linux"
        ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
        : [`${process.platform}-${process.arch}`];
    for (const n of names) {
      try {
        const dir = dirname(sdk.resolve(`@anthropic-ai/claude-agent-sdk-${n}/package.json`));
        const bin = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
        if (existsSync(bin)) return bin;
      } catch {
        // next
      }
    }
  } catch {
    // not bundled
  }
  return null;
}
