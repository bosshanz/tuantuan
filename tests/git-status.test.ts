import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGitStatus, handleGitStatusDetail } from "../server/git-status";
import { Store } from "../server/store";
import type { GitStatusDetailResponse, GitStatusResponse, GitStatusSection } from "../shared/gitStatus";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(options: { init?: boolean; subdirectory?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tt-git-status-"));
  const repo = join(root, "repo");
  const cwd = options.subdirectory ? join(repo, "project") : repo;
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (options.init !== false) {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
  }
  const store = new Store(join(root, "chat.sqlite"));
  const project = store.createProject("project", cwd);
  const room = store.createRoom("room", [], { projectId: project.id });
  cleanups.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    repo,
    cwd,
    git,
    store,
    room,
    list: async () => (await (await handleGitStatus(store, room.id)).json()) as GitStatusResponse,
    detail: async (path: string, section: GitStatusSection) => {
      const query = new URLSearchParams({ path, section });
      return (await (
        await handleGitStatusDetail(store, room.id, new URL(`http://localhost/?${query}`))
      ).json()) as GitStatusDetailResponse;
    },
  };
}

describe("Git workspace status", () => {
  test("reports scoped staged, unstaged, untracked and deleted files with literal path details", async () => {
    const f = fixture({ subdirectory: true });
    writeFileSync(join(f.cwd, "a.txt"), "base\n");
    writeFileSync(join(f.cwd, "deleted.txt"), "delete me\n");
    writeFileSync(join(f.cwd, ":(glob)*.txt"), "original\n");
    writeFileSync(join(f.repo, "outside.txt"), "outside\n");
    f.git("add", ".");
    f.git("commit", "-qm", "baseline");
    writeFileSync(join(f.cwd, "a.txt"), "staged\n");
    f.git("add", "project/a.txt");
    writeFileSync(join(f.cwd, "a.txt"), "unstaged\n");
    writeFileSync(join(f.cwd, ":(glob)*.txt"), "literal\n");
    rmSync(join(f.cwd, "deleted.txt"));
    writeFileSync(join(f.cwd, "new\nfile.txt"), "new content\n");
    writeFileSync(join(f.repo, "outside.txt"), "changed outside\n");

    const before = readFileSync(join(f.repo, ".git", "index"));
    const status = await f.list();
    expect(status.state).toBe("ready");
    expect(status.scope).toBe("project");
    expect(status.items).toEqual(
      expect.arrayContaining([
        { path: "project/a.txt", staged: "M", unstaged: "M", untracked: false },
        { path: "project/deleted.txt", staged: null, unstaged: "D", untracked: false },
        { path: "project/new\nfile.txt", staged: null, unstaged: null, untracked: true },
      ]),
    );
    expect(status.items.some((item) => item.path === "outside.txt")).toBe(false);
    expect((await f.detail("project/a.txt", "staged")).content).toContain("+staged");
    expect((await f.detail("project/a.txt", "unstaged")).content).toContain("+unstaged");
    expect((await f.detail("project/:(glob)*.txt", "unstaged")).content).toContain("+literal");
    expect((await f.detail("project/deleted.txt", "unstaged")).content).toContain("-delete me");
    expect(await f.detail("project/new\nfile.txt", "untracked")).toMatchObject({
      state: "text",
      content: "new content\n",
    });
    expect((await f.detail("outside.txt", "unstaged")).state).toBe("unavailable");
    expect(readFileSync(join(f.repo, ".git", "index"))).toEqual(before);
  });

  test("unborn repository exposes staged and untracked content", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "staged.txt"), "staged\n");
    writeFileSync(join(f.cwd, "new.txt"), "new\n");
    f.git("add", "staged.txt");
    const status = await f.list();
    expect(status.state).toBe("unborn");
    expect(status.items).toEqual(
      expect.arrayContaining([
        { path: "staged.txt", staged: "A", unstaged: null, untracked: false },
        { path: "new.txt", staged: null, unstaged: null, untracked: true },
      ]),
    );
    expect((await f.detail("staged.txt", "staged")).content).toContain("+staged");
  });

  test("reports non-repository, binary, too large, symlink escape and stale status", async () => {
    const missing = fixture({ init: false });
    expect((await missing.list()).state).toBe("not-repository");
    const f = fixture();
    writeFileSync(join(f.cwd, "binary"), Buffer.from([0, 1, 2]));
    writeFileSync(join(f.cwd, "large"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(f.root, "secret"), "outside");
    symlinkSync(join(f.root, "secret"), join(f.cwd, "link"));
    expect((await f.detail("binary", "untracked")).state).toBe("binary");
    expect((await f.detail("large", "untracked")).state).toBe("too-large");
    expect((await f.detail("link", "untracked")).state).toBe("unavailable");
    expect((await f.detail("../secret", "untracked")).state).toBe("unavailable");
    rmSync(join(f.cwd, "binary"));
    expect((await f.detail("binary", "untracked")).state).toBe("unavailable");
  });

  test("refuses active clean filters from included Git configuration without executing them", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "file"), "original\n");
    writeFileSync(join(f.cwd, ".gitattributes"), "file filter=probe\n");
    f.git("add", ".");
    f.git("commit", "-qm", "baseline");
    const marker = join(f.root, "filter-ran");
    const included = join(f.root, "filters.config");
    writeFileSync(included, `[filter "probe"]\n clean = touch ${marker}; cat\n`);
    f.git("config", "include.path", included);
    writeFileSync(join(f.cwd, "file"), "changed\n");
    const result = await f.list();
    expect(result.state).toBe("error");
    expect(result.error).toContain("clean filter");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("does not block a configured filter unused by files in the conversation scope", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "file"), "original\n");
    f.git("add", ".");
    f.git("commit", "-qm", "baseline");
    const marker = join(f.root, "filter-ran");
    f.git("config", "filter.probe.clean", `touch ${marker}; cat`);
    writeFileSync(join(f.cwd, "file"), "changed\n");
    expect((await f.list()).state).toBe("ready");
    expect((await f.detail("file", "unstaged")).content).toContain("+changed");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("refuses scoped submodules instead of inspecting their own Git configuration", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "file"), "one\n");
    f.git("add", "file");
    f.git("commit", "-qm", "baseline");
    const head = f.git("rev-parse", "HEAD").trim();
    f.git("update-index", "--add", "--cacheinfo", `160000,${head},module`);
    const result = await f.list();
    expect(result.state).toBe("error");
    expect(result.error).toContain("子模块");
  });

  test("reports oversized tracked patch instead of returning a partial diff", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "large.txt"), "old\n");
    f.git("add", "large.txt");
    f.git("commit", "-qm", "baseline");
    writeFileSync(join(f.cwd, "large.txt"), `${"x".repeat(1024 * 1024 + 1)}\n`);
    expect((await f.detail("large.txt", "unstaged")).state).toBe("too-large");
  });

  test("reports tracked binary changes and never calls external diff or textconv", async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, "binary"), Buffer.from([0, 1]));
    writeFileSync(join(f.cwd, ".gitattributes"), "binary diff=bad\n");
    f.git("add", ".");
    f.git("commit", "-qm", "baseline");
    f.git("config", "diff.bad.textconv", `touch ${join(f.root, "textconv-ran")}`);
    f.git("config", "diff.external", `touch ${join(f.root, "external-ran")}`);
    writeFileSync(join(f.cwd, "binary"), Buffer.from([0, 2]));
    expect((await f.detail("binary", "unstaged")).state).toBe("binary");
    expect(() => readFileSync(join(f.root, "textconv-ran"))).toThrow();
    expect(() => readFileSync(join(f.root, "external-ran"))).toThrow();
  });
});
