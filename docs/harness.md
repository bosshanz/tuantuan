# Harness：安装、登录与能力

团团如何发现、安装、登录各个编码 Harness，以及各 Harness 的 ACP 能力差异。

## 安装和登录 Harness

团团优先用你自己装的版本（登录 shell 的 PATH，或在「Harness」页填的绝对路径），这样会沿用你的版本和配置；找不到时用团团内置的（源码运行时）或团团管理的固定版本。「Harness」页会标出当前用的是「本机」「自定义路径」「内置」还是「团团安装」。桌面包默认不内置 Claude Code / Codex，也不捆绑 DeepSeek，下表「内置」一列指源码运行。

| Harness | 团团怎么提供 | 还需要什么 | 登录 |
| --- | --- | --- | --- |
| Claude Code | **内置**：`@agentclientprotocol/claude-agent-acp` 是团团的依赖，用团团自己的 bun 启动；它依赖的 Claude Agent SDK 按平台自带 Claude Code 可执行文件（macOS arm64/x64、Linux x64/arm64，含 musl） | 不需要另装 Claude Code 或 Node | 本机有 `claude` 就运行它完成 `/login`；没有时「Harness」页给出内置 Claude Code 的路径来登录；或设置 `ANTHROPIC_API_KEY`（CC Switch 写入的 `~/.claude/settings.json` 照常生效） |
| Codex | **内置**：`@agentclientprotocol/codex-acp`，它依赖的 `@openai/codex` 按平台自带 codex 可执行文件（macOS arm64/x64、Linux x64/arm64） | 不需要另装 Codex 或 Node | ACP 登录（ChatGPT）；或 `codex login`（没有全局 `codex` 时页面给出内置命令）；或 `OPENAI_API_KEY`。`~/.codex/config.toml` 照常生效 |
| DeepSeek | **按需安装**：团团补充的官方 npm 包 `@deepseek-ai/dsh@0.2.1-rc.2`，使用原生 `dsh --profile acp`，当前标为实验性 | Node ≥ 22.19；符合版本的本机 Node 优先，否则团团下载托管版本；本机 `dsh` 仍优先 | Harness 页填写 `DEEPSEEK_API_KEY`，或沿用本机 DeepSeek 凭据；握手不验证 Key，详见下节 |
| Grok Build | **一键安装**：官方脚本 `curl -fsSL https://x.ai/cli/install.sh \| bash`（装到 `~/.grok/bin`，不需要 sudo） | curl、bash | `grok login`，或 `XAI_API_KEY` |
| OpenCode | **一键安装**：官方脚本（`~/.opencode/bin`）、`bun add -g opencode-ai`（`~/.bun/bin`）、Homebrew，或 npm（仅当全局目录可写） | 对应工具 | `opencode auth login`（自带免费模型时可不登录） |

![Harness 页：内置适配器与一键安装](screenshots/harness.png)

一键安装只在你点按钮后运行官方安装命令：后台执行，日志实时显示，可取消，失败时显示最后一行错误，完成后自动重新检测。取消或超时会回收安装命令及其子进程组。不会用 sudo；某种方式在这台机器上不可用（没有 curl / brew，npm 全局目录需要 sudo）时按钮置灰并说明原因。都不可用时显示手动安装命令。

### DeepSeek 官方 Harness（预发布）

常用列表里的 DeepSeek 连接官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)。本次接入核实时，上游 ACP Registry 尚未收录它，因此团团补充了固定版本条目；「实验性」标记对应官方预发布状态。安装进入团团自己的目录，不装全局、不修改本机 `dsh`；桌面包按需下载。该版本需要 Node ≥ 22.19，优先使用符合版本的本机 Node，没有合适版本时由团团下载托管 Node，不用 Bun 运行。

可在 Harness 页的 Key 输入框保存 `DEEPSEEK_API_KEY`，也可沿用原生凭据。`DSH_HOME` 默认是 `~/.dsh`；此版本的原生查找顺序是 `$DSH_HOME/.credentials.yaml` → `DEEPSEEK_API_KEY` → 项目 `.env` → `$DSH_HOME/.env`。因此，本机已保存的凭据可能优先于团团注入的 Key；需要更换时应按 [DeepSeek 凭据规则](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/credentials/credentials-local/README.md)管理，团团不改写这些文件。团团保存的 Key 沿用下方的服务端保存与打码契约；Agent 自己的环境变量优先于团团保存的环境变量。

