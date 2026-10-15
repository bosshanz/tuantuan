import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { ProjectTerminalMeta } from "../shared/project-terminal";

/** Real browser → WebSocket → PTY; no command-output or terminal mocks. */
export async function terminalSmoke(
  browser: Browser,
  base: string,
  roomId: string,
  projectId: string,
  cwd: string,
  shotsDir?: string,
) {
  const videoDir = process.env.TERMINAL_VIDEO_DIR;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
  });
  const video = page.video();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const endpoint = `${base}/api/projects/${projectId}/terminal`;
  const info = async () => (await (await fetch(endpoint)).json()) as ProjectTerminalMeta | null;
  let disconnectTerminal: () => Promise<void> = async () => {
    throw new Error("terminal socket has not opened");
  };
  let resizeFrames = 0;
  await page.routeWebSocket(`${base.replace("http", "ws")}/ws/terminal/*`, (socket) => {
    const backend = socket.connectToServer();
    backend.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "exit" || event.type === "error") console.log("terminal WS", JSON.stringify(event));
      socket.send(message);
    });
    socket.onMessage((message) => {
      if (JSON.parse(String(message)).type === "resize") resizeFrames++;
      backend.send(message);
    });
    disconnectTerminal = () => socket.close({ code: 1012, reason: "terminal reconnect focus regression" });
  });
  const waitSettled = async (open: boolean) =>
    page.waitForFunction((expected) => {
      const slot = document.querySelector<HTMLElement>(".terminal-slot");
      const content = slot?.querySelector<HTMLElement>(".terminal-slot-content");
      if (!slot || !content || slot.getAnimations().some((animation) => animation.playState === "running"))
        return false;
      return Math.abs(slot.getBoundingClientRect().height - (expected ? content.offsetHeight : 0)) < 0.5;
    }, open);
  const beginMotion = async () =>
    page.evaluate(() => {
      const state = { frames: [] as { height: number; contentHeight: number; at: number; open: boolean }[] };
      const win = window as typeof window & { terminalMotion?: typeof state };
      win.terminalMotion = state;
      const tick = (at: number) => {
        if (win.terminalMotion !== state) return;
        const slot = document.querySelector<HTMLElement>(".terminal-slot");
        const content = slot?.querySelector<HTMLElement>(".terminal-slot-content");
        if (slot && content)
          state.frames.push({
            height: slot.getBoundingClientRect().height,
            contentHeight: content.offsetHeight,
            at,
            open: slot.hasAttribute("data-open"),
          });
        requestAnimationFrame(tick);
      };
      tick(performance.now());
    });
  const finishMotion = async (label: string, animated: boolean) => {
    const frames = await page.evaluate(() => {
      const win = window as typeof window & {
        terminalMotion?: { frames: { height: number; contentHeight: number; at: number; open: boolean }[] };
      };
      const frames = win.terminalMotion?.frames ?? [];
      delete win.terminalMotion;
      return frames;
    });
    const middle = frames.filter((frame) => frame.height > 1 && frame.height < frame.contentHeight - 1);
    if (animated && middle.length < 2) throw new Error(`${label} jumped without intermediate layout frames`);
    if (!animated && middle.length) throw new Error(`${label} animated despite reduced motion`);
    if (new Set(frames.map((frame) => frame.contentHeight)).size > 1)
      throw new Error(`${label} resized terminal contents during clipping`);
    console.log(`terminal motion ${label}: ${middle.length} intermediate frames`);
    return frames;
  };
  try {
    // Hold only the lazy module: the same outer slot must animate while fallback and real terminal exchange.
    let releaseModule: () => void = () => {};
    const moduleGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    const moduleUrl = /\/assets\/ProjectTerminal-[^/]+\.js$/;
    await page.route(moduleUrl, async (route) => {
      await moduleGate;
      await route.continue();
    });
    await page.goto(`${base}/#/c/${roomId}`);
    const messages = page.locator(".messages");
    const chatInput = page.getByRole("textbox", { name: "消息输入框" });
    await messages.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await beginMotion();
    await page.getByRole("button", { name: "打开项目终端" }).click();
    await page.getByRole("status").filter({ hasText: "正在打开终端…" }).waitFor();
    await waitSettled(true);
    await finishMotion("first lazy open", true);
    const loadingHeight = await page.locator(".terminal-slot").evaluate((el) => el.getBoundingClientRect().height);
    // Choosing another input before the module/snapshot arrives revokes delayed auto-focus.
    await chatInput.focus();
    const moduleLoaded = page.waitForResponse((response) => moduleUrl.test(response.url()));
    releaseModule();
    await moduleLoaded;
    await page.unroute(moduleUrl);
    const dock = page.getByRole("region", { name: "项目终端" });
    const terminalElement = page.locator(".project-terminal");
    const terminalInput = terminalElement.locator(".xterm-helper-textarea");
    const command = async (text: string) => {
      await terminalInput.focus();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };
    const output = async (text: string) => {
      await page.waitForFunction(
        (value) =>
          [...document.querySelectorAll(".xterm-accessibility-tree > div")].some(
            (row) => row.textContent?.trim() === value,
          ),
        text,
      );
    };
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "");
    await waitSettled(true);
    if (
      Math.abs(
        (await page.locator(".terminal-slot").evaluate((el) => el.getBoundingClientRect().height)) - loadingHeight,
      ) > 0.5
    )
      throw new Error("lazy terminal replacement changed reserved height");
    await page.keyboard.type("终端加载时继续写草稿");
    if ((await chatInput.inputValue()) !== "终端加载时继续写草稿")
      throw new Error("terminal lazy load stole composer focus");
    await chatInput.fill("");
    if (await messages.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight > 3))
      throw new Error("opening terminal lost chat bottom anchoring");
    const first = await info();
    if (!first || first.cwd !== cwd) throw new Error("terminal did not open in the project cwd");
    await command("pwd");
    await output(realpathSync(cwd));
    await command("export TT_SMOKE_VALUE=686000; expr $TT_SMOKE_VALUE + 987");
    await output("686987");
    const resizeBeforeToggle = resizeFrames;
    await beginMotion();
    await dock.getByRole("button", { name: "收起终端", exact: true }).click();
    const toolbar = page.getByRole("button", { name: "打开项目终端" });
    if (!(await toolbar.evaluate((el) => el === document.activeElement)))
      throw new Error("hiding terminal did not return toolbar focus");
    if (
      !(await page
        .locator(".terminal-slot")
        .evaluate((el) => el.hasAttribute("inert") && el.getAttribute("aria-hidden") === "true"))
    )
      throw new Error("closing terminal remains exposed to interaction");
    if (
      await terminalInput.evaluate((el) => {
        (el as HTMLTextAreaElement).focus();
        return el === document.activeElement;
      })
    )
      throw new Error("closing terminal accepted focus while inert");
    await waitSettled(false);
    await finishMotion("close", true);
    await chatInput.focus();
    await disconnectTerminal();
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "正在重连…");
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "");
    if (!(await chatInput.evaluate((el) => el === document.activeElement)))
      throw new Error("hidden reconnect stole composer focus");
    if ((await info())?.id !== first.id) throw new Error("hiding ended the terminal");
    await beginMotion();
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "visible" });
    await waitSettled(true);
    await finishMotion("reopen", true);
    // Reconnect may synchronize once, but clipping must not send one PTY resize per animation frame.
    if (resizeFrames - resizeBeforeToggle > 2) throw new Error("terminal clipping repeatedly resized the PTY");
    await command("expr $TT_SMOKE_VALUE + 988");
    await output("686988");
    // The shortcut also works while xterm owns keyboard focus.
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "hidden" });
    await waitSettled(false);
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "visible" });
    await waitSettled(true);
    // Reverse twice in-flight. The next rendered frame must stay near the current height.
    for (let reversal = 0; reversal < 2; reversal++) {
      await page.keyboard.press("Control+Backquote");
      await page.waitForFunction(() => {
        const slot = document.querySelector<HTMLElement>(".terminal-slot");
        const full = slot?.querySelector<HTMLElement>(".terminal-slot-content")?.offsetHeight ?? 0;
        const height = slot?.getBoundingClientRect().height ?? 0;
        return height > full * 0.35 && height < full * 0.7;
      });
      const current = await page.locator(".terminal-slot").evaluate((el) => el.getBoundingClientRect().height);
      await page.keyboard.press("Control+Backquote");
      const next = await page
        .locator(".terminal-slot")
        .evaluate(
          (el) =>
            new Promise<number>((resolve) => requestAnimationFrame(() => resolve(el.getBoundingClientRect().height))),
        );
      if (next < 1 || next >= loadingHeight || Math.abs(next - current) > loadingHeight * 0.35)
        throw new Error("rapid terminal reversal jumped to an endpoint");
      await waitSettled(true);
    }
    const canReadHistory = await messages.evaluate((el) => el.scrollHeight - el.clientHeight > 80);
    if (canReadHistory) {
      await messages.evaluate((el) => {
        el.scrollTop = Math.min(80, (el.scrollHeight - el.clientHeight) / 4);
      });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const readingTop = await messages.evaluate((el) => el.scrollTop);
      await page.keyboard.press("Control+Backquote");
      await waitSettled(false);
      await page.keyboard.press("Control+Backquote");
      await waitSettled(true);
      if (Math.abs((await messages.evaluate((el) => el.scrollTop)) - readingTop) > 2)
        throw new Error("terminal toggle moved a reader's history position");
    }
    await page.keyboard.press("Control+Backquote");
    await waitSettled(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await beginMotion();
    await page.keyboard.press("Control+Backquote");
    await waitSettled(true);
    await finishMotion("reduced-motion open", false);
    await beginMotion();
    await page.keyboard.press("Control+Backquote");
    await waitSettled(false);
    await finishMotion("reduced-motion close", false);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.keyboard.press("Control+Backquote");
    await waitSettled(true);
    const before = await dock.boundingBox();
    await dock.getByRole("separator", { name: "调整终端高度" }).focus();
    await page.keyboard.press("ArrowUp");
    const after = await dock.boundingBox();
    if (!before || !after || after.height - before.height !== 20) throw new Error("terminal keyboard resize failed");
    const handle = await dock.getByRole("separator", { name: "调整终端高度" }).boundingBox();
    if (!handle) throw new Error("terminal resize handle missing");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - 40);
    await page.mouse.up();
    if ((await dock.boundingBox())?.height !== after.height + 40) throw new Error("terminal drag resize failed");
    // Layout, xterm fitting and the WebSocket resize reach the PTY on separate turns.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const clientRows = await dock.locator(".xterm-accessibility-tree > div").count();
    await page.waitForFunction(
      async ({ endpoint, rows }) => {
        const terminal = await (await fetch(endpoint)).json();
        return terminal?.rows === rows;
      },
      { endpoint, rows: clientRows },
    );
    const size = await info();
    await command("stty size");
    await output(`${size?.rows} ${size?.cols}`);
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal.png") });
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "");
    if ((await info())?.id !== first.id) throw new Error("reload replaced the shell");
    await command("expr $TT_SMOKE_VALUE + 989");
    await output("686989");
    await command("sleep 30");
    // The shell acknowledges command input by echoing it; Ctrl+C then interrupts the foreground job.
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".xterm-accessibility-tree > div")].some((row) =>
        row.textContent?.includes("sleep 30"),
      ),
    );
    await page.keyboard.press("Control+c");
    await command("expr 40000 + 221");
    await output("40221");
    await page.emulateMedia({ colorScheme: "dark" });
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("terminal layout overflows the narrow viewport");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal-narrow.png") });
    await command("exit 7");
    await dock.getByRole("status").filter({ hasText: "已退出 · 7" }).waitFor();
    await dock.getByRole("button", { name: "重新打开" }).click();
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "");
    if ((await info())?.id === first.id) throw new Error("restart retained the exited shell");
    await command("expr 19000 + 992");
    await output("19992");
    await beginMotion();
    await dock.getByRole("button", { name: "结束终端" }).click();
    await waitSettled(false);
    await finishMotion("end terminal", true);
    await terminalElement.waitFor({ state: "detached" });
    if (await info()) throw new Error("ending left the terminal registered");
    // Changing the system preference during an exit must finish cleanup without waiting for a transition event.
    await page.getByRole("button", { name: "打开项目终端" }).click();
    await waitSettled(true);
    await page.waitForFunction(() => document.querySelector(".terminal-status")?.textContent === "");
    await dock.getByRole("button", { name: "结束终端" }).click();
    await page.waitForFunction(() => {
      const slot = document.querySelector<HTMLElement>(".terminal-slot");
      const full = slot?.querySelector<HTMLElement>(".terminal-slot-content")?.offsetHeight ?? 0;
      const current = slot?.getBoundingClientRect().height ?? 0;
      return current > 1 && current < full - 1;
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await waitSettled(false);
    await terminalElement.waitFor({ state: "detached" });
    if (await info()) throw new Error("reduced-motion exit retained a terminal");
    if (errors.length) throw new Error(`terminal page errors: ${errors.join("; ")}`);
  } catch (error) {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal-failure.png") }).catch(() => {});
    throw error;
  } finally {
    const current = await info();
    if (current) await fetch(`${endpoint}?terminalId=${current.id}`, { method: "DELETE" });
    await page.close();
    if (video && videoDir) {
      await video.saveAs(join(videoDir, "project-terminal-motion.webm"));
      await video.delete();
    }
  }
}
