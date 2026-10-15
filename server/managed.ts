import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { platformKey, type RegistryAgent } from "./registry";

/**
 * Harnesses installed by Tuantuan from the ACP registry, into a directory it owns
 * (<data>/harnesses, or $TUANTUAN_HARNESS_DIR): never global, never sudo, version pinned to the
 * registry entry. Layout:
 *   agents/<id>/<version>/…   one install per version (npm packages, extracted archives, uv tools)
 *   agents/<id>/manifest.json how to launch the current one
 *   runtimes/node-vX, runtimes/uv-vX   runtimes fetched on demand (Node ≥ 22.19 for packages that need it)
 */
export type ManagedKind = "npx" | "uvx" | "binary";
export type ManagedRuntime = "bun" | "node" | "uv" | "native";
export interface ManagedManifest {
  id: string;
  version: string;
  kind: ManagedKind;
  runtime: ManagedRuntime;
  command: string;
  args: string[];
  env: Record<string, string>;
  dir: string;
  installedAt: number;
}

let rootDir: string | null = null;
export function setManagedRoot(dir: string) {
  rootDir = dir;
}
export function managedRoot(): string {
  return process.env.TUANTUAN_HARNESS_DIR || rootDir || join(process.cwd(), "data", "harnesses");
}
const agentDir = (id: string) => join(managedRoot(), "agents", id);

export function readManifest(id: string): ManagedManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(agentDir(id), "manifest.json"), "utf8")) as ManagedManifest;
    return existsSync(m.command) || m.command === process.execPath ? m : null;
  } catch {
    return null;
  }
}

export function uninstallManaged(id: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error("bad id");
  rmSync(agentDir(id), { recursive: true, force: true });
}

export type Log = (line: string) => void;
interface Ctx {
  log: Log;
  signal: AbortSignal;
  /** Login-shell env (PATH for a user's own node / uv). */
  env: Record<string, string>;
  /** Force a runtime for npx packages (curated knowledge); otherwise read from engines.node. */
  runtime?: "bun" | "node";
}

/** Split "@scope/name@1.2.3" / "name@1.2.3" / "pkg==1.0" into name + version. */
export function splitPackage(spec: string): { name: string; version: string | null } {
  if (spec.includes("==")) {
    const [name, version] = spec.split("==");
    return { name: name as string, version: version ?? null };
  }
  const at = spec.lastIndexOf("@");
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  return { name: spec, version: null };
}

