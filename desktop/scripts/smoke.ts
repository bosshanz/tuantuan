/**
 * Headless end-to-end check of the packaged desktop app (Linux AppImage, under Xvfb):
 * launch → bundled Bun server healthy → preload bridge present → create a mock-harness agent →
 * send a message through the window → reply arrives → screenshot → quit → server + harness gone.
 *   xvfb-run -a bun desktop/scripts/smoke.ts [path/to/App.AppImage | linux-unpacked/tuantuan]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = join(import.meta.dir, "..", "..");
const rel = join(root, "desktop", "release");
const target =
  process.argv[2] ??
  join(rel, readdirSync(rel).find((n) => n.endsWith(".AppImage")) ?? join("linux-unpacked", "tuantuan"));
if (!existsSync(target)) throw new Error(`not built: ${target}`);
const tmp = mkdtempSync(join(tmpdir(), "tuantuan-desk-"));
const home = join(tmp, "home");
mkdirSync(home);
const auth = join(tmp, "mock-auth");
writeFileSync(auth, "ok");
const shots = process.env.SHOTS_DIR ?? join(root, "docs", "screenshots");
const cdp = 9300 + Math.floor(Math.random() * 500);

const args = [`--remote-debugging-port=${cdp}`, "--no-sandbox"];
const app = spawn(target, target.endsWith(".AppImage") ? ["--appimage-extract-and-run", ...args] : args, {
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    DISPLAY: process.env.DISPLAY ?? "",
    XAUTHORITY: process.env.XAUTHORITY ?? "",
    HOME: home,
    SHELL: "/bin/sh",
    TUANTUAN_USER_DATA: join(tmp, "userData"),
    TUANTUAN_WORKSPACES: join(tmp, "ws"),
    TUANTUAN_MOCK_HARNESS: "1",
    MOCK_AGENT_AUTH_FILE: auth,
    TUANTUAN_DESKTOP_SMOKE: "1",
    TUANTUAN_NATIVE_PICKER: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let out = "";
app.stdout.on("data", (d) => {
  out += d;
});
app.stderr.on("data", (d) => {
  out += d;
});
const t0 = Date.now();
const until = async <T>(f: () => T | Promise<T>, what: string, ms = 60_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve()
      .then(f)
      .catch(() => null);
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timeout: ${what}\n${out.slice(-3000)}`);
    await Bun.sleep(200);
  }
};
const descendants = (pid: number): number[] => {
  const r = spawnSync("ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf8" });
  const rows = r.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = (p: number): number[] => rows.filter((x) => x[1] === p).flatMap((x) => [x[0], ...kids(x[0])]);
  return kids(pid);
};

let ok = false;
try {
  const url = await until(() => out.match(/TUANTUAN_SERVER_URL=(\S+)/)?.[1], "server url");
  const health = await (await fetch(`${url}/api/health`)).json();
  console.log(`server healthy in ${Date.now() - t0}ms`, health);
  const api = async (m: string, p: string, b?: unknown) =>
    (
      await fetch(url + p, {
        method: m,
        headers: { "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      })
    ).json() as Promise<any>;

  const browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${cdp}`), "cdp");
  const page = await until(
    () =>
      browser
        .contexts()[0]
        ?.pages()
        .find((p) => p.url().startsWith(url)),
    "window",
  );
  const bridge = await page.evaluate(() => {
    const t = (window as any).tuantuan;
    return {
      picker: typeof t?.pickFolder,
      desktop: document.documentElement.dataset.desktop,
      node: typeof (window as any).require,
    };
  });
  console.log("preload bridge", bridge);
  if (bridge.picker !== "function" || bridge.node !== "undefined") throw new Error("preload bridge wrong");

  // Packaged mode: Claude/Codex are not bundled (unless built with TUANTUAN_BUNDLE_ADAPTERS=1);
  // install Codex from the ACP registry on the packaged Bun, then handshake.
  const harnesses = async () => {
    const hs = (await api("GET", "/api/harnesses")) as any;
    return (Array.isArray(hs) ? hs : (hs.items ?? hs.harnesses ?? [])) as any[];
  };
  const bundled = process.env.TUANTUAN_BUNDLE_ADAPTERS === "1";
  for (const id of ["claude-code", "codex"]) {
    const h = (await harnesses()).find((x) => x.id === id);
    console.log(
      id,
      h?.source ?? "missing",
      h?.command ?? "",
      h?.installers?.map((i: any) => i.id),
    );
    if (bundled ? h?.source !== "bundled" : h?.command || h?.installers?.[0]?.id !== "registry")
      throw new Error(`${id}: unexpected ${JSON.stringify(h).slice(0, 200)}`);
  }
  if (!bundled) {
    const t0 = Date.now();
    await api("POST", "/api/harnesses/codex/install", { installerId: "registry" });
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const j = await api("GET", "/api/harnesses/codex/install");
      if (j?.state === "running") continue;
      if (j?.state !== "done") throw new Error(`codex install: ${JSON.stringify(j).slice(-400)}`);
      break;
    }
    console.log(`codex installed from registry in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const codex = (await harnesses()).find((x) => x.id === "codex");
  console.log("codex", codex?.source, codex?.command, codex?.managedVersion);
  if (!bundled && (codex?.source !== "managed" || !String(codex.command).includes("resources/bin/bun")))
    throw new Error("codex not managed on bundled bun");
  const t = await api("POST", "/api/harnesses/codex/test");
  console.log("codex handshake:", JSON.stringify(t).slice(0, 160));
  if (t.ok !== true) throw new Error("codex handshake failed");
  await api("POST", "/api/onboarding");
  const agent = await api("POST", "/api/agents", {
    name: "小团",
    color: "#336699",
    avatar: "团",
    identity: "",
    harness: "mock",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "allow",
  });
  if (!agent.id) throw new Error(`agent: ${JSON.stringify(agent)}`);
  const room = await api("POST", "/api/rooms", { name: "桌面冒烟", agentIds: [agent.id] });
  await page.goto(`${url}/#/rooms/${room.id}`);
  await page.reload();
  const box = page.locator(".composer-box textarea");
  await box.waitFor({ timeout: 30_000 });
  await box.fill("你好，团团桌面版");
  await box.press("Enter");
  await page.waitForTimeout(1500);
  const sent = await until(
    async () => ((await api("GET", `/api/rooms/${room.id}/messages`)).messages as any[]).length > 0,
    "message sent",
    10_000,
  ).catch(async (e) => {
    await page.screenshot({ path: join(tmp, "fail.png") });
    console.error("screenshot", join(tmp, "fail.png"));
    throw e;
  });
  void sent;
  const reply = await until(async () => {
    const ms = (await api("GET", `/api/rooms/${room.id}/messages`)).messages as any[];
    const m = ms.find((x) => x.senderKind === "agent" && x.senderId === agent.id);
    return (m && m.status === "done") || m.status === "error" ? m : null;
  }, "agent reply");
  console.log("reply", reply.status, JSON.stringify(reply.content).slice(0, 120));
  if (reply.status === "error") throw new Error(`reply error: ${reply.error}`);
  const harnessPids = descendants(app.pid ?? 0);
  console.log(`process tree under app: ${harnessPids.length} processes`);
  await page.waitForTimeout(600);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "desktop-linux.png") });
  await browser.close().catch(() => {});

  // Quit like the user would; everything we started must go away.
  const before = descendants(app.pid ?? 0);
  // (the AppImage runtime doesn't forward signals: ask Electron's main process itself to quit)
  const ps0 = spawnSync("ps", ["-o", "pid=,args=", "-p", [app.pid, ...before].join(",")], { encoding: "utf8" }).stdout;
  const main = ps0
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((c) => /tuantuan$/.test(c[1] ?? "") && !c.some((a) => a.startsWith("--type=")));
  process.kill(Number(main?.[0] ?? app.pid), "SIGTERM");
  await until(() => app.exitCode !== null || app.signalCode !== null, "app exit", 15_000);
  const alive = () =>
    before.filter((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
  const end = Date.now() + 10_000;
  while (alive().length && Date.now() < end) await Bun.sleep(200);
  if (alive().length) {
    const ps = spawnSync("ps", ["-o", "pid,args", "-p", alive().join(",")], { encoding: "utf8" }).stdout;
    throw new Error(`left running after quit:\n${ps}`);
  }
  const after = await fetch(`${url}/api/health`).then(
    () => "up",
    () => "down",
  );
  if (after !== "down") throw new Error("server still answering after quit");
  console.log(`quit clean: ${before.length} processes gone, server down`);
  ok = true;
} finally {
  if (!ok) {
    console.error(out.slice(-4000));
    try {
      process.kill(-(app.pid ?? 0), "SIGKILL");
    } catch {}
  }
}
console.log("desktop smoke: PASS");
process.exit(0);
