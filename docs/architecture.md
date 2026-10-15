# 团团 Tuantuan 架构

## 背景与约束

- 本机使用：一个 Bun 进程 + 一个 SQLite 文件，无鉴权、无多实例。桌面版（`desktop/`）是 Electron 壳：主进程把同一个 Bun 服务端作为子进程跑在随包 Bun 上，窗口加载它的本机地址。
- 团团不调用模型。每个 Agent 绑定一个编码 Harness，通过 ACP（JSON-RPC over stdio，`@agentclientprotocol/sdk` 1.8.0）驱动；模型、Key、登录归 Harness。
- 没有任何账号也必须可测试 → `server/mock-agent.ts` 是一个确定性的 ACP agent（`TUANTUAN_MOCK_HARNESS=1` 时可选）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/main.ts` | 打开数据库，启动服务；退出时关闭所有 Harness 进程 |
| `server/app.ts` | HTTP API（参数校验）、WebSocket 订阅、静态文件 |
| `server/harness.ts` | Harness 定义（常用 6 个 + mock，及 `reg:<id>` 形式的任意 Registry Agent）：启动命令、安装与登录提示、身份文档传递方式；登录 shell 环境（PATH）解析、`which`、版本检测、绝对路径覆盖、来源判定 |
| `server/registry.ts` | 官方 ACP Registry 客户端：本地缓存 → 随包快照兜底、zod 校验（坏条目跳过）、6 小时刷新、图标缓存（只接受 SVG）；平台键；额外的实验性条目（ZCode 桥接） |
| `server/managed.ts` | 团团安装的 Harness（`<数据目录>/harnesses`）：npx 包用 Bun 或托管 Node 22（`npm install --omit=dev`）、uvx 用 uv（用户的或下载的）、二进制按平台下载 + sha256 校验 + 解压；`manifest.json` 记录版本与命令；卸载 |
| `server/harness-secrets.ts` | 按 Harness 保存的 API Key（`settings.harnessEnv`，打码给前端，只注入该 Harness 进程）；打开终端（osascript / x-terminal-emulator…）；缺 Key 错误识别在 `shared/auth.ts` |
| `server/installer.ts` | 安装任务：命令只来自定义（不接受请求里的命令）或 Registry 任务；日志流、取消、超时 |
| `server/acp.ts` | `AcpProcess`：`Bun.spawn` 一个 Harness，用 SDK 的 `ndJsonStream` 建连接、`initialize`；处理 agent 发来的 `fs/*`（限制在 cwd 内）、`terminal/*`、`session/request_permission`；保留 stderr 末尾用于报错 |
| `server/custom.ts` | BYOK「自定义 API」harness：OpenAI Chat / Responses / Anthropic Messages 的 SSE 流式与 tool call，输出 ACP `session/update`；Key 只在服务端 |
| `server/skills.ts` | Skills：解析 SKILL.md；自动发现（用户级 / 插件 / 项目）、勾选链接；导入（目录 / git / GitHub / SKILL.md 链接，先预览再选）；按 Harness 链接到会话目录的原生位置（不覆盖）；BYOK 的 `load_skill` |
| `server/providers.ts` | 服务商：预设、Key 打码、按 Harness 注入（Claude Code 用进程 env，Codex 用 ACP `providers/set` + `CODEX_CONFIG` 里的 model，BYOK 直接用）、测速、公开余额接口、只读导入 CC Switch |
| `server/usage.ts` | 用量：读 `~/.claude/projects` / `~/.codex/sessions` 的 JSONL（只读），解析 Claude Code `/usage` 与 codex `/status` 的回复 |
| `server/dirpicker.ts` | 选择文件夹：系统对话框（osascript / zenity / kdialog，可由桌面壳替换）+ 应用内浏览器的目录列表与常用位置 |
| `server/host.ts` | `HarnessHost`：按「Agent + 会话工作目录」复用进程；会话 ↔ ACP session 映射（`acp_sessions` 表，重启后 resume / load）；prompt、cancel、配置项 / 模式、会话列表与切换；权限请求挂起直到用户回答 |
| `shared/timeline.ts` | 把 `session/update` 折叠成时间线（文本、思考、工具卡片、计划、用量）；服务端持久化和前端渲染共用 |
| `server/tuantuan-mcp.ts` / `server/mcp-shim.ts` | 团团自己的 MCP 服务器：`/mcp/<token>`（JSON-RPC over HTTP POST）；token 对应「房间 + Agent」，只在内存。Harness 支持 HTTP MCP 时直接连，否则启动 stdio 中转脚本。工具由 Orchestrator 提供 |
| `server/orchestrator.ts` | 房间队列、触发（单 Agent / @ / @所有人 / 主 Agent）、单个 Agent 回合（拼 prompt + 身份文档 → host.prompt → 推送 update → 持久化时间线）、取消 |
| `server/mentions.ts` | 人类消息里的 `@名字` / `@所有人` 解析（忽略引用、代码和转述行）；Agent 回复不解析 |
| `server/store.ts` | SQLite 迁移与读写 |
| `web/src/Harness.tsx` | 时间线渲染（工具卡片、diff、终端、计划）、权限弹窗、会话栏 |
| `web/src/Onboarding.tsx` / `Setup.tsx` / `Registry.tsx` | 首次引导（一页三步）；Harness 管理页；「更多 Agent」（Registry 列表、安装、握手、图标） |
| `desktop/` | Electron 壳：主进程启动随包 Bun 服务端（子进程组、`/api/health`、父进程看门狗）、单实例、菜单、preload（文件夹对话框、全屏状态）；`scripts/` 打包（stage / electron-builder / afterPack）与 Xvfb 冒烟 |
| `server/avatars.ts` | 头像轮廓与颜色定义、按 Agent id 的确定性默认头像（FNV-1a），前后端共用 |
| `web/src/*` | React 前端：哈希路由、三栏布局、Agent 编辑、聊天视图、Cmd+K；样式为手写 CSS 变量（无 Tailwind），主题 token（颜色、圆角、阴影、字体）在 `styles.css` 顶部；字体由 `@fontsource-variable/plus-jakarta-sans` 自托管 |
| `web/src/BotAvatar.tsx` / `avatarState.ts` / `AvatarPicker.tsx` | SVG Bot 头像（轮廓 + 表情 + 仅 transform 的动画）、消息/成员状态 → 表情映射、头像选择器；预览页 `#/dev/avatars` |
| `web/src/messageMerge.ts` | 历史快照与 WebSocket 实时事件按 id 合并（慢快照不会覆盖已收到的消息）；发送接口返回的消息立即插入 |
| `web/src/motion.ts` | `usePresence`（退场动画期间保持挂载）、`withViewTransition`（路由切换） |
| `web/src/BrandMark.tsx` | 团团 Logo（导航栏，眨眼 + 悬停互看）；favicon 在 `web/public/` |

前端直接 `import type` 后端的数据类型（`Agent`、`Message`、`RoomEvent`…），契约只有一份定义。

## 数据与状态归属

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Agent（Harness、env、权限策略、身份文档、MCP 服务器）、项目（名称、目录）、房间/会话（所属项目、主 Agent）、消息（含时间线 JSON）、ACP 会话映射、会话模型偏好（`room_models`）、设置（Harness 路径覆盖、`onboarded`） | SQLite（`Store`） | 唯一权威来源 |
| Harness 进程、挂起的权限请求、终端输出 | `HarnessHost` 内存 | 进程退出即丢失；重启后用 `acp_sessions` 里的 sessionId resume / load |
| ACP session 自身的对话历史 | Harness | 团团不重放 Harness 的历史（load 时的回放 update 被忽略），只显示自己存的消息 |
| 模型、Key、登录 | Harness | 团团不保存凭据 |

迁移按 `PRAGMA user_version` 顺序执行，只追加：

| 版本 | 内容 |
| --- | --- |
| 1–3 | 初始表；早期的路由与设备表（对应功能已移除，见 6、7） |
| 4 | `agents.avatar_shape` |
| 5 | 头像颜色映射到新色板 |
| 6 | ACP：`system_prompt` → `identity`；agents 加 `harness`、`cwd`、`env`、`permission_policy`、`mcp_server_ids`（从旧的 `mcp:` 工具 id 迁移）；rooms 加 `main_agent_id`（回填第一个成员）、`cwd`；messages 加 `timeline`；删除 `routing_decisions`；新表 `acp_sessions`、`settings` |
| 7 | 清理已移除功能的设备会话：删除对应房间（及其消息、ACP 会话、成员）和 `device_sessions` 表 |

头像动画只用 CSS transform：≥32px 完整动画、更小只眨眼；`prefers-reduced-motion` 全部关闭；离屏（IntersectionObserver）和标签页隐藏（`html[data-tab-hidden]`）时暂停。

## 编排

1. 人类消息写库并入房间队列，每个房间同时只执行一条链，不同房间并行。
2. 触发：单 Agent → 该 Agent；多 Agent 时 @所有人 → 全部成员；@具体成员 → 这些成员；没有 @ → 主 Agent。串行执行。
3. 单个回合：取得（或新建 / 恢复）该 Agent 在本会话的 ACP session；多 Agent prompt = 该 Agent 上次发言之后的会话记录（带发言者），单 Agent = 用户消息（含图片）。身份文档按 Harness 传递（见 README）；不支持的 Harness 附加在会话第一条 prompt 前的 `<tuantuan-identity>` 中。
4. `session/update` 实时以 `update` 事件推送，同时折叠进时间线；回合结束时写库。权限请求以 `permission` 事件推送，用户回答后返回给 Harness。
5. 取消：`session/cancel`，保留已生成部分并标为 `cancelled`。
6. 交接：回合进行时，Agent 调用 `handoff` 把目标记到本回合（校验是会话成员、不是自己）；回合正常结束后按顺序入队（去重、`@所有人` 轮次不重复），`hop + 1`，接手方 prompt 末尾附 `<tuantuan-handoff from="…">task</tuantuan-handoff>`。时间线记录 `handoffs` / `handoffFrom`，界面显示交接卡片。超过 5 次交接停止。会话新消息打断当前链。
7. session/load 回放：`switchSession` 指定历史会话时优先 load，回放的 update 存在 slot 里，`/replay` 接口按用户消息文本去掉本房间已有的轮次后返回，前端只读显示。

## 取舍

- **每个 Agent 一个进程**：会话隔离清楚、可分别设置 env 和 cwd；代价是内存。同一 Agent 在不同会话（不同工作目录）会各开一个进程。
- **身份文档不落盘**：不改用户仓库；拒绝了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 方案，因为它们会把登录态也换掉，每个 Agent 要各自登录。
- **fs / terminal 限制在 cwd**：只约束经过团团的请求；Harness 自己的内置工具按它自己的沙箱与权限运行。
- **未做鉴权 / 多用户**：仅适合本机。

## Harness 来源与一键安装

- `detectHarness` 顺序：「Harness 页填的路径」→ 登录 shell 的 PATH → 团团内置（`bundled`，从团团自己的 `node_modules` 解析 ACP 适配器，用 `process.execPath` 的 Bun 启动）→ 团团安装（`managed`）。`TUANTUAN_PREFER_MANAGED=1` 时团团安装的优先。
- 桌面包默认不带 Claude Code / Codex 适配器（引擎各 250–400 MB）：首次使用时走 Registry 安装（`claude-acp` / `codex-acp`，npx 包，Bun 运行）。`TUANTUAN_BUNDLE_ADAPTERS=1` 打包时改为内置。登录命令按「内置 → 团团安装」两处找 Claude / Codex 可执行文件。
- Registry 安装：`installManaged` 按分发类型执行；版本目录 `agents/<id>/<version>/`，失败时不留下半成品；Registry 版本变了提示更新；卸载只删团团目录。需要 Node ≥ 22 的包（`engines.node` 或常用定义里 `runtime: "node"`，如 MiniMax 的 better-sqlite3）用托管 Node（nodejs.org，校验 SHASUMS256）。uv 工具直接装到最终目录（venv 写死路径）。
- 一键安装（常用 Harness 的官方脚本 / bun / brew / npm）：`bash -c` 在登录 shell 环境里运行，`stdin` 关闭，日志去掉 ANSI 并折叠 `\r` 进度，最多保留 800 行；取消时连同子进程一起结束；15 分钟超时。完成后清掉登录 shell 环境缓存，页面重新检测。
- 测试：`mock-cli`（本地安装脚本）与 `tests/fixtures/mock-registry.ts`（本地 CDN + npm 源，二进制 / npx / 坏条目）；`TUANTUAN_REAL_REGISTRY=1` 跑真实安装与握手。

## 桌面（Electron）

- 服务端不进 asar：`resources/server`（源码 + 生产依赖）+ `resources/bin/bun`。主进程选空闲端口启动子进程组，等 `/api/health` 后加载窗口；退出时结束整个进程组；服务端用 `TUANTUAN_PARENT_PID` 看门狗兜底。
- 登录 shell 环境在主进程解析一次，传给服务端，Harness 继承它（CC Switch 写的变量照常生效）。
- macOS：`titleBarStyle: "hidden"`，红绿灯位置 `{x: 18, y: 20}`；网页侧 `html[data-desktop="darwin"]` 让侧栏顶行左侧留出红绿灯位置，搜索和「+」排在红绿灯右边；`data-fullscreen` 由主进程在进入 / 退出全屏时经 preload 设置，全屏时不再留空。
