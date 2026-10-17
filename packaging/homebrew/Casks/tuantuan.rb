# Proposed cask for a personal tap (github.com/bosshanz/homebrew-tap, file Casks/tuantuan.rb).
#   brew install --cask bosshanz/tap/tuantuan
# The app is ad-hoc signed and not notarized, so the postflight clears the quarantine flag that
# Homebrew sets on download; the user opts into that by installing from this tap.
# Update version and sha256 for every release (values from the release's SHA256SUMS.txt).
cask "tuantuan" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm:   "8031e797fc4e91185cd6cebd65aebf9455908255f529eec4ff91d0566d337b3f",
         intel: "12a3e5a37b04614e089bb7017c0d954679fb1231cf326a9eb98acb3bbd06763f"

  url "https://github.com/bosshanz/tuantuan/releases/download/v#{version}/Tuantuan-#{version}-mac-#{arch}.dmg"
  name "Tuantuan"
  name "团团"
  desc "Multi-agent workspace for coding agents (ACP harnesses)"
  homepage "https://github.com/bosshanz/tuantuan"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "tuantuan.app"

  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/tuantuan.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/团团",
    "~/Library/Preferences/app.tuantuan.desktop.plist",
    "~/Library/Saved Application State/app.tuantuan.desktop.savedState",
  ]
end
