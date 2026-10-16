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
| `server/harness.ts` | Harness 定义（常用 6 个 + mock，及 `reg:<id>` 形式的任意 Registry Agent）：启动命令、安装与登录提示、身份文档传递方式；登录 shell 环境（PATH）解析、`which`、版本检测、绝对路径覆盖、来源判定 |
| `server/registry.ts` | 官方 ACP Registry 客户端：本地缓存 → 随包快照兜底、zod 校验（坏条目跳过）、6 小时刷新、图标缓存（只接受 SVG）；平台键；额外的实验性条目（ZCode 桥接） |
| `server/managed.ts` | 团团安装的 Harness（`<数据目录>/harnesses`）：npx 包用 Bun 或托管 Node 22（`npm install --omit=dev`）、uvx 用 uv（用户的或下载的）、二进制按平台下载 + sha256 校验 + 解压；`manifest.json` 记录版本与命令；卸载 |
| `server/harness-secrets.ts` | 按 Harness 保存的 API Key（`settings.harnessEnv`，打码给前端，只注入该 Harness 进程）；打开终端（osascript / x-terminal-emulator…）；缺 Key 错误识别在 `shared/auth.ts` |
| `server/installer.ts` | 安装任务：命令只来自定义（不接受请求里的命令）或 Registry 任务；日志流、取消、超时 |
| `server/acp.ts` | `AcpProcess`：启动 Harness 并用 SDK `ndJsonStream` 连接；`fs/*` 校验真实路径与最近现存父目录；选中的 Skill 目录额外只读授权，每轮替换；`terminal/*` 只约束启动 cwd；权限请求、终端输出与 stderr 尾部 |
| `server/process-tree.ts` | Harness、ACP 终端与安装命令的进程组启动 / 回收；POSIX 按组发信号，Windows 使用 `taskkill /T /F` |
| `server/custom.ts` | BYOK「自定义 API」harness：OpenAI Chat / Responses / Anthropic Messages 的 SSE 流式与 tool call，输出 ACP `session/update`；Key 只在服务端 |
| `server/skills.ts` | Skills：解析 SKILL.md；统一原生来源与 Agent 选择，按需路径索引；导入（目录 / git / GitHub / SKILL.md 链接，先预览再选）；不写共享项目链接；BYOK 的 `load_skill` 仅访问当前选择 |
| `server/providers.ts` | 服务商：预设、Key 打码、按 Harness 注入（Claude Code 用进程 env，Codex 用 ACP `providers/set` + `CODEX_CONFIG` 里的 model，BYOK 直接用）、测速、公开余额接口、只读导入 CC Switch |
| `usage_log` 表 | 每轮 Token（Harness 报告的 usage、模型、缓存读 / 写、思考、费用差分）；`GET /api/usage/stats?since=&tz=` 按 Agent / 模型 / Harness 汇总并按天分桶，`reporting` 列出报告过数据的 Harness |
| `server/library.ts` | 「Skills 与插件」：只读扫描 ~/.claude / ~/.agents / ~/.codex / 项目目录，解析 Claude 插件（plugin.json），导入到 `<data>/library`（更新 / 删除），算各 Harness 支持；按 Agent 勾选的插件在建会话时变成 Claude `_meta.claudeCode.options.plugins` 或 Skill 索引 + stdio MCP |
| `web/src/brands.ts` | 模型 id → 厂商（含 `openrouter/…`、`anthropic/…` 前缀），未知一律中性图标；Logo 来自 @lobehub/icons（MIT） |
| `server/usage.ts` | 用量：读 `~/.claude/projects` / `~/.codex/sessions` 的 JSONL，解析 Claude Code `/usage`、Codex `/status`、Grok CLI 会话用量及 ACP billing 额度；未知值保留为空 |
| `server/registry-usage.ts` | Registry Harness 的原生额度查询与解析；Antigravity `/usage`、ZCode `account/usage_stats`；不读取凭据或改变登录渠道 |
| `server/dirpicker.ts` | 选择文件夹：系统对话框（osascript / zenity / kdialog，可由桌面壳替换）+ 应用内浏览器的目录列表与常用位置 |
| `server/host.ts` | `HarnessHost`：按「房间 + Agent + 工作目录」隔离进程；会话 ↔ ACP session 映射（`acp_sessions` 表，重启后 resume / load）；prompt、cancel、配置项 / 模式、会话列表与切换；同房间同 Agent 防重入，权限请求挂起直到用户回答 |
| `shared/timeline.ts` | 把 `session/update` 折叠成时间线（文本、思考、工具卡片、计划、用量）；服务端持久化和前端渲染共用 |
| `server/tuantuan-mcp.ts` / `server/mcp-shim.ts` | 团团自己的 MCP 服务器：`/mcp/<token>`（JSON-RPC over HTTP POST）；token 对应「房间 + Agent」，只在内存。Harness 支持 HTTP MCP 时直接连，否则启动 stdio 中转脚本。工具由 Orchestrator 提供 |
| `server/orchestrator.ts` | 每房间的任务依赖图与每 Agent FIFO 队列；直达 / 群主统筹路由、逐轮职责、成员结果收集与群主续轮、单个 Agent 回合、交接预算与定向取消 |
| `server/mentions.ts` | 人类消息里的 `@名字` / `@所有人` 解析（忽略引用、代码和转述行）；Agent 回复不解析 |
| `server/store.ts` | SQLite 迁移与读写 |
| `web/src/Harness.tsx` | 时间线渲染（工具卡片、diff、终端、计划）、权限弹窗、会话栏 |
| `web/src/Onboarding.tsx` / `Setup.tsx` / `Registry.tsx` | 首次引导（一页三步）；Harness 管理页；「更多 Agent」（Registry 列表、安装、握手、图标） |
| `desktop/` | Electron 壳：主进程启动随包 Bun 服务端（子进程组、`/api/health`、父进程看门狗）、单实例、菜单、preload（文件夹对话框、全屏状态）；`scripts/` 打包（stage / electron-builder / afterPack）与 Xvfb 冒烟 |
| `server/avatars.ts` | 头像轮廓与颜色定义、按 Agent id 的确定性默认头像（FNV-1a），前后端共用 |
| `web/src/*` | React 前端：哈希路由、三栏布局、Agent 编辑、聊天视图、Cmd+K；样式为手写 CSS 变量（无 Tailwind），主题 token（颜色、圆角、阴影、字体）在 `styles.css` 顶部；字体由 `@fontsource-variable/plus-jakarta-sans` 自托管 |
| `web/src/BotAvatar.tsx` / `avatarState.ts` / `AvatarPicker.tsx` | SVG Bot 头像（轮廓 + 表情 + 仅 transform 的动画）、消息/成员状态 → 表情映射、头像选择器；预览页 `#/dev/avatars` |
| `web/src/chatState.ts` | ChatView 的服务端投影视图 reducer：只落地当前房间最新请求的快照，重放请求期间的运行状态 / 会话 / 权限 / 终端事件；完成或失败即释放事件日志 |
| `web/src/useChatScroll.ts` | 聊天自动跟随意图；上滑立即暂停，消息增量和布局变化保持阅读位置，回到底部或点击「回到最新」恢复 |
| `web/src/ui.tsx` / `MermaidBlock.tsx` / `mermaidRendering.ts` | 稳定的 Markdown renderer 保留流式更新期间的组件状态；仅显式 Mermaid 围栏按需加载渲染器。全局队列串行执行主题初始化与渲染，过期任务不落地；固定 strict、关闭 HTML labels，在渲染前拒绝配置覆盖、图片 / 图标元数据、sequence properties / details 与外部样式资源（strict 本身不阻止图内图片请求）；输出带固有尺寸的 SVG 图片隔离链接 / 事件，失败保留源码 |
| `web/src/ImagePreview.tsx` | Mermaid、Markdown、ACP 与工具图片共用缩略图 / 原生模态 dialog，局部持有放大状态；预览通过 portal 进入 top layer，焦点循环与恢复使用 preventScroll，不改消息占位，适应窗口 / 原图可切换；Markdown 图片关联的外链独立呈现，避免嵌套交互元素 |
| `shared/roomPreview.ts` / `web/src/roomListState.ts` | 列表快照和全局 `room.preview` 共用摘要规则；按消息 seq 与状态防回退，列表加载期间重放全局事件，重连刷新 |
| `web/src/ProjectTerminal.tsx` | 按需加载 xterm.js，独立 WebSocket 传输输入 / 输出 / 尺寸，隐藏保留实例，标签页各自连接独立 shell，刷新恢复项目全部终端与选中页；只在显式打开且用户尚未选择其他焦点时聚焦，正常退出状态不被迟到的 PTY 错误覆盖 |
| `web/src/messageMerge.ts` | 历史快照与实时消息按 id 合并，保留完成态 / 较长流式文本；发送接口返回的消息立即插入 |
| `web/src/motion.ts` | `usePresence`（退场动画期间保持挂载）、`withViewTransition`（路由切换） |
| `web/src/BrandMark.tsx` | 团团 Logo（导航栏，眨眼 + 悬停互看）；favicon 在 `web/public/` |

