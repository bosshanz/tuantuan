import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineView, ToolCard } from "../web/src/Harness";
import { PreviewImage } from "../web/src/ImagePreview";
import {
  type DiagramTheme,
  MERMAID_MAX_LENGTH,
  mermaidConfig,
  mermaidSourceError,
  renderMermaid,
} from "../web/src/mermaidRendering";
import { MessageMarkdown } from "../web/src/ui";

const markdown = (text: string) => renderToStaticMarkup(<MessageMarkdown text={text} mentionNames={["Alice"]} />);

describe("rich message rendering", () => {
  test("only explicit Mermaid code fences become diagrams, preserving ordinary Markdown and highlighting", () => {
    expect(markdown("```mermaid\nflowchart LR\n A --> B\n```")).toContain('class="mermaid-block"');
    for (const source of ["`mermaid`", "    flowchart LR\n    A --> B", "```mermaid-extra\nA-->B\n```", "A --> B"])
      expect(markdown(source)).not.toContain('class="mermaid-block"');
    const ordinary = markdown('```ts\nconst label = "<img src=x onerror=alert(1)>";\n```\n\n**重点** @Alice');
    expect(ordinary).toContain('class="hljs-keyword"');
    expect(ordinary).toContain("&lt;img");
    expect(ordinary).not.toContain("<img");
    expect(ordinary).toContain("<strong>重点</strong>");
    expect(ordinary).toContain('class="mention"');
  });

  test("unfinished and forbidden diagrams preserve escaped, readable source", () => {
    const unfinished = markdown("```mermaid\nflowchart LR\nA[\n");
    expect(unfinished).toContain('class="mermaid-block"');
    expect(unfinished).toContain("A[\n");
    const unsafe = markdown(
      '```mermaid\n%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA["<script>alert(1)</script>"]\n```',
    );
    expect(unsafe).toContain("配置指令不受支持");
    expect(unsafe).toContain("&lt;script&gt;");
    expect(unsafe).not.toContain("<script>");
  });

  test("Markdown images have a keyboard button, including linked images without nested interactive controls", () => {
    const image = markdown('![设计图](https://example.com/image.png "设计图标题")');
    expect(image).toContain('class="image-preview-trigger"');
    expect(image).toContain('aria-haspopup="dialog"');
    expect(image).toContain('aria-label="放大预览：设计图"');
    expect(image).toContain('src="https://example.com/image.png"');
    const linked = markdown("[![设计图](https://example.com/image.png)](https://example.com/page)");
    expect(linked).toContain('class="image-preview-trigger"');
    expect(linked).toContain('href="https://example.com/page"');
    expect(linked).toContain("打开链接</a>");
    expect(linked).not.toMatch(/<a\b[^>]*>[\s\S]*image-preview-trigger/u);
    const nested = markdown("[**![设计图](https://example.com/image.png)**](https://example.com/page)");
    expect(nested).toContain('class="md-linked-image"');
    expect(nested).toContain('<strong><span class="image-preview-wrap">');
    expect(nested).toContain('href="https://example.com/page"');
    expect(nested).not.toMatch(/<a\b[^>]*>[\s\S]*image-preview-trigger/u);
    const mixed = markdown("[查看大图 ![设计图](https://example.com/image.png)](https://example.com/page)");
    expect(mixed).toContain("查看大图 ");
    expect(mixed).toContain('href="https://example.com/page"');
    expect(mixed).toContain("打开链接</a>");
    expect(markdown("[普通链接](https://example.com/page)")).toContain('target="_blank" rel="noreferrer noopener"');
    expect(markdown("![不安全](javascript:alert(1))")).not.toContain("image-preview-trigger");
  });

  test("diagram thumbnails use the same accessible preview without losing the diagram selector", () => {
    const html = renderToStaticMarkup(
      <PreviewImage src="data:image/svg+xml,%3Csvg%2F%3E" alt="Mermaid 图表" imageClassName="mermaid-svg" />,
    );
    expect(html).toContain('aria-label="放大预览：Mermaid 图表"');
    expect(html).toContain('class="image-preview-trigger"');
    expect(html).toContain('class="mermaid-svg"');
  });

  test("ACP timeline and tool images use the same preview entrypoint", () => {
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const timeline = renderToStaticMarkup(
      <TimelineView
        t={{ parts: [{ kind: "image", ...image }], tools: {}, plan: null }}
        streaming
        terminals={{}}
        mentionNames={[]}
      />,
    );
    const tool = renderToStaticMarkup(
      <ToolCard
        tool={{
          toolCallId: "image",
          title: "生成图片",
          kind: "other",
          status: "completed",
          content: [{ type: "content", content: image }],
          locations: [],
        }}
        terminals={{}}
      />,
    );
    for (const html of [timeline, tool]) {
      expect(html).toContain('class="image-preview-trigger"');
      expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
    }
  });
});

