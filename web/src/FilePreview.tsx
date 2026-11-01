import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FilePreviewContent } from "../../shared/filePreview";
import { highlightedSourceLines } from "./filePreviewContent";
import { useI18n } from "./i18n";
import { highlightCode } from "./ui";
import "./filePreview.css";

const HIGHLIGHT_MAX_BYTES = 100 * 1024;
const SOURCE_ROWS_MAX = 3000;
const markdownPlugins = [remarkGfm];

function canHighlight(text: string, size?: number) {
  return (
    (size ?? new TextEncoder().encode(text).length) <= HIGHLIGHT_MAX_BYTES && text.split("\n").length <= SOURCE_ROWS_MAX
  );
}

export function PreviewMarkdown({ text }: { text: string }) {
  const { t } = useI18n();
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href }) => (
        <span className="file-preview-inert-link" title={href}>
          {children}
        </span>
      ),
      img: ({ alt }) => (
        <span className="file-preview-image-placeholder">{t("图片未加载：{name}", { name: alt || t("图片") })}</span>
      ),
      code: ({ children, className }) => {
        const source = String(children ?? "");
        const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
        const highlighted = canHighlight(source) ? highlightCode(source, language) : null;
        return highlighted ? (
          <code
            className={className}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes source; only its registered token spans are inserted
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className={className}>{children}</code>
        );
      },
    }),
    [t],
  );
  return (
    <div className="md file-preview-markdown">
      <Markdown remarkPlugins={markdownPlugins} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

export function SourceView({ content, wrap }: { content: FilePreviewContent; wrap: boolean }) {
  const lineCount = useMemo(() => content.text.split("\n").length, [content.text]);
  const rows = useMemo(() => {
    if (lineCount > SOURCE_ROWS_MAX) return null;
    const language = content.kind === "html" ? "xml" : content.language;
    return highlightedSourceLines(
      content.text,
      canHighlight(content.text, content.size) ? highlightCode(content.text, language) : null,
    );
  }, [content, lineCount]);
  const { t } = useI18n();
  const numbers = useMemo(
    () => (rows ? "" : Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")),
    [lineCount, rows],
  );
  return (
    <section
      className="file-preview-source"
      data-wrap={(wrap && !!rows) || undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: source region receives focus for keyboard scrolling
      tabIndex={0}
      aria-label={t("文件源码")}
    >
      {rows ? (
        <pre className="file-preview-code">
          <code>
            {rows.map((tokens, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: source lines are immutable within a preview response
              <span className="file-preview-code-line" key={index}>
                <span className="file-preview-line-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="file-preview-line-content">
                  {tokens.length
                    ? tokens.map((token, tokenIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: highlight tokens are immutable within a source line
                        <span key={tokenIndex} className={token.className}>
                          {token.text}
                        </span>
                      ))
                    : "\u200b"}
                </span>
              </span>
            ))}
          </code>
        </pre>
      ) : (
        <div className="file-preview-plain-source">
          <pre className="file-preview-number-gutter" aria-hidden="true">
            {numbers}
          </pre>
          <pre>
            <code>{content.text || "\u200b"}</code>
          </pre>
        </div>
      )}
    </section>
  );
}
