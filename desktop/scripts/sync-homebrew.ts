/** Synchronize an already-published release into a local tap checkout; never commits or pushes.
 * bun desktop/scripts/sync-homebrew.ts --tag vX.Y.Z --tap /path/to/homebrew-tap
 * Offline: add --release-json fixture/release.json --assets fixture/assets
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestFile, parseChecksums, releaseVersion } from "./release";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}
export interface PublishedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export function updateCask(source: string, version: string, arm: string, intel: string): string {
  const current = /^ {2}version "(\d+\.\d+\.\d+)"$/m.exec(source)?.[1];
  if (!current) throw new Error("unsupported cask version format");
  const previousParts = current.split(".").map(Number);
  const nextParts = version.split(".").map(Number);
  const difference = nextParts.map((part, index) => part - (previousParts[index] ?? 0)).find((part) => part !== 0);
  if (difference !== undefined && difference < 0)
    throw new Error(`refusing Homebrew downgrade ${current} → ${version}`);
  if (
    !source.includes('arch arm: "arm64", intel: "x64"') ||
    !source.includes(
      'url "https://github.com/bosshanz/tuantuan/releases/download/v#{version}/Tuantuan-#{version}-mac-#{arch}.dmg"',
    )
  )
    throw new Error("cask architecture/download URL differs from the release contract");
  const hashes = /sha256 arm:\s+"([a-f0-9]{64})",\s*intel:\s+"([a-f0-9]{64})"/;
  const old = hashes.exec(source);
  if (!old) throw new Error("unsupported cask architecture hashes");
  if (current === version && (old[1] !== arm || old[2] !== intel))
    throw new Error(`cask ${version} already has different digests; published versions are immutable`);
  return source
    .replace(/^ {2}version "[^"]+"$/m, `  version "${version}"`)
    .replace(hashes, `sha256 arm:   "${arm}",\n         intel: "${intel}"`);
}

export async function syncHomebrew(options: {
  tag: string;
  tap: string;
  release: PublishedRelease;
  assetsDir?: string;
}) {
  const { tag, release } = options;
  const version = releaseVersion(tag, tag.slice(1));
  if (release.tag_name !== tag || release.draft || release.prerelease)
    throw new Error("Homebrew requires the matching published stable release");
  const cask = join(options.tap, "Casks", "tuantuan.rb");
  const source = readFileSync(cask, "utf8");
  const asset = (name: string) => {
    const matches = release.assets.filter((item) => item.name === name);
    const match = matches[0];
    const expected = `https://github.com/bosshanz/tuantuan/releases/download/${tag}/${name}`;
    if (matches.length !== 1 || match?.browser_download_url !== expected)
      throw new Error(`missing/duplicate/mismatched release download: ${name}`);
    return match;
  };
  const scratch = options.assetsDir ? undefined : mkdtempSync(join(tmpdir(), "tt-homebrew-"));
  const load = async (name: string) => {
    const info = asset(name);
    const path = join(options.assetsDir ?? scratch ?? "", name);
    if (!options.assetsDir) {
      const response = await fetch(info.browser_download_url);
      if (!response.ok) throw new Error(`download failed: ${response.status} ${info.browser_download_url}`);
      await Bun.write(path, response);
    }
    const digest = (await digestFile(path)).sha256;
    if (info.digest && info.digest !== `sha256:${digest}`) throw new Error(`GitHub digest mismatch: ${name}`);
    return { path, digest };
  };
  try {
    const checksums = parseChecksums(readFileSync((await load("SHA256SUMS.txt")).path, "utf8"));
    const hashes: string[] = [];
    for (const arch of ["arm64", "x64"]) {
      const name = `Tuantuan-${version}-mac-${arch}.dmg`;
      const { digest } = await load(name);
      if (checksums.get(name) !== digest) throw new Error(`SHA256SUMS mismatch: ${name}`);
      hashes.push(digest);
    }
    const [arm, intel] = hashes;
    if (!arm || !intel) throw new Error("missing Homebrew architecture hashes");
    const updated = updateCask(source, version, arm, intel);
    if (updated !== source) writeFileSync(cask, updated);
    return { version, changed: updated !== source };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const arg = (name: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const tag = arg("tag") ?? "";
  releaseVersion(tag, tag.slice(1));
  const tap = resolve(arg("tap") ?? "homebrew-tap");
  if (!existsSync(join(tap, "Casks", "tuantuan.rb"))) throw new Error(`tap checkout missing: ${tap}`);
  const fixture = arg("release-json");
  let release: PublishedRelease;
  if (fixture) release = JSON.parse(readFileSync(fixture, "utf8"));
  else {
    const response = await fetch(`https://api.github.com/repos/bosshanz/tuantuan/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`release lookup failed: HTTP ${response.status}`);
    release = (await response.json()) as PublishedRelease;
  }
  const result = await syncHomebrew({ tag, tap, release, assetsDir: arg("assets") });
  // Keep commit identity and credentials in the caller's repository/workflow, never global Git configuration.
  console.log(
    result.changed
      ? `updated ${tap}/Casks/tuantuan.rb to ${result.version}; review and commit the diff`
      : `Homebrew already matches ${tag}`,
  );
}
