/**
 * Message links that name a local file rather than a remote/app target. Used both by the
 * conversation-files extractor and by click handling so they agree on what counts as local.
 * Returns null for remote URLs, app-internal anchors and unresolvable targets; explicit local
 * but inaccessible paths stay visible to the caller.
 */
export function localFileTarget(raw: string): string | null {
  if (!raw || raw.length > 8192 || raw.includes("\0") || raw.startsWith("#")) return null;
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.hostname && url.hostname !== "localhost") return null;
      const path = decodeURIComponent(url.pathname);
      // file:///C:/x → C:/x on Windows; POSIX paths keep their leading slash.
      return /^\/[a-zA-Z]:[\\/]/.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.startsWith("//") || raw.startsWith("\\\\")) return null;
  try {
    return decodeURIComponent(raw.replace(/#(?:L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?$/, "")).replace(
      /:\d+(?::\d+)?$/,
      "",
    );
  } catch {
    return null;
  }
}

const normalizeSlashes = (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
const isAbsolute = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
const driveOf = (p: string) => (/^([a-zA-Z]):/.exec(p)?.[1] ?? "").toLowerCase();

function resolveSegments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return out;
}

export interface LocalFileLink {
  /** Slash-normalized absolute target on the machine that runs the server. */
  absolute: string;
  /** Workspace-relative POSIX path when inside cwd ("" is the workspace root), else null. */
  relative: string | null;
}

/**
 * Resolve a local link against the room workspace. Relative hrefs resolve under cwd; absolute
 * hrefs stay absolute. `relative` is null when the target escapes or cwd is unset, so callers
 * can fall back to revealing the absolute path instead of guessing a workspace file.
 */
export function resolveLocalFileLink(cwd: string, raw: string): LocalFileLink | null {
  const target = localFileTarget(raw);
  if (target === null) return null;
  const t = normalizeSlashes(target);
  const root = normalizeSlashes(cwd).replace(/\/+$/, "");
  if (!isAbsolute(t) && !root) return { absolute: t, relative: null };
  const joined = isAbsolute(t) ? t : `${root}/${t}`;
  const drive = driveOf(joined);
  const prefix = joined.startsWith("/") ? "/" : `${drive ? `${drive.toUpperCase()}:` : ""}/`;
  const segs = resolveSegments(drive ? joined.slice(2) : joined);
  const absolute = `${prefix}${segs.join("/")}`;
  if (!root) return { absolute, relative: null };
  const rootSegs = resolveSegments(driveOf(root) ? root.slice(2) : root);
  if (drive !== driveOf(root)) return { absolute, relative: null };
  const inside = segs.length >= rootSegs.length && rootSegs.length > 0 && rootSegs.every((seg, i) => segs[i] === seg);
  return { absolute, relative: inside ? segs.slice(rootSegs.length).join("/") : null };
}
