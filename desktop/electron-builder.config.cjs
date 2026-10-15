/**
 * electron-builder config for 团团 / Tuantuan.
 * Signing / notarization only when the env provides it:
 *   macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID), APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *          (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER) to notarize.
 *   Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD.
 * Auto-update: set TUANTUAN_PUBLISH=github (and GH_TOKEN) to embed the GitHub releases feed;
 * without it no app-update.yml is written and the app never checks for updates.
 */
const env = process.env;
const notarize = !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || !!env.APPLE_API_KEY;
const publish =
  env.TUANTUAN_PUBLISH === "github"
    ? [{ provider: "github", owner: env.TUANTUAN_GH_OWNER || "bosshanz", repo: env.TUANTUAN_GH_REPO || "tuantuan" }]
    : null;

module.exports = {
  appId: "app.tuantuan.desktop",
  productName: "团团",
  executableName: "tuantuan",
  copyright: "Copyright © Tuantuan",
  directories: { output: "release", buildResources: "build" },
  artifactName: "Tuantuan-${version}-${os}-${arch}.${ext}",
  files: ["dist/**", "package.json"],
  // The Bun server is not asar-able: it ships as plain files next to app.asar.
  extraResources: [
    { from: "build/stage/server", to: "server", filter: ["**/*"] },
    { from: "build/stage/bin", to: "bin", filter: ["**/*"] },
    { from: "build/icon.png", to: "icon.png" },
  ],
  asar: true,
  asarUnpack: ["dist/preload.cjs"],
  afterPack: "./scripts/after-pack.cjs",
  publish,
  mac: {
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    // Arch comes from the CLI (scripts/dist.ts builds arm64 and x64 separately, each with its own Bun).
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize,
    identity: env.CSC_LINK || env.CSC_NAME ? undefined : null,
  },
  dmg: { title: "团团 ${version}" },
  win: { icon: "build/icon.ico", target: ["nsis"] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, shortcutName: "团团" },
  linux: {
    icon: "build/icon.png",
    category: "Development",
    target: ["AppImage"],
    synopsis: "多 Agent 群聊工作台",
  },
};
