# 团团 Tuantuan 架构

## 背景与约束

- 本机使用：一个 Bun 进程 + 一个 SQLite 文件，无鉴权、无多实例。桌面壳（Electrobun，主进程即 Bun）在 M3。
- 团团不调用模型。每个 Agent 绑定一个编码 Harness，通过 ACP（JSON-RPC over stdio，`@agentclientprotocol/sdk` 1.8.0）驱动；模型、Key、登录归 Harness。
- 没有任何账号也必须可测试 → `server/mock-agent.ts` 是一个确定性的 ACP agent（`TUANTUAN_MOCK_HARNESS=1` 时可选）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/main.ts` | 打开数据库，启动服务；退出时关闭所有 Harness 进程 |
| `server/app.ts` | HTTP API（参数校验）、WebSocket 订阅、静态文件 |
| `server/harness.ts` | Harness 注册表（Claude Code / Codex / Grok Build / OpenCode / mock）：启动命令、安装与登录提示、身份文档传递方式；登录 shell 环境（PATH）解析、`which`、版本检测、绝对路径覆盖 |
| `server/acp.ts` | `AcpProcess`：`Bun.spawn` 一个 Harness，用 SDK 的 `ndJsonStream` 建连接、`initialize`；处理 agent 发来的 `fs/*`（限制在 cwd 内）、`terminal/*`、`session/request_permission`；保留 stderr 末尾用于报错 |
| `server/custom.ts` | BYOK「自定义 API」harness：OpenAI Chat / Responses / Anthropic Messages 的 SSE 流式与 tool call，输出 ACP `session/update`；Key 只在服务端 |
| `server/skills.ts` | Skills：解析 SKILL.md；自动发现（用户级 / 插件 / 项目）、勾选链接；导入（目录 / git / GitHub / SKILL.md 链接，先预览再选）；按 Harness 链接到会话目录的原生位置（不覆盖）；BYOK 的 `load_skill` |
| `server/providers.ts` | 服务商：预设、Key 打码、按 Harness 注入（Claude Code 用进程 env，Codex 用 ACP `providers/set` + `CODEX_CONFIG` 里的 model，BYOK 直接用）、测速、公开余额接口、只读导入 CC Switch |
| `server/usage.ts` | 用量：读 `~/.claude/projects` / `~/.codex/sessions` 的 JSONL（只读），解析 Claude Code `/usage` 与 codex `/status` 的回复 |
| `server/dirpicker.ts` | 选择文件夹：系统对话框（osascript / zenity / kdialog，可由桌面壳替换）+ 应用内浏览器的目录列表与常用位置 |
| `server/host.ts` | `HarnessHost`：按「Agent + 会话工作目录」复用进程；会话 ↔ ACP session 映射（`acp_sessions` 表，重启后 resume / load）；prompt、cancel、配置项 / 模式、会话列表与切换；权限请求挂起直到用户回答 |
| `shared/timeline.ts` | 把 `session/update` 折叠成时间线（文本、思考、工具卡片、计划、用量）；服务端持久化和前端渲染共用 |
| `server/tuantuan-mcp.ts` / `server/mcp-shim.ts` | 团团自己的 MCP 服务器：`/mcp/<token>`（JSON-RPC over HTTP POST）；token 对应「房间 + Agent」，只在内存。Harness 支持 HTTP MCP 时直接连，否则启动 stdio 中转脚本。工具由 Orchestrator 提供 |
| `server/orchestrator.ts` | 房间队列、触发（私聊 / @ / @所有人 / 主 Agent）、单个 Agent 回合（拼 prompt + 身份文档 → host.prompt → 推送 update → 持久化时间线）、取消 |
| `server/mentions.ts` | 人类消息里的 `@名字` / `@所有人` 解析（忽略引用、代码和转述行）；Agent 回复不解析 |
| `server/store.ts` | SQLite 迁移与读写 |
| `web/src/Harness.tsx` / `Setup.tsx` | 时间线渲染（工具卡片、diff、终端、计划）、权限弹窗、会话栏；新手引导（仅首次）/ Harness 管理页 |
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
| 1–3 | 初始表、路由决策、设备（桌面机器人）会话表及清理（功能已移除，见 7） |
| 4 | `agents.avatar_shape` |
| 5 | 头像颜色映射到新色板 |
| 6 | ACP：`system_prompt` → `identity`；agents 加 `harness`、`cwd`、`env`、`permission_policy`、`mcp_server_ids`（从旧的 `mcp:` 工具 id 迁移）；rooms 加 `main_agent_id`（回填第一个成员）、`cwd`；messages 加 `timeline`；删除 `routing_decisions`；新表 `acp_sessions`、`settings` |
| 7 | 移除桌面机器人：删除设备会话对应的房间（及其消息、ACP 会话、成员）并删除 `device_sessions` 表 |

头像动画只用 CSS transform：≥32px 完整动画、更小只眨眼；`prefers-reduced-motion` 全部关闭；离屏（IntersectionObserver）和标签页隐藏（`html[data-tab-hidden]`）时暂停。

## 编排

1. 人类消息写库并入房间队列，每个房间同时只执行一条链，不同房间并行。
2. 触发：单 Agent → 该 Agent；多 Agent 时 @所有人 → 全部成员；@具体成员 → 这些成员；没有 @ → 主 Agent。串行执行。
3. 单个回合：取得（或新建 / 恢复）该 Agent 在本会话的 ACP session；多 Agent prompt = 该 Agent 上次发言之后的会话记录（带发言者），单 Agent = 用户消息（含图片）。身份文档按 Harness 传递（见 README）；不支持的 Harness 附加在会话第一条 prompt 前的 `<tuantuan-identity>` 中。
4. `session/update` 实时以 `update` 事件推送，同时折叠进时间线；回合结束时写库。权限请求以 `permission` 事件推送，用户回答后返回给 Harness。
5. 取消：`session/cancel`，保留已生成部分并标为 `cancelled`。
6. 交接：回合进行时，Agent 调用 `handoff` 把目标记到本回合（校验是群成员、不是自己）；回合正常结束后按顺序入队（去重、`@所有人` 轮次不重复），`hop + 1`，接手方 prompt 末尾附 `<tuantuan-handoff from="…">task</tuantuan-handoff>`。时间线记录 `handoffs` / `handoffFrom`，界面显示交接卡片。超过 5 次交接停止。会话新消息打断当前链。
7. session/load 回放：`switchSession` 指定历史会话时优先 load，回放的 update 存在 slot 里，`/replay` 接口按用户消息文本去掉本房间已有的轮次后返回，前端只读显示。

## 取舍

- **每个 Agent 一个进程**：会话隔离清楚、可分别设置 env 和 cwd；代价是内存。同一 Agent 在不同会话（不同工作目录）会各开一个进程。
- **身份文档不落盘**：不改用户仓库；拒绝了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 方案，因为它们会把登录态也换掉，每个 Agent 要各自登录。
- **fs / terminal 限制在 cwd**：只约束经过团团的请求；Harness 自己的内置工具按它自己的沙箱与权限运行。
- **未做鉴权 / 多用户**：仅适合本机。

## Harness 来源与一键安装

- `server/harness.ts` 的 `detectHarness`：顺序是「Harness 页填的路径」→ 登录 shell 的 PATH → 团团内置（`bundled`）。内置的 Claude Code / Codex ACP 适配器从团团自己的 `node_modules` 解析（`createRequire`，先按源码位置、再按 `process.cwd()`），用 `process.execPath`（bun）启动，所以不依赖全局 npm 或 Node。打包（Electrobun）时需要把这两个包连同当前平台的可选依赖一起带上。
- `server/installer.ts`：一键安装。命令只来自注册表（`installers`），不接受请求里的命令；`bash -c` 在登录 shell 环境里运行，`stdin` 关闭，日志去掉 ANSI 并折叠 `\r` 进度，最多保留 800 行；取消时连同子进程一起结束（`pkill -P`）；15 分钟超时。完成后清掉登录 shell 环境缓存，页面重新检测。
- 测试用 `mock-cli` Harness（`TUANTUAN_MOCK_HARNESS=1`）配了一个本地安装脚本 `server/mock-installer.ts`，用于测试和 e2e。