前端直接 `import type` 后端的数据类型（`Agent`、`Message`、`RoomEvent`…），契约只有一份定义。

## 数据与状态归属

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Agent（Harness、env、权限策略、身份文档、MCP 服务器）、项目（名称、目录）、房间/会话（所属项目、主 Agent）、消息（含时间线 JSON）、ACP 会话映射、会话配置偏好（`room_config`，含模型）、设置（Harness 路径覆盖、`onboarded`） | SQLite（`Store`） | 唯一权威来源 |
| Harness 进程、挂起的权限请求、终端输出 | `HarnessHost` 内存 | 进程退出即丢失；重启后用 `acp_sessions` 里的 sessionId resume / load |
| 待执行 / 活动任务、交接父子关系、每条人类消息的负责人和交接预算 | `Orchestrator` 内存 | taskId 标识单个任务，runId 关联原始人类消息；协调 run 冻结 coordinatorId / rootTaskId，parentTaskId 表示取消依赖，reviewOf 关联待收集的分工批次；房间下每个 Agent 一个 FIFO。整轮无剩余任务后清理；服务重启不重放队列，无数据库迁移 |
| ACP session 自身的对话历史 | Harness；当前 slot 暂存 load 回放 | `/replay` 按用户消息文本去掉本房间已有轮次，前端只读显示其余回放 |
| 团团配置的 API / 管理 Key | SQLite（`providers.api_key` / `mgmt_key`、`agents.custom`、`settings.harnessEnv`） | 当前明文存储；服务商、BYOK 与 Harness env_var 专用公开接口返回掩码，不是磁盘加密。普通 `agents.env` 是可读写配置，不具备这些专用接口的打码契约 |
| 原生登录凭据、模型配置 | Harness | 沿用用户 Harness 的配置与登录态；系统钥匙串集成仍未实现 |
| 前端消息、运行状态、会话视图、权限与终端投影 | `ChatView` 的 `chatReducer` | roomId 隔离；App 按 room.id 重挂载；非权威副本，最新快照与请求期间实时事件合并，旧响应忽略 |
| 权限提交中的状态 / 错误 | `ChatView` | 按 askId 防重复；成功或 404 关闭，其余错误保留 ask 并显示可重试错误，WS 解决事件同样可关闭 |
| 停止任务请求中的状态 / 错误 | `ChatView` | 按 taskId 防重复、失败可重试；任务列表只由服务端 RoomState 更新，HTTP 确认不会覆盖实时任务状态 |
| 终端面板开合、高度与焦点意图 | `ChatView` | 外层网格裁切连续改变占位，内部 xterm 保持实际尺寸，避免动效逐帧触发 PTY resize；首次加载与结束共用外层，隐藏立即 inert，结束后在退场完成时卸载。减少动态效果直接切换，拖动高度立即响应 |

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

