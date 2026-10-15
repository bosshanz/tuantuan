# 团团：桌面客户端 + 独立 Harness（ACP）改造计划（待 Andy 评审）

> 状态：已评审（2026-10-14）。**2026-10-14 Andy 决定移除桌面机器人功能**：下文涉及机器人的条目（决策 4、§3.3、机器人 MCP 工具）已作废，仅保留作历史记录。M1 已完成主体（见 §8 M1 状态）。凡标「未核实」的条目需要实测。

## 0. Andy 的决定（2026-10-14）
1. 桌面框架：~~Electrobun~~ → **Electron**（2026-10-15 Andy 改定，见 §2.3 末尾）。
2. 群聊不 @ 时：每个群指定一个**主 Agent**，由它回复。
3. 工作目录**属于会话**（群聊或私聊），不属于 Agent；群内所有 Agent 共用它。
4. 机器人房间绑定一个**编码 Harness** Agent。
5. **不做内置简易 Harness**；改为「新手引导」：检测 / 安装 / 登录各 Harness，并绑定到 Agent 与机器人。测试与 e2e 用 mock ACP Agent。
6. 团团维护每个 Agent 独立的**身份文档**（类似 AGENTS.md / CLAUDE.md，在团团里编辑），以不侵入用户仓库的方式交给 Harness（见 §3.4），兜底为会话首条 prompt 前置。

## 1. 目标与非目标

**目标**
- 团团变成桌面客户端：每个 Agent 背后是一个独立的 Harness 进程（Claude Code、Codex、Grok Build、OpenCode 首批），通过 ACP（Agent Client Protocol）接入。
- Agent 的 Skills、指令、工具、模型都归各自 Harness 管；团团只负责会话、群聊编排、展示和权限。
- UI 完整支持 ACP 能力：流式文本、思考、工具卡片（diff / 终端输出）、计划、权限确认、模式 / 模型 / 推理档位切换、斜杠命令、附件、取消、会话列表与恢复、用量。
- 保留群聊、交接（handoff）、Bot 头像与表情、机器人房间。

**非目标（本轮不做）**
- 不再自己调模型：删除 Auto 路由、决策模型分类器、`AGENT_HUB_MODELS` 选模型、providers 配置、内置 mock 以外的 LLM 客户端。
- 不做多用户 / 远程部署 / 账号体系。
- 不追 ACP v2 草案（只做 v1，见风险）。
- 不自研编码 Agent；「内置简易 Harness」作为可选（见决策 5）。

## 2. 调研结论（带出处）

