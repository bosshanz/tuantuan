import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";

/** Verify the real workspace reading flow against an isolated Git repository. */
export async function gitWorkspaceSmoke(browser: Browser, base: string) {
  const scratch = mkdtempSync(join(tmpdir(), "tt-git-ui-e2e-"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", scratch, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
      stdio: "pipe",
    });
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Git fixture ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  let agentId = "";
  let projectId = "";
  let roomId = "";
  try {
    git("init", "-q");
    git("config", "user.name", "Git UI fixture");
    git("config", "user.email", "git-ui@example.invalid");
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src", "app.ts"), "baseline\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    writeFileSync(join(scratch, "src", "app.ts"), "staged\n");
    git("add", "src/app.ts");
    writeFileSync(join(scratch, "src", "app.ts"), "unstaged\n");
    for (let i = 1; i <= 20; i++)
      writeFileSync(
        join(scratch, "src", `fixture-${String(i).padStart(2, "0")}.ts`),
        i === 12 ? `file 12\n${Array.from({ length: 180 }, (_, line) => `line ${line}`).join("\n")}\n` : `file ${i}\n`,
      );

    agentId = (await post<{ id: string }>("/api/agents", { name: "Git验收助手", harness: "mock" })).id;
    projectId = (await post<{ id: string }>("/api/projects", { name: "Git验收项目", cwd: scratch })).id;
    roomId = (
      await post<{ id: string }>("/api/rooms", {
        name: "Git工作区验收",
        agentIds: [agentId],
        projectId,
      })
    ).id;
    await page.goto(`${base}/#/c/${roomId}`);
    await page.getByRole("button", { name: "会话文件", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "会话文件与改动", exact: true });
    await dialog.waitFor();
    const tabs = dialog.getByRole("tablist").getByRole("tab");
    if ((await tabs.count()) !== 3) throw new Error("expected three peer tabs");
    await tabs.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    if ((await tabs.nth(1).getAttribute("aria-selected")) !== "true")
      throw new Error("Agent tab key navigation failed");
    await page.keyboard.press("ArrowRight");
    if ((await tabs.nth(2).getAttribute("aria-selected")) !== "true") throw new Error("Git tab key navigation failed");

    const rows = dialog.locator(".git-browser-file");
    const unstaged = rows.filter({ hasText: "app.ts" }).nth(0);
    const staged = rows.filter({ hasText: "app.ts" }).nth(1);
    await unstaged.waitFor();
    await dialog.locator(".git-patch").getByText("+unstaged", { exact: true }).waitFor();
    if ((await unstaged.getAttribute("aria-pressed")) !== "true") throw new Error("first Git change was not selected");
    await staged.click();
    await dialog.locator(".git-patch").getByText("+staged", { exact: true }).waitFor();
    if ((await staged.getAttribute("aria-pressed")) !== "true") throw new Error("whole-file selection failed");

    const target = rows.filter({ hasText: "fixture-12.ts" });
    await target.click();
    await page.waitForFunction(() => document.querySelector(".git-patch")?.textContent?.startsWith("file 12"));
    const list = dialog.locator(".git-browser-files");
    const scrollBefore = await list.evaluate((element) => element.scrollTop);
    if (scrollBefore < 1) throw new Error("fixture did not scroll the file list");
    const detail = dialog.locator(".git-detail-scroll");
    const detailBefore = await detail.evaluate((element) => {
      element.scrollTop = 240;
      return element.scrollTop;
    });
    if (detailBefore < 1) throw new Error("fixture did not scroll the file detail");
    await dialog.getByRole("button", { name: "刷新改动列表" }).click();
    await page.waitForFunction(
      () => document.querySelector(".git-workspace-v2")?.getAttribute("aria-busy") === "false",
    );
    await page.waitForFunction(() => document.querySelector(".git-patch")?.textContent?.startsWith("file 12"));
    if ((await target.getAttribute("aria-pressed")) !== "true") throw new Error("refresh lost the selected file");
    if ((await list.evaluate((element) => element.scrollTop)) !== scrollBefore)
      throw new Error("refresh lost the file list position");
    if ((await detail.evaluate((element) => element.scrollTop)) !== detailBefore)
      throw new Error("refresh lost the file detail position");

    await page.setViewportSize({ width: 390, height: 700 });
    const back = dialog.getByRole("button", { name: "文件列表", exact: true });
    await back.waitFor();
    await back.click();
    if (!(await target.evaluate((element) => element === document.activeElement)))
      throw new Error("mobile return did not restore focus to the selected file");
    if ((await list.evaluate((element) => element.scrollTop)) !== scrollBefore)
      throw new Error("mobile return lost the file list position");
    const next = rows.filter({ hasText: "fixture-13.ts" });
    await next.click();
    await dialog.locator(".git-patch").getByText("file 13", { exact: true }).waitFor();
    await back.click();
    if (!(await next.evaluate((element) => element === document.activeElement)))
      throw new Error("mobile return did not focus the newly selected file");
    if (await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1))
      throw new Error("Git workspace horizontally overflows at 390px");
    console.log("git workspace: peer tabs, diff selection, refresh, scroll and mobile return passed");
  } finally {
    await page.close();
    for (const [kind, id] of [
      ["rooms", roomId],
      ["projects", projectId],
      ["agents", agentId],
    ]) {
      if (id) await fetch(`${base}/api/${kind}/${id}`, { method: "DELETE" });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}
