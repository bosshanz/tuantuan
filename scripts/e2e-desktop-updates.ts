// Built UI + real IndexedDB, HTTP/SQLite/WS and mock ACP; no real model or updater download.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { UpdateCheckpointFile } from "../desktop/src/update-checkpoint";
import { serve } from "../server/app";
import type { DesktopUpdateBridge, DesktopUpdateCheckpoint, DesktopUpdateStatus } from "../shared/desktopUpdate";

const root = mkdtempSync(join(tmpdir(), "tuantuan-update-ui-"));
process.env.TUANTUAN_MOCK_HARNESS = "1";
process.env.TUANTUAN_REGISTRY_OFFLINE = "1";
process.env.TUANTUAN_WORKSPACES = join(root, "workspaces");
process.env.MOCK_AGENT_AUTH_FILE = join(root, "auth");
writeFileSync(process.env.MOCK_AGENT_AUTH_FILE, "ok");
const { app, server } = serve({ dbPath: join(root, "test.db"), staticDir: "web/dist" }, 0);
app.store.setSetting("onboarded", true);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
let base = `http://127.0.0.1:${server.port}`;
let activeApp = app;
let restarted: ReturnType<typeof serve> | undefined;
const checkpointPath = join(root, "update-checkpoint.json");
let hostCheckpoint = new UpdateCheckpointFile(checkpointPath);
let checkpointAcks = 0;
type UpdateTest = {
  push(patch: Partial<DesktopUpdateStatus>): void;
  installs: number;
  opened: number;
  locked: boolean;
  failWrites: boolean;
  prepare(): Promise<void>;
};
type TestWindow = Window & {
  tuantuan: DesktopUpdateBridge;
  updateTest: UpdateTest;
  updateCheckpoint(
    operation: string,
    value?: DesktopUpdateCheckpoint | string,
  ): Promise<DesktopUpdateCheckpoint | null>;
};
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, reducedMotion: "reduce" });
  await context.exposeBinding(
    "updateCheckpoint",
    (_source, operation: string, value?: DesktopUpdateCheckpoint | string) => {
      if (operation === "save") {
        hostCheckpoint.save(value);
        return null;
      }
      const checkpoint = hostCheckpoint.read();
      if (operation === "clear") {
        if (checkpoint?.id !== value) throw new Error("checkpoint id mismatch");
        hostCheckpoint.clear(value);
        ++checkpointAcks;
        return null;
      }
      return checkpoint;
    },
  );
  await context.addInitScript(() => {
    const target = window as unknown as TestWindow;
    let status: DesktopUpdateStatus = {
      version: "0.2.0",
      mode: "automatic",
      phase: "ready",
      automaticChecks: true,
      availableVersion: "0.3.0",
      activity: "idle",
      activeTasks: 0,
      releaseNotes: "A safe update\n<script>window.injected = true</script>",
    };
    const listeners = new Set<(status: DesktopUpdateStatus) => void>();
    const preparations = new Set<() => Promise<void>>();
    const test: UpdateTest = {
      installs: 0,
      opened: 0,
      locked: false,
      failWrites: location.search.includes("failRestore=1"),
      push(patch) {
        status = { ...status, error: undefined, ...patch };
        for (const listener of listeners) listener(status);
      },
      async prepare() {
        test.push({ phase: "installing" });
        try {
          for (const prepare of preparations) await prepare();
          test.locked = document.querySelector<HTMLElement>(".shell")?.inert === true;
          test.push({ phase: "ready" });
        } catch (error) {
          test.push({ phase: "ready", error: (error as Error).message });
          throw error;
        }
      },
    };
    target.updateTest = test;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (test.failWrites && String(key).startsWith("room:"))
        throw new DOMException("Simulated quota exceeded", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
    target.tuantuan = {
      saveUpdateCheckpoint: async (checkpoint) => {
        await target.updateCheckpoint("save", checkpoint);
      },
      readUpdateCheckpoint: () => target.updateCheckpoint("read"),
      clearUpdateCheckpoint: async (id) => {
        await target.updateCheckpoint("clear", id);
      },
      updateStatus: async () => status,
      checkForUpdates: async () => {
        test.push({ phase: "available", checkedAt: Date.now() });
        return status;
      },
      downloadUpdate: async () => {
        test.push({ phase: "ready" });
        return status;
      },
      installUpdate: async () => {
        await test.prepare();
        ++test.installs;
        return status;
      },
      setUpdateChecks: async (automaticChecks) => {
        test.push({ automaticChecks });
        return status;
      },
      openUpdateRelease: async () => {
        ++test.opened;
      },
      onUpdateState: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      onPrepareUpdate: (callback) => {
        preparations.add(callback);
        return () => {
          preparations.delete(callback);
        };
      },
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const agent = app.store.createAgent({
    name: "更新回归助手",
    avatar: "U",
    identity: "",
    harness: "mock",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "ask",
  });
  const helper = app.store.createAgent({
    name: "第二成员",
    avatar: "H",
    identity: "",
    harness: "",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "ask",
  });
  const room = app.store.createRoom("保留工作", [agent.id, helper.id]);
  const other = app.store.createRoom("另一个房间", [agent.id]);
  const messages = Array.from({ length: 451 }, (_, index) =>
    app.store.insertMessage({
      roomId: room.id,
      runId: "update-history",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "作者",
      content: `历史消息 ${index + 1}。重启保留这段阅读位置。`,
      status: "done",
    }),
  );
  const go = async (hash: string) => {
    await page.evaluate((next) => {
      location.hash = next;
    }, hash);
  };
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const readyComposer = () =>
    page.waitForFunction(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      return input && !input.readOnly;
    });
  const about = async () => {
    await go("#/about");
    await page.getByRole("heading", { name: "关于与更新" }).waitFor();
  };
  await page.goto(`${base}/#/c/${room.id}`);
  await readyComposer();
  await input.fill("重启前保留的草稿");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "large-draft.png",
    mimeType: "image/png",
    buffer: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]),
  });
  await page.locator(".attach img").waitFor();
  await page.locator(`[data-message-id="${messages.at(-1)?.id}"]`).hover();
  await page
    .locator(`[data-message-id="${messages.at(-1)?.id}"]`)
    .getByRole("button", { name: "引用回复" })
    .click();
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length >= 400);
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length === 451);
  const anchorId = messages[8]?.id as string;
  const anchor = await page.locator(".messages").evaluate((list, id) => {
    const message = list.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!message) throw new Error("missing old message");
    list.scrollTop += message.getBoundingClientRect().top - list.getBoundingClientRect().top + 11;
    list.dispatchEvent(new Event("scroll"));
    return message.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, anchorId);
  console.log("updates UI: checking settings states");
  await about();
  assert(await page.getByText("当前版本 0.2.0", { exact: true }).isVisible(), "missing current version");
  assert(
    await page.getByText("新版本 0.3.0 可用", { exact: true }).isVisible(),
    "ready update is missing its target version",
  );
  assert((await page.locator(".update-notes").innerText()).includes("<script>"), "release notes must render as text");
  assert((await page.locator(".side-update-dot").count()) === 1, "background update must be discoverable");
  await page.evaluate(() => (window as unknown as TestWindow).updateTest.push({ activity: "busy", activeTasks: 2 }));
  assert(await page.getByRole("button", { name: "重启更新", exact: true }).isDisabled(), "busy Agent allowed install");
  await page.getByText("仍有 2 项 Agent 任务，结束后才能重启更新。", { exact: true }).waitFor();
  await page.evaluate(() => (window as unknown as TestWindow).updateTest.push({ activity: "unknown" }));
  assert(
    await page.getByRole("button", { name: "重启更新", exact: true }).isDisabled(),
    "unknown activity allowed install",
  );
  await page.evaluate(() =>
    (window as unknown as TestWindow).updateTest.push({ phase: "available", activity: "busy" }),
  );
  await page.getByRole("button", { name: "下载更新", exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as TestWindow).updateTest.push({ phase: "downloading", progress: 47.8 }),
  );
  assert(
    (await page.getByRole("progressbar", { name: "下载进度" }).getAttribute("value")) === "48",
    "download progress is inaccurate",
  );
  await page.evaluate(() => (window as unknown as TestWindow).updateTest.push({ phase: "ready", activity: "idle" }));
  await go(`#/c/${other.id}`);
  await readyComposer();
  assert((await input.inputValue()) === "", "room drafts are mixed");
  await input.fill("另一房间的草稿");
  await go(`#/c/${room.id}`);
  await readyComposer();
  const assertDraftAndReading = async () => {
    assert((await input.inputValue()) === "重启前保留的草稿", "draft text was lost");
    assert((await page.locator(".attach img").count()) === 1, "large image was lost");
    assert((await page.locator(".composer-quote").count()) === 1, "quote was lost");
    await page.waitForFunction((id) => !!document.querySelector(`[data-message-id="${id}"]`), anchorId);
    await page.waitForFunction(
      ({ id, offset }) => {
        const message = document.querySelector(`[data-message-id="${id}"]`);
        const list = document.querySelector(".messages");
        return (
          message &&
          list &&
          Math.abs(message.getBoundingClientRect().top - list.getBoundingClientRect().top - offset) < 2
        );
      },
      { id: anchorId, offset: anchor },
    );
  };
  await assertDraftAndReading();
  console.log("updates UI: checking checkpoint and restart");
  await page.evaluate(() => (window as unknown as TestWindow).updateTest.prepare());
  assert(
    await page.evaluate(() => (window as unknown as TestWindow).updateTest.locked),
    "checkpoint did not lock editing",
  );
  const oldOrigin = base;
  restarted = serve({ dbPath: join(root, "test.db"), staticDir: "web/dist" }, 0);
  base = `http://127.0.0.1:${restarted.server.port}`;
  activeApp = restarted.app;
  hostCheckpoint = new UpdateCheckpointFile(checkpointPath);
  assert(base !== oldOrigin, "restart must use a different origin");
  await page.goto(`${base}/?failRestore=1`);
  await page.getByText("无法恢复更新前的工作：", { exact: false }).waitFor();
  assert(existsSync(checkpointPath), "failed import consumed the durable checkpoint");
  assert(
    (await page.locator(".composer textarea").count()) === 0,
    "failed import allowed an empty composer to overwrite drafts",
  );
  await page.goto(base);
  await page.waitForURL(`**/#/c/${room.id}`);
  await readyComposer();
  await assertDraftAndReading();
  assert(!existsSync(checkpointPath) && checkpointAcks === 1, "restored checkpoint was not acknowledged after import");
  await page.evaluate(() => {
    (window as unknown as TestWindow).updateTest.failWrites = true;
  });
  await input.fill("写入失败也不能丢失");
  await about();
  await page.getByRole("button", { name: "重启更新", exact: true }).click();
  await page.getByText("保存工作失败，未重启更新。请重试。", { exact: false }).first().waitFor();
  assert(
    (await page.evaluate(() => (window as unknown as TestWindow).updateTest.installs)) === 0,
    "failed storage reported install success",
  );
  assert(await page.locator(".workspace-save-error").isVisible(), "storage failure was hidden");
  assert(
    await page.locator(".shell").evaluate((shell) => !(shell as HTMLElement).inert),
    "failed checkpoint left editing locked",
  );
  await page.evaluate(() => {
    (window as unknown as TestWindow).updateTest.failWrites = false;
  });
  await page.locator(".workspace-save-error").getByRole("button", { name: "重试" }).click();
  await page.locator(".workspace-save-error").waitFor({ state: "detached" });
  for (const reason of ["unsigned-mac", "missing-feed", "homebrew"] as const) {
    await page.evaluate(
      (reason) => (window as unknown as TestWindow).updateTest.push({ mode: "manual", reason, phase: "available" }),
      reason,
    );
    await page.getByRole("button", { name: "打开下载页面", exact: true }).waitFor();
    assert(
      (await page.getByRole("button", { name: "重启更新", exact: true }).count()) === 0,
      `${reason} showed automatic install`,
    );
    if (reason === "homebrew")
      assert(
        await page.getByText("brew upgrade --cask tuantuan", { exact: true }).isVisible(),
        "missing brew upgrade command",
      );
  }
  await page.getByRole("button", { name: "打开下载页面", exact: true }).click();
  assert(
    (await page.evaluate(() => (window as unknown as TestWindow).updateTest.opened)) === 1,
    "manual release action did not reach bridge",
  );
  await page.evaluate(() =>
    (window as unknown as TestWindow).updateTest.push({ mode: "disabled", reason: "development", phase: "idle" }),
  );
  await page.getByText("开发版不提供应用更新。", { exact: true }).waitFor();
  assert(
    (await page.getByRole("button", { name: "检查更新", exact: true }).count()) === 0,
    "development build offered updates",
  );
  await page.evaluate(() =>
    (window as unknown as TestWindow).updateTest.push({
      mode: "automatic",
      phase: "ready",
      activity: "busy",
      activeTasks: 1,
    }),
  );
  await go(`#/c/${other.id}`);
  await readyComposer();
  console.log("updates UI: checking pending ACP question");
  await page.request.post(`${base}/api/rooms/${other.id}/messages`, { data: { senderName: "用户", content: "/ask" } });
  await page.locator(".elicit-summary").click();
  await page.getByLabel("补充说明").fill("确认之后保留回答");
  const ask = activeApp.host.pendingElicitations(other.id)[0];
  assert(ask, "missing pending mock elicitation");
  await about();
  await page.waitForTimeout(100);
  assert(
    activeApp.host.pendingElicitations(other.id).some((pending) => pending.id === ask?.id),
    "visiting updates cancelled the Agent question",
  );
  assert(
    await page.getByRole("button", { name: "重启更新", exact: true }).isDisabled(),
    "pending question allowed install",
  );
  await go(`#/c/${other.id}`);
  await page.locator(".elicit-summary").click();
  assert(
    (await page.getByLabel("补充说明").inputValue()) === "确认之后保留回答",
    "partly filled question was lost on navigation",
  );
  await page.getByRole("button", { name: "取消提问", exact: true }).click();
  const web = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await web.goto(`${base}/#/about`);
  await web.getByText("应用更新仅桌面版支持。浏览器使用当前服务提供的版本。", { exact: true }).waitFor();
  assert(
    (await web.getByRole("button", { name: "重启更新", exact: true }).count()) === 0,
    "browser offered desktop install",
  );
  assert(await web.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile about page overflowed");
  if (process.env.SHOTS_DIR) await web.screenshot({ path: join(process.env.SHOTS_DIR, "updates-browser-mobile.png") });
  await about();
  await page.evaluate(() =>
    (window as unknown as TestWindow).updateTest.push({ phase: "ready", activity: "idle", activeTasks: 0 }),
  );
  await page.waitForFunction(() => document.getElementById("update-install-help")?.classList.contains("muted"));
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, "updates-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "mobile desktop update page overflowed",
  );
  assert(
    await page.getByRole("button", { name: "重启更新", exact: true }).isVisible(),
    "mobile restart action is hidden",
  );
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, "updates-desktop-mobile.png") });
  assert(!errors.length, `page errors: ${errors.join("; ")}`);
  console.log(
    "desktop update UI: PASS (safe notes, status/actions, busy/unknown guards, manual/browser/development modes, room drafts + 5MB image + quote + paged reading restore, checkpoint lock/failure/retry/route restart across different origins, failed import retains host checkpoint until ack, pending ACP question + typed form survives navigation)",
  );
} finally {
  await browser.close();
  app.host.shutdown();
  await app.projectTerminals.shutdown();
  server.stop(true);
  app.store.db.close();
  if (restarted) {
    restarted.app.host.shutdown();
    await restarted.app.projectTerminals.shutdown();
    restarted.server.stop(true);
    restarted.app.store.db.close();
  }
  rmSync(root, { recursive: true, force: true });
}
