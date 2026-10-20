import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { Store } from "../server/store";
import { emptyTimeline } from "../shared/timeline";

/** Preview real persisted attachments in the built app, including untrusted active content. */
export async function filePreviewSmoke(browser: Browser, base: string, store: Store, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  const resourceRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("__file_preview_probe")) resourceRequests.push(request.url());
  });
  const agentResponse = await fetch(`${base}/api/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "文件预览助手", harness: "mock" }),
  });
  if (!agentResponse.ok) throw new Error(`preview fixture agent: ${agentResponse.status}`);
  const agent = (await agentResponse.json()) as { id: string };
  const response = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "文件预览验收", agentIds: [agent.id] }),
  });
  if (!response.ok) throw new Error(`preview fixture room: ${response.status}`);
  const room = (await response.json()) as { id: string };
  const attachment = (name: string, bytes: string | Buffer, mimeType = "text/plain") => {
    const message = store.insertMessage({
      roomId: room.id,
      content: `预览文件：${name}`,
      runId: "file-preview-e2e",
      hop: 0,
      senderKind: "human",
      senderId: null,
      senderName: "我",
      status: "done",
    });
    store.updateReply(message.id, {
      content: message.content,
      status: "done",
      timeline: {
        ...emptyTimeline(),
        parts: [{ kind: "file", name, mimeType, data: Buffer.from(bytes).toString("base64") }],
      },
    });
  };
  const markdown = `# 项目交付说明\n\n直接在团团检查 **文档与代码**。\n\n| 项目 | 状态 |\n| --- | --- |\n| 文件预览 | 已完成 |\n\n\`\`\`ts\nconst release = "0.2.5";\n\`\`\`\n\n![外部图片](https://example.invalid/__file_preview_probe/md.png)\n\n<script>window.__filePreviewExecuted = true</script>\n`;
  const code = 'export const version: string = "0.2.5";\nconst literal = "<script>unsafe()</script>";\n';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @import url("https://example.invalid/__file_preview_probe/import.css");
    body{margin:0;padding:40px;font:16px/1.7 system-ui;background:#f1f5f3;color:#183e35}
    main{max-width:760px;margin:auto}h1{font-size:36px;line-height:1.3}p{color:#5c736b}
    section{background:white;border:1px solid #d6e1dc;border-radius:16px;padding:24px;margin-top:24px}
    .tag{font-size:12px;letter-spacing:2px;color:#387d68}.bar{height:12px;background:#418870;border-radius:6px;width:80%}
    body::after{content:"";display:block;width:1px;height:1px;background-image:url("https://example.invalid/__file_preview_probe/css.png")}
    </style><meta http-equiv="refresh" content="0;url=${base}/__file_preview_probe/refresh"><base href="https://example.invalid/"></head>
    <body><main><div class="tag">TUANTUAN / DELIVERY</div><h1>每一次交付，都清晰可见</h1><p>文档、代码和页面，在会话里直接检查。</p><section><h2>本周进展</h2><p>8 项任务已完成 · 2 项进行中</p><div class="bar"></div></section>
    <svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#418870"/></svg>
    <a href="${base}/__file_preview_probe/link" target="_top">外部链接测试</a>
    <svg width="180" height="30"><a href="${base}/__file_preview_probe/svg"><text x="0" y="20">SVG 链接测试</text></a></svg>
    <form action="${base}/__file_preview_probe/form"><button>提交测试</button></form>
    <img src="https://example.invalid/__file_preview_probe/image.png" onerror="parent.__filePreviewExecuted=true">
    <iframe src="${base}/__file_preview_probe/frame"></iframe>
    <script>window.__filePreviewExecuted=true;parent.__filePreviewExecuted=true;fetch('${base}/__file_preview_probe/script')</script>
    </main></body></html>`;
  try {
    attachment("交付说明.md", markdown, "text/markdown");
    attachment("版本.ts", code);
    attachment("周报.html", html, "text/html");
    attachment("过大文件.txt", "a".repeat(1024 * 1024 + 1));
    attachment("二进制.txt", Buffer.from([0, 1, 2, 3]));
    attachment("旧编码.txt", Buffer.from([0xff, 0xfe, 0x61, 0]));
    await page.goto(`${base}/#/c/${room.id}`);
    const editor = page.getByRole("textbox", { name: "消息输入框", exact: true });
    await editor.fill("预览后保留草稿");
    await page.getByRole("button", { name: "会话文件", exact: true }).click();
    const list = page.getByRole("dialog", { name: "会话文件", exact: true });
    const preview = page.locator("dialog.file-preview[open]");
    const open = async (name: string) => {
      await list.getByRole("button", { name: `预览文件 ${name}`, exact: true }).click();
      await preview.waitFor();
    };
    const close = async () => {
      await preview.getByRole("button", { name: "关闭文件预览", exact: true }).click();
      await preview.waitFor({ state: "hidden" });
      await list.waitFor();
    };
    await open("交付说明.md");
    await preview.locator(".file-preview-markdown h1").filter({ hasText: "项目交付说明" }).waitFor();
    await preview.locator(".file-preview-markdown table").waitFor();
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, "file-preview-markdown.png") });
    }
    await preview.getByRole("button", { name: "源码", exact: true }).click();
    await preview.locator(".file-preview-source").waitFor();
    if (!(await preview.locator(".file-preview-source").innerText()).includes("# 项目交付说明"))
      throw new Error("Markdown source was not preserved");
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    if (
      !(await list
        .getByRole("button", { name: "预览文件 交付说明.md", exact: true })
        .evaluate((el) => el === document.activeElement))
    )
      throw new Error("preview did not restore trigger focus");
    let failPreviewOnce = true;
    await page.route("**/files/*/preview", async (route) => {
      if (failPreviewOnce) {
        failPreviewOnce = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "暂时无法读取" }),
        });
      } else await route.continue();
    });
    await open("版本.ts");
    await preview.getByRole("alert").waitFor();
    await preview.getByRole("button", { name: "重试预览", exact: true }).click();
    await preview.locator(".file-preview-source .hljs-keyword").first().waitFor();
    await page.unroute("**/files/*/preview");
    await preview.getByRole("button", { name: "自动换行", exact: true }).click();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await preview.getByRole("button", { name: "复制源码", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== code) throw new Error("copy changed original source bytes");
    await close();
    await open("周报.html");
    const frame = page.frameLocator("iframe.file-preview-html");
    await frame.getByRole("heading", { name: "每一次交付，都清晰可见", exact: true }).waitFor();
    if ((await preview.locator("iframe").getAttribute("sandbox")) !== "")
      throw new Error("HTML sandbox grants permissions");
    if (await frame.locator("script,iframe,object,embed,base,meta[http-equiv=refresh]").count())
      throw new Error("active HTML elements survived static preview");
    await frame.getByText("外部链接测试", { exact: true }).click();
    await frame.getByText("SVG 链接测试", { exact: true }).click();
    await page.waitForTimeout(100);
    if (page.url() !== `${base}/#/c/${room.id}` || resourceRequests.length)
      throw new Error(`preview navigated or fetched external resources: ${resourceRequests.join(", ")}`);
    if (await page.evaluate(() => "__filePreviewExecuted" in window)) throw new Error("HTML executed in host");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "file-preview-html.png") });
    // Escape must close only the top dialog, even after focus entered the sandboxed frame.
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    await list.waitFor();
    for (const name of ["过大文件.txt", "二进制.txt", "旧编码.txt"]) {
      await open(name);
      await preview.getByRole("alert").waitFor();
      if (!(await preview.getByRole("button", { name: `下载文件 ${name}`, exact: true }).isEnabled()))
        throw new Error("preview failure removed original download");
      await close();
    }
    await page.setViewportSize({ width: 320, height: 780 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open("交付说明.md");
    await preview.locator(".file-preview-markdown h1").waitFor();
    if (await preview.evaluate((element) => element.scrollWidth > element.clientWidth + 1))
      throw new Error("file preview horizontally overflows at 320px");
    if (shotsDir) await page.screenshot({ path: join(shotsDir, "file-preview-narrow.png") });
    await close();
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "hidden" });
    if ((await editor.inputValue()) !== "预览后保留草稿") throw new Error("preview changed draft");
    if (errors.length) throw new Error(`file preview renderer errors: ${errors.join("; ")}`);
    console.log(
      "file preview: Markdown/source, code/highlight/copy, isolated HTML, errors, focus and narrow layout passed",
    );
  } catch (error) {
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, "file-preview-failure.png") }).catch(() => {});
    }
    throw error;
  } finally {
    await page.close();
    await fetch(`${base}/api/rooms/${room.id}`, { method: "DELETE" });
    await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
  }
}
