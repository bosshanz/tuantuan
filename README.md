# 团团 Tuantuan

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/tuantuan-lockup-dark.svg">
  <img alt="团团 Tuantuan" src="docs/brand/tuantuan-lockup-light.svg" width="330">
</picture>

**一群 Agent，团团协作。** 多 Agent 协作工作台。

> 仓库已从 `bosshanz/agent-hub` 更名为 `bosshanz/tuantuan`（旧地址自动跳转）。为兼容，环境变量继续使用 `AGENT_HUB_*` 前缀，默认数据库路径仍是 `data/agent-hub.db`。

团团不自带模型：每个 Agent 绑定一个本机的编码 **Harness**（Claude Code、Codex、Grok Build、OpenCode），团团通过 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 驱动它。按 **项目**（名称 + 目录）组织 **会话**（1+ Agent）；多 Agent 时可 @、设主 Agent、交接。完整显示流式回复、思考、工具调用（diff / 终端输出）、计划、权限请求和用量。

![会话：主 Agent 用 handoff 把任务交给 Alice](docs/screenshots/group-chat.png)

- 模型、Key 和登录全部由 Harness 自己管理，团团不保存任何凭据。
- 不装任何 CLI 也能体验：`TUANTUAN_MOCK_HARNESS=1` 启用内置 mock ACP agent。

## 快速开始

