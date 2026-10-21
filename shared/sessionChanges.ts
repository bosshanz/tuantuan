import type { SessionEditOccurrence, SessionFileChange } from "./sessionEdits";

export type { SessionEditOccurrence, SessionFileChange };

export interface SessionChangesResponse {
  items: SessionFileChange[];
  /** Product boundary: only Agent-reported completed edits. */
  scope: "agent-reported-edits";
}

export interface SessionChangeDetailResponse {
  path: string;
  name: string;
  overlap: boolean;
  edits: SessionEditOccurrence[];
  scope: "agent-reported-edits";
}
