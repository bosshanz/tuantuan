import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message, Store } from "../server/store";
import { emptyTimeline } from "../shared/timeline";

/** Built UI + persisted source messages and real local files; no paid models or user directories. */
export async function conversationFilesSmoke(
  browser: Browser,
  base: string,
  store: Store,
  publish: (message: Message) => void,
  shotsDir?: string,
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const scratch = mkdtempSync(join(tmpdir(), "tt-files-e2e-"));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`file fixture ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const agent = await post<{ id: string }>("/api/agents", { name: "文件列表助手", harness: "mock" });
  const project = await post<{ id: string }>("/api/projects", { name: "文件列表验收", cwd: scratch });
  const room = await post<{ id: string }>("/api/rooms", {
    name: "文件与交付记录",
    agentIds: [agent.id],
    projectId: project.id,
  });
  const insert = (content: string, senderKind: "human" | "agent" = "human") =>
    store.insertMessage({
      roomId: room.id,
      content,
      runId: "files-e2e",
      hop: 0,
      senderKind,
      senderId: senderKind === "agent" ? agent.id : null,
      senderName: senderKind === "agent" ? "文件列表助手" : "我",
      status: "done",
    });
  const attachment = (name: string, text: string) => {
    const message = insert(`附件来源 ${name}`);
    store.updateReply(message.id, {
      content: message.content,
      status: "done",
      timeline: {
        ...emptyTimeline(),
        parts: [{ kind: "file", name, mimeType: "text/plain", data: Buffer.from(text).toString("base64") }],
      },
    });
    return message;
  };
  const row = (name: string) => page.locator(".conversation-file-row").filter({ hasText: name });
  const dialog = page.getByRole("dialog", { name: "会话文件与改动", exact: true });
  const open = () => page.getByRole("button", { name: "会话文件", exact: true }).click();
  const sourceRow = (id: string) => page.locator(`[data-message-id="${id}"]`);
  try {
    const originalText = "最早附件：原样保存\n\u0000\n";
    const oldest = attachment("历史原件.txt", originalText);
    for (let i = 0; i < 230; i++) insert(`历史阅读记录 ${i + 1}`);
    for (let i = 0; i < 32; i++) attachment(`附件-${String(i + 1).padStart(2, "0")}.txt`, `附件内容 ${i}`);
    attachment("主动内容.html", "<script>window.__fileExecuted = true</script>");
    writeFileSync(join(scratch, "项目交付.txt"), "项目文件的当前内容\n");
    const artifact = insert("交付：[项目交付](项目交付.txt)\n[已删除的交付](已删除.txt)", "agent");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=";
    const late = insert("稍后完成：[并行交付](并行交付.txt)", "agent");
    store.updateReply(late.id, { content: late.content, status: "streaming", timeline: emptyTimeline() });
    writeFileSync(join(scratch, "并行交付.txt"), "较早发起、较晚完成的交付");
    const image = insert("图片来源");
    store.updateReply(image.id, {
      content: image.content,
      status: "done",
      timeline: { ...emptyTimeline(), parts: [{ kind: "image", mimeType: "image/png", data: png }] },
    });
    await page.goto(`${base}/#/c/${room.id}`);
    await sourceRow(artifact.id).waitFor();
    const editor = page.getByRole("textbox", { name: "消息输入框", exact: true });
    await editor.fill("打开文件列表时保留的草稿");
    await open();
    await dialog.waitFor();
    await row("项目交付.txt").waitFor();
    if (await row("并行交付.txt").count()) throw new Error("streaming message entered file list");
    const completed = store.updateReply(late.id, { content: late.content, status: "done", timeline: emptyTimeline() });
    publish(completed);
    await row("并行交付.txt").waitFor();
    await row("已删除.txt").getByText("文件已不存在", { exact: true }).waitFor();
    if (
      await row("已删除.txt")
        .getByRole("button", { name: /^下载文件 / })
        .count()
    ) {
      if (
        await row("已删除.txt")
          .getByRole("button", { name: /^下载文件 / })
          .isEnabled()
      )
        throw new Error("missing project file still has an enabled download");
    }
    const download = page.waitForEvent("download");
    await row("项目交付.txt").getByRole("button", { name: "下载文件 项目交付.txt", exact: true }).click();
    const artifactDownload = await download;
    const artifactPath = await artifactDownload.path();
    if (!artifactPath || readFileSync(artifactPath, "utf8") !== "项目文件的当前内容\n")
      throw new Error("project file download bytes differ");
    // Preview must stack over the list and Escape must return to the list, not close both.
    await dialog
      .getByRole("button", { name: /^预览图片/ })
      .first()
      .click();
    await page.locator("dialog.image-preview").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("dialog.image-preview").waitFor({ state: "hidden" });
    await dialog.waitFor();
    // An item can disappear after listing. The action must report an error instead of downloading JSON.
    rmSync(join(scratch, "项目交付.txt"));
    await row("项目交付.txt").getByRole("button", { name: "下载文件 项目交付.txt", exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    let pages = 0;
    while (!(await row("历史原件.txt").count())) {
      if (++pages > 12) throw new Error("file list failed to traverse full history");
      await dialog.getByRole("button", { name: /加载更多|更早.*文件|更多文件/ }).click();
      await page.waitForFunction(
        () => !document.querySelector<HTMLButtonElement>(".conversation-files-more")?.disabled,
      );
      await page.waitForTimeout(60);
    }
    const oldDownload = page.waitForEvent("download");
    await row("历史原件.txt").getByRole("button", { name: "下载文件 历史原件.txt", exact: true }).click();
    const oldPath = await (await oldDownload).path();
    if (!oldPath || readFileSync(oldPath, "utf8") !== originalText)
      throw new Error("persisted attachment bytes differ");
    const htmlDownload = page.waitForEvent("download");
    await row("主动内容.html").getByRole("button", { name: "下载文件 主动内容.html", exact: true }).click();
    await htmlDownload;
    if (await page.evaluate(() => "__fileExecuted" in window)) throw new Error("downloaded HTML executed in app");
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await dialog.locator(".conversation-file-row").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shotsDir, "conversation-files.png"), animations: "disabled" });
    }
    await row("历史原件.txt").getByRole("button", { name: "查看来源消息", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await sourceRow(oldest.id).locator("[data-source-highlight]").first().waitFor();
    await page.getByRole("button", { name: "返回刚才位置", exact: true }).click();
    if ((await editor.inputValue()) !== "打开文件列表时保留的草稿") throw new Error("file source jump changed draft");
    await page.setViewportSize({ width: 320, height: 780 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open();
    await row("主动内容.html").waitFor();
    const overflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    if (overflow) throw new Error("file list horizontally overflows at 320px");
    if (shotsDir)
      await page.screenshot({ path: join(shotsDir, "conversation-files-narrow.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (errors.length) throw new Error(`file list renderer errors: ${errors.join("; ")}`);
    console.log(
      "conversation files: history pagination, source jump, drafts, image preview, byte-exact downloads, stale files and narrow layout passed",
    );
  } catch (error) {
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, "conversation-files-failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    await page.close();
    for (const [kind, id] of [
      ["rooms", room.id],
      ["projects", project.id],
      ["agents", agent.id],
    ])
      await fetch(`${base}/api/${kind}/${id}`, { method: "DELETE" });
    rmSync(scratch, { recursive: true, force: true });
  }
}