当前 DeepSeek ACP 不声明登录方法，`authenticate` 不执行凭据校验；初始化、建会话和读取模型选项都可能在无效 Key 下成功。团团因此在握手和建会话成功时将登录状态保留为「未知」，也不因没有环境变量 Key 阻止使用本机凭据。可识别的真实认证失败仍显示未登录及对应错误；重新握手不能证明 Key 有效。

模型、推理等级、MCP、权限、取消与会话恢复沿用实际 [ACP 能力](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/acp/acp/README.md)。固定版本提供会话 list / resume，不支持 `session/load` 历史回放或 fork；模型与推理以响应选项为准，图片以所选模型的实际能力为准。团团身份通过新会话首条普通消息传入。安装版本取自实际 npm 包 / CLI，ACP `agentInfo.version` 中的 `0.0.1` 不能代表 CLI 安装版本。

DeepSeek Harness 与「服务商」页的 DeepSeek 是独立入口：后者仍可供 Claude Code、OpenCode、Pi 或自定义 API 等兼容 Harness 使用，不会因安装 DeepSeek CLI 改变原绑定。

### ACP Registry 与「更多 Agent」

团团直接读取官方 [ACP Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)：启动时用本地缓存（没有缓存时用随包的快照，离线也能看），后台每 6 小时更新一次，「刷新」按钮立即更新；数据先过 schema 校验，坏条目跳过，更新失败保留旧数据并显示原因。图标从 Registry 下载后缓存在本地。

- 常用列表：Claude Code、Codex、DeepSeek、Grok Build、OpenCode、Pi、MiniMax Code。「更多 Agent」列出 Registry 与团团补充的条目（图标、名称、简介、版本、协议、平台），可搜索；补充来源会单独说明。
- 一键安装只在点按钮后执行，装到团团自己的目录（`<数据目录>/harnesses/agents/<id>/<版本>`，可用 `TUANTUAN_HARNESS_DIR` 改），固定版本，不用 sudo，不装全局：npx 包用团团自带的 Bun 安装运行；需要 Node ≥ 22 的（如 MiniMax Code）自动下载团团专用的 Node 22（校验 SHASUMS256）；uvx 包用你的 uv，没有就下载一份；二进制包按平台下载，带 sha256 时校验。
- Registry 的 Agent id、版本必须是安全的单个目录段；拒绝路径穿越和保留名称。二进制 / npx 安装先写入独立随机暂存目录，成功后更新版本目录与 manifest，失败或取消时清理暂存；uvx 因 venv 固定路径仍直接写目标版本目录，失败时清理该目录。
- Registry 版本变了显示「更新到 x」；可卸载团团装的版本。你自己装的版本始终优先（`TUANTUAN_PREFER_MANAGED=1` 反过来）。
- ACP / CLI 更新后，团团按实际启动文件及其配套引擎的身份重新读取能力，同一路径覆盖安装也会使旧选项缓存失效。运行中的任务继续完成，下次空闲接入时更换进程并重新握手；已保存的模型与 Think 选择仍按新版实际支持的选项恢复。Registry 刷新只发现更新，安装仍由用户触发。
- 装好的 Agent 可在新建 Agent 时选择；安装完成自动握手，已有安装可点「握手」重新检查。卡片按 Harness 声明提供登录按钮、终端命令或 Key 输入框；登录期间显示等待状态，失败保留入口供重试，无法确认登录状态时明确显示未知。
- **API Key 登录**：Agent 通过 ACP 声明 `env_var` 登录方式（如 glm-acp-agent 的 `Z_AI_API_KEY`）时，握手结果里直接出现输入框；普通登录方式在错误中明确指出缺少的 Key 变量名时，也会出现对应输入框。Key 保存在团团的数据库里（和服务商 Key 一样只在服务端、打码显示），只注入这个 Harness 的进程环境（Agent 自己的环境变量优先），保存后自动重新握手，可修改、清除。回复因为缺 Key 失败时，会话里显示「需要 API Key」并可当场填写。
- **终端登录**：终端类登录方式（ACP `terminal`，或说明里写着 `xxx --setup` 的）提供「在终端中打开」：用团团安装的绝对路径和运行时（如 `…/bun …/dist/index.js --setup`）打开 macOS「终端」（osascript）或 Linux 的终端程序；同时总有一行可复制的完整命令。团团不把它装进 PATH。
- 实验性：ZCode（社区桥接 `zcode-acp-server`，不在官方 Registry 里）。当前固定的 0.70.0 不支持团队套餐的运行时认证；旧 `builtin:bigmodel-coding-plan` 会映射到个人渠道。本机 ZCode 团队套餐能用，而桥接返回 1113 时，应先核对渠道，不能直接认定团队余额不足。团团不会静默改用个人账号或替换本机凭据。
- `TUANTUAN_REGISTRY_URL` 换 Registry 地址，`TUANTUAN_REGISTRY_OFFLINE=1` 不联网。

