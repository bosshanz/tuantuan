import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpProcess } from "../server/acp";

const temp = mkdtempSync(join(tmpdir(), "tt-acp-paths-"));
const root = join(temp, "project");
const outside = join(temp, "outside");
mkdirSync(root);
mkdirSync(outside);
mkdirSync(join(root, "actual"));
writeFileSync(join(outside, "marker"), "outside");
writeFileSync(join(root, "actual", "marker"), "inside");
symlinkSync(outside, join(root, "escape"), "dir");
symlinkSync(join(outside, "marker"), join(root, "escape-file"), "file");
symlinkSync(join(outside, "missing"), join(root, "dangling"), "file");
symlinkSync(join(root, "actual"), join(root, "allowed"), "dir");
symlinkSync(root, join(temp, "project-link"), "dir");

// Exercise the actual ACP request handlers, without a model or any external harness.
type FileHandlers = {
  readTextFile(p: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(p: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  createTerminal(p: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
};
const processes: AcpProcess[] = [];
function client(cwd = root) {
  const p = new AcpProcess(
    { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {}, cwd },
    { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
  );
  processes.push(p);
  return { p, files: p as unknown as FileHandlers };
}
const { p, files } = client();

afterAll(async () => {
  for (const process of processes) process.kill();
  await Promise.all(processes.map((process) => process.exited));
  rmSync(temp, { recursive: true, force: true });
});

test("outside directory/file links and dangling links cannot read or overwrite outside files", async () => {
  for (const path of ["escape/marker", "escape-file", "dangling"]) {
    await expect(files.readTextFile({ sessionId: "test", path })).rejects.toThrow();
    await expect(files.writeTextFile({ sessionId: "test", path, content: "changed" })).rejects.toThrow();
  }
  await expect(
    files.writeTextFile({ sessionId: "test", path: "escape/new/marker", content: "changed" }),
  ).rejects.toThrow();
  expect(readFileSync(join(outside, "marker"), "utf8")).toBe("outside");
  expect(existsSync(join(outside, "new"))).toBe(false);
  await expect(files.createTerminal({ sessionId: "test", command: "pwd", cwd: "escape" })).rejects.toThrow();
});

test("inside links, missing parents, and a symlinked project root remain usable", async () => {
  expect(await files.readTextFile({ sessionId: "test", path: "allowed/marker" })).toEqual({ content: "inside" });
  await files.writeTextFile({ sessionId: "test", path: "allowed/new/deep/marker", content: "new" });
  expect(readFileSync(join(root, "actual/new/deep/marker"), "utf8")).toBe("new");
  const linked = client(join(temp, "project-link"));
  expect(await linked.files.readTextFile({ sessionId: "test", path: "allowed/marker" })).toEqual({ content: "inside" });
  expect(linked.p.inside(join(realpathSync(root), "actual/marker"))).toBe(join(realpathSync(root), "actual/marker"));
  expect(p.inside("new/nested/file")).toBe(join(realpathSync(root), "new/nested/file"));
  expect(() => linked.p.inside("../outside/marker")).toThrow();
});
