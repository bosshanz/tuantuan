# 团团 Tuantuan

![团团 Tuantuan · 开源](docs/assets/poster.png)

<!-- 宣传视频占位：把 GitHub user-attachments 视频链接（https://github.com/user-attachments/assets/...）单独粘贴在下一行，GitHub 会自动渲染成播放器。 -->
https://github.com/user-attachments/assets/d6d0b112-2b6f-4f10-ba21-a4bdf45a910b


**一群 Agent，团团协作。** 多 Agent 协作工作台。

> 仓库已从 `bosshanz/agent-hub` 更名为 `bosshanz/tuantuan`（旧地址自动跳转）。为兼容，环境变量继续使用 `AGENT_HUB_*` 前缀，默认数据库路径仍是 `data/agent-hub.db`。

团团不自带模型：每个 Agent 绑定一个编码 **Harness**（Claude Code、Codex、Grok Build、OpenCode、Pi、MiniMax Code，以及 [ACP Registry](https://agentclientprotocol.com) 里的其他 Agent），团团通过 ACP（Agent Client Protocol）驱动它。按 **项目**（名称 + 目录）组织 **会话**（1 个或多个 Agent）；多个 Agent 时可 @、设主 Agent、交接。完整显示流式回复、思考、工具调用（diff / 终端输出）、计划、权限请求和用量。

![会话：主 Agent 用 handoff 把任务交给 Alice](docs/screenshots/conversation-handoff.png)

## 主要功能

- **多 Harness**：Claude Code、Codex、Grok Build、OpenCode 等通过 ACP 接入；优先用本机版本，没有时一键安装。
- **多 Agent 会话**：按项目组织；@ 指定成员，群主分工、跟进、汇总，`handoff` 交接。
- **完整过程**：流式回复、思考、工具卡片（diff / 终端）、计划、权限请求、Mermaid 图表。
- **服务商与用量**：自定义 API 可接入 Claude Code、OpenCode、Pi、Codex；通过 models.dev 目录与 Pi AI 兼容规则适配已知模型的思考档位，保留会话选择；另有纯对话 BYOK、CC Switch 只读导入、Token 统计与额度。
- **Skills 与插件**：自动发现本机 Skills / Claude 插件，按 Agent 勾选。
- **界面语言**：在「设置 → 个人资料 → 界面语言」选择简体中文、繁体中文、英语或日语，默认简体中文；保存后即时切换，聊天内容与模型回复语言保持原样。
- **桌面版**：macOS / Windows / Linux（Electron），也可浏览器 + 本机服务；团团从不改 `~/.claude` / `~/.codex`。

完整清单见 [功能一览](docs/features.md)。

## 快速开始（从源码构建）

需要 [Bun](https://bun.sh) 1.4.2。暂未发布安装包。

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun dev                                   # 浏览器打开 http://localhost:5173
# 或打桌面包：
bun run desktop:install && bun run desktop:build   # 产物在 desktop/release/
```

没装任何 CLI 也能体验：`TUANTUAN_MOCK_HARNESS=1 bun dev`。详细步骤见 [安装与运行](docs/install.md)。

## 文档

- [安装与运行](docs/install.md) · [Harness](docs/harness.md) · [会话与消息](docs/conversations.md) · [Skills 与插件](docs/skills.md)
- [服务商、BYOK 与用量](docs/providers.md) · [配置与 mock](docs/configuration.md) · [界面](docs/ui.md) · [开发与测试](docs/development.md)
- [常见问题与已知限制](docs/faq.md) · [产品规则](docs/product.md) · [架构](docs/architecture.md) · [ACP 计划](docs/plan-harness-acp.md)

全部文档索引：[docs/README.md](docs/README.md)。

## 商标说明

界面中出现的 Anthropic、OpenAI、Google、xAI、智谱、Moonshot、通义千问、DeepSeek、MiniMax 等模型厂商 Logo（来自 [@lobehub/icons](https://github.com/lobehub/lobe-icons)，MIT）仅用于标识对应厂商的模型。这些商标归各自所有者所有，本项目与这些公司没有关联，也未获其背书。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)、[行为准则](CODE_OF_CONDUCT.md)、[安全策略](SECURITY.md)；第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，模型目录与适配参考见 [server/data/NOTICE.md](server/data/NOTICE.md)。

## License

MIT