头像动画只用 CSS transform：≥32px 完整动画、更小只眨眼；`prefers-reduced-motion` 全部关闭；离屏（IntersectionObserver）和标签页隐藏（`html[data-tab-hidden]`）时暂停。

## 编排

项目终端不参与 Agent 编排：`POST /api/projects/:id/terminal` 默认幂等打开，加 `{create:true}` 新建独立实例；`GET` 默认读首个实例，`?all=1` 列出全部，`DELETE ?terminalId=` 按实例结束，`/ws/terminal/:id` 推送快照 / 输出 / 退出。所有入口沿用本机请求边界。服务端内存拥有进程、最多 12 个终端及每终端 256K 字符尾部输出；浏览器保留面板状态和选中标签，非活动标签停止输入但继续接收输出，断线不杀进程。项目删除或目录改变会清理所属全部终端。Bun 1.3 的 PTY 部分写入按实际接受字节补发；交互式任务各自有进程组，结束时按专属 TTY 和后代身份清理。自然退出后已主动脱离的任务保留 shell 语义，无数据库迁移。

Skills 的原生来源与 Agent 选择由 `skills.ts` 统一解析：真实路径去重时合并来源及 native 标记；Antigravity 包括 GEMINI_HOME 和项目 `.agents/.gemini`。当前选择在每轮普通 prompt 中形成 `<tuantuan-skills>` 索引，`AcpProcess` 同步替换额外只读范围，拒绝根外符号链接；索引不注入 Skill 正文。前导斜杠命令保留原始 blocks，不依赖异步命令声明；身份和 Skills 索引不改变命令文本，身份延后到普通消息注入。回放会话时剥离内部索引。停止写共享项目链接；历史未知归属链接作为原生项目来源保留，不推断所有者后删除。BYOK 只允许 `load_skill` 读取当前启用项。

