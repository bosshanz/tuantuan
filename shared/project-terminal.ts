/** Project shells live in server memory; ACP tool terminals have a separate lifecycle. */
export interface ProjectTerminalMeta {
  id: string;
  projectId: string;
  number: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
}

export type ProjectTerminalEvent =
  | { type: "snapshot"; terminal: ProjectTerminalMeta; output: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "error"; error: string };

export type ProjectTerminalMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
