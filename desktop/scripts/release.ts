/** Build and verify a complete release before exposing its update feed.
 * bun desktop/scripts/release.ts prepare --tag vX.Y.Z --dir desktop/release --output desktop/release-ready
 * bun desktop/scripts/release.ts publish --tag vX.Y.Z --dir desktop/release-ready --repo bosshanz/tuantuan
 * prepare is offline; publish requires gh and GH_TOKEN. Failed uploads remain drafts for inspection.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

export interface UpdateFile {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
}
export interface UpdateMetadata {
  version: string;
  files: UpdateFile[];
  path: string;
  sha512: string;
  releaseDate?: string;
}
export interface FileDigest {
  size: number;
  sha256: string;
  sha512: string;
}

export function releaseVersion(tag: string, packageVersion: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== `v${packageVersion}`)
    throw new Error(
      `release tag ${tag} must match desktop/package.json version v${packageVersion} (stable versions only)`,
    );
  return packageVersion;
}

export function readMetadata(text: string, label: string): UpdateMetadata {
  const metadata = Bun.YAML.parse(text) as UpdateMetadata | null;
  if (
    !metadata ||
    typeof metadata.version !== "string" ||
    !Array.isArray(metadata.files) ||
    !metadata.files.length ||
    typeof metadata.path !== "string" ||
    typeof metadata.sha512 !== "string"
  )
    throw new Error(`${label}: invalid update metadata`);
  for (const file of metadata.files) {
    if (!file || typeof file.url !== "string" || typeof file.sha512 !== "string")
      throw new Error(`${label}: invalid update file`);
  }
  return metadata;
}

export function mergeMacMetadata(metadata: UpdateMetadata[]): UpdateMetadata {
  const first = metadata[0];
  if (!first) throw new Error("no macOS update metadata");
  const files = new Map<string, UpdateFile>();
  for (const item of metadata) {
    if (item.version !== first.version) throw new Error("conflicting macOS metadata versions");
    for (const file of item.files) {
      const previous = files.get(file.url);
      if (previous && JSON.stringify(previous) !== JSON.stringify(file))
        throw new Error(`conflicting macOS metadata for ${file.url}`);
      files.set(file.url, file);
    }
  }
  // electron-updater selects arm64 by filename. Keep the legacy path/sha512 on a ZIP too.
  const sorted = [...files.values()].sort((a, b) => Number(b.url.endsWith(".zip")) - Number(a.url.endsWith(".zip")));
  const legacy = sorted[0];
  if (!legacy) throw new Error("no macOS update files");
  return { ...first, files: sorted, path: legacy.url, sha512: legacy.sha512 };
}

export function releaseFiles(version: string) {
  const mac = ["arm64", "x64"].flatMap((arch) => ["dmg", "zip"].map((ext) => `Tuantuan-${version}-mac-${arch}.${ext}`));
  const windows = `Tuantuan-${version}-win-x64.exe`;
  const linux = `Tuantuan-${version}-linux-x64.AppImage`;
  const blockmaps = [...mac, windows].map((name) => `${name}.blockmap`);
  return { mac, windows, linux, blockmaps, metadata: ["latest-mac.yml", "latest.yml", "latest-linux.yml"] };
}

export async function digestFile(path: string): Promise<FileDigest> {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (!size) throw new Error(`empty release file ${path}`);
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

function verifyBlockmap(compressed: Buffer, embedded: boolean, size: number, label: string) {
  const text = embedded
    ? inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
    : gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
  const map = JSON.parse(text.toString()) as {
    version: string;
    files: { name: string; offset: number; sizes: number[]; checksums: string[] }[];
  };
  if (
    map.version !== "2" ||
    map.files?.length !== 1 ||
    map.files[0]?.name !== "file" ||
    map.files[0].offset !== 0 ||
    !Array.isArray(map.files[0]?.sizes) ||
    !map.files[0].sizes.length ||
    map.files[0].sizes.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !Array.isArray(map.files[0].checksums) ||
    map.files[0].checksums?.length !== map.files[0].sizes.length ||
    map.files[0].checksums.some((value) => typeof value !== "string" || !/^[A-Za-z0-9+/]{24}$/.test(value)) ||
    map.files[0].sizes.reduce((sum, value) => sum + value, 0) !== size
  )
    throw new Error(`${label}: invalid blockmap or artifact size`);
}

/** Validates real artifact bytes; metadata alone never authorizes publication. */
export async function validateRelease(dir: string, version: string, options: { mergeMacSnapshots?: boolean } = {}) {
  const expected = releaseFiles(version);
  const names = [...expected.mac, expected.windows, expected.linux, ...expected.blockmaps];
  const digests = new Map<string, FileDigest>();
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`missing release artifact ${name}`);
    digests.set(name, await digestFile(path));
  }
  const metadata = new Map<string, UpdateMetadata>();
  const load = (name: string) => readMetadata(readFileSync(join(dir, name), "utf8"), name);
  const snapshots = ["arm64", "x64"].map((arch) => `latest-mac-${arch}.yml`);
  metadata.set(
    "latest-mac.yml",
    options.mergeMacSnapshots && snapshots.some((name) => existsSync(join(dir, name)))
      ? mergeMacMetadata(snapshots.map(load))
      : load("latest-mac.yml"),
  );
  metadata.set("latest.yml", load("latest.yml"));
  metadata.set("latest-linux.yml", load("latest-linux.yml"));
  for (const [name, info] of metadata) {
    if (info.version !== version) throw new Error(`${name}: version ${info.version} does not match ${version}`);
    const allowed =
      name === "latest-mac.yml" ? expected.mac : [name === "latest.yml" ? expected.windows : expected.linux];
    const references = new Set<string>();
    for (const file of info.files) {
      if (basename(file.url) !== file.url || !allowed.includes(file.url))
        throw new Error(`${name}: unexpected artifact reference ${file.url}`);
      if (references.has(file.url)) throw new Error(`${name}: duplicate artifact ${file.url}`);
      references.add(file.url);
      const digest = digests.get(file.url);
      if (!digest || digest.sha512 !== file.sha512 || (file.size !== undefined && file.size !== digest.size))
        throw new Error(`${name}: digest/size mismatch for ${file.url}`);
    }
    if (allowed.some((file) => !references.has(file)))
      throw new Error(`${name}: missing architecture/artifact reference`);
    const legacy = info.files.find((file) => file.url === info.path);
    if (!legacy || legacy.sha512 !== info.sha512 || (name === "latest-mac.yml" && !legacy.url.endsWith(".zip")))
      throw new Error(`${name}: invalid legacy path/sha512`);
  }
  for (const name of expected.blockmaps) {
    const artifact = digests.get(name.slice(0, -".blockmap".length));
    if (!artifact) throw new Error(`missing blockmap artifact ${name}`);
    verifyBlockmap(readFileSync(join(dir, name)), false, artifact.size, name);
  }
  const image = digests.get(expected.linux);
  const blockMapSize = metadata.get("latest-linux.yml")?.files[0]?.blockMapSize;
  if (
    !image ||
    !Number.isSafeInteger(blockMapSize) ||
    !blockMapSize ||
    blockMapSize < 1 ||
    blockMapSize > 64 * 1024 * 1024 ||
    image.size <= blockMapSize + 4
  )
    throw new Error("latest-linux.yml: missing/invalid embedded blockmap size");
  const fd = openSync(join(dir, expected.linux), "r");
  try {
    const tail = Buffer.alloc(blockMapSize + 4);
    if (
      readSync(fd, tail, 0, tail.length, image.size - tail.length) !== tail.length ||
      tail.readUInt32BE(blockMapSize) !== blockMapSize
    )
      throw new Error("AppImage embedded blockmap size mismatch");
    verifyBlockmap(tail.subarray(0, blockMapSize), true, image.size - tail.length, expected.linux);
  } finally {
    closeSync(fd);
  }
  return { names, digests, metadata };
}

