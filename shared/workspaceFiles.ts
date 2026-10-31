export interface WorkspaceEntry {
  /** POSIX path relative to the conversation's working directory. */
  path: string;
  name: string;
  kind: "dir" | "file";
  size: number | null;
  mtimeMs: number | null;
  image: boolean;
  previewable: boolean;
  /** Generated or dependency directory; collapsed and dimmed by default, still expandable on demand. */
  muted?: boolean;
}

export interface WorkspaceTreeResponse {
  state: "ready" | "unavailable";
  dir: string;
  cwdName: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
  error?: string;
}

export interface WorkspaceSearchResponse {
  state: "ready" | "unavailable";
  query: string;
  items: WorkspaceEntry[];
  truncated: boolean;
  error?: string;
}

export const WORKSPACE_DIR_ENTRY_LIMIT = 5000;
export const WORKSPACE_SEARCH_VISIT_LIMIT = 25_000;
export const WORKSPACE_SEARCH_RESULT_LIMIT = 200;

export const MUTED_WORKSPACE_DIRS = new Set([
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "vendor",
]);

export function isMutedWorkspaceDir(name: string): boolean {
  return MUTED_WORKSPACE_DIRS.has(name.toLowerCase());
}
