import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message, Store } from "../server/store";
import { emptyTimeline } from "../shared/timeline";

/** Returning from a quoted source restores the reading anchor, including across a prepended history page. */
export async function quoteReturnSmoke(
  browser: Browser,
  base: string,
  store: Store,
  publish: (message: Message) => void,
  shotsDir?: string,
) {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`quote return fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const agent = await post<{ id: string; name: string }>("/api/agents", { name: "引用返回助手", harness: "mock" });
  const mate = await post<{ id: string }>("/api/agents", { name: "阅读协作者", harness: "mock" });
  const room = await post<{ id: string }>("/api/rooms", {
    name: "引用返回位置",
    agentIds: [agent.id, mate.id],
    mainAgentId: agent.id,
  });
  const other = await post<{ id: string }>("/api/rooms", { name: "引用返回另一会话", agentIds: [agent.id] });
  const human = (content: string, replyToId?: string, replyToPartIndex?: number) =>
    store.insertMessage({
      roomId: room.id,
      runId: crypto.randomUUID(),
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "Andy",
      content,
      status: "done",
      replyToId,
      replyToPartIndex,
    });
  for (let index = 0; index < 16; index++) human(`原文之前的讨论 ${index}`);
  const phases = ["先核对当前筛选条件。", "权限规则已经确认，开始实现导出。", "导出实现与针对性验证已完成。"];
  const source = store.insertMessage({
    roomId: room.id,
    runId: "quote-return-source",
    hop: 1,
    senderKind: "agent",
    senderId: agent.id,
    senderName: agent.name,
    content: phases.join("\n\n"),
    status: "done",
  });
  store.updateReply(source.id, {
    content: phases.join("\n\n"),
    status: "done",
    timeline: {
      ...emptyTimeline(),
      parts: [
        { kind: "text", text: phases[0] as string },
        { kind: "thought", text: "检查权限规则" },
        { kind: "text", text: phases[1] as string },
        { kind: "thought", text: "核对验证结果" },
        { kind: "text", text: phases[2] as string },
      ],
    },
  });
  const intermediate = human("请继续说明这一阶段。", source.id, 2);
  for (let index = 0; index < 220; index++) human(`后续讨论 ${index}`);
  const origin = human("我正在对照之前的讨论阅读。", intermediate.id);
  for (let index = 0; index < 12; index++) human(`当前阅读位置之后的记录 ${index}`);

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let releasePage = () => {};
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
    const originRow = page.locator(`[data-message-id="${origin.id}"]`);
    const originLink = originRow.locator(".message-quote-link");
    const intermediateRow = page.locator(`[data-message-id="${intermediate.id}"]`);
    const sourceRow = page.locator(`[data-message-id="${source.id}"]`);
    const goBack = page.getByRole("button", { name: "返回刚才位置", exact: true });
    const latest = page.getByRole("button", { name: "回到最新消息", exact: true });
    const settle = () =>
      page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    const readOrigin = async () => {
      await originRow.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".msg")].every((element) =>
          element.getAnimations().every((animation) => animation.playState !== "running"),
        ),
      );
      await originRow.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
      await latest.waitFor();
      await settle();
      return originRow.evaluate((element) => element.getBoundingClientRect().top);
    };
    const expectOrigin = async (top: number, label: string) => {
      try {
        await page.waitForFunction(
          ({ id, top }) => {
            const row = document.querySelector(`[data-message-id="${id}"]`);
            return row && Math.abs(row.getBoundingClientRect().top - top) < 2;
          },
          { id: origin.id, top },
          { timeout: 5000 },
        );
      } catch {
        const actualTop = await originRow.evaluate((element) => element.getBoundingClientRect().top);
        throw new Error(`${label} failed to restore the reading position: expected ${top}, got ${actualTop}`);
      }
      await goBack.waitFor({ state: "hidden" });
      if (await page.locator("[data-source-highlight]").count()) throw new Error("return left a source highlighted");
    };
    const originalTop = await readOrigin();
    await input.fill("阅读引用时保留的草稿");
    if (await sourceRow.count()) throw new Error("quote return source must begin outside the loaded history page");
    await originLink.click();
    await goBack.waitFor();
    await intermediateRow.locator("[data-message-body][data-source-highlight]").waitFor();
    // Another source visit must not replace the first reading location.
    await intermediateRow.locator(".message-quote-link").click();
    await sourceRow.locator('[data-body-phase="2"][data-source-highlight]').waitFor();
    const arrived = human("查看原文期间到达的新消息");
    publish(arrived);
    await page.locator(`[data-message-id="${arrived.id}"]`).waitFor({ state: "attached" });
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "quote-return.png") });
    await goBack.click();
    await expectOrigin(originalTop, "nested quote return after a new message");
    if ((await input.inputValue()) !== "阅读引用时保留的草稿") throw new Error("return changed the composer draft");
    if (await page.evaluate(() => document.activeElement === document.body))
      throw new Error("return lost keyboard focus when its button disappeared");
    await latest.waitFor();

    // Returning while an old page is in flight cancels its navigation intent, not the legitimate history merge.
    // Refresh now preserves reading intent; start from Latest so this case must request the old source again.
    await latest.click();
    await latest.waitFor({ state: "hidden" });
    await settle();
    await page.reload();
    const pendingTop = await readOrigin();
    if (await intermediateRow.count()) throw new Error("pending history fixture already loaded the quoted source");
    const gate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const historyPattern = `**/api/rooms/${room.id}/messages?*`;
    await page.route(historyPattern, async (route) => {
      if (new URL(route.request().url()).searchParams.has("beforeSeq")) await gate;
      await route.continue();
    });
    await originLink.click();
    await goBack.waitFor();
    await goBack.press("Enter");
    await expectOrigin(pendingTop, "return while history is loading");
    const loaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/rooms/${room.id}/messages` && url.searchParams.has("beforeSeq");
    });
    releasePage();
    await loaded;
    await intermediateRow.waitFor();
    await settle();
    await expectOrigin(pendingTop, "late history after return");
    await page.unroute(historyPattern);

    // An explicit jump to latest ends the return path; another room must never inherit it.
    await originLink.click();
    await goBack.waitFor();
    await latest.click();
    await goBack.waitFor({ state: "hidden" });
    await latest.waitFor({ state: "hidden" });
    await readOrigin();
    await originLink.click();
    await goBack.waitFor();
    await page.goto(`${base}/#/c/${other.id}`);
    await page.getByRole("heading", { name: "引用返回另一会话", exact: true }).waitFor();
    if (await goBack.count()) throw new Error("return point leaked into another room");
    await page.goto(`${base}/#/c/${room.id}`);
    await page.getByRole("heading", { name: "引用返回位置", exact: true }).waitFor();
    if (await goBack.count()) throw new Error("return point survived leaving the room");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const narrowTop = await readOrigin();
    await originLink.click();
    await intermediateRow.locator("[data-message-body][data-source-highlight]").waitFor();
    const returnBox = await goBack.boundingBox();
    const latestBox = await latest.boundingBox();
    if (
      !returnBox ||
      !latestBox ||
      returnBox.x < 0 ||
      returnBox.x + returnBox.width > 390 ||
      returnBox.y < 0 ||
      returnBox.y + returnBox.height > 844 ||
      (returnBox.x < latestBox.x + latestBox.width &&
        returnBox.x + returnBox.width > latestBox.x &&
        returnBox.y < latestBox.y + latestBox.height &&
        returnBox.y + returnBox.height > latestBox.y)
    )
      throw new Error(
        `return/latest controls overlap or leave the viewport: ${JSON.stringify({ returnBox, latestBox })}`,
      );
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "quote-return-narrow.png") });
    await goBack.press("Enter");
    await expectOrigin(narrowTop, "narrow view keyboard return");
    if (errors.length) throw new Error(`quote return browser errors:\n${errors.join("\n")}`);
    console.log(
      "PASS quote return: history prepend, nested sources, new messages, pending cancellation, focus and narrow view",
    );
  } catch (error) {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "quote-return-failure.png") });
    throw error;
  } finally {
    releasePage();
    await page.close();
  }
}
