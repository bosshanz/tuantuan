# Tuantuan

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

<a href="https://bosshanz.github.io/tuantuan/assets/six-windows.mp4"><img src="docs/assets/six-windows-poster.jpg" alt="Tuantuan の紹介動画を見る（35 秒）" width="100%"></a>

**複数のエージェントがローカルで協力するためのワークスペース。**

Claude Code、Codex、DeepSeek、OpenCode、Pi、Grok Build、MiniMax Code などのコーディングエージェントを、プロジェクトごとの会話で利用できます。Tuantuan は [Agent Client Protocol（ACP）](https://agentclientprotocol.com) を通じて、各エージェントの実行環境（ハーネス）に接続します。

macOS、Windows、Linux 向けの Electron デスクトップアプリ、またはブラウザーとローカルサーバーの組み合わせで動作します。モデルの利用には、ご自身のハーネス用アカウントや API プロバイダーを使います。Tuantuan 自体にモデルサービスは含まれていません。

![リードエージェントが Alice にタスクを引き継ぐ様子](docs/screenshots/conversation-handoff.png)

*スクリーンショットは簡体字中国語の画面です。日本語、英語、繁体字中国語にも切り替えられます。*

## 主な機能

- **メッセージとファイルを探す**：現在またはすべての会話を検索し、元のメッセージに移動して読んでいた位置に戻れます。会話のファイル一覧で過去の添付、画像、Agent のファイルを確認し、プレビュー、ダウンロード、出典への移動ができます。「対応が必要」には承認待ち、質問、失敗した応答をまとめて表示します。
- **ハーネスを選択**：ローカルにインストール済みのハーネスを使うか、ACP Registry からエージェントをインストールできます。Tuantuan が追加した公式 DeepSeek CLI のプレリリース版も、必要に応じてインストールできます。[インストールと認証の説明（簡体字中国語）](docs/harness.md)をご覧ください。ハーネスが提供するログイン方法に沿って設定を進められます。
- **ファイルと画像を添付**：選択、ドラッグ＆ドロップ、貼り付けに対応。会話の切り替えや通常の再起動後も下書きを保持します。テキストは内容を直接渡し、画像やバイナリの利用可否はモデルとハーネスによって異なります。[添付の制限（簡体字中国語）](docs/conversations.md#文件与图片附件)。
- **チームで作業**：1 つの会話に 1 人または複数のエージェントを参加させられます。`@` でメンバーを指定するほか、リードエージェントに分担、進捗確認、結果の取りまとめを任せられます。メンバーは同じプロジェクトの作業ディレクトリを共有します。
- **構造化された引き継ぎ**：タスクの説明、目標、決定事項、残作業を引き継ぎます。長い元メッセージや結果はページ単位で読み返せます。各エージェントは独自のハーネスセッションを使い、引き継ぎ元の非公開セッション履歴は複製しません。
- **ハーネス本来の機能を活用**：Claude Code、OpenCode、Pi、Codex のプロンプトとコンテキスト管理をそのまま使います。モデル、権限、推論、スラッシュコマンドの設定は、各ハーネスが提供するものを表示します。利用できる機能はハーネスによって異なります。
- **作業の過程を確認**：ストリーミング応答、ハーネスが公開する思考、ツール呼び出し、diff、ターミナル出力、計画、権限の承認要求を表示します。Markdown と Mermaid に対応し、タスクを個別に停止できます。
- **独自の API を利用**：Claude Code、OpenCode、Pi、Codex に互換プロバイダーを設定できます。直接接続する BYOK モードでは OpenAI Chat Completions、OpenAI Responses、Anthropic Messages に対応し、会話と引き継ぎが可能です。ファイル操作やターミナルのツールはありません。互換性はハーネスとプロバイダーのプロトコルに依存します。
- **既存の環境を利用**：ローカルの Skills と Claude プラグインを検出し、エージェントごとに選択できます。CC Switch を変更せずにプロバイダー設定を読み込み、ハーネスが報告するトークン使用量や利用枠を確認できます。Tuantuan は `~/.claude` や `~/.codex` を書き換えません。
- **4 言語の UI**：英語、簡体字中国語、繁体字中国語、日本語に対応しています。表示言語を変えても、会話の内容やモデルの回答言語は変わりません。

詳しくは[機能一覧（簡体字中国語）](docs/features.md)をご覧ください。

## v0.2.5 をダウンロード

[GitHub Releases](https://github.com/bosshanz/tuantuan/releases/tag/v0.2.5) からデスクトップアプリをダウンロードできます。

- **macOS**：Apple シリコン（arm64）または Intel（x64）向けの `.dmg` と `.zip`。
- **Windows**：x64 向けの `.exe` インストーラー。
- **Linux**：x64 向けの `.AppImage`。

デスクトップアプリには実行環境が含まれているため、Bun のインストールは不要です。v0.2.5 の macOS 版はアドホック署名を使用し、Apple の公証を受けていません。Windows 版にはコード署名がありません。詳しくは[インストールと署名の説明（簡体字中国語）](docs/install.md)をご覧ください。

### Homebrew でインストール（macOS）

```bash
brew install --cask bosshanz/tap/tuantuan
```

[この tap](https://github.com/bosshanz/homebrew-tap) はインストール後に隔離属性を自動で外すため、下記の Gatekeeper の警告は表示されません。更新は `brew upgrade --cask tuantuan` で行えます。

### macOS で初めて開くとき（未公証）

Tuantuan はまだ Apple Developer ID を持っていないため、初回起動は macOS にブロックされます。これは想定どおりです。

1. `.dmg` を開き、**tuantuan.app** を「アプリケーション」へドラッグします（`.zip` の場合は Finder でダブルクリックして展開し、`tuantuan.app` を「アプリケーション」へ移動します）。ディスクイメージの中から直接起動しないでください。
2. 一度開きます。macOS が検証できないと表示したら「完了」をクリックします（「ゴミ箱に入れる」は選ばないでください）。
3. 「システム設定 → プライバシーとセキュリティ」を開き、「セキュリティ」までスクロールして、「“tuantuan”はブロックされました」の横の「このまま開く」をクリックし、パスワードを入力してから「開く」をクリックします。macOS 14 以前では、Control キーを押しながらアプリをクリック →「開く」→「開く」でも構いません。
4. 「壊れているため開けません」と表示される、またはそれでも開けない場合は、ターミナルで次を実行してから再度開きます。

   ```bash
   xattr -dr com.apple.quarantine /Applications/tuantuan.app
   ```

ウィンドウにサービスを起動できないと表示された場合、ログは `~/Library/Application Support/团团/logs/server.log` にあります。

## ソースコードから起動

CI と同じ [Bun](https://bun.sh) **1.4.2** が必要です。

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun run dev
```

**http://localhost:5173** を開きます。初回ガイドに沿ってハーネスを選択またはインストールし、必要に応じてログインして、最初のエージェントを作成します。作業フォルダーに対応するプロジェクトを作成すると、1 人または複数のエージェントとの会話を始められます。

初期表示は簡体字中国語です。**设置 → 个人资料 → 界面语言**（設定 → プロフィール → 表示言語）で **日本語** を選択してください。

ハーネスにログインせずに模擬応答を試すには、次のコマンドで起動し、Mock ハーネスを選択します。

```bash
TUANTUAN_MOCK_HARNESS=1 bun run dev
```

ビルド済みのフロントエンドをローカル API サーバーから配信する場合：

```bash
bun run build && bun start
```

**http://localhost:8787** を開きます。サーバーは既定で `127.0.0.1` を使用し、ローカルでの 1 ユーザー利用を想定しています。

### デスクトップアプリをビルド

`bun install` の実行後、現在の OS とアーキテクチャ向けのインストーラーを作成します。

```bash
bun run desktop:install
bun run desktop:build
```

出力先は `desktop/release/` です。プラットフォームごとの手順と署名については[インストールと実行（簡体字中国語）](docs/install.md)をご覧ください。

## ドキュメント

詳細なドキュメントは現在、**簡体字中国語**で提供しています。

- [インストールと実行](docs/install.md) · [ハーネスと ACP Registry](docs/harness.md) · [会話と引き継ぎ](docs/conversations.md) · [Skills とプラグイン](docs/skills.md)
- [プロバイダー・BYOK・使用量](docs/providers.md) · [設定と mock モード](docs/configuration.md) · [UI](docs/ui.md) · [開発とテスト](docs/development.md)
- [FAQ と既知の制限](docs/faq.md) · [製品ルール](docs/product.md) · [アーキテクチャ](docs/architecture.md) · [ACP 実装計画](docs/plan-harness-acp.md)

[ドキュメント一覧](docs/README.md)。

## コントリビュート

Issue やプルリクエストを歓迎します。[貢献ガイド（簡体字中国語）](CONTRIBUTING.md)と[行動規範（英語）](CODE_OF_CONDUCT.md)をご確認ください。脆弱性の報告は[セキュリティポリシー（簡体字中国語）](SECURITY.md)に従ってください。

## 商標とサードパーティーのライセンス

[@lobehub/icons](https://github.com/lobehub/lobe-icons) のロゴは、対応するモデルプロバイダーを識別するために使用しています。商標は各権利者に帰属し、Tuantuan と各社の提携や各社からの推奨を示すものではありません。[サードパーティーに関する通知（簡体字中国語）](THIRD_PARTY_NOTICES.md)と[モデルデータの出典・ライセンス（英語）](server/data/NOTICE.md)をご覧ください。

## ライセンス

[MIT](LICENSE)
