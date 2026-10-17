import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message, Store } from "../server/store";
import type { ChatSnapshot } from "../web/src/chatState";

/** Form question cards, the pinned conclusion card and interrupted-request retry in the built UI. */
export async function chatToolsSmoke(browser: Browser, base: string, store: Store, shotsDir?: string) {
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
    if (!response.ok) throw new Error(`chat tools fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const agent = await request<{ id: string; name: string }>("POST", "/api/agents", {
    name: "提问助手",
    harness: "mock",
  });
  const mate = await request<{ id: string; name: string }>("POST", "/api/agents", {
    name: "协作成员",
    harness: "mock",
  });
  const room = await request<{ id: string }>("POST", "/api/rooms", {
    name: "提问与结论回归",
    agentIds: [agent.id, mate.id],
    mainAgentId: agent.id,
  });
  const history = () => request<ChatSnapshot>("GET", `/api/rooms/${room.id}/messages`);
  const context = {
    goal: "发布 0.2.0 并保留提问记录",
    decisions: ["只声明表单提问", "结论卡从消息派生"],
    pending: ["真实 Harness 手测"],
  };
  const shot = async (name: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  };
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    await page.getByRole("heading", { name: "提问与结论回归" }).waitFor();
    const input = page.getByRole("textbox", { name: "消息输入框" });
    const dialog = page.locator(".palette.elicit");

    // A form question renders, validates required fields, and submits through the real API.
    await input.fill("/ask");
    await input.press("Enter");
    await dialog.waitFor();
    await dialog.getByText("请确认本次发布的方式").waitFor();
    for (const label of ["发布范围", "发布频道", "补充说明", "批次数量", "灰度比例", "确认发布", "标签"]) {
      await dialog.getByText(label, { exact: false }).first().waitFor();
    }
    await dialog.getByRole("button", { name: "提交回答" }).click();
    await dialog.getByText("此项为必填", { exact: true }).first().waitFor();
    if (await dialog.getByRole("button", { name: "提交回答" }).isDisabled())
      throw new Error("empty required fields did not keep submit available for correction");
    await dialog.getByLabel("发布范围").selectOption("canary");
    await dialog.getByLabel("补充说明").fill("确认发布");
    await dialog.getByRole("checkbox", { name: "移动端" }).check();
    await shot("elicit-form");
    await dialog.getByRole("button", { name: "提交回答" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText(/提问结果：accept/).waitFor();
    const accepted = await (async () => {
      const finish = Date.now() + 20_000;
      for (;;) {
        const snapshot = await history();
        const message = snapshot.messages.find((m) => m.content.includes('"target":"canary"'));
        if (message) return message;
        if (Date.now() > finish) throw new Error("accepted answer did not reach the Agent");
        await page.waitForTimeout(40);
      }
    })();
    if (!accepted.content.includes("提问结果：accept"))
      throw new Error("accepted answer was reported as something other than accept");

    // Closing the card sends cancel so the Harness is never left waiting.
    await input.fill("/ask");
    await input.press("Enter");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "取消提问", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("提问结果：cancel").waitFor();

    // A saved task note becomes the pinned conclusion card; clicking it flashes the source row.
    await input.fill(`/context ${JSON.stringify(context)}`);
    await input.press("Enter");
    const card = page.locator(".room-conclusion");
    await card.waitFor();
    await card.getByText("当前结论").waitFor();
    for (const value of [context.goal, ...context.decisions, ...context.pending])
      await card.getByText(value, { exact: false }).waitFor();
    const end = Date.now() + 20_000;
    let source: Message | undefined;
    while (!source) {
      if (Date.now() > end) throw new Error("saved task note did not arrive");
      const snapshot = await history();
      if (!snapshot.state.activeRunId)
        source = snapshot.messages.find((message) => message.timeline?.taskContext?.goal === context.goal);
      await page.waitForTimeout(40);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
      throw new Error("conclusion card overflows a narrow viewport");
    await shot("room-conclusion-narrow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card.getByRole("button", { name: "查看来源消息" }).click();
    await page.waitForFunction(
      (id) => document.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`)?.hasAttribute("data-flash"),
      source.id,
    );

    // An interrupted request is retried as a new, quoting request in a DM.
    const dm = await request<{ id: string }>("POST", "/api/rooms", { name: "中断重试回归", agentIds: [agent.id] });
    const original = store.insertMessage({
      roomId: dm.id,
      runId: crypto.randomUUID(),
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "Andy",
      content: "执行发布巡检",
      status: "done",
    });
    const interrupted = store.insertMessage({
      roomId: dm.id,
      runId: original.id,
      hop: 1,
      senderKind: "agent",
      senderId: agent.id,
      senderName: agent.name,
      content: "",
      status: "interrupted",
    });
    await page.goto(`${base}/#/c/${dm.id}`);
    // The SPA loaded before the DM existed, so reload to fetch the room list again.
    await page.reload();
    await page.getByRole("heading", { name: "中断重试回归" }).waitFor();
    if (await page.locator(".room-conclusion").count())
      throw new Error("a room without accepted notes showed a conclusion card");
    const row = page.locator(`.message-row[data-message-id="${interrupted.id}"]`);
    await row.getByRole("button", { name: "重试此请求" }).click();
    const retried = await (async () => {
      const finish = Date.now() + 20_000;
      for (;;) {
        const snapshot = await request<ChatSnapshot>("GET", `/api/rooms/${dm.id}/messages`);
        const human = snapshot.messages.find((message) => message.quote?.messageId === original.id);
        if (human) return { human, snapshot };
        if (Date.now() > finish) throw new Error("retry did not create a new quoting request");
        await page.waitForTimeout(40);
      }
    })();
    if (retried.human.content !== original.content || retried.human.senderKind !== "human")
      throw new Error("retry did not re-post the original request text");
    await page.getByText("执行发布巡检").last().waitFor();
    const finish = Date.now() + 20_000;
    for (;;) {
      const reply = (await request<ChatSnapshot>("GET", `/api/rooms/${dm.id}/messages`)).messages.find(
        (message) => message.runId === retried.human.id && message.senderKind === "agent",
      );
      if (reply?.status === "done") break;
      if (Date.now() > finish) throw new Error("retried request did not run to completion");
      await page.waitForTimeout(40);
    }
    if (errors.length) throw new Error(`browser console errors:\n${errors.join("\n")}`);
  } finally {
    await page.close();
  }
}
