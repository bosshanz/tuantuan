import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import {
  digestFile,
  type GhRunner,
  prepareRelease,
  publishRelease,
  releaseFiles,
  releaseVersion,
  type UpdateMetadata,
  validateRelease,
} from "../desktop/scripts/release";
import { type PublishedRelease, syncHomebrew } from "../desktop/scripts/sync-homebrew";

const roots: string[] = [];
const version = "0.2.1";
const tag = `v${version}`;
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const sha512 = (data: Uint8Array) => createHash("sha512").update(data).digest("base64");
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "tt-release-"));
  roots.push(root);
  return root;
};
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = scratch();
  const dir = join(root, "artifacts");
  const output = join(root, "ready");
  mkdirSync(dir);
  const expected = releaseFiles(version);
  const blockmap = (size: number) =>
    JSON.stringify({
      version: "2",
      files: [{ name: "file", offset: 0, checksums: [Buffer.alloc(18, 1).toString("base64")], sizes: [size] }],
    });
  for (const name of [...expected.mac, expected.windows]) {
    const data = Buffer.from(`installer fixture ${name}`);
    writeFileSync(join(dir, name), data);
    if (expected.blockmaps.includes(`${name}.blockmap`))
      writeFileSync(join(dir, `${name}.blockmap`), gzipSync(blockmap(data.length)));
  }
  const image = Buffer.from("AppImage fixture with embedded differential metadata");
  const map = deflateRawSync(blockmap(image.length));
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(map.length);
  writeFileSync(join(dir, expected.linux), Buffer.concat([image, map, tail]));
  const metadata = (names: string[]): UpdateMetadata => {
    const files = names.map((url) => {
      const data = readFileSync(join(dir, url));
      return {
        url,
        sha512: sha512(data),
        size: data.length,
        ...(url === expected.linux ? { blockMapSize: map.length } : {}),
      };
    });
    const first = files[0];
    if (!first) throw new Error("fixture needs files");
    return { version, files, path: first.url, sha512: first.sha512, releaseDate: "2026-10-18T00:00:00.000Z" };
  };
  const save = (name: string, info: UpdateMetadata) =>
    writeFileSync(join(dir, name), Bun.YAML.stringify(info, null, 2));
  for (const arch of ["arm64", "x64"])
    save(`latest-mac-${arch}.yml`, metadata(expected.mac.filter((name) => name.includes(`-${arch}.`)).reverse()));
  // Simulate the overwritten channel file left by the last independent builder process.
  save("latest-mac.yml", metadata(expected.mac.filter((name) => name.includes("-x64.")).reverse()));
  save("latest.yml", metadata([expected.windows]));
  save("latest-linux.yml", metadata([expected.linux]));
  const edit = (name: string, change: (metadata: UpdateMetadata) => void) => {
    const info = Bun.YAML.parse(readFileSync(join(dir, name), "utf8")) as UpdateMetadata;
    change(info);
    save(name, info);
  };
  return { root, dir, output, expected, edit };
}

async function fakeGithub(dir: string, remoteDigestCorrect = true, latestTag: string | null = "v0.2.0") {
  const files = [
    ...releaseFiles(version).mac,
    releaseFiles(version).windows,
    releaseFiles(version).linux,
    ...releaseFiles(version).blockmaps,
    ...releaseFiles(version).metadata,
    "SHA256SUMS.txt",
  ];
  const assets = await Promise.all(
    files.map(async (name) => {
      const digest = await digestFile(join(dir, name));
      return {
        name,
        size: digest.size,
        digest: `sha256:${remoteDigestCorrect ? digest.sha256 : "0".repeat(64)}`,
        state: "uploaded",
      };
    }),
  );
  const calls: string[][] = [];
  const releaseId = 12345;
  let created = false;
  const gh: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === "release" && args[1] === "create") created = true;
    if (args[0] === "release" && args[1] === "view")
      return created
        ? { status: 0, stdout: JSON.stringify({ databaseId: releaseId }), stderr: "" }
        : { status: 1, stdout: "", stderr: "release not found\n" };
    if (args[0] === "api" && args[1] === `repos/bosshanz/tuantuan/releases/${releaseId}`)
      return { status: 0, stdout: JSON.stringify({ id: releaseId, draft: true, tag_name: tag, assets }), stderr: "" };
    if (args[0] === "api" && args[1] === "repos/bosshanz/tuantuan/releases/latest")
      return latestTag === null
        ? { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }
        : { status: 0, stdout: JSON.stringify({ tag_name: latestTag }), stderr: "" };
    if (args[0] === "api" && args[1]?.includes("releases/tags"))
      throw new Error("draft releases must be read by ID, not the published-tag endpoint");
    return { status: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
}

