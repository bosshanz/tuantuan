import type { GlobalEvent } from "../../shared/notify";
import { newerPreview } from "../../shared/roomPreview";
import type { Room } from "./api";

export type RoomListEvent = Extract<GlobalEvent, { type: "activity" | "room.preview" }>;
export interface RoomListState {
  rooms: Room[];
  loading: { id: number; events: RoomListEvent[] } | null;
}

type Action =
  | { type: "load"; id: number }
  | { type: "snapshot"; id: number; rooms: Room[] }
  | { type: "load.failed"; id: number }
  | { type: "event"; event: RoomListEvent };

function applyEvent(rooms: Room[], event: RoomListEvent): Room[] {
  return rooms.map((room) => {
    if (room.id !== event.roomId) return room;
    return event.type === "activity"
      ? { ...room, busy: event.busy }
      : { ...room, last: newerPreview(room.last, event.last) };
  });
}

/** Replay global events that arrived while fetching, including before the initial room list exists. */
export function roomListReducer(state: RoomListState, action: Action): RoomListState {
  if (action.type === "load") return { ...state, loading: { id: action.id, events: [] } };
  if (action.type === "event") {
    return {
      rooms: applyEvent(state.rooms, action.event),
      loading: state.loading ? { ...state.loading, events: [...state.loading.events, action.event] } : null,
    };
  }
  if (state.loading?.id !== action.id) return state;
  if (action.type === "load.failed") return { ...state, loading: null };
  let rooms = action.rooms;
  for (const event of state.loading.events) rooms = applyEvent(rooms, event);
  return { rooms, loading: null };
}
