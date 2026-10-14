# agent-hub

动态 Agent 平台：在网页上用 **Prompt + Tools + Skills** 组合出 Agent，后台按任务 **自动路由模型**，Agent 可以在 **群聊** 中被 @，也能互相 @ 协作。

- 不需要任何 API Key 即可运行：默认使用内置的确定性 `mock` 模型。
- 接入真实模型只需配置 OpenAI 兼容接口（NewAPI、DeepSeek、通义千问、豆包等）。

## 快速开始

需要 [Bun](https://bun.sh)（开发与测试使用 1.4.2；Skill 解析依赖内置的 `Bun.YAML`，更早版本未验证）。

```bash
bun install
bun dev          # 同时启动 API（:8787）和前端（:5173），默认 mock 模型
```

打开 http://localhost:5173 ：

1. 左侧「Agents → + 新建」创建 Agent（名称用于 @，不能含空格）。
2. 「会话 → + 新建」建一个群聊并拉入 Agent，或与单个 Agent 私聊。
3. 群聊里输入 `@名字` 触发对应 Agent，`@所有人` 让每个 Agent 各回复一次，不 @ 时按话题自动选一个 Agent 回复；回复过程中发新消息会打断当前回复。私聊每条消息都交给该 Agent。

生产方式：`bun run build && bun start`（API 同时托管 `web/dist`，访问 http://localhost:8787）。

## 用 mock 演示

mock 模型根据文本中的指令给出确定性结果，方便不接 Key 就体验完整流程：

| 写在哪里 | 指令 | 效果 |
| --- | --- | --- |
| Agent 的系统 Prompt | `[[reply:好的]]` | 该 Agent 固定这样回复 |
| Agent 的系统 Prompt | `[[handoff:Bob 请你来处理]]` | 该 Agent 先调用 handoff 工具把任务交给 Bob（Agent 之间只能这样交接，回复里写 @ 不会触发） |
| 发送的消息 | `[[tool:calculator {"expression":"6*7"}]]` | 调用工具（需在 Agent 上勾选），再根据结果回复 |
| 发送的消息 | `[[tool:load_skill {"name":"code-review"}]]` | 按需加载 Skill 正文 |
| 发送的消息 | `[[fail:small]]` | 让 `mock/small` 模拟故障，观察路由回退（分类器也用 small，会退回规则分类） |

例：Prompt 分别为 `[[handoff:PongBot 该你了]]` 和 `[[handoff:PingBot 该你了]]` 的两个 Agent 会互相交接，直到触发跳数上限（默认 5）。

## 接入真实模型

### 只改 .env（推荐）

在 `.env` 里写 `AGENT_HUB_MODELS=provider/模型,...`（1–5 个），并填好对应 provider 的 `*_API_KEY`（以及 newapi 的 `NEWAPI_BASE_URL`），不需要 providers.json。可用的 provider 有 `newapi`、`deepseek`、`qwen`、`doubao`。

- 内置目录里已知的模型有 deepseek-chat、deepseek-reasoner、qwen-turbo、qwen-plus、qwen-max、qwen-long、qwen-vl-plus、doubao-seed-1-6-250615、doubao-seed-1-6-flash-250615，它们的标签、成本档和上下文长度都已预设。
- 其他模型需要在 `.env` 里写 `AGENT_HUB_MODEL_<序号>_TAGS / _TIER / _CONTEXT` 三项，序号从 1 开始。这三项也可以用来覆盖已知模型的预设值。
- 启动时会校验：数量必须在 1–5 之间、不能重复、provider 必须存在、Key 和地址必须齐全。出错时启动失败，并用中文指出是哪个变量有问题。
- `AGENT_HUB_CLASSIFIER_MODEL`（可选）：指定一个已启用的模型作为 LLM 分类器。
- 如果同时存在 providers.json，模型集合仍以 `AGENT_HUB_MODELS` 为准；providers.json 里的 provider 定义、模型元数据、router 和 limits 会被沿用。

### 决策模型（Auto 路由分类器，可选）

设置 `DECISION_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`（填业务空间地址，程序会自动拼接 `/compatible-mode/v1/systemone`；直接填完整 endpoint 也可以），就会启用百炼 `decision-model-preview` 来判断任务类型和难度。

- Key 用 `DECISION_API_KEY`，没填时用 `DASHSCOPE_API_KEY`。
- 其他可选项：`DECISION_MODEL`、`DECISION_MIN_CONFIDENCE`（默认 0.6）、`DECISION_TIMEOUT_MS`（默认 3000）。
- 调用失败、超时或返回格式不对时，按 LLM 分类器 → 规则 依次回退。某一项置信度太低时，只有这一项回退。
- 回复详情面板里会显示用了哪个分类器、各项置信度和回退原因。

### 使用 providers.json

```bash
cp config/providers.example.json config/providers.json   # 已被 .gitignore 忽略
cp .env.example .env                                     # 填入对应的 API Key
```

`config/providers.json` 结构：

- `providers`：`{ id, type: "openai", baseUrl?, baseUrlEnv?, apiKeyEnv }`，Key 只通过环境变量名引用，文件里不放密钥；`type: "mock"` 为内置模型。
  - 地址解析顺序：`baseUrlEnv` 指向的环境变量非空时用它（必须是合法 http(s) URL，否则启动报错并指出变量名）→ 否则用 `baseUrl` → 两者都没有则启动报错并指出 provider。
  - 示例配置里每个 provider 都有 `*_BASE_URL`，所以日常只需改 `.env`；newapi 没有默认地址，必须填 `NEWAPI_BASE_URL`（不用的话从 providers.json 删掉它）。
  - 启动日志会列出所用配置文件，以及每个 provider 的地址来源和 Key 是否已设置。没有 providers.json 时只用内置 mock，`.env` 里的 Key 不会生效（不会自动套用示例配置）。
- `models`：`{ id, provider, model, tags, costTier, contextWindow }`。`tags` 取值 `chat | coding | reasoning | long_context | tool_heavy | vision`；`costTier` 1（最便宜）~ 3（最强）。
- `router.classifierModel`：用于任务分类的便宜模型；省略则只用规则分类。`router.minTier`：各难度优先的最低成本档。
- `limits`：`maxAgentHops`（每条人类消息最多的 Agent 互相 @ 次数，默认 5）、`maxToolIterations`（默认 6）、`contextMessages` / `contextChars`（上下文窗口）。

文件不存在时使用内置 mock 配置；文件存在但不合法时启动直接报错，不会静默回退。

## 环境变量

见 `.env.example`：`PORT`、`DB_PATH`（默认 `data/agent-hub.db`）、`SKILLS_DIR`（默认 `skills`）、`AGENT_HUB_CONFIG`、`MOCK_CHUNK_DELAY_MS`，以及各 Provider 的 Key / BASE_URL、`AGENT_HUB_MODELS`、`AGENT_HUB_MODEL_<n>_*`、`AGENT_HUB_CLASSIFIER_MODEL`、`DECISION_*`。

## Skills

`skills/<名字>/SKILL.md`，YAML frontmatter 必须有 `name`（字母数字 `_-`）和 `description`。Agent 只在系统提示里看到名称和描述，需要时调用 `load_skill` 才注入正文。加载失败的 Skill 会在启动日志和 Agent 编辑页列出原因。

## 开发命令

```bash
bun run check      # tsc 类型检查 + biome lint + bun test
bun run test       # 仅测试
bun run build      # 构建前端
bun run e2e        # 浏览器冒烟（需先 build，需要本机 Chrome；CHROME_PATH 可指定）
```

## 文档

- [docs/product.md](docs/product.md)：产品规则与验收条件
- [docs/architecture.md](docs/architecture.md)：模块、状态归属、路由机制与取舍
- [docs/device-protocol.md](docs/device-protocol.md)：桌面机器人 / 硬件设备的 WebSocket 协议

打开 `#/robot` 可以体验虚拟桌面机器人：语音需要浏览器支持 Web Speech（Chrome），也可以用文字输入；mock 模型下说「你好」「跳舞」会触发对应的表情和动作。

## License

MIT