export async function prepareRelease(dir: string, output: string, version: string) {
  const validated = await validateRelease(dir, version, { mergeMacSnapshots: true });
  if (existsSync(output)) throw new Error(`output already exists: ${output}; use a fresh directory`);
  mkdirSync(output, { recursive: true });
  for (const name of validated.names) copyFileSync(join(dir, name), join(output, name));
  for (const [name, info] of validated.metadata) writeFileSync(join(output, name), Bun.YAML.stringify(info, null, 2));
  const files = [...validated.names, ...validated.metadata.keys()].sort();
  const sums = [];
  for (const name of files) sums.push(`${(await digestFile(join(output, name))).sha256}  ${name}`);
  writeFileSync(join(output, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
  return files;
}

export function parseChecksums(text: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/.exec(line);
    if (!match?.[1] || !match[2] || hashes.has(match[2])) throw new Error("invalid/duplicate SHA256SUMS entry");
    hashes.set(match[2], match[1]);
  }
  return hashes;
}

export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };
export const runGh: GhRunner = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
};

export async function publishRelease(dir: string, tag: string, version: string, repo: string, gh = runGh) {
  releaseVersion(tag, version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("invalid GitHub repository");
  const validated = await validateRelease(dir, version);
  const names = [...validated.names, ...validated.metadata.keys(), "SHA256SUMS.txt"].sort();
  const sums = parseChecksums(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8"));
  if (sums.size !== names.length - 1) throw new Error("SHA256SUMS must cover exactly the release files");
  const digests = new Map<string, FileDigest>();
  for (const name of names) {
    const digest = await digestFile(join(dir, name));
    if (name !== "SHA256SUMS.txt" && sums.get(name) !== digest.sha256) throw new Error(`SHA256SUMS mismatch: ${name}`);
    digests.set(name, digest);
  }
  const command = (args: string[]) => {
    const result = gh(args);
    if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
  };
  const findReleaseId = () => {
    // gh resolves both published tags and pending draft tags; REST tag lookup only promises published releases.
    const result = gh(["release", "view", tag, "--repo", repo, "--json", "databaseId"]);
    if (result.status !== 0) {
      if (result.status === 1 && result.stderr.trim() === "release not found") return undefined;
      throw new Error(`cannot look up release ${tag}: ${result.stderr}`);
    }
    const id = (JSON.parse(result.stdout) as { databaseId?: unknown }).databaseId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw new Error(`invalid GitHub release ID for ${tag}`);
    return id;
  };
  // A pre-existing draft can contain unrelated/stale files too. Never overwrite any existing tag release.
  if (findReleaseId() !== undefined) throw new Error(`release ${tag} already exists; inspect it before retrying`);
  command(["api", `repos/${repo}/git/ref/tags/${tag}`]);
  command([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--verify-tag",
    "--draft",
    "--title",
    tag,
    "--generate-notes",
    ...names.map((name) => join(dir, name)),
  ]);
  const id = findReleaseId();
  if (id === undefined) throw new Error("created draft release cannot be found; release stays unpublished");
  const remote = JSON.parse(command(["api", `repos/${repo}/releases/${id}`])) as {
    id: number;
    draft: boolean;
    tag_name: string;
    assets: { name: string; size: number; digest: string; state: string }[];
  };
  if (remote.id !== id || !remote.draft || remote.tag_name !== tag || remote.assets.length !== names.length)
    throw new Error("draft release assets/tag differ; release stays unpublished");
  for (const name of names) {
    const assets = remote.assets.filter((asset) => asset.name === name);
    const local = digests.get(name);
    if (
      assets.length !== 1 ||
      !local ||
      assets[0]?.size !== local.size ||
      assets[0]?.digest !== `sha256:${local.sha256}` ||
      assets[0]?.state !== "uploaded"
    )
      throw new Error(`remote asset verification failed for ${name}; release stays unpublished`);
  }
  const latest = gh(["api", `repos/${repo}/releases/latest`]);
  if (latest.status === 0) {
    const latestTag = (JSON.parse(latest.stdout) as { tag_name?: unknown }).tag_name;
    const parts = typeof latestTag === "string" ? /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(latestTag) : null;
    const latestParts = parts?.slice(1).map(Number);
    if (!latestParts || latestParts.some((part) => !Number.isSafeInteger(part)))
      throw new Error("current latest release has an invalid stable version; release stays unpublished");
    const currentParts = version.split(".").map(Number);
    const difference = currentParts.map((part, index) => part - (latestParts[index] ?? 0)).find((part) => part !== 0);
    if (difference !== undefined && difference < 0)
      throw new Error(`refusing to replace latest ${latestTag} with older ${tag}; release stays unpublished`);
  } else if (latest.status !== 1 || latest.stderr.trim() !== "gh: Not Found (HTTP 404)") {
    throw new Error(`cannot check current latest release: ${latest.stderr}; release stays unpublished`);
  }
  command(["release", "edit", tag, "--repo", repo, "--draft=false", "--latest"]);
}

if (import.meta.main) {
  const arg = (name: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const tag = arg("tag") ?? "";
  const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
  const version = releaseVersion(tag, packageVersion);
  const dir = resolve(arg("dir") ?? "desktop/release");
  if (process.argv[2] === "prepare") {
    const output = resolve(arg("output") ?? "desktop/release-ready");
    await prepareRelease(dir, output, version);
    console.log(`validated ${tag}: ${output}`);
  } else if (process.argv[2] === "publish") {
    await publishRelease(dir, tag, version, arg("repo") ?? "bosshanz/tuantuan");
    console.log(`published ${tag}; now run sync-homebrew.ts for the published release`);
  } else
    throw new Error("usage: release.ts prepare|publish --tag vX.Y.Z [--dir path] [--output path] [--repo owner/repo]");
}
