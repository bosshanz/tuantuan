import { join } from "node:path";
import type { Browser, Locator } from "playwright-core";
import type { Message } from "../server/store";
import type { ChatSnapshot } from "../web/src/chatState";

/** Built React UI + real HTTP persistence; callers provide an idle mock-Harness group. */
export async function repliesSmoke(browser: Browser, base: string, roomId: string, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  let temporaryRoomId: string | undefined;
  page.on("pageerror", (error) => errors.push(error.message));
  const endpoint = `${base}/api/rooms/${roomId}/messages`;
  const history = async () => (await (await fetch(endpoint)).json()) as ChatSnapshot;
  const waitIdle = async () => {
    const end = Date.now() + 20_000;
    while ((await history()).state.activeRunId) {
      if (Date.now() > end) throw new Error("quote smoke group did not become idle");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  try {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ senderName: "引用作者", content: "引用原文：保留 @没有这个成员 与上下文" }),
    });
    if (!result.ok) throw new Error(`quote fixture POST failed: ${result.status}`);
    const source = (await result.json()) as Message;
    await waitIdle();
    const agent = (await history()).messages.find(
      (m) => m.runId === source.id && m.senderKind === "agent" && m.status === "done",
    );
    if (!agent) throw new Error("quote fixture has no completed Agent reply");
    const layoutMessages: Message[] = [];
    for (const content of ["hi", "最长一行正文".repeat(60)]) {
      const fixture = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderName: "布局回归", content }),
      });
      if (!fixture.ok) throw new Error(`message layout fixture failed: ${fixture.status}`);
      layoutMessages.push((await fixture.json()) as Message);
      await waitIdle();
    }
    const emptyResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "",
        images: [
          {
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEAAAAABJRU5ErkJggg==",
          },
        ],
      }),
    });
    if (!emptyResponse.ok) throw new Error(`empty-body image fixture failed: ${emptyResponse.status}`);
    const emptyMessage = (await emptyResponse.json()) as Message;
    await waitIdle();
    // Deterministic completion capabilities; message persistence and sends still use the real server.
    const withCompletions = (session: ChatSnapshot["sessions"][string]) => {
      session.commands.push({ name: "quote-regression-command", description: "completion lock fixture" });
      session.skills.push({ name: "quote-regression-skill", description: "completion lock fixture" });
    };
    await page.routeWebSocket(`${base.replace("http", "ws")}/ws`, (socket) => {
      const backend = socket.connectToServer();
      backend.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (event.type === "session") withCompletions(event.view);
        socket.send(JSON.stringify(event));
      });
    });
    await page.route(`${endpoint}?*`, async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as ChatSnapshot;
      for (const session of Object.values(snapshot.sessions)) {
        withCompletions(session);
      }
      await route.fulfill({ response, json: snapshot });
    });
    // Member warm-up also dispatches an HTTP SessionView. It may arrive after the snapshot/WS
    // fixtures, so all three sources must advertise the same deterministic completions.
    await page.route(`${base}/api/rooms/${roomId}/agents/*/session`, async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const session = (await response.json()) as ChatSnapshot["sessions"][string];
      withCompletions(session);
      await route.fulfill({ response, json: session });
    });
    await page.goto(`${base}/#/c/${roomId}`);
    const input = page.getByRole("textbox", { name: "消息输入框" });
    const sourceBubble = page.locator(`[data-message-id="${source.id}"]`);
    const agentBubble = page.locator(`[data-message-id="${agent.id}"]`);
    const menu = page.getByRole("dialog", { name: "消息操作", exact: true });
    const openMore = async (row: Locator) => {
      await row.getByRole("button", { name: "更多消息操作", exact: true }).focus();
      await page.keyboard.press("Enter");
      await menu.waitFor();
    };
    // Toolbar hit targets must be outside the text, with a continuous hover bridge and no reflow.
    for (const message of [source, agent, ...layoutMessages]) {
      const row = page.locator(`[data-message-id="${message.id}"]`);
      await row.scrollIntoViewIfNeeded();
      await input.focus();
      await page.mouse.move(2, 2);
      await page.waitForFunction((id) => {
        const actions = document.querySelector(`[data-message-id="${id}"] .message-actions`);
        return actions && getComputedStyle(actions).opacity === "0";
      }, message.id);
      const bubble = row.locator(".msg");
      await bubble.scrollIntoViewIfNeeded();
      await bubble.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
      const before = await bubble.boundingBox();
      if (!before) throw new Error("message bubble not laid out");
      await bubble.hover();
      const bar = await row.locator(".message-actions").boundingBox();
      const after = await bubble.boundingBox();
      const bounds = await page.locator(".messages").boundingBox();
      if (!bar || !after || !bounds || JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(`message toolbar changed bubble layout on hover: ${JSON.stringify({ before, after })}`);
      if (
        bar.x < bounds.x ||
        bar.x + bar.width > bounds.x + bounds.width ||
        (message.senderKind === "human" ? bar.x + bar.width > before.x : bar.x < before.x + before.width)
      )
        throw new Error(`message toolbar overlaps text or is clipped: ${message.content.slice(0, 20)}`);
      const edge = message.senderKind === "human" ? before.x + 1 : before.x + before.width - 1;
      const target = message.senderKind === "human" ? bar.x + bar.width - 4 : bar.x + 4;
      await page.mouse.move(edge, bar.y + bar.height / 2);
      await page.mouse.move(target, bar.y + bar.height / 2, { steps: 16 });
      if ((await row.locator(".message-actions").evaluate((el) => getComputedStyle(el).pointerEvents)) !== "auto")
        throw new Error("message hover bridge dropped the toolbar before the pointer reached it");
      await row.getByRole("button", { name: "更多消息操作", exact: true }).click();
      await menu.waitFor();
      await page.mouse.move(2, 2);
      if ((await row.locator(".message-actions").evaluate((el) => getComputedStyle(el).pointerEvents)) !== "auto")
        throw new Error("open message menu lost its toolbar");
      await page.keyboard.press("Escape");
      if (
        !(await row
          .getByRole("button", { name: "更多消息操作", exact: true })
          .evaluate((el) => el === document.activeElement))
      )
        throw new Error("Escape did not return focus to message actions");
    }
    await agentBubble.hover();
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "message-actions-desktop.png"), animations: "disabled" });
    await openMore(agentBubble);
    const copyContent = menu.getByRole("button", { name: "复制内容", exact: true });
    const copyId = menu.getByRole("button", { name: "复制消息 ID", exact: true });
    await copyContent.click();
    await menu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
    if ((await page.evaluate(() => navigator.clipboard.readText())) !== agent.content)
      throw new Error("copy content included rendered context or omitted stored body text");
    await copyId.click();
    await menu.getByRole("status").filter({ hasText: "已复制消息 ID" }).waitFor();
    if ((await page.evaluate(() => navigator.clipboard.readText())) !== agent.id)
      throw new Error("copy message ID did not use the actual stored ID");
    await page.keyboard.press("Home");
    if (!(await copyContent.evaluate((el) => el === document.activeElement)))
      throw new Error("menu Home navigation failed");
    await page.keyboard.press("End");
    if (
      !(await menu
        .getByRole("button", { name: "查看详情", exact: true })
        .evaluate((el) => el === document.activeElement))
    )
      throw new Error("menu End navigation failed");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "回复详情", exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click();
    // Native clipboard success above; controllable rejection/delay below checks truthful feedback and retry.
    await page.evaluate(() => {
      const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      const state = { mode: "allow", calls: 0, release: () => {} };
      Object.assign(window, { clipboardFixture: state });
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (text: string) => {
          state.calls++;
          if (state.mode === "fail") throw new Error("测试复制被拒绝");
          if (state.mode === "hold")
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
          await nativeWrite(text);
        },
      });
    });
    await openMore(agentBubble);
    await page.evaluate(() => {
      (window as unknown as { clipboardFixture: { mode: string } }).clipboardFixture.mode = "fail";
    });
    await copyContent.click();
    await menu.getByRole("alert").filter({ hasText: "测试复制被拒绝" }).waitFor();
    if (await menu.getByRole("status").filter({ hasText: "已复制" }).count())
      throw new Error("failed clipboard reported success");
    await page.evaluate(() => {
      (window as unknown as { clipboardFixture: { mode: string } }).clipboardFixture.mode = "allow";
    });
    await copyContent.click();
    await menu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
    const callsBefore = await page.evaluate(() => {
      const state = (window as unknown as { clipboardFixture: { mode: string; calls: number } }).clipboardFixture;
      state.mode = "hold";
      return state.calls;
    });
    await copyContent.click();
    await menu.getByRole("status").filter({ hasText: "正在复制" }).waitFor();
    await copyContent.press("Enter");
    if (
      (await page.evaluate(
        () => (window as unknown as { clipboardFixture: { calls: number } }).clipboardFixture.calls,
      )) !==
      callsBefore + 1
    )
      throw new Error("pending clipboard operation duplicated");
    await page.evaluate(() => {
      (window as unknown as { clipboardFixture: { release: () => void } }).clipboardFixture.release();
    });
    await menu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
    await input.click();
    await menu.waitFor({ state: "hidden" });
    if (!(await input.evaluate((el) => el === document.activeElement)))
      throw new Error("outside dismissal stole focus");
    await openMore(page.locator(`[data-message-id="${emptyMessage.id}"]`));
    if (
      !(await copyContent.isDisabled()) ||
      (await copyId.isDisabled()) ||
      (await menu.getByRole("button", { name: "查看详情", exact: true }).count())
    )
      throw new Error("empty human content must disable body copying but keep its real ID available");
    await page.keyboard.press("Escape");
    await sourceBubble.hover();
    await sourceBubble.getByRole("button", { name: "引用回复", exact: true }).click();
    const composerQuote = page.getByTestId("composer-quote");
    await composerQuote.getByText("引用作者", { exact: true }).waitFor();
    if ((await input.inputValue()) !== "") throw new Error("quoting inserted text or mentions into the draft");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await composerQuote.waitFor({ state: "hidden" });
    await agentBubble.getByRole("button", { name: "引用回复", exact: true }).focus();
    await page.keyboard.press("Enter");
    await composerQuote.getByText(agent.senderName, { exact: true }).waitFor();
    if (!(await input.evaluate((el) => el === document.activeElement)))
      throw new Error("quote action did not focus composer");
    // Reproduce the review case: click Send while each completion popup is open, then hold the POST.
    for (const [value, listName] of [
      ["@", "选择要 @ 的 Agent"],
      ["/quote-regression", "命令"],
      ["$quote-regression", "Skills"],
    ] as const) {
      await input.fill(value);
      await page.getByRole("listbox", { name: listName, exact: true }).waitFor();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requests = 0;
      await page.route(endpoint, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        requests++;
        await gate;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "completion lock fixture" }),
        });
      });
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.readOnly,
      );
      if (await page.getByRole("listbox").count()) throw new Error(`${listName} remained interactive during POST`);
      if (
        !(await page
          .getByRole("button", { name: "引用回复", exact: true })
          .evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled)))
      )
        throw new Error("pending send left quote actions enabled");
      await input.focus();
      await page.keyboard.type("must not modify");
      await page.keyboard.press("Enter");
      if ((await input.inputValue()) !== value) throw new Error(`${listName} rewrote the pending draft`);
      release();
      await page.getByRole("alert").filter({ hasText: "completion lock fixture" }).waitFor();
      if (requests !== 1 || (await input.inputValue()) !== value)
        throw new Error("completion send duplicated or lost draft");
      await page.unroute(endpoint);
    }
    const draft = "  请根据引用继续，不添加点名  ";
    await input.fill(draft);
    let attempts = 0;
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "引用发送暂时失败" }),
      });
    });
    await input.press("Enter");
    await page.keyboard.press("Enter");
    await page.getByRole("alert").filter({ hasText: "引用发送暂时失败" }).waitFor();
    if (attempts !== 1 || (await input.inputValue()) !== draft)
      throw new Error("failed quoted send lost draft or duplicated POST");
    await composerQuote.getByText(agent.senderName, { exact: true }).waitFor();
    await page.keyboard.type("失败后继续输入");
    if ((await input.inputValue()) !== `${draft}失败后继续输入`) throw new Error("failed send lost composer focus");
    for (const _ of "失败后继续输入") await page.keyboard.press("Backspace");
    await page.unroute(endpoint);
    await input.press("Enter");
    await composerQuote.waitFor({ state: "hidden" });
    await waitIdle();
    const sent = (await history()).messages.find((m) => m.senderKind === "human" && m.content === draft.trim());
    if (!sent || sent.quote?.messageId !== agent.id) throw new Error("quoted reply was not persisted");
    const sentBubble = page.locator(`[data-message-id="${sent.id}"]`);
    await sentBubble.getByRole("blockquote").waitFor();
    if ((await input.inputValue()) !== "") throw new Error("successful send did not clear the draft");
    await page.keyboard.type("成功后继续输入");
    if ((await input.inputValue()) !== "成功后继续输入") throw new Error("successful send lost composer focus");
    await page.reload();
    await page.locator(`[data-message-id="${sent.id}"] .message-quote`).waitFor();
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "group-replies.png"), animations: "disabled" });
    await openMore(sentBubble);
    await copyContent.click();
    await menu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
    if ((await page.evaluate(() => navigator.clipboard.readText())) !== sent.content)
      throw new Error("copying a quoted message included its quoted context");
    await page.keyboard.press("Escape");
    // Streamed replies expose inspection/copy, but cannot become a quote until completed.
    const slowResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/slow" }),
    });
    if (!slowResponse.ok) throw new Error(`streaming fixture failed: ${slowResponse.status}`);
    const slowSource = (await slowResponse.json()) as Message;
    let slow: Message | undefined;
    let taskId: string | undefined;
    const streamDeadline = Date.now() + 10_000;
    while (!slow || !taskId) {
      const snapshot = await history();
      slow = snapshot.messages.find((message) => message.runId === slowSource.id && message.status === "streaming");
      taskId = snapshot.state.tasks.find((task) => task.runId === slowSource.id)?.id;
      if (Date.now() > streamDeadline) throw new Error("streaming fixture was never active");
      if (!slow || !taskId) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const slowRow = page.locator(`[data-message-id="${slow.id}"]`);
    await slowRow.waitFor();
    if (await slowRow.getByRole("button", { name: "引用回复", exact: true }).count())
      throw new Error("streaming message incorrectly offered quoting");
    await openMore(slowRow);
    await menu.getByRole("button", { name: "查看详情", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    const cancelled = await fetch(`${base}/api/rooms/${roomId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    if (!cancelled.ok) throw new Error(`streaming fixture cancellation failed: ${cancelled.status}`);
    await waitIdle();
    // DM actions retain copy/details without introducing the group-only reply affordance.
    const dmResponse = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "消息操作私聊回归", agentIds: [agent.senderId] }),
    });
    if (!dmResponse.ok) throw new Error(`DM fixture failed: ${dmResponse.status}`);
    temporaryRoomId = ((await dmResponse.json()) as { id: string }).id;
    const dmEndpoint = `${base}/api/rooms/${temporaryRoomId}/messages`;
    const dmSend = await fetch(dmEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "私聊正文" }),
    });
    if (!dmSend.ok) throw new Error(`DM message failed: ${dmSend.status}`);
    const dmHuman = (await dmSend.json()) as Message;
    await page.goto(`${base}/#/c/${temporaryRoomId}`);
    await page.reload(); // This room was created outside the UI; refresh its room-list snapshot too.
    await page.locator(`[data-message-id="${dmHuman.id}"]`).waitFor();
    const dmAgent = page.locator('.message-row[data-sender="agent"]');
    await dmAgent.locator('.msg[data-status="done"]').waitFor();
    if (await page.getByRole("button", { name: "引用回复", exact: true }).count())
      throw new Error("DM incorrectly offered group quoting");
    await openMore(dmAgent);
    await menu.getByRole("button", { name: "复制内容", exact: true }).waitFor();
    await menu.getByRole("button", { name: "查看详情", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.goto(`${base}/#/c/${roomId}`);
    await page.emulateMedia({ colorScheme: "dark" });
    await openMore(agentBubble);
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "message-actions-dark.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await sourceBubble.getByRole("button", { name: "引用回复", exact: true }).click();
    await composerQuote.waitFor();
    for (const message of layoutMessages) {
      const row = page.locator(`[data-message-id="${message.id}"]`);
      const bubble = await row.locator(".msg").boundingBox();
      const bar = await row.locator(".message-actions").boundingBox();
      if (
        !bubble ||
        !bar ||
        bar.y < bubble.y + bubble.height ||
        Math.abs(bubble.x + bubble.width - (bar.x + bar.width)) > 1
      )
        throw new Error("narrow human actions did not stay below/right aligned to their bubble");
    }
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await touch.goto(`${base}/#/c/${roomId}`);
    const touchSource = touch.locator(`[data-message-id="${source.id}"]`);
    await touchSource.getByRole("button", { name: "更多消息操作", exact: true }).tap();
    const touchMenu = touch.getByRole("dialog", { name: "消息操作", exact: true });
    await touchMenu.waitFor();
    const menuBounds = await touchMenu.boundingBox();
    if (!menuBounds || menuBounds.x < 0 || menuBounds.x + menuBounds.width > 390)
      throw new Error("touch action menu escaped the viewport");
    await touch.getByRole("textbox", { name: "消息输入框" }).tap();
    await touchMenu.waitFor({ state: "hidden" });
    await touchSource.getByRole("button", { name: "引用回复", exact: true }).tap();
    await touch.getByTestId("composer-quote").waitFor();
    if (shotsDir) await touch.screenshot({ path: join(shotsDir, "message-actions-touch.png"), animations: "disabled" });
    await touch.setViewportSize({ width: 1000, height: 844 });
    await touch.getByRole("textbox", { name: "消息输入框" }).focus();
    if ((await touchSource.locator(".message-actions").evaluate((el) => getComputedStyle(el).opacity)) !== "1")
      throw new Error("no-hover tablet hid message actions");
    await touch.close();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("quoted reply overflows narrow viewport");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "group-replies-narrow.png"), animations: "disabled" });
    if (errors.length) throw new Error(`quote browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS message actions/replies: hover bridge/no reflow, clipboard success/failure/retry/pending, keyboard/details/touch, quoted-send retention/persistence, dark/narrow layout",
    );
  } finally {
    if (temporaryRoomId) await fetch(`${base}/api/rooms/${temporaryRoomId}`, { method: "DELETE" });
    await page.close();
  }
}