Grok 额度沿用 `AcpProcess`，初始化后只发送 `_x.ai/billing`，不建立模型会话；解析当前周期百分比及旧版 credits schema，缓存最新查询和错误。此处是 Grok 的只读扩展，不引入原生 provider 适配层。

`server/registry-usage.ts` 负责 Antigravity / ZCode 的额度解析和只读 ACP 查询。Antigravity 等待当前会话声明 `/usage` 后发送原生命令；ZCode 直接发 `account/usage_stats`，不建会话或调用模型。`app.ts` 在成功登录 / 握手的同一进程查询并保存公开额度快照，手动刷新单飞；页面读取缓存，不启动登录。失败保留未知与错误，不用旧数值冒充新结果。ZCode 0.70.0 仅覆盖个人渠道，团队套餐明确标注未支持。

额度刷新、Harness 检测与登录请求在入口校验后关闭 HTTP 的默认空闲超时，实际等待仍受各 ACP 操作的超时限制。`process-tree.ts` 统一隔离进程清理错误：进程组信号失败保留日志，仅对尚未退出的原始子进程尝试回退；延迟强制终止同样不抛出未捕获异常，显式强制终止会撤销旧计时器。主进程先退出时仍回收其组内后代；清理失败不能覆盖查询结果或终止团团服务。

群聊引用由 `POST messages` 的 `replyToId` 指定；`Store.insertMessage` 在写入事务中校验同房间及完成态，再生成最多 400 字符的快照。前端不能提供引用正文；原消息不在近期历史时仍能向本轮 prompt 提供引用。`content` 只含用户的新文本，引用不会进入 @ 路由解析，也不递归复制被引用消息的引用。

