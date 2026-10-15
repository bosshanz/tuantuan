// Browser smoke test against the built UI + real server + the mock ACP harness (server/mock-agent.ts).
// Needs `bun run build` first and a Chrome/Chromium binary (CHROME_PATH, default /usr/bin/google-chrome).
// SHOTS_DIR=<dir> also saves screenshots of the main screens.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { serve } from "../server/app";
import { mockRegistry } from "../tests/fixtures/mock-registry";

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
// No OS folder dialog in CI: the in-app folder browser is used. Skills are discovered from a fake home.
process.env.TUANTUAN_NATIVE_PICKER = "0";
process.env.TUANTUAN_SKILLS_HOME = fakeHome;
const putSkill = (root: string, name: string, description: string) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`);
};
putSkill(join(fakeHome, ".claude", "skills"), "code-review", "审查改动并指出风险");
putSkill(join(fakeHome, ".agents", "skills"), "pdf-tools", "读取、拆分和合并 PDF");
putSkill(join(fakeHome, ".codex", "skills"), "release-notes", "根据提交生成发布说明");
putSkill(join(cwd, ".agents", "skills"), "deploy", "部署到预发环境");
// A Claude plugin installed under ~/.claude/plugins and a plugin repo to import into the library.
const putPlugin = (root: string, name: string) => {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: `${name} 插件` }),
  );
  putSkill(join(root, "skills"), `${name}-check`, "检查发布前的清单");
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "ship.md"), "---\ndescription: 发布\n---\n");
  mkdirSync(join(root, "hooks"), { recursive: true });
  writeFileSync(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [] } }));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }));
};
putPlugin(join(fakeHome, ".claude", "plugins", "marketplaces", "acme", "plugins", "release-kit"), "release-kit");
mkdirSync(join(fakeHome, ".claude", "agents"), { recursive: true });
writeFileSync(join(fakeHome, ".claude", "agents", "tester.md"), "---\nname: tester\ndescription: 写测试\n---\n");
const pluginRepo = mkdtempSync(join(tmpdir(), "tuantuan-plugin-repo-"));
putPlugin(pluginRepo, "doc-kit");
for (const a of [
  ["init", "-q"],
  ["add", "."],
  ["commit", "-qm", "init"],
])
  Bun.spawnSync(["git", "-C", pluginRepo, ...a], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e@e",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e@e",
    },
  });
const skillSrv = Bun.serve({
  port: 0,
  fetch: () => new Response("---\nname: changelog\ndescription: 维护 CHANGELOG.md\n---\n\nKeep a changelog.\n"),
});
// 服务商与用量: local usage logs, a CC Switch db and a DeepSeek-style balance endpoint, all fixtures.
process.env.TUANTUAN_USAGE_HOME = fakeHome;
process.env.TUANTUAN_CCSWITCH_DIR = join(fakeHome, ".cc-switch");
{
  const now = Date.now();
  const at = (ago: number) => new Date(now - ago).toISOString();
  const cl = join(fakeHome, ".claude", "projects", "-work");
  mkdirSync(cl, { recursive: true });
  writeFileSync(
    join(cl, "s.jsonl"),
    [1, 2, 3]
      .map((i) =>
        JSON.stringify({
          type: "assistant",
          timestamp: at(i * 60_000),
          requestId: `r${i}`,
          message: { id: `m${i}`, usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: 40_000 } },
        }),
      )
      .join("\n"),
  );
  const cx = join(fakeHome, ".codex", "sessions", "2026", "10", "15");
  mkdirSync(cx, { recursive: true });
  const resets = Math.floor(now / 1000) + 2 * 3600;
  writeFileSync(
    join(cx, "rollout-e2e.jsonl"),
    JSON.stringify({
      timestamp: at(30_000),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 52_000,
            cached_input_tokens: 30_000,
            output_tokens: 4000,
            total_tokens: 56_000,
          },
        },
        rate_limits: {
          primary: { used_percent: 38, window_minutes: 300, resets_at: resets },
          secondary: { used_percent: 81, window_minutes: 10080, resets_at: resets + 3 * 86400 },
          plan_type: "plus",
        },
      },
    }),
  );
  mkdirSync(join(fakeHome, ".cc-switch"), { recursive: true });
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(fakeHome, ".cc-switch", "cc-switch.db"));
  db.run("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, is_current INTEGER)");
  db.run("INSERT INTO providers VALUES ('k', 'claude', 'Kimi 包月', ?, 1)", [
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-kimi-e2e-0001" },
    }),
  ]);
  db.close();
}
const balanceSrv = Bun.serve({
  port: 0,
  fetch: (req) => {
    const u = new URL(req.url);
    if (req.headers.get("authorization") !== "Bearer sk-e2e-deepseek-4242") return new Response("no", { status: 401 });
    if (u.pathname === "/user/balance")
      return Response.json({ balance_infos: [{ currency: "CNY", total_balance: "66.60" }] });
    return Response.json({ data: [] });
  },
});
const shotsDir = process.env.SHOTS_DIR;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
// ACP registry: a local mock CDN; agents install into a throwaway managed dir.
const registry = mockRegistry();
process.env.TUANTUAN_REGISTRY_URL = registry.url;
process.env.TUANTUAN_HARNESS_DIR = mkdtempSync(join(tmpdir(), "tuantuan-e2e-harnesses-"));
const { server, app } = serve({ dbPath, staticDir: process.env.E2E_DIST ?? "web/dist" }, 0);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
let failed = false;
let diagPage: Page | undefined;
const consoleLog: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  diagPage = page;
  await page.context().grantPermissions(["notifications"]);
  await page.addInitScript(() => {
    // Record Web Notifications (browser fallback) so the test can assert on them.
    const sent: { title: string; body?: string }[] = [];
    (window as unknown as { __notes: typeof sent }).__notes = sent;
    const Real = window.Notification;
    if (Real) {
      class Spy extends Real {
        constructor(title: string, o?: NotificationOptions) {
          super(title, o);
          sent.push({ title, body: o?.body });
        }
      }
      Object.defineProperty(Spy, "permission", { get: () => Real.permission });
      window.Notification = Spy as unknown as typeof Notification;
    }
    const t0 = performance.now();
    addEventListener("hashchange", () => console.log(`hash ${Math.round(performance.now() - t0)}ms ${location.hash}`));
  });
  page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));
  const shot = async (name: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  };
  // Sidebar: conversations by default; 设置 swaps it to Agents / Harness / 服务商与用量.
  const nav = async (name: string) => {
    const item = page.locator(".side-nav", { hasText: name });
    if (!(await item.count())) await page.locator(".side-settings").click();
    await item.first().click();
  };
  const toRooms = async () => {
    if (await page.locator(".side-back").count()) await page.locator(".side-back").click();
    await page.locator(".side-section-head").waitFor();
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.port}/`);
  await page.locator(".side-foot .dot.ok").waitFor();

  // First launch: one-screen onboarding. Pick the mock harness → it is logged out, its own login
  // method signs in → name the first agent → it is created with a conversation in 草稿, which opens.
  await page.getByRole("heading", { name: "开始使用团团" }).waitFor();
  await page.getByRole("button", { name: "跳过" }).waitFor();
  await page.getByRole("button", { name: /Mock（测试）/ }).click();
  await page.getByRole("button", { name: "用「Mock 登录」登录" }).click();
  await page.getByLabel("Agent 名称").waitFor();
  await page.getByLabel("Agent 名称").fill("小助手");
  await page.waitForTimeout(250);
  await shot("setup");
  await page.getByRole("button", { name: "创建并开始会话" }).click();
  await page.waitForFunction(() => /^#\/c\/[^/]+$/.test(location.hash) && !location.hash.endsWith("/new"));
  await page.locator(".composer-box textarea").waitFor();
  if (!app.store.getSetting("onboarded", false)) throw new Error("onboarding not persisted");
  if (!app.store.listAgents().some((a) => a.name === "小助手" && a.harness === "mock"))
    throw new Error("onboarding agent missing");
  // Finishing is remembered server-side: #/setup now lands on Harness 管理.
  await page.goto(`http://localhost:${server.port}/#/setup`);
  await page.locator(".side-foot .dot.ok").waitFor();
  await page.waitForFunction(() => location.hash === "#/harness");
  await page.getByRole("heading", { name: "Harness 管理" }).waitFor();
  const mockRow = page.locator(".harness-row", { hasText: "Mock（测试）" });
  await mockRow.getByRole("button", { name: "握手测试" }).click();
  await mockRow.getByText(/ACP v1 · Mock.*已登录/).waitFor();

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

  // 更多 Agent: the registry list (mock CDN), search, one-click binary install (checksum), handshake.
  const more = page.locator("section", { has: page.getByRole("heading", { name: "更多 Agent" }) });
  await more.getByRole("button", { name: "刷新 Registry" }).click();
  await more.getByLabel("搜索 Agent").fill("Mock 二进制");
  const item = more.getByRole("article", { name: "Mock 二进制" });
  await item.getByRole("button", { name: "安装", exact: true }).click();
  await item.getByText(/已安装 1\.0\.0/).waitFor({ timeout: 60_000 });
  await item.getByRole("button", { name: "握手" }).click();
  await item.getByRole("status").getByText(/ACP/).waitFor();
  await item.scrollIntoViewIfNeeded();
  await shot("harness-registry");
  await more.getByLabel("搜索 Agent").fill("");
  await page.setViewportSize({ width: 1440, height: 1500 });
  await more.scrollIntoViewIfNeeded();
  await shot("harness-registry-list");
  await page.setViewportSize({ width: 1440, height: 900 });

  // An agent that needs an API key (env_var login, like glm-acp-agent) and has a terminal `--setup`:
  // the reply fails → the conversation asks for the key in place → saved masked → it answers.
  await more.getByLabel("搜索 Agent").fill("Mock 密钥");
  const keyItem = more.getByRole("article", { name: "Mock 密钥" });
  await keyItem.getByRole("button", { name: "安装", exact: true }).click();
  await keyItem.getByText(/已安装 1\.0\.0/).waitFor({ timeout: 60_000 });
  await keyItem.getByRole("button", { name: "握手" }).click();
  await keyItem
    .getByRole("status")
    .getByText(/需要 API Key/)
    .waitFor();
  await keyItem.getByLabel("MOCK_API_KEY").waitFor();
  await keyItem.getByRole("button", { name: /在终端中打开「Mock 设置」/ }).waitFor();
  const setupCmd =
    (await keyItem.locator(".copy-line code").filter({ hasText: "--setup" }).first().textContent()) ?? "";
  if (!/^env MOCK_AGENT_KEY_VAR=MOCK_API_KEY \/.+\/bin\/mock-acp --setup$/.test(setupCmd.trim()))
    throw new Error(`terminal command: ${setupCmd}`);
  await keyItem.scrollIntoViewIfNeeded();
  await shot("harness-api-key");
  const keyAgent = await (
    await fetch(`http://localhost:${server.port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "KeyBot", harness: "reg:mock-key", avatarShape: "cat" }),
    })
  ).json();
  const keyRoom = await (
    await fetch(`http://localhost:${server.port}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "KeyBot", agentIds: [keyAgent.id] }),
    })
  ).json();
  await page.goto(`http://localhost:${server.port}/#/c/${keyRoom.id}`);
  await page.reload();
  const keyBox = page.locator(".composer-box textarea");
  await keyBox.fill("你好");
  await keyBox.press("Enter");
  const needKey = page.locator(".need-key");
  await needKey.getByText("需要 API Key").waitFor();
  await needKey.getByLabel("MOCK_API_KEY").fill("sk-e2e-key-123456");
  await shot("conversation-need-key");
  await needKey.getByRole("button", { name: "保存" }).click();
  await needKey.getByText("已保存，重新发送消息即可").waitFor();
  if (JSON.stringify(app.store.getSetting("harnessEnv", {})).indexOf("sk-e2e-key-123456") < 0)
    throw new Error("key not stored");
  await keyBox.fill("再试一次");
  await keyBox.press("Enter");
  await page.getByText("收到：「再试一次」").waitFor();
  await nav("Harness");
  await page.getByRole("heading", { name: "Harness 管理" }).waitFor();

  const createAgent = async (name: string, identity: string) => {
    await nav("Agents");
    await page.locator(".side").getByRole("button", { name: "新建 Agent" }).click();
    await page.getByLabel("名称").fill(name);
    await page.getByLabel("Harness", { exact: true }).selectOption({ label: "Mock（测试）" });
    await page.getByLabel("身份文档").fill(identity);
    // Skills already on the machine are listed before the agent exists.
    await page.locator(".skills-card .skill-row").first().waitFor();
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
  await nav("Agents");
  await page.locator(".side").getByRole("button", { name: "新建 Agent" }).click();
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

  await toRooms();
  // New project with an existing folder.
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill("冒烟项目");
  await page.getByRole("button", { name: "选择已有" }).click();
  await page.getByRole("button", { name: "选择文件夹" }).click();
  const fb = page.getByRole("dialog", { name: "选择项目文件夹" });
  await fb.locator(".fb-crumb button", { hasText: /^\/$/ }).click();
  for (const part of cwd.split("/").filter(Boolean)) {
    await fb.locator(".fb-crumb:last-child button").waitFor();
    await fb.locator(".fb-row", { has: page.locator(".fb-name", { hasText: new RegExp(`^${part}$`) }) }).click();
    await fb.locator(".fb-crumb:last-child button", { hasText: part }).waitFor();
  }
  await page.waitForTimeout(250);
  await shot("folder-picker");
  await fb.getByRole("button", { name: "选择此文件夹" }).click();
  await page.locator(".folder-chip", { hasText: cwd.split("/").pop() ?? "" }).waitFor();
  await page.getByLabel("项目名称").fill("冒烟项目");
  await shot("new-project");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("heading", { name: "冒烟项目" }).waitFor();
  const project = app.store.listProjects().find((p) => p.name === "冒烟项目");
  if (!project || project.cwd !== cwd) throw new Error("new project dir mismatch");

  // Skills: discovered from the user's dirs + the selected project, enable one, add one from a URL.
  await nav("Agents");
  await page.locator(".list-item", { hasText: "Alice" }).first().click();
  const skillsCard = page.locator(".skills-card");
  await skillsCard.getByRole("button", { name: "项目" }).click();
  await page.getByRole("option", { name: /冒烟项目/ }).click();
  await skillsCard.getByRole("button", { name: "项目" }).filter({ hasText: "冒烟项目" }).waitFor();
  await skillsCard.locator(".skill-group-title", { hasText: "可选" }).waitFor();
  await skillsCard.locator(".skill-row", { hasText: "deploy" }).waitFor();
  for (const n of ["code-review", "pdf-tools", "release-notes"])
    await skillsCard.locator(".skill-row", { hasText: n }).waitFor();
  await skillsCard.getByLabel("pdf-tools").check();
  await skillsCard.getByLabel("Skill 链接").fill(`http://localhost:${skillSrv.port}/SKILL.md`);
  await skillsCard.getByRole("button", { name: "查找" }).click();
  await skillsCard.getByLabel("添加 changelog").waitFor();
  await skillsCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot("skills-preview");
  await skillsCard.getByRole("button", { name: /^添加/ }).click();
  await skillsCard.locator(".skill-row", { hasText: "changelog" }).locator(".badge", { hasText: "已导入" }).waitFor();
  const aliceId = app.store.listAgents().find((a) => a.name === "Alice")?.id ?? "";
  const linked = readFileSync(join(dirname(dbPath), "agents", aliceId, "skills-linked.json"), "utf8");
  if (!linked.includes("pdf-tools")) throw new Error("skill link not saved");
  await page.waitForTimeout(250);
  await shot("skills");
  // Plugins in the Agent's checklist: searchable, with this harness's support.
  await skillsCard.getByLabel("搜索 Skills 与插件").fill("release");
  const kit = skillsCard.getByRole("list", { name: "插件列表" }).locator(".skill-row", { hasText: "release-kit" });
  await kit.locator(".badge", { hasText: /部分/ }).waitFor(); // mock harness: no commands / hooks
  await kit.getByLabel("release-kit", { exact: true }).check();
  await page.waitForTimeout(300);
  await shot("agent-library");
  await skillsCard.getByLabel("搜索 Skills 与插件").fill("");
  if (!readFileSync(join(dirname(dbPath), "agents", aliceId, "plugins-linked.json"), "utf8").includes("release-kit"))
    throw new Error("plugin choice not saved");

  // Agent defaults read from the harness's own options.
  await page.getByRole("button", { name: "默认推理" }).click();
  await page.getByRole("option", { name: /^高/ }).click();
  await page.getByRole("button", { name: "默认推理" }).filter({ hasText: "高" }).waitFor();
  await page.getByRole("button", { name: "默认推理" }).scrollIntoViewIfNeeded();
  await shot("agent-defaults");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.locator('.side-agent[title*="推理 高"]', { hasText: "Alice" }).waitFor();

  await toRooms();
  await page.locator(".side-top").getByRole("button", { name: "新建会话" }).click();
  // 项目（可选）: defaults to 不选项目 (草稿); styled picker with folder icons.
  const projBtn = page.getByRole("button", { name: "项目", exact: true });
  await projBtn.filter({ hasText: "不选项目" }).waitFor();
  await projBtn.click();
  await page
    .getByRole("listbox", { name: "项目" })
    .getByRole("option", { name: /冒烟项目/ })
    .waitFor();
  await page.waitForTimeout(300);
  await shot("new-conversation-project");
  await page
    .getByRole("listbox", { name: "项目" })
    .getByRole("option", { name: /冒烟项目/ })
    .click();
  await projBtn.filter({ hasText: "冒烟项目" }).waitFor();
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
  // Multi-agent: one summary chip, per-agent settings inside.
  await page.locator(".chip-summary").click();
  await page.locator(".pop-menu .opt-group-head", { hasText: "Alice" }).waitFor();
  await page.locator(".pop-menu .opt-group-head", { hasText: "Bob" }).waitFor();
  await page.waitForTimeout(250);
  await shot("chips-group");
  await page.keyboard.press("Escape");

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
  await shot("conversation-handoff");
  // Single-agent conversation in 草稿

  // No project chosen → 草稿.
  await page.locator(".side-top").getByRole("button", { name: "新建会话" }).click();
  await projBtn.filter({ hasText: "不选项目" }).waitFor();
  await page.getByLabel("会话名称").fill("草稿会话");
  await pick("Bob").check();
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByRole("heading", { name: "草稿会话" }).waitFor();
  if (app.store.listRooms().find((r) => r.name === "草稿会话")?.projectId !== "drafts")
    throw new Error("conversation without a project should go to 草稿");
  // A project's "+" preselects that project.
  await page.locator(".side-group-head", { hasText: "冒烟项目" }).hover();
  await page.getByRole("button", { name: "在 冒烟项目 新建会话" }).click();
  await projBtn.filter({ hasText: "冒烟项目" }).waitFor();
  await page.getByLabel("会话名称").fill("与 Bob");
  await pick("Bob").check();
  await shot("new-conversation-single");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.locator(".model-trigger").waitFor(); // composer model picker
  await page.locator(".model-trigger").click();
  await page.getByRole("option", { name: "Mock Smart" }).waitFor();
  // Vendor logos by model id; unknown (mock-*) ids get the neutral mark.
  for (const [name, brand] of [
    ["Claude Sonnet 4.5", "anthropic"],
    ["GPT-5.5", "openai"],
    ["Gemini 2.5 Pro", "google"],
    ["GLM-4.6", "zhipu"],
    ["Kimi K2", "moonshot"],
    ["Mock Smart", "generic"],
  ])
    await page.getByRole("option", { name }).locator(`.brand-${brand}`).waitFor();
  await page.waitForTimeout(350);
  await shot("model-picker");
  await page.getByRole("option", { name: "Mock Smart" }).click();
  await page.locator(".model-trigger", { hasText: "Mock Smart" }).waitFor();
  // Settings live in the composer as chips (no floating select row); danger values are tinted.
  if (await page.locator(".session-bar select, .sess-select").count()) throw new Error("legacy select row still shown");
  await page.locator(".chip-opt", { hasText: "权限" }).click();
  await page.getByRole("option", { name: /全部允许/ }).click();
  await page.locator(".chip-opt[data-danger]", { hasText: "全部允许" }).waitFor();
  await page.locator(".chip-opt", { hasText: "权限" }).click();
  await page.getByRole("option", { name: /询问/ }).click();
  await page.locator(".chip-opt:not([data-danger])", { hasText: "询问" }).waitFor();
  // A model the harness rejects: readable error, current model kept.
  await page.locator(".model-trigger").click();
  await page.getByRole("option", { name: "Mock Broken" }).click();
  await page.getByText(/Invalid model: mock-broken/).waitFor();
  await page.locator(".model-trigger", { hasText: "Mock Smart" }).waitFor();
  // Narrow window: popover stays inside the viewport and above the trigger, nothing clipped.
  await page.setViewportSize({ width: 420, height: 760 });
  await page.waitForTimeout(200);
  await page.locator(".model-trigger").click();
  await page.locator(".pop-menu").waitFor();
  await page.waitForTimeout(250);
  const popIssues = await page.evaluate(() => {
    const pop = document.querySelector(".pop-menu")?.getBoundingClientRect();
    const trig = document.querySelector(".model-trigger")?.getBoundingClientRect();
    if (!pop || !trig) return ["missing"];
    const out: string[] = [];
    if (pop.left < 0 || pop.right > innerWidth || pop.top < 0 || pop.bottom > innerHeight)
      out.push(`off-screen ${JSON.stringify(pop)}`);
    if (pop.bottom > trig.top + 1) out.push("not above trigger");
    const logo = document.querySelector(".pop-menu .brand-logo")?.getBoundingClientRect();
    if (!logo || logo.left < pop.left) out.push("logo clipped");
    const hit = document.elementFromPoint(pop.left + 20, pop.top + 20);
    if (!hit?.closest(".pop-menu")) out.push("popover under other content");
    return out;
  });
  await shot("chips-narrow");
  if (popIssues.length) throw new Error(`popover: ${popIssues.join("; ")}`);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  await page.locator(".chip-opt", { hasText: "推理" }).click();
  await page.waitForTimeout(250);
  await shot("chips");
  await page.keyboard.press("Escape");
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
  await page.getByText("命令跑完了。").waitFor();
  {
    // Tool calls are one collapsed row; the output opens on click.
    const card = page.locator("details.tool", { hasText: "echo hello" }).last();
    if (await card.evaluate((d) => (d as HTMLDetailsElement).open)) throw new Error("tool card should start collapsed");
    if (await page.locator("pre.term:not(.term-wrap pre)", { hasText: "终端输出不可用" }).count())
      throw new Error("empty terminal box rendered");
    await card.locator("summary").click();
    await card.locator(".term", { hasText: "hello from terminal" }).waitFor();
    await card.locator("summary").click();
  }

  // Already switched to Mock Smart via the composer picker above; sending confirms the preference stuck.
  await input.fill("换模型了");
  await input.press("Enter");
  await page.getByText("收到：「换模型了」（mock-smart）").waitFor();
  await page.locator(".ctx-usage").waitFor();
  await shot("conversation-capabilities");

  await input.fill("/slow");
  await input.press("Enter");
  await page.locator('.send-btn[data-mode="stop"]').waitFor();
  if (await page.locator(".run-bar").count()) throw new Error("reply banner should be gone");
  await page.waitForTimeout(250);
  await shot("composer-stop");
  {
    const btn = page.locator('.send-btn[data-mode="stop"]');
    const off = await btn.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const i = (el.querySelector(".send-ico-stop i") as HTMLElement).getBoundingClientRect();
      return Math.max(
        Math.abs(b.left + b.width / 2 - (i.left + i.width / 2)),
        Math.abs(b.top + b.height / 2 - (i.top + i.height / 2)),
      );
    });
    if (off > 0.5) throw new Error(`stop icon off-center by ${off}px`);
    if (shotsDir) {
      await page.addStyleTag({ content: ".send-ico-stop i { animation: none !important; }" });
      await btn.screenshot({ path: join(shotsDir, "stop-1x.png") });
    }
  }
  await page.getByRole("button", { name: "停止" }).click();
  await page.locator(".state-tag", { hasText: "已停止" }).waitFor();

  // A harness that never answers and ignores session/cancel: 停止 still ends the turn.
  await page.locator(".model-trigger").click();
  await page.getByRole("option", { name: "Mock Stuck" }).click();
  await page.locator(".model-trigger", { hasText: "Mock Stuck" }).waitFor();
  await input.fill("卡住了吗");
  await input.press("Enter");
  await page.locator('.send-btn[data-mode="stop"]').waitFor();
  await page.getByRole("button", { name: "停止" }).click();
  await page.locator('.send-btn[data-mode="stop"]').waitFor({ state: "detached", timeout: 10_000 });
  await page.locator(".model-trigger").click();
  await page.getByRole("option", { name: "Mock Smart" }).click();
  await page.locator(".model-trigger", { hasText: "Mock Smart" }).waitFor();

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
    // One 56px header line: sidebar top row, floating title pill, details header.
    for (const sel of [".side-top", ".details-head"]) {
      const b = r(document.querySelector(sel));
      if (!b) out.push(`missing ${sel}`);
      else {
        near(b.height, 56, `${sel} height`);
        near(b.top, 0, `${sel} top`);
      }
    }
    const pill = r(document.querySelector(".title-pill"));
    const main = r(document.querySelector(".chat-head"));
    if (!pill || !main) out.push("missing title pill");
    else {
      near(pill.top + pill.height / 2, 28, "title pill centred on header line");
      near(pill.left + pill.width / 2, main.left + main.width / 2, "title pill centred");
    }
    const details = r(document.querySelector(".details"));
    for (const b of document.querySelectorAll(".main-head button")) {
      const x = b.getBoundingClientRect();
      if (details && x.width && x.right > details.left) out.push("chat header control overlaps the details panel");
    }
    // Sidebar: ungrouped rows and project headers share one left edge; project rows indent one level.
    const rows = [...document.querySelectorAll(".side-scroll > .side-room")].map((e) => e.getBoundingClientRect().left);
    const heads = [...document.querySelectorAll(".side-group-head")].map((e) => e.getBoundingClientRect().left);
    const kids = [...document.querySelectorAll(".side-group-rooms .side-room")].map(
      (e) => e.getBoundingClientRect().left,
    );
    const edge = rows[0] ?? heads[0] ?? Number.NaN;
    for (const x of [...rows, ...heads]) near(x, edge, "sidebar row left edge");
    for (const x of kids) near(x, edge + 14, "project conversation indent");
    for (const c of document.querySelectorAll(".side-group-count")) {
      const b = c.getBoundingClientRect();
      const h = c.parentElement?.getBoundingClientRect();
      if (b.width && h) near(h.right - b.right, 12, "project count right-aligned");
    }
    const left = (el: Element | null) =>
      el ? el.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(el).paddingLeft) : Number.NaN;
    // Agent bubbles: name label, meta and timeline line up with the text inside the bubble.
    for (const g of document.querySelectorAll('.msg-group[data-kind="agent"]')) {
      const text = left(g.querySelector(".msg"));
      near(g.querySelector(".msg-head")?.getBoundingClientRect().left ?? text, text, "message name vs text");
      for (const s of [".msg-meta", ".timeline"])
        for (const el of g.querySelectorAll(s)) near(el.getBoundingClientRect().left, text, `${s} vs text`);
    }
    // Human bubbles sit on the right edge of the message column.
    const col = r(document.querySelector(".messages"));
    for (const m of document.querySelectorAll('.msg-group[data-kind="human"] .msg')) {
      const b = m.getBoundingClientRect();
      if (col && b.right > col.right) out.push("human bubble overflows message column");
    }
    const composer = r(document.querySelector(".composer-box"));
    const list = r(document.querySelector(".messages-inner, .messages"));
    if (composer && list && composer.width < list.width)
      near(composer.left + composer.width / 2, list.left + list.width / 2, "composer centred under messages");
    const dts = [...document.querySelectorAll(".details .kv dt")].map((e) => e.getBoundingClientRect().left);
    const dds = [...document.querySelectorAll(".details .kv dd")].map((e) => e.getBoundingClientRect().left);
    if (new Set(dts).size > 1 || new Set(dds).size > 1) out.push("details label/value columns not aligned");
    return out;
  });
  if (issues.length) throw new Error(`alignment: ${issues.join("; ")}`);

  // Agent editor: header stays on the 56px line, opaque, and scrolled content never shows through.
  await nav("Agents");
  await page.locator(".list-item", { hasText: "Alice" }).first().click();
  await page.getByLabel("名称").waitFor();
  await page.locator("form.page").evaluate((el) => el.scrollTo(0, 240));
  await page.waitForTimeout(100);
  await settle();
  const editorIssues = await page.evaluate(() => {
    const out: string[] = [];
    const head = document.querySelector(".main-head")?.getBoundingClientRect();
    const page = document.querySelector("form.page")?.getBoundingClientRect();
    const bar = document.querySelector(".save-bar")?.getBoundingClientRect();
    if (!head || !page || !bar) return ["editor elements missing"];
    if (Math.abs(head.height - 56) > 0.5 || head.top !== 0) out.push(`editor head ${head.top}/${head.height}`);
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
  await nav("Agents");
  await page.locator(".list-item", { hasText: "Bob" }).first().click();
  await page.getByRole("button", { name: /对话/ }).click();
  await live("Bob", "直播-1", /收到：「直播-1」/);
  await toRooms();
  await page.locator(".li-title", { hasText: "冒烟会话" }).click();
  await live("冒烟会话", "@Bob 会话直播-2", /\[我\]: @Bob 会话直播-2/);
  await page.locator(".li-title", { hasText: "与 Bob" }).click();
  await live("与 Bob", "切换后-3", /收到：「切换后-3」/);
  await page.unroute(/\/api\/rooms\/[^/]+\/messages\?/);
  if ((await page.evaluate(() => performance.getEntriesByType("navigation").length)) !== navs)
    throw new Error("page reloaded during live checks");

  // 服务商与用量: usage cards from local fixtures, add a DeepSeek profile (mock endpoint), test +
  // balance, CC Switch import on click, then pick the profile on a Claude Code agent.
  await page.setViewportSize({ width: 1440, height: 1100 });
  const ccAgent = await (
    await fetch(`http://localhost:${server.port}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "架构师", harness: "claude-code", identity: "", env: {}, mcpServerIds: [] }),
    })
  ).json();
  // Grok Build "installed" now (after the install checks above): a stand-in CLI that answers
  // `grok usage <id>` with the JSON captured from the real grok 1.0.52.
  {
    const gdir = join(fakeHome, ".grok");
    mkdirSync(join(gdir, "bin"), { recursive: true });
    const sid = "01a13d37-9bd8-7672-97ce-4c27e230203f";
    mkdirSync(join(gdir, "sessions", "%2Fwork", sid), { recursive: true });
    const real = JSON.parse(readFileSync("tests/fixtures/grok-usage.json", "utf8"));
    const turns = [1290, 1290, 1290].map((totalTokens) => ({
      ...real.turns[0],
      totalTokens,
      endedAt: new Date().toISOString(),
      costUsdTicks: 4e8,
    }));
    writeFileSync(join(gdir, "usage.json"), JSON.stringify({ ...real, turns }));
    writeFileSync(
      join(gdir, "bin", "grok"),
      `#!/bin/sh\ncase "$1" in --version) echo "grok 1.0.52";; usage) cat "${join(gdir, "usage.json")}";; *) exit 1;; esac\n`,
    );
    chmodSync(join(gdir, "bin", "grok"), 0o755);
  }
  await page.reload();
  await page.locator(".side-foot .dot.ok").waitFor();
  await nav("服务商与用量");
  await page.waitForFunction(() => location.hash === "#/providers");
  // Token 统计: what the mock harness reported per turn (usage + _meta.quota model + cumulative cost).
  const ud = page.locator(".ud");
  await ud
    .getByTestId("usage-row-Bob")
    .getByText(/^\d+(\.\d)?k$/)
    .waitFor();
  await ud.getByTestId("usage-row-架构师").getByText("无数据").waitFor(); // Claude Code: no turns recorded here
  await ud.getByRole("button", { name: "全部" }).click();
  await ud.getByRole("tab", { name: "模型" }).click();
  await ud.getByTestId("usage-row-mock-smart").waitFor();
  await ud.getByTestId("usage-row-mock-fast").waitFor();
  await ud.getByRole("tab", { name: "Agent" }).click();
  await page.waitForTimeout(700);
  await shot("usage-dashboard");
  const codexCard = page.getByTestId("usage-codex");
  await codexCard.getByText("剩 62%").waitFor();
  await codexCard.getByText("剩 19%").waitFor();
  await codexCard.getByText("plus").waitFor();
  await page.getByTestId("usage-claude-code").getByText("126.0k").first().waitFor();
  await page.getByTestId("usage-opencode").getByText("暂不支持查询").waitFor();
  const grokCard = page.getByTestId("usage-grok");
  await grokCard.getByText("3.9k").first().waitFor();
  await grokCard.getByText("$0.12").waitFor();
  await grokCard.getByText(/ACP 没有提供/).waitFor();
  await page
    .getByTestId("usage-tuantuan")
    .getByText(/\d+ 轮/)
    .waitFor();
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "添加服务商" });
  await dlg.getByRole("button", { name: "DeepSeek" }).click();
  if ((await dlg.getByLabel("名称").inputValue()) !== "DeepSeek") throw new Error("preset did not fill the name");
  await dlg.getByLabel("API Key").fill("sk-e2e-deepseek-4242");
  const mockBase = `http://127.0.0.1:${balanceSrv.port}`;
  await dlg.getByLabel("Claude Code 地址").fill(`${mockBase}/anthropic`);
  await dlg.getByLabel("OpenAI 兼容地址").fill(`${mockBase}/v1`);
  await dlg.getByRole("button", { name: "保存" }).click();
  await dlg.waitFor({ state: "detached" });
  const ds = page.getByTestId("provider-DeepSeek");
  await ds.getByText(/sk-e…4242|4242/).waitFor();
  if ((await page.content()).includes("sk-e2e-deepseek-4242")) throw new Error("API key leaked to the page");
  await ds.getByRole("button", { name: "测速" }).click();
  await ds.getByText(/连通 · \d+ ms/).waitFor();
  await ds.getByRole("button", { name: "余额" }).click();
  await ds.getByText("余额 66.60 CNY").waitFor();
  await page.getByRole("button", { name: "从 CC Switch 导入" }).click();
  const imp = page.getByRole("dialog", { name: "从 CC Switch 导入" });
  await imp.getByText("Kimi 包月").waitFor();
  await page.waitForTimeout(500); // let the dialog finish animating in
  await shot("ccswitch-import");
  await imp.getByRole("button", { name: /导入 1 个/ }).click();
  await page.getByTestId("provider-Kimi 包月").waitFor();
  await shot("providers");
  await ds.getByRole("button", { name: "切换 Agent" }).click();
  await ds.getByRole("button", { name: "架构师" }).click();
  await ds.getByText("架构师 在用").waitFor();
  await page.goto(`http://localhost:${server.port}/#/a/${ccAgent.id}`);
  const provPick = page.getByRole("group", { name: "服务商" });
  await provPick.getByRole("button", { name: "DeepSeek" }).and(page.locator("[aria-pressed=true]")).waitFor();
  await provPick.getByRole("button", { name: "本机配置" }).click();
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByText("所有修改已保存").or(page.getByText("已保存")).first().waitFor();
  await provPick.getByRole("button", { name: "Kimi 包月" }).waitFor();
  await provPick.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot("agent-provider");
  await page.setViewportSize({ width: 1440, height: 900 });

  // 「Skills 与插件」: discovered read-only + imported (update / delete), per-harness support.
  await nav("Skills 与插件");
  const libItem = (n: string) => page.getByTestId(`lib-${n}`);
  await libItem("release-kit").getByText("Claude 插件").waitFor();
  await libItem("release-kit")
    .getByText(/1 Skill · 1 命令 · 1 MCP · 1 Hook/)
    .waitFor();
  await libItem("release-kit").locator('.lib-chip[data-level="yes"]', { hasText: "Claude" }).waitFor();
  await libItem("release-kit").locator('.lib-chip[data-level="partial"]', { hasText: "Codex" }).waitFor();
  await libItem("tester").getByText("Claude 子代理").waitFor();
  await libItem("code-review").getByText("~/.claude").waitFor();
  await page.getByLabel("导入链接").fill(`file://${pluginRepo}`);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await libItem("doc-kit").getByText("已导入").waitFor();
  await page.locator(".lib-pkg", { hasText: "doc-kit" }).getByRole("button", { name: "更新" }).click();
  await page.locator(".lib-pkg", { hasText: "doc-kit" }).waitFor();
  await page.waitForTimeout(400);
  await shot("library");
  await page.getByRole("tab", { name: /插件/ }).click();
  await libItem("code-review").waitFor({ state: "detached" });
  await page.getByRole("tab", { name: /全部/ }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "删除 doc-kit" }).click();
  await libItem("doc-kit").waitFor({ state: "detached" });

  // Settings pages never scroll sideways and the sidebar never covers them (packaged mac window ≈1024px).
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [label, hash] of [
      ["Agents", "#/a"],
      ["Agent 编辑", `#/a/${ccAgent.id}`],
      ["Harness", "#/harness"],
      ["服务商与用量", "#/providers"],
      ["Skills 与插件", "#/library"],
    ] as const) {
      await page.goto(`http://localhost:${server.port}/${hash}`);
      await page.locator(".main .main-head, .main > .pane > .empty").first().waitFor();
      await page.waitForTimeout(400);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        const side = document.querySelector(".side")?.getBoundingClientRect();
        const main = document.querySelector(".main")?.getBoundingClientRect();
        if (!side || !main) return ["missing sidebar / main"];
        if (Math.abs(main.left - side.right) > 0.5)
          out.push(`main starts at ${main.left}, sidebar ends at ${side.right}`);
        for (const sel of ["html", "body", ".shell", ".main", ".page", ".page-inner"])
          for (const el of document.querySelectorAll(sel))
            if (el.scrollWidth > el.clientWidth + 0.5)
              out.push(`${sel} scrolls sideways: ${el.scrollWidth} > ${el.clientWidth}`);
        const m = document.querySelector(".main") as HTMLElement;
        if (m.scrollLeft !== 0) out.push(`main scrolled ${m.scrollLeft}`);
        return out;
      });
      if (bad.length) throw new Error(`${label} @${width}: ${bad.join("; ")}`);
      if (label === "Harness" && width === 1024) await shot("harness-1024");
    }
  }
  // Desktop titlebar: sidebar search / + stay clickable; no drag strip from another column covers them.
  await page.setViewportSize({ width: 1024, height: 640 });
  for (const hash of ["#/c", `#/c/${app.store.listRooms()[0]?.id}`, "#/a", "#/harness", "#/library", "#/providers"]) {
    await page.goto(`http://localhost:${server.port}/${hash}`);
    await page.locator(".side-top .side-icon").first().waitFor();
    await page.waitForTimeout(300);
    const bad = await page.evaluate(() => {
      document.documentElement.dataset.desktop = "darwin";
      const region = (el: Element) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || "none";
      const out: string[] = [];
      const drags = [...document.querySelectorAll("body *")].filter(
        (el) => region(el) === "drag" && el.getBoundingClientRect().width > 0,
      );
      for (const btn of document.querySelectorAll(".side-top button, .main-head button, .chat-head button")) {
        const r = btn.getBoundingClientRect();
        if (!r.width) continue;
        const name = btn.getAttribute("aria-label") ?? btn.textContent?.trim();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(btn === hit || btn.contains(hit))) out.push(`${name}: covered by ${hit?.className}`);
        if (region(btn) !== "no-drag") out.push(`${name}: app-region ${region(btn)}`);
        for (const d of drags) {
          if (d.contains(btn)) continue;
          const q = d.getBoundingClientRect();
          if (cx > q.left && cx < q.right && cy > q.top && cy < q.bottom)
            out.push(`${name}: under drag strip ${d.className}`);
        }
      }
      delete document.documentElement.dataset.desktop;
      return out;
    });
    if (bad.length) throw new Error(`titlebar ${hash}: ${bad.join("; ")}`);
  }

  // Settings sidebar: Agents sub-list expands smoothly, "新建 Agent" never clipped, concise subtitles.
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto(`http://localhost:${server.port}/#/harness`);
  await page.locator(".main .main-head").first().waitFor();
  const collapse = page.locator(".side-collapse");
  if ((await collapse.getAttribute("data-open")) !== null) throw new Error("agents list open outside Agents");
  await page.locator(".side-nav", { hasText: "Agents" }).click();
  for (const t of [40, 90]) {
    await page.waitForTimeout(t === 40 ? 40 : 50);
    if (shotsDir) await page.locator(".side").screenshot({ path: join(shotsDir, `sidebar-expand-${t}ms.png`) });
  }
  await page.waitForTimeout(300);
  const addBtn = page.locator(".side-agent-add");
  const clip = await addBtn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const sub = el.closest(".side-sub")?.getBoundingClientRect();
    const scroll = el.closest(".side-scroll")?.getBoundingClientRect();
    if (!sub || !scroll) return "missing containers";
    if (
      r.bottom > sub.bottom + 0.5 &&
      (el.closest(".side-sub") as HTMLElement).scrollHeight <= (el.closest(".side-sub") as HTMLElement).clientHeight
    )
      return `clipped by list: ${r.bottom} > ${sub.bottom}`;
    return "";
  });
  if (clip) throw new Error(`新建 Agent ${clip}`);
  await addBtn.scrollIntoViewIfNeeded();
  if (!(await addBtn.isVisible())) throw new Error("新建 Agent not visible");
  for (const sub of await page.locator(".side-agent .li-sub").allTextContents())
    if (/builtin:/i.test(sub)) throw new Error(`internal id in subtitle: ${sub}`);
  await page.locator(".side-agent", { hasText: ccAgent.name }).first().click();
  await page.locator(`.side-agent[aria-current="page"]`).waitFor();
  await page.waitForTimeout(350);
  await shot("settings-agents");
  await page.locator(".side-nav", { hasText: "Harness" }).click();
  await page.waitForTimeout(60);
  if (shotsDir) await page.locator(".side").screenshot({ path: join(shotsDir, "sidebar-collapse-60ms.png") });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Chat: soft fade edges never take clicks; long tool output stays collapsed.
  {
    const dm = app.store.listRooms().find((r) => r.agentIds.length === 1 && r.name.includes("Bob"));
    if (!dm) throw new Error("no Bob DM");
    await page.goto(`http://localhost:${server.port}/#/c/${dm.id}`);
    await page.locator(".messages-wrap").waitFor();
    const fades = await page.$$eval(".msg-fade", (els) => els.map((e) => getComputedStyle(e).pointerEvents));
    if (fades.length !== 2 || fades.some((p) => p !== "none")) throw new Error(`fade overlays: ${fades}`);
    await page.locator(".messages").evaluate((el) => el.scrollTo({ top: 0 }));
    await page.waitForTimeout(200);
    if ((await page.locator(".messages-wrap[data-more-below] .msg-fade-bottom").count()) !== 1)
      throw new Error("bottom fade should show when scrolled up");
    await shot("chat-fade");

    // Notifications: settings page, test notification, and a real reply in another conversation.
    await nav("通知");
    await page.getByRole("heading", { name: "通知", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "回复完成" }).waitFor();
    await page.getByRole("button", { name: "发送测试通知" }).click();
    await page.getByRole("status").filter({ hasText: "已发送" }).waitFor();
    await shot("notifications");
    const notes = () =>
      page.evaluate(() => (window as unknown as { __notes: { title: string; body?: string }[] }).__notes);
    if (!(await notes()).some((n) => n.title === "团团")) throw new Error("test notification not shown");
    const r = await fetch(`http://localhost:${server.port}/api/rooms/${dm.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderName: "我", content: "通知测试" }),
    });
    if (!r.ok) throw new Error(`send: ${r.status}`);
    await page.waitForFunction(() =>
      (window as unknown as { __notes: { title: string; body?: string }[] }).__notes.some((n) =>
        n.body?.includes("通知测试"),
      ),
    );
    const note = (await notes()).find((n) => n.body?.includes("通知测试"));
    if (note?.title !== "Bob") throw new Error(`notification title: ${note?.title}`);
    await page.locator(".side-back").click();
    await page.locator(".side-room", { hasText: dm.name }).first().locator(".unread").waitFor();
    // Opening the conversation clears its unread count.
    await page.locator(".side-room", { hasText: dm.name }).first().click();
    await page.locator(".side-room[aria-current] .unread").waitFor({ state: "detached" });
    // Off switch: no notification for the next reply.
    await page.evaluate(() =>
      localStorage.setItem(
        "tuantuan:notify",
        JSON.stringify({ enabled: true, reply: false, permission: true, error: true, auth: true }),
      ),
    );
    await nav("Harness");
    const before = (await notes()).length;
    await fetch(`http://localhost:${server.port}/api/rooms/${dm.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderName: "我", content: "静音测试" }),
    });
    await page.waitForTimeout(1500);
    if ((await notes()).length !== before) throw new Error("reply notification should be off");
    await page.evaluate(() => localStorage.removeItem("tuantuan:notify"));
  }

  // Avatar states (thinking / working / done / idle) on every shape.
  if (shotsDir) {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`http://localhost:${server.port}/#/dev/avatars`);
    await page.locator(".showcase-grid").waitFor();
    for (const t of [0, 450, 900]) {
      await page.waitForTimeout(t ? 450 : 50);
      await page.locator(".showcase-grid").screenshot({ path: join(shotsDir, `avatar-states-${t}ms.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  }

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
    await dev.locator(".side-foot .dot.ok").waitFor({ timeout: 15000 });
    await dev.getByText("冒烟会话").first().waitFor();
    await dev.close();
  } finally {
    vite.kill();
  }

  await shot("final");
  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log(
    "e2e smoke: PASS (one-screen onboarding (pick, login, first agent + conversation) → harness page: bundled adapters + one-click install → ACP registry install + handshake → agents on mock ACP harness → BYOK form → onboarding once → new project (existing folder) → conversation with main agent → single-agent conversation → main agent, @, MCP handoff → DM: slash command, plan, thought, permission + diff, terminal, config option, usage, cancel → details → live updates under slow snapshot → providers: usage cards, add/test/balance, CC Switch import, agent switch → UI via Vite proxy)",
  );
} catch (e) {
  failed = true;
  if (diagPage) {
    const dir = process.env.E2E_DIAG_DIR ?? "/tmp";
    await diagPage.screenshot({ path: join(dir, "e2e-failure.png") }).catch(() => {});
    const state = await diagPage
      .evaluate(() => ({
        hash: location.hash,
        main: (document.querySelector(".main") as HTMLElement | null)?.innerText.slice(0, 600),
      }))
      .catch(() => null);
    console.error("e2e diag:", JSON.stringify(state), "\n", consoleLog.slice(-30).join("\n"));
  }
  if (shotsDir)
    await browser
      .contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: join(tmpdir(), "e2e-fail.png") })
      .catch(() => {});
  console.error("e2e smoke: FAIL", e);
} finally {
  await browser.close();
  app.host.shutdown();
  server.stop(true);
  registry.stop();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(workspaces, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  skillSrv.stop(true);
  balanceSrv.stop(true);
  rmSync(dbPath, { force: true });
  rmSync(authFile, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}
process.exit(failed ? 1 : 0);
