# 配置与 mock 演示

环境变量、界面语言、桌面休眠与内置 mock Harness。

## 环境变量

见 `.env.example`：`PORT`、`TUANTUAN_HOST`（默认 `127.0.0.1`）、`DB_PATH`（默认 `data/agent-hub.db`）、`TUANTUAN_MOCK_HARNESS`。其他常用：`TUANTUAN_WORKSPACES`（项目根目录）、`TUANTUAN_HARNESS_DIR`（团团安装的 Harness）、`TUANTUAN_REGISTRY_URL` / `TUANTUAN_REGISTRY_OFFLINE`、`TUANTUAN_PREFER_MANAGED`、`TUANTUAN_NATIVE_PICKER=0`。

## 模型能力目录

每个本机数据库的 `Store` 拥有独立模型目录，默认读取内置快照。服务商页「同步模型能力」成功后，将已校验快照存到 SQLite `settings.modelCatalog`；失败保留旧数据，损坏缓存启动时回退内置目录并显示诊断。无需设置 API Key，也不会在启动或对话时自动请求远程目录。

服务商 API 的可选 `modelCatalog` 是「请求中的原始模型 ID → models.dev 的 `provider/model` 引用」映射，例如 `{"company-main":"deepseek/deepseek-v4-pro"}`，存入 `providers.model_catalog` JSON 列。它只关联能力，不重写模型 ID；编辑时未提交该字段保留已有映射，空字符串或空映射恢复自动识别，新增或更改的未知引用拒绝保存。同步移除目录条目后，未更改的已有引用仍可保存，能力按未知处理，不阻断其他字段编辑。表单入口及四个 Harness 的限制见 [服务商](providers.md#模型能力目录与思考等级)。

## 界面语言与个人资料

在「设置 → 个人资料 → 界面语言」选择简体中文（`zh-CN`）、繁体中文（`zh-TW`）、英语（`en`）或日语（`ja`），默认简体中文，不按系统或浏览器语言自动选择。选择后自动保存，保存成功后立即切换；保存失败保留当前草稿，可点击页头「重试」。个人资料的连续修改按顺序保存，避免较早的请求覆盖后来的选择。

语言保存在服务端 SQLite 的 `settings` 表中，属于 `profile.language`，通过 `GET /api/profile`、`PUT /api/profile` 读取和更新。同一本机服务的已连接窗口通过 `profile.updated` 同步，重连时重新读取个人资料。浏览器的 `localStorage` 键 `tuantuan:language` 仅缓存启动语言，服务端返回的个人资料是权威来源；浏览器存储不可用不影响服务端保存。

切换覆盖应用界面、桌面菜单和系统通知中的应用提示；聊天与 Agent 正文、用户填写的名称、路径、模型 ID 以及未知第三方错误保留原文。界面语言不加入 Agent 指令，也不改变模型回复语言；需要指定回答语言时，可在「关于我」或 Agent 身份文档中自行约定。

## 桌面休眠设置

「设置 → 通知 → 任务运行」的「Agent 任务运行中阻止自动休眠」默认关闭，保存在桌面应用数据目录的 `settings.json`（`keepAwakeDuringTasks`）。开启时由桌面主进程汇总全部会话的运行状态，使用 Electron 的 [`prevent-app-suspension`](https://www.electronjs.org/docs/latest/api/power-save-blocker)，允许屏幕熄灭；最后一个任务结束、失败或取消时自动释放。连接中断时释放，重新连接后读取完整任务快照恢复。浏览器模式下开关不可用。

## 用 mock 演示

`TUANTUAN_MOCK_HARNESS=1 bun dev` 后可以选「Mock」Harness。它回复「收到：…」，并支持 `/plan`（计划）、`/edit`（权限请求 + diff）、`/run`（终端）、`/slow`（慢回复，用于测试停止）；多 Agent 会话里 `/handoff 名字 任务`、`/members`。

---

[← 返回 README](../README.md) · [文档索引](README.md)
