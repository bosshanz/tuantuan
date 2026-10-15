import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../server/acp";
import { installManaged, run } from "../server/managed";
import { platformKey, type RegistryAgent, RegistryAgentSchema } from "../server/registry";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tt-managed-boundary-"));
  const savedRoot = process.env.TUANTUAN_HARNESS_DIR;
  process.env.TUANTUAN_HARNESS_DIR = root;
  const sentinel = join(root, "agents", "existing-agent", "marker");
  mkdirSync(join(root, "agents", "existing-agent"), { recursive: true });
  writeFileSync(sentinel, "existing installation");
  const agent: RegistryAgent = {
    id: "test-agent",
    name: "Test agent",
    version: "1.0.0",
    description: "",
    authors: [],
    license: "",
    distribution: { binary: { [platformKey()]: { archive: "https://invalid.example/marker", cmd: "marker" } } },
  };
  return {
    root,
    sentinel,
    agent,
    close() {
      if (savedRoot === undefined) delete process.env.TUANTUAN_HARNESS_DIR;
      else process.env.TUANTUAN_HARNESS_DIR = savedRoot;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("managed installation boundaries", () => {
  test("rejects unsafe versions before touching any existing agents, including direct callers", async () => {
    const f = fixture();
    try {
      for (const version of [".", "..", "../other", "a/b", "a\\b", "manifest.json", ""]) {
        const agent = { ...f.agent, version };
        expect(RegistryAgentSchema.safeParse(agent).success).toBe(false);
        await expect(
          installManaged(agent, { signal: new AbortController().signal, env: {}, log: () => {} }),
        ).rejects.toThrow();
        expect(readFileSync(f.sentinel, "utf8")).toBe("existing installation");
        expect(readdirSync(join(f.root, "agents"))).toEqual(["existing-agent"]);
      }
      for (const version of ["1.2.3", "v1.2.3-rc.1+build", "2026.10.15"]) {
        expect(RegistryAgentSchema.safeParse({ ...f.agent, version }).success).toBe(true);
      }
    } finally {
      f.close();
    }
  });

  test("rejects a symlinked agent directory before creating or deleting files", async () => {
    const f = fixture();
    try {
      symlinkSync(join(f.root, "agents", "existing-agent"), join(f.root, "agents", f.agent.id), "dir");
      await expect(
        installManaged(f.agent, { signal: new AbortController().signal, env: {}, log: () => {} }),
      ).rejects.toThrow("符号链接");
      expect(readFileSync(f.sentinel, "utf8")).toBe("existing installation");
      expect(readdirSync(join(f.root, "agents", "existing-agent"))).toEqual(["marker"]);
    } finally {
      f.close();
    }
  });

  test("an already-cancelled installation performs no filesystem work", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(installManaged(f.agent, { signal: abort.signal, env: {}, log: () => {} })).rejects.toThrow();
      expect(readFileSync(f.sentinel, "utf8")).toBe("existing installation");
      expect(readdirSync(join(f.root, "agents"))).toEqual(["existing-agent"]);
    } finally {
      f.close();
    }
  });

  test("cancellation after download cannot publish a new version or replace its old manifest", async () => {
    const f = fixture();
    const abort = new AbortController();
    const body = "synthetic executable";
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    const base = join(f.root, "agents", f.agent.id);
    mkdirSync(join(base, "0.9.0"), { recursive: true });
    writeFileSync(join(base, "manifest.json"), "old manifest");
    f.agent.distribution.binary = {
      [platformKey()]: { archive: `http://127.0.0.1:${server.port}/marker`, cmd: "marker", sha256 },
    };
    try {
      await expect(
        installManaged(f.agent, {
          signal: abort.signal,
          env: {},
          log: (line) => {
            if (line === "校验和一致") abort.abort();
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(join(base, "manifest.json"), "utf8")).toBe("old manifest");
      expect(readdirSync(base).sort()).toEqual(["0.9.0", "manifest.json"]);
      expect(readFileSync(f.sentinel, "utf8")).toBe("existing installation");
    } finally {
      server.stop(true);
      f.close();
    }
  });

  test("managed commands abort their whole process tree and refuse pre-aborted work", async () => {
    const f = fixture();
    const abort = new AbortController();
    const started = join(f.root, "started");
    const marker = join(f.root, "survived");
    const script = join(f.root, "grandchild.sh");
    writeFileSync(
      script,
      `trap '' TERM\nprintf ready > ${shellQuote(started)}\n/bin/sleep 0.1\nprintf survived > ${shellQuote(marker)}\n`,
    );
    const ctx = { signal: abort.signal, env: { PATH: "/usr/bin:/bin" }, log: () => {} };
    const pending = run("/bin/sh", ["-c", `sh ${shellQuote(script)} & wait`], ctx);
    // Attach the rejection handler before cancellation so the test also catches unhandled rejections.
    const stopped = pending.then(
      () => null,
      (error: Error) => error,
    );
    try {
      for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(5);
      expect(existsSync(started)).toBe(true);
      abort.abort();
      expect((await stopped)?.message).toBe("已取消");
      await Bun.sleep(250);
      expect(existsSync(marker)).toBe(false);
      await expect(run("/bin/sh", ["-c", `touch ${shellQuote(marker)}`], ctx)).rejects.toThrow();
      expect(existsSync(marker)).toBe(false);
    } finally {
      abort.abort();
      f.close();
    }
  });
});
