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

function markupEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

/** Only inspect the document prefix; an <html> string inside content is never an attribute source. */
function leadingHtmlTag(source: string): string | null {
  let index = 0;
  // The preview response bounds the entire source to 1 MiB.
  while (index < source.length) {
    while (/[\t\n\f\r \uFEFF]/.test(source[index] ?? "")) index++;
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    const prefix = source.slice(index, index + 16);
    if (/^<!doctype(?:\s|>)/i.test(prefix) || /^<\?xml(?:\s|\?)/i.test(prefix)) {
      const end = markupEnd(source, index);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    if (!/^<html(?=[\t\n\f\r />])/i.test(prefix)) return null;
    const end = markupEnd(source, index + 5);
    return end < 0 ? null : source.slice(index, end + 1);
  }
  return null;
}

const SAFE_RASTER_DATA_URI = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i;

/** Strip external @import and non-raster url() references so CSS parsing never initiates network probes. */
function sanitizeStaticCss(css: string): string {
  return css
    .replace(/@import\b[\s\S]*?(?:;|\{[\s\S]*?\})/gi, "")
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (full, dq, sq, bare) => {
      const target = String(dq ?? sq ?? bare ?? "").trim();
      if (!target || target.startsWith("#") || SAFE_RASTER_DATA_URI.test(target)) return full;
      return "none";
    });
}

/** Parse into an inert template, never a detached document that could start resource requests. */
export function staticHtmlDocument(source: string): string {
  const template = document.createElement("template");
  // Template contents own an inert document (no browsing context). An html-context fragment
  // keeps the real head/body and their attributes; parsing directly into a template drops them.
  const root = template.content.ownerDocument.createElement("html");
  template.content.append(root);
  root.innerHTML = source;
  // Fragment parsing ignores the outer html start tag. Parse that isolated prefix as an inert
  // ordinary element, then subject its attributes to the same sanitizer as every other node.
  const htmlTag = leadingHtmlTag(source);
  if (htmlTag) {
    const attributes = template.content.ownerDocument.createElement("template");
    attributes.innerHTML = htmlTag.replace(/^<html/i, "<div");
    const element = attributes.content.firstElementChild;
    if (element) for (const attribute of element.attributes) root.setAttributeNode(attribute.cloneNode() as Attr);
  }
  const pending: Element[] = [root];
  let count = 0;
  while (pending.length) {
    const element = pending.pop();
    if (!element) continue;
    if (++count > 20_000) throw new Error("页面结构过于复杂，请查看源码");
    const tag = element.localName.toLowerCase();
    if (removedTags.has(tag)) {
      // Removing templates also removes their inert nested trees and declarative shadow roots.
      element.remove();
      continue;
    }
    if (tag === "style" && element.textContent) {
      element.textContent = sanitizeStaticCss(element.textContent);
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === "style") {
        attribute.value = sanitizeStaticCss(attribute.value);
        continue;
      }
      const rasterSource = name === "src" && tag === "img" && SAFE_RASTER_DATA_URI.test(attribute.value);
      if (name.startsWith("on") || removedAttributes.has(name) || (name === "src" && !rasterSource))
        element.removeAttribute(attribute.name);
    }
    if (["input", "button", "select", "textarea"].includes(tag)) element.setAttribute("disabled", "");
    for (const child of element.children) pending.push(child);
  }
  // The document parser puts this trusted prefix in head, then merges the authored html
  // attributes. Thus even root/body inline styles are encountered only after the policy.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}"><meta name="referrer" content="no-referrer">${root.outerHTML}`;
}
