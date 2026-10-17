# 团团：桌面客户端 + 独立 Harness（ACP）计划

> 状态（2026-10-16）：M1、M2 完成；M3（桌面）早期已在 Linux 上端到端验证，后续功能的各平台验收按下方记录分别说明。Harness 从官方 ACP Registry 接入；新增图文渲染与放大预览已完成本机构建、完整检查和 Chrome 冒烟。四语言界面已完成代码接入与浏览器定向验证，桌面原生菜单显示尚未实测。本文档记录目标、决策和里程碑；当前行为以 `README.md` 及 `docs/` 下的使用文档、`docs/product.md`、`docs/architecture.md` 为准。

## 0. 决定记录

1. 桌面框架：**Electron**（2026-10-15）。Electron 主进程只管窗口，服务端原样跑在随包的 Bun 子进程上（见 §2.3）。
2. 多 Agent 会话不 @ 时由**群主（主 Agent）**负责分工、跟进、接收结果与最终汇总；明确 @ 成员保持直接对话（2026-10-15 更新，见末尾）。
3. 工作目录属于**项目**（名称 + 目录），项目下的会话共用；默认项目「草稿」。
4. 不做模型路由：模型、Key、登录归 Harness；团团不调模型。例外：用户要求后加入的「自定义 API（BYOK）」轻量 harness，只做对话。
5. 每个 Agent 有团团里编辑的**身份文档**，不写进用户仓库（见 §3.4）。
6. **桌面机器人功能已移除**（2026-10-14，迁移 7 清理数据）。
7. Harness 来源（2026-10-15）：用户自己装的优先；否则从**官方 ACP Registry** 一键装到团团自己的目录（固定版本、校验和、不用 sudo、不装全局）。Claude Code / Codex 不再默认打进桌面安装包，首次使用时下载（`TUANTUAN_BUNDLE_ADAPTERS=1` 可内置）。
8. 不改用户配置：从不设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`，不写 `~/.claude` / `~/.codex`；CC Switch 只读导入；不从钥匙串抓 token 调私有接口。
9. 接入与行为边界（2026-10-15）：继续沿用 ACP 的能力声明与会话生命周期；不新增原生适配或固定 Agent 上下级。群主职责按请求路由确定，分工与汇总内容由身份指令和所选 Harness 执行，调度器保证结果回流与取消边界；后续改动以实际需求和已确认缺陷为依据。
10. 群聊调度（2026-10-15）：不同 Agent 并行，同一房间同一 Agent 排队，新消息不自动打断；按任务及实际交接依赖停止，独立请求继续。详见末尾「群聊并行调度」。
11. 消息阅读（2026-10-16）：Mermaid 在客户端渲染，沿用当前视觉；图表与图片共享放大预览，聊天内保持紧凑。模型选择沿用 Harness 实际返回的列表，不伪装其他客户端以绕过上游开放范围。
12. 界面语言（2026-10-16）：支持简体中文、繁体中文、英语、日语，默认简体中文；语言属于服务端个人资料，同步各窗口及桌面菜单 / 通知。只翻译应用文案，不改用户内容或模型回复语言。

## 1. 目标与非目标

**目标**
- 团团变成桌面客户端：每个 Agent 背后是一个独立的 Harness 进程（Claude Code、Codex、Grok Build、OpenCode 首批），通过 ACP（Agent Client Protocol）接入。
- Agent 的 Skills、指令、工具、模型都归各自 Harness 管；团团只负责会话、多 Agent 编排、展示和权限。
- UI 完整支持 ACP 能力：流式文本、思考、工具卡片（diff / 终端输出）、计划、权限确认、模式 / 模型 / 推理档位切换、斜杠命令、附件、取消、会话列表与恢复、用量。
- 保留多 Agent 会话、交接（handoff）、Bot 头像与表情。

**非目标（本轮不做）**
- 不自己调模型、不做模型路由（BYOK 例外见 §0）。
- 不做多用户 / 远程部署 / 账号体系。
- 不追 ACP v2 草案（只做 v1，见风险）。
- 不自研编码 Agent。

## 2. 调研结论（带出处）

以下保留当时的调研快照，不代表本轮重新核实过的外部版本或能力。

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
备选过 Electrobun（主进程是 Bun）和 Tauri v2 + Bun sidecar；最终选 Electron。

**2026-10-15 决定改用 Electron**：Chromium 渲染与开发时一致、electron-builder 的 dmg / nsis / AppImage、签名公证、electron-updater 都成熟，Windows / Linux 不用赌。代价用「Bun 子进程」消化：Electron 主进程只管窗口，服务端原样跑在随包附带的 Bun 上（`resources/bin/bun` + `resources/server`，不进 asar），所以服务端代码零改动。Linux AppImage 最初 431 MB（Codex / Claude 引擎占大头）；改成首次使用时从 Registry 下载后为 165 MB。

**共同难点：macOS GUI 应用的 PATH**。从 Dock 启动时继承的是 launchd 的精简 PATH，找不到 `npm -g`、Homebrew、nvm、`~/.opencode/bin` 下的 CLI。方案：启动时用用户登录 shell 解析一次环境（`$SHELL -ilc 'env -0'`，带超时），缓存后用于所有子进程；设置页允许为每个 Harness 填绝对路径；「检测」按钮显示解析到的路径和版本。

## 3. 架构

第 3–7 节保留初版目标与方案，未标记完成的能力不能据此视为已实现。当前模块、数据与约束以 `docs/architecture.md` 为准；本轮纠正的执行边界和凭据现状见 §7 及下方修复记录。

```
桌面壳（Electron 主进程：窗口 / 菜单 / 文件夹对话框）→ 子进程 Bun 服务端
├─ HarnessRegistry      已知 Harness 定义：检测命令、启动命令/参数、安装提示、认证提示、默认 env
├─ AcpHost              每个 Agent 一个 Harness 子进程（按 Agent 复用，多会话复用同一进程）
│   ├─ AcpConnection    @agentclientprotocol/sdk client：initialize / authenticate / session/* / 处理 Agent→Client 请求
│   ├─ ClientServices   fs/*（限定在 workspace 内）、terminal/*（受控 PTY）、request_permission → UI、elicitation → UI
│   └─ Lifecycle        启动、崩溃重启（退避）、空闲回收、stderr 日志
├─ SessionStore(SQLite) 会话 ↔ ACP sessionId 映射、消息/事件时间线（含 tool_call、plan、thought）、权限记忆
├─ Orchestrator         单 Agent 会话直接转发；多 Agent 会话：@ 路由、交接链、跳数上限、打断
├─ HandoffMCP           团团自己暴露的 MCP 服务（本地 HTTP 或 stdio），在 session/new 时通过 mcpServers 注入：handoff / list_members / post_to_room
└─ WebView (React)      现有界面 + 新的能力组件
```

### 3.1 会话映射
- 单 Agent 会话：1 个团团会话 = 1 个 Agent 的 1 个 ACP session。优先 `session/resume`/`session/load`（看能力）恢复；不支持时，团团保存本地时间线用于展示，并在新 session 首条 prompt 里注入简短历史摘要（标注为降级）。
- 多 Agent 会话：1 个群 × 每个成员 Agent 各 1 个 ACP session（成员各自的上下文）。人类消息和其他成员的发言以「会话转述」形式作为 prompt 的一部分（`[多 Agent 会话] Alice: …`），只发给被路由到的成员；未被路由的成员不消耗 token，下次轮到时补上他错过的消息（截断 + 摘要）。
- 团团自己的消息 id ↔ ACP `messageId` / `toolCallId` 对应存表，界面刷新后可完全重建。

### 3.2 多 Agent 编排（去掉 Auto 之后）
- `@名字` / `@所有人`：保留，纯规则，无需分类器。
- **不 @ 时谁回复**：群设置里的**群主（主 Agent）**负责本轮分工、跟进和最终汇总。
- **交接**：团团注入 `tuantuan-handoff` MCP 工具，Agent 调 `handoff(to, task)` → 团团把任务作为新 prompt 发给目标 Agent 的 session；保留跳数上限、打断、交接卡片。所有首批 Harness 都支持客户端传入 MCP 服务（Claude / Codex 文档明确；Grok / OpenCode 需实测 `mcpServers` 注入是否生效）。

### 3.4 身份文档的传递（不往共享工作目录写文件）
| Harness | 方式 | 依据 | 副作用 |
| --- | --- | --- | --- |
| Claude Code | `session/new`（及 load/resume）的 `_meta.systemPrompt = { append: 身份文档 }` | 适配器源码与 [LIBRARY.md](https://github.com/papiguy/claude-agent-acp/blob/main/docs/LIBRARY.md)、[PR #91](https://github.com/zed-industries/claude-code-acp/pull/91) | 无。**不用** `_meta.claudeCode.configDir` / `CLAUDE_CONFIG_DIR`：会把认证文件一起换目录，等于每个 Agent 要单独登录 |
| Codex | 每个 Agent 一个进程，进程 env `CODEX_CONFIG={"developer_instructions": 身份文档}` | [codex-acp 运行时选项](https://github.com/agentclientprotocol/codex-acp/)、[Codex 配置参考](https://developers.openai.com/codex/config-reference.md)；按会话传 `_meta` 尚未支持（[issue #215](https://github.com/agentclientprotocol/codex-acp/issues/215)） | 无；不改 `~/.codex`，不用 `CODEX_HOME`（同样会换掉登录） |
| Grok Build | `session/new` 的 `_meta.rules = 身份文档`（追加到系统提示） | [agent-mode 文档](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md) | 无 |
| OpenCode | **兜底：会话首条 prompt 前置**（`<tuantuan-identity>` 包裹）。可选的 `OPENCODE_CONFIG_CONTENT` 自定义 agent 的 `prompt` 会替换 OpenCode 默认 agent 的系统提示，`instructions` 字段在 V2 不生效 | [Config](https://opencode.ai/docs/config/)、[Instructions](https://opencode.ai/v2/docs/instructions/) | 前置会占一次上下文且对模型优先级较低；会话恢复后不重复发送 |
| 其他 / 未知 | 首条 prompt 前置 | — | 同上 |

稳定的多 Agent 上下文（群名、成员及 handoff 使用约定）与身份文档拼在一起，按同样的通道传递。群主 / 成员 / 直达职责由每轮的 `<tuantuan-coordination>` 指定，避免已缓存的身份文档留下旧群主身份。

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
| `authMethods` / `authenticate` / terminal-auth | Agent 设置页「登录」：API Key 输入（原计划钥匙串，当前 SQLite 明文）或打开系统终端运行登录命令后重连 | 全部有各自方式 |
| `fs/*`、`terminal/*`（客户端提供） | 团团实现：读写限定在 workspace；终端由团团 PTY 执行并在工具卡片里展示 | 首批均可能调用 |
| 私有扩展（`_meta`、`x.ai/*`、Claude goal 等） | M4 之后按需支持，未知字段安全忽略 | — |

## 5. 每个 Agent 的配置
- 名称、头像（保留）、Harness（下拉，来自 Registry，显示检测状态与版本）。
- 工作目录（必填，绝对路径；可加 `additionalDirectories`）。
- 环境变量（键值）。原计划密钥类放系统钥匙串，尚未实现；当前团团专用 Key 存 SQLite 明文、专用接口打码，普通 Agent.env 仍是可读写配置。
- 额外 MCP 服务（团团的 handoff MCP 自动注入，不可删）。
- 默认权限策略：每次询问 / 本会话内记住 / 只读自动允许 / 全部自动（危险，需二次确认）。
- 启动参数（高级）：如 Grok `-m`、`--agent-profile`；OpenCode `--cwd`。
- 删除：System Prompt、Tools、Skills、模型选择这些字段（归 Harness）；可选保留一段「团团附加说明」作为每轮 prompt 前缀（决策 6）。

## 6. 删除与保留
**删除**：`server/router.ts`、`decision.ts`、`classify.ts`、`picker.ts`（话题选人）、`llm.ts`、`tool-loop.ts`、`tools.ts` 中的内置工具、`skills.ts` 与 `skills/` 目录、`config.ts` 的模型/provider/路由表部分、`config/providers*.json`、`.env.example` 里 `AGENT_HUB_MODELS*` / `DECISION_*` / provider Key、路由详情面板（「回复详情」里的分类、候选、回退）、相关测试与文档章节。`mock.ts` 改造成一个「mock ACP Agent」（用 SDK 的 agent 端写），供 e2e 和无 Harness 演示用。
**保留**：多 Agent 会话 / @ / @所有人 / 交接 / 跳数上限 / 打断、Bot 头像与表情（表情改由 ACP 状态驱动：thought=思考、message chunk=说话、tool_call=专注、permission=等待、错误=难过）、对齐与动效体系、SQLite（迁移重做：agents 表加 harness/cwd/env 引用，新增 acp_sessions、timeline_events、permission_rules）。

## 7. 安全
- 权限默认「每次询问」；「总是允许」按 Agent + 工具 kind + 路径前缀记忆，可在设置里撤销。
- **当前文件 / 终端边界（2026-10-15 纠正）**：ACP `fs/*` 按真实路径与最近现存父目录校验，拒绝工作目录外目标和符号链接逃逸。终端只校验启动 cwd，命令可访问其他路径；旧「文件与终端严格限定 workspace」描述过宽。没有操作系统沙箱，也不防御校验后的并发文件系统替换。目录外 ACP 文件请求直接拒绝，不通过权限弹窗放行。
- Harness 自己的工具（不走 `fs/*`）不受团团控制：在 UI 明示「该 Harness 在本机以你的权限运行」，并展示其沙箱选项（如 Codex 沙箱、Grok sandbox profile）。
- **凭据现状（2026-10-15）**：团团的服务商 / BYOK / Harness env_var Key 当前以明文存在 SQLite，专用公开接口打码；原生登录态归 Harness。钥匙串、严格的子进程 env 白名单是早期计划，尚未实现；当前继承登录 shell 环境并叠加配置，不应将普通 Agent.env 当成打码的密钥存储。
- 本机 Bun 服务（含 handoff MCP 与 WS）默认监听 `127.0.0.1`，HTTP / WS 共用 Host、Origin 与跨站检查；handoff MCP 另带内存 token。改变监听地址不启用远程鉴权。

## 8. 里程碑
- **M1：ACP 客户端 + 首批 4 个 Harness 的单 Agent 会话，完整能力 UI**（仍以浏览器 + Bun 服务形态开发，桌面壳放 M3）
  - SDK 在 Bun 下冒烟；HarnessRegistry（检测/路径/版本/认证提示），PATH 解析。
  - Claude Code、Codex、Grok Build、OpenCode 单 Agent 会话：流式、思考、工具卡片（diff + 终端）、plan、权限、configOptions（模式/模型/档位）、斜杠命令、图片与 @文件、取消、会话恢复（按能力降级）、usage。
  - mock ACP Agent + e2e：覆盖每种 update 的渲染、权限流程、取消、恢复；每个真实 Harness 一个手动验收清单（需要 Andy 的账号）。
  - 删除 Auto 路由及相关配置、文档。
  - **M1 状态（2026-10-14）**：已完成 SDK 在 Bun 下验证、注册表与检测、每 Agent 进程、会话映射与恢复、cwd 限制、权限弹窗、单 Agent 会话完整能力 UI、Agent 编辑字段、基础新手引导、删除 Auto 路由、mock ACP agent + e2e、迁移 6。握手实测：Claude Code（claude-agent-acp 0.90.0）与 OpenCode 1.19.0 无账号可建会话；Codex（codex-acp 2.2.2）与 Grok 1.0.52 初始化成功、建会话需登录。未完成：ACP `authenticate` 流程（目前只显示登录提示）、session/load 回放显示、新建会话时直接设主 Agent / cwd。
- **M2：多 Agent 会话 + 交接 MCP**
  - **M2 状态（2026-10-14）**：已完成 `tuantuan` MCP 服务器（HTTP `/mcp/<token>` + stdio 中转，按 `mcpCapabilities.http` 选择）、`handoff` / `list_members`（成员校验、去重、跳数上限、打断语义、交接卡片）、会话转述（上次发言后的新消息，8000 字上限）、引导页 ACP `authenticate` + 终端命令复制 + 重新检测、session/load 回放只读显示（按用户消息去重）、建会话时选主 Agent 和工作目录、README 截图更新。实测：OpenCode 1.19.0（免费模型，无账号）在 HTTP 和 stdio 两种传输下都完成了真实交接；Claude Code 未登录时 prompt 报需要登录；Codex / Grok 未登录无法建会话。：成员 session 管理、转述上下文、@ 路由、默认回复人（按决策）、handoff MCP、跳数与打断。
- **M3：桌面打包**：Electron 壳、登录 shell 环境解析、钥匙串、签名公证、自动更新、首次运行引导（检测并提示安装 Harness）。
  - **M3 状态（2026-10-15）**：`desktop/` 已完成：Electron 主进程拉起随包 Bun 服务端（随机本机端口、等 `/api/health`、退出时杀整个进程组）、单实例、macOS hiddenInset 标题栏（红绿灯居中在侧栏上方）、中文菜单、可选托盘、窗口位置记忆、登录 shell 环境导入、preload 桥接原生文件夹对话框（contextIsolation + sandbox，无 nodeIntegration）、图标、electron-builder（mac dmg+zip arm64/x64、win nsis、linux AppImage）、签名公证按环境变量开启、electron-updater 仅在配置发布时启用、GitHub Actions 打包。Linux AppImage 在 Xvfb 下端到端冒烟通过（`desktop/scripts/smoke.ts`）。未完成：钥匙串集成。未实测：macOS / Windows 包、签名公证、自动更新。
  - **2026-10-15**：桌面版 macOS 标题栏改为全列统一 52px 标题行（红绿灯居中在图标栏顶部，全屏时让回）；首次引导简化为一页三步。
- **Registry 接入（2026-10-15）**：官方 ACP Registry 客户端（缓存 + 随包快照 + schema 校验 + 6 小时刷新）、「更多 Agent」列表与搜索、npx / uvx / 二进制一键安装（团团目录、固定版本、sha256）、托管 Node 22 与 uv、更新与卸载、图标缓存、实验性 ZCode 桥接；Pi、GLM、MiniMax、ZCode、OpenCode、fast-agent 在 box 上真实安装并握手通过。
- **M4：更多 Harness 与扩展**：Gemini CLI、Goose / Kimi / Qwen Code；私有扩展（Claude 子 Agent / goal、Grok `x.ai/*` 回退、OpenCode fork）；视情况评估 ACP v2。

## 9. 风险
- ACP v1 → v2 迁移：v2 去掉 modes、fs/*、terminal/*，改动 prompt 生命周期。我们先做 v1，并把协议层隔离在 AcpConnection 内。
- 各 Harness 对 configOptions、plan、slash 命令、session list 的支持不齐，UI 必须完全按能力显示/隐藏。
- 账号与费用：Claude/Codex/Grok 需各自订阅或 Key；Grok Build 需付费档；e2e 不能依赖真实账号。
- 适配器版本变化快（Claude 适配器一年内两次改名迁仓），需锁版本 + 设置页显示版本。
- 多 Agent 会话里多个编码 Agent 同一 workspace 并发写文件会冲突：当前按用户决定允许不同 Agent 并行，仍共用项目目录；不自动加文件写锁或分配 worktree，任务职责由用户和 Agent 自定义协作约定。

## 10. 待定
- 多个编码 Agent 在同一项目目录并发写文件：目前共用目录、不同 Agent 并行；是否提供用户主动选择的独立 git worktree 未定。
- 团团层的附加说明（每轮 prompt 前缀、多 Agent 身份说明）是否全部交给各 Harness 的 AGENTS.md / CLAUDE.md。
  - **2026-10-15**：布局改为单侧栏 + 悬浮标题 + 气泡 + 右侧详情（成员）；头像新增小猫、小狗、兔子。

## 2026-10-15 本机边界与状态恢复修复

本轮保留本机单用户定位、现有 Harness / Registry 接入与存储结构，修复已复现的执行边界和状态恢复问题；不扩展成远程鉴权或操作系统沙箱。

| 范围 | 实现与边界 |
| --- | --- |
| HTTP / WebSocket | 默认 loopback；HTTP（含 MCP）与 WS 升级共用 Host / Origin / 跨站检查，兼容本机 Vite 代理及无 Origin 的原生客户端；`TUANTUAN_HOST` 显式配置监听地址 |
| ACP 文件 / 终端 | 文件真实路径与最近现存父目录检查，拒绝符号链接逃逸；终端仅检查 cwd，不隔离命令文件访问，也不隔离 Harness 自带工具 |
| 取消与恢复 | 初始化期间取消不发 prompt；已运行轮次先发 cancel，默认 4 秒超时强制回收 Harness / ACP 终端进程组，关联会话随后可重建 / 恢复 |
| 初始化失效 | opening 按配置签名与代次去重并在提交前核对；Agent 设置、项目目录或会话选择变更，以及停机后旧结果不能回写，旧请求以 409 要求重试；旧 load 失败仅清理自己仍拥有的映射 |
| 安装 | id / 版本目录段校验、独立随机暂存、发布前检查取消信号；取消 / 超时终止整组。uvx 固定 venv 路径仍直接安装到最终目录，失败清理 |
| 桌面退出 | 追踪独立子进程组及进程身份，服务端先退出时仍回收已记录组；POSIX ps 不可用时只有原组兜底，Windows 使用 taskkill 树 |
| 前端 | 最新快照加实时事件重放，跨 room 旧响应忽略；授权提交失败保留、提示并可重试，pending 防重复，成功 / 404 关闭 |
| 资料校准 | SQLite 实际迁移已至 16；专用 Key 为 SQLite 明文、专用接口打码，原生登录归 Harness；钥匙串仍未完成。早期调研、目标方案继续作为历史记录保留 |

状态：本轮修复与回归已完成，独立复审按原复现脚本确认前端慢快照、授权失败、目录变更、过期 load 清理以及桌面强退均已修复，无剩余必须修正项。当前检查中的 3 项失败通过隔离测试用户 HOME / 登录环境、分开真实适配器测试并设置合理超时、显式初始化 Registry fixture 修正；真实适配器只连接本地模型接口。

最终验证环境为 macOS、Bun 1.3.14（CI 仍固定 1.4.2）：

- `bun run check`：类型检查、Biome、全部测试通过；34 个测试文件，236 pass、6 skip、0 fail，1584 个断言。6 项跳过的是需显式启用 `TUANTUAN_REAL_REGISTRY=1` 的真实 Registry 安装测试。
- `bun run build`：通过；仍有既有的 Vite 原生配置加载兼容性及大于 500 kB 分包提示。
- `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' bun run e2e`：通过；包括慢快照期间停止按钮 / 权限弹窗保留、授权 503 重试、防重复提交、404 关闭、通知页清理、输入框布局及 Vite 代理。新增 `$` 回归覆盖超过 12 项的完整列表、末项键盘选择与滚动、名称 / 描述搜索、正文补全以及发送失败后草稿恢复；首次完整重跑曾遇到浏览器意外关闭，后续带浏览器日志的全程重跑通过，退出码为 0。
- 桌面类型检查与编译通过；完整测试包含真实 Bun 服务进程的正常退出、冻结后强退、忽略 TERM 后代回收与无关进程组保护。这里验证的是本机进程生命周期，未据此宣称 macOS / Windows 安装包、签名或真实付费模型验收通过。

## 2026-10-15 会话预览、额度、项目终端与引用回复

- 侧栏从独立的全局消息摘要更新，通知关闭及后台会话同样生效；重连刷新，慢快照不能覆盖新摘要。
- Grok 刷新额度改用自身 ACP `_x.ai/billing` 扩展，不建立会话或发模型请求；本机 Grok 1.0.52 只读查询返回套餐、周期额度和预付余额。移除 OpenCode 额度占位卡，保留其 Harness 功能。
- 增加项目内嵌交互式终端：每项目一个 Bun PTY，xterm.js 按需加载；支持输入、Ctrl+C、尺寸调整、收起、重连和显式结束。收起不停止命令，项目目录变更、删除及服务退出时清理；关闭期间拒绝重新打开旧实例。当前支持 macOS / Linux，主动脱离的任务保持 shell 语义。
- 增加群聊引用回复：服务端按同群已完成消息生成有界快照，迁移追加至 17；摘录进入 Agent 上下文，引用中的 @ 不参与新消息路由。失败保留草稿与引用，成功清除，刷新后保留已发送的引用。
- 本批交付时调度仍是房间串行、群聊新消息打断当前链；后续用户已授权变更，见下方「群聊并行调度」。未引入固定父子 Agent 模型或原生 provider 适配层。

验证：macOS / Bun 1.3.14 下 `bun run check` 通过（39 个文件、262 pass、6 skip、0 fail、1721 个断言），构建及完整 Chrome 冒烟通过。浏览器覆盖真实 PTY、Vite 代理、重连 / 取消 / 结束、引用持久化、发送失败保留、发送期间三类补全锁定及成功 / 失败后连续输入；浅色、深色和 390px 窄屏已检查。独立复审发现的焦点丢失与待发送草稿被补全改写已修复并按原场景复核。终端缩放用例曾因读取旧尺寸失败，改为等待界面与 PTY 尺寸同步后，整套重跑通过。Agent 对话使用 mock ACP；6 项真实 Registry 测试未启用，未运行本轮桌面包与 Windows 终端验收。构建保留既有的配置加载和大分包提示。

## 2026-10-15 群聊并行调度与终端动效

用户决定：不同 Agent 并行、同一房间同一 Agent 排队，新消息不自动打断；停止只影响指定任务及依赖它的交接。本节取代早期方案中的房间串行与新消息打断规则。

- Orchestrator 拥有任务图和 FIFO，taskId 标识单个任务，runId 关联原始人类消息，parentTaskId 关联实际交接来源。独立请求和同一消息的兄弟任务不互相取消；已回复的来源仍可停止未结束的交接。
- 保留原有 @ / 主 Agent 路由、每消息最多 5 次交接及 @所有人去重；并行调用同步预占预算，来源正常结束后才派发。排队任务明确携带原始请求与引用，后来的消息不替换其任务。
- MCP 在读取请求正文前捕获任务归属，BYOK 工具回调在 prompt 开始时捕获；旧请求不能在延迟处理后归到下一任务。固定 session endpoint 保持，完全在旧 prompt 结束后才发出的无轮次调用仍依赖 Harness 遵守生命周期。
- 前端显示运行、排队、停止中与交接中的任务，按 taskId 停止、失败重试、防重复提交，刷新与重连不被慢快照回滚。唯一任务保留输入框快捷停止，多任务通过列表明确选择。
- 取消超时只回收对应房间 / Agent 的进程。原先同 Agent 同目录的多个房间共用 Harness，强杀会误伤另一会话；现进程按房间 / Agent / 目录隔离，保留持久化 session/load，活动期间禁止重入 prompt 或切换 session。
- 删除会话 / 项目 / Agent、移除成员或变更目录 / 项目归属时同步释放对应 Host 资源并使初始化失效，避免隔离后的闲置进程泄漏；普通任务停止仍可复用会话。
- 待执行任务仅在服务内存中，浏览器刷新保留，服务重启不重放；不新增迁移。删除房间、项目变更或停机显式取消全部关联任务，移除成员只取消其任务及交接后代。
- 保留用户自定义 Agent 行为、ACP 接入和共享项目目录；未增加原生 provider 适配、固定 Agent 上下级或自动 worktree。
- 用户追加终端体验优化：展开 / 收起连续过渡、快速反向不中断布局、拖动跟手、保留 shell 与阅读位置；隐藏和后台重连不抢焦点，减少动态效果时直接切换。首次按需加载和结束终端共用面板外层，避免内容替换导致二次跳动。

验证：macOS / Bun 1.3.14 下 `bun run check` 通过（44 个文件、304 pass、6 skip、0 fail、1996 个断言），前端构建与完整 Chrome 冒烟通过。调度回归覆盖不同 Agent 并行、同 Agent FIFO、取消排队 / 活动任务 / 交接来源、独立任务继续、停止失败重试、刷新与慢快照、交接预算、迟到 MCP 请求及会话资源回收；独立后端复审发现的迟到请求归属与初始化期间删除竞态均按原场景复核通过。

终端使用真实 PTY：按需加载、展开 / 收起 / 结束分别采到连续中间帧，减少动态效果为 0 个中间帧；快速反向、固定内容尺寸、拖动 / 键盘调整、焦点与重连、聊天跟底 / 历史阅读位置、shell 保留和退出重开均通过。正常退出一度被迟到的 resize 错误覆盖，修正退出状态优先级后重跑整套通过。浅色、深色与 390px 窄屏已检查；`TERMINAL_VIDEO_DIR` 可保存浏览器原速录屏。

Agent 对话使用 mock ACP，6 项真实 Registry 测试未启用；未执行本轮桌面包或 Windows 终端验收，不据此声称真实 Harness 的全部并行行为已验证。构建保留既有的配置加载与大分包提示。

## 2026-10-15 回复状态提示

用户要求重新设计「XX 正在回复」。输入框上方改为默认收起的轻量状态条：头像、回复状态与排队数量；展开后保留请求摘要和按任务停止。单任务可直接停止，停止失败在收起时同样可见且可重试。只调整展示，任务与取消状态继续由原有服务端投影和请求状态提供，全部任务结束后移除状态条。

验证：类型检查、前端构建、完整 Chrome 冒烟及补充的调度冒烟通过；覆盖键盘展开 / 收起、单任务与并行 / 排队、停止失败重试、刷新与慢快照、交接停止、浅深色和 390px 窄屏。减少动态效果下圆点动画关闭，恢复设置后重新启用。`bun run check` 未全过：302 pass、6 skip、2 fail，另有 1 个测试间错误；失败集中在 `tests/harness-env.test.ts` 与 `tests/providers-real.test.ts` 的真实 Codex 适配器对本地 mock 模型接口的集成用例，后者 150 秒超时。这些后端链路未在本次修改，未将其记为通过；未重打桌面安装包。

## 2026-10-15 群主分工、跟进与汇总

用户决定：群主负责分工、跟进、接收成员结果和最终汇总，明确 @ 成员仍然直接对话。采用逐轮职责提示与服务端调度配合；选定群主只保存身份，不在进群时写死长期提示。

- 不 @ 的群聊请求冻结本轮群主，明确 @（包括群主）、@所有人 和单 Agent 新请求保持直达。更换群主从新请求生效，旧任务由原负责人收尾。
- 群主可独立完成简单请求，也可用既有 handoff 分派独立任务。成员正常完成、失败或取消全部收齐后，只排入一次群主跟进；继续分工仍共享 5 次预算，自动回流不计预算。
- 结果从本轮任务图和已保存消息收集，不依赖普通转述窗口；长回复以 read_result 按 6000 字符分页读取。list_members 提供身份说明，辅助按能力分工。成员不能继续转派，结果自动交回负责人。
- 后续跟进保持根任务的取消依赖；停止群主根任务结束整轮，取消单个成员则报告取消并禁止本轮自动重派，独立请求继续。移除成员使群缩为单人时，尚未结束的协调请求仍携带结果完成收尾。
- 修复单聊加成员变群聊后旧 session 没有协作工具的问题：Host 记录 MCP 接入状态，空闲时经现有 resume / load 刷新，保留支持恢复的会话历史；正在运行的回复和权限请求不被界面查询替换，下一任务再更新。
- 状态条增加「统筹中」「跟进中」，跟进消息保留收到结果的来源标记；加载 Harness 历史时剥离内部的职责与结果提示。继续复用 ACP、现有每 Agent FIFO 和时间线 JSON，无新增迁移。

验证：新增 20 项协调调度与 4 项会话缓存回归通过，覆盖整批结果收敛、错误 / 取消、续轮预算、不同请求隔离、换群主、缩为单人、移除群主、迟到工具调用、长结果分页；真实 mock ACP 的 stdio / HTTP 交接、旧单聊补接 MCP、历史与活动权限保持及加载历史回放均通过。类型检查、lint、构建和完整 Chrome 冒烟通过；浏览器包含双成员并行分工、自动跟进、最终汇总及状态条。辅助测试页面关闭后曾在补全步骤超时，恢复主测试页面焦点后完整重跑通过。

`bun run check` 未全过：327 pass、6 skip、2 fail，另有 1 个测试间错误。失败仍是 `tests/harness-env.test.ts` 与 `tests/providers-real.test.ts` 的真实 Codex 适配器对本地 mock 模型接口用例，后者 150 秒超时；与上次回复状态改动时的失败一致，未记为通过。模拟 ACP 只证明调度和工具接入，不证明真实模型的分工与汇总质量；未重打桌面安装包。

## 2026-10-16 Skills 来源、Registry 额度与会话体验

- Skills 以实际来源区分「原生可用」和团团为当前 Agent 额外选择的项；Antigravity 的 GEMINI_HOME、项目 `.agents/.gemini` 纳入原生来源。按真实路径合并来源，历史未知归属的链接保持原样。新选择只生成该 Agent 的按需索引和可撤销只读范围，不再向共享项目写链接，避免影响其他 Agent；BYOK 只读取已选择的 Skill。身份与索引不干扰前导斜杠命令，异步命令声明未到达时同样保留原始内容；历史回放剥离内部索引。
- 已安装或已配置的 Antigravity / ZCode 增加额度卡片。只通过 Harness 自身的 `/usage` 或 `account/usage_stats` 查询，登录 / 握手成功后在同进程同步，手动刷新单飞。登录改变账户状态时，在旧查询结束后执行新查询，防止旧未登录结果吞掉同步。仅缓存公开额度、套餐、时间与状态；失败清除旧数字，页面读取不启动登录或模型请求。
- 本机 Antigravity 1.4.0 已用原生 `/usage` 读到套餐、模型组周额度及 5 小时额度。ZCode 原生团队渠道可用，而已安装的社区桥接 0.70.0 将旧 Coding Plan 别名映射到个人渠道，团队认证未支持；核对 0.72.0 后该限制仍存在。因此不把 1113 解释为团队余额不足，不自动换账号、改凭据或引入原生 provider 适配；界面和文档明确桥接查询只代表个人渠道。
- 项目终端扩为多个独立标签页，保留每个 PTY、输出与连接；收起、切换和刷新不结束其他终端，单独关闭和项目整体清理区分处理。整项目关闭期间禁止新建；隐藏的 xterm 保持可测量尺寸，避免回放后停留在旧视口；退出重开在连接与输入真正就绪前保持忙碌，并恢复焦点。
- 流式消息不再按离底距离强行拉回：任何向上滚动立即暂停跟随，后续文本、工具与布局变化保持阅读位置。回到底部、「回到最新」和发送新消息可恢复；发送响应尚未返回时再上滚，仍以用户最新意图为准。
- 熊猫眼斑与眼睛间距单独校正，其他形象保持原表情；模型选择器增加行高，避免 `Argon` 的 `g` 下缘被裁切。终端窄屏多标签只在标签栏内部滚动，沿用展开 / 收起与减少动态效果行为。

验证：macOS / Bun 1.3.14 下 `bun run check` 通过（49 个文件，355 pass、6 skip、0 fail、2544 个断言），构建和完整 Chrome 冒烟通过。浏览器覆盖持续流式输出中 8px 上滚、历史阅读与回底、布局变化、延迟发送响应、多终端独立输入与后台输出、刷新恢复、退出重开就绪与焦点、Skills 完整清单及不跨 Agent 泄漏、额度卡片刷新；浅深色和 390px 窄屏已检查。独立审查发现的命令声明延迟、握手失败保留旧额度、登录与旧查询竞争均补充确定性回归。全量检查发现的内部索引泄漏到历史回放，以及浏览器发现的终端重启空窗均修复后重跑通过。

Agent 交互使用 mock ACP，项目终端使用真实 PTY；Antigravity 原生只读额度查询已验证，ZCode 团队限制按原生运行记录与锁定桥接源码核对。6 项真实 Registry 安装测试未启用，未重打桌面安装包、验证真实触摸设备 / Safari / Windows 或宣称真实模型质量通过。构建仍有既有的大分包提示。

## 2026-10-16 图文渲染与放大预览

- 用户确认接入 Mermaid 并保持当前视觉，随后明确图表与图片共用放大预览；保留聊天内的紧凑布局。Markdown 表格、普通代码高亮与链接继续可用。
- 仅显式 Mermaid 围栏按需加载渲染器，主题和字体来自现有 token；渲染队列隔离全局配置，流式片段延迟合并，过期结果不回写。错误或不支持的配置 / 资源语法保留源码，后续修正后恢复。
- Mermaid、Markdown、ACP 时间线与工具图片共用原生模态预览，支持适应窗口、原图、滚动、键盘关闭及焦点恢复。相同源码在换主题时保持预览与原图模式；普通流式增量不关闭预览或改变阅读位置。
- 独立审查发现 sequence `properties` 在测量 DOM 中仍可请求外部图片，已在渲染前拒绝并补回归；嵌套图片链接保留独立外链入口；主题重绘改为保留同一预览实例。复核原场景通过。
- 本机 Antigravity ACP 1.4.0 在真实团团客户端身份下只返回 `gemini-4-argon` 与 `gemini-3.8-flash`。已核对前端未丢弃模型，以及该版本按客户端开放第三方模型的逻辑；不能据此推断 Antigravity 所有客户端都没有 Opus，也不判断账号套餐权限。只读建会话未发送模型 prompt。
- 完整冒烟发现已有引用回复夹具漏处理直接 `/session` HTTP 响应，晚到时覆盖测试补全；统一快照、WS 与 HTTP 的夹具内容后，普通次序和强制晚到场景均通过，产品逻辑未变。

验证：macOS / Bun 1.3.14 的已有依赖环境中 `bun run check` 通过（51 个文件，371 pass、6 skip、0 fail），前端构建和完整 Chrome 冒烟通过；新增场景覆盖流程图、时序图、源码回退、流式恢复、明暗主题、所有预览入口、原图 / 适应窗口、键盘焦点及 720px 窄屏。使用 CI 同版本 Bun 1.4.2 在隔离目录对提交锁文件执行 `bun install --frozen-lockfile --ignore-scripts` 通过，功能提交 `a38c951` 的远端 CI 通过。README 同步安装版本要求，避免 Bun 1.3.14 无法解析 v2 锁文件。

浏览器使用真实构建页面与持久化测试数据，Agent 交互仍为确定性 ACP 数据；6 项真实 Registry 安装测试未启用。本轮未重新打包桌面应用或验证 Safari / Windows，不将前端冒烟等同于已安装桌面版本更新。PR：[图文渲染与共享预览 #8](https://github.com/bosshanz/tuantuan/pull/8)。

## 2026-10-16 会话可靠性修复

用户授权修复本次审查确认的三项问题：聊天重载后只能回看最近 200 条；已存在的 ACP 会话未同步用户 MCP 配置变更；BYOK 历史无界增长且重启后上下文不同。本批不包含 CI 扩展、真实模型效果评估或提交发布。

- 历史分页复用消息 `seq` 和 `Store.recentMessages` 的游标查询，保留阅读位置、实时状态与已加载窗口；重连跨过一页时先补中间缺口，再向前加载。缺口游标依赖现有每房间 seq 连续递增且无单条消息删除的契约。
- MCP 接入按完整有效配置刷新，活动任务继续使用原会话，下一次空闲挂载应用变更；配置相同不重连。初始化发布前核对服务器记录和插件配置，防止初始化期间删除绑定或修改插件后发布旧配置。按 Harness 的 resume / load 能力保留历史，不支持时新建会话。
- BYOK 追加迁移 v18，以 `custom_history` 保存完整成功轮和工具配对，最多 20 轮。每次模型请求（包括工具续请求）按实际完整 body 检查 65,536 序列化字符上限；只淘汰完整旧轮，当前轮自身超限在发送前报错。字符预算不是 KiB 或 token 窗口。
- BYOK 缺行时仅从 DM 最近转写恢复同一 run 中成功的任务与回复，群聊从空开始。新会话、成员移除及项目目录 / 归属重置保存 `[]`，重启不恢复旧上下文；普通停机保留成功上下文，房间 / Agent 删除由外键级联清理。取消、失败和资源释放后的迟到完成不提交半轮。

实施分工：Claude 负责 MCP / BYOK 后端与定向测试，Sol 子智能体负责分页 API / 前端与回归；团团负责整合修正、项目资料同步及全量验收。两位未参与实现的 Sol 分别独立审查分页和后端；复现的重连缺口、请求预算、初始化竞态、重置、取消及群聊恢复问题均按正确行为断言复核关闭。

分页 22 项定向测试通过，Chrome 专项覆盖 451 条连续分页、703 条含断线缺口的回看、实时更新、失败重试与焦点、切换会话、刷新、390px 窄屏，以及分页期间回到底部 / 发送消息。专项入口为 `bun scripts/e2e-chat-history.ts`，已接入完整冒烟。后端独立正确行为探针 10 项通过，覆盖精确请求边界、工具续请求、MCP 初始化竞态、跨 Store / Host 重置恢复、最终 SSE 回调取消与旧群聊恢复。

最终验证：`bun run check` 通过（54 个文件，403 pass / 6 skip / 0 fail，2,841 个断言），类型检查通过，lint 保持既有 24 个 warning / 4 个 info；`bun run build` 与完整 `bun run e2e` 通过。构建仍有既有大分块提示。最终补充的旧群聊恢复用例已包含在这轮全量结果中。

本轮使用 macOS / Bun 1.3.14 的已有依赖环境；浏览器使用本机 Chrome、真实构建页面和隔离持久化数据，模型 / ACP 行为仍为本机 mock。未启用 6 项真实 Registry 安装测试，未重打桌面包或调用真实模型，也未执行首次安装验证；不将源码修复等同于已安装桌面应用更新。

## 2026-10-16 主流 Harness 服务商与任务防休眠

用户要求团团保存的自定义 API 能用于 Claude Code、OpenCode、Pi、Codex，其余 Harness 沿用原生配置；随后追加任务运行时阻止电脑休眠的可选开关。

- 前后端共用地址 / 格式 / 模型兼容判断；OpenCode、Pi 要求主模型，双地址优先 OpenAI。Codex 仍需服务商实际支持 Responses，表单选择不做协议转换。阻止把已绑定 Agent 的必需配置删掉后静默退回本机。
- OpenCode 用进程配置，按 V1 / V2 格式接入；Pi 用临时启动脚本和原生 provider 扩展，不隔离原生配置目录。Key 只传进程环境，临时文件不含 Key，进程退出清理。新建与恢复会话都确保使用当前服务商模型，模型选择限于该服务商。
- Claude Code / Codex 已有接入按锁定适配器复核。旧本地回归失败由系统代理拦截回环地址导致；仅给测试环境添加 NO_PROXY/no_proxy，并用临时启动脚本固定测试 bundled adapter。真实适配器对本地 mock 回归 8 pass，未调用真实付费模型。
- 任务防休眠默认关闭，桌面主进程按全部会话状态控制 prevent-app-suspension，允许屏幕熄灭；设置持久化，完成 / 失败 / 取消 / 关闭开关 / 退出释放。浏览器版本明确不支持系统休眠控制。

验证：`bun run check` 通过（59 个文件，432 pass / 13 skip / 0 fail，3,040 个断言）。OpenCode v2.0.29、pi-acp 0.0.34 / Pi 1.0.4 的三协议验证与 runtime 单测合计 15 pass；另用校验和匹配快照的 OpenCode v1.19.0 通过 3 项真实进程验证。Chat 断言成功 SSE 文本、切模型、修改服务商后恢复；Responses / Anthropic 断言实际请求的地址、Key 和模型，模拟端点故意拒绝请求，不宣称真实模型响应质量。V2 原生 provider 策略拒绝时保持策略且明确失败。

任务防休眠单测与真实服务端活动流 9 pass；本机 Electron 44.7.2 用 `powerSaveBlocker.isStarted` 验证启动、最后任务结束、关闭开关、持久化恢复与退出释放。根目录和桌面类型检查、桌面编译通过。Pi 任意模型的文本能力 / 上下文占位限制已写入服务商文档。

前端构建与完整 Chrome 冒烟通过，新增覆盖服务商兼容提示、OpenCode / Pi 切换与默认模型清理，以及休眠开关的浏览器禁用、桌面桥接、持久化、保存失败保留原值和 390px 窄屏。修复通知页在窄窗口下被隐藏的问题。最终类型检查通过，lint 保持既有 24 个 warning / 4 个 info。

13 项默认跳过为 7 项可选真实 Harness 验证和 6 项真实 Registry 安装；前者已单独运行上述验证，后者未启用。浏览器桌面桥接为模拟，系统防休眠依据上述原生 Electron 检查。未提交或更新已安装桌面包；未验证 Windows 启动器或真实付费模型。工作区原有的两个 lockfile 改动保留。

## 2026-10-16 四语言界面

- 「设置 → 个人资料 → 界面语言」提供简体中文、繁体中文、英语、日语，默认简体中文。选择后自动保存，成功后即时生效；失败保留草稿并可重试。个人资料按顺序提交连续修改，避免旧请求覆盖新选择。
- `profile.language` 复用 SQLite 的个人资料设置；`localStorage` 仅缓存启动语言。服务端通过 `profile.updated` 广播已保存配置，窗口重连时补读，迟到的旧读取不能覆盖新配置。
- 前端页面、Harness / 服务商 / Skills、状态、确认框与无障碍文案共用语言目录；桌面菜单、托盘及系统通知的应用提示接入同一语言。聊天与 Agent 正文、名称、路径和模型 ID 保留原值；未知第三方诊断保留原文，语言设置不进入 Agent 指令。
- 英语与日语较长文案暴露的 390px Token 统计按钮 / 图例及 Skills 分类截断已修复；服务商表单保留内部滚动和可达的保存按钮。

已完成类型检查、定向 Biome、字典键与占位符检查及前端构建。Chrome 定向验证使用隔离 SQLite 与本地 fixture，覆盖英语 / 日语、1440px / 390px 共 28 屏，个人资料语言真实保存、服务商新增与编辑保存、Agent 编辑与保存、自定义 API、Mock 握手、Harness 和 Skills 页面均通过；未发现相关中文残留、横向截断或页面错误。

上述浏览器场景不调用真实模型，也未在真实 Electron 会话中实测原生菜单显示；菜单语言接入与浏览器验证不能等同于原生菜单验收。本轮未重新发布或更新桌面安装包。

## 2026-10-16 DeepSeek 思考能力与默认等级

- 观察：Pi 临时 provider 把所有自定义模型统一标记为 `reasoning: false`，导致 ACP 只返回 `off`，而请求未发送关闭字段；OpenCode 自定义模型缺少准确 variants；Codex 不认识目录外模型时不返回 reasoning picker。三者机制不同，不能只改界面默认文案。
- 对 DeepSeek 预设或官方地址上的 `deepseek-v4-pro` / `deepseek-flash` 声明已核实能力。Pi 使用协议兼容元数据，OpenCode 按 V1 / V2 配置真实 variants，Codex 启动时加载无密钥临时模型目录；其他模型保持原生行为，不猜测支持档位。Codex 保留 0.160.1 完整通用编码指令、原生上下文及截断默认，不用简化提示词替代。
- 新会话和服务商探测通过真实 ACP 设置应用 `high`，会话明确选择和 Agent 默认更优先。应用显式模型选择后再计算推荐值，避免把 DeepSeek 推荐值套给其他模型。恢复会话不应用新推荐值；实测 Codex 会丢失原生等级，因此重放团团明确记录的会话 `reasoning_effort` 或 Agent 默认选择，前者优先；未记录时沿用原生值，不套服务商自动默认。
- 请求验证：真实 Pi 1.0.4 / pi-acp 0.0.34 的 Chat、Responses、Anthropic 三协议 3 pass / 69 断言，验证 off/low/high/max、关闭后恢复、Chat 工具续轮与全部 assistant 推理字段回放。OpenCode 1.19.0 / 2.0.29 三协议合计 6 pass / 238 断言，验证 ACP 选择、high 默认应用、none/max 出站与 Chat 工具续轮。Responses / Anthropic 模拟端点记录后故意返回 400，只证明请求契约；未调用真实付费模型。

Codex 0.160.1 / codex-acp 2.2.2 的离线 model/list 与真实 ACP、本地 Responses fixture 验证通过（27 断言）：默认 high、none/low/high/max 实际参数、完整通用指令、用户 `model_instructions_file` / `developer_instructions` 覆盖。按实际 managed / PATH adapter 解析配套 CLI，保留解释器；外部私有 adapter 无法解析时维持原生行为。启动路径、隔离与清理单测 7 pass / 38 断言；Windows 实机未测。

四语与思考设置整合验证：`bun run check` 通过（486 pass / 20 skip / 0 fail，8,856 断言，67 文件）；最后补齐 Codex Agent 明确默认恢复和实际 adapter 路径后，相关 49 项回归、类型检查、lint 再次通过。lint 为 22 warning / 3 info，无 error。20 项默认跳过包含 14 项可选真实 Harness 测试（已按各自协议另跑）及 6 项真实 Registry 安装（未启用）。

前端构建、完整 Chrome 冒烟、桌面类型检查与编译通过。四语个人资料检查覆盖保存/重载、跨窗口同步、快速连续修改、失败重试、离开页面前保存；聊天定向检查 41 项覆盖英文/日文、1440px/390px、弹层即时更新、草稿与真实终端连接保持。原生菜单显示和真实付费模型未验收，未替换当前运行的桌面应用。

## 2026-10-17 模型能力目录与四 Harness 思考适配

将上一阶段的 DeepSeek 专项扩展为 models.dev 目录与 Pi AI 兼容规则驱动的 Claude Code、OpenCode、Pi、Codex 适配。内置 231 个服务商 / 8,902 个模型；每个 Store 独立管理目录，主动同步才下载无凭证公共数据（30 秒 / 15 MB），白名单校验后持久化，失败保留旧目录。服务商捕获不可变目录快照供已有进程使用，更新不打断任务。追加迁移 19 与 `modelCatalog` 能力引用映射，表单可分别关联主 / 快速模型，保留请求 ID；未知能力不猜测。

思考设置按会话 → Agent → 已识别的明确原生配置 → 团团推荐 → Harness 排序，仅应用真实支持的选项。恢复和切模型重放明确选择，暂不支持的意图保留。Claude Code 原生 ACP 无 off，不合成关闭选项；Codex 继续要求 Responses，保护 0.160.1 内置模型及用户目录；Pi 开关模型将原生 high 显示为开启，OpenCode V1 Kimi Anthropic 的固定原生 high 也不增加虚假等级。当前规则与版本边界见 [服务商](providers.md#模型能力目录与思考等级)。

四个 Harness 的真实 CLI 对本机 mock 已验证能力选项、选择及请求参数，其中 OpenCode 1.19.0 / 2.0.29 各 12 项，包含 DeepSeek Chat 工具轮推理回放；Kimi Anthropic 的 16,384 token 预算在两版另作窄复核。Pi 1.0.4 / pi-acp 0.0.34 的 7 项通用能力与预算边界验证通过，预算不足时确认没有发出 HTTP 请求。Codex 原生文件中的明确等级与 Pi 原生设置优先于团团推荐，复杂项目配置留给 Harness 的信任和优先级机制处理。部分协议故意返回 400，仅证明请求契约；未调用付费模型。

最终 `bun run check` 通过：74 个文件、606 pass / 38 skip / 0 fail、9,684 个断言；lint 为既有 22 warning / 3 info，无 error。前端构建、完整 Chrome 冒烟、桌面类型检查与编译通过。同步界面另在隔离数据库中验证一次真实 models.dev 下载，以及失败保留本地目录、主 / 快速模型来源保存重开、目录删除旧引用后仍可编辑、四种语言的 390px 布局与固定保存栏。开关型 Thinking 的原生 high ID 正确显示为「开」，不再被前端误译为「高」。完整冒烟首次因新增能力字段与旧模糊定位重名而失败，改为精确标签后重跑通过。

默认跳过项包含可选真实 Harness 测试和 6 项真实 Registry 安装；四个 CLI 的本地 mock 验证已单独运行，Registry 安装本轮未启用。未验收真实模型效果、Windows 实机或原生菜单显示，未替换当前运行的桌面应用。模型目录、Pi AI 参考与 Codex 通用指令的许可证及来源已登记；用户授权维护文档并提交推送，工作区原有两个 lockfile 改动不纳入提交。

## 2026-10-17 跟随实际 ACP / CLI 更新能力

用户要求能力随实际 ACP / CLI 更新，取代上一阶段的固定 Codex 模型名单、通用指令副本与固定思考等级枚举。

- `harness-runtime.ts` 统一实际启动身份及 Codex 命令解析。Host 与选项缓存观察适配器、配套引擎、文件身份及安装代次，同路径更新也会失效。安装完成只标记失效，活动回合继续；空闲接入再更换进程、恢复会话与明确选择。旧版本在途探测不能覆盖新版缓存。回归包含旧版暂不支持的 `ultra` 意图在升级后实际恢复。
- Codex 从所选 CLI 导出完整 bundled models 和公开 effort schema，保留原生条目全部字段。通过隔离 HOME 的未知模型空会话、归档及读取临时 rollout 获取当前 generic 指令；验证返回的模型 / provider 未被替换，路径位于临时目录，且不发起 turn / 模型请求。原生与自定义主 / 快模型可以混合，仅追加有能力依据的目录外条目。删除固定 0.160.1 提示词及其分发副本说明；探测失败记录诊断并保留原生配置。
- 模型目录接受有界的新 effort ID。Pi 从实际引擎的公开 compat API 读取等级，Claude 使用真实 ACP choices，OpenCode 对自动生成的变体再与模型能力求交集；明确的 `off` / `none` 等原生 ID 继续保留。推荐排序只代表已知语义，不限制未来可选等级。
- OpenCode 不再把任意未来主版本当作 V2。未知版本在临时 HOME 中通过当前 CLI 的公开命令禁用后台服务、读取候选配置并确认结构，缓存随引擎身份变化；探测进程和临时文件会清理。当前这条未知版本探测依赖 macOS sandbox 与公开 service 命令；其他平台或无法识别的协议明确报错。已验证的 V1 / V2 路径保留。Codex rollout 格式仍属于上游可变接口，结构变化会回退原生行为。

验证：`bun run check` 通过（77 个文件，632 pass / 39 skip / 0 fail，9,864 个断言），lint 保持既有 22 warning / 3 info；构建与完整 Chrome 冒烟通过。新增诊断的四语言字典另通过 6 项 / 5,830 断言检查，末次类型检查、lint 与构建通过。Chrome 冒烟使用本机 `CHROME_PATH`，默认 Linux 路径在 macOS 不存在。

实际进程对本机模拟端点复核：Codex 0.160.1 / ACP 2.2.2 为 2 项 / 67 断言，确认生成目录中的全部原生描述与 CLI 导出逐字段一致；OpenCode 2.0.29 为 13 项 / 234 断言，含未知版本配置探测及服务清理；Pi 1.0.4 / pi-acp 0.0.34 为 7 项 / 151 断言；Claude ACP 0.90.0 / SDK 0.3.296 / CLI 2.1.296 为 1 项 / 8 断言。未来等级与同路径替换通过确定性 CLI / ACP fixture 验证，不代表已验证尚未发布的 CLI。未调用真实付费模型、重跑 Registry 安装或替换现用桌面应用。用户已授权维护文档、提交推送，原有两个 lockfile 改动继续保留。
