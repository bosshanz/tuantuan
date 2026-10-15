import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_AGENT_PATH } from "../../server/harness";
import { platformKey } from "../../server/registry";

/**
 * A local stand-in for the ACP registry CDN + npm: one binary agent (tar.gz with a launcher script
 * that runs the mock ACP agent), one npx agent (a tiny npm package served from a fake npm
 * registry), and one malformed entry the schema must skip.
 */
export function mockRegistry(opts: { version?: string; badSha?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mock-acp-registry-"));
  const state = { version: opts.version ?? "1.0.0", badSha: !!opts.badSha, hits: { registry: 0, icon: 0 } };
  const build = (version: string) => {
    const src = join(dir, `src-${version}`);
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "bin", "mock-acp"), `#!/bin/sh\nexec "${process.execPath}" "${MOCK_AGENT_PATH}" "$@"\n`, {
      mode: 0o755,
    });
    const tgz = join(dir, `mock-acp-${version}.tar.gz`);
    Bun.spawnSync(["tar", "-czf", tgz, "-C", src, "bin"]);
    // npm package: package/package.json + package/index.js (bin)
    const pkg = join(dir, `npm-${version}`, "package");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "mock-npx-acp", version, bin: { "mock-npx-acp": "index.js" }, engines: { node: ">=18" } }),
    );
    writeFileSync(join(pkg, "index.js"), `await import(${JSON.stringify(MOCK_AGENT_PATH)});\n`);
    const npmTgz = join(dir, `mock-npx-acp-${version}.tgz`);
    Bun.spawnSync(["tar", "-czf", npmTgz, "-C", join(dir, `npm-${version}`), "package"]);
    return { tgz, npmTgz };
  };
  const sha = (f: string) => new Bun.CryptoHasher("sha256").update(readFileSync(f)).digest("hex");
  const sha1 = (f: string) => new Bun.CryptoHasher("sha1").update(readFileSync(f)).digest("hex");
  const files = new Map<string, ReturnType<typeof build>>();
  const filesFor = (v: string) => {
    if (!files.has(v)) files.set(v, build(v));
    return files.get(v) as ReturnType<typeof build>;
  };
  let port = 0;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    fetch(req): Response {
      const u = new URL(req.url);
      const base: string = `http://127.0.0.1:${port}`;
      const v = state.version;
      const f = filesFor(v);
      if (u.pathname === "/registry.json") {
        state.hits.registry++;
        return Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "mock-bin",
              name: "Mock 二进制",
              version: v,
              description: "binary distribution (test)",
              authors: ["Tuantuan"],
              license: "MIT",
              icon: `${base}/icons/mock-bin.svg`,
              distribution: {
                binary: {
                  [platformKey()]: {
                    archive: `${base}/dl/mock-acp-${v}.tar.gz`,
                    cmd: "./bin/mock-acp",
                    args: [],
                    sha256: state.badSha ? "0".repeat(64) : sha(f.tgz),
                  },
                },
              },
            },
            {
              id: "mock-npx",
              name: "Mock npx",
              version: v,
              description: "npx distribution (test)",
              authors: ["Tuantuan"],
              license: "Apache-2.0",
              distribution: { npx: { package: `mock-npx-acp@${v}`, env: { MOCK_FROM_REGISTRY: "1" } } },
            },
            { id: "broken", name: "", version: "1", distribution: {} },
          ],
          extensions: [],
        });
      }
      if (u.pathname === "/icons/mock-bin.svg") {
        state.hits.icon++;
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>',
        );
      }
      const dl = u.pathname.match(/^\/dl\/mock-acp-(.+)\.tar\.gz$/);
      if (dl) return new Response(Bun.file(filesFor(dl[1] as string).tgz));
      // fake npm registry
      if (u.pathname === "/npm/mock-npx-acp" || u.pathname.startsWith("/npm/mock-npx-acp/")) {
        const doc = (ver: string) => ({
          name: "mock-npx-acp",
          version: ver,
          bin: { "mock-npx-acp": "index.js" },
          engines: { node: ">=18" },
          dist: { tarball: `${base}/npm/-/mock-npx-acp-${ver}.tgz`, shasum: sha1(filesFor(ver).npmTgz) },
        });
        const one = u.pathname.split("/")[3];
        if (one) return Response.json(doc(one === "latest" ? v : one));
        return Response.json({ name: "mock-npx-acp", "dist-tags": { latest: v }, versions: { [v]: doc(v) } });
      }
      const t = u.pathname.match(/^\/npm\/-\/mock-npx-acp-(.+)\.tgz$/);
      if (t) return new Response(Bun.file(filesFor(t[1] as string).npmTgz));
      return new Response("nope", { status: 404 });
    },
  });
  port = server.port ?? 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, state, url: `${base}/registry.json`, npm: `${base}/npm/`, stop: () => server.stop(true) };
}
