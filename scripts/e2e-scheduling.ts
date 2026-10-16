import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import type { Agent, Room, SessionView } from "../web/src/api";
import type { ChatSnapshot } from "../web/src/chatState";

function replyDisclosure(page: Page, panel: Locator) {
  const disclosure = panel.locator(".chat-task-disclosure");
  const expand = panel.getByRole("button", { name: "展开回复状态", exact: true });
  const collapse = panel.getByRole("button", { name: "收起回复状态", exact: true });
  const settled = async (expanded: boolean) =>
    page.waitForFunction((expected) => {
      const element = document.querySelector<HTMLElement>(".chat-task-disclosure");
      if (!element || element.getAnimations().some((animation) => animation.playState === "running")) return false;
      const height = element.getBoundingClientRect().height;
      return expected ? height > 1 : height < 0.5;
    }, expanded);
  const assertCollapsed = async () => {
    await expand.waitFor();
    if ((await expand.getAttribute("aria-controls")) !== (await disclosure.getAttribute("id")))
      throw new Error("reply disclosure toggle lost its controlled region");
    if ((await expand.getAttribute("aria-expanded")) !== "false")
      throw new Error("reply status is not marked collapsed");
    if (!(await disclosure.evaluate((el) => el.hasAttribute("inert") && el.getAttribute("aria-hidden") === "true")))
      throw new Error("closed reply disclosure remains interactive or exposed to accessibility");
    await settled(false);
    if (
      (await disclosure.locator("ul.chat-task-list").count()) !== 1 ||
      !(await disclosure.locator("[data-task-id]").count())
    )
      throw new Error("closing unmounted the live task list");
    if (
      await disclosure.evaluate((el) => {
        const button = el.querySelector<HTMLButtonElement>("button:not(:disabled)");
        button?.focus();
        return !!button && document.activeElement === button;
      })
    )
      throw new Error("a closed task action accepted focus");
  };
  const expandTasks = async () => {
    if (await expand.count()) await expand.click();
    await collapse.waitFor();
    if ((await collapse.getAttribute("aria-expanded")) !== "true")
      throw new Error("reply status is not marked expanded");
    await settled(true);
    if (!(await disclosure.evaluate((el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true")))
      throw new Error("open reply disclosure remains inert");
  };
  const beginMotion = async () =>
    page.evaluate(() => {
      const state = { frames: [] as { height: number; full: number; at: number }[] };
      const win = window as typeof window & { replyMotion?: typeof state };
      win.replyMotion = state;
      const tick = (at: number) => {
        if (win.replyMotion !== state) return;
        const element = document.querySelector<HTMLElement>(".chat-task-disclosure");
        const list = element?.querySelector<HTMLElement>(".chat-task-list");
        if (element && list)
          state.frames.push({
            height: element.getBoundingClientRect().height,
            full: list.getBoundingClientRect().height,
            at,
          });
        requestAnimationFrame(tick);
      };
      tick(performance.now());
    });
  const finishMotion = async (label: string, animated: boolean, minimumFrames = 2) => {
    const frames = await page.evaluate(() => {
      const win = window as typeof window & {
        replyMotion?: { frames: { height: number; full: number; at: number }[] };
      };
      const frames = win.replyMotion?.frames ?? [];
      delete win.replyMotion;
      return frames;
    });
    const middle = frames.filter((frame) => frame.height > 1 && frame.height < frame.full - 1);
    if (animated && middle.length < minimumFrames) throw new Error(`${label} jumped without intermediate heights`);
    if (!animated && middle.length) throw new Error(`${label} animated with reduced motion`);
    if (Math.max(...frames.map((frame) => frame.full)) - Math.min(...frames.map((frame) => frame.full)) > 1)
      throw new Error(`${label} resized the list instead of clipping it`);
    console.log(`reply disclosure ${label}: ${middle.length} intermediate frames`);
  };
  return { disclosure, expand, collapse, settled, assertCollapsed, expandTasks, beginMotion, finishMotion };
}

async function assertParticipants(
  panel: Locator,
  expected: { id: string; name: string; status: RegExp; queued?: number }[],
) {
  const participants = panel.locator(".chat-activity-toggle .chat-activity-agent");
  const actual = await participants.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute("data-agent-id"),
      text: (element as HTMLElement).innerText,
      avatars: element.querySelectorAll(".avatar").length,
      visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
    })),
  );
  if (actual.length !== expected.length || new Set(actual.map((item) => item.id)).size !== actual.length)
    throw new Error(`compact participants are missing or duplicated: ${JSON.stringify(actual)}`);
  for (const agent of expected) {
    const item = actual.find((value) => value.id === agent.id);
    if (!item?.visible || item.avatars !== 1 || !item.text.includes(agent.name) || !agent.status.test(item.text))
      throw new Error(
        `compact participant lost its avatar/name/state: ${JSON.stringify({ agent: agent.name, actual })}`,
      );
    if (agent.queued && !new RegExp(`(?:${agent.queued}\\s*项?\\s*排队|排队\\s*${agent.queued})`).test(item.text))
      throw new Error(`queued count is not attached to ${agent.name}: ${item.text}`);
  }
}

