// Browser smoke test against the built UI + real server + the mock ACP harness (server/mock-agent.ts).
// Needs `bun run build` first and a Chrome/Chromium binary (CHROME_PATH, default /usr/bin/google-chrome).
// SHOTS_DIR=<dir> also saves screenshots of the main screens.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  await page.getByRole("button", { name: "引导", exact: true }).click();
  const mockRow = page.locator(".harness-row", { hasText: "Mock（测试）" });
  await mockRow.getByRole("button", { name: "握手测试" }).click();
  await mockRow.getByText(/ACP v1 · Mock.*未登录/).waitFor();
  await mockRow.getByRole("button", { name: "用「Mock 登录」登录" }).click();
  await mockRow.getByText(/ACP v1 · Mock.*已登录/).waitFor();
  await shot("setup");

  const createAgent = async (name: string, identity: string) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
    await page.getByLabel("名称").fill(name);
    await page.getByLabel("Harness", { exact: true }).selectOption({ label: "Mock（测试）" });
    await page.getByLabel("工作目录").fill(cwd);
    await page.getByLabel("身份文档").fill(identity);
    await page.getByRole("button", { name: "创建 Agent" }).click();
    await page.getByText("所有修改已保存").waitFor();
  };
  await createAgent("Alice", "你是产品经理。");
  await createAgent("Bob", "你是工程师。");
  await shot("agent-editor");

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
  await page.getByLabel("名称").fill("冒烟群");
  const pick = (name: string) =>
    page.locator(".pick", { has: page.locator(".pick-name", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  await pick("Alice").check();
  await pick("Bob").check();
  // Main agent and shared working directory are chosen when creating the group.
  await page.getByLabel("主 Agent").selectOption({ label: "Bob" });
  await page.getByLabel("共享工作目录").fill(cwd);
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByRole("heading", { name: "冒烟群" }).waitFor();
  const group = app.store.listRooms().find((r) => r.name === "冒烟群");
  const bobId = app.store.listAgents().find((a) => a.name === "Bob")?.id;
  if (group?.mainAgentId !== bobId || group?.cwd !== cwd) throw new Error("new group lost main agent / cwd");

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

  // Private chat with Bob: every ACP capability the mock harness exercises.
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.locator(".list-item", { hasText: "Bob" }).first().click();
  await page.getByRole("button", { name: /私聊/ }).click();
  await page.getByLabel("模型").waitFor(); // session config options (mode / model / reasoning)
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

  await page.getByLabel("模型").selectOption("mock-smart");
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
    near(left(document.querySelector(".group-label")), edge, "section label left edge");
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
  await page.getByRole("button", { name: /私聊/ }).click();
  await live("Bob", "私聊直播-1", /收到：「私聊直播-1」/);
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(".li-title", { hasText: "冒烟群" }).click();
  await live("冒烟群", "@Bob 群聊直播-2", /\[我\]: @Bob 群聊直播-2/);
  await page.locator(".li-title", { hasText: /私聊/ }).first().click();
  await live("Bob", "切换后-3", /收到：「切换后-3」/);
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
    await dev.getByText("冒烟群").first().waitFor();
    await dev.close();
  } finally {
    vite.kill();
  }

  await shot("final");
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log(
    "e2e smoke: PASS (setup handshake + login → agents on mock ACP harness → new group with main agent + cwd → main agent, @, MCP handoff → DM: slash command, plan, thought, permission + diff, terminal, config option, usage, cancel → details → live updates under slow snapshot → UI via Vite proxy)",
  );
} catch (e) {
  failed = true;
  console.error("e2e smoke: FAIL", e);
} finally {
  await browser.close();
  app.host.shutdown();
  server.stop(true);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
  rmSync(authFile, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}
process.exit(failed ? 1 : 0);
