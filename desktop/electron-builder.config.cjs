/**
 * electron-builder config for 团团 / Tuantuan.
 * Signing / notarization only when the env provides it:
 *   macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID), APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *          (or APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER) to notarize.
 *   Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD.
 * Installers embed the GitHub releases feed, even when built with --publish never.
 * TUANTUAN_UPDATE_FEED=none explicitly disables it. Uploads belong to scripts/release.ts.
 */
const env = process.env;
const notarize = !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || !!env.APPLE_API_KEY;
// Without a Developer ID the bundle is ad-hoc signed. The hardened runtime only matters for notarization;
// combined with an ad-hoc identity it adds library-validation / JIT restrictions to the app, its helpers,
// the bundled Bun and everything Bun loads, with no security benefit, so it stays off in that case.
const adhoc = !(env.CSC_LINK || env.CSC_NAME);
const publish =
  env.TUANTUAN_UPDATE_FEED !== "none"
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
    hardenedRuntime: !adhoc,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize,
    // Notification Center: banners by default; CFBundleIdentifier comes from appId above.
    extendInfo: { NSUserNotificationAlertStyle: "banner" },
    // No Developer ID: ad-hoc sign the whole bundle ("-") instead of leaving it unsigned. An unsigned
    // (or partially signed) app gets no entry in System Settings › Notifications and macOS drops its
    // notifications silently; ad-hoc keeps the bundle id app.tuantuan.desktop valid for Notification Center.
    identity: adhoc ? "-" : undefined,
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
  // electron-builder maps ${arch} to x86_64 for AppImage; keep the existing download URL contract.
  // dist.ts supports Linux x64, so the filename and update metadata both use the same literal name.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
  appImage: { artifactName: "Tuantuan-${version}-linux-x64.${ext}" },
};
