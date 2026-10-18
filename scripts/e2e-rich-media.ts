import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Message, Store } from "../server/store";
import type { Timeline } from "../shared/timeline";

/** Real built UI and persisted messages; deterministic ACP-shaped updates avoid paid model calls. */
export async function richMediaSmoke(
  browser: Browser,
  base: string,
  store: Store,
  publish: (message: Message) => void,
  shotsDir?: string,
) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  const errors: string[] = [];
  const unexpected: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("diagram-resource.invalid")) unexpected.push(request.url());
  });
  const imageUrl = "https://rich-media.invalid/design.png";
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1000;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    context.fillStyle = "#f5f5f4";
    context.fillRect(0, 0, 1600, 1000);
    context.fillStyle = "#18181b";
    context.font = "bold 72px sans-serif";
    context.fillText("团团 · 协作流程", 100, 150);
    for (const [index, label] of ["规划", "并行执行", "汇总"].entries()) {
      context.fillStyle = ["#e8462b", "#2f6fed", "#16a34a"][index] as string;
      context.beginPath();
      context.roundRect(100 + index * 480, 300, 420, 360, 32);
      context.fill();
      context.fillStyle = "#ffffff";
      context.font = "48px sans-serif";
      context.fillText(label, 145 + index * 480, 510);
    }
    return canvas.toDataURL("image/png").split(",")[1] as string;
  });
  await page.route(imageUrl, (route) => route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }));
  await page.route("https://diagram-resource.invalid/**", (route) => route.fulfill({ status: 200, body: "" }));
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`rich media fixture ${path}: ${response.status}`);
    return response.json() as Promise<T>;
  };
  const agent = await request<{ id: string }>("POST", "/api/agents", {
    name: "图文助手",
    harness: "mock",
    avatarShape: "panda",
  });
  const room = await request<{ id: string }>("POST", "/api/rooms", {
    name: "图文渲染回归",
    agentIds: [agent.id],
  });
  const textTimeline = (text: string): Timeline => ({ parts: [{ kind: "text", text }], tools: {}, plan: null });
  const insert = (text: string, timeline = textTimeline(text), status: "done" | "streaming" = "done") => {
    const message = store.insertMessage({
      roomId: room.id,
      runId: crypto.randomUUID(),
      hop: 0,
      senderKind: "agent",
      senderId: agent.id,
      senderName: "图文助手",
      content: text,
      status,
    });
    return store.updateReply(message.id, { content: text, status, timeline });
  };
  const flow = "flowchart LR\n A[需求] --> B{确认方案}\n B --> C[Agent 并行执行]\n C --> D[汇总结果]";
  const sequence =
    "sequenceDiagram\n participant A as 用户\n participant B as 团团\n A->>B: 发起任务\n B-->>A: 返回结果";
  const markdown = [
    "### 协作流程",
    `\`\`\`mermaid\n${flow}\n\`\`\``,
    `\`\`\`mermaid\n${sequence}\n\`\`\``,
    "|阶段|状态|\n|---|---|\n|验证|完成|",
    "```ts\nconst ready = true;\n```",
    `![界面预览](${imageUrl})`,
  ].join("\n\n");
  const message = insert(markdown, undefined, "streaming");
  const unfinished = insert("```mermaid\nflowchart LR\n A[", undefined, "streaming");
  const unsafe = insert('```mermaid\nflowchart LR\n A@{ "im\\u0067": "https://diagram-resource.invalid/track" }\n```');
  const unsafeSequence = insert(
    '```mermaid\nsequenceDiagram\n participant Alice\n participant Bob\n properties Alice: {"icon":"https://diagram-resource.invalid/sequence-icon"}\n Alice->>Bob: hello\n```',
  );
  const attachment = insert("", {
    parts: [
      { kind: "image", mimeType: "image/png", data: png },
      { kind: "tool", toolCallId: "image" },
    ],
    tools: {
      image: {
        toolCallId: "image",
        title: "生成预览图片",
        kind: "other",
        status: "completed",
        locations: [],
        content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: png } }],
      },
    },
    plan: null,
  });
  const shot = async (name: string) => {
    if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  };
  const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
  const decodedDiagram = () =>
    row(message.id)
      .locator(".mermaid-svg")
      .first()
      .evaluate((element) => decodeURIComponent((element as HTMLImageElement).src.split(",").slice(1).join(",")));
  try {
    await page.goto(`${base}/#/c/${room.id}`);
    await row(message.id).locator(".mermaid-svg").nth(1).waitFor();
    if (!(await page.title()).includes("团团") || !page.url().endsWith(`/#/c/${room.id}`))
      throw new Error("rich media smoke opened the wrong page");
    if (await page.locator("vite-error-overlay").count()) throw new Error("rich media page has a framework overlay");
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>(".mermaid-svg")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    if (!(await row(message.id).locator("table").count()) || !(await row(message.id).locator(".hljs-keyword").count()))
      throw new Error("Mermaid broke tables or ordinary code highlighting");
    const light = await decodedDiagram();
    if (!light.includes("需求") || !light.includes("汇总结果")) throw new Error("flowchart lost its labels");
    await row(message.id).locator(".mermaid-source").first().locator("summary").click();
    if ((await row(message.id).locator(".mermaid-source").first().locator("code").textContent())?.trim() !== flow)
      throw new Error("diagram source is not preserved");
    await row(message.id).locator(".mermaid-source").first().locator("summary").click();
    await row(message.id).scrollIntoViewIfNeeded();
    await shot("rich-media-light");

    const diagramTrigger = row(message.id).getByRole("button", { name: "放大预览：Mermaid 图表", exact: true }).first();
    const inlineDiagram = await row(message.id).locator(".mermaid-svg").first().boundingBox();
    await diagramTrigger.click();
    const diagramPreview = page.locator("dialog.image-preview[open]");
    await diagramPreview.waitFor();
    const enlargedDiagram = await diagramPreview.locator(".image-preview-viewport img").boundingBox();
    if (!inlineDiagram || !enlargedDiagram || enlargedDiagram.width <= inlineDiagram.width + 100)
      throw new Error(`diagram preview did not enlarge: ${JSON.stringify({ inlineDiagram, enlargedDiagram })}`);
    await shot("mermaid-preview-light");
    await page.keyboard.press("Escape");
    await diagramPreview.waitFor({ state: "hidden" });
    if (!(await diagramTrigger.evaluate((element) => element === document.activeElement)))
      throw new Error("diagram preview did not restore keyboard focus");

    const lightUrl = await row(message.id).locator(".mermaid-svg").first().getAttribute("src");
    await diagramTrigger.click();
    await diagramPreview.waitFor();
    await diagramPreview.getByRole("button", { name: "原图", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(
      ({ id, previous }) =>
        document.querySelector<HTMLImageElement>(`[data-message-id="${id}"] .mermaid-svg`)?.src !== previous,
      { id: message.id, previous: lightUrl },
    );
    await row(message.id).locator(".mermaid-svg").nth(1).waitFor();
    const dark = await decodedDiagram();
    if (dark === light || !dark.includes("#f2f2f3")) throw new Error("diagram did not adopt the dark text palette");
    if (
      !(await diagramPreview.count()) ||
      !(await diagramPreview.locator('.image-preview-viewport[data-original="true"]').count()) ||
      !(await diagramPreview.evaluate((element) => element.contains(document.activeElement)))
    )
      throw new Error("changing the theme closed the diagram preview or lost its zoom/focus state");
    if ((await diagramPreview.locator(".image-preview-viewport img").getAttribute("src")) === lightUrl)
      throw new Error("the open preview retained the old diagram theme");
    await diagramPreview.getByRole("button", { name: "适应窗口", exact: true }).click();
    await shot("mermaid-preview-dark");
    await diagramPreview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
    await shot("rich-media-dark");
    await page.emulateMedia({ colorScheme: "light" });

    await row(unfinished.id).getByText("图表暂时无法显示，可查看源码", { exact: true }).waitFor();
    if (!(await row(unfinished.id).locator("code").textContent())?.includes("A["))
      throw new Error("incomplete diagram lost its source");
    await row(unsafe.id).getByText("图表中的 HTML 和外部图片不受支持，请查看源码", { exact: true }).waitFor();
    await row(unsafeSequence.id).getByText("图表中的 HTML 和外部图片不受支持，请查看源码", { exact: true }).waitFor();
    const repaired = "```mermaid\nflowchart LR\n A[生成完成] --> B[继续阅读]\n```";
    publish(store.updateReply(unfinished.id, { content: repaired, status: "done", timeline: textTimeline(repaired) }));
    await row(unfinished.id).locator(".mermaid-svg").waitFor();

    const trigger = row(message.id).getByRole("button", { name: "放大预览：界面预览", exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    const scrollBefore = await page.locator(".messages").evaluate((element) => element.scrollTop);
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.image-preview[open]");
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "原图", exact: true }).click();
    if (!(await dialog.locator('.image-preview-viewport[data-original="true"]').count()))
      throw new Error("original image mode did not activate");
    await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
    const imageSize = await dialog.locator(".image-preview-viewport img").boundingBox();
    if (!imageSize || imageSize.width <= 320 || imageSize.width > 1440 || imageSize.height > 1000)
      throw new Error(`preview does not fit the viewport: ${JSON.stringify(imageSize)}`);
    const close = dialog.getByRole("button", { name: "关闭图片预览", exact: true });
    await close.focus();
    await page.keyboard.press("Tab");
    if (
      !(await dialog
        .getByRole("button", { name: "原图", exact: true })
        .evaluate((element) => element === document.activeElement))
    )
      throw new Error("image preview focus escaped the dialog");
    const appended = `${markdown}\n\n后续流式内容`;
    publish(
      store.updateReply(message.id, { content: appended, status: "streaming", timeline: textTimeline(appended) }),
    );
    await row(message.id).getByText("后续流式内容", { exact: true }).waitFor();
    if (!(await dialog.count())) throw new Error("streaming closed the open image preview");
    await shot("image-preview-desktop");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (!(await trigger.evaluate((element) => element === document.activeElement)))
      throw new Error("closing image preview did not restore focus");
    if (Math.abs((await page.locator(".messages").evaluate((element) => element.scrollTop)) - scrollBefore) > 2)
      throw new Error("preview moved the message reading position");

    const attachmentRow = row(attachment.id);
    await attachmentRow.hover();
    await attachmentRow.getByRole("button", { name: "更多消息操作", exact: true }).click();
    await page
      .getByRole("dialog", { name: "消息操作", exact: true })
      .getByRole("button", { name: "查看详情", exact: true })
      .click();
    await page.getByRole("heading", { name: "回复详情", exact: true }).waitFor();
    const toolDetails = page.locator(".details .timeline details.tool", { hasText: "生成预览图片" });
    await toolDetails.waitFor();
    await toolDetails.locator("summary").click();
    await toolDetails.getByRole("button", { name: "放大预览：工具图片", exact: true }).click();
    await dialog.waitFor();
    await close.click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "关闭详情面板", exact: true }).click();
    await page.getByRole("heading", { name: "回复详情", exact: true }).waitFor({ state: "hidden" });

    await page.setViewportSize({ width: 720, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await trigger.click();
    await dialog.waitFor();
    await shot("image-preview-narrow-dark");
    const panel = await dialog.locator(".image-preview-panel").boundingBox();
    if (!panel || panel.x < 0 || panel.y < 0 || panel.x + panel.width > 720 || panel.y + panel.height > 800)
      throw new Error(`image preview overflows the narrow viewport: ${JSON.stringify(panel)}`);
    await page.keyboard.press("Escape");
    await row(message.id).locator(".mermaid-svg").first().scrollIntoViewIfNeeded();
    await shot("rich-media-narrow-dark");
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error("rich media caused horizontal page overflow");
    if (unexpected.length || errors.length)
      throw new Error(`rich media browser issues: ${JSON.stringify({ unexpected, errors })}`);
    console.log(
      "rich media smoke: flowchart + sequence, source/error recovery, theme, all image entries, modal focus + streaming + narrow viewport passed",
    );
  } catch (error) {
    await shot("rich-media-failure");
    console.error("rich media browser diagnostics", { errors, unexpected });
    throw error;
  } finally {
    await page.close();
    await request("DELETE", `/api/rooms/${room.id}`);
    await request("DELETE", `/api/agents/${agent.id}`);
  }
}
