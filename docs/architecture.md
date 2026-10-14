# 架构

## 背景与约束

- 单人/小团队本地使用的 MVP：一个 Bun 进程 + 一个 SQLite 文件，无鉴权、无多实例。
- 必须在没有任何 API Key 时完整可运行、可测试 → 内置确定性 `mock` provider。
- 所有真实模型都走 OpenAI 兼容的 `chat/completions`（流式 + function calling），不引入各家 SDK。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/main.ts` | 读取配置与 Skills，启动服务 |
| `server/app.ts` | HTTP API（参数校验）、WebSocket 订阅、静态文件 |
| `server/orchestrator.ts` | **运行时编排**：房间队列、初始触发（@ / @所有人 / 按话题选择）、handoff 交接链、跳数上限、打断与取消、单个 Agent 回合（上下文构建 → 路由 → 工具循环 → 持久化/推送） |
| `server/decision.ts` | 百炼决策模型（systemone）客户端：构造问题、超时、严格解析返回 |
| `server/picker.ts` | 群聊没有 @ 时按话题选一个成员（决策模型 → LLM → 关键词规则 → 第一个成员） |
| `server/router.ts` | 任务分类（决策模型 → LLM 分类器 → 规则回退）、候选模型排序、按候选回退调用 |
| `server/classify.ts` | 确定性规则分类（router 与 mock 分类器共用） |
| `server/tool-loop.ts` | function-calling 循环 |
| `server/tools.ts` | 内置工具、为某个 Agent 组装工具集（内置 / MCP / `load_skill` / 群聊的 `handoff` / 设备房间的 `robot_express`、`robot_action`） |
| `server/mcp.ts` | MCP Streamable HTTP 客户端连接（官方 SDK） |
| `server/skills.ts` | 读取 `SKILL.md`、生成 Skill 目录提示 |
| `server/mentions.ts` | 人类消息里的 `@名字` / `@所有人` 解析（忽略引用、代码和转述行）；Agent 回复不解析 |
| `server/llm.ts` / `server/mock.ts` | OpenAI 兼容流式客户端 / 确定性假模型 |
| `server/store.ts` | SQLite 迁移与读写 |
| `server/device.ts` / `server/device-protocol.ts` | `/device` 设备协议：DeviceHub 管理设备连接、会话房间、由房间事件推导的会话状态、带 ack 超时的表情/动作下发（见 [device-protocol.md](device-protocol.md)） |
| `web/src/*` | React 前端：哈希路由、三栏布局、Agent 编辑、聊天视图、Cmd+K；样式为手写 CSS 变量（无 Tailwind） |
| `web/src/robot/*` | 虚拟桌面机器人：设备客户端（协议 v1）、Web Speech 封装、SVG 脸部与动作 |

前端直接 `import type` 后端的数据类型（`Agent`、`Message`、`RoomEvent`…），契约只有一份定义。

## 数据与状态归属

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Agent、MCP 服务、房间与成员、消息、路由决策 | SQLite（`Store`） | 唯一权威来源；前端刷新后从 API 重建 |
| 进行中的运行（每房间当前链 + 排队的人类消息 + AbortController） | `Orchestrator` 内存 | 进程退出即丢失；启动时把残留的 `streaming` 消息标记为 `interrupted`，不伪装成完成 |
| 流式增量文本 | 仅经 WebSocket 推送 | 消息完成（done / error / cancelled）时才把全文写库；刷新页面时进行中的消息显示为空直到完成 |
| Provider / 模型 / 路由表 / 限制 | `.env`（`AGENT_HUB_MODELS`、`DECISION_*` 等）+ 可选 providers.json（只读） | 启动时校验，非法直接失败；Key 只存在环境变量 |
| Skills | `skills/` 目录（只读） | 启动时加载；加载失败逐条报告 |
| 当前用户显示名 | 浏览器 localStorage | 无账号体系 |

表：`agents`、`mcp_servers`、`rooms`、`room_agents`、`messages`（`run_id` = 触发这条链的人类消息 id，`hop` = 0 人类 / 1 被人类触发 / ≥2 被 Agent 触发）、`routing_decisions`（每条 Agent 消息一条：plan JSON、attempts JSON、chosen_model）。迁移按 `PRAGMA user_version` 顺序执行，只追加。

## 编排

1. 人类消息写库并入房间队列；每个房间同时只执行一条链。群聊里新消息到达时，用原因「被新消息打断」中止当前链：正在流式输出的回复以 `cancelled` 保存已生成部分，未执行的交接写一条系统消息后丢弃。私聊不打断，按顺序排队。不同房间并行。
2. 初始触发：
   - 私聊 → 唯一的 Agent。
   - 群聊 @所有人 → 全部成员（按成员顺序）。这一轮里已经回复过的 Agent 不会再被交接触发。
   - 群聊 @具体成员 → 这些成员（不在房间的 Agent 不触发）。
   - 群聊没有 @ → `server/picker.ts` 选一个成员：决策模型对成员做一次 choice（置信度不足或选了 other 时回退）→ classifierModel 输出 JSON → 关键词（拉丁词 + 中文二元组）与"名称 + Prompt"的重叠数 → 第一个成员。选择结果写入该回复路由记录的 `plan.selection`。mock 分类器对选择请求用同一套关键词规则，因此结果是确定的。
3. 触发按 FIFO 顺序**串行**执行。Agent 回复成功后，把它本条回复里成功调用的 `handoff` 工具目标（排除自己、去重、跳过已在排队的）加入队列，`hop + 1`，并带上 task，写入接手方的系统提示。回复文本里的 @ 不解析。之所以用工具而不是解析文本：真实模型经常写"我可以让 @X 接手"这类提议，文本规则怎么改都会误判，工具调用才是明确的意图。handoff 只提供给非设备群聊房间，不计入路由的 toolCount。代价是模型必须支持 function calling（不支持时回退到下一个候选模型）。
4. `hop ≥ 2` 的每次执行计 1 次交接；达到 `maxAgentHops` 后停止整条链，并发一条系统消息列出未执行的触发。
5. 取消：中止当前链（正在流的消息以 `cancelled` 保存已生成部分）并清空该房间排队的人类消息（发系统消息说明数量）。

上下文：取房间最近 `contextMessages` 条消息，从新到旧累计不超过 `contextChars` 字符；自己的消息作 `assistant`，其他人作 `user` 并带 `[发言者]:` 前缀。系统提示包含名字、房间类型、其他成员、handoff 的使用规则（只有用户这次的请求确实需要对方现在动手时才交接，正文里的 @ 不会触发）、交接来的 task（如有）、Agent 自己的 Prompt、Skill 目录。

## 模型路由

```
信号(text, contextTokens≈字符/3, toolCount, hasImages)
  → 分类：决策模型 systemone（若设置 DECISION_BASE_URL）
            一次请求问 task_type(choice+other) / difficulty(score 3 级) / needs_tools(noul)
            失败/超时/格式错 → 下一级；单项置信度 < DECISION_MIN_CONFIDENCE 或 other → 仅该项用下一级结果
        → classifierModel（JSON 输出，严格校验枚举）── 失败/未配置 → 规则分类（记录失败原因）
  → 候选：具备该 task_type 标签且 contextWindow ≥ 1.2×contextTokens 的模型
          （无标签匹配则退回所有容量够的模型，并在理由中写明）
          排序：成本档 ≥ minTier[difficulty] 的按档位升序在前，低于的按档位降序在后
  → 调用：按候选顺序；仅当 provider 在输出任何内容前失败（ProviderError：HTTP 错误、连接失败、缺 Key）才换下一个
```

- 低置信度时选择"该项回退到下一级分类器"而不是"难度上调一档"：上调会在模型拿不准时系统性地选更贵的模型，而且这种代价不可见；回退更能如实反映实际用的是谁的判断，UI 和路由记录都会写明原因。
- needs_tools 只做一项调整：最终类型是 chat、Agent 有工具且 P(yes) ≥ 0.7 时改为 tool_heavy（记录在 note 里）。
- 决策模型的 score 是各等级下标按概率加权的期望（可能是 1.43 这样的小数），四舍五入到最近的等级。
- 启用的模型集合：设置了 `AGENT_HUB_MODELS` 时以它为准（1–5 个真实模型；provider 来自内置的 newapi/deepseek/qwen/doubao，或 providers.json 中的同名定义；标签/成本档/上下文来自内置目录、providers.json 或 `AGENT_HUB_MODEL_<n>_*` 覆盖）；否则用 providers.json；都没有就用 mock。固定到未启用模型的 Agent 会在编辑页和列表中标出，回复时如实报错。
- 固定模型的 Agent 跳过分类，只有一个候选，**不回退**（固定即意味着用户要这个模型）。
- 工具循环的后续轮次从上一轮成功的模型开始，避免同一回答中途换模型。
- 流开始后的错误不回退（否则会重复输出），直接以 `error` 状态结束并保留已生成内容。
- 每条 Agent 消息记录：信号、分类结果与来源、分类器错误、候选顺序、理由、每次尝试结果、最终模型。前端在消息下方显示一行弱化的来源（按话题选中 / 接 X 的交接 · 模型 · 已回退），点击在详情面板查看全部；会话信息面板汇总本会话的模型使用与回退次数。

## 工具与 Skills

- 工具 id：`builtin:<name>` 或 `mcp:<serverId>:<toolName>`。保存 Agent 时校验 id 是否存在；MCP 工具在每个回合实时 `tools/list`，服务端不再提供的工具作为警告写入路由理由，不静默消失。
- 工具循环最多 `maxToolIterations` 轮；工具异常以 `{"error": "..."}` 原样返回给模型，并在 UI 中标为失败。超过轮数时消息以 `error` 结束。
- Skills 渐进披露：系统提示只列 `name: description`；Agent 有 Skill 时自动获得 `load_skill` 工具，调用后才得到正文。

## 取舍

- **SQLite + 单进程内存编排**：满足 MVP，部署最简单；代价是不能多实例、重启中断进行中的回复。需要横向扩展时，运行状态应迁到持久队列。
- **链内串行**：保证消息顺序可读、跳数计数确定；代价是多个被 @ 的 Agent 不并行。
- **只在首个输出前回退**：保证用户看到的内容不重复；代价是流中途失败不能自动恢复。
- **MCP 每回合列工具**：反映服务端当前状态；代价是一次额外请求。
- **未做鉴权 / 多用户**：仅适合本机或可信网络。
