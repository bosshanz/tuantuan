import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Room, SessionView } from "../web/src/api";
import type { ChatSnapshot } from "../web/src/chatState";

/** Real HTTP/WS + mock ACP. The caller provides an onboarded, idle group with two mock Agents. */
export async function schedulingSmoke(browser: Browser, base: string, roomId: string, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true, colorScheme: "light" });
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
    await taskRow(a.id).getByText("回复中", { exact: true }).waitFor();
    await taskRow(b.id).getByText("回复中", { exact: true }).waitFor();
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
    await taskRow(second.id).getByText("回复中", { exact: true }).waitFor();
    if ((await page.locator("[data-task-id]").count()) !== 1) throw new Error("reload restored a completed task");
    await page.getByRole("button", { name: "停止", exact: true }).waitFor(); // Safe single-task shortcut.

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
    await taskRow(second.id).waitFor(); // Existing tasks remain usable while the reconnect snapshot is held.
    const cancelResponse = await fetch(cancelEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: second.id }),
    });
    if (!cancelResponse.ok) throw new Error("final targeted cancel failed");
    await waitState((s) => s.state.tasks.length === 0, "final task stops");
    await taskRow(second.id).waitFor({ state: "hidden" });
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
    await taskRow(source.id).getByText("交接中", { exact: true }).waitFor();
    await taskRow(child.id).getByText("回复中", { exact: true }).waitFor();
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "group-scheduling-handoff.png"), animations: "disabled" });
    await taskRow(source.id).getByRole("button", { name: "停止任务", exact: true }).click();
    await waitState((s) => s.state.tasks.length === 0, "stopping handoff source cancels its descendant");
    await taskRow(child.id).waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("task UI overflows narrow viewport");
    if (errors.length) throw new Error(`scheduling browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS task scheduling: parallel Agents, per-Agent queue, targeted stop/retry, independent task survives, refresh/slow snapshot, handoff subtree",
    );
  } finally {
    await page.close();
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
