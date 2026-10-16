# 安装与运行

从源码运行（浏览器 + 本机服务）和构建桌面版。

## 快速开始

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

**暂未发布安装包，请从源码构建**（步骤见下方「打包」：`bun install && bun run desktop:install && bun run desktop:build`，产物在 `desktop/release/`，macOS `.dmg`、Windows `.exe`、Linux `.AppImage`）。装好后打开即用：不用装 Bun，也不用开终端。数据在系统的应用数据目录（macOS `~/Library/Application Support/团团`，菜单「帮助 → 打开数据文件夹」），会话文件夹默认在 `~/Tuantuan`。Claude Code 和 Codex 默认不打进安装包（AppImage 约 157 MB），第一次用时在「Harness」页一键从 ACP Registry 下载；打包时设 `TUANTUAN_BUNDLE_ADAPTERS=1` 可改回内置（约 +300 MB）。你自己装的 Harness 和 CC Switch 设置的环境变量会从登录 shell 读到。

![桌面版（Linux，Xvfb 截图）](screenshots/desktop-linux.png)

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

macOS 本机打 dmg：在 Mac 上执行上面前三行即可，得到 `desktop/release/Tuantuan-<版本>-mac-arm64.dmg`。没有证书时包是未签名的，第一次打开需要右键「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/团团.app`。要签名公证，打包前设置 `CSC_LINK`、`CSC_KEY_PASSWORD`（Developer ID 证书）和 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows 用 `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。自动更新默认关闭，打包时设 `TUANTUAN_PUBLISH=github` 和 `GH_TOKEN` 才会写入 GitHub Releases 更新源。GitHub Actions 的 Desktop 工作流（打 `v*` 标签或手动触发）会打出三个平台的包作为构建产物，不发布。

---

[← 返回 README](../README.md) · [文档索引](README.md)