describe("desktop release", () => {
  test("installers embed a feed without upload credentials, with explicit opt-out", () => {
    const config = (feed?: string) => {
      const env = { ...process.env, TUANTUAN_PUBLISH: "", GH_TOKEN: "", TUANTUAN_UPDATE_FEED: feed ?? "" };
      const result = spawnSync(
        process.execPath,
        ["-e", 'console.log(JSON.stringify(require("./desktop/electron-builder.config.cjs")))'],
        { cwd: join(import.meta.dir, ".."), env, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    expect(config().publish).toEqual([{ provider: "github", owner: "bosshanz", repo: "tuantuan" }]);
    expect(config("none").publish).toBeNull();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
    expect(config().appImage.artifactName).toBe("Tuantuan-${version}-linux-x64.${ext}");
  });

  test("merges both macOS architectures, preserves references, and creates a complete checksummed set", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    const ready = await validateRelease(f.output, version);
    expect(ready.metadata.get("latest-mac.yml")?.files).toHaveLength(4);
    expect(ready.metadata.get("latest-mac.yml")?.path).toEndWith(".zip");
    const manifest = readFileSync(join(f.output, "SHA256SUMS.txt"), "utf8");
    expect(manifest.trim().split("\n")).toHaveLength(14);
    expect(manifest).not.toContain("latest-mac-arm64.yml");
  });

  test("blocks missing architectures, bad hashes, foreign references, stale versions and blockmaps", async () => {
    const cases = [
      (f: ReturnType<typeof fixture>) => rmSync(join(f.dir, required(f.expected.mac[0]))),
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, f.expected.windows), "corrupted"),
      (f: ReturnType<typeof fixture>) =>
        f.edit("latest.yml", (info) => {
          required(info.files[0]).url = "missing.exe";
        }),
      (f: ReturnType<typeof fixture>) =>
        f.edit("latest-mac-arm64.yml", (info) => {
          info.version = "0.1.0";
        }),
      (f: ReturnType<typeof fixture>) =>
        f.edit("latest-mac-arm64.yml", (info) => {
          info.files = info.files.slice(1);
        }),
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, required(f.expected.blockmaps[0])), "bad blockmap"),
      (f: ReturnType<typeof fixture>) =>
        f.edit("latest-linux.yml", (info) => {
          required(info.files[0]).blockMapSize = 9999;
        }),
    ];
    for (const corrupt of cases) {
      const f = fixture();
      corrupt(f);
      await expect(prepareRelease(f.dir, f.output, version)).rejects.toThrow();
      const calls: string[][] = [];
      await expect(
        publishRelease(f.dir, tag, version, "bosshanz/tuantuan", (args) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        }),
      ).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  test("requires tag/package version equality before any publishing operation", async () => {
    expect(() => releaseVersion("v0.2.0", version)).toThrow("must match");
    expect(() => releaseVersion("v0.2.1-beta.1", "0.2.1-beta.1")).toThrow("stable");
    const calls: string[][] = [];
    await expect(
      publishRelease("does-not-exist", "v9.0.0", version, "bosshanz/tuantuan", (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      }),
    ).rejects.toThrow("must match");
    expect(calls).toHaveLength(0);
  });

  test("rejects blockmaps with foreign file names, offsets or malformed block checksums", async () => {
    const changes = [
      (file: { name: string; offset: number; checksums: string[] }) => {
        file.name = "foreign";
      },
      (file: { name: string; offset: number; checksums: string[] }) => {
        file.offset = 12345;
      },
      (file: { name: string; offset: number; checksums: string[] }) => {
        file.checksums[0] = "invalid-checksum";
      },
      (file: { name: string; offset: number; checksums: string[] }) => {
        file.checksums[0] = "!".repeat(24);
      },
      (file: { name: string; offset: number; checksums: string[] }) => {
        file.checksums[0] = Buffer.alloc(19).toString("base64");
      },
    ];
    for (const change of changes) {
      const f = fixture();
      const path = join(f.dir, required(f.expected.blockmaps[0]));
      const map = JSON.parse(gunzipSync(readFileSync(path)).toString()) as {
        files: { name: string; offset: number; checksums: string[] }[];
      };
      change(required(map.files[0]));
      writeFileSync(path, gzipSync(JSON.stringify(map)));
      await expect(prepareRelease(f.dir, f.output, version)).rejects.toThrow("invalid blockmap");
    }
  });

  test("publishes only after remote assets match every local digest", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    const api = await fakeGithub(f.output);
    await publishRelease(f.output, tag, version, "bosshanz/tuantuan", api.gh);
    expect(api.calls.at(-1)).toEqual([
      "release",
      "edit",
      tag,
      "--repo",
      "bosshanz/tuantuan",
      "--draft=false",
      "--latest",
    ]);
    expect(api.calls.find((args) => args[1] === "create")).toContain("--draft");
    expect(api.calls.filter((args) => args[1] === "view")).toEqual([
      ["release", "view", tag, "--repo", "bosshanz/tuantuan", "--json", "databaseId"],
      ["release", "view", tag, "--repo", "bosshanz/tuantuan", "--json", "databaseId"],
    ]);
    expect(api.calls).toContainEqual(["api", "repos/bosshanz/tuantuan/releases/12345"]);
    const bad = await fakeGithub(f.output, false);
    await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", bad.gh)).rejects.toThrow(
      "stays unpublished",
    );
    expect(bad.calls.some((args) => args[1] === "edit")).toBe(false);
  });

  test("an older build finishing after a newer release cannot move latest backward", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    const api = await fakeGithub(f.output, true, "v0.3.0");
    await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", api.gh)).rejects.toThrow(
      "refusing to replace latest v0.3.0 with older v0.2.1",
    );
    expect(api.calls.some((args) => args[1] === "create")).toBe(true);
    expect(api.calls.at(-1)).toEqual(["api", "repos/bosshanz/tuantuan/releases/latest"]);
    expect(api.calls.some((args) => args[1] === "edit")).toBe(false);
  });

  test("only an absent latest release permits first publication; lookup failures keep the draft private", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    const first = await fakeGithub(f.output, true, null);
    await publishRelease(f.output, tag, version, "bosshanz/tuantuan", first.gh);
    expect(first.calls.at(-1)?.[1]).toBe("edit");
    for (const stderr of [
      "HTTP 401: Bad credentials",
      "error connecting to api.github.com",
      "HTTP 404: repository unavailable",
    ]) {
      const api = await fakeGithub(f.output);
      const gh: GhRunner = (args) => {
        if (args[0] === "api" && args[1] === "repos/bosshanz/tuantuan/releases/latest") {
          api.calls.push(args);
          return { status: 1, stdout: "", stderr };
        }
        return api.gh(args);
      };
      await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", gh)).rejects.toThrow(
        "cannot check current latest release",
      );
      expect(api.calls.some((args) => args[1] === "edit")).toBe(false);
    }
  });

  test("release lookup failures never authorize draft creation", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    for (const stderr of [
      "HTTP 404: repository not found",
      "release not found: authentication required",
      "HTTP 401: Bad credentials",
      "error connecting to api.github.com",
    ]) {
      const calls: string[][] = [];
      await expect(
        publishRelease(f.output, tag, version, "bosshanz/tuantuan", (args) => {
          calls.push(args);
          return { status: 1, stdout: "", stderr };
        }),
      ).rejects.toThrow("cannot look up release");
      expect(calls).toHaveLength(1);
    }
  });

  test("a missing or invalid created release ID never publishes the draft", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    for (const id of [undefined, null, "12345", -1, 0, 1.5]) {
      const api = await fakeGithub(f.output);
      let views = 0;
      const gh: GhRunner = (args) => {
        if (args[0] === "release" && args[1] === "view" && ++views === 2) {
          api.calls.push(args);
          return id === undefined
            ? { status: 1, stdout: "", stderr: "release not found" }
            : { status: 0, stdout: JSON.stringify({ databaseId: id }), stderr: "" };
        }
        return api.gh(args);
      };
      await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", gh)).rejects.toThrow();
      expect(api.calls.some((args) => args[1] === "create")).toBe(true);
      expect(api.calls.some((args) => args[1] === "edit")).toBe(false);
    }
  });

  test("existing releases and changed checksum manifests never overwrite/publish", async () => {
    const f = fixture();
    await prepareRelease(f.dir, f.output, version);
    const calls: string[][] = [];
    const existing: GhRunner = (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify({ databaseId: 12345 }), stderr: "" };
    };
    await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", existing)).rejects.toThrow(
      "already exists",
    );
    expect(calls).toHaveLength(1);
    calls.length = 0;
    writeFileSync(
      join(f.output, "SHA256SUMS.txt"),
      readFileSync(join(f.output, "SHA256SUMS.txt"), "utf8").replace(/^[a-f0-9]{64}/, "0".repeat(64)),
    );
    await expect(publishRelease(f.output, tag, version, "bosshanz/tuantuan", existing)).rejects.toThrow("mismatch");
    expect(calls).toHaveLength(0);
  });
});

