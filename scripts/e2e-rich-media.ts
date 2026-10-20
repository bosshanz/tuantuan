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
  const variants = await page.evaluate(() => {
    const draw = (width: number, height: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas unavailable");
      context.fillStyle = "#fafaf9";
      context.fillRect(0, 0, width, height);
      context.fillStyle = "#27272a";
      context.font = "26px sans-serif";
      context.fillText("团团 · 图片预览", 24, 48);
      context.font = "18px sans-serif";
      context.fillText("放大看细节，按 Esc 返回对话", 24, 90);
      if (height > 1000) {
        for (let y = 160; y < height - 80; y += 200) {
          context.fillStyle = y % 400 === 160 ? "#e8462b" : "#2f6fed";
          context.fillRect(24, y, width - 48, 120);
        }
        context.fillStyle = "#27272a";
        context.fillText("长图底部", 24, height - 24);
      }
      return canvas.toDataURL("image/png").split(",")[1] as string;
    };
    return { small: draw(640, 132), tall: draw(400, 3600) };
  });
  for (const [name, data] of Object.entries(variants))
    await page.route(`https://rich-media.invalid/${name}.png`, (route) =>
      route.fulfill({ contentType: "image/png", body: Buffer.from(data, "base64") }),
    );
  let recoverImage = false;
  await page.route("https://rich-media.invalid/retry.png", (route) =>
    route.fulfill({ contentType: "image/png", body: recoverImage ? Buffer.from(png, "base64") : "invalid image" }),
  );
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
  const smallImage = insert("![横向小截图](https://rich-media.invalid/small.png)");
  const tallImage = insert("![长图](https://rich-media.invalid/tall.png)");
  const retryImage = insert("![加载失败](https://rich-media.invalid/retry.png)");
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
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".image-preview-viewport img");
      return image && image.width > 0 && image.naturalWidth > 0;
    });
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
      throw new Error(
        `changing the theme closed the diagram preview or lost its zoom/focus state: ${await page.evaluate(() => JSON.stringify({ active: document.activeElement?.outerHTML.slice(0, 220), original: document.querySelector(".image-preview-viewport")?.getAttribute("data-original"), open: !!document.querySelector("dialog.image-preview[open]") }))}`,
      );
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
    const original = dialog.getByRole("button", { name: "原图", exact: true });
    await original.focus();
    await page.keyboard.press("Tab");
    if (!(await close.evaluate((element) => element === document.activeElement)))
      throw new Error("image preview focus escaped the dialog");
    await page.keyboard.press("Shift+Tab");
    if (!(await original.evaluate((element) => element === document.activeElement)))
      throw new Error("reverse tab escaped the image preview");

    const viewport = dialog.locator(".image-preview-viewport");
    const image = viewport.locator("img");
    const scale = () => dialog.locator(".image-preview-scale").textContent();
    const fitScale = await scale();
    await dialog.getByRole("button", { name: "放大", exact: true }).click();
    if ((await scale()) === fitScale) throw new Error("zoom button did not change the image scale");
    await original.click();
    const naturalSize = await image.boundingBox();
    if (naturalSize?.width !== 1600 || naturalSize.height !== 1000)
      throw new Error("original mode does not show actual image dimensions");
    const bounds = await viewport.boundingBox();
    if (!bounds) throw new Error("missing image viewport");
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 60, center.y - 50, { steps: 5 });
    await page.mouse.up();
    const panned = await image.boundingBox();
    if (!panned || Math.abs(panned.x - naturalSize.x + 60) > 2 || Math.abs(panned.y - naturalSize.y + 50) > 2)
      throw new Error("dragging the image did not pan it");
    if (!(await dialog.count())) throw new Error("finishing an image drag dismissed the preview");
    await viewport.focus();
    await page.keyboard.press("ArrowDown");
    const keyboardPan = await image.boundingBox();
    if (!keyboardPan || keyboardPan.y >= panned.y) throw new Error("keyboard image panning failed");
    await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".image-preview-viewport img");
      return image && image.getBoundingClientRect().width > 1400;
    });
    if ((await scale()) === fitScale) throw new Error("wheel did not zoom the image");
    if ((await page.evaluate(() => window.visualViewport?.scale)) !== 1)
      throw new Error("image zoom changed the browser zoom");
    await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
    await image.dblclick();
    if ((await scale()) === fitScale) throw new Error("double click did not zoom the image");
    await image.dblclick();
    if ((await scale()) !== fitScale) throw new Error("double click did not restore fit mode");
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

    await row(smallImage.id).getByRole("button", { name: "放大预览：横向小截图", exact: true }).click();
    await dialog.waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".image-preview-viewport img")?.width === 640,
    );
    const smallBounds = await image.boundingBox();
    if (smallBounds?.width !== 640 || smallBounds.height !== 132)
      throw new Error("small images should retain their native sharpness when opened");
    await shot("image-preview-small");
    await dialog.getByRole("button", { name: "放大", exact: true }).click();
    await dialog.getByRole("button", { name: "放大", exact: true }).click();
    await shot("image-preview-small-zoomed");
    await page.mouse.click(16, 400);
    await dialog.waitFor({ state: "hidden" });

    await row(tallImage.id).getByRole("button", { name: "放大预览：长图", exact: true }).click();
    await dialog.waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".image-preview-viewport img")?.naturalHeight === 3600,
    );
    const tallFit = await image.boundingBox();
    const tallViewport = await viewport.boundingBox();
    if (!tallFit || !tallViewport || tallFit.height > tallViewport.height + 1 || tallFit.y < tallViewport.y - 1)
      throw new Error("the complete tall image does not fit");
    await original.click();
    await viewport.focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");
    const tallBottom = await image.boundingBox();
    if (!tallBottom || Math.abs(tallBottom.y + tallBottom.height - tallViewport.y - tallViewport.height) > 2)
      throw new Error("the bottom of a tall image cannot be reached");
    await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
    await shot("image-preview-tall");
    await page.keyboard.press("Escape");

    await row(retryImage.id).getByRole("button", { name: "放大预览：加载失败", exact: true }).click();
    await dialog.getByRole("button", { name: "重试", exact: true }).waitFor();
    if (!(await dialog.getByRole("button", { name: "放大", exact: true }).isDisabled()))
      throw new Error("failed images expose active zoom controls");
    recoverImage = true;
    await dialog.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>(".image-preview-viewport img")?.naturalWidth === 1600,
    );
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 720, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await trigger.click();
    await dialog.waitFor();
    await shot("image-preview-narrow-dark");
    const panel = await dialog.locator(".image-preview-panel").boundingBox();
    if (!panel || panel.x < 0 || panel.y < 0 || panel.x + panel.width > 720 || panel.y + panel.height > 800)
      throw new Error(`image preview overflows the narrow viewport: ${JSON.stringify(panel)}`);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.waitForFunction(() => document.querySelector("dialog.image-preview")?.clientHeight === 700);
    const actions = await dialog.locator(".image-preview-action").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
    if (
      actions.some(
        (rect) =>
          rect.x < 0 || rect.x + rect.width > 390 || rect.y < 0 || rect.y + rect.height > 700 || rect.height < 36,
      )
    )
      throw new Error(`narrow preview controls are clipped: ${JSON.stringify(actions)}`);
    await shot("image-preview-mobile");
    const savedProfile = await request<Record<string, unknown>>("GET", "/api/profile");
    try {
      for (const language of ["en", "ja"]) {
        await request("PUT", "/api/profile", { ...savedProfile, language });
        await page.waitForFunction((value) => document.documentElement.lang === value, language);
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 700 });
          await page.waitForFunction(
            (value) => document.querySelector("dialog.image-preview")?.clientWidth === value,
            width,
          );
          const clipped = await dialog.locator(".image-preview-action").evaluateAll((elements) =>
            elements.some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.x < 0 || rect.right > innerWidth || rect.y < 0 || rect.bottom > innerHeight;
            }),
          );
          if (clipped) {
            await shot(`image-preview-clipped-${language}-${width}`);
            const dimensions = await dialog.locator(".image-preview-action").evaluateAll((elements) =>
              elements.map((element) => ({
                label: element.textContent || element.getAttribute("aria-label"),
                rect: element.getBoundingClientRect().toJSON(),
              })),
            );
            throw new Error(`preview controls clipped in ${language} at ${width}px: ${JSON.stringify(dimensions)}`);
          }
          await shot(`image-preview-${language}-${width}`);
        }
      }
    } finally {
      await request("PUT", "/api/profile", savedProfile);
      await page.waitForFunction((value) => document.documentElement.lang === value, savedProfile.language);
    }

    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 720, height: 800 });
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
