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
  await page.getByText("已连接").waitFor();

  const createAgent = async (name: string, prompt: string, tool?: string) => {
    await page.getByRole("button", { name: "+ 新建" }).nth(1).click();
    await page.getByLabel("名称（用于 @，不能含空格或 @）").fill(name);
    await page.getByLabel("系统 Prompt").fill(prompt);
    if (tool) await page.getByRole("checkbox", { name: new RegExp(tool) }).check();
    await page.getByRole("button", { name: "创建 Agent" }).click();
    await page.getByRole("heading", { name: `编辑 Agent：${name}` }).waitFor();
  };
  await createAgent("Alice", "[[reply:@Bob 请你来接手]]");
  await createAgent("Bob", "", "calculator");

  await page.getByRole("button", { name: "+ 新建" }).first().click();
  await page.getByLabel("名称").fill("冒烟群");
  await page.getByRole("checkbox", { name: /Alice/ }).check();
  await page.getByRole("checkbox", { name: /Bob/ }).check();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("heading", { name: "冒烟群" }).waitFor();

  const input = page.getByPlaceholder(/输入消息/);
  await input.fill("@Alice 你好");
  await input.press("Enter");
  await page.getByText("@Bob 请你来接手").waitFor();
  await page.getByText(/我是 Bob（mock\//).waitFor();
  await page.getByText("Agent 互相 @ 第 1 跳").waitFor();
  const routingCount = await page.locator("details.routing").count();
  if (routingCount !== 2) throw new Error(`expected 2 routing badges, got ${routingCount}`);

  await input.fill('@Bob 算 [[tool:calculator {"expression":"7*6"}]]');
  await input.press("Enter");
  await page.getByText("🔧 calculator · 成功").waitFor();
  await page.getByText("工具返回：42").waitFor();

  await page.screenshot({ path: join(tmpdir(), "agent-hub-e2e.png"), fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e smoke: PASS (create agents → group → @Alice → Alice @Bob → Bob replies → tool call shown)");
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