1. 人类消息写库后立即路由成独立的根任务：单 Agent → 该 Agent；多 Agent 时 @所有人 → 全部成员；@具体成员 → 这些成员；没有 @ → 群主负责统筹。只有最后一种 run 保存 coordinatorId 和 rootTaskId，其余是直接对话。更换群主只影响新 run。同一房间不同 Agent 并行，同一 Agent 按入队顺序执行；新消息不取消旧任务，不同房间互不阻塞。
2. `RoomState.tasks` 提供 taskId、runId、parentTaskId、agentId、messageId、请求文本与 queued / running / cancelling / waiting 状态；协调任务另带 coordination（lead / work / review）。已完成但仍有活动后代的任务显示为 waiting，保留停止剩余工作的入口。`activeRunId` 仅保留为兼容的忙碌标志，`queued` 计数任务；界面不从单个 runId 推断全部运行状态。`idle(roomId)` 等到队列、衍生交接和自动跟进全部结束。
3. 单个回合：取得（或新建 / 恢复）该 Agent 在本会话的 ACP session。群聊转述只取原始请求之前、该 Agent 上次发言之后的记录；交接额外带上同一人类请求中已完成的回复。`<tuantuan-task>` 明确原始消息与引用，避免新消息或后续发言替换排队任务。每轮另附 `<tuantuan-coordination>` 指定 leader / member / direct 职责及 initial / review 阶段，不把群主职责写死在可能缓存的身份文档中。单 Agent 的新请求直接收到用户消息（含图片）；群聊缩为单人时，已有协调 run 保留职责与结果上下文直至收尾。身份文档按 Harness 传递（见 README）；不支持的 Harness 附加在会话第一条 prompt 前的 `<tuantuan-identity>` 中。
4. `session/update` 按 messageId 实时推送，同时折叠进时间线；回合结束时写库。权限请求以 `permission` 事件推送，用户回答后返回给 Harness。取消或删除后的迟到更新不能继续写入回复。
5. `POST /api/rooms/:id/cancel {taskId}` 只取消该任务及 parentTaskId 可追溯的后代，保留独立根任务和兄弟任务。排队任务直接移除；运行任务变为 cancelling，待 Harness 结束才放行同一 Agent 下一项。群聊缺 taskId 返回 400；DM 空请求兼容为停止当前任务，保留后续队列。删除房间、修改项目目录 / 归属或停机使用 `cancelAll`；移除 Agent 使用 `cancelAgent`，只传播到其交接后代。
6. Host 取消：prompt 先检查 AbortSignal；初始化等待可被取消，取消后不发送 prompt，同一 slot 的预热可供后续请求复用。已发出的 prompt 先发 `session/cancel`、解决挂起权限；默认 4 秒仍未返回则销毁该「房间 + Agent」的 Harness 与 ACP 终端进程组，保留部分回复并标为 cancelled，其他房间和 Agent 继续执行。同一 room / Agent 的重入 prompt 与活动期间切换历史会话返回 409。
7. 交接：运行中的 Agent 调用 `handoff`，校验其他成员，并同步预占该人类消息共享的最多 5 次交接预算；来源正常结束后才创建子任务。协调 run 仅允许冻结的群主分工，成员结果自动回流；直接对话仍可按需继续交接。相同轮次已有排队 / 运行任务或预占的目标去重，`@所有人` 每成员只触发一次；不跨独立人类消息去重。失败或取消释放未派发预算，不产生后代。接手方按自己的 FIFO 排队，prompt 附 `<tuantuan-handoff from="…">task</tuantuan-handoff>`；时间线保留 `handoffs` / `handoffFrom`。角色属于本次请求，不形成固定 Agent 上下级。
8. 初始化去重与失效：同一房间 / Agent 的 opening 按配置签名复用并记录代次；发布 session 前再次核对签名与代次。Agent 设置、项目目录或会话选择变更，以及停机时使旧 opening 失效，旧结果不能回写映射或 slot；相关旧请求返回 409，下一次请求按当前配置重试。失败或切换清理只移除该请求仍拥有的 slot，不删除其他房间相同 ACP sessionId 的映射。
9. session/load 回放：`switchSession` 指定历史会话时优先 load，回放的 update 存在 slot 里，`/replay` 接口按用户消息文本去掉本房间已有的轮次后返回，前端只读显示。刷新读取当前任务快照并重放期间的 WS 事件；服务重启不重放未开始的任务，已开始但未完成的回复沿用 interrupted 恢复规则。

