export const FILE_PREVIEW_MAX_BYTES = 1024 * 1024;

export type FilePreviewKind = "markdown" | "html" | "code" | "text";

export interface FilePreviewType {
  kind: FilePreviewKind;
  language?: string;
}

export interface FilePreviewContent extends FilePreviewType {
  text: string;
  /** Original bytes, including an optional UTF-8 BOM. */
  size: number;
}

const sourceLanguages: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  py: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "shell",
  ps1: "powershell",
  bat: "dos",
  cmd: "dos",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  xsl: "xml",
  xsd: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "xml",
  svelte: "xml",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  scala: "scala",
  pl: "perl",
  pm: "perl",
  cmake: "cmake",
  diff: "diff",
  patch: "diff",
};

const textNames = new Set([
  ".gitignore",
  ".dockerignore",
  ".gitattributes",
  ".prettierignore",
  ".eslintignore",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".tool-versions",
  "license",
  "copying",
  "authors",
]);
const iniNames = new Set([".editorconfig", ".gitconfig", ".npmrc", ".yarnrc"]);
const shellNames = new Set([".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"]);
const jsonNames = new Set([".babelrc", ".eslintrc", ".prettierrc"]);

/** A display hint only; the server separately enforces byte, encoding and file-access limits. */
export function getFilePreviewType(name: string, mimeType: string): FilePreviewType | null {
  const base = name.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  const extension = base.includes(".") ? (base.split(".").at(-1) ?? "") : "";
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (["md", "markdown", "mdown", "mkd"].includes(extension)) return { kind: "markdown" };
  if (["html", "htm", "xhtml"].includes(extension)) return { kind: "html" };
  if (/^dockerfile(?:\.|$)/.test(base)) return { kind: "code", language: "dockerfile" };
  if (["makefile", "gnumakefile", "bsdmakefile"].includes(base)) return { kind: "code", language: "makefile" };
  if (base === "cmakelists.txt") return { kind: "code", language: "cmake" };
  if (base === ".env" || base.startsWith(".env.") || iniNames.has(base)) return { kind: "code", language: "ini" };
  if (shellNames.has(base)) return { kind: "code", language: "bash" };
  if (jsonNames.has(base)) return { kind: "code", language: "json" };
  const language = Object.hasOwn(sourceLanguages, extension) ? sourceLanguages[extension] : undefined;
  if (language) return { kind: "code", language };
  if (textNames.has(base) || ["txt", "text", "log", "csv", "tsv", "conf", "cfg", "lock"].includes(extension))
    return { kind: "text" };
  if (mime === "text/markdown" || mime === "text/x-markdown") return { kind: "markdown" };
  if (mime === "text/html" || mime === "application/xhtml+xml") return { kind: "html" };
  if (mime === "application/json" || mime.endsWith("+json")) return { kind: "code", language: "json" };
  if (["application/javascript", "text/javascript", "application/x-javascript"].includes(mime))
    return { kind: "code", language: "javascript" };
  if (["application/typescript", "text/typescript"].includes(mime)) return { kind: "code", language: "typescript" };
  if (["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"].includes(mime))
    return { kind: "code", language: "yaml" };
  if (["application/xml", "text/xml"].includes(mime)) return { kind: "code", language: "xml" };
  if (mime === "application/x-sh") return { kind: "code", language: "bash" };
  return mime.startsWith("text/") ? { kind: "text" } : null;
}
