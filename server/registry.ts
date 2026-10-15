import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import snapshot from "./registry-snapshot.json";

/**
 * The official ACP agent registry (https://agentclientprotocol.com/get-started/registry):
 * a JSON list of agents with how to run them (npx / uvx package or per-platform binary archive).
 * Read order: fresh fetch → last good copy in the data dir → snapshot shipped with Tuantuan, so it
 * works offline. Refreshed in the background every few hours; nothing is installed from it unless
 * the user clicks 安装.
 */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const Env = z.record(z.string(), z.string());
const Pkg = z.object({ package: z.string().min(1), args: z.array(z.string()).optional(), env: Env.optional() });
const Binary = z.object({
  archive: z.string().url(),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: Env.optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});
export const RegistryAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  repository: z.string().optional(),
  website: z.string().optional(),
  authors: z.array(z.string()).default([]),
  license: z.string().default(""),
  license_url: z.string().optional(),
  icon: z.string().optional(),
  distribution: z.object({
    npx: Pkg.optional(),
    uvx: Pkg.optional(),
    binary: z.record(z.string(), Binary).optional(),
  }),
});
export const RegistrySchema = z.object({
  version: z.string(),
  agents: z.array(z.unknown()),
});
export type RegistryAgent = z.infer<typeof RegistryAgentSchema>;
export type BinaryTarget = z.infer<typeof Binary>;

/** Registry platform key for this machine: darwin|linux|windows - aarch64|x86_64. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/** Agents Tuantuan adds itself (not in the official registry), clearly marked experimental. */
export const EXTRA_AGENTS: (RegistryAgent & { experimental: true; note: string })[] = [
  {
    id: "zcode-acp",
    name: "ZCode（社区桥接）",
    version: "0.70.0",
    description:
      "社区项目 zcode-acp-server：把智谱 ZCode 的无界面服务桥接成 ACP。需要先装好 ZCode 并登录（~/.zcode）。",
    repository: "https://github.com/william0wang/zcode-acp",
    authors: ["william0wang"],
    license: "Apache-2.0",
    distribution: { npx: { package: "zcode-acp-server@0.70.0" } },
    experimental: true,
    note: "不在官方 Registry 里，实验性",
  },
];

export interface RegistryState {
  agents: (RegistryAgent & { experimental?: boolean; note?: string })[];
  source: "network" | "cache" | "snapshot";
  fetchedAt: number | null;
  error: string | null;
  /** Entries the schema rejected (skipped, not fatal). */
  invalid: string[];
}

function parse(raw: unknown): { agents: RegistryAgent[]; invalid: string[] } {
  const r = RegistrySchema.parse(raw);
  const agents: RegistryAgent[] = [];
  const invalid: string[] = [];
  for (const a of r.agents) {
    const p = RegistryAgentSchema.safeParse(a);
    if (p.success) agents.push(p.data);
    else invalid.push(String((a as { id?: unknown })?.id ?? "?"));
  }
  if (agents.length === 0) throw new Error("Registry 里没有可用的 Agent");
  return { agents, invalid };
}

export class Registry {
  private state: RegistryState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<RegistryState> | null = null;

  constructor(
    private dir: string,
    private url = process.env.TUANTUAN_REGISTRY_URL || REGISTRY_URL,
  ) {
    this.state = this.loadLocal();
  }

  private cacheFile() {
    return join(this.dir, "registry.json");
  }

  private loadLocal(): RegistryState {
    try {
      if (existsSync(this.cacheFile())) {
        const raw = JSON.parse(readFileSync(this.cacheFile(), "utf8")) as { fetchedAt: number; data: unknown };
        const p = parse(raw.data);
        return { ...p, agents: this.withExtras(p.agents), source: "cache", fetchedAt: raw.fetchedAt, error: null };
      }
    } catch {
      // broken cache: fall back to the snapshot
    }
    const p = parse(snapshot);
    return { ...p, agents: this.withExtras(p.agents), source: "snapshot", fetchedAt: null, error: null };
  }

  private withExtras(agents: RegistryAgent[]) {
    return [...agents, ...EXTRA_AGENTS.filter((x) => !agents.some((a) => a.id === x.id))];
  }

  get(): RegistryState {
    return this.state;
  }

  agent(id: string) {
    return this.state.agents.find((a) => a.id === id) ?? null;
  }

  /** Fetch now; on failure keep what we have and remember the error. */
  refresh(signal?: AbortSignal): Promise<RegistryState> {
    this.inflight ??= (async () => {
      try {
        const res = await fetch(this.url, { signal: signal ?? AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const p = parse(data);
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.cacheFile()}.tmp`;
        const fetchedAt = Date.now();
        writeFileSync(tmp, JSON.stringify({ fetchedAt, url: this.url, data }));
        renameSync(tmp, this.cacheFile());
        this.state = { ...p, agents: this.withExtras(p.agents), source: "network", fetchedAt, error: null };
      } catch (e) {
        this.state = { ...this.state, error: `更新 Registry 失败：${(e as Error).message}` };
      } finally {
        this.inflight = null;
      }
      return this.state;
    })();
    return this.inflight;
  }

  /** Background refresh: once soon after start, then every `everyMs`. */
  start(everyMs = 6 * 3600_000) {
    if (this.timer || process.env.TUANTUAN_REGISTRY_OFFLINE === "1") return;
    setTimeout(() => void this.refresh(), 2000).unref?.();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Icon SVG, cached on disk (registry icons are monochrome currentColor SVGs). */
  async icon(id: string): Promise<string | null> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
    const file = join(this.dir, "icons", `${id}.svg`);
    if (existsSync(file)) return readFileSync(file, "utf8");
    const a = this.agent(id);
    if (!a?.icon) return null;
    try {
      const res = await fetch(a.icon, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const svg = await res.text();
      if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) || svg.length > 200_000) return null;
      mkdirSync(join(this.dir, "icons"), { recursive: true });
      writeFileSync(file, svg);
      return svg;
    } catch {
      return null;
    }
  }
}
