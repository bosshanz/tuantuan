import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { Browser, Locator, Page, WebSocketRoute } from "playwright-core";
import type { Message, Store } from "../server/store";
import { applyUpdate, emptyTimeline, timelineText } from "../shared/timeline";
import type { ChatSnapshot } from "../web/src/chatState";

/** Check rendered motion, including a reversal before the first expansion has finished. */
async function disclosureMotion(page: Page, disclosure: Locator) {
  const sample = (reverse = false) =>
    disclosure.evaluate(async (element, reverse) => {
      const details = element as HTMLDetailsElement;
      const summary = details.querySelector("summary");
      if (!summary || details.open) throw new Error("motion fixture must start collapsed");
      const height = () => details.getBoundingClientRect().height;
      const collect = (duration: number) =>
        new Promise<number[]>((resolve) => {
          const frames: number[] = [];
          const start = performance.now();
          const frame = () => {
            frames.push(height());
            if (performance.now() - start >= duration) resolve(frames);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      const closed = height();
      summary.click();
      const opening = await collect(reverse ? 60 : 300);
      const before = height();
      summary.click();
      const after = height();
      const closing = await collect(300);
      return { closed, opening, closing, before, after, final: height(), open: details.open };
    }, reverse);
  await disclosure.scrollIntoViewIfNeeded();
  const normal = await sample();
  const full = normal.opening.at(-1) ?? 0;
  const middle = (frames: number[]) => frames.filter((height) => height > normal.closed + 1 && height < full - 1);
  if (full <= normal.closed + 2 || middle(normal.opening).length < 2 || middle(normal.closing).length < 2)
    throw new Error(`disclosure jumped instead of animating: ${JSON.stringify(normal)}`);
  const reversed = await sample(true);
  if (Math.abs(reversed.before - reversed.after) > 2 || Math.abs(reversed.final - reversed.closed) > 1 || reversed.open)
    throw new Error(`disclosure reversal jumped or left content open: ${JSON.stringify(reversed)}`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    const reduced = await sample();
    if (middle(reduced.opening).length || middle(reduced.closing).length || reduced.open)
      throw new Error(`disclosure animated with reduced motion: ${JSON.stringify(reduced)}`);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
}

/** A floating conclusion fades from its anchor without moving the transcript or restarting on reversal. */
async function conclusionMotion(page: Page) {
  const sample = (reverse = false) =>
    page.evaluate(async (reverse) => {
      const trigger = document.querySelector<HTMLButtonElement>(".room-conclusion-toggle");
      if (trigger?.getAttribute("aria-expanded") !== "false") throw new Error("conclusion must start closed");
      const opacity = () => {
        const panel = document.querySelector(".room-conclusion");
        return panel ? Number(getComputedStyle(panel).opacity) : 0;
      };
      const collect = (duration: number) =>
        new Promise<number[]>((resolve) => {
          const frames: number[] = [];
          const start = performance.now();
          const frame = () => {
            frames.push(opacity());
            if (performance.now() - start >= duration) resolve(frames);
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      trigger.click();
      const opening = await collect(reverse ? 60 : 300);
      const before = opacity();
      trigger.click();
      const after = opacity();
      const closing = await collect(300);
      return { opening, closing, before, after, final: opacity(), expanded: trigger.getAttribute("aria-expanded") };
    }, reverse);
  const middle = (frames: number[]) => frames.filter((opacity) => opacity > 0.01 && opacity < 0.99).length;
  const normal = await sample();
  if (middle(normal.opening) < 2 || middle(normal.closing) < 2 || normal.final > 0.01)
    throw new Error(`conclusion did not enter and exit smoothly: ${JSON.stringify(normal)}`);
  const reverse = await sample(true);
  if (Math.abs(reverse.before - reverse.after) > 0.1 || reverse.final > 0.01 || reverse.expanded !== "false")
    throw new Error(`conclusion reversal jumped: ${JSON.stringify(reverse)}`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    const reduced = await sample();
    if (middle(reduced.opening) || middle(reduced.closing) || reduced.expanded !== "false")
      throw new Error(`conclusion ignored reduced motion: ${JSON.stringify(reduced)}`);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
}

/** Inline questions, the shared reply/conclusion status and interrupted-request retry in the built UI. */
export async function chatToolsSmoke(browser: Browser, base: string, store: Store, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  let expectedUnavailable = false;
  let liveSocket: WebSocketRoute | undefined;
  await page.routeWebSocket(`${base.replace("http", "ws")}/ws`, (socket) => {
    socket.connectToServer();
    liveSocket = socket;
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) && !(expectedUnavailable && message.text().includes("503")))
      errors.push(message.text());
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
  const other = await request<{ id: string }>("POST", "/api/rooms", {
    name: "离开提问回归",
    agentIds: [agent.id],
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
    const question = page.locator("details.elicit");
    const questionSummary = question.locator(":scope > summary");
    const questionForm = question.locator("form");
    const expandQuestion = async () => {
      if (!(await question.evaluate((element) => (element as HTMLDetailsElement).open))) await questionSummary.click();
      await questionForm.waitFor({ state: "visible" });
    };

    // Questions arrive collapsed and leave both the transcript and composer available.
    await input.fill("/ask");
    await input.press("Enter");
    await question.waitFor();
    if (await question.evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("a new question expanded without a user action");
    if (!(await input.evaluate((element) => element === document.activeElement)))
      throw new Error("a new question stole focus from the composer");
    if (await page.locator(".elicit-overlay, .palette.elicit, .elicit[aria-modal='true']").count())
      throw new Error("an inline question still uses a modal overlay");
    await questionSummary.getByText("展开提问", { exact: true }).waitFor();
    await questionSummary.getByText("请确认本次发布的方式", { exact: true }).waitFor();
    await questionSummary.getByText("提问助手 想请你回答", { exact: true }).waitFor();
    await disclosureMotion(page, question);
    const firstAskId = (await history()).elicitations[0]?.id;
    if (!firstAskId) throw new Error("the question was not included in the room snapshot");
    await shot("elicit-collapsed");
    await page.reload();
    await question.waitFor();
    if ((await history()).elicitations[0]?.id !== firstAskId)
      throw new Error("refresh cancelled the pending question instead of restoring it");
    if (await question.evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("a restored question expanded without a user action");
    if (await question.evaluate((element) => element.contains(document.activeElement)))
      throw new Error("a restored question claimed keyboard focus");
    await expandQuestion();
    for (const label of ["发布范围", "发布频道", "补充说明", "批次数量", "灰度比例", "确认发布", "标签"]) {
      await question.getByText(label, { exact: false }).first().waitFor();
    }
    const submitQuestion = question.getByRole("button", { name: "提交回答" });
    await submitQuestion.focus();
    await page.keyboard.press("Tab");
    if (await question.evaluate((element) => element.contains(document.activeElement)))
      throw new Error("the inline question trapped Tab after its last control");
    await input.fill("提问展开时仍可继续编辑消息");
    if (!(await input.evaluate((element) => element === document.activeElement)))
      throw new Error("an expanded question blocked the composer");
    await input.fill("");
    await question.getByRole("radio", { name: "稳定版", exact: false }).check();
    await question.getByRole("radio", { name: "不填写", exact: true }).check();
    await page.setViewportSize({ width: 390, height: 844 });
    const footerBox = await question.locator(".elicit-footer").boundingBox();
    const contentBox = await question.locator(".elicit-content").boundingBox();
    if (!footerBox || footerBox.y < 0 || footerBox.y + footerBox.height > 844)
      throw new Error("long question hides its actions on a narrow screen");
    if (!contentBox || contentBox.height >= 844 / 2)
      throw new Error("question content occupies more than half a narrow viewport");
    if (await question.evaluate((element) => element.scrollWidth > element.clientWidth + 1))
      throw new Error("question overflows horizontally on a narrow screen");
    await shot("elicit-form-narrow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await submitQuestion.click();
    await question.getByText("此项为必填", { exact: true }).first().waitFor();
    if (await submitQuestion.isDisabled())
      throw new Error("empty required fields did not keep submit available for correction");
    await question.getByRole("radio", { name: "canary", exact: true }).check();
    await question.getByLabel("补充说明").fill("确认发布");
    await question.getByRole("checkbox", { name: "移动端" }).check();
    if ((await question.getByLabel("执行时间").inputValue()) !== "2026-10-17T10:00:00+08:00")
      throw new Error("date-time default lost its timezone or was blanked by the browser");
    await question.getByLabel("执行时间").fill("2026-02-30T10:00:00Z");
    await submitQuestion.click();
    await question.getByText("请输入有效的 date-time", { exact: true }).waitFor();

    // Escape and the disclosure only collapse: answers, field errors, and the pending ask survive.
    await question.getByLabel("执行时间").press("Escape");
    await questionForm.waitFor({ state: "hidden" });
    if (!(await questionSummary.evaluate((element) => element === document.activeElement)))
      throw new Error("collapsing with Escape did not return focus to the question summary");
    if (!(await questionForm.evaluate((element) => (element as HTMLFormElement).inert)))
      throw new Error("a collapsed question left its form interactive");
    if ((await history()).elicitations[0]?.id !== firstAskId) throw new Error("collapsing a question sent cancel");
    await expandQuestion();
    await page.setViewportSize({ width: 390, height: 844 });
    await question.getByLabel("补充说明").press("Escape");
    await page.keyboard.press("Tab");
    if (await questionForm.evaluate((element) => element.contains(document.activeElement)))
      throw new Error("Tab entered form controls during the closing animation");
    await questionForm.waitFor({ state: "hidden" });
    if (await page.evaluate(() => document.activeElement === document.body))
      throw new Error("closing the inline question dropped keyboard focus on the page");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expandQuestion();
    if (!(await question.getByRole("radio", { name: "canary", exact: true }).isChecked()))
      throw new Error("collapsing lost the selected answer");
    if ((await question.getByLabel("补充说明").inputValue()) !== "确认发布")
      throw new Error("collapsing lost the typed answer");
    if ((await question.getByLabel("执行时间").inputValue()) !== "2026-02-30T10:00:00Z")
      throw new Error("collapsing reset an invalid answer");
    await question.getByText("请输入有效的 date-time", { exact: true }).waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const motionReduced = await question.evaluate((element) => {
      if (!CSS.supports("selector(::details-content)")) return true;
      return getComputedStyle(element, "::details-content").transitionDuration === "0s";
    });
    if (!motionReduced) throw new Error("question expansion ignored reduced motion");
    await questionSummary.click();
    await questionForm.waitFor({ state: "hidden" });
    await expandQuestion();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await question.getByLabel("执行时间").fill("2026-10-17T10:00:00+08:00");
    await shot("elicit-form");

    // Pending disables duplicate submission, including while the form is collapsed and reopened.
    const answerPattern = `**/api/elicitations/${firstAskId}`;
    expectedUnavailable = true;
    let answerRequests = 0;
    let releaseFailure = () => {};
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await page.route(answerPattern, async (route) => {
      answerRequests++;
      await failureGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture unavailable" }),
      });
    });
    await submitQuestion.click();
    try {
      await question.getByRole("button", { name: "提交中…", exact: true }).waitFor();
      if (!(await questionSummary.evaluate((element) => element === document.activeElement)))
        throw new Error("disabling the pending submit button lost keyboard focus");
      if (!(await question.getByRole("button", { name: "取消提问", exact: true }).isDisabled()))
        throw new Error("a pending question still allowed cancellation");
      await questionSummary.click();
      await questionForm.waitFor({ state: "hidden" });
      await questionSummary.getByText("提交中…", { exact: true }).waitFor();
      await questionForm.evaluate((element) => (element as HTMLFormElement).requestSubmit());
    } finally {
      releaseFailure();
    }
    await questionSummary.getByText("提交失败", { exact: true }).waitFor();
    if (await question.evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("a failed answer forced the collapsed question open");
    if (!(await questionSummary.evaluate((element) => element === document.activeElement)))
      throw new Error("a failed collapsed answer moved keyboard focus");
    await expandQuestion();
    await question.getByText(/回答提交失败/).waitFor();
    if (answerRequests !== 1) throw new Error("a pending form sent a duplicate answer");
    if (!(await question.getByRole("radio", { name: "canary", exact: true }).isChecked()))
      throw new Error("failed submission lost the selected answer");
    if ((await question.getByLabel("补充说明").inputValue()) !== "确认发布")
      throw new Error("failed submission lost the typed answer");
    await questionSummary.click();
    await questionForm.waitFor({ state: "hidden" });
    await expandQuestion();
    await question.getByText(/回答提交失败/).waitFor();
    await page.unroute(answerPattern);
    expectedUnavailable = false;
    await submitQuestion.click();
    await question.waitFor({ state: "detached" });
    if (!(await input.evaluate((element) => element === document.activeElement)))
      throw new Error("a successful answer did not return keyboard focus to the composer");
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
    if (!accepted.content.includes('"when":"2026-10-17T10:00:00+08:00"'))
      throw new Error("date-time answer did not retain its timezone");
    if (accepted.content.includes('"channel"')) throw new Error("cleared optional choice was still submitted");

    // Only the explicit cancel action answers cancel; a new ask is still collapsed by default.
    await input.fill("/ask");
    await input.press("Enter");
    await question.waitFor();
    if (await question.evaluate((element) => (element as HTMLDetailsElement).open))
      throw new Error("the next question inherited the previous question's expanded state");
    await expandQuestion();
    await question.getByRole("button", { name: "取消提问", exact: true }).click();
    await question.waitFor({ state: "detached" });
    if (!(await input.evaluate((element) => element === document.activeElement)))
      throw new Error("cancelling the question did not return keyboard focus to the composer");
    await page.getByText("提问结果：cancel").waitFor();

    // Future field types remain visible and cannot be submitted from an inline question.
    await input.fill("/ask_unknown");
    await input.press("Enter");
    await question.waitFor();
    await expandQuestion();
    await question
      .getByText("这个提问包含当前版本不支持的问题类型，无法提交。请取消本次提问。", { exact: true })
      .waitFor();
    if (!(await question.getByRole("button", { name: "提交回答" }).isDisabled()))
      throw new Error("an unsupported inline question could be submitted");
    await question.getByRole("button", { name: "取消提问", exact: true }).click();
    await question.waitFor({ state: "detached" });

    // Navigation preserves the pending Agent question, its typed form and the room's composer draft.
    await input.fill("/ask");
    await input.press("Enter");
    await question.waitFor();
    await expandQuestion();
    await question.getByLabel("补充说明").fill("确认导航后保留");
    await question.getByRole("radio", { name: "canary", exact: true }).check();
    await input.fill("切换房间后保留的聊天草稿");
    const leavingSnapshot = await history();
    const leavingRun = leavingSnapshot.messages.filter((message) => message.senderKind === "human").at(-1)?.id;
    const leavingAsk = leavingSnapshot.elicitations[0]?.id;
    if (!leavingAsk) throw new Error("the navigation fixture has no pending question");
    await page.evaluate((hash) => {
      location.hash = hash;
    }, `#/c/${other.id}`);
    await page.getByRole("heading", { name: "离开提问回归", exact: true }).waitFor();
    const awaySnapshot = await history();
    if (!awaySnapshot.elicitations.some((ask) => ask.id === leavingAsk))
      throw new Error("leaving the conversation cancelled its pending Agent question");
    if (
      awaySnapshot.messages.some(
        (message) => message.runId === leavingRun && message.content.startsWith("提问结果：cancel"),
      )
    )
      throw new Error("ordinary navigation sent a cancel answer to the Agent");
    await page.evaluate((hash) => {
      location.hash = hash;
    }, `#/c/${room.id}`);
    await page.getByRole("heading", { name: "提问与结论回归", exact: true }).waitFor();
    await question.waitFor();
    await expandQuestion();
    if ((await input.inputValue()) !== "切换房间后保留的聊天草稿")
      throw new Error("returning to the conversation lost its composer draft");
    if (
      (await question.getByLabel("补充说明").inputValue()) !== "确认导航后保留" ||
      !(await question.getByRole("radio", { name: "canary", exact: true }).isChecked())
    )
      throw new Error("returning to the conversation lost the partly filled question");
    await question.getByRole("button", { name: "取消提问", exact: true }).click();
    await question.waitFor({ state: "detached" });
    const leaveDeadline = Date.now() + 10_000;
    for (;;) {
      const snapshot = await history();
      const cancelled = snapshot.messages.some(
        (message) =>
          message.runId === leavingRun && message.status === "done" && message.content.startsWith("提问结果：cancel"),
      );
      if (!snapshot.elicitations.length && cancelled) break;
      if (Date.now() > leaveDeadline)
        throw new Error("explicit cancellation did not finish the preserved Agent question");
      await page.waitForTimeout(40);
    }

    // Saved notes share the reply status near the composer, with a floating detail rather than a pinned header.
    await input.fill(`/context ${JSON.stringify(context)}`);
    await input.press("Enter");
    const end = Date.now() + 20_000;
    let source: Message | undefined;
    while (!source) {
      if (Date.now() > end) throw new Error("saved task note did not arrive");
      const snapshot = await history();
      if (!snapshot.state.activeRunId)
        source = snapshot.messages.find((message) => message.timeline?.taskContext?.goal === context.goal);
      await page.waitForTimeout(40);
    }
    const status = page.locator(".composer .chat-tasks");
    const summary = status.locator(".room-conclusion-toggle");
    const card = status.locator(".room-conclusion");
    await summary.getByText(context.goal, { exact: false }).waitFor();
    if (await page.locator(".messages-wrap > .room-conclusion").count())
      throw new Error("conclusion still occupies the transcript header");
    if ((await summary.getAttribute("aria-expanded")) !== "false" || (await card.isVisible()))
      throw new Error("conclusion opened without user input");
    await conclusionMotion(page);
    const layout = () =>
      page.evaluate(() => {
        const list = document.querySelector(".messages") as HTMLElement;
        const input = document.querySelector(".composer textarea") as HTMLElement;
        return {
          top: list.getBoundingClientRect().top,
          height: list.clientHeight,
          scroll: list.scrollTop,
          input: input.getBoundingClientRect().top,
        };
      });
    const beforeConclusion = await layout();
    await summary.click();
    await card.waitFor({ state: "visible" });
    for (const value of [...context.decisions, ...context.pending])
      await card.getByText(value, { exact: false }).waitFor();
    await card.getByText("2 项决策 · 1 项未完成").waitFor();
    const afterConclusion = await layout();
    if (
      Object.keys(beforeConclusion).some(
        (key) =>
          Math.abs(
            beforeConclusion[key as keyof typeof beforeConclusion] -
              afterConclusion[key as keyof typeof afterConclusion],
          ) > 1,
      )
    )
      throw new Error(
        `opening conclusion moved the conversation: ${JSON.stringify({ beforeConclusion, afterConclusion })}`,
      );
    await card.locator(".room-conclusion-grid").focus();
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "hidden" });
    if (!(await summary.evaluate((element) => document.activeElement === element)))
      throw new Error("Escape did not return focus to the conclusion trigger");
    await summary.click();
    await input.click();
    await card.waitFor({ state: "hidden" });
    if (!(await input.evaluate((element) => document.activeElement === element)))
      throw new Error("outside dismissal stole composer focus");
    const sourceRow = page.locator(`.message-row[data-message-id="${source.id}"]`);
    if (await sourceRow.locator(".task-context, .compact-process, .handoff-card, .handoff-from").count())
      throw new Error("compact source reply exposed internal process records");
    await sourceRow.hover();
    await sourceRow.getByRole("button", { name: "更多消息操作", exact: true }).click();
    await page
      .getByRole("dialog", { name: "消息操作", exact: true })
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    await page.getByRole("heading", { name: "回复详情", exact: true }).waitFor();
    await disclosureMotion(page, page.locator('.details .task-context[data-kind="saved"]'));
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await summary.click();
    await card.waitFor({ state: "visible" });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
      throw new Error("conclusion card overflows a narrow viewport");
    const conclusionBox = await card.boundingBox();
    const statusBox = await status.boundingBox();
    if (
      !conclusionBox ||
      !statusBox ||
      conclusionBox.y < 0 ||
      conclusionBox.x < 0 ||
      conclusionBox.x + conclusionBox.width > 391 ||
      conclusionBox.y + conclusionBox.height > statusBox.y + 1
    )
      throw new Error("floating conclusion escaped the viewport or covered its status bar");
    await shot("room-conclusion-narrow");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card.getByRole("button", { name: "查看来源消息" }).click();
    await page.waitForFunction(
      (id) => document.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`)?.hasAttribute("data-flash"),
      source.id,
    );
    await card.waitFor({ state: "hidden" });
    const highlightedBody = sourceRow.locator("[data-message-body][data-source-highlight]");
    await highlightedBody.waitFor();
    const highlightStyle = await highlightedBody.evaluate((element) => {
      const style = getComputedStyle(element);
      const messageStyle = getComputedStyle(element.closest(".msg") as HTMLElement);
      return {
        outline: style.outlineStyle,
        shadow: style.boxShadow,
        messageShadow: messageStyle.boxShadow,
        containsMetadata: !!element.querySelector(".task-context, .handoff-from, .handoff-card, .msg-meta"),
      };
    });
    if (
      highlightStyle.outline !== "none" ||
      highlightStyle.shadow !== "none" ||
      highlightStyle.messageShadow !== "none" ||
      highlightStyle.containsMetadata
    )
      throw new Error(
        `source highlight still frames the message or internal records: ${JSON.stringify(highlightStyle)}`,
      );
    await page.waitForTimeout(850);
    await summary.click();
    await card.getByRole("button", { name: "查看来源消息" }).click();
    await page.waitForTimeout(850);
    if ((await sourceRow.getAttribute("data-flash")) === null || !(await highlightedBody.count()))
      throw new Error("repeated source navigation was cleared by the previous highlight timer");
    await page.waitForFunction(
      (id) => !document.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`)?.hasAttribute("data-flash"),
      source.id,
    );

    // Running work and the saved conclusion use one status owner, without claiming the new run is done.
    await input.fill("/slow");
    await input.press("Enter");
    await status.locator(".chat-activity-agent").first().waitFor();
    await summary.waitFor();
    await page.setViewportSize({ width: 390, height: 600 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
      throw new Error("running status and conclusion overflow a narrow viewport");
    await status.getByRole("button", { name: "展开回复状态", exact: true }).click();
    await summary.click();
    await card.waitFor({ state: "visible" });
    if (
      (await status.getAttribute("data-expanded")) !== "false" ||
      !(await status.locator(".chat-task-disclosure").evaluate((element) => (element as HTMLElement).inert))
    )
      throw new Error("conclusion and task details remained open together");
    const runningConclusion = await card.boundingBox();
    const runningInput = await input.boundingBox();
    if (!runningConclusion || !runningInput || runningConclusion.y < 0 || runningInput.y + runningInput.height > 600)
      throw new Error("running conclusion or input escaped the short viewport");
    await shot("room-conclusion-running-narrow");
    await status.getByRole("button", { name: "展开回复状态", exact: true }).click();
    await card.waitFor({ state: "hidden" });
    await status.locator(".chat-task").getByRole("button", { name: "停止任务", exact: true }).click();
    await status.locator(".chat-activity-agent").waitFor({ state: "hidden" });
    await summary.getByText(context.goal, { exact: false }).waitFor();
    if ((await status.getAttribute("data-expanded")) === "true")
      throw new Error("empty task details remained expanded");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A source older than the loaded page can be reached, but a failed page must not retry forever.
    for (let index = 0; index < 205; index++)
      store.insertMessage({
        roomId: room.id,
        runId: "conclusion-history-fixture",
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "Andy",
        content: `结论之后的记录 ${index}`,
        status: "done",
      });
    await page.reload();
    await summary.waitFor();
    if (await page.locator(`.message-row[data-message-id="${source.id}"]`).count())
      throw new Error("history fixture did not put the conclusion source outside the loaded page");
    let failedPages = 0;
    const historyPattern = `**/api/rooms/${room.id}/messages?*`;
    expectedUnavailable = true;
    await page.route(historyPattern, async (route) => {
      if (!new URL(route.request().url()).searchParams.has("beforeSeq")) return route.continue();
      failedPages++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture unavailable" }),
      });
    });
    await summary.click();
    await card.getByRole("button", { name: "查看来源消息" }).click();
    await page
      .locator(".quote-navigation-feedback")
      .filter({ hasText: /加载失败：fixture unavailable/ })
      .waitFor();
    await page.waitForTimeout(500);
    if (failedPages !== 1)
      throw new Error(`source navigation automatically retried a failed page ${failedPages} times`);
    await page.unroute(historyPattern);
    expectedUnavailable = false;
    await summary.click();
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
    if (await page.locator(".room-conclusion-toggle").count())
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
    // A short compact transcript clamps scrollTop. Rapid reversal must restore the original reading anchor.
    const densityRoom = await request<{ id: string }>("POST", "/api/rooms", {
      name: "显示密度阅读位置",
      agentIds: [agent.id],
    });
    const phaseTexts = [
      "先确认当前接口与筛选范围。",
      "筛选与权限规则已确认，开始实现导出。",
      "导出实现已完成，保留上线前压测事项。",
    ];
    let phaseMessageId = "";
    for (let index = 0; index < 3; index++) {
      const message = store.insertMessage({
        roomId: densityRoom.id,
        runId: "density-fixture",
        hop: 0,
        senderKind: "agent",
        senderId: agent.id,
        senderName: agent.name,
        content: index === 0 ? phaseTexts.join("\n\n") : `阅读中的回复 ${index + 1}`,
        status: "done",
      });
      store.updateReply(message.id, {
        content: message.content,
        status: "done",
        timeline: {
          ...emptyTimeline(),
          parts:
            index === 0
              ? [
                  { kind: "text", text: phaseTexts[0] as string },
                  { kind: "thought", text: "不应出现在简洁模式的内部推演" },
                  { kind: "text", text: phaseTexts[1] as string },
                  { kind: "tool", toolCallId: "phase-check" },
                  { kind: "text", text: phaseTexts[2] as string },
                ]
              : [{ kind: "text", text: message.content }],
          tools:
            index === 0
              ? {
                  "phase-check": {
                    toolCallId: "phase-check",
                    title: "内部工具检查",
                    kind: "execute",
                    status: "completed",
                    content: [],
                    locations: [],
                  },
                }
              : {},
          plan: Array.from({ length: 18 }, (_, item) => ({
            content: `处理步骤 ${item + 1}`,
            status: "completed" as const,
            priority: "medium" as const,
          })),
        },
      });
      if (index === 0) phaseMessageId = message.id;
    }
    await page.goto(`${base}/#/c/${densityRoom.id}`);
    // Hash navigation keeps the old room list; fetch the fixture created after this page loaded.
    await page.reload();
    await page.getByRole("heading", { name: "显示密度阅读位置", exact: true }).waitFor();
    const phaseRow = page.locator(`[data-message-id="${phaseMessageId}"]`);
    for (const text of phaseTexts) await phaseRow.getByText(text, { exact: true }).waitFor();
    const renderedPhaseText = (await phaseRow.textContent()) ?? "";
    if (
      phaseTexts.some(
        (text, index) =>
          index > 0 && renderedPhaseText.indexOf(text) < renderedPhaseText.indexOf(phaseTexts[index - 1] as string),
      ) ||
      (await phaseRow.locator(".thought, .tool, .plan-item, .compact-process").count())
    )
      throw new Error("compact phases lost the Agent's original order or exposed process details");
    if ((await phaseRow.locator("[data-reply-phase]").count()) !== phaseTexts.length)
      throw new Error("separate reply phases were combined into one bubble");
    await page.getByRole("button", { name: "展开详情面板" }).click();
    await page.getByRole("tab", { name: "详情", exact: true }).click();
    const densitySwitch = page.getByRole("switch", { name: "仅显示回复正文", exact: true });
    await densitySwitch.uncheck();
    const densitySettled = () =>
      page.waitForFunction(() =>
        [...(document.querySelector(".messages")?.getAnimations() ?? [])].every((a) => a.playState !== "running"),
      );
    await densitySettled();
    const list = page.locator(".messages");
    await list.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.65;
    });
    await page.getByRole("button", { name: "回到最新消息", exact: true }).waitFor();
    const readingPosition = () =>
      list.evaluate((element) => {
        const top = element.getBoundingClientRect().top;
        const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (row) => row.getBoundingClientRect().bottom > top,
        );
        return { id: message?.dataset.messageId, offset: (message?.getBoundingClientRect().top ?? 0) - top };
      });
    const beforeDensity = await readingPosition();
    await densitySwitch.dblclick({ delay: 35 });
    await densitySettled();
    const afterDensity = await readingPosition();
    if (
      (await densitySwitch.isChecked()) ||
      beforeDensity.id !== afterDensity.id ||
      Math.abs(beforeDensity.offset - afterDensity.offset) > 2
    )
      throw new Error(`density reversal lost reading position: ${JSON.stringify({ beforeDensity, afterDensity })}`);
    await densitySwitch.check();

    // Live chunks extend one bubble; only an actual activity boundary starts the next one.
    const phaseRoom = await request<{ id: string }>("POST", "/api/rooms", {
      name: "分阶段关键回复",
      agentIds: [agent.id, mate.id],
      mainAgentId: agent.id,
    });
    store.insertMessage({
      roomId: phaseRoom.id,
      runId: "phase-stream-fixture",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "我",
      content: "实现订单 CSV 导出，并保留筛选和权限规则。",
      status: "done",
    });
    for (let index = 0; index < 12; index++)
      store.insertMessage({
        roomId: phaseRoom.id,
        runId: "phase-earlier-fixture",
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "Andy",
        content: `阶段回复之前的记录 ${index}`,
        status: "done",
      });
    const liveReply = store.insertMessage({
      roomId: phaseRoom.id,
      runId: "phase-stream-fixture",
      hop: 1,
      senderKind: "agent",
      senderId: agent.id,
      senderName: agent.name,
      content: "",
      status: "streaming",
    });
    let timeline = emptyTimeline();
    store.updateReply(liveReply.id, { content: "", status: "streaming", timeline });
    await page.goto(`${base}/#/c/${phaseRoom.id}`);
    await page.reload();
    await page.getByRole("heading", { name: "分阶段关键回复", exact: true }).waitFor();
    const liveRow = page.locator(`[data-message-id="${liveReply.id}"]`);
    await liveRow.getByText("正在处理", { exact: true }).waitFor();
    const update = async (event: acp.SessionUpdate) => {
      if (!liveSocket) throw new Error("phase fixture did not connect its live socket");
      timeline = applyUpdate(timeline, event);
      liveSocket.send(JSON.stringify({ type: "update", roomId: phaseRoom.id, messageId: liveReply.id, update: event }));
      // Observe the resulting frame before checking that an invisible process did not add a bubble.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    };
    const chunk = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "内部处理" } });
    if (await liveRow.locator("[data-reply-phase]").count())
      throw new Error("internal activity created an empty phase");
    await chunk("我先确认订单列表的筛选条件");
    const firstBubble = liveRow.locator("[data-reply-phase]").first();
    await firstBubble.waitFor();
    const firstElement = await firstBubble.elementHandle();
    await chunk("与权限边界。\n\n会保留现有筛选结果，并检查导出的中文编码。");
    await firstBubble.getByText("会保留现有筛选结果，并检查导出的中文编码。", { exact: true }).waitFor();
    await update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEAAAAABJRU5ErkJggg==",
      },
    });
    await firstBubble.locator("img").waitFor();
    if ((await liveRow.locator("[data-reply-phase]").count()) !== 1)
      throw new Error("streaming chunks, paragraphs or adjacent images split one phase");
    await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "内部核对" } });
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "phase-handoff",
      title: "handoff",
      status: "completed",
      kind: "other",
    });
    await chunk("筛选与权限规则已确认，正在实现流式导出。");
    await liveRow.locator("[data-reply-phase]").nth(1).waitFor();
    const phaseRows = liveRow.locator(".compact-phase-row");
    const phaseMenu = page.getByRole("dialog", { name: "消息操作", exact: true });
    await phaseRows.first().getByRole("button", { name: "更多消息操作", exact: true }).focus();
    await page.keyboard.press("Enter");
    await phaseMenu.waitFor();
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "phase-verify",
      title: "内部验证",
      status: "completed",
      kind: "execute",
    });
    await chunk(" ");
    if ((await liveRow.locator("[data-reply-phase]").count()) !== 2)
      throw new Error("a tool or whitespace chunk created an empty phase");
    await chunk("导出实现和针对性验证已完成，真实环境压测仍需在上线前完成。");
    const bubbles = liveRow.locator("[data-reply-phase]");
    await bubbles.nth(2).waitFor();
    if (!(await firstBubble.evaluate((element, original) => element === original, firstElement)))
      throw new Error("later phases replaced the first bubble's DOM identity");
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll(`[data-message-id="${id}"] [data-reply-phase]`)].every((bubble) =>
          bubble.getAnimations().every((animation) => animation.playState !== "running"),
        ),
      liveReply.id,
    );
    const boxes = await bubbles.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          background: style.backgroundColor,
          radius: style.borderTopLeftRadius,
        };
      }),
    );
    if (
      boxes.some(
        (box, index) =>
          box.background === "rgba(0, 0, 0, 0)" ||
          box.radius === "0px" ||
          (index > 0 &&
            (box.top < (boxes[index - 1]?.bottom ?? 0) + 4 || Math.abs(box.left - (boxes[0]?.left ?? 0)) > 1)),
      )
    )
      throw new Error(`phase bubbles lost their surfaces, spacing or alignment: ${JSON.stringify(boxes)}`);
    if ((await liveRow.getByRole("button", { name: "更多消息操作", exact: true }).count()) !== 3)
      throw new Error("each phase needs exactly one local action set");
    if (!(await phaseMenu.isVisible())) throw new Error("appending a phase closed an earlier phase's action menu");
    const phaseBodies = [
      "我先确认订单列表的筛选条件与权限边界。\n\n会保留现有筛选结果，并检查导出的中文编码。",
      "筛选与权限规则已确认，正在实现流式导出。",
      " 导出实现和针对性验证已完成，真实环境压测仍需在上线前完成。",
    ];
    await phaseMenu.getByRole("button", { name: "复制内容", exact: true }).click();
    await phaseMenu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
    if ((await page.evaluate(() => navigator.clipboard.readText())) !== phaseBodies[0])
      throw new Error("a streaming phase copied the rest of its reply");
    await page.keyboard.press("Escape");
    timeline.handoffs = [{ agentId: mate.id, agentName: mate.name, task: "核对导出结果" }];
    const completed = store.updateReply(liveReply.id, { content: timelineText(timeline), timeline, status: "done" });
    liveSocket?.send(JSON.stringify({ type: "message", message: completed }));
    await liveRow.locator('.msg[data-status="done"]').waitFor();
    await page.reload();
    await bubbles.nth(2).waitFor();
    if ((await bubbles.count()) !== 3) throw new Error("history reload merged the separate phase bubbles");
    const expectPhaseHighlight = async (index: number) => {
      await page.waitForFunction(
        ({ id, text }) => {
          const highlights = [...document.querySelectorAll<HTMLElement>("[data-message-body][data-source-highlight]")];
          return (
            highlights.length > 0 &&
            highlights.every((body) => body.closest("[data-message-id]")?.getAttribute("data-message-id") === id) &&
            highlights
              .map((body) => body.textContent)
              .join("")
              .replace(/\s+/g, " ")
              .trim() === text
          );
        },
        { id: liveReply.id, text: (phaseBodies[index] ?? "").replace(/\s+/g, " ").trim() },
      );
      const highlighted = liveRow.locator("[data-message-body][data-source-highlight]");
      if ((await highlighted.locator("img").count()) !== (index === 0 ? 1 : 0))
        throw new Error("quote navigation highlighted images outside the selected phase");
      if (await liveRow.locator(".thought[data-source-highlight], .tool[data-source-highlight]").count())
        throw new Error("quote navigation highlighted hidden process details");
    };
    for (let index = 0; index < phaseBodies.length; index++) {
      const phase = phaseRows.nth(index);
      await input.focus();
      await phase.hover();
      await page.waitForFunction(
        ({ id, index }) =>
          [...document.querySelectorAll(`[data-message-id="${id}"] .compact-phase-row .message-actions`)].every(
            (actions, at) => Number(getComputedStyle(actions).opacity) === (at === index ? 1 : 0),
          ),
        { id: liveReply.id, index },
      );
      await phase.getByRole("button", { name: "更多消息操作", exact: true }).click();
      await phaseMenu.getByRole("button", { name: "复制内容", exact: true }).click();
      await phaseMenu.getByRole("status").filter({ hasText: "已复制内容" }).waitFor();
      if ((await page.evaluate(() => navigator.clipboard.readText())) !== phaseBodies[index])
        throw new Error(`phase ${index + 1} copied a different bubble or the whole reply`);
      await page.keyboard.press("Escape");
      await phase.getByRole("button", { name: "引用回复", exact: true }).click();
      const excerpt = page.getByTestId("composer-quote").locator(".message-quote-text");
      const expected = phaseBodies[index]?.replace(/\s+/g, " ").trim();
      if ((await excerpt.textContent()) !== expected) throw new Error(`phase ${index + 1} quoted another bubble`);
      await input.fill("跳转后保留的草稿");
      const quoteLink = page.getByTestId("composer-quote").locator(".message-quote-link");
      if (index === 1) await quoteLink.press("Enter");
      else await quoteLink.click();
      await expectPhaseHighlight(index);
      if ((await input.inputValue()) !== "跳转后保留的草稿" || (await excerpt.textContent()) !== expected)
        throw new Error("quote navigation changed the draft or selected excerpt");
      await page.getByRole("button", { name: "取消引用", exact: true }).click();
      await input.fill("");
    }
    const selectedPhase = phaseRows.nth(1);
    const selectedIndex = Number(await selectedPhase.locator("[data-reply-phase]").getAttribute("data-reply-phase"));
    await selectedPhase.hover();
    await selectedPhase.getByRole("button", { name: "引用回复", exact: true }).click();
    const phaseEndpoint = `${base}/api/rooms/${phaseRoom.id}/messages`;
    let selectedRequest: { replyToId?: string; replyToPartIndex?: number } | undefined;
    await page.route(phaseEndpoint, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      selectedRequest = route.request().postDataJSON();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "阶段引用暂时失败" }),
      });
    });
    expectedUnavailable = true;
    await input.fill("请只针对引用的这一段继续。");
    await input.press("Enter");
    await page.getByRole("alert").filter({ hasText: "阶段引用暂时失败" }).waitFor();
    if (selectedRequest?.replyToId !== liveReply.id || selectedRequest.replyToPartIndex !== selectedIndex)
      throw new Error("phase send omitted or changed its original part reference");
    if ((await page.getByTestId("composer-quote").locator(".message-quote-text").textContent()) !== phaseBodies[1])
      throw new Error("failed send replaced the selected phase quote");
    await page.unroute(phaseEndpoint);
    expectedUnavailable = false;
    const savedReply = page.waitForResponse(
      (response) => response.url() === phaseEndpoint && response.request().method() === "POST",
    );
    await input.press("Enter");
    const savedResponse = await savedReply;
    if (savedResponse.status() !== 201) throw new Error(`phase quote send failed: ${savedResponse.status()}`);
    const quotedMessage = (await savedResponse.json()) as Message;
    if (quotedMessage.quote?.partIndex !== selectedIndex || quotedMessage.quote.text !== phaseBodies[1])
      throw new Error("server broadened the selected phase into a whole-reply quote");
    await page.reload();
    const savedQuote = page.locator(`[data-message-id="${quotedMessage.id}"] .message-quote-text`);
    await savedQuote.waitFor();
    if ((await savedQuote.textContent()) !== phaseBodies[1]) throw new Error("phase quote changed after refresh");
    await savedQuote.click();
    await expectPhaseHighlight(1);
    await page.getByRole("button", { name: "展开详情面板" }).click();
    await page.getByRole("tab", { name: "详情", exact: true }).click();
    await densitySwitch.uncheck();
    await densitySettled();
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click();
    await savedQuote.click();
    await expectPhaseHighlight(1);
    if (await liveRow.locator(".tool").getByText("handoff", { exact: true }).count())
      throw new Error("preserving phase indices exposed the duplicate handoff tool");
    await page.getByRole("button", { name: "展开详情面板" }).click();
    await page.getByRole("tab", { name: "详情", exact: true }).click();
    await densitySwitch.check();
    await densitySettled();
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click();

    // The selected bubble can live outside the first history page; keep its exact phase through pagination.
    // Explicitly resume Latest; otherwise refresh now restores the saved old-phase reading anchor by paging.
    await page.getByRole("button", { name: "回到最新消息", exact: true }).click();
    for (let index = 0; index < 205; index++)
      store.insertMessage({
        roomId: phaseRoom.id,
        runId: "phase-later-fixture",
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "Andy",
        content: `阶段回复之后的记录 ${index}`,
        status: "done",
      });
    const historicalQuote = store.insertMessage({
      roomId: phaseRoom.id,
      runId: "phase-history-quote",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "Andy",
      content: "回看第二段关键回复",
      status: "done",
      replyToId: liveReply.id,
      replyToPartIndex: selectedIndex,
    });
    await page.reload();
    const historicalLink = page.locator(`[data-message-id="${historicalQuote.id}"] .message-quote-link`);
    await historicalLink.waitFor();
    if (await liveRow.count()) throw new Error("quoted phase was not outside the loaded history page");
    await historicalLink.click();
    await expectPhaseHighlight(1);
    await page
      .waitForFunction(
        ({ id, phase }) => {
          const list = document.querySelector(".messages")?.getBoundingClientRect();
          const bubble = document
            .querySelector(`[data-message-id="${id}"] [data-reply-phase="${phase}"]`)
            ?.getBoundingClientRect();
          return list && bubble && Math.abs(bubble.top + bubble.height / 2 - list.top - list.height / 2) < 3;
        },
        { id: liveReply.id, phase: selectedIndex },
        { timeout: 5000 },
      )
      .catch(async (error) => {
        const position = await liveRow.evaluate((row, phase) => {
          const list = row.closest(".messages") as HTMLElement;
          const bubble = row.querySelector(`[data-reply-phase="${phase}"]`) as HTMLElement;
          return {
            list: list.getBoundingClientRect().toJSON(),
            row: row.getBoundingClientRect().toJSON(),
            bubble: bubble?.getBoundingClientRect().toJSON(),
            top: list.scrollTop,
            max: list.scrollHeight - list.clientHeight,
            focus: document.activeElement?.outerHTML.slice(0, 300),
          };
        }, selectedIndex);
        await shot("quote-source-position-failure");
        throw new Error(`quoted bubble did not reach the reading position: ${JSON.stringify(position)}`, {
          cause: error,
        });
      });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await historicalLink.click();
    await expectPhaseHighlight(1);
    // The shared reduce rule uses 0.01ms CSS transitions; check rendered frames, not same-tick objects.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const reducedHighlight = await liveRow.locator("[data-source-highlight]").evaluateAll((elements) => ({
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animations: elements.flatMap((element) =>
        element.getAnimations().map((animation) => ({
          type: animation.constructor.name,
          state: animation.playState,
          frames: (animation.effect as KeyframeEffect | null)?.getKeyframes(),
        })),
      ),
    }));
    if (!reducedHighlight.reduced || reducedHighlight.animations.some((animation) => animation.state === "running"))
      throw new Error(`quote highlight animated with reduced motion: ${JSON.stringify(reducedHighlight)}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await shot("compact-phase-bubbles");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
      throw new Error("phase bubbles overflow the narrow viewport");
    await shot("compact-phase-bubbles-narrow");
    if (errors.length) throw new Error(`browser console errors:\n${errors.join("\n")}`);
  } finally {
    await page.close();
  }
}
