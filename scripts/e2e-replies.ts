import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message } from "../server/store";
import type { ChatSnapshot } from "../web/src/chatState";

/** Built React UI + real HTTP persistence; callers provide an idle mock-Harness group. */
export async function repliesSmoke(browser: Browser, base: string, roomId: string, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const endpoint = `${base}/api/rooms/${roomId}/messages`;
  const history = async () =>
    (await (await fetch(endpoint)).json()) as { messages: Message[]; state: { activeRunId: string | null } };
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
    await page.goto(`${base}/#/c/${roomId}`);
    const input = page.getByRole("textbox", { name: "消息输入框" });
    const sourceBubble = page.locator(`[data-message-id="${source.id}"]`);
    const agentBubble = page.locator(`[data-message-id="${agent.id}"]`);
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
    await page.setViewportSize({ width: 390, height: 844 });
    await sourceBubble.getByRole("button", { name: "引用回复", exact: true }).tap();
    await composerQuote.waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("quoted reply overflows narrow viewport");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "group-replies-narrow.png"), animations: "disabled" });
    if (errors.length) throw new Error(`quote browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS quoted replies: human/Agent actions, keyboard/touch, cancel, failed-send retention, persistence/reload, narrow layout",
    );
  } finally {
    await page.close();
  }
}
