import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import type { ProjectTerminalMeta } from "../shared/project-terminal";

interface RoomFixture {
  id: string;
  cwd: string;
  worktree: { root: string; branch: string } | null;
}

/** Real Git worktrees, browser workbench and shell processes, all created in a temporary fixture. */
export async function worktreeSmoke(browser: Browser, base: string) {
  const scratch = mkdtempSync(join(tmpdir(), "tt-worktrees-e2e-"));
  const repo = join(scratch, "repository");
  mkdirSync(repo);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
      stdio: "pipe",
    });
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`worktree fixture ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const remove = async (path: string) => {
    const response = await fetch(`${base}${path}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`worktree cleanup ${path}: ${response.status} ${await response.text()}`);
  };
  const samePath = (a: string, b: string) => realpathSync(a) === realpathSync(b);
  const roomIds: string[] = [];
  const worktrees: RoomFixture[] = [];
  let projectId = "";
  let nestedProjectId = "";
  let agentId = "";
  try {
    git("init", "-q");
    git("config", "user.name", "Worktree UI fixture");
    git("config", "user.email", "worktree-ui@example.invalid");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "shared.ts"), "committed baseline\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    writeFileSync(join(repo, "src", "shared.ts"), "original dirty working tree\n");
    agentId = (await post<{ id: string }>("/api/agents", { name: "隔离验收助手", harness: "mock" })).id;
    projectId = (await post<{ id: string }>("/api/projects", { name: "隔离验收项目", cwd: repo })).id;

    await page.goto(`${base}/#/c`);
    await page.locator(".side-top").getByRole("button", { name: "新建会话" }).click();
    await page.getByRole("button", { name: "项目", exact: true }).click();
    await page
      .getByRole("listbox", { name: "项目" })
      .getByRole("option", { name: /隔离验收项目/ })
      .click();
    await page.getByLabel("会话名称").fill("隔离工作树第一会话");
    await page
      .locator(".pick", { has: page.locator(".pick-name", { hasText: /^隔离验收助手$/ }) })
      .locator("input")
      .check();
    const checkbox = page.getByRole("checkbox", { name: "在独立 Git worktree 中运行", exact: true });
    if (await checkbox.isChecked()) throw new Error("worktree was enabled by default");
    await checkbox.check();
    const created = page.waitForResponse(
      (response) => response.url() === `${base}/api/rooms` && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "创建会话", exact: true }).click();
    const response = await created;
    if (!response.ok()) throw new Error(`worktree UI creation failed: ${response.status()} ${await response.text()}`);
    const first = (await response.json()) as RoomFixture;
    roomIds.push(first.id);
    if (!first.worktree) throw new Error("worktree UI creation did not return worktree information");
    worktrees.push(first);
    const second = await post<RoomFixture>("/api/rooms", {
      name: "隔离工作树第二会话",
      agentIds: [agentId],
      projectId,
      worktree: true,
    });
    roomIds.push(second.id);
    if (!second.worktree) throw new Error("second worktree was not created");
    worktrees.push(second);
    const normal = await post<RoomFixture>("/api/rooms", {
      name: "普通目录会话",
      agentIds: [agentId],
      projectId,
    });
    roomIds.push(normal.id);
    if (!samePath(normal.cwd, repo) || normal.worktree) throw new Error("ordinary room did not use the project cwd");
    if (samePath(first.cwd, second.cwd) || samePath(first.cwd, repo) || samePath(second.cwd, repo))
      throw new Error("isolated rooms share a working directory");
    for (const room of [first, second]) {
      if (readFileSync(join(room.cwd, "src", "shared.ts"), "utf8") !== "committed baseline\n")
        throw new Error("new worktree did not start from the committed project baseline");
    }
    writeFileSync(join(first.cwd, "src", "shared.ts"), "first worktree change\n");
    writeFileSync(join(second.cwd, "src", "shared.ts"), "second worktree change\n");
    if (readFileSync(join(repo, "src", "shared.ts"), "utf8") !== "original dirty working tree\n")
      throw new Error("worktree changes affected the existing project directory");
    nestedProjectId = (
      await post<{ id: string }>("/api/projects", { name: "子目录隔离验收项目", cwd: join(repo, "src") })
    ).id;
    const nested = await post<RoomFixture>("/api/rooms", {
      name: "子目录隔离会话",
      agentIds: [agentId],
      projectId: nestedProjectId,
      worktree: true,
    });
    roomIds.push(nested.id);
    if (!nested.worktree) throw new Error("subdirectory project worktree was not created");
    worktrees.push(nested);
    if (!samePath(nested.cwd, join(nested.worktree.root, "src")))
      throw new Error("subdirectory project lost its relative working directory inside the worktree");
    if (readFileSync(join(nested.cwd, "shared.ts"), "utf8") !== "committed baseline\n")
      throw new Error("subdirectory project did not use the committed baseline");

    const inspect = async (room: RoomFixture, text: string, excluded: string) => {
      await page.goto(`${base}/#/c/${room.id}`);
      // The second room was created through the API in this fixture, so refresh the sidebar snapshot.
      await page.reload();
      await page.getByRole("button", { name: "会话文件", exact: true }).click();
      const workbench = page.getByRole("complementary", { name: "会话文件与改动", exact: true });
      await workbench.locator(".file-tree-row").filter({ hasText: "src" }).click();
      await workbench.locator(".file-tree-row").filter({ hasText: "shared.ts" }).click();
      await workbench.locator(".file-preview-source").getByText(text, { exact: false }).waitFor();
      if (await workbench.locator(".file-preview-source").getByText(excluded, { exact: false }).count())
        throw new Error("file viewer read from a different room's worktree");
      await workbench.getByRole("tab", { name: /^Git 变更/ }).click();
      await workbench.locator(".git-browser-file").filter({ hasText: "shared.ts" }).click();
      await workbench.locator(".git-patch").getByText(`+${text}`, { exact: true }).waitFor();
      if (await workbench.locator(".git-patch").getByText(`+${excluded}`, { exact: true }).count())
        throw new Error("Git view read from a different room's worktree");
    };
    await inspect(first, "first worktree change", "second worktree change");
    await inspect(second, "second worktree change", "first worktree change");

    const firstTerminal = await post<ProjectTerminalMeta>(`/api/rooms/${first.id}/terminal`, {});
    const secondTerminal = await post<ProjectTerminalMeta>(`/api/rooms/${second.id}/terminal`, {});
    if (!samePath(firstTerminal.cwd, first.cwd) || !samePath(secondTerminal.cwd, second.cwd))
      throw new Error("room terminal metadata used the wrong working directory");
    if (firstTerminal.id === secondTerminal.id) throw new Error("isolated rooms shared a terminal");
    await terminalPwd(page, base, firstTerminal, first.cwd);
    await terminalPwd(page, base, secondTerminal, second.cwd);

    await page.goto(`${base}/#/c/${first.id}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "隔离工作树第一会话 · 会话信息" }).click();
    const panel = page.getByRole("complementary", { name: "详情面板", exact: true });
    await panel.getByRole("tab", { name: "详情", exact: true }).click();
    await panel.getByText(first.worktree.branch, { exact: true }).waitFor();
    await panel.getByText(first.cwd, { exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1))
      throw new Error("worktree room details overflowed the narrow viewport");
    let confirmation = "";
    page.once("dialog", (dialog) => {
      confirmation = dialog.message();
      void dialog.accept();
    });
    const deletion = page.waitForResponse(
      (item) => item.url() === `${base}/api/rooms/${first.id}` && item.request().method() === "DELETE",
    );
    await panel.getByRole("button", { name: "删除会话", exact: true }).click();
    const deleted = await deletion;
    if (!deleted.ok()) throw new Error(`room UI delete failed: ${deleted.status()}`);
    if (!confirmation.includes("worktree") || !confirmation.includes("保留"))
      throw new Error("room deletion confirmation did not explain worktree preservation");
    roomIds.splice(roomIds.indexOf(first.id), 1);
    await remove(`/api/rooms/${second.id}`);
    roomIds.splice(roomIds.indexOf(second.id), 1);
    for (const room of [first, second]) {
      if (!room.worktree || !existsSync(room.worktree.root)) throw new Error("deleting room removed the worktree");
      if (!git("branch", "--list", room.worktree.branch).trim()) throw new Error("deleting room removed the branch");
      if (!readFileSync(join(room.cwd, "src", "shared.ts"), "utf8").includes("worktree change"))
        throw new Error("deleting room lost worktree edits");
    }
    if (errors.length) throw new Error(`worktree browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS worktree: UI create, clean baseline, two isolated rooms, file/Git views, terminals and deletion preservation",
    );
  } catch (error) {
    console.error("worktree browser page", page.url(), (await page.locator("body").innerText()).slice(0, 4000));
    throw error;
  } finally {
    await page.close();
    for (const roomId of roomIds) await remove(`/api/rooms/${roomId}`);
    if (nestedProjectId) await remove(`/api/projects/${nestedProjectId}`);
    if (projectId) await remove(`/api/projects/${projectId}`);
    if (agentId) await remove(`/api/agents/${agentId}`);
    for (const room of worktrees) {
      if (!room.worktree || !existsSync(room.worktree.root)) continue;
      const registered = git("worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
      if (registered.some((path) => samePath(path, room.worktree?.root ?? "")))
        git("worktree", "remove", "--force", room.worktree.root);
      else console.warn(`Fixture worktree is no longer registered: ${room.worktree.root}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function terminalPwd(page: Page, base: string, terminal: ProjectTerminalMeta, cwd: string) {
  const expected = realpathSync(cwd);
  const result = await page.evaluate(
    ({ url, terminalId, expectedPath }) =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws/terminal/${terminalId}`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("terminal pwd timed out"));
        }, 10_000);
        let output = "";
        socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "input", data: "pwd\n" })));
        socket.addEventListener("message", (message) => {
          const event = JSON.parse(String(message.data)) as { type: string; data?: string; output?: string };
          output += event.data ?? event.output ?? "";
          if (output.includes(expectedPath)) {
            clearTimeout(timer);
            socket.close();
            resolve(output);
          }
        });
        socket.addEventListener("error", () => reject(new Error("terminal socket failed")));
      }),
    { url: base, terminalId: terminal.id, expectedPath: expected },
  );
  if (!result.includes(expected)) throw new Error(`terminal shell pwd did not match its worktree: ${result}`);
}
