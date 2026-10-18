import { expect, test } from "bun:test";
import type { DesktopUpdateCheckpoint } from "../shared/desktopUpdate";
import { type ChatWorkspace, ChatWorkspaceStore, type WorkspaceStorage } from "../web/src/chatWorkspace";

function fixture() {
  const rooms = new Map<string, ChatWorkspace>();
  let checkpoint: DesktopUpdateCheckpoint | null = null;
  const storage: WorkspaceStorage = {
    read: async (id) => rooms.get(id),
    write: async (id, data) => {
      rooms.set(id, structuredClone(data));
    },
    all: async () => Object.fromEntries(rooms),
    import: async (data) => {
      for (const [id, value] of Object.entries(data)) rooms.set(id, structuredClone(value));
    },
  };
  const desktop = {
    saveUpdateCheckpoint: async (next: DesktopUpdateCheckpoint) => {
      checkpoint = structuredClone(next);
    },
    readUpdateCheckpoint: async () => checkpoint,
  };
  return { rooms, storage, desktop, store: new ChatWorkspaceStore(storage), route: () => checkpoint?.route };
}

test("room drafts, large image attachments, quotes and reading anchors survive a new store", async () => {
  const { store, desktop } = fixture();
  await store.load("first");
  await store.load("second");
  store.update("first", {
    draft: "保留草稿",
    images: [{ mimeType: "image/png", data: "a".repeat(6 * 1024 * 1024) }],
    quote: { messageId: "source", senderName: "作者", senderKind: "human", text: "引用" },
    reading: { id: "old-message", offset: -12, top: 987 },
  });
  store.update("second", { draft: "另一个会话" });
  await store.prepareUpdate("#/about", desktop);
  const target = fixture();
  const restarted = target.store;
  const checkpoint = await restarted.restoreCheckpoint(desktop);
  expect(restarted.snapshot("first").data).toEqual(store.snapshot("first").data);
  expect(restarted.snapshot("second").data.draft).toBe("另一个会话");
  expect(checkpoint?.route).toBe("#/about");
  expect(target.rooms.size).toBe(2);
});

test("checkpoint waits for attachment reads, committed writes and newer input", async () => {
  const { store, rooms, storage, desktop, route } = fixture();
  await store.load("room");
  let finishAttachment: () => void = () => {};
  const attachment = new Promise<void>((resolve) => {
    finishAttachment = resolve;
  }).then(() => {
    store.update("room", { images: [{ mimeType: "image/png", data: "image" }] });
  });
  void store.track(attachment);
  let finishWrite: () => void = () => {};
  const originalWrite = storage.write;
  let writes = 0;
  storage.write = async (id, data) => {
    if (++writes === 1)
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
    await originalWrite(id, data);
  };
  let done = false;
  const checkpoint = store.prepareUpdate("#/c/room", desktop).then(() => {
    done = true;
  });
  await Bun.sleep(1);
  expect(done).toBe(false);
  expect(route()).toBeUndefined();
  finishAttachment();
  await Bun.sleep(1);
  expect(done).toBe(false);
  store.update("room", { draft: "latest" });
  finishWrite();
  await checkpoint;
  expect(writes).toBe(2);
  expect(rooms.get("room")).toMatchObject({ draft: "latest", images: [{ data: "image" }] });
  expect(route()).toBe("#/c/room");
});

test("failed writes retain unsaved work, reject installation and can be retried", async () => {
  const { store, storage, desktop, route, rooms } = fixture();
  await store.load("room");
  store.update("room", { draft: "cannot lose this" });
  const write = storage.write;
  storage.write = async () => {
    throw new Error("quota exceeded");
  };
  await expect(store.prepareUpdate("#/about", desktop)).rejects.toThrow("quota exceeded");
  expect(route()).toBeUndefined();
  expect(store.error()).toBe("quota exceeded");
  expect(store.snapshot("room").data.draft).toBe("cannot lose this");
  storage.write = write;
  await store.prepareUpdate("#/about", desktop);
  expect(store.error()).toBeNull();
  expect(rooms.get("room")?.draft).toBe("cannot lose this");
});