群主自动跟进：调度器等同一分工任务的全部 work 子任务进入 done / error / cancelled 后，以 reviewScheduled 去重，仅创建一个新 review 任务，按群主 FIFO 执行。reviewOf 指向该批分工任务，parentTaskId 始终指向本轮根任务，保证停止根任务会覆盖全部批次。每批结果来自任务图与已保存消息，包含任务、状态、消息 id、错误与最多 6000 字符内容；不依赖有界的普通会话转述。Timeline.reviewOf 保存成员名字，刷新后仍能识别跟进消息。

review 可继续 handoff，重复分给已结束的成员仍消耗共享的 5 次预算；自动返回本身不计预算，耗尽后仍有最后一次汇总机会。取消成员会向群主报告，该成员本轮禁止重派；根任务或该批来源已取消、群主已移除、会话删除或停机时不再创建 review。

`read_result(messageId, offset)` 以 6000 字符分页读取本轮已结束的 Agent 消息，返回 nextOffset（null 表示结束）；服务端校验成员身份、活动任务归属、roomId / runId、消息类型和偏移。`list_members` 补充最多 600 字符身份说明。群聊工具列表不随 leader / member 角色变化，执行权限在 call 中校验；缩为单人后仍在运行的协调轮保留结果读取能力。

Host slot 记录是否已接入团团 MCP，并将可用性纳入初始化签名；单聊加成员变群聊时，下一次空闲 attach 通过已有 resume / load 更新 mcpServers，按 Harness 能力保留会话历史。活动期间的界面查询复用现有 slot 或预热，不更换进程、回调或权限请求，下一任务再刷新。MCP 可用性相同不重复重连，单纯换群主不会刷新工具接入。

交接与结果读取请求的归属在 MCP HTTP 入口读取正文之前绑定到 taskId，整个 batch 使用同一上下文；BYOK 工具回调在 prompt 开始时捕获。真正执行时核对仍是同一个未取消任务，避免旧请求延迟解析后归到下一轮。MCP endpoint 仍按房间 / Agent 注入并供 session 复用；完全在旧 prompt 结束后才新发起、且不携带轮次标识的外部调用无法区分来源，依赖 Harness 遵守 prompt 生命周期。

资源随归属释放：删除会话 / 项目 / Agent、移除成员或变更项目目录 / 归属时，先取消对应任务，再由 `HarnessHost.releaseRoom` 清理对应 opening、slot、权限、BYOK 历史及进程；旧初始化结果不能重新挂回。普通任务停止保留可复用会话，进程仅在取消超时才强制回收。

## 取舍

- **每个房间的每个 Agent 一个进程**：即使工作目录相同也不跨房间共享，避免取消超时强杀误伤；代价是更多进程与内存，原有持久化会话恢复保持。
- **并行不隔离项目文件**：Agent 仍使用该项目目录，未自动分配 worktree 或给文件写入加全局锁；群主分工需明确职责和边界。调度保证派发、结果回流、预算及取消范围，分工质量与最终内容仍取决于模型和用户配置的身份指令。
- **身份文档不落盘**：不改用户仓库；拒绝了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 方案，因为它们会把登录态也换掉，每个 Agent 要各自登录。
- **文件路径校验不等于沙箱**：ACP 文件接口将目标及现存父目录解析为真实路径，拒绝工作目录及当前 Skill 只读授权范围外的目标和符号链接逃逸。终端仅校验初始 cwd；命令可使用绝对路径或自行切换目录，Harness 内置工具也按自身沙箱与权限运行。旧文档将这些都称为「限制在 cwd」过宽；当前不提供操作系统隔离，也不防御路径校验后发生的并发文件系统替换。
- **未做鉴权 / 多用户**：仅适合本机。

