/** Compile the Electron main + preload (TypeScript) to CommonJS in desktop/dist. */
import { join } from "node:path";

const dir = join(import.meta.dir, "..");
for (const [entry, out] of [
  ["src/main.ts", "main.cjs"],
  ["src/preload.ts", "preload.cjs"],
] as const) {
  const r = await Bun.build({
    entrypoints: [join(dir, entry)],
    target: "node",
    format: "cjs",
    external: ["electron", "electron-updater"],
    naming: out,
    outdir: join(dir, "dist"),
  });
  if (!r.success) {
    for (const l of r.logs) console.error(l);
    process.exit(1);
  }
}
console.log("compiled desktop/dist");
