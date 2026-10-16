import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskPowerStatus } from "../../shared/desktopPower";

interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): unknown;
}

interface RoomActivity {
  id: string;
  busy?: boolean;
}

interface TaskPowerOptions {
  blocker: PowerBlocker;
  settingsPath: string;
  serverUrl: string;
  openSocket?: (url: string) => WebSocket;
  fetchRooms?: () => Promise<RoomActivity[]>;
  refreshMs?: number;
  retryMs?: number;
}

/** Owns the desktop's single idle-sleep assertion, without depending on a renderer's lifetime. */
export class TaskPowerManager {
  private enabled: boolean;
  private disposed = false;
  private blockerId: number | null = null;
  private activeRooms = new Set<string>();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;
  private snapshotChanges: Map<string, boolean> | null = null;
  private generation = 0;

  constructor(private readonly options: TaskPowerOptions) {
    this.enabled = this.readSettings().keepAwakeDuringTasks === true;
    if (this.enabled) this.connect();
  }

  status(): TaskPowerStatus {
    return { enabled: this.enabled, preventingSleep: this.blockerId !== null, activeRooms: this.activeRooms.size };
  }

  setEnabled(enabled: boolean): TaskPowerStatus {
    if (this.disposed) throw new Error("桌面版正在退出");
    const settings = { ...this.readSettings(), keepAwakeDuringTasks: enabled };
    mkdirSync(dirname(this.options.settingsPath), { recursive: true });
    const temp = `${this.options.settingsPath}.tmp`;
    writeFileSync(temp, JSON.stringify(settings));
    renameSync(temp, this.options.settingsPath);
    this.enabled = enabled;
    if (enabled) this.connect();
    else this.disconnect();
    return this.status();
  }

  dispose() {
    this.disposed = true;
    this.disconnect();
  }

  private readSettings(): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.options.settingsPath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private syncBlocker() {
    if (this.enabled && this.activeRooms.size && !this.disposed) {
      this.blockerId ??= this.options.blocker.start("prevent-app-suspension");
    } else if (this.blockerId !== null) {
      this.options.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  private disconnect() {
    ++this.generation;
    if (this.retry) clearTimeout(this.retry);
    if (this.refresh) clearInterval(this.refresh);
    this.retry = this.refresh = null;
    const socket = this.socket;
    this.socket = null;
    this.snapshotChanges = null;
    this.activeRooms.clear();
    this.syncBlocker();
    socket?.close();
  }

  private reconnect(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.disconnect();
    if (this.enabled && !this.disposed) {
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, this.options.retryMs ?? 1000);
    }
  }

  private connect() {
    if (!this.enabled || this.disposed || this.socket) return;
    const url = new URL("/ws", this.options.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = (this.options.openSocket ?? ((url) => new WebSocket(url)))(url.href);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      void this.snapshot(socket);
      this.refresh = setInterval(() => void this.snapshot(socket), this.options.refreshMs ?? 15_000);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const value = JSON.parse(String(event.data));
        if (value.type !== "activity" || typeof value.roomId !== "string" || typeof value.busy !== "boolean") return;
        this.snapshotChanges?.set(value.roomId, value.busy);
        if (value.busy) this.activeRooms.add(value.roomId);
        else this.activeRooms.delete(value.roomId);
        this.syncBlocker();
      } catch (error) {
        console.error("task power activity failed", error);
        this.reconnect(socket);
      }
    };
    socket.onclose = () => this.reconnect(socket);
    socket.onerror = () => this.reconnect(socket);
  }

  private async snapshot(socket: WebSocket) {
    if (this.socket !== socket || this.snapshotChanges) return;
    const changes = new Map<string, boolean>();
    this.snapshotChanges = changes;
    const generation = this.generation;
    try {
      const rooms = await (this.options.fetchRooms?.() ?? this.fetchRooms());
      if (this.socket !== socket || generation !== this.generation) return;
      const active = new Set(rooms.filter((room) => room.busy).map((room) => room.id));
      // Activity received during the HTTP request is newer than its snapshot.
      for (const [id, busy] of changes) {
        if (busy) active.add(id);
        else active.delete(id);
      }
      this.activeRooms = active;
      this.syncBlocker();
    } catch (error) {
      if (this.socket !== socket || generation !== this.generation) return;
      console.error("task power snapshot failed", error);
      // Unknown state must not leave a stale assertion running indefinitely.
      this.reconnect(socket);
    } finally {
      if (this.snapshotChanges === changes) this.snapshotChanges = null;
    }
  }

  private async fetchRooms(): Promise<RoomActivity[]> {
    const response = await fetch(new URL("/api/rooms", this.options.serverUrl), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rooms: unknown = await response.json();
    if (
      !Array.isArray(rooms) ||
      rooms.some((room) => !room || typeof room.id !== "string" || typeof room.busy !== "boolean")
    )
      throw new Error("任务状态快照无效");
    return rooms;
  }
}