## Harness 来源与一键安装

- `detectHarness` 顺序：「Harness 页填的路径」→ 登录 shell 的 PATH → 团团内置（`bundled`，从团团自己的 `node_modules` 解析 ACP 适配器，用 `process.execPath` 的 Bun 启动）→ 团团安装（`managed`）。`TUANTUAN_PREFER_MANAGED=1` 时团团安装的优先。
- 桌面包默认不带 Claude Code / Codex 适配器（引擎各 250–400 MB）：首次使用时走 Registry 安装（`claude-acp` / `codex-acp`，npx 包，Bun 运行）。`TUANTUAN_BUNDLE_ADAPTERS=1` 打包时改为内置。登录命令按「内置 → 团团安装」两处找 Claude / Codex 可执行文件。
- Registry 安装：schema 与 `installManaged` 的直接入口均校验 id / 版本为安全目录段（版本不得与 manifest 保留名称冲突），并确认安装路径在 Agent 目录内、关键目录不是符号链接。二进制与 npx 先安装到带随机后缀的独立 `.partial` 目录；发布前检查取消信号，成功后替换版本目录并写 manifest，失败 / 取消清理暂存。Registry 版本变了提示更新；卸载只删团团目录。需要 Node ≥ 22 的包（`engines.node` 或常用定义里 `runtime: "node"`，如 MiniMax 的 better-sqlite3）用托管 Node（nodejs.org，校验 SHASUMS256）。uv 工具直接装到最终目录（venv 写死路径）。
- 一键安装（常用 Harness 的官方脚本 / bun / brew / npm）：`bash -c` 在登录 shell 环境里运行，`stdin` 关闭，日志去掉 ANSI 并折叠 `\r` 进度，最多保留 800 行；取消时连同子进程一起结束；15 分钟超时。完成后清掉登录 shell 环境缓存，页面重新检测。
- 测试：`mock-cli`（本地安装脚本）与 `tests/fixtures/mock-registry.ts`（本地 CDN + npm 源，二进制 / npx / 坏条目）；`TUANTUAN_REAL_REGISTRY=1` 跑真实安装与握手。

## 桌面（Electron）

- 服务端不进 asar：`resources/server`（源码 + 生产依赖）+ `resources/bin/bun`。主进程选空闲端口启动子进程组，等 `/api/health` 后加载窗口。退出时除服务端原组外，还追踪其 Harness / ACP 终端 / 安装任务的独立子进程组，按 pid 与启动时间保留身份，服务端退出后继续回收已记录组，避免误杀复用的组号；4 秒强退兜底。POSIX 依赖 `ps` 发现子组，不可用时仅回收原服务组；Windows 走 `taskkill` 进程树，平台实际验收分开记录。服务端收到退出信号时关闭 host / installer，并用 `TUANTUAN_PARENT_PID` 看门狗兜底。
- 登录 shell 环境在主进程解析一次，传给服务端，Harness 继承它（CC Switch 写的变量照常生效）。
- macOS：`titleBarStyle: "hidden"`，红绿灯位置 `{x: 18, y: 20}`；网页侧 `html[data-desktop="darwin"]` 让侧栏顶行左侧留出红绿灯位置，搜索和「+」排在红绿灯右边；`data-fullscreen` 由主进程在进入 / 退出全屏时经 preload 设置，全屏时不再留空。
