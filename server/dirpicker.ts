import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loginShellEnv, which } from "./harness";

/**
 * Choosing a folder. A browser page can't hand over absolute paths, so the server asks the OS:
 * macOS `choose folder` (osascript), Linux zenity / kdialog. When none is available (or disabled with
 * TUANTUAN_NATIVE_PICKER=0) the UI falls back to the in-app browser backed by listDirs(). A desktop
 * shell (Electron, via its preload bridge in the web UI) can plug its own dialog in with setNativePicker().
 */
export type PickResult = { path: string } | { cancelled: true } | { unsupported: true };
type NativePicker = (opts: { title: string; start: string }) => Promise<PickResult>;

let custom: NativePicker | null = null;
export function setNativePicker(p: NativePicker | null) {
  custom = p;
}

export async function pickFolderNative(title: string, start?: string): Promise<PickResult> {
  const from = start && existsSync(start) ? start : homedir();
  if (custom) return custom({ title, start: from });
  if (process.env.TUANTUAN_NATIVE_PICKER === "0") return { unsupported: true };
  const env = await loginShellEnv();
  const path = env.PATH ?? "";
  let cmd: string[] | null = null;
  if (process.platform === "darwin" && which("osascript", path)) {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    cmd = [
      "osascript",
      "-e",
      `POSIX path of (choose folder with prompt "${esc(title)}" default location (POSIX file "${esc(from)}"))`,
    ];
  } else if (process.platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (which("zenity", path))
      cmd = ["zenity", "--file-selection", "--directory", `--title=${title}`, `--filename=${from}/`];
    else if (which("kdialog", path)) cmd = ["kdialog", "--getexistingdirectory", from, "--title", title];
  }
  if (!cmd) return { unsupported: true };
  const p = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  const code = await p.exited;
  if (code !== 0 || !out) return { cancelled: true };
  return { path: out.length > 1 ? out.replace(/\/$/, "") : out };
}

export interface DirEntry {
  name: string;
  path: string;
  git: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  crumbs: { name: string; path: string }[];
  dirs: DirEntry[];
  git: boolean;
}

const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** Sub-folders of `path` (hidden ones only when asked), git repos marked. */
export function listDirs(path: string | undefined, hidden = false): DirListing {
  const abs = expand(path?.trim() || homedir());
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`找不到：${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`不是文件夹：${abs}`);
  let names: string[] = [];
  try {
    names = readdirSync(abs);
  } catch {
    throw new Error(`没有权限读取：${abs}`);
  }
  const dirs: DirEntry[] = [];
  for (const name of names) {
    if (!hidden && name.startsWith(".")) continue;
    const p = join(abs, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push({ name, path: p, git: existsSync(join(p, ".git")) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" }));
  const crumbs: { name: string; path: string }[] = [];
  for (let p = abs; ; p = dirname(p)) {
    crumbs.unshift({ name: p === "/" ? "/" : basename(p), path: p });
    if (p === dirname(p)) break;
  }
  return {
    path: abs,
    parent: abs === dirname(abs) ? null : dirname(abs),
    crumbs,
    dirs,
    git: existsSync(join(abs, ".git")),
  };
}

/** Shortcuts for the in-app browser: home, common code folders that exist, recent project dirs. */
export function places(recent: string[]): { name: string; path: string; kind: "home" | "common" | "recent" }[] {
  const home = homedir();
  const out: { name: string; path: string; kind: "home" | "common" | "recent" }[] = [
    { name: "主目录", path: home, kind: "home" },
  ];
  for (const n of [
    "code",
    "Code",
    "projects",
    "Projects",
    "src",
    "dev",
    "Developer",
    "workspace",
    "Documents",
    "Desktop",
  ]) {
    const p = join(home, n);
    if (existsSync(p) && !out.some((x) => x.path === p)) out.push({ name: n, path: p, kind: "common" });
  }
  for (const p of recent) {
    if (existsSync(p) && !out.some((x) => x.path === p)) out.push({ name: basename(p) || p, path: p, kind: "recent" });
  }
  return out;
}