test("diagram content cannot override renderer settings or request HTML, images or CSS resources", () => {
  for (const source of [
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    '%% { init: {"htmlLabels":true} } %%\nflowchart LR\nA-->B',
    "\uFEFF---\nconfig:\n  theme: dark\n---\nflowchart LR\nA-->B",
    'flowchart LR\nA["<img src=https://example.com/track>"]',
    'flowchart LR\nA["<br onmouseover=alert(1)>"]',
    'flowchart LR\nA@{ img: "https://example.com/track" }',
    'flowchart LR\nA@{ "img": "https://example.com/track" }',
    'flowchart LR\nA@{ "im\\u0067": "https://example.com/track" }',
    'flowchart LR\nA@{ "im\\U00000067": "https://example.com/track" }',
    'flowchart LR\nA@{ label: &key img, *key: "https://example.com/track" }',
    'flowchart LR\nA@{ icon: "https://example.com/track" }',
    'sequenceDiagram\n participant Alice\n properties Alice: {"icon": "https://example.com/track"}',
    'sequenceDiagram\n participant Alice\n properties Alice: {"ic\\u006fn": "/track"}',
    "sequenceDiagram\n participant Alice\n details Alice: existing-dom-properties",
    'kanban\n item[任务]@{ icon: "https://example.com/track" }',
    "flowchart LR\nA-->B\nclassDef default fill:url(https://example.com/track)",
    "flowchart LR\nA-->B\nclassDef default fill:u\\72l(https://example.com/track)",
    "x".repeat(MERMAID_MAX_LENGTH + 1),
  ])
    expect(mermaidSourceError(source)).not.toBeNull();
  for (const source of [
    "flowchart LR\nA-->B",
    "sequenceDiagram\nAlice->>Bob: 你好",
    "flowchart LR\nA-->B\nclassDef default fill:#f00",
    'flowchart LR\nA["第一行<br/>第二行"]-->B',
  ])
    expect(mermaidSourceError(source)).toBeNull();
});

test("resource-bearing sequence syntax is rejected before entering the Mermaid renderer", async () => {
  const theme: DiagramTheme = {
    dark: false,
    font: "system-ui",
    surface: "#fff",
    background: "#eee",
    text: "#111",
    muted: "#555",
    border: "#888",
    accent: "#f00",
  };
  for (const source of [
    'sequenceDiagram\n participant Alice\n properties Alice: {"icon": "https://diagram-resource.invalid/sequence-icon"}',
    'sequenceDiagram;participant Alice;properties Alice: {"icon": "/relative-icon"}',
    "sequenceDiagram\n participant Alice\n details Alice: existing-dom-properties",
  ]) {
    await expect(renderMermaid(source, theme, () => true)).rejects.toThrow("图表中的 HTML 和外部图片不受支持");
    const html = markdown(`\`\`\`mermaid\n${source}\n\`\`\``);
    expect(html).toContain("图表中的 HTML 和外部图片不受支持");
    expect(html).toContain('class="language-mermaid"');
  }
});

test("both themes retain strict rendering and disable HTML labels", () => {
  const theme: DiagramTheme = {
    dark: false,
    font: "system-ui",
    surface: "#fff",
    background: "#eee",
    text: "#111",
    muted: "#555",
    border: "#888",
    accent: "#f00",
  };
  const light = mermaidConfig(theme);
  const dark = mermaidConfig({ ...theme, dark: true, surface: "#161618", background: "#202023", text: "#f2f2f3" });
  for (const config of [light, dark]) {
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart?.htmlLabels).toBe(false);
    expect(config.startOnLoad).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
  }
  expect(light.themeVariables.primaryTextColor).toBe("#111");
  expect(dark.themeVariables.primaryTextColor).toBe("#f2f2f3");
  expect(dark.themeVariables.darkMode).toBe(true);
});
