import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConversationFileContent, handleConversationFiles } from "../server/conversation-files";
import { Store } from "../server/store";
import {
  handleWorkspaceFileContent,
  handleWorkspaceFilePreview,
  handleWorkspaceSearch,
  handleWorkspaceTree,
} from "../server/workspace-files";
import type { ConversationFilesPage } from "../shared/conversationFiles";
import { FILE_PREVIEW_MAX_BYTES, type FilePreviewContent } from "../shared/filePreview";
import { emptyTimeline } from "../shared/timeline";
import type { WorkspaceSearchResponse, WorkspaceTreeResponse } from "../shared/workspaceFiles";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tt-workspace-files-"));
  const cwd = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const store = new Store(join(root, "chat.sqlite"));
  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject("workspace", cwd);
  const room = store.createRoom("workspace-room", [], { projectId: project.id });
  return { root, cwd, outside, store, room };
}

describe("workspace files", () => {
  test("lists directories first, dims generated dirs last, hides .git, and blocks symlink escapes", async () => {
    const { cwd, outside, store, room } = fixture();
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "config"), "[core]\n");
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(cwd, "src", "file2.ts"), "export const b = 2;\n");
    writeFileSync(join(cwd, "src", "file10.ts"), "export const ten = 10;\n");
    writeFileSync(join(cwd, "README.md"), "# Hello\n");
    writeFileSync(join(cwd, "logo.png"), ONE_PIXEL_PNG);
    writeFileSync(join(outside, "secret.txt"), "top-secret\n");

    symlinkSync(outside, join(cwd, "escape-dir"));
    symlinkSync(join(outside, "secret.txt"), join(cwd, "escape-file.txt"));
    symlinkSync(cwd, join(cwd, "src", "cycle-root"));
    symlinkSync(join(cwd, "README.md"), join(cwd, "src", "readme-link.md"));

    const rootRes = handleWorkspaceTree(store, room.id, new URL(`http://localhost/api/rooms/${room.id}/tree`));
    expect(rootRes.status).toBe(200);
    const rootTree = (await rootRes.json()) as WorkspaceTreeResponse;
    expect(rootTree.state).toBe("ready");
    expect(rootTree.entries.map((entry) => entry.name)).toEqual(["src", "node_modules", "logo.png", "README.md"]);
    expect(rootTree.entries.find((entry) => entry.name === "node_modules")?.muted).toBe(true);
    expect(rootTree.entries.find((entry) => entry.name === "logo.png")?.image).toBe(true);
    expect(rootTree.entries.find((entry) => entry.name === "README.md")?.previewable).toBe(true);

    const srcRes = handleWorkspaceTree(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/tree?dir=${encodeURIComponent("src")}`),
    );
    expect(srcRes.status).toBe(200);
    const srcTree = (await srcRes.json()) as WorkspaceTreeResponse;
    expect(srcTree.entries.map((entry) => entry.path)).toEqual(["src/file2.ts", "src/file10.ts", "src/readme-link.md"]);

    for (const invalid of ["../outside", "/etc", "src/../..", "escape-dir"]) {
      const bad = handleWorkspaceTree(
        store,
        room.id,
        new URL(`http://localhost/api/rooms/${room.id}/tree?dir=${encodeURIComponent(invalid)}`),
      );
      expect(bad.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("returns unavailable state when workspace folder is missing", async () => {
    const { cwd, store, room } = fixture();
    rmSync(cwd, { recursive: true, force: true });

    const treeRes = handleWorkspaceTree(store, room.id, new URL(`http://localhost/api/rooms/${room.id}/tree`));
    expect(treeRes.status).toBe(200);
    const tree = (await treeRes.json()) as WorkspaceTreeResponse;
    expect(tree.state).toBe("unavailable");

    const searchRes = handleWorkspaceSearch(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/tree/search?q=readme`),
    );
    expect(searchRes.status).toBe(200);
    const search = (await searchRes.json()) as WorkspaceSearchResponse;
    expect(search.state).toBe("unavailable");
  });

  test("searches workspace filenames quickly while skipping muted folders unless queried", async () => {
    const { cwd, outside, store, room } = fixture();
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(cwd, "src", "App.tsx"), "export function App() {}\n");
    writeFileSync(join(cwd, "src", "components", "AppHeader.tsx"), "export function AppHeader() {}\n");
    writeFileSync(join(cwd, "node_modules", "foo", "AppVendor.js"), "export default 1;\n");
    writeFileSync(join(outside, "AppOutside.ts"), "secret\n");
    symlinkSync(outside, join(cwd, "linked-outside"));

    const res = handleWorkspaceSearch(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/tree/search?q=app`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceSearchResponse;
    expect(body.items.map((item) => item.path)).toEqual(["src/App.tsx", "src/components/AppHeader.tsx"]);
    expect(body.items[0]?.size).toBeGreaterThan(0);

    const vendorRes = handleWorkspaceSearch(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/tree/search?q=${encodeURIComponent("node_modules/foo")}`),
    );
    const vendorBody = (await vendorRes.json()) as WorkspaceSearchResponse;
    expect(vendorBody.items.map((item) => item.path)).toEqual(["node_modules/foo/AppVendor.js"]);
  });

  test("previews text files safely and serves downloads and inline raster images", async () => {
    const { cwd, outside, store, room } = fixture();
    writeFileSync(join(cwd, "guide.md"), "# Guide\n\nSafe preview.\n");
    writeFileSync(join(cwd, "pixel.png"), ONE_PIXEL_PNG);
    writeFileSync(join(cwd, "vector.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(cwd, "huge.ts"), "x".repeat(FILE_PREVIEW_MAX_BYTES + 8));
    writeFileSync(join(outside, "secret.md"), "nope\n");
    symlinkSync(join(outside, "secret.md"), join(cwd, "secret-link.md"));

    const previewRes = handleWorkspaceFilePreview(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/preview?path=guide.md`),
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as FilePreviewContent;
    expect(preview.kind).toBe("markdown");
    expect(preview.text).toContain("Safe preview.");

    const tooLarge = handleWorkspaceFilePreview(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/preview?path=huge.ts`),
    );
    expect(tooLarge.status).toBe(413);

    const escapePreview = handleWorkspaceFilePreview(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/preview?path=secret-link.md`),
    );
    expect(escapePreview.status).toBe(403);

    const inlineImg = handleWorkspaceFileContent(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/content?path=pixel.png&inline=1`),
    );
    expect(inlineImg.status).toBe(200);
    expect(inlineImg.headers.get("content-disposition")).toBe("inline");
    expect(inlineImg.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(Buffer.from(await inlineImg.arrayBuffer())).toEqual(ONE_PIXEL_PNG);

    const svgInline = handleWorkspaceFileContent(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/content?path=vector.svg&inline=1`),
    );
    expect(svgInline.status).toBe(415);

    const svgDownload = handleWorkspaceFileContent(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/workspace-file/content?path=vector.svg`),
    );
    expect(svgDownload.status).toBe(200);
    expect(svgDownload.headers.get("content-disposition")).toContain("attachment;");

    // Verify conversation attachment inline image headers as well.
    const msg = store.insertMessage({
      roomId: room.id,
      runId: "img-run",
      hop: 0,
      senderKind: "agent",
      senderId: null,
      senderName: "Agent",
      content: "[pixel](pixel.png)",
      status: "done",
    });
    store.updateReply(msg.id, {
      content: "[pixel](pixel.png)",
      status: "done",
      timeline: emptyTimeline(),
    });
    const list = (await handleConversationFiles(
      store,
      room.id,
      new URL(`http://localhost/api/rooms/${room.id}/files`),
    ).json()) as ConversationFilesPage;
    const fileId = list.items[0]?.id ?? "";
    const convInline = handleConversationFileContent(
      store,
      room.id,
      fileId,
      new URL(`http://localhost/api/rooms/${room.id}/files/${encodeURIComponent(fileId)}/content?inline=1`),
    );
    expect(convInline.status).toBe(200);
    expect(convInline.headers.get("content-disposition")).toBe("inline");
  });
});