/** Lowest version an engines.node range admits ("^20.19.0 || >=24" → [20,19,0]). */
export function nodeMin(range: string | undefined): [number, number, number] | null {
  if (!range) return null;
  let best: [number, number, number] | null = null;
  for (const part of range.split("||")) {
    const m = part.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) continue;
    const v: [number, number, number] = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
    if (!best || cmp(v, best) < 0) best = v;
  }
  return best;
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};
const parseVer = (s: string) =>
  (s
    .match(/(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number) ?? [0, 0, 0]) as number[];

/** Install (or update to) the registry's version of an agent; returns the new manifest. */
export async function installManaged(agent: RegistryAgent, ctx: Ctx): Promise<ManagedManifest> {
  const d = agent.distribution;
  const plat = platformKey();
  const base = agentDir(agent.id);
  const dir = join(base, agent.version.replace(/[^\w.-]/g, "_"));
  const tmp = `${dir}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  let m: Omit<ManagedManifest, "dir" | "installedAt">;
  try {
    if (d.binary?.[plat]) m = await installBinary(agent, d.binary[plat], tmp, dir, ctx);
    else if (d.npx) m = await installNpx(agent, tmp, dir, ctx);
    else if (d.uvx) {
      // uv tool venvs hard-code their location: install straight into the final directory.
      rmSync(dir, { recursive: true, force: true });
      m = await installUvx(agent, dir, ctx);
    } else throw new Error(`${agent.name} 没有适合这台电脑（${plat}）的安装包`);
    if (m.kind === "uvx") rmSync(tmp, { recursive: true, force: true });
    else {
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (d.uvx && !d.binary?.[plat] && !d.npx) rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const manifest: ManagedManifest = { ...m, dir, installedAt: Date.now() };
  writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
  // Older versions go once the new one is in place.
  for (const n of readdirSync(base))
    if (n !== basename(dir) && n !== "manifest.json") rmSync(join(base, n), { recursive: true, force: true });
  ctx.log(`已安装 ${agent.name} ${agent.version}`);
  return manifest;
}

/** Which kinds this machine can install for an agent (for the UI). */
export function installableKind(agent: RegistryAgent): ManagedKind | null {
  if (agent.distribution.binary?.[platformKey()]) return "binary";
  if (agent.distribution.npx) return "npx";
  if (agent.distribution.uvx) return "uvx";
  return null;
}

// ---------- npx: npm package, run with Bun (default) or Node when it needs Node ----------

async function installNpx(agent: RegistryAgent, tmp: string, final: string, ctx: Ctx) {
  const pkg = agent.distribution.npx as NonNullable<RegistryAgent["distribution"]["npx"]>;
  const { name, version } = splitPackage(pkg.package);
  // Decide the runtime from the package's own engines field (fetched from the npm registry).
  let runtime = ctx.runtime;
  if (!runtime) {
    const engines = await npmEngines(name, version, ctx).catch(() => null);
    const min = nodeMin(engines ?? undefined);
    runtime = min && min[0] >= 22 ? "node" : "bun";
    ctx.log(`运行环境：${runtime === "node" ? `Node（要求 ${engines}）` : "团团内置的 Bun"}`);
  }
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify(
      {
        name: "tuantuan-managed",
        private: true,
        dependencies: { [name]: version ?? "latest" },
        // The user asked for this package: let its own install script run, as npx would.
        trustedDependencies: [name],
      },
      null,
      2,
    ),
  );
  let node: string | null = null;
  if (runtime === "node") {
    node = await ensureNode([22, 19, 0], ctx);
    const npm = npmCli(node);
    await run(node, [npm, "install", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier"], {
      ...ctx,
      cwd: tmp,
      env: { ...ctx.env, PATH: [dirname(node), ctx.env.PATH ?? ""].join(delimiter) },
    });
  } else {
    await run(process.execPath, ["install", "--production", "--no-progress"], { ...ctx, cwd: tmp });
  }
  const pj = JSON.parse(readFileSync(join(tmp, "node_modules", name, "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const short = name.split("/").pop() as string;
  const rel = typeof pj.bin === "string" ? pj.bin : pj.bin ? (pj.bin[short] ?? Object.values(pj.bin)[0]) : undefined;
  if (!rel) throw new Error(`${name} 没有可执行入口（package.json bin）`);
  const script = join(final, "node_modules", name, rel);
  return {
    id: agent.id,
    version: agent.version,
    kind: "npx" as const,
    runtime,
    command: runtime === "node" ? (node as string) : process.execPath,
    args: [script, ...(pkg.args ?? [])],
    env: pkg.env ?? {},
  };
}

async function npmEngines(name: string, version: string | null, ctx: Ctx): Promise<string | null> {
  const reg = (ctx.env.npm_config_registry || process.env.npm_config_registry || "https://registry.npmjs.org").replace(
    /\/$/,
    "",
  );
  const res = await fetch(`${reg}/${name.replace("/", "%2f")}/${version ?? "latest"}`, {
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { engines?: { node?: string } }).engines?.node ?? null;
}

function npmCli(node: string) {
  const d = dirname(node);
  for (const p of [
    join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(d, "node_modules", "npm", "bin", "npm-cli.js"),
    join(d, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ])
    if (existsSync(p)) return p;
  throw new Error(`找不到 ${node} 对应的 npm`);
}

/** A Node ≥ min: the user's own (login PATH) if new enough, else a Tuantuan-managed one. */
export async function ensureNode(min: [number, number, number], ctx: Ctx): Promise<string> {
  const own = Bun.which("node", { PATH: ctx.env.PATH ?? "" });
  if (own) {
    const v = Bun.spawnSync([own, "--version"], { stdout: "pipe" }).stdout.toString().trim();
    if (cmp(parseVer(v), min) >= 0 && hasNpm(own)) {
      ctx.log(`使用本机 Node ${v}`);
      return own;
    }
  }
  const rt = join(managedRoot(), "runtimes");
  const have = existsSync(rt)
    ? readdirSync(rt)
        .filter((n) => n.startsWith("node-v"))
        .map((n) => ({ n, v: parseVer(n) }))
        .filter((x) => cmp(x.v, min) >= 0)
        .sort((a, b) => cmp(b.v, a.v))
    : [];
  const exe = (dir: string) => (process.platform === "win32" ? join(dir, "node.exe") : join(dir, "bin", "node"));
  if (have[0] && existsSync(exe(join(rt, have[0].n)))) return exe(join(rt, have[0].n));
  const version = await latestNode(22, min, ctx);
  const os = process.platform === "win32" ? "win" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  const file = `node-${version}-${os}-${arch}.${ext}`;
  const dist = process.env.TUANTUAN_NODE_DIST || "https://nodejs.org/dist";
  ctx.log(`下载 Node ${version}（只给需要它的 Agent 用，放在团团的目录里）`);
  const sums = await (await fetch(`${dist}/${version}/SHASUMS256.txt`, { signal: ctx.signal })).text();
  const sha = sums
    .split("\n")
    .find((l) => l.endsWith(`  ${file}`))
    ?.split(/\s+/)[0];
  if (!sha) throw new Error(`SHASUMS256 里没有 ${file}`);
  const tmp = join(rt, `.dl-${version}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, file);
  await download(`${dist}/${version}/${file}`, archive, sha, ctx);
  await extract(archive, tmp, ctx);
  const inner = join(tmp, file.replace(/\.(tar\.gz|zip)$/, ""));
  const dest = join(rt, `node-${version}`);
  rmSync(dest, { recursive: true, force: true });
  renameSync(inner, dest);
  rmSync(tmp, { recursive: true, force: true });
  return exe(dest);
}

