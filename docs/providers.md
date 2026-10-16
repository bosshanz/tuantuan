# 服务商、BYOK 与用量

自定义 API（BYOK）、可复用的服务商、CC Switch 导入、Token 统计与额度。

## 自定义 API（BYOK）

![Agent 编辑：自定义 API（BYOK）](screenshots/agent-byok.png)

新建 Agent 时 Harness 选「自定义 API（BYOK）」：接口格式（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages）、Base URL、API Key、模型，可点「测试连接」。

- 团团内置的轻量 harness，只做对话：SSE 流式、身份文档作系统提示、会话转述；多 Agent 时 `handoff` / `list_members` 以原生 function/tool call 提供（与 MCP 走同一处理逻辑）。**没有文件读写和终端。**
- 对话上下文按完整成功轮保存，最多 20 轮；每次请求的序列化字符上限为 65,536，超限先移除完整旧轮，当前任务自身超限会提示错误。重启后继续同一上下文；新会话、成员移除或更换项目目录 / 归属会清空，失败或取消不会写入半轮。聊天记录仍可回看；字符预算不等于模型 token 窗口。
- API Key 以明文保存在服务端 SQLite，专用接口只返回掩码（如 `sk-••••abcd`），不写日志；编辑时留空即保持原 Key。服务商 Key、管理 Key 与 Harness `env_var` 登录 Key 也保存在同一数据库；打码不代表磁盘加密。Harness 原生登录态仍由 Harness 管理。普通 Agent 环境变量属于可读写配置，不能视为专用密钥存储。系统钥匙串集成仍未实现。

## 服务商与用量

左侧「服务商」页保存可复用的 API 服务商（名称、图标、Claude Code 地址、OpenAI 兼容地址、Key、主模型 / 快速模型、接口格式）。预设：Anthropic、OpenAI、xAI Grok、DeepSeek、Kimi、智谱 GLM、通义千问、MiniMax、硅基流动、OpenRouter、自定义。每个服务商可以「测速」（带 Key 请求 `/models`，显示延迟）、查「余额」（只有公开接口的才有），并用「切换 Agent」一键改用它。

Agent 页的「服务商」默认是 **本机配置**：完全沿用你自己的登录、CC Switch 和环境变量。选了服务商后只影响这个 Agent 的 Harness 进程：

