import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Agent, Message, Room } from "../server/store";
import type { ChatSnapshot } from "../web/src/chatState";

/** Real Chrome wheel input while the mock ACP streams continuously through the real server. */
export async function chatScrollSmoke(browser: Browser, base: string, shotsDir?: string) {
  const videoDir = process.env.SCROLL_VIDEO_DIR;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
  });
  const video = page.video();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`);
  });
  const request = async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`scroll fixture ${method} ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const agents: Agent[] = [];
  const rooms: Room[] = [];
  const evidence: Record<string, unknown> = {};
  const messages = page.locator(".messages");
  const metrics = () =>
    messages.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    }));
  const wheel = async (delta: number) => {
    const box = await messages.boundingBox();
    if (!box) throw new Error("message viewport is missing");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, delta);
  };
  const shot = async (name: string) => {
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `${name}.png`) });
    }
  };
  const idle = async (roomId: string) => {
    const until = Date.now() + 15_000;
    while ((await request<ChatSnapshot>("GET", `/api/rooms/${roomId}/messages`)).state.activeRunId) {
      if (Date.now() > until) throw new Error("scroll fixture room did not become idle");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const streamLength = () =>
    page.locator('.message-row[data-sender="agent"] .msg[data-status="streaming"]').last().textContent();
  const moreStream = async (before: string | null, chunks = 3) => {
    await page.waitForFunction(
      ({ length, growth }) => {
        const stream = [
          ...document.querySelectorAll('.message-row[data-sender="agent"] .msg[data-status="streaming"]'),
        ].at(-1);
        return !!stream && (stream.textContent?.length ?? 0) >= length + growth;
      },
      { length: before?.length ?? 0, growth: chunks * 2 },
    );
  };
  try {
    for (const name of ["ScrollReader", "ScrollHelper"])
      agents.push(await request<Agent>("POST", "/api/agents", { name, harness: "mock", avatarShape: "cat" }));
    for (const name of ["滚动跟随回归", "切换会话回归"])
      rooms.push(
        await request<Room>("POST", "/api/rooms", {
          name,
          agentIds: agents.map((agent) => agent.id),
          mainAgentId: agents[0]?.id,
        }),
      );
    const roomId = rooms[0]?.id as string;
    const endpoint = `/api/rooms/${roomId}/messages`;
    const history = Array.from(
      { length: 30 },
      (_, index) => `阅读位置第 ${index + 1} 段：流式输出不应抢走用户滚动位置。`,
    ).join("\n\n");
    const source = await request<Message>("POST", endpoint, { senderName: "历史作者", content: history });
    await idle(roomId);
    const otherSource = await request<Message>("POST", `/api/rooms/${rooms[1]?.id}/messages`, { content: history });
    await idle(rooms[1]?.id as string);
    await page.goto(`${base}/#/c/${roomId}`);
    await page.locator(`[data-message-id="${source.id}"]`).waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (!(await page.title()).includes("团团") || !page.url().endsWith(`/#/c/${roomId}`))
      throw new Error("chat scroll smoke opened the wrong page");
    if (await page.locator("vite-error-overlay").count()) throw new Error("chat scroll page has a Vite overlay");
    if ((await metrics()).distance > 2) throw new Error("opening a room did not show its latest messages");

    await request("POST", endpoint, { content: "/slow" });
    await moreStream(null, 3);
    const before = await metrics();
    const text = await streamLength();
    await wheel(-8);
    await moreStream(text, 5);
    const after = await metrics();
    if (after.top > before.top - 4 || after.distance < 4)
      throw new Error(`small upward wheel was pulled back during streaming: ${JSON.stringify({ before, after })}`);
    evidence.smallWheel = { before, after };
    const latest = page.getByRole("button", { name: "回到最新消息", exact: true });
    await latest.waitFor();
    await wheel(-140);
    await page.waitForFunction((top) => (document.querySelector(".messages")?.scrollTop ?? 0) < top - 100, after.top);
    const reading = (await metrics()).top;
    const pausedText = await streamLength();
    await moreStream(pausedText, 5);
    if (Math.abs((await metrics()).top - reading) > 2) throw new Error("streaming moved the reader's history position");
    await page.setViewportSize({ width: 1440, height: 820 });
    const expanded = page.getByRole("button", { name: "展开回复状态", exact: true });
    await expanded.click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".chat-task-disclosure")].every(
        (element) => !element.getAnimations().some((animation) => animation.playState === "running"),
      ),
    );
    if (Math.abs((await metrics()).top - reading) > 2) throw new Error("viewport/disclosure resize resumed following");
    await page.getByRole("button", { name: "收起回复状态", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".chat-task-disclosure")].every(
        (element) => !element.getAnimations().some((animation) => animation.playState === "running"),
      ),
    );
    if (Math.abs((await metrics()).top - reading) > 2) throw new Error("closing reply disclosure moved the reader");
    await shot("chat-scroll-reading");

    await latest.click();
    const resumedText = await streamLength();
    await moreStream(resumedText);
    if ((await metrics()).distance > 2) throw new Error("return-to-latest did not resume stream following");
    await wheel(-8);
    await latest.waitFor();
    await wheel(20_000);
    await latest.waitFor({ state: "hidden" });
    const manualText = await streamLength();
    await moreStream(manualText);
    if ((await metrics()).distance > 2) throw new Error("manually returning to the bottom did not resume following");
    await shot("chat-scroll-following");
    await idle(roomId);

    // Smooth navigation to an old source must remain in history while new chunks arrive.
    await request("POST", endpoint, { content: "/slow" });
    await moreStream(null, 3);
    const sourceRow = page.locator(`[data-message-id="${source.id}"]`);
    const tail = (await metrics()).top;
    await sourceRow.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "start" }));
    await page.waitForFunction((top) => (document.querySelector(".messages")?.scrollTop ?? 0) < top - 300, tail);
    await latest.waitFor();
    await page.waitForTimeout(650);
    const historyTop = (await metrics()).top;
    const historyText = await streamLength();
    await moreStream(historyText);
    if (Math.abs((await metrics()).top - historyTop) > 2)
      throw new Error("streaming interrupted a smooth history jump");
    const quote = sourceRow.getByRole("button", { name: "引用回复", exact: true });
    await quote.focus();
    const quoteTop = (await metrics()).top;
    await page.keyboard.press("Enter");
    await page.getByTestId("composer-quote").waitFor();
    const quoteText = await streamLength();
    await moreStream(quoteText);
    if (Math.abs((await metrics()).top - quoteTop) > 2) throw new Error("quoting an older message resumed following");
    await page.getByRole("button", { name: "取消引用", exact: true }).click();
    await idle(roomId);

    // Sending is an explicit return to the tail, but upward input while its HTTP request waits wins.
    const input = page.getByRole("textbox", { name: "消息输入框" });
    await input.fill("/slow");
    await input.press("Enter");
    await latest.waitFor({ state: "hidden" });
    await moreStream(null, 3);
    if ((await metrics()).distance > 2) throw new Error("sending a new message did not resume following");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const marker = "发送请求等待期间继续阅读";
    await page.route(`${base}${endpoint}`, async (route) => {
      if (route.request().method() === "POST" && route.request().postDataJSON().content === marker) {
        arrived();
        await gate;
      }
      await route.continue();
    });
    await input.fill(marker);
    await input.press("Enter");
    await waiting;
    await wheel(-180);
    await latest.waitFor();
    const pendingTop = (await metrics()).top;
    const acknowledged = page.waitForResponse(
      (response) => response.url() === `${base}${endpoint}` && response.request().method() === "POST",
    );
    release();
    await acknowledged;
    const pendingText = await streamLength();
    await moreStream(pendingText);
    if (Math.abs((await metrics()).top - pendingTop) > 2)
      throw new Error("a late send acknowledgement forced the reader to the bottom");
    evidence.pendingSendTop = pendingTop;
    await page.unroute(`${base}${endpoint}`);

    await page.goto(`${base}/#/c/${rooms[1]?.id}`);
    await page.locator(`[data-message-id="${otherSource.id}"]`).waitFor();
    await page.waitForFunction(() => {
      const element = document.querySelector(".messages");
      return !!element && element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
    });
    await latest.waitFor({ state: "hidden" });
    await page.goto(`${base}/#/c/${roomId}`);
    await page.locator(`[data-message-id="${source.id}"]`).waitFor();
    const switchedText = await streamLength();
    await moreStream(switchedText);
    if ((await metrics()).distance > 2)
      throw new Error("switching rooms retained the other room's paused follow state");
    await shot("chat-scroll-room-return");
    await page.setViewportSize({ width: 390, height: 844 });
    const narrowText = await streamLength();
    await moreStream(narrowText);
    await wheel(-8);
    const narrowReading = await streamLength();
    await moreStream(narrowReading);
    await latest.waitFor();
    if ((await metrics()).distance < 4) throw new Error("narrow viewport resumed following after upward wheel");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("return-to-latest control overflows narrow chat");
    await shot("chat-scroll-narrow");
    if (errors.length) throw new Error(`chat scroll page errors: ${errors.join("; ")}`);
    return evidence;
  } catch (error) {
    await shot("chat-scroll-failure").catch(() => {});
    throw error;
  } finally {
    await page.close();
    if (video && videoDir) {
      await video.saveAs(join(videoDir, "chat-stream-scroll.webm"));
      await video.delete();
    }
    for (const room of rooms) await request("DELETE", `/api/rooms/${room.id}`);
    for (const agent of agents) await request("DELETE", `/api/agents/${agent.id}`);
  }
}
