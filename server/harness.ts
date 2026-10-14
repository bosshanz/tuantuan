import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

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
}

export const MOCK_AGENT_PATH = resolve(import.meta.dir, "mock-agent.ts");

export const HARNESSES: HarnessSpec[] = [
  {
    id: "claude-code",
    login: "claude",
    name: "Claude Code",
    bin: "claude-agent-acp",
    args: [],
    versionArgs: ["--version"],
    install: "npm i -g @agentclientprotocol/claude-agent-acp",
    auth: "先装 Claude Code（npm i -g @anthropic-ai/claude-code）并运行 claude 完成 /login；或设置 ANTHROPIC_API_KEY",
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
    install: "npm i -g @agentclientprotocol/codex-acp",
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
    install: "npm i -g opencode-ai（或 brew install anomalyco/tap/opencode）",
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

export interface HarnessStatus {
  id: string;
  name: string;
  install: string;
  auth: string;
  login: string;
  docs: string;
  /** Resolved executable, or null when not installed / not found. */
  path: string | null;
  version: string | null;
  override: string | null;
  error: string | null;
}

export async function detectHarness(spec: HarnessSpec, override: string | null): Promise<HarnessStatus> {
  const env = await loginShellEnv();
  const path = override ? (existsSync(override) ? override : null) : which(spec.bin, env.PATH ?? "");
  const base = {
    id: spec.id,
    name: spec.name,
    install: spec.install,
    auth: spec.auth,
    login: spec.login,
    docs: spec.docs,
    override,
  };
  if (!path)
    return { ...base, path: null, version: null, error: override ? `找不到 ${override}` : `PATH 中没有 ${spec.bin}` };
  if (spec.dev) return { ...base, path, version: "mock", error: null };
  try {
    const p = Bun.spawn([path, ...spec.versionArgs], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 8000);
    const out = (await new Response(p.stdout).text()).trim();
    clearTimeout(timer);
    return { ...base, path, version: out.split("\n")[0]?.slice(0, 80) || null, error: null };
  } catch (e) {
    return { ...base, path, version: null, error: (e as Error).message };
  }
}
