// electron-builder afterPack: make sure the staged Bun runtime and native engines stay executable.
const { chmodSync, cpSync, existsSync, readdirSync, statSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async (ctx) => {
  const res =
    ctx.electronPlatformName === "darwin"
      ? join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : join(ctx.appOutDir, "resources");
  // extraResources never copies node_modules folders, so the server's dependencies go in here.
  const mods = join(__dirname, "..", "build", "stage", "server", "node_modules");
  if (!existsSync(mods)) throw new Error("build/stage/server/node_modules missing: run scripts/stage.ts");
  cpSync(mods, join(res, "server", "node_modules"), { recursive: true, verbatimSymlinks: true });
  if (ctx.electronPlatformName === "win32") return;
  const isExe = (p) => {
    const b = readFileSync(p).subarray(0, 4);
    return (
      (b[0] === 0x7f && b[1] === 0x45) ||
      b.readUInt32BE(0) === 0xcffaedfe ||
      b.readUInt32LE(0) === 0xfeedfacf ||
      (b[0] === 0x23 && b[1] === 0x21)
    );
  };
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.size > 3 && (st.mode & 0o111) === 0 && /[/\\](bin|vendor)[/\\]/.test(p) && isExe(p))
        chmodSync(p, st.mode | 0o755);
    }
  };
  chmodSync(join(res, "bin", "bun"), 0o755);
  walk(join(res, "server", "node_modules"));
};