test("failed reads never replace unread persisted drafts with an empty composer", async () => {
  const { store, storage, desktop, rooms } = fixture();
  const read = storage.read;
  storage.read = async () => {
    throw new Error("read failed");
  };
  await expect(store.load("room")).rejects.toThrow("read failed");
  store.update("room", { draft: "must not overwrite" });
  await expect(store.prepareUpdate("#/about", desktop)).rejects.toThrow("read failed");
  expect(rooms.size).toBe(0);
  storage.read = read;
  await store.flush();
  expect(store.snapshot("room").loaded).toBe(true);
  expect(store.error()).toBeNull();
});

test("replayed startup effects share one import and do not acknowledge prematurely", async () => {
  const { store, desktop } = fixture();
  await store.load("room");
  store.update("room", { draft: "keep" });
  await store.prepareUpdate("#/about", desktop);
  let reads = 0;
  const read = desktop.readUpdateCheckpoint;
  desktop.readUpdateCheckpoint = async () => {
    ++reads;
    return read();
  };
  const target = fixture().store;
  const restored = await Promise.all([target.restoreCheckpoint(desktop), target.restoreCheckpoint(desktop)]);
  expect(restored[0]).toBe(restored[1]);
  expect(reads).toBe(1);
  expect(await read()).not.toBeNull();
});

test("host save and import failures reject without consuming the only durable checkpoint", async () => {
  const { store, desktop, rooms } = fixture();
  rooms.set("unvisited", { draft: "old room not mounted this session", images: [], quote: null, reading: null });
  await store.prepareUpdate("#/c/unvisited", desktop);
  expect((await desktop.readUpdateCheckpoint())?.rooms.unvisited?.draft).toContain("not mounted");
  const target = fixture();
  const importRooms = target.storage.import;
  target.storage.import = async () => {
    throw new Error("import quota exceeded");
  };
  await expect(target.store.restoreCheckpoint(desktop)).rejects.toThrow("import quota exceeded");
  expect(await desktop.readUpdateCheckpoint()).not.toBeNull();
  target.storage.import = importRooms;
  await target.store.restoreCheckpoint(desktop);
  expect(target.rooms.get("unvisited")?.draft).toContain("not mounted");
  desktop.saveUpdateCheckpoint = async () => {
    throw new Error("host disk full");
  };
  await expect(store.prepareUpdate("#/about", desktop)).rejects.toThrow("host disk full");
});

test("the renderer binds its complete workspace to the current host quit request", async () => {
  const { store, storage, rooms } = fixture();
  await store.load("visited");
  store.update("visited", { draft: "latest composer" });
  rooms.set("unvisited", { draft: "other room", images: [], quote: null, reading: null });
  store.capture(() => store.update("visited", { reading: { id: "visible", offset: -10, top: 12 } }, true));
  let saved: DesktopUpdateCheckpoint | undefined;
  let request: string | undefined;
  await store.prepareUpdate(
    "#/c/visited",
    {
      saveUpdateCheckpoint: async (value, requestId) => {
        saved = value;
        request = requestId;
      },
    },
    "quit-request",
  );
  expect(request).toBe("quit-request");
  expect(saved?.id).toBe(request);
  expect(saved?.rooms).toEqual(await storage.all());
  expect(saved?.rooms.visited?.reading?.id).toBe("visible");
  expect(saved?.rooms.unvisited?.draft).toBe("other room");
});

test("legacy drafts restore empty file arrays while file drafts survive refresh and desktop handoff", async () => {
  const { store, rooms, storage, desktop } = fixture();
  rooms.set("legacy", { draft: "old draft", images: [], quote: null, reading: null });
  await store.load("legacy");
  expect(store.snapshot("legacy").data.files).toEqual([]);
  const file = { name: "draft.md", mimeType: "text/markdown", data: "aGVsbG8=" };
  store.update("legacy", { files: [file] });
  await store.flush();
  const refreshed = new ChatWorkspaceStore(storage);
  await refreshed.load("legacy");
  expect(refreshed.snapshot("legacy").data.files).toEqual([file]);
  await store.prepareUpdate("#/c/legacy", desktop);
  const restored = fixture().store;
  await restored.restoreCheckpoint(desktop);
  expect(restored.snapshot("legacy").data.files).toEqual([file]);
});