function hasNpm(node: string) {
  try {
    npmCli(node);
    return true;
  } catch {
    return false;
  }
}

async function latestNode(major: number, min: [number, number, number], ctx: Ctx): Promise<string> {
  const dist = process.env.TUANTUAN_NODE_DIST || "https://nodejs.org/dist";
  try {
    const list = (await (
      await fetch(`${dist}/index.json`, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]) })
    ).json()) as { version: string }[];
    const hit = list.find((x) => x.version.startsWith(`v${major}.`) && cmp(parseVer(x.version), min) >= 0);
    if (hit) return hit.version;
  } catch {
    // fall back to a known-good pin
  }
  return "v22.20.0";
}

// ---------- uvx: Python package through uv (the user's, or a managed one) ----------

async function installUvx(agent: RegistryAgent, final: string, ctx: Ctx) {
  const pkg = agent.distribution.uvx as NonNullable<RegistryAgent["distribution"]["uvx"]>;
  const uv = await ensureUv(ctx);
  const env = uvEnv(final);
  await run(uv, ["tool", "install", "--force", pkg.package], { ...ctx, env: { ...ctx.env, ...env } });
  const { name } = splitPackage(pkg.package);
  const bins = existsSync(env.UV_TOOL_BIN_DIR) ? readdirSync(env.UV_TOOL_BIN_DIR) : [];
  const exe = bins.find((b) => b.replace(/\.exe$/, "") === name) ?? bins[0];
  if (!exe) throw new Error(`${pkg.package} 没有安装出可执行文件`);
  return {
    id: agent.id,
    version: agent.version,
    kind: "uvx" as const,
    runtime: "uv" as const,
    command: join(env.UV_TOOL_BIN_DIR, exe),
    args: pkg.args ?? [],
    env: { UV_PYTHON_INSTALL_DIR: env.UV_PYTHON_INSTALL_DIR, ...(pkg.env ?? {}) },
  };
}

function uvEnv(dir: string) {
  const root = managedRoot();
  return {
    UV_TOOL_DIR: join(dir, "tools"),
    UV_TOOL_BIN_DIR: join(dir, "bin"),
    UV_CACHE_DIR: join(root, "cache", "uv"),
    UV_PYTHON_INSTALL_DIR: join(root, "runtimes", "python"),
  };
}

