# Homebrew tap（提案）

`Casks/tuantuan.rb` 是给个人 tap 准备的 cask 草稿，尚未发布。启用步骤（维护者操作）：

1. 新建公开仓库 `bosshanz/homebrew-tap`，把 `Casks/tuantuan.rb` 放进去。
2. 用户安装：`brew install --cask bosshanz/tap/tuantuan`。
3. 每次发版更新 `version` 和两个 `sha256`（取自 Release 的 `SHA256SUMS.txt`）。

团团没有 Developer ID 和公证，cask 的 `postflight` 会对 `/Applications/tuantuan.app` 执行 `xattr -dr com.apple.quarantine`，安装后可直接打开，不再出现 Gatekeeper 拦截。官方 homebrew/cask 仓库不接受这种做法，所以只适合个人 tap。`brew install --no-quarantine` 也能达到同样效果，但该参数在新版 Homebrew 中可能已弃用，不建议依赖。
