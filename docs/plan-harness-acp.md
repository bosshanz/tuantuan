# 团团：Harness 与桌面版本计划

更新于 2026-10-20。本文只保留当前里程碑、有效决定与尚未完成的工作；实现细节和使用规则分别见[架构](architecture.md)、[产品规则](product.md)及[文档索引](README.md)。历史调研和逐轮执行记录可从 Git 历史查阅，不在这里重复累积。

## 当前状态

| 阶段 | 状态 | 结果 |
| --- | --- | --- |
| M1：单 Agent ACP 接入 | 已完成 | 生命周期、消息、工具、权限、配置与取消；界面按实际能力展示 |
| M2：多 Agent 协作 | 已完成 | 项目会话、@ 路由、群主协调、并行与排队、交接笔记及原文追读 |
| M3：桌面交付与更新 | 已发布，部分平台验证待补 | Electron + 随包 Bun；三平台构建；macOS Homebrew 跨版本升级已实测 |
| M4：更多 Harness 与扩展 | 按需求推进 | 官方 Registry 与明确标注的补充目录；DeepSeek Harness 已在 0.2.2 发布 |
| 0.2.3–0.2.4：文件与图片附件 | 已发布 | 输入框入口、文件传递、BYOK 与 Grok Build 图片支持、草稿恢复及官网更新 |
| 0.2.5：预览、搜索、待处理与文件列表 | 已发布 | 暗色图片预览与缩放平移；全历史正文搜索与原消息定位；真实授权、提问和失败的全局待处理列表；会话文件列表与 Markdown / 代码 / 静态 HTML 预览；修复首次引导卡片重叠与窄屏布局 |

## 保留的关键决定

