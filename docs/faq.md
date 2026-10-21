# 常见问题与已知限制

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 「Harness」页显示未安装 | 在终端里 `which <命令>` 确认已安装；GUI 启动时找不到的话，在「Harness」页填绝对路径。 |
| 发消息后提示 Authentication required | 该 Harness 没登录：按「Harness」页的登录方式在终端登录后重试。 |
| DeepSeek 握手成功，但登录状态仍是未知 | 官方预发布 ACP 不通过握手验证 Key；初始化和建会话成功只表示连接可用。可在 Harness 页填写 `DEEPSEEK_API_KEY`，或沿用本机凭据；有效性以真实请求结果为准。 |
| 在团团更换 DeepSeek Key 后仍使用旧凭据 | 固定版本的 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`）优先于环境变量；Agent 自己的 `DEEPSEEK_API_KEY` 也优先于团团保存值。按 [DeepSeek 配置说明](harness.md#deepseek-官方-harness预发布)核对当前凭据来源，团团不会覆盖本机凭据文件。 |
| Antigravity 只能选 Gemini，没有 Opus | Antigravity ACP 1.4.0 对第三方模型按客户端开放；团团当前只显示 Harness 实际返回的模型。登录或额度可查不等于 Opus 已开放，应以当前 Harness 返回结果为准。 |
| Agent 想改文件但没反应 | 查看权限弹窗；提交失败可原地重试。经团团 ACP 文件接口访问的目录外路径会被拒绝。 |
| e2e 找不到浏览器 | 设置 `CHROME_PATH` 指向本机 Chrome。 |

## 已知限制

- **macOS 包未签名、未公证**：没有 Developer ID 证书时只做本机 ad-hoc 签名，第一次打开需在「系统设置 → 隐私与安全性」点「仍要打开」（macOS 14 及更早也可按住 Control 点按 →「打开」），或执行 `xattr -dr com.apple.quarantine /Applications/tuantuan.app`，详见[安装与运行](install.md)。
- **Windows 版未测试**：能打包，但还没在真实 Windows 机器上验证过。
- **部分功能待 Mac 真机验证**：系统通知与权限申请、程序坞未读数、无边框标题栏的拖动区域，目前只在 Linux/模拟环境中测试过。

---

[← 返回 README](../README.md) · [文档索引](README.md)
