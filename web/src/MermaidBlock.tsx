import { useEffect, useRef, useState } from "react";
import { PreviewImage } from "./ImagePreview";
import { useI18n } from "./i18n";
import { type DiagramTheme, mermaidSourceError, renderMermaid } from "./mermaidRendering";

function readTheme(): DiagramTheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    dark: root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches),
    font: token("--font"),
    surface: token("--surface"),
    background: token("--surface-2"),
    text: token("--text"),
    muted: token("--text-2"),
    border: token("--text-3"),
    accent: token("--accent"),
  };
}

type RenderState = { source: string; theme: string; attempt: number; url?: string; failed?: boolean };

export function MermaidBlock({ source }: { source: string }) {
  const { t: tr } = useI18n();
  const [theme, setTheme] = useState<DiagramTheme | null>(null);
  const [rendered, setRendered] = useState<RenderState | null>(null);
  const [retry, setRetry] = useState(0);
  const version = useRef(0);
  const themeKey = JSON.stringify(theme);
  const sourceError = mermaidSourceError(source);
  const current =
    rendered?.source === source && rendered.theme === themeKey && rendered.attempt === retry ? rendered : null;
  // Theme redraws preserve the same content and preview instance until their replacement is ready.
  // A changed source must never inherit an older diagram, even while streaming or after a failure.
  const displayUrl = !sourceError && rendered?.source === source ? rendered.url : undefined;

  useEffect(() => {
    const update = () => {
      const next = readTheme();
      setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const request = ++version.current;
    let active = true;
    const isCurrent = () => active && request === version.current;
    if (!theme || sourceError) return;
    // Debounce streaming fragments; stale queued jobs are skipped before loading or rendering.
    const timer = window.setTimeout(() => {
      void renderMermaid(source, theme, isCurrent).then(
        (url) => {
          if (url && isCurrent()) setRendered({ source, theme: themeKey, attempt: retry, url });
        },
        () => {
          if (isCurrent())
            setRendered((previous) => ({
              source,
              theme: themeKey,
              attempt: retry,
              failed: true,
              url: previous?.source === source ? previous.url : undefined,
            }));
        },
      );
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source, theme, themeKey, sourceError, retry]);

  const status =
    (sourceError ? tr(sourceError) : null) ??
    (current?.failed
      ? displayUrl
        ? tr("图表更新失败，当前显示上次图表，可查看源码")
        : tr("图表暂时无法显示，可查看源码")
      : displayUrl
        ? tr("正在更新图表…")
        : tr("正在绘制图表…"));
  return (
    <div className="mermaid-block">
      {displayUrl && (
        <div className="mermaid-canvas">
          <PreviewImage imageClassName="mermaid-svg" src={displayUrl} alt={tr("Mermaid 图表")} />
        </div>
      )}
      {(!displayUrl || !current || current.failed) && (
        <div className="mermaid-status">
          <span>{status}</span>
          {current?.failed && !sourceError && (
            <button type="button" className="linkish" onClick={() => setRetry((value) => value + 1)}>
              {tr("重试")}
            </button>
          )}
        </div>
      )}
      {displayUrl ? (
        <details className="mermaid-source">
          <summary>{tr("Mermaid 源码")}</summary>
          <pre>
            <code className="language-mermaid">{source}</code>
          </pre>
        </details>
      ) : (
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      )}
    </div>
  );
}