| 决定 | 约束与资料 |
| --- | --- |
| Electron 壳 + Bun 服务端 | 桌面壳负责窗口和系统能力，复用同一本机服务；不引入第二套服务端。[架构](architecture.md) |
| 本机单用户工作台 | 不扩展远程账号或多租户。HTTP/WS 检查回环来源；文件范围检查不等于操作系统沙箱。[产品边界](product.md) |
| 原生 Harness 为主 | 原生提示词、模型、认证、上下文与压缩归 Harness；团团补充身份和协作上下文，不自研编码引擎。直接 BYOK 是已确认的对话例外。[Harness](harness.md)、[服务商](providers.md) |
| 本机安装优先，托管安装按需 | 优先用户 CLI；否则从 Registry 或标明来源的补充目录安装到团团目录。固定已验证版本，不全局安装、不要求 sudo。默认不捆绑 Claude/Codex。[安装](install.md) |
| 保留用户配置 | 不隔离或改写用户的原生登录目录；CC Switch 只读导入，选中的 Skills 按 Agent 生效。更新能力缓存不打断活动任务。[Skills](skills.md) |
| 能力来自实际运行时 | 模型与推理选项按真实 ACP/CLI 返回，未知能力保持未知；不伪造模型列表、不用握手成功冒充凭据有效。原生命令保持自身语义。[Harness](harness.md) |
| 项目拥有目录 | 会话成员共用项目目录；不同 Agent 并行，同一会话同一 Agent 排队。没有自动文件写锁或自动 worktree。[会话](conversations.md) |
| 群主负责协调，显式 @ 直达 | 不 @ 的群聊由群主分工和汇总；每条请求最多 5 次交接。停止沿实际依赖传播，独立任务继续。服务重启不重放内存队列。[会话规则](conversations.md#会话规则) |
| 上下文按来源保留 | 交接笔记显式记录，原文可分页追读；不复制其他 Agent 的私有历史、不自动生成共享长期记忆。可见聊天不等于原生模型上下文。[上下文](conversations.md#上下文交接与压缩) |
| 消息展示服务阅读 | 精简视图保留各 Agent 的关键正文，过程收进详情；真实阶段独立气泡、独立复制与引用。来源定位只高亮对应内容，可返回原位置；提问不强制全屏，结论与回复状态融合。[界面](ui.md) |
| 四语言只翻译应用文案 | 简中、繁中、英语、日语；不改用户内容、路径、模型 ID 或模型回复语言。[界面语言](ui.md#界面语言) |

## 发布与升级

| 版本 | 主要变化 | 发布记录 |
| --- | --- | --- |
| 0.2.0 | 聊天卡片、阶段气泡、引用定位与返回 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.0) · [PR #18](https://github.com/bosshanz/tuantuan/pull/18) |
| 0.2.1 | 检查更新、活动任务保护、正常退出保存工作区 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.1) · [PR #20](https://github.com/bosshanz/tuantuan/pull/20) |
| 0.2.2 | 官方 DeepSeek Harness 与输入交互修正 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.2) · [PR #22](https://github.com/bosshanz/tuantuan/pull/22) |
| 0.2.3 | 文件与图片上传、下载及草稿恢复 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.3) · [PR #23](https://github.com/bosshanz/tuantuan/pull/23) |
| 0.2.4 | Grok Build 图片支持与 GitHub Pages 站点同步 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.4) |
| 0.2.5 | 图片与文件预览、聊天搜索、待处理与会话文件列表；首次引导布局修复 | [Release](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.5) · [PR #24](https://github.com/bosshanz/tuantuan/pull/24) |

当前 macOS 使用 **Homebrew**，Apple Developer、Developer ID 签名和公证暂缓。应用内检查可用，但 Homebrew 升级不等于 macOS 原生 OTA 已验证。升级必须等 Agent 全部结束并正常退出；外部 brew 不受应用内安装锁控制。签名要求、更新流程与 tap 配置集中维护在[安装文档](install.md)。

发布先校验三平台产物及更新清单，再公开 Release，并同步 [Homebrew tap](https://github.com/bosshanz/homebrew-tap) 的版本和 macOS 双架构摘要。当前用校验脚本显式发布、手动推送 tap；尚未配置 `HOMEBREW_TAP_TOKEN`，不将此记为 Actions 自动同步成功。

### 已完成的实机升级验证

- 先通过 Homebrew 把本机建立为 **0.2.1** 基线，再发布 DeepSeek 版本并实际执行 **0.2.1 → 0.2.2** 升级；没有用源码热更新代替安装包升级。
- 0.2.1 设置页检查到 0.2.2；确认所有房间空闲后正常退出、备份数据并升级。新版应用与 Caskroom 均为 0.2.2，下载包摘要与 Release/tap 一致，DeepSeek 入口已出现。
- 用户确认草稿、引用和阅读位置恢复，界面核验后验证草稿已清空；恢复快照完成导入后被清除。原有消息、Agent、房间、项目与服务商记录不变。一条 Codex 原生会话映射在启动后重建，因此不声称所有 Harness 私有会话均原样延续。
- 真实跨版本这次没有携带图片；图片恢复另有隔离 Electron 验证，二者不混用。本机升级前备份保留作恢复材料。

v0.2.2 的 [CI](https://github.com/bosshanz/tuantuan/actions/runs/39133717186)、[三平台构建、Linux 桌面冒烟及产物校验](https://github.com/bosshanz/tuantuan/actions/runs/39134076338) 通过；公开附件大小与摘要已逐项核对。[tap 同步提交](https://github.com/bosshanz/homebrew-tap/commit/29ec35d) 与发布版本对应。macOS 包为 ad-hoc 签名，Windows 包未签名；不据此宣称正式签名、公证或 Windows 实机安装已验证。

### DeepSeek 接入边界

0.2.2 固定官方 `@deepseek-ai/dsh@0.2.1-rc.2`，原生 `dsh --profile acp`，标为实验性并按需安装；与既有 DeepSeek 服务商配置独立。握手与新建会话不验证 Key，因此认证状态保持未知。凭据优先级、Node 要求和未支持的原生能力见 [Harness 文档](harness.md)。

真实官方 CLI 的安装、握手、消息、配置、工具权限、取消、跨进程恢复及 stdio MCP 已在隔离环境验证，模型端点使用本机模拟响应；没有付费模型质量结论，HTTP MCP 仅确认能力声明。

## 0.2.3–0.2.4 附件交付

统一选择、拖放、粘贴入口，支持纯附件请求、预览、移除和原样下载；图片能力关闭时普通文件入口仍可用。附件按房间持久化，完成读入前等待保存提交，恢复旧草稿与桌面 checkpoint，不新增数据库迁移。Grok Build 在 `initialize` 中未声明 `promptCapabilities.image`，但实测 `session/prompt` 接受并解析 `ContentBlock::Image`，0.2.4 起按实测能力启用。

UTF-8 文本完整内联，原生 Harness 的二进制原件按精确只读路径授权并在进程重建后恢复；三种 BYOK 接口使用原生图片结构，不支持的内容明确报错。附件契约与限制集中见[会话文档](conversations.md#文件与图片附件)。

项目检查、完整 Chrome 冒烟、附件专项、跨端口的文件/图片/引用/阅读位置恢复均已通过，独立审查问题已修复并复核。使用隔离 mock ACP、本机 Grok CLI 1.0.62 实测与本机模型端点；安装包和 Homebrew 仍遵循上面的发布校验流程，实际交付以 Release/tap 为准。

## 0.2.5 交付

图片预览、聊天正文搜索和「需要我处理」已实现，并补齐其他窗口新建会话的导航与跨会话旧阅读位置恢复。首次引导的 DeepSeek 名称、实验标记与安装状态已重新排布，四种语言的窄窗口布局可用。会话文件列表纳入本版本：附件原件和 Agent 项目文件统一展示，支持图片、Markdown、代码与单文件静态 HTML 预览、下载、可用性提示与来源定位。文本预览上限 1 MiB，HTML 不运行脚本或加载外部资源。

全量项目检查（853 通过、40 条条件跳过）、完整 Chrome 冒烟、多窗口 / 阅读位置 / 文件列表回归及四语言布局检查通过，独立审查已收尾。Markdown / 代码 / 静态 HTML 预览、复制、错误恢复、隔离与 iframe 键盘返回验收通过。[发布提交 CI](https://github.com/bosshanz/tuantuan/actions/runs/39361330802) 与[三平台构建、Linux 桌面冒烟及产物校验](https://github.com/bosshanz/tuantuan/actions/runs/39362828034/job/118433708909)通过。实际 CI 生成的 macOS ARM64 包另经隔离启动验收，覆盖图片、Markdown 与 HTML 预览、搜索、文件下载与来源定位、mock ACP 提问及正常退出；[云端发布](https://github.com/bosshanz/tuantuan/actions/runs/39362828034/job/118433972980)核验全部附件摘要后公开；公开下载的 macOS ARM64 包另经 SHA256、签名与同一桌面流程复验。官网四语言页面和公开下载链接已核验。自动 Homebrew 步骤因仓库未配置 `HOMEBREW_TAP_TOKEN` 失败，已手动核验公开 DMG 的双架构摘要并[更新、推送 cask](https://github.com/bosshanz/homebrew-tap/commit/1c2c266)。以上不表示真实付费模型、Windows 实机安装或各平台原生升级已验证。

## 尚未完成或暂缓

- **系统钥匙串**：团团保存的 Key 当前为 SQLite 明文，专用接口掩码不是磁盘加密。原生 Harness 登录仍由自身管理。
- **正式签名与原生更新验收**：Apple Developer 暂缓；Windows 原生关窗/安装及各平台原生更新的实机验证按实际环境补做。Linux 首次启动失败保留恢复材料，需要手动恢复，不承诺自动回滚。
- **真实模型与协议差异**：确定性 ACP、真实 CLI 对本机模拟端点、真实付费模型是不同证据；没有用模拟通过替代后两者。Harness 变更后按实际能力复核。
- **按需评估的扩展**：ACP v2、专用上下文压缩展示、更多原生私有扩展、用户主动选择的独立 worktree；没有排入当前版本。

## 维护约定

本文件只在里程碑、关键决定或剩余工作变化时更新。用户行为写入 `product.md` / 对应使用文档，模块与状态归属写入 `architecture.md`，具体发布说明和检查日志留在 PR、Release 与 CI。删除失效决定时同步修正引用；不重复保留逐轮测试数量、暂时失败、工具步骤或已被最终结果覆盖的状态。
