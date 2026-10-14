// Browser smoke test against the built UI + real server + mock provider.
// Needs `bun run build` first and a Chrome/Chromium binary (CHROME_PATH, default /usr/bin/google-chrome).
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { serve } from "../server/app";
import { MOCK_CONFIG } from "../server/config";
import { loadSkills } from "../server/skills";

process.env.MOCK_CHUNK_DELAY_MS = "5";
const dbPath = join(tmpdir(), `agent-hub-e2e-${Date.now()}.db`);
const { server } = serve(
  { config: MOCK_CONFIG, configSource: "builtin-mock", skills: loadSkills("skills"), dbPath, staticDir: "web/dist" },
  0,
);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
let failed = false;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.port}/`);
  await page.locator(".rail .dot.ok").waitFor();

  const createAgent = async (name: string, prompt: string, tool?: string) => {
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
    await page.getByLabel("名称").fill(name);
    await page.getByLabel("系统 Prompt").fill(prompt);
    if (tool) await page.getByRole("checkbox", { name: new RegExp(tool) }).check();
    await page.getByRole("button", { name: "创建 Agent" }).click();
    await page.getByText("所有修改已保存").waitFor();
  };
  await createAgent("Alice", "[[handoff:Bob 请你来接手]][[reply:这个交给 Bob 了。]]");
  await createAgent("Bob", "", "calculator");

  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(".pane-head").getByRole("button", { name: "新建" }).click();
  await page.getByLabel("名称").fill("冒烟群");
  const pick = (name: string) =>
    page.locator(".pick", { has: page.locator(".pick-name", { hasText: new RegExp(`^${name}$`) }) }).locator("input");
  await pick("Alice").check();
  await pick("Bob").check();
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByRole("heading", { name: "冒烟群" }).waitFor();

  const input = page.getByLabel("消息输入框");
  await input.fill("@Alice 你好");
  await input.press("Enter");
  await page.locator(".handoff", { hasText: "请你来接手" }).first().waitFor();
  await page.getByText(/我是 Bob（mock\//).waitFor();
  await page.getByText("由 Alice 转交").waitFor();
  const routingCount = await page.locator('[data-shot="expand"]').count();
  if (routingCount !== 2) throw new Error(`expected 2 routing chips, got ${routingCount}`);
  await page.locator('[data-shot="expand"]').first().click();
  await page.getByRole("heading", { name: "回复详情" }).waitFor();

  await input.fill('@Bob 算 [[tool:calculator {"expression":"7*6"}]]');
  await input.press("Enter");
  await page.locator(".msg .tool", { hasText: "calculator" }).filter({ hasText: "成功" }).first().waitFor();
  await page.getByText("工具返回：42").waitFor();

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
      for (const s of [".msg-meta", ".handoff", ".tool-list"])
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

  // Virtual desktop robot via the text fallback (Web Speech is not available headless).
  await page.getByRole("button", { name: "机器人", exact: true }).click();
  await page.getByText("设备已连接").waitFor();
  await page.locator("#robot-agent").selectOption({ label: "绑定：Bob" });
  await page.getByLabel("文字输入").fill("你好");
  await page.getByLabel("文字输入").press("Enter");
  await page.getByText("动作：挥手").waitFor();
  await page.locator(".turn.agent", { hasText: "我是 Bob" }).waitFor();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(".li-title", { hasText: "桌面机器人 · Bob" }).waitFor();
  // Re-opening the robot page must reuse the same session room, not add another one.
  await page.getByRole("button", { name: "机器人", exact: true }).click();
  await page.getByText("设备已连接").waitFor();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.locator(".li-title", { hasText: "桌面机器人 · Bob" }).waitFor();
  const robotRooms = await page.locator(".li-title", { hasText: "桌面机器人 · Bob" }).count();
  if (robotRooms !== 1) throw new Error(`expected 1 robot room for Bob, got ${robotRooms}`);

  await page.screenshot({ path: join(tmpdir(), "agent-hub-e2e.png"), fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log(
    "e2e smoke: PASS (create agents → group → @Alice → Alice @Bob → Bob replies → routing details → tool call → robot text turn with action → robot conversation listed)",
  );
} catch (e) {
  failed = true;
  console.error("e2e smoke: FAIL", e);
} finally {
  await browser.close();
  server.stop(true);
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}
process.exit(failed ? 1 : 0);
