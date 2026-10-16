# Skills 与插件

统一的 Skills / 插件库，以及每个 Agent 的 Skill 勾选与补全。

## Skills 与插件

设置里的「Skills 与插件」是团团统一的库：

- **本机（只读）**：`~/.claude`（skills、commands、agents、plugins 里的市场 / 已安装插件）、`~/.agents/skills`、`~/.codex`（skills、prompts）、每个项目的 `.claude` / `.agents`。显示来源和格式，团团从不写这些目录。
- **导入**：粘贴 GitHub / git / SKILL.md 链接，复制到团团自己的目录（`<data>/library`），可更新、删除。
- **插件**：Claude 插件格式（`.claude-plugin/plugin.json`，含 skills、commands、agents、MCP、hooks），显示各部分数量和每个 Harness 的支持情况。
- **按 Agent 勾选**：Agent 编辑页「Skills 与插件」里搜索、勾选。Claude Code 通过 `_meta.claudeCode.options.plugins` 加载选中插件（只对这个会话生效）；其他 Harness 拿到该 Agent 选中插件的 Skill 路径索引和 stdio MCP 服务器（ACP `mcpServers`）。已有原生技能仍由 Harness 的配置管理；缓存里存在一个插件不等于它已启用。

| | Skill | 命令 | 子代理 | MCP | Hook |
| --- | --- | --- | --- | --- | --- |
| Claude Code | ✓ | ✓ | ✓ | ✓ | ✓ |
| Codex、OpenCode、Grok、Pi、MiniMax | ✓ | ✕ | ✕ | ✓ 仅 stdio | ✕ |
| 自定义 API | ✓（load_skill） | ✕ | ✕ | ✕ | ✕ |

Codex 的 `~/.codex/prompts` 只有 Codex 自己会读。

![Skills 与插件](screenshots/library.png)

## Skills

每个 Agent 有自己的 Skills，按通用约定存放：`skills/<name>/SKILL.md`（frontmatter `name` / `description`，可带附属文件），兼容旧的 `commands/*.md`。

Agent 页「Skills」是一张勾选清单（新建 Agent 时就能勾选，保存后生效），自动列出：

- 用户级：`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、Antigravity 的 `$GEMINI_HOME/config/skills` / `antigravity-cli/skills`（默认 `~/.gemini`），以及 `~/.claude/plugins/**/skills`；
- 项目级：右上角选中项目的 `.agents/skills`、`.claude/skills`、`.opencode/skills`、`.gemini/skills`；
- 已导入到该 Agent 的 Skills。

勾选即对这个 Agent 启用（只记录路径到 `<数据目录>/agents/<id>/skills-linked.json`，不复制）。Harness 本来就会读取的位置（如 Claude Code 的 `~/.claude/skills`）显示为已勾选且不可取消——要停用请改用户自己的配置。

「从链接添加」支持 GitHub 仓库 / `tree` 链接（下载 tarball）、原始 `SKILL.md` 链接、任意 git 地址（`git clone --depth 1`）：先列出找到的 SKILL.md，勾选后复制到该 Agent。「文件夹」用文件夹选择器导入本地目录。

![Skills](screenshots/skills.png)

团团主动启用的 Skills 只给当前 Agent：每轮提供名称、描述和绝对路径索引，由 Harness 按需读取正文与附属文件；自定义 API 使用 `load_skill`。不再向共享项目写入技能链接，避免一个 Agent 的选择影响其他 Agent。取消勾选会撤销下一轮的索引和额外只读权限；已进入 Harness 历史的内容不会被追溯删除。

Harness 本来就会读取的全局 / 项目技能在设置里显示「原生可用」及实际来源，即使没有主动添加，也会出现在 `$` 菜单中。Antigravity 原生读取项目 `.agents/skills` 和 `.gemini/skills`。同一路径的符号链接合并时保留全部来源；旧版本留下但无法确认归属的项目链接不会自动删除。要停用原生技能，应修改对应 Harness 的配置或项目技能文件。

不改 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME`，保留用户原生配置和登录。前导 `/` 命令原样传递，不依赖命令声明到达的时机，不附加技能索引或首次身份文本，避免 `/usage` 等命令变成模型请求。

输入框里 `/` 弹出 Harness 通过 ACP `available_commands_update` 提供的命令；`$` 显示当前会话收到的完整 Skill 清单，可滚动浏览，并按名称或描述关键词搜索（名称前缀优先，也能匹配插件名称中的片段）。正文空白后也可输入 `$`，补全时保留前后文；金额和 Markdown 代码中的 `$` 不触发补全。方向键可遍历全部结果，Tab / Enter 选择，Esc 关闭并保留草稿。清单不因补全而启用其他目录或插件中的 Skill，Harness 实际可用范围仍由其会话和配置决定。

---

[← 返回 README](../README.md) · [文档索引](README.md)
