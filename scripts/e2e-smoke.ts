// Browser smoke test against the built UI + real server + the mock ACP harness (server/mock-agent.ts).
// Needs `bun run build` first and a Chrome/Chromium binary (CHROME_PATH, default /usr/bin/google-chrome).
// SHOTS_DIR=<dir> also saves screenshots of the main screens.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "../server/app";

process.env.TUANTUAN_MOCK_HARNESS = "1";
// The mock harness starts logged out; onboarding logs in through ACP `authenticate`, which creates this file.
const authFile = join(tmpdir(), `tuantuan-e2e-auth-${Date.now()}`);
process.env.MOCK_AGENT_AUTH_FILE = authFile;
const dbPath = join(tmpdir(), `agent-hub-e2e-${Date.now()}.db`);
const cwd = mkdtempSync(join(tmpdir(), "tuantuan-e2e-cwd-"));
const workspaces = mkdtempSync(join(tmpdir(), "tuantuan-e2e-ws-"));
process.env.TUANTUAN_WORKSPACES = workspaces;
// A fresh machine: the login shell has no harness CLIs on PATH, so claude/codex fall back to the bundled
// adapters and grok/opencode/mock-cli offer one-click installs (mock-cli's installer is a local script).
const fakeHome = mkdtempSync(join(tmpdir(), "tuantuan-e2e-home-"));
const fakeShell = join(fakeHome, "login-shell");
writeFileSync(fakeShell, `#!/bin/sh\nprintf 'PATH=/usr/bin:/bin\\0HOME=${fakeHome}\\0'\n`);
chmodSync(fakeShell, 0o755);
process.env.SHELL = fakeShell;
process.env.TUANTUAN_MOCK_INSTALL_DIR = join(fakeHome, "bin");
writeFileSync(join(cwd, "mock-edit.txt"), "hello\n");
const shotsDir = process.env.SHOTS_DIR;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const { server, app } = serve({ dbPath, staticDir: "web/dist" }, 0);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shot = async (name: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.port}/`);
  await page.locator(".rail .dot.ok").waitFor();

  // Onboarding: the mock harness is detected, the handshake shows it logged out, and its own
  // (agent-driven) login method logs in; the re-test then reports logged in.
  // First launch opens 新手引导 by itself.
  await page.getByRole("heading", { name: "新手引导" }).waitFor();
  const mockRow = page.locator(".harness-row", { hasText: "Mock（测试）" });
  await mockRow.getByRole("button", { name: "握手测试" }).click();
  await mockRow.getByText(/ACP v1 · Mock.*未登录/).waitFor();
  await mockRow.getByRole("button", { name: "用「Mock 登录」登录" }).click();
  await mockRow.getByText(/ACP v1 · Mock.*已登录/).waitFor();
  await shot("setup");

  // Bundled adapters are used when nothing is on PATH; a missing CLI installs with one click.
  await page
    .locator(".harness-row", { hasText: "Claude Code" })
    .locator(".source-badge", { hasText: "内置" })
    .waitFor();
  await page.locator(".harness-row", { hasText: "Codex" }).locator(".source-badge", { hasText: "内置" }).waitFor();
  const cliRow = page.locator(".harness-row", { hasText: "Mock CLI" });
  await cliRow.getByRole("button", { name: /^安装/ }).click();
  await cliRow.getByRole("log").getByText("进度 100%").waitFor();
  await cliRow.locator(".ok-text", { hasText: "安装完成" }).waitFor();
  await cliRow.locator(".source-badge", { hasText: "本机" }).waitFor();
  await page.locator(".harness-row", { hasText: "OpenCode" }).getByRole("button", { name: /^安装/ }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.locator(".harness-row", { hasText: "Claude Code" }).scrollIntoViewIfNeeded();
  await shot("harness");
  await page.setViewportSize({ width: 1440, height: 900 });
  // Finishing is remembered server-side: after a reload it never opens again; Harness 管理 stays in the rail.
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator(".rail").getByRole("button", { name: "会话", exact: true }).waitFor();
  if (!app.store.getSetting("onboarded", false)) throw new Error("onboarding not persisted");
  await page.goto(`http://localhost:${server.port}/#/setup`);
  await page.locator(".rail .dot.ok").waitFor();
  await page.waitForFunction(() => location.hash === "#/harness");
  await page.getByRole("heading", { name: "Harness 管理" }).waitFor();
  if ((await page.getByRole("button", { name: "完成", exact: true }).count()) !== 0)
    throw new Error("onboarding shown again");

  const createAgent = async (name: string, identity: string) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
    await page.getByLabel("名称").fill(name);
    await page.getByLabel("Harness", { exact: true }).selectOption({ label: "Mock（测试）" });
    await page.getByLabel("身份文档").fill(identity);
    await page.getByRole("button", { name: "创建 Agent" }).click();
    await page.getByText("所有修改已保存").waitFor();
  };
  await createAgent("Alice", "你是产品经理。");
  await createAgent("Bob", "你是工程师。");

  // BYOK custom agent against a local mock OpenAI-compatible server.
  const byok = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const _body = await req.json();
      const stream =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "byok-ok" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
        `data: [DONE]\n\n`;
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
  await page.getByLabel("名称").fill("BYOK");
  await page.getByLabel("Harness", { exact: true }).selectOption({ label: "自定义 API（BYOK）" });
  await page.getByLabel("接口格式").selectOption({ label: "OpenAI Chat Completions" });
  await page.getByLabel("Base URL").fill(`http://127.0.0.1:${byok.port}/v1`);
  await page.getByLabel("API Key").fill("sk-e2e-test");
  await page.getByLabel("模型").fill("mock");
  await page.getByRole("button", { name: "测试连接" }).waitFor();
  await shot("agent-byok");
  await page.getByRole("button", { name: "创建 Agent" }).click();
  await page.getByText("所有修改已保存").waitFor();
  const byokAgent = app.store.listAgents().find((a) => a.name === "BYOK");
  if (!byokAgent?.custom?.keyHint || byokAgent.custom.keyHint.includes("sk-e2e-test"))
    throw new Error("API key was not masked");
  byok.stop(true);

  await shot("agent-editor");

  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "会话" }).click();
  // New project with an existing folder.
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("冒烟项目");
  await page.getByRole("button", { name: "选择已有" }).click();
  await page.getByLabel("文件夹路径").fill(cwd);
  await shot("new-project");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("heading", { name: "冒烟项目" }).waitFor();
  const project = app.store.listProjects().find((p) => p.name === "冒烟项目");
  if (!project || project.cwd !== cwd) throw new Error("new project dir mismatch");

  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "会话" }).click();
  await page.locator(".pane-head").getByRole("button", { name: "会话" }).click();
  await page.locator('form .select[aria-label="项目"]').selectOption({ label: "冒烟项目" });
  await page.getByLabel("会话名称").fill("冒烟会话");
  const pick = (name: string) =>
    page.locator(".pick", { has: page.locator(".pick-name", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  await pick("Alice").check();
  await pick("Bob").check();
  await page.getByLabel("主 Agent").selectOption({ label: "Bob" });
  await page.waitForTimeout(400);
  await shot("new-conversation");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByRole("heading", { name: "冒烟会话" }).waitFor();
  const group = app.store.listRooms().find((r) => r.name === "冒烟会话");
  const bobId = app.store.listAgents().find((a) => a.name === "Bob")?.id;
  if (group?.mainAgentId !== bobId || group?.projectId !== project.id || group?.cwd !== cwd)
    throw new Error("new conversation lost main / project");
  await page.waitForTimeout(600);
  await shot("sidebar");

  // Group: no @ -> the main agent (Bob) answers; @Alice -> Alice.
  const input = page.getByLabel("消息输入框");
  await input.fill("大家好");
  await input.press("Enter");
  await page.locator(".msg-group", { hasText: "Bob" }).getByText("收到：「大家好」").waitFor();
  await input.fill("@Alice 你来");
  await input.press("Enter");
  await page.locator(".msg-group", { hasText: "Alice" }).getByText("收到：「@Alice 你来」").waitFor();
  // Hand-off through Tuantuan's MCP tool: Bob (main agent) hands the task to Alice.
  await input.fill("/handoff Alice 写一份需求文档");
  await input.press("Enter");
  await page.locator(".handoff-card", { hasText: "交接给 @Alice" }).waitFor();
  await page.locator(".handoff-from", { hasText: "接 @Bob 的交接：写一份需求文档" }).waitFor();
  await page.getByText("接手 @Bob 的任务「写一份需求文档」").waitFor();
  await shot("group");
  // Single-agent conversation in 草稿

  await page.locator(".pane-head").getByRole("button", { name: "会话" }).click();
  await page.locator('form .select[aria-label="项目"]').selectOption({ label: "冒烟项目" });
  await page.getByLabel("会话名称").fill("与 Bob");
  await pick("Bob").check();
  await shot("new-dm");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.locator(".model-trigger").waitFor(); // composer model picker
  await page.locator(".model-trigger").click();
  await page.getByRole("option", { name: "Mock Smart" }).waitFor();
  await shot("model-picker");
  await page.getByRole("option", { name: "Mock Smart" }).click();
  await page.locator(".model-trigger", { hasText: "Mock Smart" }).waitFor();
  await input.fill("/pl");
  await page.locator(".slash-pop").getByText("/plan").waitFor();
  await input.press("Tab");
  await input.press("Enter");
  await page.locator(".plan-item[data-status=completed]", { hasText: "跑测试" }).waitFor();
  await page.locator(".thought").first().waitFor();

  await input.fill("/edit");
  await input.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await dialog.locator('.diff-line[data-op="+"]', { hasText: "tuantuan" }).waitFor();
  await shot("permission");
  await dialog.getByRole("button", { name: "允许", exact: true }).click();
  await page.getByText("已修改 mock-edit.txt。").waitFor();
  if (readFileSync(join(cwd, "mock-edit.txt"), "utf8") !== "hello\ntuantuan\n") throw new Error("edit not applied");

  await input.fill("/run");
  await input.press("Enter");
  await page.locator(".term", { hasText: "hello from terminal" }).waitFor();
  await page.getByText("命令跑完了。").waitFor();

  // Already switched to Mock Smart via the composer picker above; sending confirms the preference stuck.
  await input.fill("换模型了");
  await input.press("Enter");
  await page.getByText("收到：「换模型了」（mock-smart）").waitFor();
  await page.locator(".ctx-usage").waitFor();
  await shot("dm-capabilities");

  await input.fill("/slow");
  await input.press("Enter");
  await page.getByRole("button", { name: "停止" }).click();
  await page.locator(".state-tag", { hasText: "已停止" }).waitFor();

  await page.locator('[data-shot="expand"]').last().click();
  await page.getByRole("heading", { name: "回复详情" }).waitFor();

  // Let enter/exit animations finish so geometry is measured at rest.
  const settle = () =>
    page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
  await settle();
  // Alignment: one header line across columns, shared left edges, no header collisions.
  await page.getByRole("heading", { name: "回复详情" }).waitFor();
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    const r = (el: Element | null) => el?.getBoundingClientRect();
    const near = (a: number, b: number, what: string) => Math.abs(a - b) > 0.5 && out.push(`${what}: ${a} vs ${b}`);
    const heads = [".pane-head", ".main-head", ".details-head"].map((s) => [s, r(document.querySelector(s))] as const);
    for (const [s, b] of heads) {
      if (!b) out.push(`missing ${s}`);
      else {
        near(b.height, 56, `${s} height`);
        near(b.top, 0, `${s} top`);
      }
    }
    const logo = r(document.querySelector(".rail .logo"));
    if (logo) near(logo.top + logo.height / 2, 28, "rail logo centred on header line");
    const details = r(document.querySelector(".details"));
    for (const b of document.querySelectorAll(".main-head button")) {
      const x = b.getBoundingClientRect();
      if (details && x.width && x.right > details.left) out.push("chat header control overlaps the details panel");
    }
    const left = (el: Element | null) => {
      if (!el) return Number.NaN;
      return el.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(el).paddingLeft);
    };
    const edge = r(document.querySelector(".pane-head h1"))?.left ?? Number.NaN;
    near(r(document.querySelector(".pane-search .input"))?.left ?? Number.NaN, edge, "search box left edge");
    near(left(document.querySelector(".project-toggle")), edge, "project label left edge");
    near(left(document.querySelector(".list-item")), edge, "list item left edge");
    for (const g of document.querySelectorAll(".msg-group")) {
      const text = r(g.querySelector(".msg"))?.left ?? Number.NaN;
      near(r(g.querySelector(".msg-head"))?.left ?? text, text, "message name vs body");
      for (const s of [".msg-meta", ".timeline"])
        for (const el of g.querySelectorAll(s)) near(el.getBoundingClientRect().left, text, `${s} vs body`);
    }
    const firstAvatar = r(document.querySelector(".msg-group .avatar"));
    if (firstAvatar)
      near(
        r(document.querySelector(".composer-box"))?.left ?? Number.NaN,
        firstAvatar.left,
        "composer vs avatar column",
      );
    const dts = [...document.querySelectorAll(".details .kv dt")].map((e) => e.getBoundingClientRect().left);
    const dds = [...document.querySelectorAll(".details .kv dd")].map((e) => e.getBoundingClientRect().left);
    if (new Set(dts).size > 1 || new Set(dds).size > 1) out.push("details label/value columns not aligned");
    return out;
  });
  if (issues.length) throw new Error(`alignment: ${issues.join("; ")}`);

  // Agent editor: header stays on the 56px line, opaque, and scrolled content never shows through.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".list-item", { hasText: "Alice" }).first().click();
  await page.getByLabel("名称").waitFor();
  await page.locator("form.page").evaluate((el) => el.scrollTo(0, 240));
  await page.waitForTimeout(100);
  await settle();
  const editorIssues = await page.evaluate(() => {
    const out: string[] = [];
    const head = document.querySelector(".main-head")?.getBoundingClientRect();
    const list = document.querySelector(".pane-head")?.getBoundingClientRect();
    const page = document.querySelector("form.page")?.getBoundingClientRect();
    const bar = document.querySelector(".save-bar")?.getBoundingClientRect();
    if (!head || !list || !page || !bar) return ["editor elements missing"];
    if (Math.abs(head.height - 56) > 0.5 || head.top !== 0) out.push(`editor head ${head.top}/${head.height}`);
    if (Math.abs(head.bottom - list.bottom) > 0.5) out.push("editor head not aligned with list head");
    if (page.top < head.bottom - 0.5) out.push(`content scrolls under header (${page.top} < ${head.bottom})`);
    for (const el of document.querySelectorAll(".main-head > *, .main-head .avatar")) {
      const b = el.getBoundingClientRect();
      if (b.top < head.top - 0.5 || b.bottom > head.bottom + 0.5) out.push(`header child clipped: ${el.className}`);
    }
    const bg = getComputedStyle(document.querySelector(".main-head") as Element).backgroundColor;
    if (/rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) || bg === "transparent") out.push(`header bg not opaque: ${bg}`);
    const barBg = getComputedStyle(document.querySelector(".save-bar") as Element).backgroundColor;
    if (/rgba\(/.test(barBg)) out.push(`save bar bg not opaque: ${barBg}`);
    const inner = document.querySelector(".page-inner")?.getBoundingClientRect();
    const btn = document.querySelector(".save-bar .btn.primary")?.getBoundingClientRect();
    const status = document.querySelector(".save-bar .status")?.getBoundingClientRect();
    if (inner && btn && Math.abs(btn.right - (inner.right - 24)) > 1)
      out.push(`save button ${btn.right} vs content ${inner.right - 24}`);
    if (inner && status && Math.abs(status.left - (inner.left + 24)) > 1)
      out.push(`save status ${status.left} vs content ${inner.left + 24}`);
    return out;
  });
  if (editorIssues.length) throw new Error(`editor header: ${editorIssues.join("; ")}`);

  // Live updates without reload, even when the history fetch is slow (dev proxy, remote host):
  // a late snapshot must not wipe messages that already arrived over the socket.
  await page.route(/\/api\/rooms\/[^/]+\/messages\?/, async (route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 700));
    await route.fulfill({ response: res });
  });
  const live = async (roomTitle: string, text: string, reply: RegExp) => {
    await page.locator(".main-head h2", { hasText: roomTitle }).waitFor();
    await input.fill(text);
    await input.press("Enter");
    const body = text.replace(/^@\S+\s/, "");
    await page.locator(".msg", { hasText: body }).first().waitFor({ timeout: 5000 });
    await page.locator(".msg", { hasText: reply }).last().waitFor({ timeout: 8000 });
    await page.waitForTimeout(900); // let the slow snapshot land, then make sure nothing vanished
    if ((await page.locator(".msg", { hasText: body }).count()) === 0) throw new Error(`message vanished: ${text}`);
  };
  const navs = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".list-item", { hasText: "Bob" }).first().click();
  await page.getByRole("button", { name: /对话/ }).click();
  await live("Bob", "直播-1", /收到：「直播-1」/);
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "会话" }).click();
  await page.locator(".li-title", { hasText: "冒烟会话" }).click();
  await live("冒烟会话", "@Bob 会话直播-2", /\[我\]: @Bob 会话直播-2/);
  await page.locator(".li-title", { hasText: "与 Bob" }).click();
  await live("与 Bob", "切换后-3", /收到：「切换后-3」/);
  await page.unroute(/\/api\/rooms\/[^/]+\/messages\?/);
  if ((await page.evaluate(() => performance.getEntriesByType("navigation").length)) !== navs)
    throw new Error("page reloaded during live checks");

  // Dev setup (`bun dev`): the UI must reach the API and its WebSocket through the Vite proxy.
  // Spawn vite's own entry (not `bunx`), so kill() stops the server itself: an orphaned vite from a
  // previous run would keep the port and proxy to a dead API, failing every other run.
  const vitePort = 5199;
  const vite = Bun.spawn(["node", "node_modules/vite/bin/vite.js", "--port", String(vitePort), "--strictPort"], {
    env: { ...process.env, PORT: String(server.port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(`http://localhost:${vitePort}/`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await Bun.sleep(100);
    }
    const dev = await browser.newPage();
    await dev.goto(`http://localhost:${vitePort}/`);
    await dev.locator(".rail .dot.ok").waitFor({ timeout: 15000 });
    await dev.getByText("冒烟会话").first().waitFor();
    await dev.close();
  } finally {
    vite.kill();
  }

  await shot("final");
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log(
    "e2e smoke: PASS (setup handshake + login → bundled adapters + one-click install → agents on mock ACP harness → BYOK form → onboarding once → new project (existing folder) → conversation with main agent → single-agent conversation → main agent, @, MCP handoff → DM: slash command, plan, thought, permission + diff, terminal, config option, usage, cancel → details → live updates under slow snapshot → UI via Vite proxy)",
  );
} catch (e) {
  failed = true;
  console.error("e2e smoke: FAIL", e);
} finally {
  await browser.close();
  app.host.shutdown();
  server.stop(true);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(workspaces, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
  rmSync(authFile, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}
process.exit(failed ? 1 : 0);
