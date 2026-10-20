export interface SourceToken {
  text: string;
  className?: string;
}

/** Generated highlighter markup contains only escaped text and spans. Keep multiline token styles. */
export function highlightedSourceLines(text: string, highlighted: string | null): SourceToken[][] {
  if (!highlighted) return text.split("\n").map((line) => [{ text: line }]);
  const template = document.createElement("template");
  template.innerHTML = highlighted;
  const lines: SourceToken[][] = [[]];
  const visit = (node: Node, className = "") => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      for (const [index, part] of parts.entries()) {
        if (index) lines.push([]);
        if (part) lines.at(-1)?.push({ text: part, className: className || undefined });
      }
    } else if (node instanceof Element || node instanceof DocumentFragment) {
      const classes =
        node instanceof Element ? [className, node.getAttribute("class")].filter(Boolean).join(" ") : className;
      for (const child of node.childNodes) visit(child, classes);
    }
  };
  visit(template.content);
  return lines;
}

const STATIC_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'";
const removedTags = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "meta",
  "link",
  "form",
  "template",
  "portal",
  "fencedframe",
  "audio",
  "video",
  "track",
  "foreignobject",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);
const removedAttributes = new Set([
  "href",
  "xlink:href",
  "srcset",
  "srcdoc",
  "action",
  "formaction",
  "ping",
  "poster",
  "background",
  "data",
  "codebase",
  "archive",
  "manifest",
  "autofocus",
  "tabindex",
  "accesskey",
  "download",
  "contenteditable",
  "popover",
  "is",
]);

/** Parse into an inert template, never a detached document that could start resource requests. */
export function staticHtmlDocument(source: string): string {
  const template = document.createElement("template");
  template.innerHTML = source;
  const pending = [...template.content.children];
  let count = 0;
  while (pending.length) {
    const element = pending.pop();
    if (!element) continue;
    if (++count > 20_000) throw new Error("页面结构过于复杂，请查看源码");
    if (removedTags.has(element.localName.toLowerCase())) {
      // Removing templates also removes their inert nested trees and declarative shadow roots.
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const rasterSource =
        name === "src" &&
        element.localName === "img" &&
        /^data:image\/(png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(attribute.value);
      if (name.startsWith("on") || removedAttributes.has(name) || (name === "src" && !rasterSource))
        element.removeAttribute(attribute.name);
    }
    if (["input", "button", "select", "textarea"].includes(element.localName)) element.setAttribute("disabled", "");
    for (const child of element.children) pending.push(child);
  }
  // The policy is encountered before every byte of imported markup or CSS.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}"><meta name="referrer" content="no-referrer"></head><body>${template.innerHTML}</body></html>`;
}
