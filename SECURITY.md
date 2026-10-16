# 安全策略

## 报告漏洞

**请不要在公开 Issue 里报告安全问题。**

请通过 GitHub 私密漏洞报告提交：[Report a vulnerability](https://github.com/bosshanz/tuantuan/security/advisories/new)（仓库页 → Security → Advisories → Report a vulnerability）。

请尽量附上：影响的版本或提交、复现步骤、影响范围（例如 API Key 泄露、本机 API 被跨站访问、任意命令执行）。我们会在 7 天内回复，修复后在 Advisory 中致谢（除非你不希望署名）。

## 支持的版本

项目处于早期阶段，只对 `main` 分支的最新代码提供安全修复。

## 范围说明

- 团团的本机 API 默认只监听 `127.0.0.1`，并校验 Host / Origin；它**不提供远程访问鉴权**，把它暴露到公网不在支持范围内。
- 第三方 Harness（Claude Code、Codex 等）自身的漏洞请报告给对应项目。
