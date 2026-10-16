# 开发与测试

开发命令、测试与截图回归。贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 模型目录维护

`bun run models:update` 显式下载 models.dev 公共目录，经与应用同步相同的 30 秒 / 15 MB 下载边界和 Zod 字段白名单校验后，原子更新 `server/data/models-dev.json`；失败不替换现有快照。维护者应一并审阅快照来源、时间、SHA-256 和模型能力变化。此命令更新仓库内置数据，界面的手动同步只更新当前数据库。来源及 MIT 许可证见 [server/data/NOTICE.md](../server/data/NOTICE.md)。

`tests/model-catalog.test.ts`、`tests/model-catalog-api.test.ts` 使用注入 fetcher 与临时 SQLite 覆盖识别、同步失败恢复、并发去重、缓存和能力关联。`provider-*-reasoning*-real.test.ts`、`provider-claude-real.test.ts`、`provider-codex-real.test.ts` 按文件注释启用实际 CLI，对隔离的本机 mock 验证 ACP 和请求体；不会据此推断真实模型质量。

## 开发命令

```bash
bun run check      # tsc 类型检查 + biome lint + bun test
bun run test       # 仅测试
bun run build      # 构建前端
bun run e2e        # 浏览器冒烟 + 对齐断言（需先 build，需要本机 Chrome；CHROME_PATH 可指定）
```

浏览器冒烟可用 `SHOTS_DIR=/tmp/tuantuan-shots` 保存截图；加上 `TERMINAL_VIDEO_DIR=/tmp/tuantuan-shots` 会保存终端动效录像 `project-terminal-motion.webm`，便于按原速检查展开、收起与快速反向操作。

图文回归已纳入 `bun run e2e`：覆盖流程图、时序图、源码回退与流式修正、明暗主题、图表与各类图片预览、键盘焦点及窄屏布局。`SHOTS_DIR` 同时保存 `mermaid-preview-light.png`、`mermaid-preview-dark.png` 和 `image-preview-narrow-dark.png` 等截图。场景使用持久化测试消息与确定性 ACP 数据，不调用付费模型。

---

[← 返回 README](../README.md) · [文档索引](README.md)