/** Real HTTP/WS + mock ACP. The caller provides an onboarded, idle group with two mock Agents. */
export async function schedulingSmoke(browser: Browser, base: string, roomId: string, shotsDir?: string) {
  const videoDir = process.env.SCHEDULING_VIDEO_DIR;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    hasTouch: true,
    colorScheme: "light",
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } } : {}),
  });
  const video = page.video();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let disconnect: () => Promise<void> = async () => {
    throw new Error("scheduling websocket is not connected");
  };
  await page.routeWebSocket(`${base.replace("http", "ws")}/ws`, (socket) => {
    socket.connectToServer();
    disconnect = () => socket.close({ code: 1012, reason: "scheduling reconnect regression" });
  });
  const endpoint = `${base}/api/rooms/${roomId}/messages`;
  const cancelEndpoint = `${base}/api/rooms/${roomId}/cancel`;
  const rooms = (await (await fetch(`${base}/api/rooms`)).json()) as Room[];
  const room = rooms.find((r) => r.id === roomId);
  if (room?.kind !== "group" || room.agentIds.length !== 2) throw new Error("scheduling smoke needs a two-Agent group");
  const aId = room.mainAgentId ?? (room.agentIds[0] as string);
  const bId = room.agentIds.find((id) => id !== aId) as string;
  const history = async () => (await (await fetch(endpoint)).json()) as ChatSnapshot;
  const waitState = async (matches: (snapshot: ChatSnapshot) => boolean, label: string) => {
    const end = Date.now() + 25_000;
    for (;;) {
      const snapshot = await history();
      if (matches(snapshot)) return snapshot;
      if (Date.now() > end) throw new Error(`scheduling timeout: ${label}: ${JSON.stringify(snapshot.state)}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const config = async (agentId: string, value: string) => {
    const response = await fetch(`${base}/api/rooms/${roomId}/agents/${agentId}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configId: "model", value }),
    });
    if (!response.ok) throw new Error(`mock model config failed: ${response.status}`);
  };
  const previousModels = new Map<string, string>();
  const replyStatus = page.getByRole("region", { name: "会话任务", exact: true });
  const {
    disclosure,
    expand: expandStatus,
    collapse: collapseStatus,
    settled,
    assertCollapsed,
    expandTasks,
    beginMotion,
    finishMotion,
  } = replyDisclosure(page, replyStatus);
  const taskRow = (id: string) => page.locator(`[data-task-id="${id}"]`);
  const input = page.getByRole("textbox", { name: "消息输入框" });
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入框"]')?.value === "",
    );
  };
  try {
    if ((await history()).state.tasks.length) throw new Error("scheduling smoke requires an idle group");
    for (const id of room.agentIds) {
      const view = (await (await fetch(`${base}/api/rooms/${roomId}/agents/${id}/session`)).json()) as SessionView;
      const model = view.configOptions.find((option) => option.id === "model");
      previousModels.set(id, model?.type === "select" ? model.currentValue : "mock-fast");
      await config(id, "mock-stuck");
    }
    await page.goto(`${base}/#/c/${roomId}`);
    await send("@所有人 并行任务第一轮");
    const parallel = await waitState(
      (s) => s.state.tasks.length === 2 && s.state.tasks.every((t) => t.status === "running" && !!t.messageId),
      "two Agents running in parallel",
    );
    const a = parallel.state.tasks.find((t) => t.agentId === aId);
    const b = parallel.state.tasks.find((t) => t.agentId === bId);
    if (!a || !b) throw new Error("parallel tasks lost an Agent");
    await assertCollapsed();
    await assertParticipants(replyStatus, [
      { id: aId, name: a.agentName, status: /回复/ },
      { id: bId, name: b.agentName, status: /回复/ },
    ]);
    const listNode = await disclosure.locator("ul.chat-task-list").elementHandle();
    await beginMotion();
    await expandStatus.focus();
    await page.keyboard.press("Enter");
    await expandTasks();
    await finishMotion("expand", true);
    await taskRow(a.id).getByText("回复中", { exact: true }).waitFor();
    await taskRow(b.id).getByText("回复中", { exact: true }).waitFor();
    if (
      (await taskRow(a.id).locator(".avatar").count()) !== 1 ||
      (await taskRow(b.id).locator(".avatar").count()) !== 1
    )
      throw new Error("expanded rows lost their Agent avatars");
    await beginMotion();
    await collapseStatus.focus();
    await page.keyboard.press("Space");
    await assertCollapsed();
    await finishMotion("collapse", true);
    if (
      !(await disclosure.locator("ul.chat-task-list").evaluate((element, original) => element === original, listNode))
    )
      throw new Error("disclosure replaced its task list during collapse");
    await expandTasks();
    if (await page.getByRole("button", { name: "停止", exact: true }).count())
      throw new Error("ambiguous composer stop exists for parallel tasks");
    if (await page.getByLabel("发送会打断当前回复").count()) throw new Error("obsolete interrupt warning remains");

    await send(`@${a.agentName} 排队请求待取消`);
    console.log("scheduling: parallel Agents visible; queuing another request");
    const queued = await waitState(
      (s) => s.state.tasks.some((t) => t.status === "queued"),
      "busy Agent queues without interrupting",
    );
    const queuedTask = queued.state.tasks.find((t) => t.status === "queued");
    if (
      !queuedTask ||
      !queued.state.tasks.some((t) => t.id === a.id && t.status === "running") ||
      !queued.state.tasks.some((t) => t.id === b.id && t.status === "running")
    )
      throw new Error("new message interrupted existing tasks");
    await taskRow(queuedTask.id).getByText("排队中", { exact: true }).waitFor();
    await collapseStatus.click();
    await assertCollapsed();
    await assertParticipants(replyStatus, [
      { id: aId, name: a.agentName, status: /回复/, queued: 1 },
      { id: bId, name: b.agentName, status: /回复/ },
    ]);
    // Both keyboard and pointer paths stay reversible, and collapse immediately removes task controls from focus.
    await expandTasks();
    await taskRow(a.id).getByRole("button", { name: "停止任务", exact: true }).focus();
    await collapseStatus.evaluate((element) => (element as HTMLButtonElement).click());
    if (!(await expandStatus.evaluate((element) => element === document.activeElement)))
      throw new Error("collapsing did not return focus from a task action to its toggle");
    await assertCollapsed();
    const closedAction = disclosure.locator("button:not(:disabled)").first();
    let actionable = false;
    try {
      await closedAction.click({ trial: true, timeout: 150 });
      actionable = true;
    } catch {}
    if (actionable) throw new Error("closed task action remained pointer-accessible");
    await expandStatus.focus();
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => !!document.activeElement?.closest(".chat-task-disclosure")))
      throw new Error("Tab entered a closed reply disclosure");
    await expandTasks();
    const full = await disclosure.evaluate((element) => element.getBoundingClientRect().height);
    for (let attempt = 0; attempt < 2; attempt++) {
      await collapseStatus.click();
      await page.waitForFunction((target) => {
        const height = document.querySelector(".chat-task-disclosure")?.getBoundingClientRect().height ?? 0;
        return height > target * 0.35 && height < target * 0.75;
      }, full);
      const before = await disclosure.evaluate((element) => element.getBoundingClientRect().height);
      await page.keyboard.press("Enter");
      const after = await disclosure.evaluate(
        (element) =>
          new Promise<number>((resolve) =>
            requestAnimationFrame(() => resolve(element.getBoundingClientRect().height)),
          ),
      );
      if (after < 1 || after >= full || Math.abs(after - before) > full * 0.4)
        throw new Error("reply disclosure reversal jumped to an endpoint");
      await settled(true);
    }
    const messages = page.locator(".messages");
    await collapseStatus.click();
    await assertCollapsed();
    await messages.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expandTasks();
    if (await messages.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight > 3))
      throw new Error("expanding reply status lost chat bottom anchoring");
    await collapseStatus.click();
    await assertCollapsed();
    if (await messages.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight > 3))
      throw new Error("collapsing reply status lost chat bottom anchoring");
    if (await messages.evaluate((element) => element.scrollHeight - element.clientHeight > 80)) {
      await messages.evaluate((element) => {
        element.scrollTop = Math.min(60, (element.scrollHeight - element.clientHeight) / 4);
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const readingTop = await messages.evaluate((element) => element.scrollTop);
      await expandTasks();
      await collapseStatus.click();
      await assertCollapsed();
      if (Math.abs((await messages.evaluate((element) => element.scrollTop)) - readingTop) > 2)
        throw new Error("reply disclosure moved the reader's history position");
    }
    await beginMotion();
    await expandStatus.click();
    await page.waitForFunction((target) => {
      const height = document.querySelector(".chat-task-disclosure")?.getBoundingClientRect().height ?? 0;
      return height > 1 && height < target - 1;
    }, full);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settled(true);
    if (
      await disclosure.evaluate((element) =>
        element.getAnimations().some((animation) => animation.playState === "running"),
      )
    )
      throw new Error("changing reduced motion mid-transition left an active animation");
    await finishMotion("interrupted by reduced motion", true, 1);
    await beginMotion();
    await collapseStatus.click();
    await assertCollapsed();
    await finishMotion("reduced-motion collapse", false);
    await beginMotion();
    await expandTasks();
    await finishMotion("reduced-motion expand", false);
    await collapseStatus.click();
    await assertCollapsed();
    const dots = replyStatus.locator(".chat-activity-dots i");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedAnimations = await dots.evaluateAll((items) =>
      items.map((item) => getComputedStyle(item).animationName),
    );
    if (!reducedAnimations.length || reducedAnimations.some((animation) => animation !== "none"))
      throw new Error("compact reply dots still animate with reduced motion");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    if (await dots.evaluateAll((items) => items.some((item) => getComputedStyle(item).animationName === "none")))
      throw new Error("compact reply dots did not resume after restoring motion preference");
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-compact.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("compact reply status overflows narrow viewport");
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-compact-narrow.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expandTasks();
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "group-scheduling.png"), animations: "disabled" });
    const lightPaper = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      (light) => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() !== light,
      lightPaper,
    );
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "group-scheduling-dark.png"), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("task UI overflows narrow viewport");
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-narrow.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1000 });

    let failedAttempts = 0;
    await page.route(cancelEndpoint, async (route) => {
      failedAttempts++;
      if (route.request().postDataJSON().taskId !== queuedTask.id)
        throw new Error("cancel omitted the selected taskId");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "定向取消暂时失败" }),
      });
    });
    await taskRow(queuedTask.id).getByRole("button", { name: "取消排队", exact: true }).click();
    await page.keyboard.press("Enter");
    await taskRow(queuedTask.id).getByRole("alert").filter({ hasText: "定向取消暂时失败" }).waitFor();
    if (failedAttempts !== 1) throw new Error("cancel task was submitted twice while pending");
    await page.unroute(cancelEndpoint);
    await taskRow(queuedTask.id).getByRole("button", { name: "取消排队", exact: true }).click();
    const afterQueueCancel = await waitState(
      (s) => s.state.tasks.length === 2 && !s.state.tasks.some((t) => t.id === queuedTask.id),
      "queued cancel preserves running tasks",
    );
    if (!afterQueueCancel.state.tasks.every((t) => t.id === a.id || t.id === b.id))
      throw new Error("queued cancel replaced an unrelated task");
    await taskRow(queuedTask.id).waitFor({ state: "hidden" });
    console.log("scheduling: queued cancellation retry preserved both running tasks");

    await send(`@${a.agentName} 独立排队请求第二轮`);
    const second = (
      await waitState((s) => s.state.tasks.some((t) => t.status === "queued"), "second independent task queues")
    ).state.tasks.find((t) => t.status === "queued");
    if (!second) throw new Error("missing second task");
    await taskRow(a.id).getByRole("button", { name: "停止任务", exact: true }).click();
    await taskRow(a.id).getByText("停止中", { exact: true }).waitFor();
    const continued = await waitState(
      (s) =>
        !s.state.tasks.some((t) => t.id === a.id) &&
        s.state.tasks.some((t) => t.id === second.id && t.status === "running"),
      "independent queued task survives stop and runs next",
    );
    if (!continued.state.tasks.some((t) => t.id === b.id && t.status === "running"))
      throw new Error("stopping A stopped B");
    await taskRow(b.id).getByText("回复中", { exact: true }).waitFor();
    await taskRow(second.id).getByText("回复中", { exact: true }).waitFor();
    await taskRow(b.id).getByRole("button", { name: "停止任务", exact: true }).click();
    await waitState(
      (s) => s.state.tasks.length === 1 && s.state.tasks[0]?.id === second.id,
      "stopping B preserves A's next task",
    );
    console.log("scheduling: targeted stops preserved independent task; reloading");
    await page.reload();
    await assertCollapsed();
    await assertParticipants(replyStatus, [{ id: second.agentId, name: second.agentName, status: /回复/ }]);
    await page.getByRole("button", { name: "停止", exact: true }).waitFor(); // Safe single-task composer shortcut.
    const compactStop = replyStatus.getByRole("button", { name: "停止任务", exact: true });
    let compactAttempts = 0;
    await page.route(cancelEndpoint, async (route) => {
      compactAttempts++;
      if (route.request().postDataJSON().taskId !== second.id)
        throw new Error("compact stop omitted the single taskId");
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "快捷停止暂时失败" }),
      });
    });
    await compactStop.click();
    const compactError = replyStatus.getByRole("alert").filter({ hasText: "快捷停止暂时失败" });
    await compactError.waitFor();
    if (!(await compactError.innerText()).includes(second.agentName))
      throw new Error("compact stop failure lost the Agent name");
    if (compactAttempts !== 1 || (await compactStop.isDisabled()))
      throw new Error("failed compact stop cannot be retried");
    await assertCollapsed();
    if (!(await history()).state.tasks.some((task) => task.id === second.id && task.status === "running"))
      throw new Error("failed compact stop removed the running task");
    await page.unroute(cancelEndpoint);
    await expandTasks();
    await taskRow(second.id).getByText("回复中", { exact: true }).waitFor();
    if ((await page.locator("[data-task-id]").count()) !== 1) throw new Error("reload restored a completed task");
    await collapseStatus.click();
    await assertCollapsed();

    // A snapshot captured before cancellation cannot restore the task after the live event removes it.
    const stale = await history();
    let releaseSnapshot: () => void = () => {};
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotHeld = false;
    await page.route(`${endpoint}?*`, async (route) => {
      snapshotHeld = true;
      await snapshotGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
    });
    await disconnect();
    const heldEnd = Date.now() + 10_000;
    while (!snapshotHeld) {
      if (Date.now() > heldEnd) throw new Error("slow snapshot fixture was not requested");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await compactStop.click(); // Existing tasks remain usable and failed stops can retry while reconnecting.
    await waitState((s) => s.state.tasks.length === 0, "final task stops");
    await replyStatus.waitFor({ state: "detached" });
    const deliveredSnapshot = page.waitForResponse(
      (response) => response.url().startsWith(`${endpoint}?`) && response.request().method() === "GET",
    );
    releaseSnapshot();
    await deliveredSnapshot;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.unroute(`${endpoint}?*`);
    // A new draft proves the composer stays available after the stale response is delivered.
    await input.fill("后续消息仍可发送");
    if (await page.locator("[data-task-id]").count()) throw new Error("slow snapshot resurrected a cancelled task");
    if (await replyStatus.count()) throw new Error("slow snapshot restored an idle reply status panel");

    // A completed source stays visible while its handoff runs; stopping it addresses that subtree.
    await config(aId, "mock-fast");
    await send(`/handoff ${b.agentName} 交接中的任务需要独立停止`);
    const handoff = await waitState(
      (s) =>
        s.state.tasks.some((t) => t.status === "waiting") &&
        s.state.tasks.some((t) => t.parentTaskId !== null && t.status === "running"),
      "handoff ancestor remains visible",
    );
    const source = handoff.state.tasks.find((t) => t.status === "waiting");
    const child = handoff.state.tasks.find((t) => t.parentTaskId === source?.id);
    if (!source || !child) throw new Error("handoff lost source task ownership");
    await assertCollapsed();
    await assertParticipants(replyStatus, [
      { id: source.agentId, name: source.agentName, status: /等待|统筹|交接/ },
      { id: child.agentId, name: child.agentName, status: /回复/ },
    ]);
    const participantOrder = await replyStatus
      .locator(".chat-activity-agent")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-agent-id")));
    if (participantOrder[0] !== child.agentId)
      throw new Error("waiting participant displaced an actively replying Agent");
    await expandTasks();
    await taskRow(source.id).getByText("统筹中", { exact: true }).waitFor();
    await taskRow(child.id).getByText("回复中", { exact: true }).waitFor();
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-handoff.png"), animations: "disabled" });
    await taskRow(source.id).getByRole("button", { name: "停止任务", exact: true }).click();
    await waitState((s) => s.state.tasks.length === 0, "stopping handoff source cancels its descendant");
    await taskRow(child.id).waitFor({ state: "hidden" });
    await replyStatus.waitFor({ state: "detached" });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("task UI overflows narrow viewport");
    await participantOverflowSmoke(browser, base, room.projectId, shotsDir);
    await coordinationSmoke(browser, base, room.projectId, shotsDir);
    if (errors.length) throw new Error(`scheduling browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS task scheduling: compact reply status, keyboard disclosure, parallel Agents, per-Agent queue, targeted/compact stop retry, independent task survives, refresh/slow snapshot, handoff subtree, group leader results and summary",
    );
  } catch (error) {
    if (shotsDir)
      await page
        .screenshot({ path: join(shotsDir, "group-scheduling-failure.png"), animations: "disabled" })
        .catch(() => {});
    throw error;
  } finally {
    await page.close();
    if (video && videoDir) {
      await video.saveAs(join(videoDir, "reply-status-motion.webm"));
      await video.delete();
    }
    const remaining = (await history()).state.tasks;
    await Promise.all(
      remaining.map((task) =>
        fetch(cancelEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: task.id }),
        }),
      ),
    );
    await waitState((s) => s.state.tasks.length === 0, "cleanup");
    for (const [id, model] of previousModels) await config(id, model);
  }
}

/** Four real active mock sessions exercise the visible cap and accessible overflow without changing the caller's room. */
async function participantOverflowSmoke(browser: Browser, base: string, projectId: string | null, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const agents: Agent[] = [];
  let room: Room | undefined;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`overflow fixture failed: ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const waitEmpty = async (endpoint: string) => {
    const end = Date.now() + 25_000;
    while (((await (await fetch(endpoint)).json()) as ChatSnapshot).state.tasks.length) {
      if (Date.now() > end) throw new Error("overflow fixture cleanup timed out");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  try {
    const suffix = crypto.randomUUID().slice(0, 4);
    for (let i = 1; i <= 4; i++)
      agents.push(
        await post<Agent>("agents", {
          name: `Peer${i}${suffix}`,
          harness: "mock",
          configDefaults: { model: "mock-stuck" },
        }),
      );
    room = await post<Room>("rooms", {
      name: "参与者头像上限冒烟",
      agentIds: agents.map((agent) => agent.id),
      mainAgentId: agents[0]?.id,
      projectId: projectId ?? undefined,
    });
    await post(`rooms/${room.id}/messages`, { content: "@所有人 四位参与者保持独立回复" });
    const roomId = room.id;
    await page.goto(`${base}/#/c/${roomId}`);
    await page.waitForFunction(async (id) => {
      const snapshot = await (await fetch(`/api/rooms/${id}/messages`)).json();
      return (
        snapshot.state.tasks.length === 4 &&
        snapshot.state.tasks.every(
          (task: { status: string; messageId: string | null }) => task.status === "running" && !!task.messageId,
        )
      );
    }, roomId);
    const panel = page.getByRole("region", { name: "会话任务", exact: true });
    await replyDisclosure(page, panel).assertCollapsed();
    const visibleIds = await panel
      .locator(".chat-activity-agent")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-agent-id")));
    if (visibleIds.length !== 3 || new Set(visibleIds).size !== 3)
      throw new Error("reply summary did not cap distinct avatars at three");
    const visible = agents.filter((agent) => visibleIds.includes(agent.id));
    await assertParticipants(
      panel,
      visible.map((agent) => ({ id: agent.id, name: agent.name, status: /回复/ })),
    );
    const hidden = agents.find((agent) => !visibleIds.includes(agent.id));
    const overflow = panel.locator(".chat-activity-toggle .chat-activity-count[title]");
    if (
      !hidden ||
      !(await overflow.isVisible()) ||
      !(await overflow.getAttribute("title"))?.includes(hidden.name) ||
      !/还有\s*1\s*位 Agent/.test(await overflow.innerText())
    )
      throw new Error("additional participant count is not readable with its identity");
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-overflow.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("three participant summaries overflow the narrow viewport");
    await assertParticipants(
      panel,
      visible.map((agent) => ({ id: agent.id, name: agent.name, status: /回复/ })),
    );
  } finally {
    await page.close();
    if (room) {
      const id = room.id;
      const endpoint = `${base}/api/rooms/${id}/messages`;
      const snapshot = (await (await fetch(endpoint)).json()) as ChatSnapshot;
      await Promise.all(snapshot.state.tasks.map((task) => post(`rooms/${id}/cancel`, { taskId: task.id })));
      await waitEmpty(endpoint);
      await fetch(`${base}/api/rooms/${id}`, { method: "DELETE" });
    }
    for (const agent of agents) await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
  }
}

/** No @: the leader delegates through real MCP, receives both member results, then summarizes. */
export async function coordinationSmoke(browser: Browser, base: string, projectId: string | null, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const agentIds: string[] = [];
  let room: Room | undefined;
  // The leader's review turn is held open by the mock until we release it, so the transient
  // "正在跟进 / 跟进中" state is asserted deterministically instead of racing a ~100 ms reply.
  const reviewGate = join(mkdtempSync(join(tmpdir(), "tuantuan-review-gate-")), "release");
  const create = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`coordination fixture failed: ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const agent = async (name: string, member = false) => {
    const value = await create<Agent>("agents", {
      name,
      harness: "mock",
      configDefaults: { model: "mock-fast" },
      env: member ? { MOCK_AGENT_SESSION_DELAY_MS: "1400" } : { MOCK_AGENT_REVIEW_GATE: reviewGate },
    });
    agentIds.push(value.id);
    return value;
  };
  try {
    const suffix = crypto.randomUUID().slice(0, 4);
    const lead = await agent(`Lead${suffix}`);
    const left = await agent(`Left${suffix}`, true);
    const right = await agent(`Right${suffix}`, true);
    room = await create<Room>("rooms", {
      name: "群主统筹冒烟",
      agentIds: [lead.id, left.id, right.id],
      mainAgentId: lead.id,
      projectId: projectId ?? undefined,
    });
    const endpoint = `${base}/api/rooms/${room.id}/messages`;
    const waitState = async (matches: (snapshot: ChatSnapshot) => boolean, label: string) => {
      const end = Date.now() + 15_000;
      for (;;) {
        const snapshot = (await (await fetch(endpoint)).json()) as ChatSnapshot;
        if (matches(snapshot)) return snapshot;
        if (Date.now() > end) throw new Error(`coordination timeout: ${label}: ${JSON.stringify(snapshot.state)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await page.goto(`${base}/#/c/${room.id}`);
    await page.getByRole("heading", { name: room.name, exact: true }).waitFor();
    const title = await page.title();
    if (!page.url().endsWith(`/#/c/${room.id}`) || !title.includes("团团"))
      throw new Error("coordination page has the wrong identity");
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await input.fill(`/coordinate ${left.name} ${right.name}`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const delegated = await waitState(
      (snapshot) =>
        snapshot.state.tasks.some((task) => task.agentId === lead.id && task.status === "waiting") &&
        snapshot.state.tasks.filter((task) => task.coordination === "work" && task.status === "running").length === 2,
      "two delegated member tasks run while the leader waits",
    );
    const source = delegated.state.tasks.find((task) => task.agentId === lead.id && task.status === "waiting");
    if (!source) throw new Error("coordination lost its leader task");
    const status = page.getByRole("region", { name: "会话任务", exact: true });
    await assertParticipants(status, [
      { id: lead.id, name: lead.name, status: /等待|统筹/ },
      { id: left.id, name: left.name, status: /回复|准备/ },
      { id: right.id, name: right.name, status: /回复|准备/ },
    ]);
    await status.getByRole("button", { name: "展开回复状态", exact: true }).click();
    await page.locator(`[data-task-id="${source.id}"]`).getByText("统筹中", { exact: true }).waitFor();
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-coordination-waiting.png"), animations: "disabled" });
    await status.getByRole("button", { name: "收起回复状态", exact: true }).click();
    await status
      .locator(`.chat-activity-agent[data-agent-id="${lead.id}"]`)
      .getByText("正在跟进", { exact: true })
      .waitFor();
    await status.getByRole("button", { name: "展开回复状态", exact: true }).click();
    await page.locator('[data-task-status="running"]').getByText("跟进中", { exact: true }).waitFor();
    writeFileSync(reviewGate, "go");
    const completed = await waitState(
      (snapshot) =>
        snapshot.state.tasks.length === 0 &&
        snapshot.messages.some((message) => message.senderId === lead.id && message.timeline?.reviewOf?.length === 2),
      "leader summarizes after receiving both results",
    );
    const summary = completed.messages.find((message) => message.timeline?.reviewOf?.length === 2);
    if (
      !summary ||
      summary.senderId !== lead.id ||
      summary.status !== "done" ||
      !summary.content.startsWith("群主汇总：")
    )
      throw new Error("coordination did not finish with a leader summary");
    for (const member of [left, right]) {
      const result = completed.messages.find((message) => message.senderId === member.id && message.status === "done");
      if (!result || !summary.content.includes(`${member.name} [done]：${result.content}`))
        throw new Error(`coordination summary lost ${member.name}'s result`);
    }
    const summaryMessage = page.locator(`[data-message-id="${summary.id}"]`);
    await summaryMessage.getByText("群主跟进 · 已收到 2 份成员结果", { exact: true }).waitFor();
    await summaryMessage.getByText(/群主汇总/).waitFor();
    await status.waitFor({ state: "detached" });
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-coordination-summary.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("coordination summary overflows narrow viewport");
    if (errors.length) throw new Error(`coordination browser errors: ${errors.join("; ")}`);
  } finally {
    writeFileSync(reviewGate, "go");
    await page.close();
    if (room) await fetch(`${base}/api/rooms/${room.id}`, { method: "DELETE" });
    for (const id of agentIds) await fetch(`${base}/api/agents/${id}`, { method: "DELETE" });
  }
}
