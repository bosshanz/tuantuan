import { join } from "node:path";
import type { Browser, Locator } from "playwright-core";
import type { Message, Store } from "../server/store";
import type { TaskContext, Timeline } from "../shared/timeline";
import type { ChatSnapshot } from "../web/src/chatState";

/** Built UI + real MCP handoff; the parent runner supplies an isolated mock-Harness database. */
export async function taskContextSmoke(browser: Browser, base: string, store: Store, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`task context fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const source = await request<{ id: string }>("POST", "/api/agents", { name: "交接发起者", harness: "mock" });
  const target = await request<{ id: string }>("POST", "/api/agents", { name: "交接接收者", harness: "mock" });
  const room = await request<{ id: string }>("POST", "/api/rooms", {
    name: "结构化交接回归",
    agentIds: [source.id, target.id],
    mainAgentId: source.id,
  });
  const task = `${"保留任务正文与约束。".repeat(620)}\n尾部约束：验收前必须检查刷新后的任务笔记。`;
  const context: TaskContext = {
    goal: '完成交接并保留 <img src="https://context.invalid/unsafe"> 全文',
    decisions: ["复用当前任务与群聊，不建立第二套状态。", `${"已确认约束；".repeat(180)}关键决策尾部`],
    pending: ["验证接收方可展开笔记。", "未完成事项尾部：刷新后仍可读。"],
  };
  const history = () => request<ChatSnapshot>("GET", `/api/rooms/${room.id}/messages`);
  const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
  const shot = async (name: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  };
  const assertNotes = async (note: Locator) => {
    if (await note.evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("task notes should start collapsed");
    const summary = note.locator("summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await note.locator(".task-context-content").waitFor();
    if (!(await note.evaluate((element) => (element as HTMLDetailsElement).open)))
      throw new Error("keyboard did not expand task notes");
    for (const label of ["任务目标", "关键决策", "未完成事项"]) await note.getByText(label, { exact: true }).waitFor();
    for (const value of [context.goal, ...context.decisions, ...context.pending]) {
      if (!(await note.textContent())?.includes(value)) throw new Error("structured task note lost full text");
    }
    if (await note.locator("img, script").count()) throw new Error("task notes rendered markup instead of safe text");
    await note.locator(".task-context-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  };
  const assertTask = async (taskRegion: Locator, expectedTask = task) => {
    if ((await taskRegion.textContent()) !== expectedTask) throw new Error("handoff task lost its full text");
    const metrics = await taskRegion.evaluate((element) => ({
      height: element.clientHeight,
      full: element.scrollHeight,
      tabIndex: (element as HTMLElement).tabIndex,
    }));
    if (metrics.height > 194 || metrics.full <= metrics.height || metrics.tabIndex !== 0)
      throw new Error(`long handoff task is not bounded and keyboard scrollable: ${JSON.stringify(metrics)}`);
    await taskRegion.evaluate((element) => {
      element.scrollTop = 0;
    });
    await taskRegion.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(
      (element) => !!element && element.scrollHeight - element.scrollTop - element.clientHeight < 2,
      await taskRegion.elementHandle(),
    );
  };
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    await page.getByRole("heading", { name: "结构化交接回归" }).waitFor();
    if (!page.url().endsWith(`/#/c/${room.id}`) || !(await page.title()).includes("Tuantuan"))
      throw new Error("task context smoke opened the wrong page");
    await page
      .getByRole("textbox", { name: "消息输入框" })
      .fill(`/handoff_context ${JSON.stringify({ agent: "交接接收者", task, context })}`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const end = Date.now() + 30_000;
    let snapshot = await history();
    while (snapshot.state.activeRunId || !snapshot.messages.some((message) => message.timeline?.handoffFrom)) {
      if (Date.now() > end) throw new Error("structured handoff did not finish");
      await page.waitForTimeout(40);
      snapshot = await history();
    }
    const sent = snapshot.messages.find((message) => message.timeline?.handoffs?.length);
    const received = snapshot.messages.find((message) => message.timeline?.handoffFrom);
    if (!sent || !received || sent.status !== "done" || received.status !== "done")
      throw new Error("structured handoff did not produce successful source and receiver replies");
    for (const handoff of [sent.timeline?.handoffs?.[0], received.timeline?.handoffFrom]) {
      if (handoff?.task !== task || JSON.stringify(handoff.context) !== JSON.stringify(context))
        throw new Error("persisted handoff did not retain the full task and structured snapshot");
    }
    for (const message of [sent, received]) {
      if (JSON.stringify(message.timeline?.taskContext) !== JSON.stringify(context))
        throw new Error("successful reply did not persist its task context");
    }
    const sentCard = row(sent.id).locator(".handoff-card");
    const receivedCard = row(received.id).locator(".handoff-from");
    for (const card of [sentCard, receivedCard]) {
      await card.waitFor();
      await assertTask(card.locator(".handoff-task"));
      await assertNotes(card.locator(".task-context"));
    }
    await assertNotes(row(received.id).locator(':scope > .msg > .task-context[data-kind="saved"]'));
    await receivedCard.locator(".task-context-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await receivedCard.scrollIntoViewIfNeeded();
    await shot("task-context-desktop");

    // Defensive rendering: old/corrupt snapshots must never label unfinished work as saved.
    const fixtures: Message[] = [];
    for (const status of ["error", "cancelled", "interrupted", "streaming"] as const) {
      const message = store.insertMessage({
        roomId: room.id,
        runId: crypto.randomUUID(),
        hop: 0,
        senderKind: "agent",
        senderId: source.id,
        senderName: "交接发起者",
        content: `未完成快照 ${status}`,
        status,
      });
      const timeline: Timeline = {
        parts: [{ kind: "text", text: message.content }],
        tools: {},
        plan: null,
        taskContext: context,
        ...(status === "error" ? { handoffFrom: { agentId: source.id, agentName: "交接发起者", task, context } } : {}),
      };
      fixtures.push(store.updateReply(message.id, { content: message.content, status, timeline }));
    }
    const multilineTask = `没有笔记的旧任务\n${Array.from({ length: 24 }, (_, index) => `约束${index + 1}`).join("\n")}`;
    const legacy = store.insertMessage({
      roomId: room.id,
      runId: crypto.randomUUID(),
      hop: 0,
      senderKind: "agent",
      senderId: source.id,
      senderName: "交接发起者",
      content: "旧交接数据兼容",
      status: "done",
    });
    store.updateReply(legacy.id, {
      content: legacy.content,
      status: "done",
      timeline: {
        parts: [{ kind: "text", text: legacy.content }],
        tools: {},
        plan: null,
        handoffs: [{ agentId: target.id, agentName: "交接接收者", task: multilineTask }],
        taskContext: { goal: "空事项展示", decisions: [], pending: [] },
      },
    });
    await page.reload();
    await page.getByRole("heading", { name: "结构化交接回归" }).waitFor();
    for (const message of fixtures) {
      await row(message.id).waitFor();
      if (await row(message.id).locator('.task-context[data-kind="saved"]').count())
        throw new Error(`${message.status} reply incorrectly displays saved task notes`);
      if (message.status === "error") await assertNotes(row(message.id).locator(".handoff-from .task-context"));
    }
    await row(legacy.id).locator(".handoff-card", { hasText: "没有笔记的旧任务" }).waitFor();
    if (await row(legacy.id).locator(".handoff-card .task-context").count())
      throw new Error("legacy handoff invented a structured snapshot");
    await row(legacy.id).locator(".task-context summary").click();
    await row(legacy.id).getByText("暂无记录", { exact: true }).waitFor();
    await row(legacy.id).getByText("无未完成事项", { exact: true }).waitFor();
    for (const card of [sentCard, receivedCard]) {
      await assertTask(card.locator(".handoff-task"));
      await assertNotes(card.locator(".task-context"));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await receivedCard.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => {
      const selectors = [".chat-main", ".messages", ".handoff-card", ".handoff-from", ".task-context-content"];
      return selectors.flatMap((selector) =>
        [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
          .map((element) => ({ selector, width: element.clientWidth, full: element.scrollWidth })),
      );
    });
    if (overflow.length) throw new Error(`task context overflows narrow viewport: ${JSON.stringify(overflow)}`);
    await assertTask(receivedCard.locator(".handoff-task"));
    await shot("task-context-narrow");
    await assertTask(row(legacy.id).locator(".handoff-task"), multilineTask);
    if (await page.locator("vite-error-overlay").count()) throw new Error("framework overlay in task context smoke");
    if (errors.length) throw new Error(`task context browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS task context: real MCP handoff, source/receiver/saved notes, long/short-multiline task keyboard scrolling, keyboard disclosure, safe text, reload, legacy/empty/unfinished snapshots, 390px layout",
    );
  } finally {
    await page.close();
    await request("DELETE", `/api/rooms/${room.id}`);
    await request("DELETE", `/api/agents/${source.id}`);
    await request("DELETE", `/api/agents/${target.id}`);
  }
}
