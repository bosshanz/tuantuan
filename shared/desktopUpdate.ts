import type { MessageQuote } from "./messageQuote";

export const DESKTOP_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;

export interface DesktopChatWorkspace {
  draft: string;
  images: { mimeType: string; data: string }[];
  quote: MessageQuote | null;
  reading: { id: string; offset: number; top: number } | null;
}

/** A durable handoff is needed because each desktop launch uses a new HTTP origin. */
export interface DesktopUpdateCheckpoint {
  schema: 1;
  id: string;
  route: string;
  rooms: Record<string, DesktopChatWorkspace>;
}

/** Desktop owns update state; the renderer never selects update URLs or files. */
export interface DesktopUpdateStatus {
  version: string;
  mode: "automatic" | "manual" | "disabled";
  reason?: "development" | "disabled" | "unsigned-mac" | "missing-feed" | "homebrew";
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";
  automaticChecks: boolean;
  availableVersion?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  progress?: number;
  checkedAt?: number;
  error?: string;
  activity: "idle" | "busy" | "unknown";
  activeTasks: number;
}

export interface DesktopUpdateBridge {
  updateStatus(): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  downloadUpdate(): Promise<DesktopUpdateStatus>;
  installUpdate(): Promise<DesktopUpdateStatus>;
  setUpdateChecks(enabled: boolean): Promise<DesktopUpdateStatus>;
  openUpdateRelease(): Promise<void>;
  onUpdateState(callback: (status: DesktopUpdateStatus) => void): () => void;
  /** Main process awaits this checkpoint before it acquires the server install lock. */
  onPrepareUpdate(callback: () => Promise<void>): () => void;
  saveUpdateCheckpoint(checkpoint: DesktopUpdateCheckpoint): Promise<void>;
  readUpdateCheckpoint(): Promise<DesktopUpdateCheckpoint | null>;
  /** Renderer acknowledges only after importing all rooms and restoring the route. */
  clearUpdateCheckpoint(id: string): Promise<void>;
}
