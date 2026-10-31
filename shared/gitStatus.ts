/** Current Git working tree state, scoped to a conversation's working directory. */
export type GitStatusSection = "staged" | "unstaged" | "untracked";

export interface GitStatusItem {
  /** Repository-root relative, as emitted by git status. */
  path: string;
  staged: string | null;
  unstaged: string | null;
  untracked: boolean;
}

export interface GitStatusResponse {
  state: "ready" | "unborn" | "not-repository" | "error";
  root?: string;
  /** Path relative to the repository root; empty means repository root. */
  scope?: string;
  items: GitStatusItem[];
  error?: string;
}

export interface GitStatusDetailResponse {
  path: string;
  section: GitStatusSection;
  state: "text" | "binary" | "too-large" | "unavailable";
  content?: string;
  reason?: string;
}
