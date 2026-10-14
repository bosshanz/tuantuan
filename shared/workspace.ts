/** Folder name for a room's auto-created working directory: the room name, made safe for file systems. */
export function workspaceSlug(name: string): string {
  const s = name
    .normalize("NFKC")
    .replace(/[\s/\\:*?"<>|#%&{}$!'`@+=~^]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return s || "room";
}
