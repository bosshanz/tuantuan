import { describe, expect, test } from "bun:test";
import { localFileTarget, resolveLocalFileLink } from "../shared/localFileLink";

const cwd = "/proj/root";

describe("localFileTarget", () => {
  test("accepts relative, absolute and file:// targets", () => {
    expect(localFileTarget("src/a.ts")).toBe("src/a.ts");
    expect(localFileTarget("./src/a.ts")).toBe("./src/a.ts");
    expect(localFileTarget("/abs/a.ts")).toBe("/abs/a.ts");
    expect(localFileTarget("file:///abs/a%20b.ts")).toBe("/abs/a b.ts");
    expect(localFileTarget("file://localhost/abs/a.ts")).toBe("/abs/a.ts");
    expect(localFileTarget("C:\\work\\a.ts")).toBe("C:\\work\\a.ts");
  });
  test("strips line/column suffixes like the reference parser", () => {
    expect(localFileTarget("src/a.ts:12")).toBe("src/a.ts");
    expect(localFileTarget("src/a.ts:12:3")).toBe("src/a.ts");
    expect(localFileTarget("src/a.ts#L12")).toBe("src/a.ts");
    expect(localFileTarget("src/a.ts#L12C3-L20")).toBe("src/a.ts");
  });
  test("rejects remote, scheme, anchor and malformed targets", () => {
    for (const href of [
      "https://x/y",
      "http://x",
      "mailto:a@b.c",
      "vscode://file/x",
      "#anchor",
      "#/r/1",
      "//host/share",
      "\\\\host\\share",
      "file://remote/x",
      "file://%/x",
      "",
    ])
      expect(localFileTarget(href)).toBeNull();
  });
});

describe("resolveLocalFileLink", () => {
  test("relative and inside-workspace absolute links resolve to workspace paths", () => {
    expect(resolveLocalFileLink(cwd, "src/a.ts")).toEqual({ absolute: "/proj/root/src/a.ts", relative: "src/a.ts" });
    expect(resolveLocalFileLink(cwd, "./src/../b.ts")).toEqual({ absolute: "/proj/root/b.ts", relative: "b.ts" });
    expect(resolveLocalFileLink(cwd, "/proj/root/src/a.ts")).toEqual({
      absolute: "/proj/root/src/a.ts",
      relative: "src/a.ts",
    });
    expect(resolveLocalFileLink(cwd, "file:///proj/root/a.md#L3")).toEqual({
      absolute: "/proj/root/a.md",
      relative: "a.md",
    });
    expect(resolveLocalFileLink(cwd, "/proj/root")).toEqual({ absolute: "/proj/root", relative: "" });
  });
  test("outside targets stay absolute with a null workspace path", () => {
    expect(resolveLocalFileLink(cwd, "/etc/passwd")).toEqual({ absolute: "/etc/passwd", relative: null });
    expect(resolveLocalFileLink(cwd, "../other/a.ts")).toEqual({ absolute: "/proj/other/a.ts", relative: null });
    expect(resolveLocalFileLink(cwd, "/proj/rootx/a.ts")).toEqual({ absolute: "/proj/rootx/a.ts", relative: null });
  });
  test("a conversation without a project keeps relative links unresolved", () => {
    expect(resolveLocalFileLink("", "docs/x.md")).toEqual({ absolute: "docs/x.md", relative: null });
    expect(resolveLocalFileLink("", "/abs/a.ts")).toEqual({ absolute: "/abs/a.ts", relative: null });
  });
  test("windows-style paths resolve with their drive", () => {
    expect(resolveLocalFileLink("C:/proj/root", "C:\\proj\\root\\src\\a.ts")).toEqual({
      absolute: "C:/proj/root/src/a.ts",
      relative: "src/a.ts",
    });
    expect(resolveLocalFileLink("C:/proj/root", "D:/elsewhere/a.ts")).toEqual({
      absolute: "D:/elsewhere/a.ts",
      relative: null,
    });
  });
  test("remote links are not file links", () => {
    expect(resolveLocalFileLink(cwd, "https://example.com/a.ts")).toBeNull();
    expect(resolveLocalFileLink(cwd, "#/r/1")).toBeNull();
  });
});
