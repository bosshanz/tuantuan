import type { Browser } from "playwright-core";
import type { Message, MessageStatus, Store } from "../server/store";
import { emptyTimeline } from "../shared/timeline";

/** Seed an isolated database with requests and persisted delegation evidence. */
export async function collaborationFixture(base: string, store: Store) {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`collaboration fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const leader = await post<{ id: string; name: string }>("/api/agents", { name: "协作主理人", harness: "mock" });
  const helper = await post<{ id: string; name: string }>("/api/agents", { name: "协作助手", harness: "mock" });
  const other = await post<{ id: string; name: string }>("/api/agents", { name: "另一助手", harness: "mock" });
  const room = await post<{ id: string; agentIds: string[] }>("/api/rooms", {
    name: "协作详情回归",
    agentIds: [leader.id, helper.id, other.id],
    mainAgentId: leader.id,
  });
  const human = (runId: string, content: string, replyToId?: string) =>
    store.insertMessage({
      roomId: room.id,
      runId,
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "用户",
      content,
      status: "done",
      replyToId,
    });
  const agent = (
    runId: string,
    who: typeof leader,
    content: string,
    delegated = false,
    status: MessageStatus = "done",
  ) => {
    const message = store.insertMessage({
      roomId: room.id,
      runId,
      hop: delegated ? 2 : 1,
      senderKind: "agent",
      senderId: who.id,
      senderName: who.name,
      content,
      status,
    });
    return store.updateReply(message.id, {
      content,
      status,
      ...(status === "error" ? { error: "协作助手受控失败" } : {}),
      timeline: {
        ...emptyTimeline(),
        parts: [{ kind: "text", text: content }],
        ...(delegated ? { handoffFrom: { agentId: leader.id, agentName: leader.name, task: "核实交付" } } : {}),
      },
    });
  };
  const runA = crypto.randomUUID();
  const runB = crypto.randomUUID();
  human(runA, "整理协作结果");
  const leadIntro = agent(runA, leader, "主理人开始分工");
  const first = agent(runA, helper, "助手第一批完整原文", true);
  if (!first.timeline) throw new Error("collaboration fixture has no timeline");
  store.updateReply(first.id, {
    content: first.content,
    status: "done",
    timeline: {
      ...first.timeline,
      parts: [
        ...first.timeline.parts,
        { kind: "file", name: "协作来源.txt", mimeType: "text/plain", data: "dGVzdA==" },
      ],
    },
  });
  human(runB, "另一请求");
  const secondRun = agent(runB, other, "另一请求的助手原文", true, "interrupted");
  const second = agent(runA, other, "助手第二批完整原文", true, "error");
  const leadSummary = agent(runA, leader, "主理人最终汇总");
  const directRun = crypto.randomUUID();
  human(directRun, "@协作助手 @另一助手 请直接回复");
  const direct1 = agent(directRun, helper, "直接点名的第一条回复");
  const direct2 = agent(directRun, other, "直接点名的第二条回复");
  const allRun = crypto.randomUUID();
  human(allRun, "@所有人 请直接回复");
  const directAll = agent(allRun, other, "所有人直接回复");
  const unknownRun = crypto.randomUUID();
  human(unknownRun, "检查没有回复记录的委派");
  const source = agent(unknownRun, leader, "已交接，尚无成员回复记录");
  if (!source.timeline) throw new Error("collaboration source has no timeline");
  store.updateReply(source.id, {
    content: source.content,
    status: "done",
    timeline: {
      ...source.timeline,
      handoffs: [{ agentId: helper.id, agentName: helper.name, task: "尚未记录回复的完整任务正文" }],
    },
  });
  const stoppedRuns = (["error", "cancelled"] as const).map((status) => {
    const id = crypto.randomUUID();
    human(id, `主理人${status}后查看成果`);
    agent(id, leader, `主理人${status}`, false, status);
    return { id, message: agent(id, helper, `主理人${status}时的助手成果`, true) };
  });
  const keyRun = crypto.randomUUID();
  human(keyRun, "检查未配置密钥");
  for (const who of [helper, other]) {
    const keyFailure = agent(keyRun, who, "等待密钥后继续", true, "error");
    if (!keyFailure.timeline) throw new Error("key failure fixture has no timeline");
    store.updateReply(keyFailure.id, {
      content: keyFailure.content,
      status: "error",
      error: "MOCK_API_KEY is missing; api key required",
      timeline: keyFailure.timeline,
    });
  }
  const quote = human(crypto.randomUUID(), "请看前面的助手成果", first.id);

  const appendHistoryQuote = () => {
    for (let index = 0; index < 210; index++) human(crypto.randomUUID(), `分页填充消息 ${index}`);
    return human(crypto.randomUUID(), "翻页后查看助手成果", first.id);
  };
  return {
    room,
    runA,
    runB,
    unknownRun,
    stoppedRuns,
    keyRun,
    newLeader: other.id,
    leadIntro,
    leadSummary,
    first,
    second,
    secondRun,
    direct1,
    direct2,
    directAll,
    quote,
    appendHistoryQuote,
  };
}

/** Real browser against persisted messages; no live model or user's project data. */
export async function collaborationSmoke(browser: Browser, base: string, store: Store) {
  const {
    room,
    runA,
    runB,
    unknownRun,
    stoppedRuns,
    keyRun,
    newLeader,
    leadIntro,
    leadSummary,
    first,
    second,
    secondRun,
    direct1,
    direct2,
    directAll,
    quote,
    appendHistoryQuote,
  } = await collaborationFixture(base, store);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const row = (message: Message) => page.locator(`[data-message-id="${message.id}"]`);
  const run = (id: string) => page.locator(`details[data-collaboration-run="${id}"]`);
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    await page.getByRole("heading", { name: "协作详情回归", exact: true }).waitFor();
    await run(runA).waitFor();
    if ((await run(runA).count()) !== 1 || (await run(runB).count()) !== 1)
      throw new Error("interleaved requests did not retain one details per run");
    const chronological = await page.evaluate(
      ({ introId, runId, summaryId }) => {
        const intro = document.querySelector(`[data-message-id="${introId}"]`);
        const details = document.querySelector(`details[data-collaboration-run="${runId}"]`);
        const summary = document.querySelector(`[data-message-id="${summaryId}"]`);
        if (!intro || !details || !summary) return false;
        return (
          Boolean(intro.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          Boolean(details.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      },
      { introId: leadIntro.id, runId: runA, summaryId: leadSummary.id },
    );
    if (!chronological) throw new Error("collaboration details is not placed between leader intro and final summary");
    await run(unknownRun).locator(":scope > summary").getByText("未记录回复").waitFor();
    await run(unknownRun).locator(":scope > summary").click();
    await run(unknownRun).getByText("尚未记录回复的完整任务正文").waitFor();
    for (const stopped of stoppedRuns) {
      await run(stopped.id).locator(":scope > summary").click();
      await row(stopped.message).getByText(stopped.message.content).waitFor();
    }
    if (await run(keyRun).evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("key failure details unexpectedly expanded");
    const keyPrompt = page.locator(`.collaboration-block:has(details[data-collaboration-run="${keyRun}"]) > .need-key`);
    await keyPrompt.getByText("需要 API Key").waitFor();
    await keyPrompt.getByLabel("MOCK_API_KEY").waitFor();
    if ((await keyPrompt.count()) !== 1) throw new Error("duplicate missing-key prompts rendered for the same harness");
    if (await run(runA).evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("delegated responses were expanded by default");
    if ((await row(first).isVisible()) || (await row(second).isVisible()) || (await row(secondRun).isVisible()))
      throw new Error("delegated response visible while details is closed");
    for (const message of [direct1, direct2, directAll])
      if (!(await row(message).isVisible())) throw new Error(`direct mention is hidden: ${message.content}`);
    if ((await run(runA).locator(`[data-message-id="${second.id}"]`).count()) !== 1)
      throw new Error("later delegation batch missing from original run");
    await run(runA).locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await row(first).getByText("助手第一批完整原文").waitFor();
    await row(second).getByText("助手第二批完整原文").waitFor();
    await run(runA).locator(":scope > summary").click();
    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".messages");
      if (list) list.scrollTop = 0;
    });
    const composer = page.locator("textarea").first();
    await composer.fill("验证输入不触发旧滚动锚点");
    if ((await page.evaluate(() => document.querySelector<HTMLElement>(".messages")?.scrollTop ?? -1)) !== 0)
      throw new Error("typing after toggling collaboration details jumped the scroll position");
    await composer.fill("");
    await row(quote).locator(".message-quote-link").click();
    await row(first).locator("[data-message-body][data-source-highlight]").waitFor();
    if (!(await run(runA).evaluate((element) => (element as HTMLDetailsElement).open)))
      throw new Error("quote navigation did not expand the assistant's details");
    await page.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    await run(runA).locator(":scope > summary").click();
    await page
      .getByRole("button", { name: /需要我处理/ })
      .first()
      .click();
    const attention = page.getByRole("dialog", { name: "需要我处理", exact: true });
    await attention
      .locator(".attention-item")
      .filter({ hasText: "协作助手受控失败" })
      .filter({ hasText: "另一助手" })
      .locator(".attention-item-main")
      .click();
    await row(second).locator(".msg-error").waitFor();
    if (!(await run(runA).evaluate((element) => (element as HTMLDetailsElement).open)))
      throw new Error("attention navigation did not expand the failed assistant's details");
    const attentionSnapshot = (await fetch(`${base}/api/attention`).then((response) => response.json())) as {
      failures: { messageId: string }[];
    };
    if (!attentionSnapshot.failures.some((failure) => failure.messageId === second.id))
      throw new Error("viewing the failure incorrectly marked it handled");
    await page.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    await run(runA).locator(":scope > summary").click();
    await page.getByRole("button", { name: "搜索当前会话", exact: true }).click();
    const search = page.getByRole("dialog", { name: "搜索聊天记录", exact: true });
    await search.getByRole("combobox").fill("助手第一批完整原文");
    await search.locator(".message-search-result").click();
    await row(first).locator("[data-source-highlight]").first().waitFor();
    if (!(await run(runA).evaluate((element) => (element as HTMLDetailsElement).open)))
      throw new Error("search navigation did not expand the assistant's details");
    await page.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    await run(runA).locator(":scope > summary").click();
    await page.getByRole("button", { name: "会话文件", exact: true }).click();
    const files = page.getByRole("complementary", { name: "会话文件与改动", exact: true });
    await files
      .locator(".conversation-file-row")
      .filter({ hasText: "协作来源.txt" })
      .getByRole("button", { name: "查看来源消息", exact: true })
      .click();
    await row(first).locator("[data-source-highlight]").first().waitFor();
    if (!(await run(runA).evaluate((element) => (element as HTMLDetailsElement).open)))
      throw new Error("file source navigation did not expand the assistant's details");
    await files.getByRole("button", { name: "关闭会话文件", exact: true }).click();
    await files.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    await page.reload();
    await run(runA).waitFor();
    if ((await run(runA).count()) !== 1 || (await run(runB).count()) !== 1)
      throw new Error("reload changed run grouping");
    const changed = await fetch(`${base}/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mainAgentId: newLeader }),
    });
    if (!changed.ok) throw new Error(`changing main agent failed: ${changed.status}`);
    await page.reload();
    await run(runA).waitFor();
    if ((await run(runA).locator(`[data-message-id="${first.id}"]`).count()) !== 1 || !(await row(direct2).isVisible()))
      throw new Error("changing main agent reclassified historical replies");
    await page.evaluate((id) => localStorage.setItem(`tuantuan:compact:${id}`, "0"), room.id);
    await page.reload();
    await run(runA).locator(":scope > summary").click();
    await row(first).locator(".handoff-from").waitFor();
    if ((await run(runA).locator(".collaboration-assignment").count()) !== 0)
      throw new Error("full timeline view duplicated the handoff task inside collaboration details");
    await page.evaluate((id) => localStorage.setItem(`tuantuan:compact:${id}`, "1"), room.id);
    const originalAgents = room.agentIds;
    const shrunk = await fetch(`${base}/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [newLeader] }),
    });
    if (!shrunk.ok) throw new Error(`shrinking room failed: ${shrunk.status}`);
    await page.reload();
    await run(runA).waitFor();
    if (await row(first).isVisible()) throw new Error("shrinking room to one member unfolded historical assistants");
    const restored = await fetch(`${base}/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: originalAgents, mainAgentId: newLeader }),
    });
    if (!restored.ok) throw new Error(`restoring room members failed: ${restored.status}`);
    await page.reload();
    await run(runA).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    if (!(await run(runA).evaluate((element) => (element as HTMLDetailsElement).open))) {
      await run(runA).locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
    }
    await row(first).getByText("助手第一批完整原文").waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1))
      throw new Error("collaboration details overflows narrow viewport");
    const historyQuote = appendHistoryQuote();
    const historyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    try {
      await historyPage.goto(`${base}/#/c/${room.id}`);
      const historySource = historyPage.locator(`[data-message-id="${first.id}"]`);
      await historyPage.locator(`[data-message-id="${historyQuote.id}"] .message-quote-link`).waitFor();
      if (await historySource.count()) throw new Error("paged source was unexpectedly in the latest history window");
      await historyPage.locator(`[data-message-id="${historyQuote.id}"] .message-quote-link`).click();
      await historySource.locator("[data-source-highlight]").first().waitFor();
      const historyRun = historyPage.locator(`details[data-collaboration-run="${runA}"]`);
      if (
        (await historyRun.count()) !== 1 ||
        !(await historyRun.evaluate((element) => (element as HTMLDetailsElement).open))
      )
        throw new Error("paging to a hidden assistant source did not reconstruct and open its run");
      await historyPage.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    } finally {
      await historyPage.close();
    }
    if (errors.length) throw new Error(`collaboration browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS collaboration: interleaved runs, unknown assignment, direct mentions, attention/quote/search/file navigation, reload, history paging and narrow keyboard",
    );
  } finally {
    await page.close();
  }
}
