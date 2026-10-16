# 参与贡献

欢迎 Issue 和 PR！

## 开发环境

需要 [Bun](https://bun.sh) ≥ 1.3。

```bash
bun install
bun run dev          # 前后端开发模式
bun run check        # 类型检查 + Biome + 单元测试（提交前必须通过）
bun run build && bun run e2e   # 端到端冒烟测试
bun run desktop:install && bun run desktop:build && bun run desktop:smoke   # 桌面版
```

## 提交 PR

1. 从 `main` 新建分支，一个 PR 只做一件事。
2. 提交前跑 `bun run check`；改了界面请附截图，涉及桌面行为请跑 `desktop:smoke`。
3. 截图只用 mock 数据，不要包含真实 API Key、个人路径或邮箱。
4. 不要提交 `.env`、`config/providers.json`、打包产物。
5. 用户可见的改动请同步更新 README。

## 报告问题

Bug 和功能建议请用 Issue 模板；安全问题请看 [SECURITY.md](SECURITY.md)。

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。贡献的代码按 [MIT](LICENSE) 许可发布。
