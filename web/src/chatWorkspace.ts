import {
  DESKTOP_CHECKPOINT_MAX_BYTES,
  type DesktopChatWorkspace,
  type DesktopUpdateBridge,
  type DesktopUpdateCheckpoint,
} from "../../shared/desktopUpdate";

export type ChatWorkspace = DesktopChatWorkspace;
export type ImageAttachment = ChatWorkspace["images"][number];

interface WorkspaceSnapshot {
  data: ChatWorkspace;
  loaded: boolean;
  error: string | null;
}

export interface WorkspaceStorage {
  read(roomId: string): Promise<ChatWorkspace | undefined>;
  write(roomId: string, data: ChatWorkspace): Promise<void>;
  all(): Promise<Record<string, ChatWorkspace>>;
  import(rooms: Record<string, ChatWorkspace>): Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tuantuan-chat-workspace", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开聊天草稿存储"));
    request.onblocked = () => reject(new Error("聊天草稿存储被其他窗口占用，请关闭其他窗口后重试。"));
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

/** Resolves only after the transaction commits, including image attachments. */
async function transaction<T>(key: string, write: boolean, value?: unknown): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("workspace", write ? "readwrite" : "readonly");
    const store = tx.objectStore("workspace");
    const request = write ? store.put(value, key) : store.get(key);
    tx.oncomplete = () => resolve(write ? undefined : request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error("无法保存聊天草稿"));
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error("无法保存聊天草稿"));
  });
}

const storage: WorkspaceStorage = {
  read: (id) => transaction<ChatWorkspace>(`room:${id}`, false),
  write: (id, data) => transaction<void>(`room:${id}`, true, data).then(() => {}),
  async all() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("workspace", "readonly");
      const request = tx.objectStore("workspace").openCursor();
      const rooms: Record<string, ChatWorkspace> = {};
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (typeof cursor.key === "string" && cursor.key.startsWith("room:")) rooms[cursor.key.slice(5)] = cursor.value;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(rooms);
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error("无法保存聊天草稿"));
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error("无法保存聊天草稿"));
    });
  },
  async import(rooms) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("workspace", "readwrite");
      const store = tx.objectStore("workspace");
      try {
        for (const [id, workspace] of Object.entries(rooms)) store.put(workspace, `room:${id}`);
      } catch (error) {
        tx.abort();
        reject(error);
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("无法保存聊天草稿"));
      tx.onerror = () => reject(tx.error ?? new Error("无法保存聊天草稿"));
    });
  },
};

interface RoomEntry {
  snapshot: WorkspaceSnapshot;
  revision: number;
  saved: number;
  loading?: Promise<void>;
  writing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Only local composer state and reading positions; server chat state remains in chatReducer. */
export class ChatWorkspaceStore {
  private rooms = new Map<string, RoomEntry>();
  private listeners = new Set<() => void>();
  private captures = new Set<() => void>();
  private pending = new Set<Promise<unknown>>();
  private failures: string | null = null;
  private restoringCheckpoint?: Promise<DesktopUpdateCheckpoint | null>;

  constructor(private storage: WorkspaceStorage) {}

  private entry(id: string) {
    let entry = this.rooms.get(id);
    if (!entry) {
      entry = {
        snapshot: { data: { draft: "", images: [], quote: null, reading: null }, loaded: false, error: null },
        revision: 0,
        saved: 0,
      };
      this.rooms.set(id, entry);
    }
    return entry;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = (id: string) => this.entry(id).snapshot;
  error = () => this.failures;

  private notify() {
    this.failures = [...this.rooms.values()].find((entry) => entry.snapshot.error)?.snapshot.error ?? null;
    for (const listener of this.listeners) listener();
  }

  async load(id: string) {
    const entry = this.entry(id);
    if (entry.snapshot.loaded) return;
    if (entry.loading) return entry.loading;
    entry.loading = (async () => {
      try {
        const data = await this.storage.read(id);
        entry.snapshot = { data: data ?? entry.snapshot.data, loaded: true, error: null };
      } catch (error) {
        entry.snapshot = { ...entry.snapshot, error: (error as Error).message };
        throw error;
      } finally {
        entry.loading = undefined;
        this.notify();
      }
    })();
    return entry.loading;
  }

  update(id: string, patch: Partial<ChatWorkspace>, silent = false) {
    const entry = this.entry(id);
    // A failed read must never overwrite an unread draft with an empty composer.
    if (!entry.snapshot.loaded) return;
    entry.snapshot = { ...entry.snapshot, data: { ...entry.snapshot.data, ...patch } };
    ++entry.revision;
    if (!silent) this.notify();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.save(id).catch(() => {}), 250);
  }

  async save(id: string): Promise<void> {
    const entry = this.entry(id);
    clearTimeout(entry.timer);
    await this.load(id);
    if (entry.writing) await entry.writing;
    if (entry.revision === entry.saved) return;
    const revision = entry.revision;
    const data = entry.snapshot.data;
    entry.writing = this.storage.write(id, data);
    try {
      await entry.writing;
      entry.saved = revision;
      entry.snapshot = { ...entry.snapshot, error: null };
    } catch (error) {
      entry.snapshot = { ...entry.snapshot, error: (error as Error).message };
      throw error;
    } finally {
      entry.writing = undefined;
      this.notify();
    }
    // Input can change while the previous transaction is pending.
    if (entry.revision !== entry.saved) await this.save(id);
  }

  capture = (callback: () => void) => {
    this.captures.add(callback);
    return () => this.captures.delete(callback);
  };

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
    for (const capture of this.captures) capture();
    await Promise.all([...this.rooms.keys()].map((id) => this.save(id)));
  }

  async prepareUpdate(route: string, desktop: Pick<DesktopUpdateBridge, "saveUpdateCheckpoint">) {
    await this.flush();
    // Include drafts not visited in this renderer session, not only entries in the memory cache.
    const rooms = await this.storage.all();
    const checkpoint: DesktopUpdateCheckpoint = { schema: 1, id: crypto.randomUUID(), route, rooms };
    if (new Blob([JSON.stringify(checkpoint)]).size > DESKTOP_CHECKPOINT_MAX_BYTES)
      throw new Error("聊天草稿中的图片过大，无法保存更新前的工作。请减少图片后重试。");
    await desktop.saveUpdateCheckpoint(checkpoint);
  }

  restoreCheckpoint(desktop: Pick<DesktopUpdateBridge, "readUpdateCheckpoint">) {
    // StrictMode replays startup effects; one import is shared until it succeeds or can be retried.
    this.restoringCheckpoint ??= (async () => {
      const checkpoint = await desktop.readUpdateCheckpoint();
      if (checkpoint) {
        await this.storage.import(checkpoint.rooms);
        for (const [id, data] of Object.entries(checkpoint.rooms)) {
          const entry = this.entry(id);
          entry.snapshot = { data, loaded: true, error: null };
          entry.saved = entry.revision;
        }
        this.notify();
      }
      return checkpoint;
    })().catch((error) => {
      this.restoringCheckpoint = undefined;
      throw error;
    });
    return this.restoringCheckpoint;
  }
}

export const chatWorkspace = new ChatWorkspaceStore(storage);
