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
