# Tuantuan

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

<a href="https://bosshanz.github.io/tuantuan/assets/six-windows.mp4"><img src="docs/assets/six-windows-poster.jpg" alt="Watch the Tuantuan promo video (35 s)" width="100%"></a>

**A local workspace for multi-agent collaboration.**

Bring Claude Code, Codex, DeepSeek, OpenCode, Pi, Grok Build, MiniMax Code, and other coding agents into project-based conversations. Tuantuan connects their coding runtimes (harnesses) through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com).

Run it as an Electron desktop app on macOS, Windows, or Linux, or use a browser with the local server. Bring your own harness account or API provider; Tuantuan does not include a model service.

![A lead agent hands a task to Alice](docs/screenshots/conversation-handoff.png)

*The screenshot shows the Simplified Chinese interface. English, Traditional Chinese, and Japanese are also available.*

## What you can do

- **Choose your harness.** Use an existing local installation or install an agent from the ACP Registry. Tuantuan also offers the official DeepSeek CLI prerelease as an on-demand install; see [setup and authentication](docs/harness.md). Setup guides you through the sign-in options provided by the harness.
- **Attach files and images.** Choose, drop, or paste attachments; drafts survive switching conversations and normal restarts. Text files are supplied inline, while image and binary support depends on the model and Harness. [Attachment limits](docs/conversations.md#文件与图片附件).
- **Work with a team.** Use one agent or several in a conversation. Mention members with `@`, or let a lead agent delegate, follow up, and bring the results together. Agents share the project's working directory.
- **Hand off useful context.** Structured handoffs carry the task, goal, decisions, and pending work. Agents can read longer source messages and results in pages. Each agent keeps its own harness session; a handoff does not clone another agent's private session history.
- **Keep native coding workflows.** Claude Code, OpenCode, Pi, and Codex use their native prompts and context management. Tuantuan exposes the model, permission, reasoning, and slash-command controls reported by each harness; available capabilities vary.
- **See the work as it happens.** Follow streaming replies, thinking when provided, tool calls, diffs, terminal output, plans, and permission requests. Read Markdown and Mermaid diagrams, and stop individual tasks.
- **Use your API providers.** Configure compatible providers for Claude Code, OpenCode, Pi, and Codex. Direct BYOK mode supports OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages for chat and handoffs, without file or terminal tools. Compatibility depends on the harness and provider protocol.
- **Bring your setup.** Discover local Skills and Claude plugins, choose them per agent, and import CC Switch providers without modifying CC Switch. View token usage and quotas where the harness reports them. Tuantuan does not rewrite `~/.claude` or `~/.codex`.
- **Update when you are ready.** Desktop Settings → About & Updates checks for new releases and offers supported in-app updates. In-app installation is blocked while any Agent task is active and requires an explicit restart after all tasks finish. Homebrew installations continue to update through Homebrew; see [update and signing requirements](docs/install.md). macOS currently uses Homebrew or manual downloads; Developer ID signing is deferred.
- **Choose your language.** The interface supports English, Simplified Chinese, Traditional Chinese, and Japanese. Changing it leaves conversation content and model response language unchanged.

See the [full feature list (Simplified Chinese)](docs/features.md).

## Download v0.2.3

Get the desktop app from [GitHub Releases](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.3):

- **macOS**: Apple silicon (arm64) or Intel (x64), `.dmg` or `.zip`.
- **Windows**: x64 `.exe` installer.
- **Linux**: x64 `.AppImage`.

The desktop app includes its runtime; you do not need to install Bun. The v0.2.3 macOS builds are ad-hoc signed and are not notarized by Apple; the Windows installer is not code signed. See [installation and signing notes (Simplified Chinese)](docs/install.md).

### Install with Homebrew (macOS)

```bash
brew install --cask bosshanz/tap/tuantuan
```

The [tap](https://github.com/bosshanz/homebrew-tap) clears the quarantine flag after install, so the app opens without the Gatekeeper prompt below. Update with `brew upgrade --cask tuantuan`.

### First launch on macOS (not notarized)

Tuantuan has no Apple Developer ID yet, so macOS blocks the first launch. This is expected:

1. Open the `.dmg` and drag **tuantuan.app** into **Applications** (with the `.zip`, double-click it in Finder, then move `tuantuan.app` to Applications). Do not run it from inside the disk image.
2. Open it once. When macOS says it can't verify the app, click **Done** (not "Move to Trash").
3. Go to **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to "tuantuan was blocked", confirm with your password, then **Open**. On macOS 14 or earlier you can instead Control-click the app → **Open** → **Open**.
4. If macOS says the app "is damaged" or it still won't open, run this in Terminal and open it again:

   ```bash
   xattr -dr com.apple.quarantine /Applications/tuantuan.app
   ```

If the window says the service could not start, the log is in `~/Library/Application Support/团团/logs/server.log`.

## Quick start from source

Requires [Bun](https://bun.sh) **1.4.2**, the version used in CI.

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun run dev
```

Open **http://localhost:5173**. The first-run guide helps you choose or install a harness, sign in when needed, and create your first agent. Create a project for your working folder, then start a conversation with one or more agents.

The app starts in Simplified Chinese. To use English, open **设置 → 个人资料 → 界面语言** (Settings → Profile → Interface language) and select **English**.

To explore with simulated replies and no harness login, select the Mock harness after starting with:

```bash
TUANTUAN_MOCK_HARNESS=1 bun run dev
```

To serve the built frontend from the local API server:

```bash
bun run build && bun start
```

Open **http://localhost:8787**. The server listens on `127.0.0.1` by default and is designed for local, single-user use.

### Build the desktop app

After `bun install`, build an installer for your current operating system and architecture:

```bash
bun run desktop:install
bun run desktop:build
```

Output is written to `desktop/release/`. See [installation and packaging (Simplified Chinese)](docs/install.md) for platform details and signing.

## Documentation

The detailed documentation is currently in **Simplified Chinese**.

- [Installation](docs/install.md) · [Harnesses and ACP Registry](docs/harness.md) · [Conversations and handoffs](docs/conversations.md) · [Skills and plugins](docs/skills.md)
- [Providers, BYOK, and usage](docs/providers.md) · [Configuration and mock mode](docs/configuration.md) · [Interface](docs/ui.md) · [Development and testing](docs/development.md)
- [FAQ and known limitations](docs/faq.md) · [Product rules](docs/product.md) · [Architecture](docs/architecture.md) · [ACP implementation plan](docs/plan-harness-acp.md)

[Browse the documentation index](docs/README.md).

## Contributing

Issues and pull requests are welcome. Start with the [contributing guide (Simplified Chinese)](CONTRIBUTING.md) and [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities using the [security policy (Simplified Chinese)](SECURITY.md).

## Trademarks and third-party notices

Provider logos from [@lobehub/icons](https://github.com/lobehub/lobe-icons) identify the corresponding model providers. Trademarks belong to their respective owners; Tuantuan is not affiliated with or endorsed by them. See [third-party notices (Simplified Chinese)](THIRD_PARTY_NOTICES.md) and [model data sources and licenses](server/data/NOTICE.md).

## License

[MIT](LICENSE)