function brewFixture() {
  const f = fixture();
  const tap = join(f.root, "tap");
  mkdirSync(join(tap, "Casks"), { recursive: true });
  const source = `cask "tuantuan" do\n  arch arm: "arm64", intel: "x64"\n  version "0.2.0"\n  sha256 arm:   "${"a".repeat(64)}",\n         intel: "${"b".repeat(64)}"\n  url "https://github.com/bosshanz/tuantuan/releases/download/v#{version}/Tuantuan-#{version}-mac-#{arch}.dmg"\n  app "tuantuan.app"\nend\n`;
  const cask = join(tap, "Casks", "tuantuan.rb");
  writeFileSync(cask, source);
  const names = f.expected.mac.filter((name) => name.endsWith(".dmg"));
  writeFileSync(
    join(f.dir, "SHA256SUMS.txt"),
    names.map((name) => `${sha256(readFileSync(join(f.dir, name)))}  ${name}\n`).join(""),
  );
  const release: PublishedRelease = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [...names, "SHA256SUMS.txt"].map((name) => ({
      name,
      browser_download_url: `https://github.com/bosshanz/tuantuan/releases/download/${tag}/${name}`,
      digest: `sha256:${sha256(readFileSync(join(f.dir, name)))}`,
    })),
  };
  return { ...f, tap, source, cask, release };
}