export async function ensureUv(ctx: Ctx): Promise<string> {
  const own = Bun.which("uv", { PATH: ctx.env.PATH ?? "" });
  if (own) return own;
  const rt = join(managedRoot(), "runtimes", "uv");
  const exe = join(rt, process.platform === "win32" ? "uv.exe" : "uv");
  if (existsSync(exe)) return exe;
  const triple =
    process.platform === "darwin"
      ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
      : process.platform === "win32"
        ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
        : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  const file = `uv-${triple}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${file}`;
  ctx.log("下载 uv（运行 Python 版 Agent 用）");
  const sha = (await (await fetch(`${url}.sha256`, { signal: ctx.signal })).text()).trim().split(/\s+/)[0];
  const tmp = `${rt}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await download(url, join(tmp, file), sha && /^[a-f0-9]{64}$/.test(sha) ? sha : undefined, ctx);
  await extract(join(tmp, file), tmp, ctx);
  mkdirSync(rt, { recursive: true });
  const found = findFile(tmp, basename(exe));
  if (!found) throw new Error("uv 压缩包里没有 uv");
  cpSync(found, exe);
  chmodSync(exe, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  return exe;
}

// ---------- binary: per-platform archive, checksum when the registry has one ----------

async function installBinary(
  agent: RegistryAgent,
  t: NonNullable<RegistryAgent["distribution"]["binary"]>[string],
  tmp: string,
  final: string,
  ctx: Ctx,
) {
  const name = basename(new URL(t.archive).pathname) || "download";
  const file = join(tmp, ".download", name);
  mkdirSync(dirname(file), { recursive: true });
  if (!t.sha256) ctx.log("注意：Registry 没有提供校验和，只校验下载完整");
  await download(t.archive, file, t.sha256, ctx);
  if (/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar)$/i.test(name)) await extract(file, tmp, ctx);
  else {
    // A bare executable: it is the command.
    cpSync(file, join(tmp, basename(t.cmd)));
  }
  rmSync(dirname(file), { recursive: true, force: true });
  const cmdRel = t.cmd.replace(/^\.\//, "");
  const inTmp = resolve(tmp, cmdRel);
  if (relative(tmp, inTmp).startsWith("..")) throw new Error("Registry 的 cmd 指向安装目录之外");
  if (!existsSync(inTmp)) throw new Error(`压缩包里没有 ${t.cmd}`);
  if (process.platform !== "win32") chmodSync(inTmp, statSync(inTmp).mode | 0o755);
  return {
    id: agent.id,
    version: agent.version,
    kind: "binary" as const,
    runtime: "native" as const,
    command: resolve(final, cmdRel),
    args: t.args ?? [],
    env: t.env ?? {},
  };
}

// ---------- helpers ----------

export async function download(url: string, to: string, sha256: string | undefined, ctx: Ctx) {
  ctx.log(`下载 ${url}`);
  const res = await fetch(url, { signal: ctx.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const hasher = new Bun.CryptoHasher("sha256");
  const sink = Bun.file(to).writer();
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    hasher.update(chunk);
    sink.write(chunk);
    got += chunk.length;
    if (total && got / total >= shown + 0.2) {
      shown = Math.floor((got / total) * 5) / 5;
      ctx.log(`  ${Math.round((got / total) * 100)}%  ${(got / 1e6).toFixed(1)} MB`);
    }
  }
  await sink.end();
  const hex = hasher.digest("hex");
  if (sha256 && hex.toLowerCase() !== sha256.toLowerCase())
    throw new Error(`校验和不匹配（期望 ${sha256.slice(0, 12)}…，实际 ${hex.slice(0, 12)}…），已停止安装`);
  if (sha256) ctx.log("校验和一致");
}

async function extract(file: string, into: string, ctx: Ctx) {
  ctx.log(`解压 ${basename(file)}`);
  if (/\.zip$/i.test(file) && process.platform !== "win32")
    await run("unzip", ["-q", "-o", file, "-d", into], { ...ctx, cwd: into });
  else await run("tar", ["-xf", file, "-C", into], { ...ctx, cwd: into });
}

function findFile(dir: string, name: string): string | null {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (n === name) return p;
  }
  return null;
}

export async function run(
  cmd: string,
  args: string[],
  ctx: Ctx & { cwd?: string; env?: Record<string, string> },
): Promise<void> {
  ctx.log(`$ ${basename(cmd)} ${args.join(" ")}`);
  const p = Bun.spawn([cmd, ...args], {
    cwd: ctx.cwd,
    env: { ...ctx.env, CI: "1", NO_COLOR: "1", npm_config_yes: "true", TERM: "dumb" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => p.kill();
  ctx.signal.addEventListener("abort", onAbort);
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const c of s) {
      buf += dec.decode(c, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) ctx.log(l);
    }
    if (buf.trim()) ctx.log(buf);
  };
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  const code = await p.exited;
  ctx.signal.removeEventListener("abort", onAbort);
  if (ctx.signal.aborted) throw new Error("已取消");
  if (code !== 0) throw new Error(`${basename(cmd)} 退出码 ${code}`);
}
