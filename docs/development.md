# 开发与测试

开发命令、测试与截图回归。贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

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