### 2.1 ACP 协议现状
- JSON-RPC 2.0，客户端把 Agent 作为子进程启动，stdio 上传换行分隔 JSON（[协议概览](https://agentclientprotocol.com/protocol/overview)）。协议主版本是整数，当前稳定为 **v1**；v2 是草案（SDK 需显式 `experimental/v2` 导入，[npm](https://www.npmjs.com/package/@agentclientprotocol/sdk)）。
- 流程：`initialize`（版本 + 能力协商、`authMethods`）→ 可选 `authenticate` → `session/new`（`cwd` 绝对路径、`mcpServers`）或 `session/load`（需 `loadSession` 能力）→ `session/prompt` → Agent 推 `session/update` → 结束时返回 `stopReason`（end_turn / max_tokens / max_turn_requests / refusal / cancelled）；`session/cancel` 是通知（[初始化](https://agentclientprotocol.com/protocol/initialization)、[Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)）。
- `session/update` 全部变体：`user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`（上下文用量 + 费用）、`notice`（需客户端声明 `session.notices`）、`compaction_update` / `compaction_summary_chunk`（需 `session.compaction`）。消息块可带 `messageId`。
- 客户端方法：`session/request_permission`（必备）、`fs/read_text_file` / `fs/write_text_file`、`terminal/create|output|wait_for_exit|kill|release`、`elicitation/create`（表单 / URL 提问）。Agent 可选方法：`session/load`、`session/set_mode`、`logout`；会话能力还有 list / resume / fork / close / delete（按能力声明）。
- 提示内容：基线 text + resource_link；可选 image、audio、embedded resource（`promptCapabilities`）。MCP：Agent 声明 `mcpCapabilities.http/sse`，stdio MCP 为基线。
- **模型选择**：没有独立的模型 API。`session/set_model` 从未稳定并已移除，模型 / 模式 / 推理档位统一走 **Session Config Options**（`configOptions`，category = `mode` / `model` / `model_config` / `thought_level`，用 `session/set_config_option` 设置）。v1 里旧的 `modes` 仍在，过渡期 Agent 可能两者都发（[Config Options v1](https://agentclientprotocol.com/protocol/v1/session-config-options)、[go-sdk 0.13.5 说明](https://github.com/coder/acp-go-sdk/releases/tag/v0.13.5)）。v2 草案里 modes、fs/*、terminal/* 都被移除（[v2 迁移](https://agentclientprotocol.com/protocol/v2/migration)）。
- 扩展：`_meta` 字段、`_` 前缀自定义方法；各家有私有扩展（如 Grok 的 `x.ai/*`）。
- TypeScript SDK：`@agentclientprotocol/sdk` v1.8.0（Zed 维护，Apache-2.0，周下载约 730 万）。新 API 为 `acp.client({ name }).onRequest(...).onNotification(...).connect(stream)` / `connectWith`；`ClientSideConnection` 已标记弃用（[TS 文档](https://agentclientprotocol.com/libraries/typescript)、[迁移指南](https://github.com/agentclientprotocol/typescript-sdk/blob/main/MIGRATION_0.26_0.27.md)）。**Bun 兼容性未核实**：SDK 是纯 TS、0 依赖、基于 Web Streams（`ndJsonStream`），预计可用 `Bun.spawn` 的 stdin/stdout 流直接接；M1 第一天做冒烟验证。

### 2.2 各 Harness 的 ACP 支持

| Harness | 接入方式 / 启动命令 | 安装 | 认证 | 亮点 | 已知缺口 / 注意 |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | 适配器 `claude-agent-acp`（基于 Claude Agent SDK） | `npm i -g @agentclientprotocol/claude-agent-acp`（v0.70，旧名 `@zed-industries/claude-code-acp` / `claude-agent-acp` 已迁移）；Releases 有免 Node 单文件二进制 | `ANTHROPIC_API_KEY`，或沿用本机 Claude 登录（未核实订阅登录在适配器下的行为） | @ 引用、图片、带权限的工具调用、编辑审阅、TODO（plan）、嵌套子 Agent 记录、交互/后台终端、自定义斜杠命令、客户端 MCP、goal / 失败结构化扩展（[npm](https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp)、[GitHub](https://github.com/zed-industries/claude-agent-acp/)） | 子 Agent 信息在 `_meta.claudeCode`，需专门渲染；v2 需环境变量开启 |
| **Codex** | 适配器 `codex-acp`（基于 Codex App Server） | `npx -y @agentclientprotocol/codex-acp` 或 `npm i -g`（自带兼容的 `@openai/codex`，`CODEX_PATH` 可换） | ChatGPT 订阅登录 / `CODEX_API_KEY` / `OPENAI_API_KEY` | @ 引用、图片、权限、编辑审阅、TODO、斜杠命令 `/review` `/review-branch` `/review-commit` `/init` `/compact` `/logout`、客户端 MCP（[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp/)、[旧仓库说明](https://github.com/zed-industries/codex-acp)） | 旧包 `@zed-industries/codex-acp` 不要再用；ChatGPT 登录不支持远程项目 |
| **Grok Build** | 原生：`grok agent stdio` | 官方一行安装脚本（具体 URL 未核实），客户端 2026-07 开源（[xai-org/grok-build](https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-shell)） | `grok login` 缓存凭据或 API Key；需 SuperGrok / X Premium+（据第三方教程，未在官方文档核实） | 工具调用、思考、计划、权限；`-m` 选模型、`--always-approve`、`--agent-profile`、插件目录；`x.ai/*` 扩展（历史回退、compact、认证 URL 等）；另有 `grok agent serve`（本地 WebSocket）（[grok-wiki](https://grok-wiki.com/public/docs/xai-org-grok-build-90205de50458/pages/15-agent-mode-acp.md)、[grokbook](https://www.grokbook.dev/chapter/15-agent-mode)） | 社区提示：完整回复要从 `agent_message_chunk` 拼，不能只看 prompt 返回；configOptions / 斜杠命令覆盖情况未核实 |
| **OpenCode** | 原生：`opencode acp`（`--cwd` 可选） | 官方安装脚本 `curl -fsSL https://opencode.ai/install \| bash` 或 `npm i -g opencode-ai`（以官网为准，未逐一核实） | 声明 `opencode-login` 认证方法：客户端支持 terminal-auth 时跑 `opencode auth login`（或 `opencode acp --login`）后重连；或 provider 环境变量（如 `OPENCODE_API_KEY`） | ACP v1；`loadSession`、session list / resume / fork / close；图片、嵌入上下文；MCP http/sse；读取 `elicitation.form`（提问表单，需 `OPENCODE_ENABLE_QUESTION_TOOL=1` 才启用问答工具）、`session.compaction`；自带工具、自定义工具与斜杠命令、`AGENTS.md`、formatter/linter、agents 与权限系统；多 provider 多模型（[ACP 文档](https://opencode.ai/docs/acp/)、[v2 文档 ACP 页](https://opencode.ai/v2/docs/cli/acp/)、[agent.ts](https://github.com/anomalyco/opencode/blob/721ff512/packages/opencode/src/acp/agent.ts)） | `/undo` `/redo` 等部分内置斜杠命令不支持；一个进程内跑私有 OpenCode server；GUI 应用找不到 `opencode` 时需绝对路径；模型 / agent 是否以 configOptions 暴露需实测 |
| Gemini CLI（第二批） | 原生 `gemini --acp`（`--experimental-acp` 已弃用但兼容） | `npm i -g @google/gemini-cli` | Google 登录 / API Key | ACP 参考实现之一（[acp-mode.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)） | — |
| 其他 | Goose、Kimi CLI、Qwen Code、Cline、Cursor、GitHub Copilot、Junie 等均在官方列表 | — | — | — | 见 [ACP Agents 列表](https://agentclientprotocol.com/overview/agents) |

### 2.3 桌面打包
| 方案 | 适配度 | 优点 | 代价 |
| --- | --- | --- | --- |
| **Electrobun v1**（推荐） | 主进程就是 Bun，现有 Bun 服务端几乎原样搬进去 | 不用 sidecar；`Bun.spawn` 直接拉起各 Harness；自带签名 + 公证 + 差分更新（静态 HTTPS 托管）；包体小（系统 WebView）（[v1 博客](https://blackboard.sh/blog/electrobun-v1/)、[签名](https://framework.blackboard.sh/electrobun/guides/code-signing/)、[更新](https://framework.blackboard.sh/electrobun/guides/updates/)） | 生态新、坑少有人踩；Windows / Linux 成熟度未核实；系统 WebView 差异（Safari 内核）需测 |
| Tauri v2 + Bun sidecar（`bun build --compile`） | 成熟，签名公证流程清楚（[sidecar 文档](https://v2.tauri.app/develop/sidecar/)） | 包小、更新器成熟 | 两套运行时（Rust 壳 + Bun sidecar）；sidecar 嵌套签名在 macOS 公证上有已知坑（[issue #11992](https://github.com/tauri-apps/tauri/issues/11992)）；进程管理多一层 |
| Electron | 最稳 | 生态最大、Chromium 一致性 | 包体 100MB+；Node 而非 Bun（服务端要改或再嵌 Bun） |

**2026-10-15 决定改用 Electron**：Chromium 渲染与开发时一致、electron-builder 的 dmg / nsis / AppImage、签名公证、electron-updater 都成熟，Windows / Linux 不用赌。代价用「Bun 子进程」消化：Electron 主进程只管窗口，服务端原样跑在随包附带的 Bun 上（`resources/bin/bun` + `resources/server`，不进 asar），所以服务端代码零改动。实测 Linux AppImage 431 MB（Codex 引擎 427 MB 解压后、Claude 引擎 273 MB、Bun 76 MB 占大头）。

**共同难点：macOS GUI 应用的 PATH**。从 Dock 启动时继承的是 launchd 的精简 PATH，找不到 `npm -g`、Homebrew、nvm、`~/.opencode/bin` 下的 CLI。方案：启动时用用户登录 shell 解析一次环境（`$SHELL -ilc 'env -0'`，带超时），缓存后用于所有子进程；设置页允许为每个 Harness 填绝对路径；「检测」按钮显示解析到的路径和版本。

## 3. 架构

```
桌面壳（Electron 主进程：窗口 / 菜单 / 文件夹对话框）→ 子进程 Bun 服务端
├─ HarnessRegistry      已知 Harness 定义：检测命令、启动命令/参数、安装提示、认证提示、默认 env
├─ AcpHost              每个 Agent 一个 Harness 子进程（按 Agent 复用，多会话复用同一进程）
│   ├─ AcpConnection    @agentclientprotocol/sdk client：initialize / authenticate / session/* / 处理 Agent→Client 请求
│   ├─ ClientServices   fs/*（限定在 workspace 内）、terminal/*（受控 PTY）、request_permission → UI、elicitation → UI
│   └─ Lifecycle        启动、崩溃重启（退避）、空闲回收、stderr 日志
├─ SessionStore(SQLite) 会话 ↔ ACP sessionId 映射、消息/事件时间线（含 tool_call、plan、thought）、权限记忆
├─ Orchestrator         私聊直接转发；群聊：@ 路由、交接链、跳数上限、打断
├─ HandoffMCP           团团自己暴露的 MCP 服务（本地 HTTP 或 stdio），在 session/new 时通过 mcpServers 注入：handoff / list_members / post_to_room
└─ WebView (React)      现有界面 + 新的能力组件
```

### 3.1 会话映射
- 私聊：1 个团团会话 = 1 个 Agent 的 1 个 ACP session。优先 `session/resume`/`session/load`（看能力）恢复；不支持时，团团保存本地时间线用于展示，并在新 session 首条 prompt 里注入简短历史摘要（标注为降级）。
- 群聊：1 个群 × 每个成员 Agent 各 1 个 ACP session（成员各自的上下文）。人类消息和其他成员的发言以「群聊转述」形式作为 prompt 的一部分（`[群聊] Alice: …`），只发给被路由到的成员；未被路由的成员不消耗 token，下次轮到时补上他错过的消息（截断 + 摘要）。
- 团团自己的消息 id ↔ ACP `messageId` / `toolCallId` 对应存表，界面刷新后可完全重建。

### 3.2 群聊编排（去掉 Auto 之后）
- `@名字` / `@所有人`：保留，纯规则，无需分类器。
- **不 @ 时谁回复**：群设置里的**主 Agent**回复（已决定）。
- **交接**：团团注入 `tuantuan-handoff` MCP 工具，Agent 调 `handoff(to, task)` → 团团把任务作为新 prompt 发给目标 Agent 的 session；保留跳数上限、打断、交接卡片。所有首批 Harness 都支持客户端传入 MCP 服务（Claude / Codex 文档明确；Grok / OpenCode 需实测 `mcpServers` 注入是否生效）。

### 3.4 身份文档的传递（不往共享工作目录写文件）
| Harness | 方式 | 依据 | 副作用 |
| --- | --- | --- | --- |
| Claude Code | `session/new`（及 load/resume）的 `_meta.systemPrompt = { append: 身份文档 }` | 适配器源码与 [LIBRARY.md](https://github.com/papiguy/claude-agent-acp/blob/main/docs/LIBRARY.md)、[PR #91](https://github.com/zed-industries/claude-code-acp/pull/91) | 无。**不用** `_meta.claudeCode.configDir` / `CLAUDE_CONFIG_DIR`：会把认证文件一起换目录，等于每个 Agent 要单独登录 |
| Codex | 每个 Agent 一个进程，进程 env `CODEX_CONFIG={"developer_instructions": 身份文档}` | [codex-acp 运行时选项](https://github.com/agentclientprotocol/codex-acp/)、[Codex 配置参考](https://developers.openai.com/codex/config-reference.md)；按会话传 `_meta` 尚未支持（[issue #215](https://github.com/agentclientprotocol/codex-acp/issues/215)） | 无；不改 `~/.codex`，不用 `CODEX_HOME`（同样会换掉登录） |
| Grok Build | `session/new` 的 `_meta.rules = 身份文档`（追加到系统提示） | [agent-mode 文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md) | 无 |
| OpenCode | **兜底：会话首条 prompt 前置**（`<tuantuan-identity>` 包裹）。可选的 `OPENCODE_CONFIG_CONTENT` 自定义 agent 的 `prompt` 会替换 OpenCode 默认 agent 的系统提示，`instructions` 字段在 V2 不生效 | [Config](https://opencode.ai/docs/config/)、[Instructions](https://opencode.ai/v2/docs/instructions/) | 前置会占一次上下文且对模型优先级较低；会话恢复后不重复发送 |
| 其他 / 未知 | 首条 prompt 前置 | — | 同上 |

群聊上下文（「你在群 X 里，成员有…，主 Agent 是…，要交接请调用 handoff」）与身份文档拼在一起，按同样的通道传递。

### 3.3 机器人房间
- 机器人绑定一个 Agent，走同一套 ACP 会话；语音转文字后作为 prompt，回复的 `agent_message_chunk` 送 TTS。
- 编码类 Harness 回复里常有代码、工具卡片、权限请求，不适合语音：机器人房间默认把该 Agent 的 session 切到只读/问答模式（如有 `mode` config），工具卡片和权限请求在屏幕上显示、语音只念摘要。
- `robot_express` / `robot_action` 改为同样经注入的 MCP 工具提供。
- 待决策：机器人房间是否需要一个「轻量对话型」Harness（见决策 5）。

## 4. UI 能力映射

| ACP 能力 | UI 组件 | 首批 Harness 支持情况（M1 实测确认） |
| --- | --- | --- |
| `agent_message_chunk` | 流式 Markdown 消息（现有） | 全部 |
| `agent_thought_chunk` | 可折叠「思考」块，默认收起，流式时显示一行摘要 | Claude、Grok、OpenCode 预计有；Codex 待测 |
| `tool_call` / `tool_call_update` | 工具卡片：标题、kind 图标、状态；`content` 中 `diff` → 并排/统一 diff 查看器（接受/拒绝由权限流程处理）；`terminal` → 内嵌终端输出（xterm.js，跟随）；`locations` → 可点击文件路径；嵌套子 Agent（Claude `_meta`）→ 缩进子时间线 | 全部（diff/终端细节各家不同） |
| `plan` | 消息上方的计划清单（pending / in_progress / completed，优先级），随更新原地刷新 | Claude、Codex、Grok 有；OpenCode 待测 |
| `session/request_permission` | 权限卡片 / 对话框：显示工具、参数、diff 预览；按钮来自 Agent 给的 options（允许一次 / 总是允许 / 拒绝 / 总是拒绝）；Agent 级默认策略；取消时自动回 `cancelled` | 全部 |
| `configOptions`（mode / model / model_config / thought_level）+ 旧 `modes` | 输入框上方的「模式」切换（如 Ask/Code/Plan）、「模型」选择器、推理档位；`config_option_update` / `current_mode_update` 实时同步 | 各家支持度不一，按能力显示，没有就隐藏 |
| `available_commands_update` | 输入 `/` 弹出斜杠命令面板（名称、描述、参数提示），与 @ 列表同一套交互 | Claude、Codex、OpenCode 有；Grok 待测 |
| `promptCapabilities.image/audio/embeddedContext` | 附件：拖拽/粘贴图片，`@文件` 选择工作区文件作为 resource / resource_link；不支持的类型禁用 | Claude、Codex、OpenCode 支持图片；音频基本无 |
| `session/cancel` | 停止按钮（现有），取消时把未完成工具卡片标为已取消 | 全部 |
| `session/list` / `load` / `resume` / `fork` / `delete` | 会话列表可导入 Harness 已有会话；「从这里分叉」；删除同步 | OpenCode 支持 list/resume/fork；Claude v2 才有完整列表；其余待测 |
| `usage_update` | 头部的上下文占用条 + 累计费用 | 待测 |
| `session_info_update` | 会话标题自动更新 | 待测 |
| `notice` | 轻提示（toast），不进历史 | 需客户端声明 |
| `compaction_*` | 时间线里的「上下文已压缩」分隔块，可展开摘要 | OpenCode 读取该能力；其余待测 |
| `elicitation/create` | 表单提问卡片 / 打开 URL 确认 | OpenCode（需开启问答工具）；其余待测 |
| `authMethods` / `authenticate` / terminal-auth | Agent 设置页「登录」：API Key 输入（存钥匙串）或在内置终端运行登录命令后重连 | 全部有各自方式 |
| `fs/*`、`terminal/*`（客户端提供） | 团团实现：读写限定在 workspace；终端由团团 PTY 执行并在工具卡片里展示 | 首批均可能调用 |
| 私有扩展（`_meta`、`x.ai/*`、Claude goal 等） | M4 之后按需支持，未知字段安全忽略 | — |

## 5. 每个 Agent 的配置
- 名称、头像（保留）、Harness（下拉，来自 Registry，显示检测状态与版本）。
- 工作目录（必填，绝对路径；可加 `additionalDirectories`）。
- 环境变量（键值；密钥类存系统钥匙串，不落 SQLite 明文）。
- 额外 MCP 服务（团团的 handoff MCP 自动注入，不可删）。
- 默认权限策略：每次询问 / 本会话内记住 / 只读自动允许 / 全部自动（危险，需二次确认）。
- 启动参数（高级）：如 Grok `-m`、`--agent-profile`；OpenCode `--cwd`。
- 删除：System Prompt、Tools、Skills、模型选择这些字段（归 Harness）；可选保留一段「团团附加说明」作为每轮 prompt 前缀（决策 6）。

## 6. 删除与保留
**删除**：`server/router.ts`、`decision.ts`、`classify.ts`、`picker.ts`（话题选人）、`llm.ts`、`tool-loop.ts`、`tools.ts` 中的内置工具、`skills.ts` 与 `skills/` 目录、`config.ts` 的模型/provider/路由表部分、`config/providers*.json`、`.env.example` 里 `AGENT_HUB_MODELS*` / `DECISION_*` / provider Key、路由详情面板（「回复详情」里的分类、候选、回退）、相关测试与文档章节。`mock.ts` 改造成一个「mock ACP Agent」（用 SDK 的 agent 端写），供 e2e 和无 Harness 演示用。
**保留**：群聊 / @ / @所有人 / 交接 / 跳数上限 / 打断、Bot 头像与表情（表情改由 ACP 状态驱动：thought=思考、message chunk=说话、tool_call=专注、permission=等待、错误=难过）、机器人房间与 `/device` 协议、对齐与动效体系、SQLite（迁移重做：agents 表加 harness/cwd/env 引用，新增 acp_sessions、timeline_events、permission_rules）。

## 7. 安全
- 权限默认「每次询问」；「总是允许」按 Agent + 工具 kind + 路径前缀记忆，可在设置里撤销。
- `fs/*` 与团团终端严格限定在 Agent 的 workspace（realpath 校验，拒绝符号链接逃逸）；workspace 外读写一律走权限确认。
- Harness 自己的工具（不走 `fs/*`）不受团团控制：在 UI 明示「该 Harness 在本机以你的权限运行」，并展示其沙箱选项（如 Codex 沙箱、Grok sandbox profile）。
- 密钥只放钥匙串 / 环境变量注入子进程，日志脱敏；子进程 env 白名单（PATH、HOME、LANG + 用户配置项），不把团团自身环境整个透传。
- handoff MCP 只监听 127.0.0.1，带每会话随机 token。

## 8. 里程碑
- **M1：ACP 客户端 + 首批 4 个 Harness 的私聊，完整能力 UI**（仍以浏览器 + Bun 服务形态开发，桌面壳放 M3）
  - SDK 在 Bun 下冒烟；HarnessRegistry（检测/路径/版本/认证提示），PATH 解析。
  - Claude Code、Codex、Grok Build、OpenCode 私聊：流式、思考、工具卡片（diff + 终端）、plan、权限、configOptions（模式/模型/档位）、斜杠命令、图片与 @文件、取消、会话恢复（按能力降级）、usage。
  - mock ACP Agent + e2e：覆盖每种 update 的渲染、权限流程、取消、恢复；每个真实 Harness 一个手动验收清单（需要 Andy 的账号）。
  - 删除 Auto 路由及相关配置、文档。
  - **M1 状态（2026-10-14）**：已完成 SDK 在 Bun 下验证、注册表与检测、每 Agent 进程、会话映射与恢复、cwd 限制、权限弹窗、私聊完整能力 UI、Agent 编辑字段、基础新手引导、删除 Auto 路由、mock ACP agent + e2e、迁移 6。握手实测：Claude Code（claude-agent-acp 0.90.0）与 OpenCode 1.19.0 无账号可建会话；Codex（codex-acp 2.2.2）与 Grok 1.0.52 初始化成功、建会话需登录。未完成：ACP `authenticate` 流程（目前只显示登录提示）、session/load 回放显示、机器人 Agent 按 Harness 过滤、新建群时直接设主 Agent / cwd。
- **M2：群聊 + 交接 MCP**
  - **M2 状态（2026-10-14）**：已完成 `tuantuan` MCP 服务器（HTTP `/mcp/<token>` + stdio 中转，按 `mcpCapabilities.http` 选择）、`handoff` / `list_members`（成员校验、去重、跳数上限、打断语义、交接卡片）、群聊转述（上次发言后的新消息，8000 字上限）、机器人 MCP 工具（已随机器人功能移除）、引导页 ACP `authenticate` + 终端命令复制 + 重新检测、session/load 回放只读显示（按用户消息去重）、建群时选主 Agent 和工作目录、机器人只列 Harness 已安装的 Agent、README 截图更新。实测：OpenCode 1.19.0（免费模型，无账号）在 HTTP 和 stdio 两种传输下都完成了真实交接；Claude Code 未登录时 prompt 报需要登录；Codex / Grok 未登录无法建会话。：成员 session 管理、转述上下文、@ 路由、默认回复人（按决策）、handoff MCP、跳数与打断、机器人房间改走 ACP。
- **M3：桌面打包**：Electron 壳、登录 shell 环境解析、钥匙串、签名公证、自动更新、首次运行引导（检测并提示安装 Harness）。
  - **M3 状态（2026-10-15）**：`desktop/` 已完成：Electron 主进程拉起随包 Bun 服务端（随机本机端口、等 `/api/health`、退出时杀整个进程组）、单实例、macOS hiddenInset 标题栏（红绿灯居中在侧栏上方）、中文菜单、可选托盘、窗口位置记忆、登录 shell 环境导入、preload 桥接原生文件夹对话框（contextIsolation + sandbox，无 nodeIntegration）、图标、electron-builder（mac dmg+zip arm64/x64、win nsis、linux AppImage）、签名公证按环境变量开启、electron-updater 仅在配置发布时启用、GitHub Actions 打包。Linux AppImage 在 Xvfb 下端到端冒烟通过（`desktop/scripts/smoke.ts`）。未实测：macOS / Windows 包、签名公证、自动更新、钥匙串。
- **M4：更多 Harness 与扩展**：Gemini CLI、Goose / Kimi / Qwen Code；私有扩展（Claude 子 Agent / goal、Grok `x.ai/*` 回退、OpenCode fork）；视情况评估 ACP v2。

## 9. 风险
- ACP v1 → v2 迁移：v2 去掉 modes、fs/*、terminal/*，改动 prompt 生命周期。我们先做 v1，并把协议层隔离在 AcpConnection 内。
- 各 Harness 对 configOptions、plan、slash 命令、session list 的支持不齐，UI 必须完全按能力显示/隐藏。
- 账号与费用：Claude/Codex/Grok 需各自订阅或 Key；Grok Build 需付费档；e2e 不能依赖真实账号。
- 适配器版本变化快（Claude 适配器一年内两次改名迁仓），需锁版本 + 设置页显示版本。
- 群聊里多个编码 Agent 同一 workspace 并发写文件会冲突：默认同一 workspace 同时只允许一个 Agent 执行写操作（或每 Agent 独立 worktree，见决策）。
- 机器人语音与编码 Harness 的输出形态不匹配。

## 10. 需要 Andy 决定（已在 §0 决定，保留原问题供追溯）
1. **桌面框架**：Electrobun（推荐，主进程就是 Bun）还是 Tauri + Bun sidecar？（最终：Electron + Bun 子进程）
2. **群聊不 @ 时谁回复**：默认回复人 / 上一位继续 / 无人回复。
3. **群里多个 Agent 共用一个工作目录，还是每个 Agent 自动建 git worktree**？
4. **机器人房间**：继续绑定编码 Harness（只读模式 + 语音念摘要），还是加一个轻量对话型 Harness 专门给机器人？
5. **内置简易 Harness** 要不要做（用于无账号演示 / 机器人），还是只保留 mock ACP Agent 给测试？
6. **团团层的附加说明**（每轮 prompt 前缀、群聊身份说明）是否保留，还是完全交给各 Harness 的 AGENTS.md / CLAUDE.md？
