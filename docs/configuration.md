# 配置与 mock 演示

环境变量和内置 mock Harness。

## 环境变量

见 `.env.example`：`PORT`、`TUANTUAN_HOST`（默认 `127.0.0.1`）、`DB_PATH`（默认 `data/agent-hub.db`）、`TUANTUAN_MOCK_HARNESS`。其他常用：`TUANTUAN_WORKSPACES`（项目根目录）、`TUANTUAN_HARNESS_DIR`（团团安装的 Harness）、`TUANTUAN_REGISTRY_URL` / `TUANTUAN_REGISTRY_OFFLINE`、`TUANTUAN_PREFER_MANAGED`、`TUANTUAN_NATIVE_PICKER=0`。

## 用 mock 演示

`TUANTUAN_MOCK_HARNESS=1 bun dev` 后可以选「Mock」Harness。它回复「收到：…」，并支持 `/plan`（计划）、`/edit`（权限请求 + diff）、`/run`（终端）、`/slow`（慢回复，用于测试停止）；多 Agent 会话里 `/handoff 名字 任务`、`/members`。

---

[← 返回 README](../README.md) · [文档索引](README.md)