需要 [Bun](https://bun.sh)（开发与测试使用 1.4.2；Skill 解析依赖内置的 `Bun.YAML`，更早版本未验证）。

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun dev          # 同时启动 API（:8787）和前端（:5173）
```

开发模式下 Vite 会把 `/api`、`/mcp` 和 `/ws` 转发到 API（列表在 `server/routes.ts`）。改了 `vite.config.ts` 或这个列表后要重启 `bun dev`。

打开 http://localhost:5173 ：

1. 首次启动自动打开「新手引导」（只出现一次，完成或跳过后记在数据库里）；之后在左侧「Harness」（`#/harness`）管理：检测本机已安装的 Harness，显示版本、安装命令和登录方式，可以填绝对路径覆盖、点「测试」做 ACP 握手。
2. 「Agents → + 新建」创建 Agent：选 Harness、权限策略、身份文档、MCP 服务器和环境变量。
3. 「会话」侧栏按**项目**分组。先建项目（新建目录，或选择已有文件夹；根目录默认 `~/Tuantuan`，可用 `TUANTUAN_WORKSPACES` 改），再在项目下建会话。未选项目时进默认项目「草稿」（`~/Tuantuan/drafts`）。会话共用项目目录；2+ Agent 时可设**主 Agent**。更换项目目录会重置该项目下会话的 Harness 上下文。

生产方式：`bun run build && bun start`（API 同时托管 `web/dist`，访问 http://localhost:8787）。

## 安装和登录 Harness

团团优先用你自己装的版本（登录 shell 的 PATH，或在「Harness」页填的绝对路径），这样会沿用你的版本和配置；找不到时才用团团内置的。「Harness」页会标出当前用的是「本机」「自定义路径」还是「内置」。

| Harness | 团团怎么提供 | 还需要什么 | 登录 |
| --- | --- | --- | --- |
| Claude Code | **内置**：`@agentclientprotocol/claude-agent-acp` 是团团的依赖，用团团自己的 bun 启动；它依赖的 Claude Agent SDK 按平台自带 Claude Code 可执行文件（macOS arm64/x64、Linux x64/arm64，含 musl） | 不需要另装 Claude Code 或 Node | 本机有 `claude` 就运行它完成 `/login`；没有时「Harness」页给出内置 Claude Code 的路径来登录；或设置 `ANTHROPIC_API_KEY`（CC Switch 写入的 `~/.claude/settings.json` 照常生效） |
| Codex | **内置**：`@agentclientprotocol/codex-acp`，它依赖的 `@openai/codex` 按平台自带 codex 可执行文件（macOS arm64/x64、Linux x64/arm64） | 不需要另装 Codex 或 Node | ACP 登录（ChatGPT）；或 `codex login`（没有全局 `codex` 时页面给出内置命令）；或 `OPENAI_API_KEY`。`~/.codex/config.toml` 照常生效 |
| Grok Build | **一键安装**：官方脚本 `curl -fsSL https://x.ai/cli/install.sh \| bash`（装到 `~/.grok/bin`，不需要 sudo） | curl、bash | `grok login`，或 `XAI_API_KEY` |
| OpenCode | **一键安装**：官方脚本（`~/.opencode/bin`）、`bun add -g opencode-ai`（`~/.bun/bin`）、Homebrew，或 npm（仅当全局目录可写） | 对应工具 | `opencode auth login`（自带免费模型时可不登录） |

![Harness 页：内置适配器与一键安装](docs/screenshots/harness.png)

一键安装只在你点按钮后运行官方安装命令：后台执行，日志实时显示，可取消，失败时显示最后一行错误，完成后自动重新检测。不会用 sudo；某种方式在这台机器上不可用（没有 curl / brew，npm 全局目录需要 sudo）时按钮置灰并说明原因。都不可用时显示手动安装命令。

内置适配器体积：每个平台约 250 MB（Claude Code）+ 330–400 MB（Codex），`bun install` 只下载当前平台的那一份。

「Harness」页的「握手测试」会报告是否已登录。未登录时，如果 Harness 通过 ACP 声明了自带的登录流程（如 Codex 的 ChatGPT / API Key、Grok 的 grok.com、OpenCode 的 opencode-login），点「用「…」登录」由 Harness 自己完成（可能会打开浏览器），完成后自动重新检测；否则复制旁边的登录命令到终端执行，再点「重新检测」。所有 Agent 共用同一份 Harness 登录。

> Claude Code 的适配器没有声明登录方式，而且未登录时也能建会话，所以「已登录」只代表握手和建会话成功；真正发消息时没登录会提示去终端运行 `claude` 登录。

**身份文档**：每个 Agent 的身份文档保存在团团里，不写进你的仓库。Claude Code 通过 `_meta.systemPrompt.append`、Grok 通过 `_meta.rules`、Codex 通过进程环境 `CODEX_CONFIG` 的 `developer_instructions` 传递；其他 Harness 在会话第一条消息前附加。

## 会话规则

| 你发的消息 | 谁回复 |
| --- | --- |
| `@产品经理 …` | 只有被 @ 的 Agent（可以 @ 多个，按顺序各回复一次） |
| 不 @ 任何人 | 会话的**主 Agent**（仅 2+ Agent） |
| `@所有人`（或 `@all` / `@everyone`） | 每个成员按顺序各回复一次 |

- 会话里所有 Agent 共用项目目录。2+ Agent 时创建会话会选主 Agent。
- **会话转述**：Agent 每次被叫到时，收到的是它上次发言之后会话里的新消息（最多 30 条、约 8000 字，超出时保留最新的并注明省略了几条）。单 Agent 会话直接转发用户消息。
- **交接**：多 Agent 会话注入 `tuantuan` MCP（`handoff` / `list_members`）。调用 `handoff` 后对方接手；界面显示交接卡片。正文 `@名字` 不会触发。
  - 只能交给会话里其他成员；去重与 `@所有人` 轮次规则同前。
  - 每条人类消息最多 5 次交接；新消息打断当前链。
  - 传输：HTTP `/mcp/<token>` 或 stdio 中转（`server/mcp-shim.ts`）。

## 能力

- 流式回复、思考过程、工具卡片（文件 diff、终端输出）、计划清单、用量。
- 权限请求弹窗：允许一次 / 总是允许 / 拒绝。文件读写和终端只能在项目目录内。
- 会话开始前可在输入框旁选**模型**（Harness 通过 ACP 声明的 model 选项；BYOK 可改会话级模型 ID）。多人会话按 Agent 分别记住。中途切换走 `set_config_option`。没有模型选项时不显示。
- Harness 提供的其他配置项（模式、推理强度等）和斜杠命令（输入 `/` 弹出）。
- 粘贴或拖入图片（Harness 支持时）、随时停止、会话列表（切换 / 恢复历史会话 / 新会话）。
- 切换到 Harness 里的历史会话时用 `session/load`，Harness 回放的历史中团团没显示过的轮次（按用户消息去重）以只读方式显示在消息列表顶部。

## 用 mock 演示

`TUANTUAN_MOCK_HARNESS=1 bun dev` 后可以选「Mock」Harness。它回复「收到：…」，并支持 `/plan`（计划）、`/edit`（权限请求 + diff）、`/run`（终端）、`/slow`（慢回复，用于测试停止）；多 Agent 会话里 `/handoff 名字 任务`、`/members`。

## 环境变量

见 `.env.example`：`PORT`、`DB_PATH`（默认 `data/agent-hub.db`）、`TUANTUAN_MOCK_HARNESS`。旧版的 `AGENT_HUB_MODELS`、`DECISION_*` 和各 provider Key 已不再使用（模型由 Harness 管理）。

## 界面

![Agent 编辑](docs/screenshots/agent-editor.png)

![侧栏：按项目分组的会话](docs/screenshots/sidebar.png)

![新建项目](docs/screenshots/new-project.png)

![新建会话](docs/screenshots/new-conversation.png)

![输入框旁的模型选择](docs/screenshots/model-picker.png)

- 现代简洁风格：干净的中性底色（浅色近白 / 深色石墨），品牌色是 Logo 里的番茄珊瑚红，只用在关键动作和状态上；Agent 头像用鲜亮的彩色区分。字体为 Plus Jakarta Sans（已自托管）+ 苹方，浅色/深色跟随系统。
- Agent 头像是 SVG Bot（13 种轮廓 × 13 种颜色），默认按 Agent id 生成，在编辑页点击头像修改。头像会根据状态变表情（思考、说话、难过、惊讶、休眠），开启「减少动态效果」时静止。预览全部表情：`/#/dev/avatars`。

## 开发命令

```bash
bun run check      # tsc 类型检查 + biome lint + bun test
bun run test       # 仅测试
bun run build      # 构建前端
bun run e2e        # 浏览器冒烟 + 对齐断言（需先 build，需要本机 Chrome；CHROME_PATH 可指定）
```


## 自定义 API（BYOK）

![Agent 编辑：自定义 API（BYOK）](docs/screenshots/agent-byok.png)

新建 Agent 时 Harness 选「自定义 API（BYOK）」：接口格式（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）、Base URL、API Key、模型，可点「测试连接」。

- 团团内置的轻量 harness，只做对话：SSE 流式、身份文档作系统提示、会话转述；多 Agent 时 `handoff` / `list_members` 以原生 function/tool call 提供（与 MCP 走同一处理逻辑）。**没有文件读写和终端。**
- API Key 只存服务端（SQLite），接口只返回掩码（如 `sk-••••abcd`），不写日志；编辑时留空即保持原 Key。

## 会话设置（模型 / 权限 / 推理…）

Harness 通过 ACP `configOptions`（及旧的 `modes`）提供的设置，显示在输入框底栏里的小标签上：图标、简短中文名和当前值，比如 `权限 询问`、`推理 高`。点开后是和模型选择器一样的弹层，列出选项名和 Harness 自己的说明。已知的 id/category（mode、model、effort/thought_level、thinking）会翻译成中文，其余沿用 Harness 给的名称。危险选项（Bypass permissions、full-access 等）用浅橙色标出。窗口较窄时，次要设置收进「…」。多 Agent 会话只显示一个「各自设置」标签，点开后按 Agent 分组。

弹层渲染在 `<body>` 下，跟随触发按钮定位：默认向上展开，空间不够时向下，不超出窗口。

**Agent 默认设置**：在 Agent 页选好 Harness 后，团团会在临时目录开一个一次性 ACP 会话来读取可用选项（按 Harness 缓存 30 分钟）。读不到时（例如未登录）会显示原因和「重试」按钮。新会话按「会话里改过的 > Agent 默认 > Harness 默认」依次生效。

**卡住与停止**：`session/resume` / `load` 超过 45 秒会改开新会话；切换设置超过 20 秒算失败，Harness 拒绝时会直接显示它返回的原因。点「停止」后，如果 Harness 4 秒内没有结束这一轮，团团会自己结束。回复 15 秒还没有任何输出时，会显示等了多久。

## 选择文件夹

浏览器拿不到绝对路径，所以由服务端弹系统对话框：macOS 用 `osascript choose folder`，Linux 桌面用 `zenity` / `kdialog`。都不可用时（或 `TUANTUAN_NATIVE_PICKER=0`）改用应用内的文件夹浏览器（面包屑、常用目录、最近项目、git 仓库标记）。接口统一为 `POST /api/fs/pick`、`GET /api/fs/dirs`、`GET /api/fs/places`；桌面壳可通过 `setNativePicker()` 换成自己的原生对话框。新建项目、项目设置、Skill 导入都用它。

![选择文件夹](docs/screenshots/folder-picker.png)

## Skills

每个 Agent 有自己的 Skills，按通用约定存放：`skills/<name>/SKILL.md`（frontmatter `name` / `description`，可带附属文件），兼容旧的 `commands/*.md`。

Agent 页「Skills」是一张勾选清单，自动列出：

- 用户级：`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`，以及 `~/.claude/plugins/**/skills`（插件名取自 `.claude-plugin/plugin.json`）；
- 项目级：右上角选中项目的 `.agents/skills`、`.claude/skills`；
- 已导入到该 Agent 的 Skills。

勾选即对这个 Agent 启用（只记录路径到 `<数据目录>/agents/<id>/skills-linked.json`，不复制）。Harness 本来就会读取的位置（如 Claude Code 的 `~/.claude/skills`）显示为已勾选且不可取消——要停用请改用户自己的配置。

「从链接添加」支持 GitHub 仓库 / `tree` 链接（下载 tarball）、原始 `SKILL.md` 链接、任意 git 地址（`git clone --depth 1`）：先列出找到的 SKILL.md，勾选后复制到该 Agent。「文件夹」用文件夹选择器导入本地目录。

![Skills](docs/screenshots/skills.png)

会话开始时，启用的 Skills 以符号链接放进会话目录里该 Harness 原生扫描的位置（同名已存在则跳过，不覆盖）：

| Harness | 位置 | 方式 |
| --- | --- | --- |
| Claude Code | `<会话目录>/.claude/skills` | 原生 |
| Codex | `<会话目录>/.agents/skills` | 原生（`$` 调用） |
| OpenCode | `<会话目录>/.agents/skills` | 原生 |
| Grok Build | `<会话目录>/.agents/skills` | 未见官方说明，按通用约定 |
| 自定义 API | 不写文件 | 模拟：系统提示列出名称和描述，`load_skill` 工具按需加载正文 |

不改 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`：它们同时存放 Harness 的登录信息，隔离会导致需要重新登录。会话目录里已有的 `.claude/` / `.agents/` / `.opencode/` Skills 也会被发现。

输入框里 `/` 弹出 Harness 通过 ACP `available_commands_update` 提供的命令，`$` 弹出 Skills；方向键选择，Tab / Enter 补全，Esc 关闭。


### ACP 能力对照（各 Harness）

输入框：`/` 弹出 `available_commands_update` 里的命令；`$` 弹出 Skills（Codex 会把 skill 以 `$name` 形式放进同一列表，团团会拆开）。

| | Claude Code | Codex | OpenCode | Grok | 自定义 API |
| --- | --- | --- | --- | --- | --- |
| Skills 发现 | `<cwd>/.claude/skills` | `<cwd>/.agents/skills`、`~/.agents/skills` | `.agents` / `.claude` / `.opencode` | 未见文档，按 `.agents/skills` | `load_skill` 工具（模拟） |
| `/` 命令 | 原生（含 skill 名） | 原生（`/skills`、`/review`…） | 原生 | 需登录 | 无 |
| `$` Skills | 无（skill 走 `/`） | 原生（`$demo`…） | 无（skill 走 `/` 或 `@`） | — | 无（用工具） |
| 会话 list/resume/fork | 有 | 有 | 有 | 视登录 | 无 |
| configOptions | mode/model/effort… | mode/collaboration_mode/model | model/mode | — | 无 |
| 未接进 UI | providers、additionalDirectories、subagents、elicitation 表单、session.compaction | 同上；`/review-branch` 等已在命令列表可选 | MCP sse、自定义 skill tool 的单独面板 | 登录后能力未探 | 文件/终端 |

**用户本地配置（CC Switch / Codex provider）**：团团**从不**设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`。Skill 只链到会话目录；进程继承登录 shell 的 `ANTHROPIC_*` / `OPENAI_*`；`CODEX_CONFIG` 只合并 `developer_instructions`，不覆盖 `model_provider`。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 「Harness」页显示未安装 | 在终端里 `which <命令>` 确认已安装；GUI 启动时找不到的话，在「Harness」页填绝对路径。 |
| 发消息后提示 Authentication required | 该 Harness 没登录：按「Harness」页的登录方式在终端登录后重试。 |
| Agent 想改文件但没反应 | 正在等你在权限弹窗里选择；或者目标路径在工作目录之外（会被拒绝）。 |
| e2e 找不到浏览器 | 设置 `CHROME_PATH` 指向本机 Chrome。 |

## 文档

- [docs/product.md](docs/product.md)：产品规则与验收条件
- [docs/architecture.md](docs/architecture.md)：模块、状态归属、路由机制与取舍


## License

MIT
