import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message, Store } from "../server/store";
import type { AttentionSnapshot } from "../shared/attention";
import type { ChatSnapshot } from "../web/src/chatState";

/** Built UI + HTTP/SQLite/WS and real mock-ACP permission/question lifecycle. No paid models. */
export async function v025Smoke(
  browser: Browser,
  base: string,
  store: Store,
  publish: (message: Message) => void,
  shotsDir?: string,
) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  const roomIds: string[] = [];
  const agentIds: string[] = [];
  const historyRequests = new Map<string, number>();
  const evidence: Record<string, unknown> = {};
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    const roomId = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/)?.[1];
    if (roomId && url.searchParams.has("beforeSeq"))
      historyRequests.set(roomId, (historyRequests.get(roomId) ?? 0) + 1);
  });
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`v0.2.5 fixture ${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const agent = async (name: string, env: Record<string, string> = {}) => {
    const created = await request<{ id: string; name: string }>("POST", "/api/agents", {
      name,
      harness: "mock",
      env,
      permissionPolicy: "ask",
    });
    agentIds.push(created.id);
    return created;
  };
  const room = async (name: string, agentId: string) => {
    const created = await request<{ id: string; name: string }>("POST", "/api/rooms", { name, agentIds: [agentId] });
    roomIds.push(created.id);
    return created;
  };
  const insert = (roomId: string, content: string) =>
    store.insertMessage({
      roomId,
      content,
      runId: "v025-history",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "阅读者",
      status: "done",
    });
  const snapshot = (roomId: string) => request<ChatSnapshot>("GET", `/api/rooms/${roomId}/messages`);
  const attention = () => request<AttentionSnapshot>("GET", "/api/attention");
  const waitSnapshot = async (roomId: string, check: (snapshot: ChatSnapshot) => boolean, label: string) => {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await snapshot(roomId);
      if (check(value)) return value;
      if (Date.now() > end) throw new Error(`v0.2.5 ${label}: ${JSON.stringify(value).slice(0, 600)}`);
      await page.waitForTimeout(40);
    }
  };
  const waitAttention = async (check: (snapshot: AttentionSnapshot) => boolean, label: string) => {
    const end = Date.now() + 10_000;
    for (;;) {
      const value = await attention();
      if (check(value)) return value;
      if (Date.now() > end) throw new Error(`v0.2.5 ${label}: ${JSON.stringify(value).slice(0, 600)}`);
      await page.waitForTimeout(40);
    }
  };
  const shot = async (name: string) => {
    if (!shotsDir) return;
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  };
  const searchDialog = page.getByRole("dialog", { name: "搜索聊天记录", exact: true });
  const searchInput = searchDialog.getByRole("combobox");
  const attentionDialog = page.getByRole("dialog", { name: "需要我处理", exact: true });
  const attentionEntry = page.getByRole("button", { name: /需要我处理/ }).first();
  const attentionItem = (name: string) => attentionDialog.locator(".attention-item").filter({ hasText: name });
  const openAttention = async () => {
    await attentionEntry.click();
    await attentionDialog.waitFor();
  };
  const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
  const highlighted = (id: string) => row(id).locator("[data-source-highlight]");
  const settle = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  const shortcut = process.platform === "darwin" ? "Meta" : "Control";
  const back = page.getByRole("button", { name: "返回刚才位置", exact: true });
  const assertOrigin = async (id: string, top: number, label: string) => {
    await page
      .waitForFunction(
        ({ id, top }) => {
          const element = document.querySelector(`[data-message-id="${id}"]`);
          return !!element && Math.abs(element.getBoundingClientRect().top - top) < 2;
        },
        { id, top },
        { timeout: 5000 },
      )
      .catch(async () => {
        const actual = await row(id).evaluate((element) => element.getBoundingClientRect().top);
        throw new Error(`v0.2.5 ${label} changed the reading position: ${top} -> ${actual}`);
      });
    await back.waitFor({ state: "hidden" });
  };

  try {
    const worker = await agent("v025搜索与请求助手");
    const failedWorker = await agent("v025失败助手", {
      MOCK_AGENT_SESSION_ERROR: "v025 temporary Harness session failure",
    });
    const historyRoom = await room("v025 当前搜索会话", worker.id);
    const crossRoom = await room("v025 跨房间搜索会话", worker.id);
    const failedRoom = await room("v025 失败原消息会话", failedWorker.id);
    const permissionRoom = await room("v025 等待批准会话", worker.id);
    const questionRoom = await room("v025 等待回答会话", worker.id);
    const originals = Array.from({ length: 461 }, (_, index) =>
      insert(
        historyRoom.id,
        index === 0
          ? "v025 最早正文：这条消息在 400 条历史之外。"
          : index === 19
            ? "v025 保存阅读原文：从另一会话定位到这里。"
            : index === 220
              ? "v025 范围正文：当前会话中的旧讨论。"
              : `v025 阅读记录 ${index + 1}：保留正在阅读的位置。`,
      ),
    );
    const elsewhere = insert(crossRoom.id, "v025 范围正文：另一个会话中的最早讨论。");
    const crossMessages = Array.from({ length: 420 }, (_, index) =>
      insert(crossRoom.id, `v025 另一会话后续讨论 ${index + 1}`),
    );
    const origin = originals[435];
    const middle = originals[220];
    const oldest = originals[0];
    if (!origin || !middle || !oldest) throw new Error("v0.2.5 missing history fixture");

    await page.goto(`${base}/#/c/${historyRoom.id}`);
    await row(origin.id).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await row(origin.id).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.getByRole("button", { name: "回到最新消息", exact: true }).waitFor();
    await settle();
    const originTop = await row(origin.id).evaluate((element) => element.getBoundingClientRect().top);
    const composer = page.getByRole("textbox", { name: "消息输入框", exact: true });
    await composer.fill("搜索期间保留的草稿");
    if ((await row(middle.id).count()) || (await row(oldest.id).count()))
      throw new Error("v0.2.5 old sources must begin outside the initial 200-message window");

    await page.keyboard.press(`${shortcut}+f`);
    await searchDialog.waitFor();
    if (
      (await searchDialog.getByRole("button", { name: "当前会话", exact: true }).getAttribute("aria-pressed")) !==
      "true"
    )
      throw new Error("v0.2.5 current-conversation shortcut opened the wrong scope");
    await searchInput.fill("v025 范围正文");
    await searchDialog.locator(".message-search-result").waitFor();
    if ((await searchDialog.locator(".message-search-result").count()) !== 1)
      throw new Error("v0.2.5 current search leaked a result from another room");
    await searchDialog.getByRole("button", { name: "全部会话", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".message-search-result").length === 2);
    await searchDialog.getByRole("button", { name: "当前会话", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".message-search-result").length === 1);
    await searchDialog.locator(".message-search-result").click();
    await searchDialog.waitFor({ state: "hidden" });
    await highlighted(middle.id).waitFor();
    await back.click();
    await assertOrigin(origin.id, originTop, "return from a source older than 200 messages");
    if ((await composer.inputValue()) !== "搜索期间保留的草稿")
      throw new Error("v0.2.5 search changed the composer draft");

    await page.getByRole("button", { name: "搜索当前会话", exact: true }).click();
    await searchInput.fill("v025 最早正文");
    await searchDialog.locator(".message-search-result").click();
    await highlighted(oldest.id).waitFor();
    if ((historyRequests.get(historyRoom.id) ?? 0) < 2)
      throw new Error("v0.2.5 oldest search result did not traverse both history boundaries");
    const live = insert(historyRoom.id, "v025 搜索原文期间到达的新消息");
    publish(live);
    await row(live.id).waitFor({ state: "attached" });
    await shot("v025-search-old-source");
    await back.click();
    await assertOrigin(origin.id, originTop, "return from a source older than 400 messages");
    evidence.sameRoomSearch = {
      initialMessages: 200,
      persistedMessages: 461,
      historyPages: historyRequests.get(historyRoom.id),
      returnsToReading: true,
      retainsDraft: true,
    };

    await page.keyboard.press(`${shortcut}+k`);
    await searchInput.fill("v025 范围正文");
    await searchDialog.getByRole("option").filter({ hasText: crossRoom.name }).click();
    await highlighted(elsewhere.id).waitFor();
    if (!page.url().endsWith(`/#/c/${crossRoom.id}`) || (historyRequests.get(crossRoom.id) ?? 0) < 2)
      throw new Error("v0.2.5 global search did not load the old result in its own conversation");
    evidence.crossRoomSearch = {
      persistedMessages: 421,
      historyPages: historyRequests.get(crossRoom.id),
      changesRoom: true,
    };

    // A consumed search target must not run again when normal sidebar navigation remounts ChatView.
    await back.click();
    await back.waitFor({ state: "hidden" });
    const crossOrigin = crossMessages[380];
    if (!crossOrigin) throw new Error("v0.2.5 missing cross-room reading fixture");
    await row(crossOrigin.id).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await settle();
    const crossTop = await row(crossOrigin.id).evaluate((element) => element.getBoundingClientRect().top);
    await composer.fill("跨会话独立草稿");
    await page.locator(".side-room").filter({ hasText: historyRoom.name }).click();
    await row(origin.id).waitFor();
    await assertOrigin(origin.id, originTop, "ordinary return to the first conversation");
    if ((await composer.inputValue()) !== "搜索期间保留的草稿")
      throw new Error("v0.2.5 switching back lost the first conversation's draft");
    if (await page.locator(".message-row[data-flash]").count())
      throw new Error("v0.2.5 switching back replayed an old same-room search target");
    await page.locator(".side-room").filter({ hasText: crossRoom.name }).click();
    await row(crossOrigin.id).waitFor();
    await assertOrigin(crossOrigin.id, crossTop, "ordinary return to the searched conversation");
    if ((await composer.inputValue()) !== "跨会话独立草稿")
      throw new Error("v0.2.5 switching back lost the searched conversation's draft");
    if (await page.locator(".message-row[data-flash]").count())
      throw new Error("v0.2.5 switching back replayed a consumed cross-room search target");
    evidence.normalRoomSwitch = { preservesBothDrafts: true, preservesBothReadingAnchors: true, replaysSearch: false };

    // Restoring an older saved reading anchor must finish before capturing the search return point.
    const olderOrigin = originals[49];
    const olderSource = originals[19];
    if (!olderOrigin || !olderSource) throw new Error("v0.2.5 missing older saved-reading fixtures");
    await page.locator(".side-room").filter({ hasText: historyRoom.name }).click();
    await row(origin.id).waitFor();
    for (let attempt = 0; attempt < 3 && !(await row(olderOrigin.id).count()); attempt++) {
      const previousCount = await page.locator(".messages [data-message-id]").count();
      await page.locator(".messages").evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
      await page.waitForFunction(
        (count) => document.querySelectorAll(".messages [data-message-id]").length > count,
        previousCount,
      );
    }
    await row(olderOrigin.id).evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await settle();
    const olderOriginTop = await row(olderOrigin.id).evaluate((element) => element.getBoundingClientRect().top);
    await composer.fill("保存于第50条的会话草稿");
    await page.locator(".side-room").filter({ hasText: crossRoom.name }).click();
    await row(crossOrigin.id).waitFor();
    if ((await composer.inputValue()) !== "跨会话独立草稿")
      throw new Error("v0.2.5 older source setup changed the other conversation's draft");
    await page.keyboard.press(`${shortcut}+k`);
    await searchInput.fill("v025 保存阅读原文");
    await searchDialog.locator(".message-search-result").click();
    await highlighted(olderSource.id).waitFor();
    await back.click();
    await assertOrigin(
      olderOrigin.id,
      olderOriginTop,
      "return after restoring a saved reading anchor older than 400 messages",
    );
    if ((await composer.inputValue()) !== "保存于第50条的会话草稿")
      throw new Error("v0.2.5 cross-room search lost the older target conversation's draft");
    await page.locator(".side-room").filter({ hasText: crossRoom.name }).click();
    await row(crossOrigin.id).waitFor();
    await assertOrigin(crossOrigin.id, crossTop, "return to the search-origin conversation");
    await page.locator(".side-room").filter({ hasText: historyRoom.name }).click();
    await row(olderOrigin.id).waitFor();
    await assertOrigin(olderOrigin.id, olderOriginTop, "ordinary revisit after an older cross-room search");
    if (
      (await page.locator(".message-row[data-flash]").count()) ||
      (await composer.inputValue()) !== "保存于第50条的会话草稿"
    )
      throw new Error("v0.2.5 ordinary revisit replayed the older source or lost its saved draft");
    evidence.savedOlderReading = {
      savedSeq: olderOrigin.seq,
      sourceSeq: olderSource.seq,
      restoresReadingBeforeSearch: true,
      preservesDraft: true,
      ordinaryRevisitReplaysSearch: false,
    };

    // A real failed session creation enters attention while the user is in a different room.
    await request("POST", `/api/rooms/${failedRoom.id}/messages`, { content: "v025 触发受控失败" });
    const failedSnapshot = await waitSnapshot(
      failedRoom.id,
      (value) =>
        !value.state.tasks.length &&
        value.messages.some((message) => message.senderKind === "agent" && message.status === "error"),
      "mock Harness did not produce the failed request",
    );
    const failed = failedSnapshot.messages.find(
      (message) => message.senderKind === "agent" && message.status === "error",
    );
    if (!failed?.error?.includes("v025 temporary Harness session failure"))
      throw new Error("v0.2.5 failed message did not retain the actual Harness diagnostic");
    for (let index = 0; index < 450; index++) insert(failedRoom.id, `v025 失败后的历史记录 ${index + 1}`);
    const failureAttention = await waitAttention(
      (value) => value.failures.some((item) => item.messageId === failed.id),
      "failure was missing from global attention",
    );
    await page.waitForFunction(
      (count) => document.querySelector(".side-attention-count")?.textContent === String(count),
      failureAttention.totalCount,
    );
    await openAttention();
    const failureItem = attentionItem(failedRoom.name);
    await failureItem.waitFor();
    await failureItem.getByRole("button", { name: "查看", exact: true }).click();
    await row(failed.id).locator(".msg-error").waitFor();
    if ((await row(failed.id).getAttribute("data-flash")) === null)
      throw new Error("v0.2.5 failed message was rendered without consuming the source navigation");
    if ((historyRequests.get(failedRoom.id) ?? 0) < 2)
      throw new Error("v0.2.5 attention did not page to the original old failure");
    if (!(await attention()).failures.some((item) => item.messageId === failed.id))
      throw new Error("v0.2.5 viewing a failed message incorrectly marked it handled");
    await openAttention();
    await failureItem.waitFor();
    await shot("v025-attention-failure");
    const dismissed = page.waitForResponse(
      (response) =>
        response.url() === `${base}/api/attention/${failed.id}/dismiss` && response.request().method() === "POST",
    );
    await failureItem.getByRole("button", { name: "标为已处理", exact: true }).click();
    if (!(await dismissed).ok()) throw new Error("v0.2.5 mark as handled failed");
    await failureItem.waitFor({ state: "detached" });
    if (
      (await attention()).failures.some((item) => item.messageId === failed.id) ||
      store.getMessage(failed.id)?.status !== "error"
    )
      throw new Error("v0.2.5 dismissal either failed to persist or changed the original message");
    const refreshedAttention = page.waitForResponse(
      (response) => response.url() === `${base}/api/attention` && response.request().method() === "GET",
    );
    await page.reload();
    const afterRefresh = (await (await refreshedAttention).json()) as AttentionSnapshot;
    if (afterRefresh.failures.some((item) => item.messageId === failed.id))
      throw new Error("v0.2.5 fresh server snapshot restored the handled failure");
    await attentionEntry.waitFor();
    await openAttention();
    await attentionDialog.locator(".attention-list[aria-busy=false]").waitFor();
    if (await failureItem.count()) throw new Error("v0.2.5 handled failure returned after refreshing");
    await attentionDialog.getByRole("button", { name: "关闭", exact: true }).click();
    evidence.failureAttention = {
      realHarnessFailure: true,
      oldMessageHistoryPages: historyRequests.get(failedRoom.id),
      viewingRetainsItem: true,
      dismissalSurvivesRefresh: true,
      originalStatus: store.getMessage(failed.id)?.status,
    };

    // Requests are issued to the actual mock ACP process and verified in the real Host-backed snapshots.
    await request("POST", `/api/rooms/${permissionRoom.id}/messages`, { content: "/edit" });
    await request("POST", `/api/rooms/${questionRoom.id}/messages`, { content: "/ask" });
    const permissionSnapshot = await waitSnapshot(
      permissionRoom.id,
      (value) => value.asks.length === 1,
      "permission was not pending in Host",
    );
    const questionSnapshot = await waitSnapshot(
      questionRoom.id,
      (value) => value.elicitations.length === 1,
      "question was not pending in Host",
    );
    const permission = permissionSnapshot.asks[0];
    const question = questionSnapshot.elicitations[0];
    if (!permission || !question) throw new Error("v0.2.5 missing pending Host requests");
    await waitAttention(
      (value) => [permission.id, question.id].every((id) => value.active.some((item) => item.askId === id)),
      "global attention disagreed with Host",
    );
    await openAttention();
    const permissionItem = attentionItem(permissionRoom.name);
    const questionItem = attentionItem(questionRoom.name);
    await permissionItem.waitFor();
    await questionItem.waitFor();
    if (
      (await permissionItem.getByRole("button", { name: "标为已处理", exact: true }).count()) ||
      (await questionItem.getByRole("button", { name: "标为已处理", exact: true }).count())
    )
      throw new Error("v0.2.5 live requests incorrectly allow manual dismissal");
    await permissionItem.getByRole("button", { name: "查看", exact: true }).click();
    const permissionDialog = page.getByRole("alertdialog");
    await permissionDialog.waitFor();
    if (
      !(await attention()).active.some((item) => item.askId === permission.id) ||
      (await snapshot(permissionRoom.id)).asks[0]?.id !== permission.id
    )
      throw new Error("v0.2.5 opening permission resolved it without a Host decision");
    await permissionDialog.getByRole("button", { name: "拒绝", exact: true }).click();
    await permissionDialog.waitFor({ state: "hidden" });
    await waitAttention(
      (value) =>
        !value.active.some((item) => item.askId === permission.id) &&
        value.active.some((item) => item.askId === question.id),
      "rejecting permission did not preserve the other room's question",
    );
    await openAttention();
    await permissionItem.waitFor({ state: "detached" });
    await questionItem.getByRole("button", { name: "查看", exact: true }).click();
    const questionDetails = page.locator("details.elicit");
    await questionDetails.locator("form").waitFor({ state: "visible" });
    if (
      !(await attention()).active.some((item) => item.askId === question.id) ||
      (await snapshot(questionRoom.id)).elicitations[0]?.id !== question.id
    )
      throw new Error("v0.2.5 opening a question answered it without a Host response");
    await shot("v025-attention-question");
    await questionDetails.getByRole("button", { name: "取消提问", exact: true }).click();
    await waitAttention(
      (value) => !value.active.some((item) => [permission.id, question.id].includes(item.askId)),
      "resolved requests remained in global attention",
    );
    await openAttention();
    await questionItem.waitFor({ state: "detached" });
    if ((await snapshot(questionRoom.id)).elicitations.length || (await snapshot(permissionRoom.id)).asks.length)
      throw new Error("v0.2.5 attention hid a request that was still pending in Host");
    evidence.activeRequests = {
      realMockAcp: true,
      permissionAndQuestionAcrossRooms: true,
      openingRetainsRequests: true,
      cannotManuallyDismiss: true,
      resolvedThroughHost: true,
    };

    // Another window can create rooms after this App has loaded its sidebar metadata.
    await attentionDialog.getByRole("button", { name: "关闭", exact: true }).click();
    const remoteQuestionRoom = await room("v025 另一个窗口的新提问", worker.id);
    await request("POST", `/api/rooms/${remoteQuestionRoom.id}/messages`, { content: "/ask" });
    const remoteSnapshot = await waitSnapshot(
      remoteQuestionRoom.id,
      (value) => value.elicitations.length === 1,
      "new-room question was not pending in Host",
    );
    const remoteQuestion = remoteSnapshot.elicitations[0];
    if (!remoteQuestion) throw new Error("v0.2.5 missing real request in the remotely created room");
    if (await page.locator(".side-room").filter({ hasText: remoteQuestionRoom.name }).count())
      throw new Error("v0.2.5 remote-room fixture must begin outside the loaded sidebar cache");
    evidence.remoteRoomNavigation = { initiallyUnknownQuestionRoom: true };
    await openAttention();
    const remoteQuestionItem = attentionItem(remoteQuestionRoom.name);
    await remoteQuestionItem.waitFor();
    await shot("v025-attention-unknown-room");
    await remoteQuestionItem.getByRole("button", { name: "查看", exact: true }).click();
    await page.getByRole("heading", { name: remoteQuestionRoom.name, exact: true }).waitFor();
    await questionDetails.locator("form").waitFor({ state: "visible" });
    if (
      !page.url().endsWith(`/#/c/${remoteQuestionRoom.id}`) ||
      (await snapshot(remoteQuestionRoom.id)).elicitations[0]?.id !== remoteQuestion.id ||
      !(await attention()).active.some((item) => item.askId === remoteQuestion.id)
    )
      throw new Error("v0.2.5 attention did not load the unknown room and reveal its still-pending question");
    await questionDetails.getByRole("button", { name: "取消提问", exact: true }).click();
    await waitAttention(
      (value) => !value.active.some((item) => item.askId === remoteQuestion.id),
      "remotely created question remained pending after cancellation",
    );

    // Create this second room after the first navigation's metadata reload, keeping search unknown too.
    const remoteSearchRoom = await room("v025 另一个窗口的新消息", worker.id);
    const remoteSource = insert(remoteSearchRoom.id, "v025 未知新房间正文：从全局搜索定位原消息。");
    if (await page.locator(".side-room").filter({ hasText: remoteSearchRoom.name }).count())
      throw new Error("v0.2.5 remote search fixture must begin outside the loaded sidebar cache");
    await page.keyboard.press(`${shortcut}+k`);
    await searchInput.fill("v025 未知新房间正文");
    await searchDialog.getByRole("option").filter({ hasText: remoteSearchRoom.name }).click();
    await page.getByRole("heading", { name: remoteSearchRoom.name, exact: true }).waitFor();
    await highlighted(remoteSource.id).waitFor();
    if (!page.url().endsWith(`/#/c/${remoteSearchRoom.id}`))
      throw new Error("v0.2.5 search did not navigate to the remotely created room");
    await shot("v025-search-unknown-room");
    evidence.remoteRoomNavigation = {
      initiallyUnknownQuestionRoom: true,
      attentionUpdatedWithoutManualReload: true,
      questionOpenedAndRemainedPending: true,
      initiallyUnknownSearchRoom: true,
      searchOpenedOriginalMessage: true,
    };

    if (errors.length) throw new Error(`v0.2.5 browser errors: ${errors.join("; ")}`);
    console.log(`PASS v0.2.5 search and attention: ${JSON.stringify(evidence)}`);
    return evidence;
  } catch (error) {
    await shot("v025-failure").catch(() => {});
    if (shotsDir)
      await Bun.write(
        join(shotsDir, "v025-failure.json"),
        JSON.stringify({ url: page.url(), error: String(error), evidence, browserErrors: errors }, null, 2),
      ).catch(() => {});
    throw error;
  } finally {
    await page.close();
    for (const id of roomIds) await fetch(`${base}/api/rooms/${id}`, { method: "DELETE" });
    for (const id of agentIds) await fetch(`${base}/api/agents/${id}`, { method: "DELETE" });
  }
}
