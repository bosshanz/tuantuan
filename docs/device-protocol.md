# 设备协议 v1（`/device` WebSocket）

虚拟桌面机器人（`#/robot`）和未来的真实硬件都走这个协议。设备只负责感知（ASR）和表达（TTS、表情、动作），会话状态、Agent 运行和历史都归后端所有。

## 连接与会话
- 连接 `ws(s)://<host>/device`，第一条消息必须是 `hello`，否则服务端关闭连接（1008 `not_ready`）。
- 每个 `(deviceId, agentId)` 对应一个持久的 dm 房间（表 `device_sessions`），房间名为「桌面机器人 · Agent 名」，会出现在聊天列表中，也可以在网页里继续聊。
- 服务端→设备的每条消息都带有本连接内单调递增的 `seq`。

## 设备 → 服务端
| type | 字段 | 说明 |
|---|---|---|
| `hello` | `protocol:1, deviceId, agentId, userName?, capabilities{expressions[], actions[], asr, tts}` | 握手并绑定 Agent |
| `bind` | `agentId` | 切换绑定的 Agent（切到另一个房间） |
| `utterance` | `id, text` | 一句用户话语。如果此时有运行中的回复，会先取消（barge-in） |
| `interrupt` | — | 打断当前回复 |
| `state` | `listening, speaking` | 设备本地状态，仅作参考 |
| `ack` | `id, ok, error?` | 对 `expression` / `action` 指令的执行回执 |

## 服务端 → 设备
`welcome{protocol, sessionId, roomId, agent}`、`session.state{state: idle|thinking|replying}`、`utterance.accepted{id}`、`reply.start` / `reply.delta{text}` / `reply.end{status, text, error?}`、`expression{id, name, durationMs}`、`action{id, name}`、`interrupt.result{cancelled}`、`error{code, message}`。

错误码：`invalid_message`（JSON 或 schema 不合法，发送后以 1008 关闭）、`not_ready`、`unknown_agent`（连接不关闭）、`busy`。

## Agent 控制身体
绑定到设备的房间里，Agent 会额外获得两个内置工具：`robot_express(name: neutral|happy|sad|surprised)` 和 `robot_action(name: nod|shake_head|tilt|wave|look_around|dance)`。工具会把指令下发给设备，并**等待设备 ack**（默认 3000 ms，可通过 `deviceAckTimeoutMs` 配置）。设备离线、不支持该能力、返回失败或超时，工具结果都会如实报告失败，不会假装成功。

## 决策
- 使用独立的 `/device` 端点，不复用 UI 的 `/ws`：两者的身份模型和背压需求不同，设备协议需要版本号和 ack。
- 会话状态（idle/thinking/replying）由 DeviceHub 根据房间事件推导，设备不自行维护。
- TTS 在 `reply.end` 之后朗读完整文本（流式片段不适合中文分句）。
- mock provider 根据关键词确定性地触发表情和动作（如「你好」→ happy + wave，「跳舞」→ dance），便于测试。