![更多 Agent：从 Registry 安装并握手](screenshots/harness-registry.png)

源码运行时的内置适配器体积：每个平台约 250 MB（Claude Code）+ 330–400 MB（Codex），`bun install` 只下载当前平台的那一份。

ACP 适配器与底层 CLI 可能是不同版本：Claude Code 默认使用所选适配器依赖的 SDK 引擎（可由 `CLAUDE_CODE_EXECUTABLE` 指定），Codex 使用适配器配套 CLI（可由 `CODEX_PATH` 指定），Pi 使用 `PI_ACP_PI_COMMAND` 或 PATH 中的引擎。升级一个未被当前适配器使用的全局 CLI 不会改变实际会话。新增 ACP 选项直接来自握手 / 会话响应；若上游改变协议或配置格式，团团需识别新契约后才能启用对应增强，不能仅凭版本号推测参数。

「Harness」页的「握手测试」会报告是否已登录。未登录时，如果 Harness 通过 ACP 声明了自带的登录流程（如 Codex 的 ChatGPT / API Key、Grok 的 grok.com、OpenCode 的 opencode-login），点「用「…」登录」由 Harness 自己完成（可能会打开浏览器），完成后自动重新检测；否则复制旁边的登录命令到终端执行，再点「重新检测」。所有 Agent 共用同一份 Harness 登录。

Registry 中的登录选项来自各 Harness 自己的认证方式。第三方服务商可在 Claude Code、OpenCode、Pi、Codex 和自定义 API 的 Agent 设置里选择，具体地址、格式和模型要求见[服务商](providers.md)；不能把一个 Harness 的登录选项当成任意服务商都兼容。

> Claude Code 的适配器没有声明登录方式，而且未登录时也能建会话，所以「已登录」只代表握手和建会话成功；真正发消息时没登录会提示去终端运行 `claude` 登录。DeepSeek 成功握手后则保留「未知」，其凭据有效性不能通过握手判断。

## 原生提示词与团团身份

Claude Code、OpenCode、Pi、Codex 的基础提示词由实际启动的 CLI / SDK 提供，团团不维护固定版本的正文副本。每个 Agent 的身份文档保存在团团里，不写进你的仓库；它与会话身份、可选个人资料一起按下表传递。

| Harness | 原生提示词来源 | 团团身份如何传入 |
| --- | --- | --- |
| Claude Code | 当前 SDK / CLI 的 `claude_code` preset | `_meta.systemPrompt.append`，保留原生 preset |
| OpenCode | 当前 CLI 及其原生 Agent 配置 | 新会话首条普通消息中的 `<tuantuan-identity>` |
| Pi | 当前 Pi 引擎及其原生资源、配置 | 新会话首条普通消息中的 `<tuantuan-identity>`；服务商扩展只配置模型与思考参数 |
| Codex | 当前 CLI 的模型目录及原生指令 | 合并 `CODEX_CONFIG.developer_instructions`；需要补充目录外自定义模型时，通用指令从当前 CLI 的隔离临时会话读取 |

