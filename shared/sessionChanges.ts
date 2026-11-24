import type { SessionEditOccurrence, SessionFileChange } from "./sessionEdits";

export type { SessionEditOccurrence, SessionFileChange };

export interface SessionChangeRequest {
  id: string;
  seq: number;
  content: string;
  createdAt: number;
}

export interface SessionChangeRequestsResponse {
  items: SessionChangeRequest[];
  nextBeforeSeq: number | null;
}

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
