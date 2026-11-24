import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { serve } from "../server/app";
import { type Room, Store } from "../server/store";
import { createRoomWorktree, validateRoomWorktree } from "../server/worktrees";
import { agentInput } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "tuantuan-worktree-test-"));
const previousWorkspaces = process.env.TUANTUAN_WORKSPACES;
process.env.TUANTUAN_WORKSPACES = join(root, "workspaces");
const source = join(root, "repository");
mkdirSync(join(source, "nested"), { recursive: true });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
git(source, "init", "-q");
git(source, "config", "user.email", "test@example.invalid");
git(source, "config", "user.name", "Test");
writeFileSync(join(source, "nested", "example.txt"), "committed\n");
writeFileSync(join(source, ".gitignore"), "ignored.tmp\n");
git(source, "add", ".");
git(source, "commit", "-qm", "initial");
writeFileSync(join(source, "nested", "example.txt"), "uncommitted\n");
writeFileSync(join(source, "nested", "untracked.txt"), "untracked\n");
const db = join(root, "data", "test.sqlite");
const { app, server } = serve({ dbPath: db }, 0);
const url = `http://127.0.0.1:${server.port}`;
const project = app.store.createProject("repo", join(source, "nested"));
const agent = app.store.createAgent(agentInput("Worktree", { permissionPolicy: "allow" }));
const request = (method: string, path: string, body?: unknown) =>
  fetch(url + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
afterAll(async () => {
  app.host.shutdown();
  await app.projectTerminals.shutdown();
  server.stop(true);
  app.store.db.close();
  if (previousWorkspaces === undefined) delete process.env.TUANTUAN_WORKSPACES;
  else process.env.TUANTUAN_WORKSPACES = previousWorkspaces;
  rmSync(root, { recursive: true, force: true });
});

test("isolated rooms use separate committed checkouts and preserve them on deletion", async () => {
  const create = async () => {
    const response = await request("POST", "/api/rooms", {
      name: "isolated",
      projectId: project.id,
      agentIds: [agent.id],
      worktree: true,
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Room;
  };
  const [first, second] = await Promise.all([create(), create()]);
  expect(first.worktree).toBeDefined();
  expect(second.worktree).toBeDefined();
  expect(first.worktree?.root).not.toBe(second.worktree?.root);
  expect(first.worktree?.branch).not.toBe(second.worktree?.branch);
  expect(relative(first.worktree?.root as string, first.cwd)).toBe("nested");
  expect(readFileSync(join(first.cwd, "example.txt"), "utf8")).toBe("committed\n");
  const response = await request("POST", `/api/rooms/${first.id}/messages`, { content: "/edit" });
  expect(response.status).toBe(201);
  const sent = await response.json();
  await app.orchestrator.idle(first.id);
  expect(readFileSync(join(first.cwd, "mock-edit.txt"), "utf8")).toContain("tuantuan");
  expect(existsSync(join(second.cwd, "mock-edit.txt"))).toBe(false);
  expect(existsSync(join(source, "nested", "mock-edit.txt"))).toBe(false);
  const report = await request("GET", `/api/rooms/${first.id}/changes?runId=${sent.id}`);
  expect((await report.json()).items).toMatchObject([{ path: "mock-edit.txt", editCount: 1 }]);
  writeFileSync(join(first.cwd, "example.txt"), "first room\n");
  expect(readFileSync(join(second.cwd, "example.txt"), "utf8")).toBe("committed\n");
  expect(readFileSync(join(source, "nested", "example.txt"), "utf8")).toBe("uncommitted\n");
  expect(git(first.cwd, "branch", "--show-current")).toBe(first.worktree?.branch as string);
  const anotherProject = app.store.createProject("another", source);
  expect((await request("PATCH", `/api/rooms/${first.id}`, { projectId: anotherProject.id })).status).toBe(409);
  app.store.setAcpSession(first.id, agent.id, "mock", "isolated-session");
  const shared = app.store.createRoom("shared", [agent.id], { projectId: project.id });
  app.store.setAcpSession(shared.id, agent.id, "mock", "shared-session");
  const moved = await request("PATCH", `/api/projects/${project.id}`, { cwd: source });
  expect(moved.status).toBe(200);
  expect(app.store.getRoom(first.id)?.cwd).toBe(first.cwd);
  expect(app.store.getAcpSession(first.id, agent.id)?.sessionId).toBe("isolated-session");
  expect(app.store.getAcpSession(shared.id, agent.id)).toBeNull();
  const reopened = new Store(db);
  expect(reopened.getRoom(first.id)?.worktree).toEqual(first.worktree);
  reopened.db.close();
  expect((await request("DELETE", `/api/rooms/${first.id}`)).status).toBe(200);
  expect(readFileSync(join(first.cwd, "example.txt"), "utf8")).toBe("first room\n");
  expect(git(source, "branch", "--list", first.worktree?.branch as string)).toContain(first.worktree?.branch as string);
  expect((await request("DELETE", `/api/rooms/${second.id}`)).status).toBe(200);
});

test("rejects missing checkouts and symlinked conversation directories", async () => {
  const response = await request("POST", "/api/rooms", {
    name: "missing",
    projectId: project.id,
    agentIds: [agent.id],
    worktree: true,
  });
  expect(response.status).toBe(201);
  const room = (await response.json()) as Room;
  const worktree = room.worktree as NonNullable<Room["worktree"]>;
  const original = join(root, "moved-worktree");
  renameSync(worktree.root, original);
  expect(() => validateRoomWorktree(room)).toThrow();
  expect(app.store.getRoom(room.id)?.cwd).toBe(room.cwd);
  expect((await request("GET", `/api/rooms/${room.id}/tree`)).status).toBe(409);
  renameSync(original, worktree.root);
  expect(() => validateRoomWorktree(room)).not.toThrow();
  // Re-create a room with nested cwd for the symlink test.
  const nestedProject = app.store.createProject("nested", join(source, "nested"));
  const nestedResponse = await request("POST", "/api/rooms", {
    name: "link",
    projectId: nestedProject.id,
    agentIds: [agent.id],
    worktree: true,
  });
  const nested = (await nestedResponse.json()) as Room;
  const replaced = join(dirname(nested.cwd), "nested-original");
  renameSync(nested.cwd, replaced);
  symlinkSync(join(source, "nested"), nested.cwd);
  expect(() => validateRoomWorktree(nested)).toThrow();
  expect((await request("GET", `/api/rooms/${nested.id}/tree`)).status).toBe(409);
  expect(() => app.host.cwdFor(nested)).toThrow();
});

test("invalid inputs create no checkout and an uncommitted-only project subdirectory is cleaned up", async () => {
  const before = git(source, "worktree", "list", "--porcelain");
  const invalid = await request("POST", "/api/rooms", {
    name: "invalid",
    projectId: project.id,
    agentIds: ["missing"],
    worktree: true,
  });
  expect(invalid.status).toBe(400);
  const drafts = await request("POST", "/api/rooms", { name: "drafts", agentIds: [agent.id], worktree: true });
  expect(drafts.status).toBe(400);
  mkdirSync(join(source, "uncommitted-only"));
  const uncommitted = app.store.createProject("uncommitted", join(source, "uncommitted-only"));
  const absent = await request("POST", "/api/rooms", {
    name: "missing folder",
    projectId: uncommitted.id,
    agentIds: [agent.id],
    worktree: true,
  });
  expect(absent.status).toBe(400);
  expect(git(source, "worktree", "list", "--porcelain")).toBe(before);
});

test("a data directory inside the source repo puts checkouts beside the repo", async () => {
  const checkout = await createRoomWorktree(source, join(source, ".tuantuan-data"));
  expect(dirname(dirname(checkout.root))).toBe(dirname(realpathSync(source)));
  expect(dirname(checkout.root)).toBe(`${realpathSync(source)}.tuantuan-worktrees`);
  expect(await checkout.cleanup()).toBe(true);
});

test("failed creation cleanup preserves ignored user data", async () => {
  const checkout = await createRoomWorktree(source, join(root, "data"));
  writeFileSync(join(checkout.root, "ignored.tmp"), "do not delete");
  expect(await checkout.cleanup()).toBe(false);
  expect(readFileSync(join(checkout.root, "ignored.tmp"), "utf8")).toBe("do not delete");
  rmSync(join(checkout.root, "ignored.tmp"));
  expect(await checkout.cleanup()).toBe(true);
});

test("project changes are blocked during checkout and a deleted member rolls back only that checkout", async () => {
  const hooks = join(root, "hooks");
  const started = join(root, "checkout-started");
  mkdirSync(hooks);
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch '${started}'\nsleep 1\n`);
  chmodSync(hook, 0o755);
  git(source, "config", "core.hooksPath", hooks);
  const member = app.store.createAgent(agentInput("Temporary"));
  const before = git(source, "worktree", "list", "--porcelain");
  try {
    const creation = request("POST", "/api/rooms", {
      name: "concurrent",
      projectId: project.id,
      agentIds: [member.id],
      worktree: true,
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(started)).toBe(true);
    expect((await request("PATCH", `/api/projects/${project.id}`, { cwd: join(source, "nested") })).status).toBe(409);
    expect((await request("DELETE", `/api/projects/${project.id}`)).status).toBe(409);
    app.store.deleteAgent(member.id);
    expect((await creation).status).toBe(400);
    expect(git(source, "worktree", "list", "--porcelain")).toBe(before);
  } finally {
    git(source, "config", "--unset", "core.hooksPath");
  }
});

test("cleanup retains a clean checkout whose branch gained a commit, detached HEAD, or switched branches", async () => {
  const checkout = await createRoomWorktree(source, join(root, "data"));
  const base = git(checkout.root, "rev-parse", "HEAD");
  writeFileSync(join(checkout.root, "new.txt"), "new commit\n");
  git(checkout.root, "add", "new.txt");
  git(checkout.root, "commit", "-qm", "created while provisioning");
  const changed = git(checkout.root, "rev-parse", "HEAD");
  expect(changed).not.toBe(base);
  expect(git(checkout.root, "status", "--porcelain")).toBe("");
  expect(await checkout.cleanup()).toBe(false);
  expect(git(checkout.root, "rev-parse", "HEAD")).toBe(changed);
  expect(git(source, "rev-parse", `refs/heads/${checkout.branch}`)).toBe(changed);

  // The checkout and branch remain owned by this disposable test fixture.
  git(checkout.root, "reset", "--hard", base);
  git(checkout.root, "checkout", "--detach", base);
  expect(await checkout.cleanup()).toBe(false);
  expect(existsSync(checkout.root)).toBe(true);
  git(checkout.root, "checkout", checkout.branch);
  git(checkout.root, "checkout", "-b", "test-switch-branch");
  expect(await checkout.cleanup()).toBe(false);
  expect(git(checkout.root, "branch", "--show-current")).toBe("test-switch-branch");
  git(checkout.root, "checkout", checkout.branch);
  git(source, "branch", "-d", "test-switch-branch");
  expect(await checkout.cleanup()).toBe(true);
});

test("a nonzero post-checkout hook cleans a registered clean checkout and its exact branch", async () => {
  const hooks = join(root, "failing-hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  git(source, "config", "core.hooksPath", hooks);
  const beforeTrees = git(source, "worktree", "list", "--porcelain");
  const beforeBranches = git(source, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/tuantuan/");
  try {
    let failure = "";
    try {
      await createRoomWorktree(source, join(root, "data"));
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain("无法创建会话 worktree");
    expect(failure).not.toContain("如有残留");
    expect(git(source, "worktree", "list", "--porcelain")).toBe(beforeTrees);
    expect(git(source, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/tuantuan/")).toBe(
      beforeBranches,
    );
  } finally {
    git(source, "config", "--unset", "core.hooksPath");
  }
});

test("a failing post-checkout hook that made a commit leaves the checkout and branch for recovery", async () => {
  const hooks = join(root, "committing-hooks");
  mkdirSync(hooks);
  const hook = join(hooks, "post-checkout");
  writeFileSync(
    hook,
    "#!/bin/sh\necho changed > hook-created.txt\ngit add hook-created.txt\ngit commit -qm hook-commit\nexit 1\n",
  );
  chmodSync(hook, 0o755);
  git(source, "config", "core.hooksPath", hooks);
  const before = new Set(
    git(source, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree ")),
  );
  try {
    let failure = "";
    try {
      await createRoomWorktree(source, join(root, "data"));
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain("如有残留");
    const added = git(source, "worktree", "list", "--porcelain")
      .split("\n")
      .find((line) => line.startsWith("worktree ") && !before.has(line));
    expect(added).toBeDefined();
    const checkoutRoot = (added as string).slice("worktree ".length);
    expect(readFileSync(join(checkoutRoot, "hook-created.txt"), "utf8")).toBe("changed\n");
    expect(git(checkoutRoot, "log", "-1", "--format=%s")).toBe("hook-commit");
    expect(git(checkoutRoot, "branch", "--show-current")).toStartWith("tuantuan/");
  } finally {
    git(source, "config", "--unset", "core.hooksPath");
  }
});