- Claude Code：进程环境里设置 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`，并去掉继承来的其它 `ANTHROPIC_*`。
- Codex：初始化后通过 ACP `providers/set` 指定地址和 Key（只在进程内存里，不需要 `codex login`）；模型合并进 `CODEX_CONFIG`（保留 developer_instructions）。codex-acp 只支持 Responses 接口，所以只有「接口格式 = Responses」的服务商可选。
- 自定义 API（BYOK）：直接用服务商的地址和 Key。

团团从不写 `~/.claude`、`~/.codex`。Key 只存在团团数据库里，接口和页面只返回打码后的 `sk-••••1234`。编辑服务商后，用它的 Agent 下一轮会自动重启进程用上新设置；删除后这些 Agent 回到「本机配置」。

**从 CC Switch 导入**：点按钮后才去只读打开 `~/.cc-switch/cc-switch.db`（旧版为 `config.json`），列出 Claude / Codex 的配置，勾选后导入，不会修改 CC Switch。

**Token 统计**（页面最上方）：每轮回复结束时，团团记下 Harness 自己报告的 Token（ACP `PromptResponse.usage`，Grok 的 `_meta.usage`），连同 Agent、模型（`_meta.quota.model_usage` / `_claude/model` / 当前模型选项）、Harness、服务商、会话和时间存进本地数据库；费用只在 Harness 通过 `usage_update` 报告累计费用时按轮差分记录。从不估算：没报告的 Harness 显示「无数据」。可按 Agent / 模型 / Harness 分组（排名 + 输入 / 输出 / 缓存条形），看每日趋势，范围选今天 / 7 天 / 30 天 / 全部。

| Harness | Token | 模型 | 费用 |
| --- | --- | --- | --- |
| Claude Code | ✓ 每轮（含缓存读写） | ✓ | ✓ 累计费用差分 |
| Codex | ✓ 每轮（含缓存、思考） | ✓ | — |
| OpenCode | ✓ 每轮（含缓存、思考） | 当前模型选项 | ✓ 累计费用差分 |
| Grok Build | ✓ `_meta.usage` | 当前模型选项 | — |
| Pi | 无数据（只报告上下文占用） | — | — |
| MiniMax Code、自定义 API、Registry 其他 Agent | 报告了就记，否则无数据 | | |

![Token 统计](screenshots/usage-dashboard.png)

**额度**（同一页，支持查询的 Harness 各有卡片，可单独刷新）：

| 来源 | 内容 | 说明 |
| --- | --- | --- |
| Claude Code 本机记录 `~/.claude/projects/**/*.jsonl` | 今天 / 7 天 token | 与 ccusage 相同：按 message id + request id 去重 |
| Claude Code `/usage`（点刷新） | 5 小时 / 每周额度、重置时间、套餐 | 由 claude-agent-acp 自己查询；只用 API Key 时没有额度信息 |
| Codex 本机记录 `~/.codex/sessions/**/rollout-*.jsonl` | token、`rate_limits`（5 小时 / 每周）、套餐 | 取最新一条 `token_count` |
| Codex `/status`（点刷新） | 额度 | 需要已 `codex login` |
| Grok：官方 `grok usage <session-id>` | 今天 / 7 天 token、今天花费（有价格时） | 只查最近 7 天动过的会话 |
| Grok ACP `x.ai/billing` 扩展（点刷新） | 周期额度、重置时间、套餐、预付余额 | 沿用 Grok 自己的登录；只握手和查询，不创建会话、不发模型请求；旧版本不支持时提示更新 |
| Grok 每轮 ACP 返回的 `_meta.usage` | 计入「团团今天」 | |
| Antigravity 原生 `/usage` | 各模型组的额度窗口、重置时间、套餐 | 只在 Harness 声明该命令后查询，命令由 ACP 服务直接处理；API Key 等认证方式可能没有订阅额度 |
| ZCode ACP `account/usage_stats` 扩展 | 桥接返回的个人套餐额度与状态 | 只握手和查询，不发模型请求；0.70.0 不支持团队套餐，该结果不能代表原生 ZCode 的团队余额 |
| 余额：xAI `GET /v1/api-key`（检查 Key / 团队是否被停用，拿 team_id）+ Management API `GET /v1/billing/teams/{team_id}/prepaid/balance`（需另填 Management Key） | 预付余额（美元） | 没填 Management Key 时只显示 Key 状态 |
| 余额：DeepSeek `/user/balance`、OpenRouter `/api/v1/credits`、Kimi `/v1/users/me/balance`、硅基流动 `/v1/user/info` | 余额 | 其它服务商显示「没有公开的余额接口」 |
| 团团自己 | 今天每个 Harness / 服务商的轮数和 token | 来自每轮 ACP `session/prompt` 返回的 `usage` |

已安装或已绑定 Agent 的 Antigravity / ZCode 显示对应卡片。登录或握手成功后同步查询结果，卡片可手动刷新，并显示来源、查询时间与失败原因。公开额度结果可在重启后恢复；仅打开用量页不会启动登录或模型请求。不读钥匙串、不拿 OAuth token 调私有接口。

![服务商与用量](screenshots/providers.png)

Claude Code 用服务商时：Claude Code 会让 `~/.claude/settings.json` 里的 `env` 盖过进程环境变量，所以团团把服务商的地址、Key 和 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 通过会话的 `_meta.claudeCode.options.settings`（比用户设置优先级更高的程序设置层）传入，不写任何用户文件。Agent 的「默认设置」按 Harness + 服务商分别读取，模型列表是服务商的模型，可填自定义模型 ID；切换服务商会清掉旧的默认模型。

![从 CC Switch 导入](screenshots/ccswitch-import.png)

![Agent 的服务商](screenshots/agent-provider.png)

---

[← 返回 README](../README.md) · [文档索引](README.md)
