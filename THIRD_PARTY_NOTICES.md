# Third-Party Notices

团团（Tuantuan）本身以 MIT 许可发布。它使用或在安装包中分发了以下第三方组件，各组件版权归原作者所有，按其各自许可证使用。完整许可文本见各包的 `LICENSE` 文件（`node_modules/<包名>/LICENSE`）。

## 素材

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [@lobehub/icons](https://github.com/lobehub/lobe-icons)（`icons-static-svg`） | 模型厂商 Logo 的 SVG 路径，内嵌于 `web/src/brandIcons.ts` | MIT |
| [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans)（`@fontsource-variable/plus-jakarta-sans`） | 界面字体 | SIL Open Font License 1.1 |
| [Lucide](https://lucide.dev)（`lucide-react`） | 界面图标 | ISC |

厂商 Logo 是各公司的商标，仅用于标识对应模型；MIT 许可只覆盖 SVG 文件本身，不授予商标权。

## 模型目录与适配参考

| 来源 | 用途 | 许可证 |
| --- | --- | --- |
| [models.dev](https://github.com/anomalyco/models.dev) | 随包模型能力快照；来源与更新时间记在快照中 | [MIT](server/data/models-dev.LICENSE) |
| [Pi AI 1.0.4](https://github.com/earendil-works/pi/tree/main/packages/ai) | 思考等级、协议兼容字段与预算适配参考 | [MIT](server/data/pi-ai.LICENSE) |

目录快照不包含可执行配置；Pi SDK 由用户的 Pi Harness 加载，未作为新的团团请求依赖引入。详见 [模型数据说明](server/data/NOTICE.md)。

Codex 模型目录、effort schema 与通用指令在运行时从用户实际选择的 CLI 读取，不再随团团源码复制固定版本的提示词；临时派生目录在进程退出后删除。Codex 本身及其输出内容仍受上游适用许可证约束。

## 运行时依赖

| 组件 | 许可证 |
| --- | --- |
| @agentclientprotocol/sdk | Apache-2.0 |
| @agentclientprotocol/claude-agent-acp | Apache-2.0 |
| @agentclientprotocol/codex-acp | Apache-2.0 |
| @modelcontextprotocol/sdk | MIT |
| @xterm/xterm 6.0.0、@xterm/addon-fit 0.11.0 | MIT |
| mermaid 12.2.0 | MIT |
| highlight.js | BSD-3-Clause |
| react、react-dom | MIT |
| react-markdown、remark-gfm | MIT |
| zod | MIT |
| electron（桌面版运行时，含 Chromium 与 Node.js，其各自许可见安装包内 `LICENSES.chromium.html`） | MIT |
| electron-updater | MIT |

## 按需下载（不随源码分发）

Claude Code、Codex、Grok Build、OpenCode、MiniMax Code 等 Harness 默认不打进安装包，用户点击安装时从官方渠道或 ACP Registry 下载，受其各自的许可和服务条款约束。用 `TUANTUAN_BUNDLE_ADAPTERS=1` 打包时，Claude Code / Codex 的适配器会被打进安装包，其中 Claude Code 本体受 Anthropic 商业条款约束，请自行确认再分发是否合规。

## 开发工具（不分发）

Vite、@vitejs/plugin-react、TypeScript、Biome、Playwright、electron-builder 等，许可证为 MIT 或 Apache-2.0。
