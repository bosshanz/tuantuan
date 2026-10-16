import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import type { Message, Store } from "../server/store";
import type { RoomEvent } from "../web/src/api";

/** Built UI + real HTTP/SQLite/WS, with controlled latency and a single recoverable HTTP failure. */
export async function chatHistorySmoke(
  browser: Browser,
  base: string,
  store: Store,
  publish: (event: RoomEvent) => void,
  shotsDir?: string,
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const agent = store.createAgent({
    name: "历史助手",
    avatar: "H",
    identity: "",
    harness: "",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "ask",
  });
  const room = store.createRoom("历史分页回归", [agent.id]);
  const other = store.createRoom("迟到响应隔离", [agent.id]);
  const followRoom = store.createRoom("分页期间恢复跟随", [agent.id]);
  const insert = (roomId: string, content: string) =>
    store.insertMessage({
      roomId,
      runId: "history-fixture",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "历史作者",
      content,
      status: "done",
    });
  const originals = Array.from({ length: 451 }, (_, index) => insert(room.id, `历史记录 ${index + 1}：保留阅读位置。`));
  const otherMessage = insert(other.id, "另一会话的唯一消息");
  const followOriginals = Array.from({ length: 451 }, (_, index) => insert(followRoom.id, `跟随记录 ${index + 1}`));
  const endpoint = `${base}/api/rooms/${room.id}/messages`;
  const list = page.locator(".messages");
  const older = page.getByRole("button", { name: "加载更早消息", exact: true });
  let disconnect: () => Promise<void> = async () => {
    throw new Error("history websocket is not connected");
  };
  await page.routeWebSocket(`${base.replace("http", "ws")}/ws`, (socket) => {
    socket.connectToServer();
    disconnect = () => socket.close({ code: 1012, reason: "history reconnect regression" });
  });
  const shot = async (name: string) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  };
  const renderedIds = () =>
    list
      .locator("[data-message-id]")
      .evaluateAll((elements) => elements.map((element) => (element as HTMLElement).dataset.messageId));
  const assertIds = async (expected: Message[]) => {
    await page.waitForFunction(
      (count) => document.querySelectorAll(".messages [data-message-id]").length === count,
      expected.length,
    );
    const actual = await renderedIds();
    if (JSON.stringify(actual) !== JSON.stringify(expected.map((message) => message.id)))
      throw new Error(
        `history contains missing, duplicated or misordered messages (${actual.length}/${expected.length})`,
      );
  };
  const anchor = () =>
    list.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (row) => row.getBoundingClientRect().bottom > top,
      );
      if (!message) throw new Error("no visible history anchor");
      return {
        id: message.dataset.messageId as string,
        offset: message.getBoundingClientRect().top - top,
        top: element.scrollTop,
      };
    });
  const assertAnchor = async (before: Awaited<ReturnType<typeof anchor>>, label: string) => {
    const offset = await page
      .locator(`[data-message-id="${before.id}"]`)
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          (element.closest(".messages") as HTMLElement).getBoundingClientRect().top,
      );
    if (Math.abs(offset - before.offset) > 2)
      throw new Error(`${label} moved the reading anchor: ${before.offset} -> ${offset}`);
  };
  const top = async () => {
    await list.evaluate((element) => {
      element.scrollTop = 0;
    });
    await older.waitFor();
  };
  const holdPage = async (url = endpoint) => {
    let release = () => {};
    let started = () => {};
    let finished = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let requests = 0;
    await page.route(`${url}?*`, async (route) => {
      if (!new URL(route.request().url()).searchParams.has("beforeSeq")) return route.continue();
      requests++;
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
      finished();
    });
    return { ready, release, done, requests: () => requests };
  };
  const evidence: Record<string, unknown> = {};
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    await assertIds(originals.slice(-200));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (await list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight > 2))
      throw new Error("fresh history did not open at the latest message");
    await top();
    await shot("chat-history-initial");

    const pending = await holdPage();
    await older.click();
    await pending.ready;
    await page.getByRole("button", { name: "加载中…", exact: true }).click({ force: true });
    // The user continues reading while HTTP is pending; anchor the position at response time.
    await list.evaluate((element) => {
      element.scrollTop = 480;
    });
    const live = insert(room.id, "分页请求期间到达的新消息");
    publish({ type: "message", message: live });
    await page.locator(`[data-message-id="${live.id}"]`).waitFor({ state: "attached" });
    const beforePage = await anchor();
    pending.release();
    await pending.done;
    await assertIds([...originals.slice(51), live]);
    await assertAnchor(beforePage, "prepending 200 records after user scrolling");
    if (pending.requests() !== 1) throw new Error("history loading admitted a duplicate request");
    await page.unroute(`${endpoint}?*`);
    evidence.pendingPage = { messages: 401, anchorOffset: beforePage.offset, requests: pending.requests() };

    const reconnect = page.waitForResponse((response) => response.url() === `${endpoint}?limit=200`);
    await disconnect();
    await reconnect;
    await assertIds([...originals.slice(51), live]);
    await assertAnchor(beforePage, "reconnect snapshot");
    await top();
    const beforeFailure = await anchor();
    const buttonBefore = await older.boundingBox();
    let failedRequests = 0;
    await page.route(`${endpoint}?*`, async (route) => {
      if (!new URL(route.request().url()).searchParams.has("beforeSeq")) return route.continue();
      failedRequests++;
      await route.fulfill({ status: 503, contentType: "application/json", json: { error: "暂时无法加载历史" } });
    });
    await older.focus();
    await older.press("Enter");
    await page.getByRole("alert").filter({ hasText: "暂时无法加载历史" }).waitFor();
    await assertAnchor(beforeFailure, "failed page");
    const buttonAfter = await older.boundingBox();
    if (
      !buttonBefore ||
      !buttonAfter ||
      Math.abs(buttonBefore.y - buttonAfter.y) > 1 ||
      !(await older.evaluate((element) => element === document.activeElement))
    )
      throw new Error("a failed page moved the retry button or lost keyboard focus");
    if (failedRequests !== 1) throw new Error("failed history request was retried without the reader");
    await shot("chat-history-retry");
    await page.unroute(`${endpoint}?*`);

    const retry = page.waitForRequest((request) => request.url() === `${endpoint}?limit=200&beforeSeq=52`);
    await older.press("Enter");
    await retry;
    await assertIds([...originals, live]);
    await assertAnchor(beforeFailure, "last page and removed history control");
    await older.waitFor({ state: "hidden" });
    evidence.completed = { messages: 452, firstSeq: 1, duplicates: 0, exhausted: true, failedRequests };

    // Refresh resets the window; navigating away makes a pending page harmless.
    await page.reload();
    await assertIds([...originals, live].slice(-200));
    await top();
    const late = await holdPage();
    await older.click();
    await late.ready;
    await page.goto(`${base}/#/c/${other.id}`);
    await assertIds([otherMessage]);
    late.release();
    await late.done;
    await assertIds([otherMessage]);
    await page.unroute(`${endpoint}?*`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/c/${room.id}`);
    await assertIds([...originals, live].slice(-200));
    await top();
    await older.click();
    await assertIds([...originals.slice(52), live]);
    await top();
    await older.click();
    await assertIds([...originals, live]);
    await older.waitFor({ state: "hidden" });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("history pagination overflows the narrow viewport");
    await shot("chat-history-narrow-complete");
    evidence.refreshAndNarrow = { messages: 452, width: 390, ignoresLateRoomResponse: true };

    const missed = Array.from({ length: 251 }, (_, index) => insert(room.id, `断线期间记录 ${index + 1}`));
    const burstReconnect = page.waitForResponse((response) => response.url() === `${endpoint}?limit=200`);
    await disconnect();
    await burstReconnect;
    await assertIds([...originals, live, ...missed.slice(-200)]);
    await top();
    const gapRequest = page.waitForRequest((request) => request.url() === `${endpoint}?limit=200&beforeSeq=504`);
    await older.click();
    await gapRequest;
    await assertIds([...originals, live, ...missed]);
    await older.waitFor({ state: "hidden" });
    evidence.reconnectGap = { unseen: 251, messages: 703, fillsSkippedMiddle: true };

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#/c/${followRoom.id}`);
    await assertIds(followOriginals.slice(-200));
    await top();
    const followEndpoint = `${base}/api/rooms/${followRoom.id}/messages`;
    const followingPage = await holdPage(followEndpoint);
    await older.click();
    await followingPage.ready;
    const latest = page.getByRole("button", { name: "回到最新消息", exact: true });
    await latest.click();
    followingPage.release();
    await followingPage.done;
    await assertIds(followOriginals.slice(51));
    const atTail = () =>
      page.waitForFunction(() => {
        const element = document.querySelector(".messages");
        return !!element && element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
      });
    await atTail();
    await latest.waitFor({ state: "hidden" });
    await page.unroute(`${followEndpoint}?*`);
    await top();
    const sendingPage = await holdPage(followEndpoint);
    await older.click();
    await sendingPage.ready;
    const sent = page.waitForResponse(
      (response) => response.url() === followEndpoint && response.request().method() === "POST",
    );
    const composer = page.getByRole("textbox", { name: "消息输入框" });
    await composer.fill("分页期间发送仍跟随最新");
    await composer.press("Enter");
    await sent;
    sendingPage.release();
    await sendingPage.done;
    await page.locator(`[data-message-id="${followOriginals[0]?.id}"]`).waitFor({ state: "attached" });
    await atTail();
    await latest.waitFor({ state: "hidden" });
    await page.unroute(`${followEndpoint}?*`);
    evidence.followIntent = { returnToLatest: true, sendDuringPagination: true };
    if (errors.length) throw new Error(`history browser errors: ${errors.join("; ")}`);
    return evidence;
  } catch (error) {
    await shot("chat-history-failure").catch(() => {});
    throw error;
  } finally {
    await page.close();
    for (const id of [room.id, other.id, followRoom.id]) await fetch(`${base}/api/rooms/${id}`, { method: "DELETE" });
    await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
  }
}

if (import.meta.main) {
  const dir = mkdtempSync(join(tmpdir(), "tuantuan-history-"));
  process.env.TUANTUAN_WORKSPACES = join(dir, "workspaces");
  process.env.TUANTUAN_REGISTRY_OFFLINE = "1";
  const { serve } = await import("../server/app");
  const { app, server } = serve({ dbPath: join(dir, "history.db"), staticDir: process.env.E2E_DIST ?? "web/dist" }, 0);
  app.store.setSetting("onboarded", true);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome" });
  try {
    console.log(
      JSON.stringify(
        await chatHistorySmoke(
          browser,
          `http://localhost:${server.port}`,
          app.store,
          (event) =>
            server.publish(
              `room:${event.type === "message" ? event.message.roomId : event.roomId}`,
              JSON.stringify(event),
            ),
          process.env.SHOTS_DIR,
        ),
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    app.host.shutdown();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
