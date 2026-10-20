# 团团 Tuantuan 架构

## 背景与约束

- 本机使用：一个 Bun 进程 + 一个 SQLite 文件，无用户鉴权、无多实例。`serve` 和 `server/main.ts` 默认监听 `127.0.0.1`；`TUANTUAN_HOST` 可改监听地址。HTTP（含 MCP）和 WS 升级共用请求边界：URL / Host 必须是回环地址，提供 Origin 时必须为 HTTP(S) 本机来源，拒绝 `Sec-Fetch-Site: cross-site`。这允许本机 Vite 代理和不带 Origin 的原生客户端，不构成远程访问鉴权。桌面版（`desktop/`）是 Electron 壳：主进程把同一个 Bun 服务端作为子进程跑在随包 Bun 上，窗口加载它的本机地址。
- 编码 Agent 通过 ACP（JSON-RPC over stdio，`@agentclientprotocol/sdk` 1.8.0）驱动 Harness，模型和原生登录由 Harness 管理；BYOK 是团团直接调用模型的轻量对话例外。团团配置的服务商 / BYOK / Harness `env_var` Key 由 SQLite 保存，原生登录凭据仍由 Harness 保存。
- 没有任何账号也必须可测试 → `server/mock-agent.ts` 是一个确定性的 ACP agent（`TUANTUAN_MOCK_HARNESS=1` 时可选）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/main.ts` | 打开数据库，按本机监听地址启动服务；退出时先停止调度，再关闭 Harness、安装任务与项目终端，桌面父进程看门狗 |
| `server/project-terminal.ts` / `shared/project-terminal.ts` | 项目交互式终端：Bun PTY、每项目多个独立 shell、输入 / 尺寸校验、有界输出重放、退出与进程清理；独立于 ACP 工具终端 |
| `server/app.ts` | HTTP API（参数校验）、WebSocket 订阅、静态文件；HTTP / WS 共用 Host、Origin 与跨站请求检查 |
| `server/harness.ts` | Harness 定义（常用 7 个 + mock，及 `reg:<id>` 形式的任意 Registry Agent）：启动命令、安装与登录提示、身份文档传递方式；登录 shell 环境（PATH）解析、`which`、版本检测、绝对路径覆盖、来源判定 |
| `server/harness-runtime.ts` | 所选 ACP 与配套引擎的启动身份、Codex 命令解析及安装失效代次；Host 进程与探测缓存共用，不把 Registry / ACP 版本误当作底层引擎版本 |
| `server/registry.ts` | 官方 ACP Registry 客户端：本地缓存 → 随包快照兜底、zod 校验（坏条目跳过）、6 小时刷新、图标缓存（只接受 SVG）；平台键；补充的实验性条目（DeepSeek 官方预发布、ZCode 桥接），明确区别于上游收录 |
| `server/managed.ts` | 团团安装的 Harness（`<数据目录>/harnesses`）：npx 包用 Bun 或托管 Node 22（`npm install --omit=dev`）、uvx 用 uv（用户的或下载的）、二进制按平台下载 + sha256 校验 + 解压；`manifest.json` 记录版本与命令；卸载 |
| `server/harness-secrets.ts` | 按 Harness 保存的 API Key（`settings.harnessEnv`，打码给前端，只注入该 Harness 进程）；打开终端（osascript / x-terminal-emulator…）；缺 Key 错误识别在 `shared/auth.ts` |
| `server/installer.ts` | 安装任务：命令只来自定义（不接受请求里的命令）或 Registry 任务；日志流、取消、超时 |
| `server/acp.ts` | `AcpProcess`：启动 Harness 并用 SDK `ndJsonStream` 连接；`fs/*` 校验真实路径与最近现存父目录；选中的 Skill 目录额外只读授权，每轮替换；`terminal/*` 只约束启动 cwd；权限请求、终端输出与 stderr 尾部 |
| `server/process-tree.ts` | Harness、ACP 终端与安装命令的进程组启动 / 回收；POSIX 按组发信号，Windows 使用 `taskkill /T /F` |
| `server/custom.ts` | BYOK「自定义 API」harness：OpenAI Chat / Responses / Anthropic Messages 的 SSE 流式与 tool call，输出 ACP `session/update`；Key 只在服务端 |
| `server/skills.ts` | Skills：解析 SKILL.md；统一原生来源与 Agent 选择，按需路径索引；导入（目录 / git / GitHub / SKILL.md 链接，先预览再选）；不写共享项目链接；BYOK 的 `load_skill` 仅访问当前选择 |
| `server/providers.ts` | 服务商：预设、Key 打码、按 Harness 注入（Claude Code 用进程 env，Codex 用 ACP `providers/set` + `CODEX_CONFIG` 里的 model，BYOK 直接用）、测速、公开余额接口、只读导入 CC Switch |
| `shared/providerSupport.ts` / `server/provider-runtime.ts` / `server/provider-reasoning.ts` | 前后端共用服务商兼容规则；消费统一模型能力，生成 Pi 兼容元数据、推荐值及各 Harness 进程配置。探测和实际会话使用同一注入入口；Pi 保留原生配置目录，临时文件不含密钥并在退出时清理 |
| `server/model-catalog.ts` / `model-catalog-schema.ts` / `model-capabilities.ts` | 每个 Store 的目录实例、能力契约、官方地址 / 预设 / 显式引用识别、搜索、受限下载和字段白名单校验；数据来自内置或持久化快照 |
| `server/provider-opencode.ts` / `provider-codex.ts` / `provider-claude.ts` | OpenCode V1 / V2 variants、Codex 临时目录与内置目录保护、Claude Code 自定义模型能力及真实 effort 选项限制 |
| `usage_log` 表 | 每轮 Token（Harness 报告的 usage、模型、缓存读 / 写、思考、费用差分）；`GET /api/usage/stats?since=&tz=` 按 Agent / 模型 / Harness 汇总并按天分桶，`reporting` 列出报告过数据的 Harness |
| `server/library.ts` | 「Skills 与插件」：只读扫描 ~/.claude / ~/.agents / ~/.codex / 项目目录，解析 Claude 插件（plugin.json），导入到 `<data>/library`（更新 / 删除），算各 Harness 支持；按 Agent 勾选的插件在建会话时变成 Claude `_meta.claudeCode.options.plugins` 或 Skill 索引 + stdio MCP |
| `web/src/brands.ts` | 模型 id → 厂商（含 `openrouter/…`、`anthropic/…` 前缀），未知一律中性图标；Logo 来自 @lobehub/icons（MIT） |
| `server/usage.ts` | 用量：读 `~/.claude/projects` / `~/.codex/sessions` 的 JSONL，解析 Claude Code `/usage`、Codex `/status`、Grok CLI 会话用量及 ACP billing 额度；未知值保留为空 |
| `server/registry-usage.ts` | Registry Harness 的原生额度查询与解析；Antigravity `/usage`、ZCode `account/usage_stats`；不读取凭据或改变登录渠道 |
| `server/dirpicker.ts` | 选择文件夹：系统对话框（osascript / zenity / kdialog，可由桌面壳替换）+ 应用内浏览器的目录列表与常用位置 |
| `server/host.ts` | `HarnessHost`：按「房间 + Agent + 工作目录」隔离进程；会话 ↔ ACP session 映射（`acp_sessions` 表，重启后 resume / load）；prompt、cancel、配置项 / 模式、会话列表与切换；同房间同 Agent 防重入，权限请求挂起直到用户回答 |
| `shared/attachments.ts` / `server/attachments.ts` | 附件数量、大小、编码契约；UTF-8 文本内联、二进制原件托管与精确只读路径授权 |
| `web/src/composerAttachments.ts` / `FileAttachments.tsx` | 按房间串行读取附件、预览与安全下载；草稿仍由 `chatWorkspace.ts` 拥有 |
| `server/conversation-files.ts` / `shared/conversationFiles.ts` / `web/src/ConversationFiles.tsx` | 从持久化消息派生会话文件元数据并分页；内容接口重新解析来源、验证项目文件范围；前端按需下载 / 预览，来源定位复用聊天导航 |
| `shared/timeline.ts` | 把 `session/update` 折叠成时间线（文本、思考、工具卡片、计划、用量）；服务端持久化和前端渲染共用 |
| `server/tuantuan-mcp.ts` / `server/mcp-shim.ts` | 团团自己的 MCP 服务器：`/mcp/<token>`（JSON-RPC over HTTP POST）；token 对应「房间 + Agent」，只在内存。Harness 支持 HTTP MCP 时直接连，否则启动 stdio 中转脚本。工具由 Orchestrator 提供 |
| `server/orchestrator.ts` | 每房间的任务依赖图与每 Agent FIFO 队列；直达 / 群主统筹路由、逐轮职责、成员结果收集与群主续轮、单个 Agent 回合、交接预算与定向取消 |
| `server/task-context.ts` | 结构化任务笔记的共享 schema 与运行时校验、交接长度契约、带省略标记的正文首尾摘录 |
| `server/mentions.ts` | 人类消息里的 `@名字` / `@所有人` 解析（忽略引用、代码和转述行）；Agent 回复不解析 |
| `server/store.ts` | SQLite 迁移与读写 |
| `server/profile.ts` | 个人资料校验与默认值，`language` 限定为 `zh-CN` / `zh-TW` / `en` / `ja`；生成给 Agent 的用户说明时不包含界面语言 |
| `shared/i18n.ts` / `shared/locales/*` | 前端、服务端通知与桌面共用的文案目录、占位符替换及日期语言映射；已知应用错误按限定模板翻译，未知诊断保留原文 |
| `web/src/i18n.ts` / `Profile.tsx` | 响应式界面语言与启动缓存；个人资料编辑草稿、串行保存和失败重试 |
| `web/src/Harness.tsx` | 时间线渲染（工具卡片、diff、终端、计划）、权限弹窗、会话栏 |
| `web/src/Onboarding.tsx` / `Setup.tsx` / `Registry.tsx` | 首次引导（一页三步）；Harness 管理页；「更多 Agent」（Registry 列表、安装、握手、图标） |
| `desktop/` | Electron 壳：主进程启动随包 Bun 服务端（子进程组、`/api/health`、父进程看门狗）、单实例、菜单、preload（文件夹对话框、全屏状态）；`scripts/` 打包（stage / electron-builder / afterPack）与 Xvfb 冒烟 |
| `desktop/src/power.ts` / `shared/desktopPower.ts` | 桌面任务防休眠：主进程拥有唯一 prevent-app-suspension 实例，监听全局 activity 并用全部房间快照校准；增量覆盖在途旧快照，断线释放并重连恢复。偏好保存到 userData/settings.json，preload 只提供状态与开关 |
| `server/avatars.ts` | 头像轮廓与颜色定义、按 Agent id 的确定性默认头像（FNV-1a），前后端共用 |
| `web/src/*` | React 前端：哈希路由、三栏布局、Agent 编辑、聊天视图、Cmd+K；样式为手写 CSS 变量（无 Tailwind），主题 token（颜色、圆角、阴影、字体）在 `styles.css` 顶部；字体由 `@fontsource-variable/plus-jakarta-sans` 自托管 |
| `web/src/BotAvatar.tsx` / `avatarState.ts` / `AvatarPicker.tsx` | SVG Bot 头像（轮廓 + 表情 + 仅 transform 的动画）、消息/成员状态 → 表情映射、头像选择器；预览页 `#/dev/avatars` |
| `web/src/chatState.ts` | ChatView 的服务端投影视图 reducer：只落地当前房间最新请求的快照，重放请求期间的运行状态 / 会话 / 权限 / 终端事件；完成或失败即释放事件日志 |
| `web/src/useChatScroll.ts` | 聊天自动跟随意图与阅读锚点；上滑立即暂停，消息增量和布局变化保持阅读位置，引用导航保存并恢复消息位置，回到底部或点击「回到最新」恢复跟随 |
| `web/src/ui.tsx` / `MermaidBlock.tsx` / `mermaidRendering.ts` | 稳定的 Markdown renderer；显式 Mermaid 围栏按需加载，串行渲染、资源语法校验、主题重绘与源码回退，见下方「消息渲染」 |
| `web/src/ImagePreview.tsx` | 图表和各类消息图片共用缩略图、原生模态 dialog、视口适配、缩放平移与键盘焦点管理 |
| `shared/roomPreview.ts` / `web/src/roomListState.ts` | 列表快照和全局 `room.preview` 共用摘要规则；按消息 seq 与状态防回退，列表加载期间重放全局事件，重连刷新 |
| `web/src/ProjectTerminal.tsx` | 按需加载 xterm.js，独立 WebSocket 传输输入 / 输出 / 尺寸，隐藏保留实例，标签页各自连接独立 shell，刷新恢复项目全部终端与选中页；只在显式打开且用户尚未选择其他焦点时聚焦，正常退出状态不被迟到的 PTY 错误覆盖 |
| `web/src/messageMerge.ts` | 历史快照与实时消息按 id 合并，保留完成态 / 较长流式文本；发送接口返回的消息立即插入 |
| `web/src/motion.ts` | `usePresence`（退场动画期间保持挂载）、`withViewTransition`（路由切换） |
| `web/src/BrandMark.tsx` | 团团 Logo（导航栏，眨眼 + 悬停互看）；favicon 在 `web/public/` |

前端直接 `import type` 后端的数据类型（`Agent`、`Message`、`RoomEvent`…），契约只有一份定义。

## 模型能力与思考配置

`Store.modelCatalog` 是当前数据库的唯一目录所有者，内置快照为 231 个服务商、8,902 个模型。`GET /api/providers/models?query=` 只做本地搜索（最多 50 条）；`POST /api/providers/models/sync` 才请求固定公共地址 `https://models.dev/api.json`，不传凭据、用户模型或对话数据，限制 30 秒 / 15 MB。Zod 白名单丢弃 headers、body、npm 等配置；完整校验并写入 `settings.modelCatalog` 后才切换内存快照，并发同步共用一个任务，任一步失败保留旧目录。

effort ID 保留为有长度和字符约束的字符串，新档位不会因团团的固定枚举导致整次同步失败。推荐排序只覆盖语义已知的等级；未知等级不猜强弱，必须由对应 Harness 的实际选项 / 原生能力实现支持。

读取服务商时捕获当前目录快照，已运行进程的能力解析不会随同步变化，新房间 / 新进程再读取新数据；同步不使当前任务重启。`providers.model_catalog` 保存原始模型 ID 到能力引用的映射，API 字段为 `modelCatalog`，只改变能力解析来源，路由 ID 保持原样。未显式关联时按当前协议的官方 URL 优先、预设其次识别，未知不猜；目录控制等级、输入类型和上下文 / 输出上限，Pi 的未知模型保持文本与 128,000 / 8,192 占位，费用仍只记录 Harness 报告值。

协议适配参考 Pi AI 1.0.4 的公开兼容契约，依赖用户 Pi Harness 的请求实现，不新增团团请求传输 SDK。新会话先应用模型选择，再以会话 → Agent → 已识别的明确原生配置 → 团团推荐 → Harness 的顺序应用实际 ACP 支持的等级；推荐值从目录可用等级按 high / medium / low / on / minimal / xhigh / max 的顺序选出，ACP 不支持该值时保留原生状态。恢复或切模型只重放明确意图，不支持的值继续保存在团团。Claude Code 原生模型能力与 Codex 原生 / 用户模型目录保持优先，各适配边界见 [服务商](providers.md#模型能力目录与思考等级)。数据与参考来源、MIT 许可见 [server/data/NOTICE.md](../server/data/NOTICE.md)。

CLI / ACP 升级与模型目录同步是两条独立来源。Host 进程签名和 Harness 选项缓存包含实际启动文件、配套引擎文件及安装代次；同路径更新和配套引擎更新都会失效。探测结果发布前再次核对身份，旧版本的在途响应不能进入新版本缓存。成功安装只标记失效，不终止活动回合；下一次空闲接入重新建立进程，并沿用原有会话恢复及明确选择重放机制。

## 原生提示词与上下文边界

原生基础提示词属于实际启动的 Harness 引擎。`HarnessHost` 向 Claude 发送 `_meta.systemPrompt = { append: identity }`，由适配器保留 `claude_code` preset；OpenCode / Pi 通过新会话首条普通 prompt 的 `<tuantuan-identity>` 接收身份，不写系统字段。Codex 身份合并到 `CODEX_CONFIG.developer_instructions`；目录外模型所需的通用指令由 `provider-codex.ts` 从实际 CLI 的隔离空会话读取，不保存固定正文副本。用户原生配置与扩展的处理、恢复会话是否沿用旧指令，继续归各引擎所有。

`Orchestrator.identityFor` 负责团团身份、协作工具约定和可选个人资料；每轮任务、转述与职责由 `promptFor` / `runAgentTurn` 生成，Skills 索引由 Host 追加。跨 Agent 交接传递完整任务说明与显式 `TaskContext`（goal / decisions / pending），接收方仍使用独立会话。普通正文只做首尾摘录，原文另可分页追读；笔记独立于转述预算完整注入，不迁移来源 Agent 的完整工具历史。字符契约见[会话文档](conversations.md#上下文交接与压缩)。笔记由执行 Agent 编写，没有额外模型摘要请求、统一压缩器或跨请求自动合并的共享记忆。

ACP session 的历史与压缩归 Harness，包括通过原生 Harness 使用自定义服务商的场景。模型目录中的上下文窗口元数据可影响引擎决策，但团团不设置统一压缩阈值。当前 ACP client 仅声明文件和终端能力，未声明专用 `session.compaction` 展示；适配器降级成普通工具更新时可进入现有时间线。上下文占用来自 `usage_update`，不反推压缩是否成功。直接 BYOK 的 `custom_history` 淘汰规则另由团团实现，见下节。

会话恢复使用 `acp_sessions` 保存的 sessionId，优先 `session/resume`，不支持或用户指定历史回放时用 `session/load`。恢复失败 / 45 秒超时或没有可恢复映射时新建会话；界面转写仍保存在 `messages`，不会自动作为完整模型上下文重放。普通服务重启不重放内存中的待执行任务与交接队列。

## 数据与状态归属

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Agent（Harness、env、权限策略、身份文档、MCP 服务器）、项目（名称、目录）、房间/会话（所属项目、主 Agent）、消息（含时间线 JSON）、ACP 会话映射、会话配置偏好（`room_config`，含模型）、设置（Harness 路径覆盖、`onboarded`） | SQLite（`Store`） | 唯一权威来源 |
| 模型目录与服务商能力关联 | `Store.modelCatalog`；SQLite `settings.modelCatalog` / `providers.model_catalog` | 已校验目录持久化；服务商对象捕获快照供既有进程使用，显式关联不改变模型请求 ID |
| 个人资料（含 `profile.language`） | SQLite（`settings` 表的 `profile` 值） | 服务端权威配置；前端 `localStorage["tuantuan:language"]` 仅作启动缓存，保存后的 `profile.updated` 同步已连接窗口 |
| Harness 进程、挂起的权限请求、终端输出 | `HarnessHost` 内存 | 进程退出即丢失；重启后用 `acp_sessions` 里的 sessionId resume / load |
| 待执行 / 活动任务、交接父子关系、每条人类消息的负责人和交接预算 | `Orchestrator` 内存 | taskId 标识单个任务，runId 关联原始人类消息；协调 run 冻结 coordinatorId / rootTaskId，parentTaskId 表示取消依赖，reviewOf 关联待收集的分工批次；房间下每个 Agent 一个 FIFO。整轮无剩余任务后清理；服务重启不重放队列，无数据库迁移 |
| 结构化任务笔记与交接快照 | 当前 `TurnCtx` 暂存；成功后 SQLite `messages.timeline` | `save_context` 完整替换当前回合快照；成功结束通过 `Store.updateReply` 与回复原子保存为 `taskContext`。`handoffs[].context` 接受时独立复制；`handoffFrom.context` 保留接收快照。失败 / 取消 / 中断不提交暂存；不增加数据表或迁移，不自动继承其他 run 的笔记 |
| ACP session 自身的对话历史与压缩 | Harness；当前 slot 暂存 load 回放 | `/replay` 按用户消息文本去掉本房间已有轮次，前端只读显示其余回放；可见转写不等于模型实际上下文 |
| 直接 BYOK 对话上下文 | SQLite（`custom_history`，按房间 / Agent） | 唯一上下文来源；按完整成功轮持久化工具调用与结果，最多 20 轮，按序列化字符预算淘汰旧轮，不生成摘要；重启不改变上下文 |
| 团团配置的 API / 管理 Key | SQLite（`providers.api_key` / `mgmt_key`、`agents.custom`、`settings.harnessEnv`） | 当前明文存储；服务商、BYOK 与 Harness env_var 专用公开接口返回掩码，不是磁盘加密。普通 `agents.env` 是可读写配置，不具备这些专用接口的打码契约 |
| 原生登录凭据、模型配置 | Harness | 沿用用户 Harness 的配置与登录态；系统钥匙串集成仍未实现 |
| 前端消息、运行状态、会话视图、权限与终端投影 | `ChatView` 的 `chatReducer` | roomId 隔离；App 按 room.id 重挂载；非权威副本，最新快照与请求期间实时事件合并，旧响应忽略 |
| 权限提交中的状态 / 错误 | `ChatView` | 按 askId 防重复；成功或 404 关闭，其余错误保留 ask 并显示可重试错误，WS 解决事件同样可关闭 |
| 停止任务请求中的状态 / 错误 | `ChatView` | 按 taskId 防重复、失败可重试；任务列表只由服务端 RoomState 更新，HTTP 确认不会覆盖实时任务状态 |
| 终端面板开合、高度与焦点意图 | `ChatView` | 外层网格裁切连续改变占位，内部 xterm 保持实际尺寸，避免动效逐帧触发 PTY resize；首次加载与结束共用外层，隐藏立即 inert，结束后在退场完成时卸载。减少动态效果直接切换，拖动高度立即响应 |
| 图表源码、主题与最后一次渲染结果 | `MermaidBlock` | 仅前端派生状态；源码变化不复用旧图，同一源码换主题保留上次结果直至重绘完成；不写数据库 |
| 图片预览开合、缩放平移与加载状态 | `PreviewImage` / `ImagePreview` | 组件局部状态；相同入口更新图片地址时保持预览、缩放选择与焦点；自然尺寸、加载状态按地址与重试次数隔离 |

界面语言默认 `zh-CN`，另支持 `zh-TW`、`en`、`ja`。`App.applyProfile` 在启动读取、保存响应及 `profile.updated` 到达时更新界面语言；个人资料读取带修订号，迟到的旧响应不能覆盖更新事件。前端启动先读取语言缓存，成功读取服务端配置后以服务端为准。`ProfilePage` 保留编辑草稿并串行提交；语言选择立即提交，其他字段合并短时间内的修改，失败保留草稿并提供重试。语言字段复用现有 JSON 设置，无新增数据库迁移。

文案以简体中文源字符串为键，在组件渲染时响应语言变化；模块常量保留源文案，ACP 选项保留原始数据后生成展示标签。用户数据与聊天正文不进入翻译流程，已知错误模板中的名称、路径和模型 ID 只作原值插入，未知第三方诊断回退到原文。`profileInstructions` 不写入界面语言，模型回答语言仍由用户指令和 Harness 决定。

迁移按 `PRAGMA user_version` 顺序执行，只追加：

| 版本 | 内容 |
| --- | --- |
| 1–3 | 初始表；早期的路由与设备表（对应功能已移除，见 6、7） |
| 4 | `agents.avatar_shape` |
| 5 | 头像颜色映射到新色板 |
| 6 | ACP：`system_prompt` → `identity`；agents 加 `harness`、`cwd`、`env`、`permission_policy`、`mcp_server_ids`（从旧的 `mcp:` 工具 id 迁移）；rooms 加 `main_agent_id`（回填第一个成员）、`cwd`；messages 加 `timeline`；删除 `routing_decisions`；新表 `acp_sessions`、`settings` |
| 7 | 清理已移除功能的设备会话：删除对应房间（及其消息、ACP 会话、成员）和 `device_sessions` 表 |
| 8 | 工作目录归房间：回填旧 DM cwd，删除 `agents.cwd` |
| 9 | `agents.custom`：BYOK 配置（含服务端 Key） |
| 10 | `projects` 与 `rooms.project_id`；启动时按文件系统状态分配已有房间 |
| 11 | `room_models`：会话成员的模型偏好 |
| 12 | `agents.config_defaults` 与 `room_config`：Agent 默认配置、会话覆盖；迁移模型偏好与旧 DM 名称 |
| 13 | `providers`、`agents.provider_id`、`usage_log` |
| 14 | 服务商 `mgmt_key` |
| 15 | 用量的模型、缓存读写、思考 token、费用及币种 |
| 16 | `agents.use_profile`：是否附带用户个人资料 |
| 17 | `messages.quote`：群聊引用的服务端有界快照（原消息 id、作者、角色及摘录），旧消息为空 |
| 18 | `custom_history`：按房间 / Agent 保存有界 BYOK 上下文，房间或 Agent 删除时外键级联清理 |
| 19 | `providers.model_catalog`：模型 ID 到能力来源引用的 JSON 映射，旧服务商默认 `{}` 自动识别 |

BYOK 每次上游请求（包括工具续请求）都用实际请求构造器计算 JSON body 的文本序列化字符数，上限 65,536；包含系统提示、工具定义、当前任务、工具链及 JSON 包装，剔除图片 Base64 本体。图片按原始字节另设 20 MiB 预算，三种 API 均使用各自的图片结构。超限先按完整旧轮淘汰，不截断当前任务或系统提示，不拆散工具调用与结果；当前轮自身超限则在发送前明确报错。完成轮按相同文本、图片预算和最多 20 轮持久化；最终回复使单轮超限时保留可见回复、报告错误并保留上一成功上下文。这是字符预算，不是字节数或模型 token 窗口。

`custom_history` 缺行表示尚未初始化：仅 DM 从最近 40 条转写中按同一 runId 配对人类任务与该 Agent 的成功回复，经预算裁剪后恢复一次；群聊从空开始，历史由转述携带。`[]` 是明确清空的状态，新会话、成员移除、项目目录 / 归属重置后重启也不复活旧聊天。普通停机保留成功上下文；取消、错误或 slot 已释放的迟到回复不提交半轮。

头像动画只用 CSS transform：≥32px 完整动画、更小只眨眼；`prefers-reduced-motion` 全部关闭；离屏（IntersectionObserver）和标签页隐藏（`html[data-tab-hidden]`）时暂停。

## 消息渲染

聊天正文搜索由 `server/message-search.ts` 校验参数与分页游标，`Store.searchMessages` 参数化查询 SQLite 的完整 `messages.content`，先限制结果条数再提取片段，不加载 timeline。按 `(created_at, id)` 倒序分页，游标绑定关键词与会话范围；本版为本机字面扫描，无语义搜索或 FTS 索引。`MessageSearch` 管理防抖、请求代次与分页；`CommandPalette` 组合现有快速切换。App 发出一次性的目标导航，ChatView 消费后清除，复用连续历史加载和阅读锚点，避免普通返回会话重复跳转。

`AttentionService` 每次快照读取 Host 的真实待授权 / 提问以及 SQLite 中未确认的 error / interrupted 消息，不新增任务运行态。新增迁移 `message_attention_dismissals` 只保存失败消息的明确处理记录，随消息删除级联清理。`GET /api/attention` 分页失败项并始终返回全部活动请求；`POST /api/attention/:messageId/dismiss` 幂等确认失败。Host 请求变化、结束消息、删除与手动处理经全局 `attention.changed` 通知，不依赖当前房间订阅。App 唯一挂载的 `AttentionController` 管理快照、离线状态和请求代次，拒绝迟到响应覆盖较新状态；界面列表不代替原会话的授权 / 回答操作。

`MessageMarkdown` 使用 `react-markdown`、GFM 和 highlight.js，不执行原始 HTML。renderer 定义在模块级，避免流式文本增量让图片预览和图表组件重新挂载；含图片的链接拆为图片按钮与独立外链，避免 `<a>` 嵌套按钮。

`MermaidBlock` 只处理 `language-mermaid` 围栏，延迟 180ms 合并流式片段；`mermaidRendering` 按需加载固定版本的 Mermaid。其主题初始化和渲染依赖全局状态，因此共用一条串行队列；任务在加载前、渲染前和结果提交前检查是否过期。临时测量 DOM 位于屏幕外，成功或失败都会清理。渲染输出补齐 SVG 固有尺寸，再作为图片展示，无需数据库迁移或 ACP 协议扩展。

图表使用固定 `strict`、关闭 HTML labels，并在渲染前拒绝配置覆盖、HTML（无属性的 `<br>` 换行除外）、图片 / 图标元数据、sequence `properties` / `details`、资源别名及外部样式资源。`strict` 本身不阻止测量 DOM 发起图片请求，不能只依赖最终 SVG 图片的隔离。源码上限 50,000 字符、边数上限 500；不支持或解析失败时显示转义后的源码，不插入 Mermaid 错误页。输出作为静态 SVG 图片，不绑定图内事件，并关闭图内动画。

图表从 CSS token 读取主题，监听系统主题与根元素主题变化。相同源码重绘期间保留图像和预览实例，替换地址时不重置原图模式、焦点；重绘失败明确显示上次图表仍在使用。源码变更立即失效旧图，过期结果不能覆盖新内容。

`PreviewImage` 为 Mermaid、Markdown、ACP 时间线及工具图片提供同一个入口。预览通过 portal 和原生 `dialog.showModal()` 进入 top layer，缩略图继续占据消息中的原位置；Tab 保持在弹窗内，关闭时以 `preventScroll` 恢复触发按钮焦点。视口通过 ResizeObserver 测量，适应窗口按自然尺寸计算且不自动放大小图。缩放与平移由组件统一管理，滚轮按指针位置缩放，拖动和方向键平移均限制在图片边界；窗口变化重新计算适配比例与平移边界。暗色背景与固定工具区让图片不被控件遮挡；失败可重试，重试不更改原始资源地址。

`tests/rich-message.test.tsx` 覆盖 Markdown 分流、图片入口与资源语法；`scripts/e2e-rich-media.ts` 接入全量浏览器冒烟，使用持久化测试消息和 ACP 形状的确定性更新验证实际 SVG、主题、预览与流式恢复。测试夹具不代表真实模型输出质量或各 Harness 的图片输入能力。

## 编排

项目终端不参与 Agent 编排：`POST /api/projects/:id/terminal` 默认幂等打开，加 `{create:true}` 新建独立实例；`GET` 默认读首个实例，`?all=1` 列出全部，`DELETE ?terminalId=` 按实例结束，`/ws/terminal/:id` 推送快照 / 输出 / 退出。所有入口沿用本机请求边界。服务端内存拥有进程、最多 12 个终端及每终端 256K 字符尾部输出；浏览器保留面板状态和选中标签，非活动标签停止输入但继续接收输出，断线不杀进程。项目删除或目录改变会清理所属全部终端。Bun 1.3 的 PTY 部分写入按实际接受字节补发；交互式任务各自有进程组，结束时按专属 TTY 和后代身份清理。自然退出后已主动脱离的任务保留 shell 语义，无数据库迁移。

Skills 的原生来源与 Agent 选择由 `skills.ts` 统一解析：真实路径去重时合并来源及 native 标记；Antigravity 包括 GEMINI_HOME 和项目 `.agents/.gemini`。当前选择在每轮普通 prompt 中形成 `<tuantuan-skills>` 索引，`AcpProcess` 同步替换额外只读范围，拒绝根外符号链接；索引不注入 Skill 正文。前导斜杠命令保留原始 blocks，不依赖异步命令声明；身份和 Skills 索引不改变命令文本，身份延后到普通消息注入。回放会话时剥离内部索引。停止写共享项目链接；历史未知归属链接作为原生项目来源保留，不推断所有者后删除。BYOK 只允许 `load_skill` 读取当前启用项。

Grok 额度沿用 `AcpProcess`，初始化后只发送 `_x.ai/billing`，不建立模型会话；解析当前周期百分比及旧版 credits schema，缓存最新查询和错误。此处是 Grok 的只读扩展，不引入原生 provider 适配层。

`server/registry-usage.ts` 负责 Antigravity / ZCode 的额度解析和只读 ACP 查询。Antigravity 等待当前会话声明 `/usage` 后发送原生命令；ZCode 直接发 `account/usage_stats`，不建会话或调用模型。`app.ts` 在成功登录 / 握手的同一进程查询并保存公开额度快照，手动刷新单飞；页面读取缓存，不启动登录。失败保留未知与错误，不用旧数值冒充新结果。ZCode 0.70.0 仅覆盖个人渠道，团队套餐明确标注未支持。

额度刷新、Harness 检测与登录请求在入口校验后关闭 HTTP 的默认空闲超时，实际等待仍受各 ACP 操作的超时限制。`process-tree.ts` 统一隔离进程清理错误：进程组信号失败保留日志，仅对尚未退出的原始子进程尝试回退；延迟强制终止同样不抛出未捕获异常，显式强制终止会撤销旧计时器。主进程先退出时仍回收其组内后代；清理失败不能覆盖查询结果或终止团团服务。

人类消息的引用由 `POST messages` 的 `replyToId` 指定；阶段气泡另传 `replyToPartIndex`，使用原始 timeline parts 中的阶段起点。前端展示与服务端选段共用 `timelineBodyPhases`，连续正文和图片同段，思考或工具记录分隔阶段。`Store.insertMessage` 在写入事务中校验同房间、完成态及真实阶段起点，只从选定原文生成最多 400 字符的快照；无效索引、跨房间或未完成来源原子拒绝，不回退为整轮引用。可选 `partIndex` 与文本一起保存到既有 quote JSON，刷新保留选段，不需要数据库迁移；不传片段索引的既有请求仍引用整条消息。界面引用操作用于群聊，单聊中断重试也可生成引用。前端不能提供引用正文；原消息不在近期历史时仍能向本轮 prompt 提供引用。`content` 只含用户的新文本，引用不会进入 @ 路由解析，也不递归复制被引用消息的引用。

ACP 表单提问仅声明 `elicitation.form`。`HarnessHost` 按 ask ID 与活动 slot 保存待办，`shared/elicitation.ts` 规范化字段并供前后端共同校验，`POST /api/elicitations/:id` 成功时先移除待办再应答。待办通过 `elicitation` 事件和消息快照同步，刷新恢复，任务取消、进程退出或 slot 释放时返回 cancel。普通页面导航和会话切换不回答或取消提问；`ElicitationDialog` 按 ask ID 在内存保留未提交的表单值，成功回答、明确取消或已解决的请求清理对应草稿，刷新只恢复服务端仍待回答的问题。`ElicitationDialog` 使用共同校验而非 HTML 原生约束，避免正则匹配和字符长度规则不同；日期时间保留时区，未知字段阻止提交。

消息分页沿用 `messages.seq` 和 `Store.recentMessages(roomId, limit, beforeSeq)`；`GET /api/rooms/:id/messages` 接受正整数 `limit`（默认 100，最多 500）与可选的排他游标 `beforeSeq`，返回按序排列的消息和 `nextBeforeSeq`（`null` 表示没有更早记录）。前端初始页为 200 条，历史页只合并消息与分页进度，不应用响应里的任务、会话或权限快照。消息按 id 去重、按 seq 排序，历史请求与最新快照分别标识和隔离；分页提交前记录当前可见消息的偏移，布局更新后恢复阅读位置。

结论卡从成功根任务或 `reviewOf` 跟进消息的 `timeline.taskContext` 派生，服务端快照不受当前历史页限制，前端以 seq 合并快照与实时结果；无新笔记时保留上一份，不另存结论或生成摘要。来源跳转按需加载旧页，失败停止自动追读，保留错误和手动重试入口。引用导航复用该通路并携带已保存的 `partIndex`，以原始时间线阶段位置定位和高亮正文；完整视图仅在渲染时隐藏重复交接工具，保留原始索引。带阶段位置的引用不能回退到整条消息，连续定位会清除旧高亮；旧引用仍按原消息定位。`ChatView` 在首次来源导航时保存 `useChatScroll` 的消息 ID 与视口偏移锚点，连续查看来源保留最初的锚点；返回按当前布局还原位置，取消待完成定位并清除高亮，迟到历史页仍正常合并。显式回到最新或切换会话清除返回点，返回按钮消失后焦点落在消息阅读区域。`POST /api/rooms/:id/messages/:messageId/retry` 仅接受同房间的 interrupted Agent 消息，从 runId 找到原人类请求，将正文、图片与原请求引用交给普通消息路由，创建新 run；不恢复旧任务队列或 Harness 内部执行断点。

1. 人类消息写库后立即路由成独立的根任务：单 Agent → 该 Agent；多 Agent 时 @所有人 → 全部成员；@具体成员 → 这些成员；没有 @ → 群主负责统筹。只有最后一种 run 保存 coordinatorId 和 rootTaskId，其余是直接对话。更换群主只影响新 run。同一房间不同 Agent 并行，同一 Agent 按入队顺序执行；新消息不取消旧任务，不同房间互不阻塞。
2. `RoomState.tasks` 提供 taskId、runId、parentTaskId、agentId、messageId、请求文本与 queued / running / cancelling / waiting 状态；协调任务另带 coordination（lead / work / review）。已完成但仍有活动后代的任务显示为 waiting，保留停止剩余工作的入口。`activeRunId` 仅保留为兼容的忙碌标志，`queued` 计数任务；界面不从单个 runId 推断全部运行状态。`idle(roomId)` 等到队列、衍生交接和自动跟进全部结束。
3. 单个回合：取得（或新建 / 恢复）该 Agent 在本会话的 ACP session。群聊转述取原始请求及之前的最近 30 条记录作为候选；交接通过 `Store.runMessages` 单独查询同一请求已完成的 Agent 回复，不先对全房间取 30 条再过滤。候选中取该 Agent 上次成功发言之后的内容，长正文保留首尾与省略标记，附消息 ID 和原长；单条约 2000 字符、整体约 8000 字符，优先较新消息，目录与完整原文可经 `read_context` 追读。`<tuantuan-task>` 独立保留原始消息全文与引用快照，`<tuantuan-context>` 独立保留结构化笔记；排队期间的新消息不能替换它们。每轮另附 `<tuantuan-coordination>` 指定 leader / member / direct 职责及 initial / review 阶段，不把群主职责写死在可能缓存的身份文档中。单 Agent 的新请求直接收到用户消息（含图片）；群聊缩为单人时，已有协调 run 保留职责与结果上下文直至收尾。身份文档按 Harness 传递（见 [Harness 文档](harness.md)）；不支持的 Harness 附加在新会话首条普通 prompt 前的 `<tuantuan-identity>` 中。

普通模型请求的 `runAgentTurn` 另附 `<tuantuan-response>` 沟通约定，覆盖单聊、直达、群主、成员及跟进轮，确保恢复的 Harness session 也接收当前约定。原生 Harness 的前导斜杠命令按 Host 相同规则识别，不追加该块，保留命令处理所需的原始块数量、内容和顺序；自定义模型以及带引用或群聊包装的请求仍按模型任务处理。约定引导少量面向用户的关键消息，不改变原始请求、协调职责、权限、上下文保存或原生 Harness 规则；前端的本机精简偏好不传入编排。消息仍使用原 ACP 正文/思考/工具事件，没有新增阶段协议或摘要调用；原生历史回放剥离该内部提示块。

4. `session/update` 按 messageId 实时推送，同时折叠进时间线；回合结束时写库。权限请求以 `permission` 事件推送，用户回答后返回给 Harness。取消或删除后的迟到更新不能继续写入回复。
5. `POST /api/rooms/:id/cancel {taskId}` 只取消该任务及 parentTaskId 可追溯的后代，保留独立根任务和兄弟任务。排队任务直接移除；运行任务变为 cancelling，待 Harness 结束才放行同一 Agent 下一项。群聊缺 taskId 返回 400；DM 空请求兼容为停止当前任务，保留后续队列。删除房间、修改项目目录 / 归属或停机使用 `cancelAll`；移除 Agent 使用 `cancelAgent`，只传播到其交接后代。
6. Host 取消：prompt 先检查 AbortSignal；初始化等待可被取消，取消后不发送 prompt，同一 slot 的预热可供后续请求复用。已发出的 prompt 先发 `session/cancel`、解决挂起权限；默认 4 秒仍未返回则销毁该「房间 + Agent」的 Harness 与 ACP 终端进程组，保留部分回复并标为 cancelled，其他房间和 Agent 继续执行。同一 room / Agent 的重入 prompt 与活动期间切换历史会话返回 409。
7. 交接：运行中的 Agent 调用 `handoff`，校验成员、完整任务和可选笔记后，同步预占该人类消息共享的最多 5 次交接预算；来源正常结束后才创建子任务。协调 run 仅允许冻结的群主分工，成员结果自动回流；直接对话仍可按需继续交接。相同轮次已有排队 / 运行任务或预占的目标去重，`@所有人` 每成员只触发一次；不跨独立人类消息去重。失败或取消释放未派发预算，不保存成功交接、不产生后代。交接说明 trim 后最多 16,000 字符，超限拒绝，不截断。`context` 完整 JSON 最多 4000 字符，各字符串最多 2000 字符，数组各最多 20 项；缺少字段或超限不修改当前快照。省略 `context` 时复制当前收到 / 暂存的笔记，显式 `context` 只作用于该目标，接受后不受后续 `save_context` 影响。接手方按自己的 FIFO 排队，prompt 附完整 `<tuantuan-handoff>` 与独立 `<tuantuan-context>`，不克隆来源 session；时间线保留 `handoffs` / `handoffFrom`。角色属于本次请求，不形成固定 Agent 上下级。
8. 初始化去重与失效：同一房间 / Agent 的 opening 按配置签名复用并记录代次；发布 session 前再次核对签名与代次。Agent 设置、项目目录或会话选择变更，以及停机时使旧 opening 失效，旧结果不能回写映射或 slot；相关旧请求返回 409，下一次请求按当前配置重试。失败或切换清理只移除该请求仍拥有的 slot，不删除其他房间相同 ACP sessionId 的映射。
9. session/load 回放：`switchSession` 指定历史会话时优先 load，回放的 update 存在 slot 里，`/replay` 接口按用户消息文本去掉本房间已有的轮次后返回，前端只读显示。刷新读取当前任务快照并重放期间的 WS 事件；服务重启不重放未开始的任务，已开始但未完成的回复沿用 interrupted 恢复规则。

群主自动跟进：调度器等同一分工任务的全部 work 子任务进入 done / error / cancelled 后，以 reviewScheduled 去重，仅创建一个新 review 任务，按群主 FIFO 执行。reviewOf 指向该批分工任务，parentTaskId 始终指向本轮根任务，保证停止根任务会覆盖全部批次。每批结果来自任务图与已保存消息，包含任务、状态、消息 id、错误与最多 6000 字符内容；不依赖有界的普通会话转述。Timeline.reviewOf 保存成员名字，刷新后仍能识别跟进消息。

review 可继续 handoff，重复分给已结束的成员仍消耗共享的 5 次预算；自动返回本身不计预算，耗尽后仍有最后一次汇总机会。取消成员会向群主报告，该成员本轮禁止重派；根任务或该批来源已取消、群主已移除、会话删除或停机时不再创建 review。

`read_result(messageId, offset)` 以 6000 字符分页读取本轮已结束的 Agent 消息，返回 nextOffset（null 表示结束）；服务端校验成员身份、活动任务归属、roomId / runId、消息类型和偏移。`list_members` 补充最多 600 字符身份说明。群聊工具列表不随 leader / member 角色变化，执行权限在 call 中校验；缩为单人后仍在运行的协调轮保留结果读取能力。

`save_context(goal, decisions, pending)` 暂存完整快照，只有回合成功才提交 `Timeline.taskContext` 及内存 `Task.context`；输出上限、失败、取消、中断均不提交。接手任务从 `from.context` 继承；群主 review 从 `reviewOf` 所指的实际上一批任务继承，不使用仅表示取消关系的 `parentTaskId`。成功成员的笔记作为 report 附件，由群主复核后自行决定是否更新其快照，避免自动合并相互矛盾的决定。

review 的任务说明使用最多 2000 字符首尾摘录，长任务标记 `taskTruncated`、`taskLength` 及 `taskSource { messageId, handoffIndex }`，从本批来源的成功交接记录追读全文。原始用户任务、群主笔记及成员成功笔记保留完整，避免 16,000 字符交接在每个 report 中重复占满 BYOK 请求；BYOK 自身 65,536 字符预算和原生 Harness 压缩机制不变。

`read_context` 复用消息时间线，无额外索引表。无 messageId 时通过 `Store.contextMessages` 以 beforeSeq 排他游标返回每页 20 条目录；指定 messageId 时返回每页 6000 字符的正文、成功笔记与交接目录；指定 handoffIndex 可读取该条交接说明和快照。可见性在查询 / 读取时校验：同房间、非系统、非生成中，且 seq 不晚于原始请求，或属于本 run 的后续已结束消息。后来的独立 run 不可读取；成员已移除、任务取消或 taskId 过期也拒绝。`nextBeforeSeq` / `nextOffset` 为 null 时结束。`<tuantuan-context>` 与其他团团内部块在原生 session/load 回放中剥离，避免显示为用户输入。

Host slot 记录完整有效 MCP 配置签名（用户服务器、插件 stdio MCP、团团工具入口）；增删绑定、删除服务器、插件配置变化或单聊加成员变群聊时，下一次空闲 attach 通过已有 resume / load 更新 mcpServers，按 Harness 能力保留会话历史，不支持恢复时新建会话。活动期间的界面查询复用现有 slot 或预热，不更换进程、回调或权限请求，下一任务再刷新。配置相同不重复重连，单纯换群主不会刷新工具接入。初始化签名同时包含用户服务器记录与插件配置指纹，发布前再次核对；初始化期间的配置变更使旧结果失效，不能覆盖新 slot。

交接、笔记保存与原文 / 结果读取请求的归属在 MCP HTTP 入口读取正文之前绑定到 taskId，整个 batch 使用同一上下文；BYOK 工具回调在 prompt 开始时捕获。真正执行时核对仍是同一个未取消任务，避免旧请求延迟解析后归到下一轮。MCP endpoint 仍按房间 / Agent 注入并供 session 复用；完全在旧 prompt 结束后才新发起、且不携带轮次标识的外部调用无法区分来源，依赖 Harness 遵守 prompt 生命周期。

资源随归属释放：删除会话 / 项目 / Agent、移除成员或变更项目目录 / 归属时，先取消对应任务，再由 `HarnessHost.releaseRoom` 清理对应 opening、slot、权限、BYOK 历史及进程；旧初始化结果不能重新挂回。普通任务停止保留可复用会话，进程仅在取消超时才强制回收。

## 取舍

- **每个房间的每个 Agent 一个进程**：即使工作目录相同也不跨房间共享，避免取消超时强杀误伤；代价是更多进程与内存，原有持久化会话恢复保持。
- **并行不隔离项目文件**：Agent 仍使用该项目目录，未自动分配 worktree 或给文件写入加全局锁；群主分工需明确职责和边界。调度保证派发、结果回流、预算及取消范围，分工质量与最终内容仍取决于模型和用户配置的身份指令。
- **身份文档不落盘**：不改用户仓库；拒绝了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 方案，因为它们会把登录态也换掉，每个 Agent 要各自登录。
- **文件路径校验不等于沙箱**：ACP 文件接口将目标及现存父目录解析为真实路径，拒绝工作目录及当前 Skill 只读授权范围外的目标和符号链接逃逸。终端仅校验初始 cwd；命令可使用绝对路径或自行切换目录，Harness 内置工具也按自身沙箱与权限运行。旧文档将这些都称为「限制在 cwd」过宽；当前不提供操作系统隔离，也不防御路径校验后发生的并发文件系统替换。
- **未做鉴权 / 多用户**：仅适合本机。

## Harness 来源与一键安装

- `detectHarness` 顺序：「Harness 页填的路径」→ 登录 shell 的 PATH → 团团内置（`bundled`，从团团自己的 `node_modules` 解析 ACP 适配器，用 `process.execPath` 的 Bun 启动）→ 团团安装（`managed`）。`TUANTUAN_PREFER_MANAGED=1` 时团团安装的优先。
- DeepSeek 常用定义为 `deepseek` / `dsh --profile acp`，身份走首条普通消息；托管安装复用 Registry 安装器，但条目由团团补充，固定官方 npm `@deepseek-ai/dsh@0.2.1-rc.2`，需要 Node ≥ 22.19，符合版本的本机 Node 优先，否则下载托管版本，不加到桌面依赖。登录入口补充 `DEEPSEEK_API_KEY`，沿用 `settings.harnessEnv` 的保存与进程注入；原生 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）优先级归 CLI，不改写本机文件。该版本不声明认证方法且 `authenticate` 不校验凭据，成功握手 / 建会话时的 `loggedIn` 为未知，只表示连接可用；可识别的真实认证失败仍返回未登录及错误。安装版本来自 npm / CLI，不采用固定为 `0.0.1` 的 ACP `agentInfo.version`。会话复用走原生 list / resume，不伪造 `session/load` 回放；DeepSeek 服务商的兼容规则保持独立。
- 桌面包默认不带 Claude Code / Codex 适配器（引擎各 250–400 MB）：首次使用时走 Registry 安装（`claude-acp` / `codex-acp`，npx 包，Bun 运行）。`TUANTUAN_BUNDLE_ADAPTERS=1` 打包时改为内置。登录命令按「内置 → 团团安装」两处找 Claude / Codex 可执行文件。
- Registry 安装：schema 与 `installManaged` 的直接入口均校验 id / 版本为安全目录段（版本不得与 manifest 保留名称冲突），并确认安装路径在 Agent 目录内、关键目录不是符号链接。二进制与 npx 先安装到带随机后缀的独立 `.partial` 目录；发布前检查取消信号，成功后替换版本目录并写 manifest，失败 / 取消清理暂存。Registry 版本变了提示更新；卸载只删团团目录。需要 Node ≥ 22 的包（`engines.node` 或常用定义里 `runtime: "node"`，如 MiniMax 的 better-sqlite3）用托管 Node（nodejs.org，校验 SHASUMS256）。uv 工具直接装到最终目录（venv 写死路径）。
- 一键安装（常用 Harness 的官方脚本 / bun / brew / npm）：`bash -c` 在登录 shell 环境里运行，`stdin` 关闭，日志去掉 ANSI 并折叠 `\r` 进度，最多保留 800 行；取消时连同子进程一起结束；15 分钟超时。完成后清掉登录 shell 环境缓存，页面重新检测。
- 测试：`mock-cli`（本地安装脚本）与 `tests/fixtures/mock-registry.ts`（本地 CDN + npm 源，二进制 / npx / 坏条目）；`TUANTUAN_REAL_REGISTRY=1` 跑真实安装与握手。

## 桌面（Electron）

- 服务端不进 asar：`resources/server`（源码 + 生产依赖）+ `resources/bin/bun`。主进程选空闲端口启动子进程组，等 `/api/health` 后加载窗口。退出时除服务端原组外，还追踪其 Harness / ACP 终端 / 安装任务的独立子进程组，按 pid 与启动时间保留身份，服务端退出后继续回收已记录组，避免误杀复用的组号；4 秒强退兜底。POSIX 依赖 `ps` 发现子组，不可用时仅回收原服务组；Windows 走 `taskkill` 进程树，平台实际验收分开记录。服务端收到退出信号时关闭 host / installer，并用 `TUANTUAN_PARENT_PID` 看门狗兜底。
- 登录 shell 环境在主进程解析一次，传给服务端，Harness 继承它（CC Switch 写的变量照常生效）。
- 主进程启动时读取 `/api/profile` 初始化菜单语言；前端全局通知模块在语言变化时经 preload 的 `tuantuan:set-locale` 同步，主进程重建应用菜单和托盘菜单。系统通知使用当前语言生成应用标题、状态和提示，消息预览保留原文。浏览器桥接检查不能替代真实原生菜单显示验收。
- macOS：`titleBarStyle: "hidden"`，红绿灯位置 `{x: 18, y: 20}`；网页侧 `html[data-desktop="darwin"]` 让侧栏顶行左侧留出红绿灯位置，搜索和「+」排在红绿灯右边；`data-fullscreen` 由主进程在进入 / 退出全屏时经 preload 设置，全屏时不再留空。

## 桌面更新的状态与安装边界

`desktop/src/updates.ts` 由 Electron 主进程持有检查、下载、显式安装和错误恢复状态，通过 `shared/desktopUpdate.ts` 与 preload 的窄 IPC 接口传给设置页。更新 URL、文件与安装器均不由 renderer 指定。更新 IPC 限定应用窗口主 frame 与本地服务 origin。`update-policy.ts` 区分 Homebrew、签名能力、更新源和 AppImage 环境；不具备自动安装条件时显式降级手动更新。

服务进程由桌面启动时获得一次随机更新 capability，`server/main.ts` 捕获后移除环境变量，避免子 Harness/终端继承。受该 capability 保护的 `/api/desktop/update-activity`、`update-prepare`、`update-resume` 仅供主进程使用。`Orchestrator` 持有接收锁，并跟踪执行 Promise 的完整生命周期：prepare 在同一个同步步骤检查所有 runtime 并关闭新消息入口，不取消既有工作；失败时 resume 恢复入口。没有 capability 的普通浏览器服务不开放这组接口。

renderer 在明确重启前完成持久化 checkpoint，主进程等待成功后才申请服务端锁。超时、存储异常、状态不可读或 prepare 失败均不调用安装器。`autoInstallOnAppQuit` 始终关闭；失败的锁释放会重试恢复接收，但不会重试安装。会话草稿与阅读锚点的持久化由前端聚焦模块管理，图片和文件保存在 IndexedDB。桌面服务每次启动会换端口，更新和正常退出前还需通过主进程把所有房间的草稿、图片、文件、引用、阅读锚点及路由原子写入 userData/update-checkpoint.json（64 MiB 上限、私有文件权限）；新窗口将其导入新 origin 的 IndexedDB，恢复路由后才按 checkpoint id 确认删除。导入失败保留源文件并提供重试，安装放弃后清理本次快照，避免覆盖后续编辑。安装页不维护另一份会话状态。 普通退出在窗口销毁和服务停止前完成相同保存握手；主进程按请求 id 拥有保存许可，迟到写入不能覆盖后续快照。退出保存与更新安装状态分开，后台检查不能清除退出快照或解除编辑锁。macOS 仅隐藏窗口时不保存退出快照、不停止服务；保存失败取消退出并允许重试。强制终止不保证此握手完成。

退出许可与界面 installing 状态分开：只有 checkpoint 完成且 prepare 成功后才能授予，任何失败立即撤销。主进程使用 before-quit-for-update 区分更新退出，并覆盖 macOS 先关窗再退出的顺序。Windows 保留 NSIS 的安装参数和提权流程，但通过 SDK 声明的扩展点等待安装器启动成功；macOS 用原生更新器的一次性等待，失败撤销回调；AppImage 在同文件系统暂存并保留旧可执行文件，通过 app.relaunch 排程到旧实例退出、释放单实例锁后再启动。userData/appimage-update.json 记录本次 nonce 和恢复路径；新版服务健康、窗口 ready 且 renderer 成功调用更新状态 IPC 后，才按 nonce 和镜像路径确认并清理旧包。安排重启失败会还原；新版首次启动失败会留下旧包及记录供手动恢复，不自动回滚。下载、签名验证和更新源仍由 electron-updater 负责。

发布流程与安装能力解耦：构建生成更新源及元数据，发布脚本验证所有平台文件后再公开 Release；macOS 双架构清单需合并而不能互相覆盖。Homebrew 的公开版本只在 Release 可下载并通过校验后更新，详细命令与凭据要求见 `docs/install.md`。

## 文件与图片附件

`POST messages` 保留旧 `images` 字段并增加可选 `files`，共享规则校验文件名、MIME、规范 Base64、数量与解码后大小；总计最多 8 个、单个 5 MiB、合计 20 MiB。人类原文及附件保存在既有 `messages.timeline`，文件使用带名称的 `file` part，无数据库迁移。附件文本不参与 @ 路由。

UTF-8 文本直接内联；ACP 支持 embedded context 时使用文本 resource，否则使用文本块。二进制原件按房间、消息与内容摘要保存于数据目录 `attachments/`，落盘文件名使用内容摘要与验证过的扩展名，不接受客户端路径；创建拒绝符号链接，已有文件须与原字节一致。原生 Harness 收到 resource link 和本机路径，ACP 文件读取仅额外授权具体原件，不开放所在目录或写权限；即使数据目录位于项目内，已授权原件也拒绝 ACP 写入。进程重建时从同房间持久化的人类附件逐条恢复原件与精确读取授权，缺失文件可重建，替换的符号链接拒绝恢复。Harness 自身的工具与沙箱仍可能限制读取，上传成功不等于模型理解任意格式。BYOK 对非文本二进制明确拒绝。

图片能力按实际接收成员判断：已知不支持则保留附件并提示，服务端与 Host 再检查；未知能力在真实接入后确认，不静默丢图。`custom_history` 为 BYOK 保存图片并按独立预算淘汰完整旧轮。

附件读取按房间排队；读取中不允许发送或退出保存，读取失败不污染原草稿。发送仅在成功后清除对应快照，失败保留内容。`chatWorkspace` 在 IndexedDB 中持久化文件；桌面 checkpoint 的可选 `files` 默认空数组，兼容旧格式。消息下载通过 Blob 与 download 属性保留原名和字节，不将上传内容作为 HTML 展示。
