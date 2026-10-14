/** Folder name for a room's auto-created working directory: keep CJK, spaces→-, strip path-unsafe chars. */
export function workspaceSlug(name: string): string {
  const s = name
    .normalize("NFKC")
    .replace(/[\s/\\:*?"<>|#%&{}$!'`@+=~^]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return s || "room";
}

/** Relative path under the workspaces root: dm/<agent> or groups/<name>. */
export function workspaceRel(kind: "group" | "dm", name: string, agentName?: string): string {
  if (kind === "dm")
    return `dm/${workspaceSlug(agentName || name.replace(/^与\s*/, "").replace(/\s*私聊$/, "") || name)}`;
  return `groups/${workspaceSlug(name)}`;
}
