/**
 * Verify a built macOS package the way Gatekeeper and AMFI will see it, and fail the build if not:
 *   - every Mach-O in the .app has a valid signature, and all of them use the same identity kind
 *     (ad-hoc vs Developer ID) — a single unsigned or stale binary (e.g. the bundled Bun) is what
 *     produces "code signature invalid" kills on Apple silicon;
 *   - ad-hoc builds do not carry the hardened runtime flag;
 *   - `codesign --verify --deep --strict` passes on the .app, on the .app extracted from the .zip
 *     with ditto, and on the .app inside the mounted .dmg (packaging must not break the seal).
 * `spctl` is printed for information only: without notarization it always reports "rejected".
 *   bun desktop/scripts/verify-mac.ts            # every .app under release/mac-*, plus the mac zip and dmg files
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const release = join(import.meta.dir, "..", "release");
const failures: string[] = [];
const sh = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const MAGICS = new Set(["cffaedfe", "cefaedfe", "cafebabe", "feedfacf", "feedface"]);
const isMachO = (p: string) => {
  const fd = openSync(p, "r");
  try {
    const b = Buffer.alloc(4);
    return readSync(fd, b, 0, 4, 0) === 4 && MAGICS.has(b.toString("hex"));
  } finally {
    closeSync(fd);
  }
};
const machOs = (dir: string, out: string[] = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) machOs(p, out);
    else if (st.size > 4 && isMachO(p)) out.push(p);
  }
  return out;
};

function verifyApp(app: string, label: string, deepOnly = false) {
  const deep = sh("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  console.log(`[${label}] codesign --verify --deep --strict: ${deep.ok ? "ok" : "FAILED"}`);
  if (!deep.ok) failures.push(`${label}: ${deep.out}`);
  if (deepOnly) return;
  const kinds = new Map<string, string[]>();
  for (const file of machOs(app)) {
    const v = sh("codesign", ["--verify", "--strict", file]);
    if (!v.ok) failures.push(`${label}: invalid signature ${file}: ${v.out}`);
    const d = sh("codesign", ["-dvv", file]).out;
    const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(d)?.[1] ?? "none";
    const kind = /Signature=adhoc/.test(d) ? "adhoc" : (/Authority=([^\n]+)/.exec(d)?.[1] ?? "unsigned");
    kinds.set(kind, [...(kinds.get(kind) ?? []), file]);
    if (kind === "adhoc" && flags.includes("runtime")) failures.push(`${label}: ad-hoc with hardened runtime ${file}`);
  }
  console.log(
    `[${label}] Mach-O signatures: ${[...kinds].map(([k, v]) => `${k}×${v.length}`).join(", ") || "none found"}`,
  );
  if (kinds.size !== 1) failures.push(`${label}: mixed signing identities ${[...kinds.keys()].join(" / ")}`);
  const gk = sh("spctl", ["--assess", "--type", "execute", "-vv", app]);
  console.log(`[${label}] spctl (informational): ${gk.out.split("\n").join(" | ")}`);
}

if (process.platform !== "darwin") {
  console.log("verify-mac: not macOS, skipped");
  process.exit(0);
}
if (!existsSync(release)) throw new Error(`no ${release}`);
for (const d of readdirSync(release).filter((n) => n.startsWith("mac"))) {
  const dir = join(release, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const app of readdirSync(dir).filter((n) => n.endsWith(".app"))) verifyApp(join(dir, app), `${d}/${app}`);
}
for (const f of readdirSync(release).filter((n) => /-mac-.*\.(zip|dmg)$/.test(n))) {
  const tmp = mkdtempSync(join(tmpdir(), "tuantuan-verify-"));
  try {
    if (f.endsWith(".zip")) {
      const x = sh("ditto", ["-x", "-k", join(release, f), tmp]);
      if (!x.ok) failures.push(`${f}: ditto: ${x.out}`);
    } else {
      const a = sh("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", tmp, join(release, f)]);
      if (!a.ok) failures.push(`${f}: hdiutil: ${a.out}`);
    }
    for (const app of readdirSync(tmp).filter((n) => n.endsWith(".app"))) verifyApp(join(tmp, app), f, true);
    if (f.endsWith(".dmg") && !readdirSync(tmp).includes("Applications"))
      failures.push(`${f}: no Applications link in the disk image`);
  } finally {
    if (f.endsWith(".dmg")) sh("hdiutil", ["detach", tmp, "-force"]);
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error(`verify-mac: ${failures.length} problem(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("verify-mac: ok");
