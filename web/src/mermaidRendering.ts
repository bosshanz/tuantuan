import type { Mermaid, MermaidConfig } from "mermaid";

export const MERMAID_MAX_LENGTH = 50_000;

/** Diagram authors control content, never the renderer's configuration or external resources. */
export function mermaidSourceError(source: string): string | null {
  if (source.length > MERMAID_MAX_LENGTH) return "图表过长，请查看源码";
  if (/^\s*\uFEFF?\s*---(?:\s|$)/u.test(source) || /%%\s*\{/u.test(source))
    return "图表中的配置指令不受支持，请移除后重试";
  // Mermaid parses node metadata as YAML, including quoted and Unicode-escaped keys.
  const inspected = source
    .replace(/\\\r?\n\s*/gu, "")
    .replace(/\\(?:u([\da-fA-F]{4})|x([\da-fA-F]{2})|U([\da-fA-F]{8}))/gu, (escaped, u, x, upper) => {
      const point = Number.parseInt(u ?? x ?? upper, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : escaped;
    });
  // Resource-bearing syntax must be rejected before Mermaid creates its hidden measurement DOM.
  // strict sanitizes HTML/callbacks, but sequence properties can still insert remote SVG images;
  // details can import the same properties indirectly from another DOM element.
  const resourceMetadata = /(?:^|[\s,{])["']?(?:img|icon)["']?\s*:/iu.test(inspected);
  const externalProperties = /\b(?:properties|details)[ \t]+[^\r\n;:]+:/iu.test(inspected);
  // Mermaid's plain-text labels understand a bare <br> as a line break; no attributes or other HTML.
  if (/<\/?[a-z][^>]*>/iu.test(inspected.replace(/<br\s*\/?>/giu, "")) || resourceMetadata || externalProperties)
    return "图表中的 HTML 和外部图片不受支持，请查看源码";
  // No aliases in node metadata: otherwise an apparently unrelated key can alias the image key.
  if (/@\{[\s\S]*?[&*]/u.test(inspected)) return "图表中的资源别名不受支持，请查看源码";
  if (/url\s*\(|@import/iu.test(inspected) || /\b(?:style|classDef|linkStyle)\b[\s\S]*\\/iu.test(source))
    return "图表中的外部样式资源不受支持，请查看源码";
  return null;
}

export type DiagramTheme = {
  dark: boolean;
  font: string;
  surface: string;
  background: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
};

export function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    maxTextSize: MERMAID_MAX_LENGTH,
    maxEdges: 500,
    htmlLabels: false,
    theme: "base",
    look: "classic",
    fontFamily: theme.font,
    fontSize: 14,
    flowchart: { htmlLabels: false },
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
    ],
    themeVariables: {
      darkMode: theme.dark,
      fontFamily: theme.font,
      fontSize: "14px",
      background: theme.surface,
      primaryColor: theme.background,
      primaryTextColor: theme.text,
      primaryBorderColor: theme.border,
      secondaryColor: theme.surface,
      secondaryTextColor: theme.text,
      secondaryBorderColor: theme.border,
      tertiaryColor: theme.background,
      tertiaryTextColor: theme.text,
      tertiaryBorderColor: theme.border,
      lineColor: theme.muted,
      textColor: theme.text,
      mainBkg: theme.background,
      nodeBorder: theme.border,
      clusterBkg: theme.surface,
      clusterBorder: theme.border,
      edgeLabelBackground: theme.surface,
      actorBkg: theme.background,
      actorBorder: theme.border,
      actorTextColor: theme.text,
      actorLineColor: theme.muted,
      signalColor: theme.text,
      signalTextColor: theme.text,
      labelBoxBkgColor: theme.background,
      labelBoxBorderColor: theme.border,
      labelTextColor: theme.text,
      loopTextColor: theme.text,
      noteBkgColor: theme.background,
      noteBorderColor: theme.border,
      noteTextColor: theme.text,
      activationBkgColor: theme.surface,
      activationBorderColor: theme.accent,
    },
  };
}

let mermaidModule: Promise<Mermaid> | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** initialize and render share Mermaid's global state, so both belong to the same serialized job. */
export function renderMermaid(source: string, theme: DiagramTheme, isCurrent: () => boolean): Promise<string | null> {
  const error = mermaidSourceError(source);
  if (error) return Promise.reject(new Error(error));
  const job = renderQueue.then(async () => {
    if (!isCurrent()) return null;
    mermaidModule ??= import("mermaid").then(
      (module) => module.default,
      (error) => {
        mermaidModule = undefined;
        throw error;
      },
    );
    const mermaid = await mermaidModule;
    if (!isCurrent()) return null;
    // Mermaid needs an attached, measurable element. The temporary tree never participates in chat layout.
    const host = document.createElement("div");
    host.className = "mermaid-render-host";
    host.setAttribute("aria-hidden", "true");
    document.body.append(host);
    try {
      mermaid.initialize(mermaidConfig(theme));
      const { svg } = await mermaid.render(`tuantuan-mermaid-${++nextId}`, source, host);
      if (!isCurrent()) return null;
      // Mermaid uses percentage dimensions. Give the image a real intrinsic size so the shared
      // preview's original-size mode can expose the full diagram instead of a 300px SVG default.
      const image = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      const viewBox = image
        .getAttribute("viewBox")
        ?.trim()
        .split(/[\s,]+/u)
        .map(Number);
      const width = viewBox?.[2];
      const height = viewBox?.[3];
      if (width && height && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        image.setAttribute("width", String(width));
        image.setAttribute("height", String(height));
      }
      // SVG image documents cannot execute scripts, expose HTML, or activate diagram links/callbacks.
      // Keep diagrams static, including edge animations, for reduced-motion users.
      const staticSvg = new XMLSerializer()
        .serializeToString(image)
        .replace(/<\/svg>\s*$/u, "<style>*{animation:none!important;transition:none!important}</style></svg>");
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(staticSvg)}`;
    } finally {
      host.remove();
    }
  });
  renderQueue = job.catch(() => undefined);
  return job;
}
