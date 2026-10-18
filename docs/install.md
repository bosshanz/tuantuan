# 安装与运行

下载桌面安装包，或从源码运行（浏览器 + 本机服务）和构建桌面版。

## 下载桌面版 v0.2.0

前往 [GitHub Releases v0.2.0](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.0)，按操作系统和芯片选择安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS · Apple 芯片（arm64） | `Tuantuan-0.2.0-mac-arm64.dmg` |
| macOS · Intel（x64） | `Tuantuan-0.2.0-mac-x64.dmg` |
| Windows · x64 | `Tuantuan-0.2.0-win-x64.exe` |
| Linux · x64 | `Tuantuan-0.2.0-linux-x64.AppImage` |

macOS 也提供对应架构的 `.zip` 包。桌面版已包含运行时，无需安装 Bun。v0.2.0 的 macOS 包使用 ad-hoc 签名，未经 Apple 公证；Windows 安装包未代码签名，因此系统可能显示开发者或发布者验证提示。自动更新默认关闭，后续版本请从 Release 页面下载。

- **macOS（Homebrew，推荐）**：`brew install --cask bosshanz/tap/tuantuan`。[这个 tap](https://github.com/bosshanz/homebrew-tap) 安装后会自动清除隔离标记，打开时不会被 Gatekeeper 拦截，升级用 `brew upgrade --cask tuantuan`。
- **macOS**：打开 `.dmg`，把 **tuantuan.app** 拖进「应用程序」后启动（用 `.zip` 时在访达里双击解压，再移到「应用程序」）。不要直接在磁盘映像里运行。因为没有 Developer ID 和公证，第一次打开会被拦截：
  1. 提示无法验证时点「完成」（不要点「移到废纸篓」）。
  2. 打开「系统设置 → 隐私与安全性」，滚动到「安全性」，在「已阻止“tuantuan”」旁点「仍要打开」，输入密码后点「打开」（参见 [Apple 的说明](https://support.apple.com/en-us/102445)）。macOS 14 及更早版本也可以按住 Control 点按 App →「打开」。macOS 15 起这个右键方式不再绕过拦截，只能用「仍要打开」。
  3. 提示「已损坏，无法打开」或仍然打不开时，在「终端」执行 `xattr -dr com.apple.quarantine /Applications/tuantuan.app` 后再打开。
  4. 窗口提示服务无法启动时，日志在 `~/Library/Application Support/团团/logs/server.log`；数据在同一目录。图形界面启动的 App 拿不到终端的 PATH，团团会从登录 shell 读取并补上 Homebrew、`~/.local/bin`、`~/.bun/bin` 等常见目录；仍找不到 Harness 时，在「Harness」页填绝对路径。
  5. 桌面版默认不内置 Claude Code / Codex 适配器，第一次使用时在「Harness」页从 ACP Registry 一键安装。
- **Windows**：运行 `.exe`，按安装向导完成安装。
- **Linux**：给 `.AppImage` 添加可执行权限后运行：

  ```bash
  chmod +x Tuantuan-0.2.0-linux-x64.AppImage
  ./Tuantuan-0.2.0-linux-x64.AppImage
  ```

## 从源码运行

使用 [Bun](https://bun.sh) 1.4.2 安装依赖，与 CI 保持一致。仓库使用 v2 锁文件，Bun 1.3.14 无法读取；已有依赖环境下的历史检查结果不能代替首次安装验证。Skill 解析依赖内置的 `Bun.YAML`，验证记录见 [ACP 计划](plan-harness-acp.md)。

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun dev          # 同时启动 API（:8787）和前端（:5173）
```

开发模式下 Vite 会把 `/api`、`/mcp` 和 `/ws` 转发到 API（列表在 `server/routes.ts`）。改了 `vite.config.ts` 或这个列表后要重启 `bun dev`。

打开 http://localhost:5173 ：

1. 首次启动是一页三步的引导（随时可「跳过」，只出现一次）：选一个 Harness（没装就一键安装）→ 需要时登录（Harness 自带登录按钮，或复制终端命令，回到窗口自动重新检测）→ 给第一个 Agent 起名，创建后直接在「草稿」里打开会话。之后在左侧「Harness」（`#/harness`）管理全部 Harness。

   ![首次引导](screenshots/setup.png)

2. 「Agents → + 新建」创建 Agent：选 Harness、权限策略、身份文档、MCP 服务器和环境变量。
3. 「会话」侧栏按**项目**分组。先建项目（新建目录，或选择已有文件夹；根目录默认 `~/Tuantuan`，可用 `TUANTUAN_WORKSPACES` 改），再在项目下建会话。未选项目时进默认项目「草稿」（`~/Tuantuan/drafts`）。会话共用项目目录；2+ Agent 时可设**主 Agent**。更换项目目录会重置该项目下会话的 Harness 上下文。

生产方式：`bun run build && bun start`（API 同时托管 `web/dist`，访问 http://localhost:8787）。API 默认只监听 `127.0.0.1`；HTTP（含 MCP）与 WebSocket 升级均校验本机 Host、浏览器 Origin 和跨站请求标记，正常的本机 Vite 代理可用。原生本机客户端可省略 Origin。`TUANTUAN_HOST` 可改监听地址，但不会关闭请求检查，也不提供远程访问鉴权。

## 桌面版（Electron）

可直接使用 [v0.2.0 安装包](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.0)，也可按下方步骤自行构建。数据在系统的应用数据目录（macOS `~/Library/Application Support/团团`，菜单「帮助 → 打开数据文件夹」），会话文件夹默认在 `~/Tuantuan`。Claude Code 和 Codex 默认不打进安装包，第一次用时在「Harness」页一键从 ACP Registry 下载；打包时设 `TUANTUAN_BUNDLE_ADAPTERS=1` 可改回内置。你自己装的 Harness 和 CC Switch 设置的环境变量会从登录 shell 读到。

![桌面版（Linux，Xvfb 截图）](screenshots/desktop-linux.png)

桌面版可在「设置 → 通知 → 任务运行」开启「Agent 任务运行中阻止自动休眠」（默认关闭）。开启后，只要任一会话仍有 Agent 任务，团团会阻止系统自动休眠，屏幕仍可熄灭；所有任务结束、失败、取消或关闭开关后释放，退出团团时也会释放。切换会话、刷新页面或隐藏窗口不会中断检测。浏览器版不支持控制系统休眠。

界面是单侧栏布局：侧栏顶部是搜索和「+」，下面是会话（大头像 + 最后一条消息），再下面是「项目」分组（可折叠，当前项目自动展开）；底部是你的头像和「设置」（Agents、Harness、服务商与用量都在这里）。主区顶部是居中的悬浮标题，点击打开右侧详情（详情 / 资料库 / 成员）。macOS 上窗口没有系统标题栏，红绿灯在侧栏顶行左侧，搜索和「+」在它右边；全屏时这块空位收回。

![macOS 标题栏（浏览器模拟）](screenshots/mac-conversation.png)

自己打包：

```bash
bun install && bun run desktop:install   # 第一次：装 Electron 和打包工具
bun run desktop:dev                      # 开发：构建前端后用 Electron 打开
bun run desktop:build                    # 当前系统、当前架构的安装包 → desktop/release/
bun run desktop:build -- --arch arm64,x64   # macOS 同时出 Apple 芯片和 Intel 包
xvfb-run -a bun run desktop:smoke        # Linux：无界面端到端冒烟
```

macOS 本机构建：在 Mac 上执行上面的依赖安装和 `desktop:build` 命令，会生成当前架构的 `.dmg` 和 `.zip`；使用 `--arch arm64,x64` 可同时生成 Apple 芯片和 Intel 版本。未配置 Developer ID 证书时，构建配置使用 ad-hoc 签名；它不等同于 Developer ID 签名或 Apple 公证。要使用 Developer ID 签名并公证，打包前设置 `CSC_LINK`、`CSC_KEY_PASSWORD`（Developer ID 证书）和 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows 签名使用 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。

自动更新默认关闭，打包时设 `TUANTUAN_PUBLISH=github` 和 `GH_TOKEN` 才会写入 GitHub Releases 更新源。GitHub Actions 的 Desktop 工作流（打 `v*` 标签或手动触发）默认只上传三个平台的构建产物；安装包由维护者上传到对应的 Release。

## 发布版本时同步 Homebrew

发布 **0.2.0** 及后续版本时，GitHub Release 与 [bosshanz/homebrew-tap](https://github.com/bosshanz/homebrew-tap) 的安装版本需要一起更新：

1. 先发布正式安装包与 `SHA256SUMS.txt`，确认 macOS arm64 / x64 的 `.dmg` 均可下载。
2. 更新 tap 仓库的 `Casks/tuantuan.rb`：将 `version` 改为本次版本，并从该 Release 的 `SHA256SUMS.txt` 同步两个架构的 `sha256`；核对下载 URL 与实际标签、文件名一致。
3. 提交并合并 tap 更新，确认 `brew info --cask bosshanz/tap/tuantuan` 显示新版本，按对应架构验证下载与安装，确保现有用户能通过 `brew upgrade --cask tuantuan` 升级。

正式安装包可用后再更新 cask，避免 Homebrew 指向尚未发布的文件。安装包发布并验证后，同步更新 Homebrew tap。

---

[← 返回 README](../README.md) · [文档索引](README.md)
