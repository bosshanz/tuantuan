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
3. 群聊里输入 `@名字` 触发对应 Agent；私聊每条消息都交给该 Agent。

生产方式：`bun run build && bun start`（API 同时托管 `web/dist`，访问 http://localhost:8787）。

## 用 mock 演示

mock 模型根据文本中的指令给出确定性结果，方便不接 Key 就体验完整流程：

| 写在哪里 | 指令 | 效果 |
| --- | --- | --- |
| Agent 的系统 Prompt | `[[reply:@Bob 请你来处理]]` | 该 Agent 固定这样回复，用来演示 Agent 互相 @ |
| 发送的消息 | `[[tool:calculator {"expression":"6*7"}]]` | 调用工具（需在 Agent 上勾选），再根据结果回复 |
| 发送的消息 | `[[tool:load_skill {"name":"code-review"}]]` | 按需加载 Skill 正文 |
| 发送的消息 | `[[fail:small]]` | 让 `mock/small` 模拟故障，观察路由回退（分类器也用 small，会退回规则分类） |

例：Prompt 分别为 `[[reply:@PongBot 该你了]]` 和 `[[reply:@PingBot 该你了]]` 的两个 Agent 会互相 @，直到触发跳数上限（默认 5）。

## 接入真实模型

```bash
cp config/providers.example.json config/providers.json   # 已被 .gitignore 忽略
cp .env.example .env                                     # 填入对应的 API Key
```

`config/providers.json` 结构：

- `providers`：`{ id, type: "openai", baseUrl, apiKeyEnv }`，Key 只通过环境变量名引用，文件里不放密钥；`type: "mock"` 为内置模型。
- `models`：`{ id, provider, model, tags, costTier, contextWindow }`。`tags` 取值 `chat | coding | reasoning | long_context | tool_heavy | vision`；`costTier` 1（最便宜）~ 3（最强）。
- `router.classifierModel`：用于任务分类的便宜模型；省略则只用规则分类。`router.minTier`：各难度优先的最低成本档。
- `limits`：`maxAgentHops`（每条人类消息最多的 Agent 互相 @ 次数，默认 5）、`maxToolIterations`（默认 6）、`contextMessages` / `contextChars`（上下文窗口）。

文件不存在时使用内置 mock 配置；文件存在但不合法时启动直接报错，不会静默回退。

## 环境变量

见 `.env.example`：`PORT`、`DB_PATH`（默认 `data/agent-hub.db`）、`SKILLS_DIR`（默认 `skills`）、`AGENT_HUB_CONFIG`、`MOCK_CHUNK_DELAY_MS`，以及各 Provider 的 Key。

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