Grok 通过 `_meta.rules` 传递身份；其他 Harness 使用首条普通消息。每轮额外选择的 Skills 索引、群聊转述、原始任务与本轮协作职责通过普通消息传递。首条是原生命令时，采用首条消息方式的身份注入会延后到普通对话，避免改变命令路由。

这里的「当前版本」指团团实际使用的引擎；升级另一份全局 CLI 不会改变它。已有原生会话可能保留此前保存的提示词，恢复、压缩或新建会话时如何重建由 Harness 自己决定。用户的原生提示词配置与扩展继续按各 Harness 的规则生效。上下文的所有者及恢复边界见[会话与消息](conversations.md#上下文交接与压缩)。

## ACP 能力对照（各 Harness）

输入框：`/` 弹出 `available_commands_update` 里的命令；`$` 弹出 Skills（Codex 会把 skill 以 `$name` 形式放进同一列表，团团会拆开）。

| | Claude Code | Codex | OpenCode | Grok | 自定义 API |
| --- | --- | --- | --- | --- | --- |
| Skills 发现 | `<cwd>/.claude/skills` | `<cwd>/.agents/skills`、`~/.agents/skills` | `.agents` / `.claude` / `.opencode` | 未见文档，按 `.agents/skills` | `load_skill` 工具（模拟） |
| `/` 命令 | 原生（含 skill 名） | 原生（`/skills`、`/review`…） | 原生 | 需登录 | 无 |
| `$` Skills | 无（skill 走 `/`） | 原生（`$demo`…） | 无（skill 走 `/` 或 `@`） | — | 无（用工具） |
| 会话 list/resume/fork | 有 | 有 | 有 | 视登录 | 无 |
| configOptions | mode/model/effort… | mode/collaboration_mode/model | model/mode | — | 无 |
| ACP 提问 | 客户端已接 form elicitation；原生触发未实测 | 同左 | 原生提问工具（默认启用）+ form elicitation | 视 Harness 声明 | 无 |
| 未接进 UI | providers、additionalDirectories、subagents、session.compaction | 同上；`/review-branch` 等已在命令列表可选 | MCP sse、自定义 skill tool 的单独面板 | 登录后能力未探 | 文件/终端 |

**ACP 提问（elicitation）**：团团向 Harness 声明 `clientCapabilities.elicitation.form`，不声明 URL 模式。Harness 以 `elicitation/create` 发起表单时，团团渲染提问卡片并接受 `string`（含 `enum` / `oneOf` 选项）、`number`、`integer`、`boolean`、`array` 字段；未知类型只读显示且不能提交。回答在服务端按同一份 schema 再校验一次。收起卡片、切换会话或打开设置不会取消提问，返回后保留本次应用运行中填写的答案；只有明确「取消提问」、停止任务或 Harness 进程退出才以 `cancel` 回应。刷新页面会从房间快照恢复未回答的问题，但未提交的表单值仅在本次应用运行中保留；存在待回答的问题时禁止安装应用更新。

OpenCode 的原生提问工具由 `OPENCODE_ENABLE_QUESTION_TOOL=1` 打开；通过团团启动 OpenCode 时默认注入该变量，登录 shell、Agent 环境变量或显式配置中的值优先。其他 Harness 是否提供提问取决于其 ACP 声明，团团不为未声明的 Harness 猜测能力。

**用户本地配置（CC Switch / Codex provider）**：正式对话进程沿用原生配置目录与登录态，团团不为它们覆盖 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`。额外选择的 Skill 通过当前 Agent 的按需路径索引提供，不写共享项目链接。「本机配置」继承登录 shell 的环境；身份注入合并 `CODEX_CONFIG.developer_instructions` 并保留其他键。显式选择团团服务商时按[服务商接入规则](providers.md#服务商与用量)配置对应进程。Codex 元数据与未知版本 OpenCode 配置探测使用隔离临时目录，不修改正式会话的配置。

---

[← 返回 README](../README.md) · [文档索引](README.md)
