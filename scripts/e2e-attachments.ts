import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Store } from "../server/store";

/** Exercise the browser's file chooser and persisted draft, without calling a paid model. */
export async function attachmentsSmoke(browser: Browser, base: string, store: Store, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const request = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`attachment fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const agent = await request<{ id: string }>("/api/agents", { name: "附件助手", harness: "mock" });
  const room = await request<{ id: string }>("/api/rooms", { name: "文件与图片", agentIds: [agent.id] });
  const other = await request<{ id: string }>("/api/rooms", { name: "另一个草稿", agentIds: [agent.id] });
  const text = "# 发布清单\n\n- 文件内容完整保留\n- @所有人 是文档原文，不触发群聊路由\n";
  const filename = "发布验收清单-包含中文与较长文件名称.md";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=",
    "base64",
  );
  const editor = page.getByRole("textbox", { name: "消息输入框" });
  const add = page.getByRole("button", { name: "添加文件或图片", exact: true });
  const send = page.getByRole("button", { name: "发送", exact: true });
  const settleLayout = () =>
    page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  const open = async (id: string, name: string) => {
    await page.goto(`${base}/#/c/${id}`);
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await editor.waitFor();
    await add.waitFor();
  };
  const select = async (files: { name: string; mimeType: string; buffer: Buffer }[]) => {
    const chooser = page.waitForEvent("filechooser");
    await add.click();
    await (await chooser).setFiles(files);
  };
  try {
    await open(room.id, "文件与图片");
    await select([
      { name: filename, mimeType: "text/markdown", buffer: Buffer.from(text) },
      { name: "示意图.png", mimeType: "image/png", buffer: png },
    ]);
    await page.locator(".attach-row").getByText(filename, { exact: true }).waitFor();
    await page.locator(".attach-row img").waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".send-btn")?.disabled);
    if (await editor.inputValue()) throw new Error("attaching files modified the text draft");
    await open(other.id, "另一个草稿");
    if (await page.locator(".attach-row").count()) throw new Error("attachments leaked into another room");
    await open(room.id, "文件与图片");
    await page.locator(".attach-row").getByText(filename, { exact: true }).waitFor();
    await page.reload();
    await page.locator(".attach-row img").waitFor();
    await page.locator(".attach-row").getByText(filename, { exact: true }).waitFor();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await settleLayout();
      const layout = await page.locator(".composer-box").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const send = element.querySelector(".send-btn");
        const button = send?.getBoundingClientRect();
        const hit = button && document.elementFromPoint(button.left + button.width / 2, button.top + button.height / 2);
        return {
          left: bounds.left,
          right: bounds.right,
          width: innerWidth,
          overflow: document.body.scrollWidth > innerWidth,
          bottom: bounds.bottom,
          height: innerHeight,
          sendVisible: !!button && button.top >= 0 && button.bottom <= innerHeight && !!hit && !!send?.contains(hit),
        };
      });
      if (
        layout.left < 0 ||
        layout.right > layout.width + 1 ||
        layout.overflow ||
        layout.bottom > layout.height + 1 ||
        !layout.sendVisible
      )
        throw new Error(`attachment composer overflows at ${width}px: ${JSON.stringify(layout)}`);
      if (shotsDir) await page.screenshot({ path: join(shotsDir, `attachments-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settleLayout();
    const endpoint = `${base}/api/rooms/${room.id}/messages`;
    await page.route(endpoint, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "附件发送失败测试" }),
          })
        : route.continue(),
    );
    await send.click();
    await page.getByRole("alert").filter({ hasText: "附件发送失败测试" }).waitFor();
    if (!(await page.locator(".attach-row img").count())) throw new Error("failed send discarded the image");
    await page.locator(".attach-row").getByText(filename, { exact: true }).waitFor();
    await page.unroute(endpoint);
    await send.click();
    await page.locator(".attach-row").waitFor({ state: "detached" });
    const human = store.recentMessages(room.id, 10).find((message) => message.senderKind === "human");
    const file = human?.timeline?.parts.find((part) => part.kind === "file");
    const image = human?.timeline?.parts.find((part) => part.kind === "image");
    if (
      !human ||
      human.content ||
      file?.kind !== "file" ||
      file.name !== filename ||
      Buffer.from(file.data, "base64").toString() !== text
    )
      throw new Error("file-only request did not preserve its original bytes and empty text");
    if (image?.kind !== "image" || !Buffer.from(image.data, "base64").equals(png))
      throw new Error("image attachment bytes changed in transit");
    const message = page.locator(`[data-message-id="${human.id}"]`);
    const download = page.waitForEvent("download");
    await message.getByRole("link", { name: `下载文件 ${filename}`, exact: true }).click();
    const downloaded = await download;
    const path = await downloaded.path();
    if (!path || !readFileSync(path).equals(Buffer.from(text)) || downloaded.suggestedFilename() !== filename)
      throw new Error("downloaded attachment does not match its original file");

    await page.locator(".composer-box").evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(["drag contents"], "拖入.txt", { type: "text/plain" }));
      element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await page.locator(".attach-row").getByText("拖入.txt", { exact: true }).waitFor();
    await editor.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(["clipboard contents"], "粘贴.txt", { type: "text/plain" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator(".attach-row").getByText("粘贴.txt", { exact: true }).waitFor();
    await page.getByRole("button", { name: "移除文件 拖入.txt", exact: true }).click();
    await page.getByRole("button", { name: "移除文件 粘贴.txt", exact: true }).click();
    await page.locator(".attach-row").waitFor({ state: "detached" });
    await select([{ name: "过大.txt", mimeType: "text/plain", buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 65) }]);
    await page.getByRole("alert").filter({ hasText: "5 MiB" }).waitFor();
    if (await page.locator(".attach-row").count()) throw new Error("oversized file was silently attached");

    const textAgent = await request<{ id: string }>("/api/agents", {
      name: "纯文本助手",
      harness: "mock",
      env: { MOCK_AGENT_IMAGE: "0" },
    });
    const textRoom = await request<{ id: string }>("/api/rooms", { name: "图片能力关闭", agentIds: [textAgent.id] });
    // These fixtures bypass the UI's create-and-reload flow; a hash-only goto keeps its old room snapshot.
    await page.reload();
    await open(textRoom.id, "图片能力关闭");
    await select([{ name: "示意图.png", mimeType: "image/png", buffer: png }]);
    await page.locator(".attach-row img").waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: /正在读取/ })
      .waitFor({ state: "hidden" });
    await page
      .locator(".composer-box")
      .getByText(/不支持图片/)
      .waitFor();
    if (await send.isEnabled()) throw new Error("image-unsupported recipient allowed an image send");
    if (!(await page.locator(".attach-row img").count())) throw new Error("unsupported image was silently dropped");
    await page.getByRole("button", { name: "移除图片", exact: true }).click();
    await select([{ name: "可读文本.txt", mimeType: "text/plain", buffer: Buffer.from("plain text attachment") }]);
    await page.locator(".attach-row").getByText("可读文本.txt", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".send-btn")?.disabled);
    if (!(await send.isEnabled())) throw new Error("image-unsupported harness could not send a text file");
    await send.click();
    await page.locator(".attach-row").waitFor({ state: "detached" });
    if (errors.length) throw new Error(`attachment browser errors: ${errors.join("; ")}`);
  } finally {
    await page.close();
  }
}
