import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { readManifest } from "./managed";
import { platformKey, type Registry, type RegistryAgent } from "./registry";

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
  /** ACP registry entry that can install it into Tuantuan's own directory (one-click 安装). */
  registry?: string;
  /** Runtime for a registry npm package when its engines field isn't enough to tell. */
  runtime?: "bun" | "node";
  /** Listed on the Harness page's first list (curated) vs only under 更多. */
  curated?: boolean;
  experimental?: boolean;
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
    registry: "claude-acp",
    curated: true,
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
    registry: "codex-acp",
    curated: true,
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
    registry: "grok-build",
    curated: true,
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
    registry: "opencode",
    curated: true,
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
    id: "pi",
    login: "pi",
    name: "Pi",
    bin: "pi-acp",
    args: [],
    versionArgs: ["--version"],
    install: "npm i -g pi-acp @mariozechner/pi-coding-agent",
    registry: "pi-acp",
    curated: true,
    auth: "pi-acp 会调用本机的 pi：先装 pi 并在终端运行 pi 配置模型和 Key",
    docs: "https://github.com/svkozak/pi-acp",
    identity: "first-prompt",
  },
  {
    id: "minimax",
    login: "mcode",
    name: "MiniMax Code",
    bin: "mcode",
    args: ["acp"],
    versionArgs: ["--version"],
    install: "npm i -g @minimax-ai/code（需要 Node ≥ 22.19）",
    registry: "minimax-code",
    runtime: "node",
    curated: true,
    auth: "在终端运行 mcode 登录 MiniMax 账号，或按握手结果里的方式登录",
    docs: "https://agent.minimax.io",
    identity: "first-prompt",
  },
  {
    id: "deepseek",
    login: "",
    name: "DeepSeek Harness",
    bin: "dsh",
    args: ["--profile", "acp"],
    versionArgs: ["--version"],
    install: "团团补充的官方 npm 预发布包 @deepseek-ai/dsh@0.2.1-rc.2（需要 Node ≥ 22.19）",
    registry: "deepseek-harness",
    runtime: "node",
    curated: true,
    experimental: true,
    auth: "设置 DEEPSEEK_API_KEY；也可沿用 ~/.dsh/.credentials.yaml（DSH_HOME 可改目录）。本机已保存的凭据优先于环境变量；握手不验证 Key 是否有效。",
    docs: "https://github.com/deepseek-ai/deepseek-harness",
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

let registry: Registry | null = null;
/** The app's registry client (set once at startup). */
export function setRegistry(r: Registry | null) {
  registry = r;
}
export function getRegistry() {
  return registry;
}

/** Harness id for an ACP registry agent without a curated entry. */
export const REG_PREFIX = "reg:";

/** A harness spec straight from a registry entry: installed and launched only by Tuantuan. */
export function registrySpec(a: RegistryAgent & { experimental?: boolean }): HarnessSpec {
  return {
    id: `${REG_PREFIX}${a.id}`,
    name: a.name,
    bin: "",
    args: [],
    versionArgs: [],
    install: "在「Harness」页的「更多」里一键安装",
    login: "",
    auth: "按握手结果里 Agent 自己声明的方式登录",
    docs: a.website ?? a.repository ?? "",
    identity: "first-prompt",
    registry: a.id,
    experimental: a.experimental,
  };
}

export function harnessSpec(id: string): HarnessSpec | null {
  const h = HARNESSES.find((x) => x.id === id);
  if (h) return h;
  if (id.startsWith(REG_PREFIX)) {
    const a = registry?.agent(id.slice(REG_PREFIX.length));
    if (a) return registrySpec(a);
    // Uninstalled from the registry but still installed here: keep it usable.
    const m = readManifest(id.slice(REG_PREFIX.length));
    if (m)
      return registrySpec({
        id: m.id,
        name: m.id,
        version: m.version,
        description: "",
        authors: [],
        license: "",
        distribution: {},
      });
  }
  return null;
}

/** Curated harnesses plus every registry agent installed through Tuantuan. */
export function visibleHarnesses(): HarnessSpec[] {
  const curated = HARNESSES.filter((h) => !h.dev || process.env.TUANTUAN_MOCK_HARNESS === "1");
  const taken = new Set(curated.map((h) => h.registry).filter(Boolean));
  const extra = (registry?.get().agents ?? [])
    .filter((a) => !taken.has(a.id) && readManifest(a.id))
    .map((a) => registrySpec(a));
  return [...curated, ...extra];
}

/** Spec for a registry agent id: its curated harness if there is one, else the generic one. */
export function specForRegistryAgent(id: string): HarnessSpec | null {
  return HARNESSES.find((h) => h.registry === id) ?? harnessSpec(`${REG_PREFIX}${id}`);
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
      // Markers keep banners / prompts printed by rc files out of the parsed environment.
      const marker = "__TUANTUAN_ENV__";
      const p = Bun.spawn([shell, "-ilc", `printf ${marker}; env -0; printf ${marker}`], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const timer = setTimeout(() => p.kill(), 5000);
      const raw = await new Response(p.stdout).text();
      clearTimeout(timer);
      const out = raw.includes(marker) ? (raw.split(marker)[1] ?? "") : raw;
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

export type HarnessSource = "override" | "path" | "bundled" | "managed";

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
  /** Extra env the registry entry asks for (managed installs). */
  env: Record<string, string>;
  /** API keys saved for this harness in 团团, masked (filled in by the API, not by detection). */
  secretEnv?: Record<string, string>;
  /** ACP registry: entry id, the version Tuantuan installed, the registry's current version. */
  registryId: string | null;
  managedVersion: string | null;
  latestVersion: string | null;
  /** A Tuantuan-managed install is older than the registry's version. */
  updateAvailable: boolean;
  /** The registry can install it on this platform (npx / uvx / a binary for this OS+CPU). */
  installable: boolean;
  curated: boolean;
  experimental: boolean;
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
  // Tuantuan's own install from the ACP registry comes first: no sudo, no global changes.
  const reg = spec.registry ? registry?.agent(spec.registry) : null;
  if (reg) {
    const d = reg.distribution;
    const what = d.binary?.[platformKey()]
      ? d.binary[platformKey()]?.archive
      : (d.npx?.package ?? (d.uvx ? `uvx ${d.uvx.package}` : ""));
    out.push({
      id: "registry",
      label: "团团安装",
      command: `${reg.origin === "tuantuan" ? "团团补充目录" : "ACP Registry"}：${reg.name} ${reg.version}（${what}）`,
      available: registryInstallable(reg),
      reason: registryInstallable(reg) ? null : `没有适合 ${platformKey()} 的安装包`,
    });
  }
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
  const reg = spec.registry ? (registry?.agent(spec.registry) ?? null) : null;
  const managed = spec.registry ? readManifest(spec.registry) : null;
  const base = {
    env: {} as Record<string, string>,
    registryId: spec.registry ?? null,
    managedVersion: managed?.version ?? null,
    latestVersion: reg?.version ?? null,
    updateAvailable: !!(managed && reg && managed.version !== reg.version),
    installable: !!reg && registryInstallable(reg),
    curated: !!spec.curated || !!spec.dev,
    experimental: !!spec.experimental,
    id: spec.id,
    name: spec.name,
    // The desktop package does not ship Claude Code / Codex adapters by default: say so instead of "built in".
    install: spec.bundled && !bundled ? "桌面版未内置，可在 Harness 页从 ACP Registry 一键安装" : spec.install,
    auth: spec.auth,
    login: loginCommand(spec, env),
    docs: spec.docs,
    override,
    bundledVersion: bundled?.version ?? null,
    installers: await installerStatuses(spec, env),
  };
  const onPath = override
    ? existsSync(override)
      ? override
      : null
    : spec.bin
      ? which(spec.bin, env.PATH ?? "")
      : null;
  // The user's own install wins; then the copy shipped inside Tuantuan; then one Tuantuan installed.
  if (!onPath && !override && managed && !(bundled && process.env.TUANTUAN_PREFER_MANAGED !== "1"))
    return {
      ...base,
      env: managed.env,
      path: managed.args[0] && managed.kind === "npx" ? managed.args[0] : managed.command,
      command: managed.command,
      args: managed.args,
      source: "managed",
      version: managed.version,
      error: null,
    };
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
      error: override ? `找不到 ${override}` : spec.bin ? `PATH 中没有 ${spec.bin}` : "未安装",
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
export function loginCommand(spec: HarnessSpec, env: Record<string, string>): string {
  const path = env.PATH ?? "";
  // Bundled copy first, else the one Tuantuan installed from the registry.
  const roots = [req];
  const m = spec.registry ? readManifest(spec.registry) : null;
  if (m?.kind === "npx") roots.push(createRequire(join(m.dir, "package.json")));
  if (spec.id === "claude-code" && !which("claude", path)) {
    for (const r of roots) {
      const bin = bundledClaudeBinary(r);
      if (bin) return `"${bin}"`;
    }
  }
  if (spec.id === "codex" && !which("codex", path)) {
    for (const r of roots) {
      try {
        const codexAcp = createRequire(r.resolve("@agentclientprotocol/codex-acp/package.json"));
        return `"${process.execPath}" "${codexAcp.resolve("@openai/codex/bin/codex.js")}" login`;
      } catch {
        // not here
      }
    }
  }
  return spec.login;
}

/** The Claude Code binary the bundled claude-agent-acp runs (Agent SDK platform package). */
export function bundledClaudeBinary(from: NodeJS.Require = req): string | null {
  try {
    const acp = createRequire(from.resolve("@agentclientprotocol/claude-agent-acp/package.json"));
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

/** Whether this machine can install a registry entry (npx / uvx always; binaries per OS+CPU). */
export function registryInstallable(a: RegistryAgent): boolean {
  return !!(a.distribution.npx || a.distribution.uvx || a.distribution.binary?.[platformKey()]);
}
