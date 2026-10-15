import { realpathSync } from "node:fs";
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const endpoint = `${base}/api/projects/${projectId}/terminal`;
  const info = async () => (await (await fetch(endpoint)).json()) as ProjectTerminalMeta | null;
  try {
    await page.goto(`${base}/#/c/${roomId}`);
    await page.getByRole("button", { name: "打开项目终端" }).click();
    const dock = page.getByRole("region", { name: "项目终端" });
    const terminalInput = dock.locator(".xterm-helper-textarea");
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
    const first = await info();
    if (!first || first.cwd !== cwd) throw new Error("terminal did not open in the project cwd");
    await command("pwd");
    await output(realpathSync(cwd));
    await command("export TT_SMOKE_VALUE=686000; expr $TT_SMOKE_VALUE + 987");
    await output("686987");
    await dock.getByRole("button", { name: "收起终端", exact: true }).click();
    await page.getByRole("button", { name: "打开项目终端" }).waitFor();
    if ((await info())?.id !== first.id) throw new Error("hiding ended the terminal");
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "visible" });
    await command("expr $TT_SMOKE_VALUE + 988");
    await output("686988");
    // The shortcut also works while xterm owns keyboard focus.
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "hidden" });
    await page.keyboard.press("Control+Backquote");
    await dock.waitFor({ state: "visible" });
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
    await page.waitForTimeout(100);
    await page.keyboard.press("Control+c");
    await command("expr 40000 + 221");
    await output("40221");
    await page.emulateMedia({ colorScheme: "dark" });
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
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
    await dock.getByRole("button", { name: "结束终端" }).click();
    await dock.waitFor({ state: "detached" });
    if (await info()) throw new Error("ending left the terminal registered");
    if (errors.length) throw new Error(`terminal page errors: ${errors.join("; ")}`);
  } catch (error) {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "project-terminal-failure.png") }).catch(() => {});
    throw error;
  } finally {
    const current = await info();
    if (current) await fetch(`${endpoint}?terminalId=${current.id}`, { method: "DELETE" });
    await page.close();
  }
}