test("concurrent attachment reads merge with removals and stay in their original room", async () => {
  const { store } = fixture();
  await store.load("first");
  await store.load("second");
  const existing = { name: "remove.txt", mimeType: "text/plain", data: "b2xk" };
  store.update("first", { files: [existing] });
  let finish!: (value: typeof existing) => void;
  const reading = store.addAttachments(
    "first",
    [new File(["one"], "one.txt")],
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const queued = store.addAttachments("first", [new File(["two"], "two.txt")], async () => ({
    name: "two.txt",
    mimeType: "text/plain",
    data: "dHdv",
  }));
  await Bun.sleep(1);
  expect(store.snapshot("first").pendingAttachments).toBe(2);
  store.update("first", { files: [], draft: "edited while reading" });
  await store.addAttachments("second", [new File(["other"], "other.txt")], async () => ({
    name: "other.txt",
    mimeType: "text/plain",
    data: "b3RoZXI=",
  }));
  finish({ name: "one.txt", mimeType: "text/plain", data: "b25l" });
  await Promise.all([reading, queued]);
  expect(store.snapshot("first").data.files.map((file) => file.name)).toEqual(["one.txt", "two.txt"]);
  expect(store.snapshot("first").data.draft).toBe("edited while reading");
  expect(store.snapshot("second").data.files.map((file) => file.name)).toEqual(["other.txt"]);
  expect(store.snapshot("first").pendingAttachments).toBe(0);
  await store.flush();
});

test("a failed attachment batch preserves existing work and does not poison later reads or quit saves", async () => {
  const { store, desktop } = fixture();
  await store.load("room");
  const existing = { name: "keep.txt", mimeType: "text/plain", data: "a2VlcA==" };
  store.update("room", { draft: "keep this", files: [existing] });
  await store.addAttachments("room", [new File(["a"], "a.txt"), new File(["b"], "b.txt")], async (file) => {
    if (file.name === "b.txt") throw new Error("file read failed");
    return { name: file.name, mimeType: "text/plain", data: "YQ==" };
  });
  expect(store.snapshot("room").data.files).toEqual([existing]);
  expect(store.snapshot("room").attachmentError).toBe("file read failed");
  expect(store.snapshot("room").pendingAttachments).toBe(0);
  await store.prepareUpdate("#/c/room", desktop);
  await store.addAttachments("room", [new File(["c"], "c.txt")], async () => ({
    name: "c.txt",
    mimeType: "text/plain",
    data: "Yw==",
  }));
  expect(store.snapshot("room").attachmentError).toBeNull();
  expect(store.snapshot("room").data.files.map((file) => file.name)).toEqual(["keep.txt", "c.txt"]);
  await store.flush();
});

test("queued selections enforce the count against the latest attachments and never truncate", async () => {
  const { store } = fixture();
  await store.load("room");
  let reads = 0;
  const read = async (file: File) => {
    ++reads;
    return { name: file.name, mimeType: "text/plain", data: "" };
  };
  const first = store.addAttachments(
    "room",
    Array.from({ length: 7 }, (_, i) => new File([], `${i}.txt`)),
    read,
  );
  const second = store.addAttachments("room", [new File([], "8.txt"), new File([], "9.txt")], read);
  await Promise.all([first, second]);
  expect(reads).toBe(7);
  expect(store.snapshot("room").data.files).toHaveLength(7);
  expect(store.snapshot("room").attachmentError).toContain("8");
  expect(store.snapshot("room").pendingAttachments).toBe(0);
  await store.flush();
});

test("attachment readiness waits for the durable write and removals start saving without the typing debounce", async () => {
  const { store, rooms, storage } = fixture();
  await store.load("room");
  const originalWrite = storage.write;
  let commit!: () => void;
  let writes = 0;
  storage.write = async (id, data) => {
    ++writes;
    if (writes === 1)
      await new Promise<void>((resolve) => {
        commit = resolve;
      });
    await originalWrite(id, data);
  };
  const adding = store.addAttachments("room", [new File(["hello"], "notes.txt")], async () => ({
    name: "notes.txt",
    mimeType: "text/plain",
    data: "aGVsbG8=",
  }));
  await Bun.sleep(1);
  expect(writes).toBe(1);
  expect(store.snapshot("room").data.files).toHaveLength(1);
  expect(store.snapshot("room").pendingAttachments).toBe(1);
  expect(rooms.get("room")).toBeUndefined();
  commit();
  await adding;
  expect(store.snapshot("room").pendingAttachments).toBe(0);
  expect(rooms.get("room")?.files?.[0]?.name).toBe("notes.txt");
  store.update("room", { files: [] });
  await Bun.sleep(1);
  expect(writes).toBe(2);
  expect(rooms.get("room")?.files).toEqual([]);
  await store.flush();
});