describe("Homebrew release synchronization", () => {
  test("the manual CLI supports an entirely offline release fixture", () => {
    const f = brewFixture();
    const json = join(f.root, "release.json");
    writeFileSync(json, JSON.stringify(f.release));
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "..", "desktop", "scripts", "sync-homebrew.ts"),
        "--tag",
        tag,
        "--tap",
        f.tap,
        "--release-json",
        json,
        "--assets",
        f.dir,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`updated ${f.tap}/Casks/tuantuan.rb to ${version}`);
  });

  test("uses published dual-architecture bytes and checksums, preserves the cask body and is idempotent", async () => {
    const f = brewFixture();
    const options = { tag, tap: f.tap, release: f.release, assetsDir: f.dir };
    expect((await syncHomebrew(options)).changed).toBe(true);
    const cask = readFileSync(f.cask, "utf8");
    expect(cask).toContain(`version "${version}"`);
    for (const arch of ["arm64", "x64"])
      expect(cask).toContain(sha256(readFileSync(join(f.dir, `Tuantuan-${version}-mac-${arch}.dmg`))));
    expect(cask).toContain('app "tuantuan.app"');
    expect((await syncHomebrew(options)).changed).toBe(false);
  });

  test("rejects drafts, missing architectures, URL/digest mismatch and version conflicts without changing cask", async () => {
    const cases = [
      (f: ReturnType<typeof brewFixture>) => {
        f.release.draft = true;
      },
      (f: ReturnType<typeof brewFixture>) => {
        f.release.assets.shift();
      },
      (f: ReturnType<typeof brewFixture>) => {
        required(f.release.assets[0]).browser_download_url += ".other";
      },
      (f: ReturnType<typeof brewFixture>) => {
        required(f.release.assets[0]).digest = `sha256:${"0".repeat(64)}`;
      },
      (f: ReturnType<typeof brewFixture>) => {
        writeFileSync(join(f.dir, "SHA256SUMS.txt"), `${"0".repeat(64)}  wrong.dmg\n`);
        required(f.release.assets.find((asset) => asset.name === "SHA256SUMS.txt")).digest = undefined;
      },
      (f: ReturnType<typeof brewFixture>) => {
        f.release.tag_name = "v9.0.0";
      },
      (f: ReturnType<typeof brewFixture>) => {
        writeFileSync(f.cask, f.source.replace('version "0.2.0"', `version "${version}"`));
      },
      (f: ReturnType<typeof brewFixture>) => {
        writeFileSync(f.cask, f.source.replace('version "0.2.0"', 'version "9.0.0"'));
      },
    ];
    for (const corrupt of cases) {
      const f = brewFixture();
      corrupt(f);
      const before = readFileSync(f.cask, "utf8");
      await expect(syncHomebrew({ tag, tap: f.tap, release: f.release, assetsDir: f.dir })).rejects.toThrow();
      expect(readFileSync(f.cask, "utf8")).toBe(before);
    }
  });
});
