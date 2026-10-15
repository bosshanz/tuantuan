/**
 * Stage what the packaged app runs outside app.asar (Bun can't read asar):
 *   build/stage/server  server/ + shared/ + web/dist + production node_modules
 *                       (ACP SDK, claude-agent-acp, codex-acp and its native codex engine)
 *   build/stage/bin/bun the Bun runtime for the target platform
 * Usage: bun desktop/scripts/stage.ts [--platform darwin|win32|linux] [--arch arm64|x64]
 * Cross-arch targets install the matching engine packages (--os/--cpu) and download that Bun.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const platform = (arg("platform") ?? process.platform) as NodeJS.Platform;
const arch = arg("arch") ?? process.arch;
const root = join(import.meta.dir, "..", "..");
const stage = join(root, "desktop", "build", "stage");
const srv = join(stage, "server");

if (!existsSync(join(root, "web", "dist", "index.html")))
  throw new Error("web/dist missing: run `bun run build` first");
rmSync(stage, { recursive: true, force: true });
mkdirSync(srv, { recursive: true });
const skip = (p: string) => !/\.test\.ts$/.test(p);
cpSync(join(root, "server"), join(srv, "server"), { recursive: true, filter: skip });
cpSync(join(root, "shared"), join(srv, "shared"), { recursive: true });
cpSync(join(root, "web", "dist"), join(srv, "web", "dist"), { recursive: true });

// Only what the server imports or spawns; the web UI is prebuilt.
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Claude Code / Codex engines are downloaded from the ACP registry on first use;
// TUANTUAN_BUNDLE_ADAPTERS=1 ships them inside the package instead (≈+300 MB).
const bundleAdapters = process.env.TUANTUAN_BUNDLE_ADAPTERS === "1";
const keep = [
  "@agentclientprotocol/sdk",
  ...(bundleAdapters ? ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp"] : []),
  "zod",
];
console.log(bundleAdapters ? "bundling Claude/Codex adapters" : "Claude/Codex: download on first use");
writeFileSync(
  join(srv, "package.json"),
  JSON.stringify(
    {
      name: "tuantuan-server",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(keep.map((k) => [k, rootPkg.dependencies[k]])),
    },
    null,
    2,
  ),
);
const cross = platform !== process.platform || arch !== process.arch;
const os = platform === "win32" ? "win32" : platform;
const r = spawnSync(
  process.execPath,
  ["install", "--production", "--no-save", ...(cross ? [`--os=${os}`, `--cpu=${arch}`] : [])],
  { cwd: srv, stdio: "inherit" },
);
if (r.status !== 0) throw new Error("bun install failed");

// AppImage targets glibc distros: the musl copy of the Claude engine (≈240 MB) is dead weight.
if (platform === "linux") {
  const a = join(srv, "node_modules", "@anthropic-ai");
  for (const n of existsSync(a) ? readdirSync(a) : []) if (n.endsWith("-musl")) rmSync(join(a, n), { recursive: true });
}

// Executables inside packages (codex engine, ripgrep, …) must stay executable after copying.
let fixed = 0;
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(p);
    else if (/\/(bin|vendor)\//.test(p) && platform !== "win32" && !/\.(md|json|txt|d\.ts|map)$/.test(n)) {
      if ((st.mode & 0o111) === 0 && isBinary(p)) {
        chmodSync(p, st.mode | 0o755);
        fixed++;
      }
    }
  }
};
const isBinary = (p: string) => {
  const b = readFileSync(p).subarray(0, 4);
  return (
    (b[0] === 0x7f && b[1] === 0x45) ||
    b.readUInt32BE(0) === 0xcffaedfe ||
    b.readUInt32LE(0) === 0xfeedfacf ||
    b[0] === 0x23
  );
};
walk(join(srv, "node_modules"));

// Bun runtime for the target.
const binDir = join(stage, "bin");
mkdirSync(binDir, { recursive: true });
const exe = platform === "win32" ? "bun.exe" : "bun";
if (!cross && !process.env.TUANTUAN_BUN_DOWNLOAD) {
  cpSync(process.execPath, join(binDir, exe));
} else {
  const name = `bun-${platform === "win32" ? "windows" : platform}-${arch === "arm64" ? "aarch64" : "x64"}`;
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}/${name}.zip`;
  console.log("downloading", url);
  const zip = join(stage, `${name}.zip`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const u = spawnSync("unzip", ["-o", "-q", zip, "-d", stage], { stdio: "inherit" });
  if (u.status !== 0) throw new Error("unzip failed (install unzip)");
  cpSync(join(stage, name, exe), join(binDir, exe));
  rmSync(zip);
  rmSync(join(stage, name), { recursive: true });
}
if (platform !== "win32") chmodSync(join(binDir, exe), 0o755);
console.log(`staged ${platform}-${arch} (fixed ${fixed} exec bits)`);
