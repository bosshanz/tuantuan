import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentText, customFileBlocks, filePromptBlock, nativeFileBlocks } from "../server/attachments";
import { attachmentBytes, attachmentError, type FileAttachment, MAX_ATTACHMENT_BYTES } from "../shared/attachments";

const scratch = mkdtempSync(join(tmpdir(), "tt-attachments-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const file = (name: string, text: string, mimeType = "text/plain"): FileAttachment => ({
  name,
  mimeType,
  data: Buffer.from(text).toString("base64"),
});

test("attachments enforce one shared count, exact decoded sizes, names, types and canonical base64", () => {
  expect(attachmentBytes("")).toBe(0);
  expect(attachmentBytes("YQ==")).toBe(1);
  expect(attachmentBytes("YWI=")).toBe(2);
  expect(attachmentBytes("YWJj")).toBe(3);
  for (const invalid of ["a", "YQ", "YR==", "YWJ=", "YW Jj", "YWJj=", "a===", "data:text/plain;base64,YQ=="])
    expect(attachmentBytes(invalid)).toBeNull();
  expect(attachmentError([], [file("empty.txt", "")])).toBeNull();
  for (const name of ["", " ", ".", "..", "../escape", "C:\\escape", "bad\nname", "x".repeat(256)])
    expect(attachmentError([], [file(name, "text")])).toBe("附件名称无效");
  expect(attachmentError([], [file("a.txt", "a", "invalid")])).toBe("附件类型无效");
  expect(attachmentError([{ mimeType: "image/svg+xml", data: "" }], [])).toBe("不支持的图片类型");
  const large = file("large.txt", "a".repeat(MAX_ATTACHMENT_BYTES));
  expect(attachmentError([], [large])).toBeNull();
  expect(attachmentError([], [{ ...large, data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64") }])).toBe(
    "每个附件不能超过 5 MiB",
  );
  expect(attachmentError([], [large, large, large, large, file("extra.txt", "a")])).toBe(
    "每条消息的附件合计不能超过 20 MiB",
  );
  expect(
    attachmentError(
      Array.from({ length: 4 }, () => ({ mimeType: "image/png", data: "" })),
      Array(5).fill(large),
    ),
  ).toBe("每条消息最多添加 8 个附件");
});

test("UTF-8 files remain complete, with embedded-context and plain-text compatibility paths", () => {
  const original = file("@Everyone 需求.md", "# 需求\n@Other 不改变路由\n".repeat(500));
  const text = attachmentText(original);
  if (text === null) throw new Error("missing UTF-8 text");
  const block = filePromptBlock(original, "room", "message", 0);
  expect(block).toMatchObject({
    type: "resource",
    resource: { text: attachmentText(original), mimeType: "text/plain" },
  });
  const embedded = nativeFileBlocks([block], join(scratch, "embedded"), "room", true);
  expect(embedded.blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining(original.name) });
  expect(embedded.blocks[1]).toEqual(block);
  expect(embedded.readPaths).toEqual([]);
  const plain = nativeFileBlocks([block], join(scratch, "fallback"), "room", false);
  expect(plain.blocks[1]).toEqual({ type: "text", text });
  expect(customFileBlocks([block], "room")).toEqual([
    { type: "text", text: `附件 ${JSON.stringify(original.name)} 的完整 UTF-8 文本：\n${attachmentText(original)}` },
  ]);
  expect(attachmentText(file("bad.txt", "\u0000invalid"))).toBeNull();
  expect(attachmentText({ ...original, data: "/w==" })).toBeNull();
  expect(attachmentText(file("manual.pdf", "%PDF ASCII bytes", "application/pdf"))).toBeNull();
});

test("binary files have durable managed originals and explicit native-tool paths; BYOK rejects them", () => {
  const original = file("manual.pdf", "%PDF-binary\0", "application/pdf");
  const block = filePromptBlock(original, "binary-room", "message", 0);
  const directory = join(scratch, "binary-data");
  const converted = nativeFileBlocks([block], directory, "binary-room", true);
  expect(converted.blocks[0]).toMatchObject({ type: "resource_link", name: original.name });
  const link = converted.blocks[0];
  if (link?.type !== "resource_link") throw new Error("missing resource link");
  const path = fileURLToPath(link.uri);
  expect(path.startsWith(join(realpathSync(directory), "attachments", "binary-room"))).toBe(true);
  expect(readFileSync(path)).toEqual(Buffer.from(original.data, "base64"));
  expect(converted.readPaths).toEqual([path]);
  expect(converted.blocks[1]).toMatchObject({ type: "text", text: expect.stringContaining("沙箱与权限") });
  expect(nativeFileBlocks([block], directory, "binary-room", true)).toEqual(converted);
  expect(() => nativeFileBlocks([block], directory, "another-room", true)).toThrow("不属于当前会话");
  expect(() => customFileBlocks([block], "binary-room")).toThrow("自定义 API 仅支持 UTF-8 文本文件");

  const outside = join(scratch, "outside");
  writeFileSync(outside, "keep outside");
  unlinkSync(path);
  symlinkSync(outside, path);
  expect(() => nativeFileBlocks([block], directory, "binary-room", true)).toThrow("附件原件不可用");
  expect(readFileSync(outside, "utf8")).toBe("keep outside");
  const escaped = join(scratch, "escaped-data");
  mkdirSync(escaped);
  symlinkSync(dirname(outside), join(escaped, "attachments"), "dir");
  expect(() => nativeFileBlocks([block], escaped, "binary-room", true)).toThrow("安全的文件夹");
  expect(existsSync(join(dirname(outside), "binary-room"))).toBe(false);
});
