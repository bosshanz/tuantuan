/** Folder name for a project's auto-created directory: keep CJK, spaces→-, strip path-unsafe chars. */
export function workspaceSlug(name: string): string {
  const s = name
    .normalize("NFKC")
    .replace(/[\s/\\:*?"<>|#%&{}$!'`@+=~^]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return s || "project";
}
