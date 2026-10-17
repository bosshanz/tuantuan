/**
 * Build installers for this OS: compile main/preload, then per arch stage the Bun server + runtime
 * for that arch and run electron-builder for it (one Bun binary per package).
 *   bun desktop/scripts/dist.ts                 # host OS, host arch
 *   bun desktop/scripts/dist.ts --arch arm64,x64
 *   bun desktop/scripts/dist.ts --dir           # unpacked app only (fast)
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = join(import.meta.dir, "..");
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const archs = (arg("arch") ?? process.arch).split(",");
const plat = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform as string];
if (!plat) throw new Error(`unsupported platform ${process.platform}`);
const buildEnv = { ...process.env };
// Actions supplies absent secrets as empty strings. On macOS electron-builder treats
// an empty CSC_LINK as a certificate path and tries to import the project directory.
if (process.platform === "darwin" && buildEnv.CSC_LINK === "") delete buildEnv.CSC_LINK;
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: dir, stdio: "inherit", env: buildEnv });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(process.execPath, ["scripts/compile.ts"]);
for (const arch of archs) {
  run(process.execPath, ["scripts/stage.ts", "--arch", arch]);
  const extra = process.argv.includes("--dir") ? ["--dir"] : [];
  run(process.execPath, [
    join(dir, "node_modules", "electron-builder", "cli.js"),
    "--config",
    "electron-builder.config.cjs",
    plat,
    `--${arch}`,
    "--publish",
    process.env.TUANTUAN_PUBLISH ? "always" : "never",
    ...extra,
  ]);
}
// Fail the build if any Mach-O is unsigned / inconsistently signed, or packaging broke the seal.
if (process.platform === "darwin") run(process.execPath, ["scripts/verify-mac.ts"]);
