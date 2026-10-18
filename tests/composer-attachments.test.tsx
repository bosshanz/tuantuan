import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "../shared/attachments";
import { emptyTimeline } from "../shared/timeline";
import {
  formatAttachmentSize,
  selectedAttachmentError,
  splitComposerAttachments,
} from "../web/src/composerAttachments";
import { fileAttachmentBlob } from "../web/src/FileAttachments";
import { TimelineView } from "../web/src/Harness";

const textFile = { name: "notes.md", mimeType: "text/markdown", data: "aGVsbG8=" };

test("only supported image MIME types enter the image channel; all other files retain their names", () => {
  const selection = splitComposerAttachments([
    textFile,
    { name: "picture.png", mimeType: "image/png", data: "aGVsbG8=" },
    { name: "drawing.svg", mimeType: "image/svg+xml", data: "aGVsbG8=" },
  ]);
  expect(selection.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
  expect(selection.files.map((file) => file.name)).toEqual(["notes.md", "drawing.svg"]);
});

test("the composer rejects the entire selection before reading if count or byte limits would be exceeded", () => {
  const empty = { images: [], files: [] };
  expect(
    selectedAttachmentError(
      empty,
      Array.from({ length: 9 }, () => new File([""], "a.txt")),
    ),
  ).toContain("8");
  expect(selectedAttachmentError(empty, [new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "large.bin")])).toContain(
    "5 MiB",
  );
  const files = Array.from({ length: 4 }, () => new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "a.bin"));
  expect(files.reduce((bytes, file) => bytes + file.size, 0)).toBe(MAX_TOTAL_ATTACHMENT_BYTES);
  expect(selectedAttachmentError(empty, files)).toBeNull();
  expect(selectedAttachmentError({ images: [], files: [textFile] }, files)).toContain("20 MiB");
});

test("file download preserves arbitrary bytes and always uses an inert MIME type", async () => {
  const bytes = new Uint8Array([0, 255, 128, 60, 115, 99, 114, 105, 112, 116, 62]);
  const blob = fileAttachmentBlob({
    name: "untrusted.html",
    mimeType: "text/html",
    data: Buffer.from(bytes).toString("base64"),
  });
  expect(blob.type).toBe("application/octet-stream");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  expect(() => fileAttachmentBlob({ ...textFile, data: "bad!" })).toThrow("Base64");
});

test("human timeline files expose escaped names and an explicit download action", () => {
  const t = emptyTimeline();
  t.parts = [{ kind: "file", ...textFile, name: "<script>.html" }];
  const html = renderToStaticMarkup(<TimelineView t={t} streaming={false} terminals={{}} mentionNames={[]} />);
  expect(html).toContain("&lt;script&gt;.html");
  expect(html).toContain('download="&lt;script&gt;.html"');
  expect(html).toContain("下载文件");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("data:text/html");
});

test("attachment sizes remain readable at file boundaries", () => {
  expect(formatAttachmentSize(0)).toBe("0 B");
  expect(formatAttachmentSize(1024)).toBe("1 KiB");
  expect(formatAttachmentSize(MAX_ATTACHMENT_BYTES)).toBe("5 MiB");
});
