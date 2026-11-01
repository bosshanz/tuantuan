# 團團 Tuantuan

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md)

<a href="https://bosshanz.github.io/tuantuan/assets/six-windows.mp4"><img src="docs/assets/six-windows-poster.jpg" alt="觀看團團宣傳影片（35 秒）" width="100%"></a>

**讓多個 Agent 在本機協作的工作台。**

將 Claude Code、Codex、DeepSeek、OpenCode、Pi、Grok Build、MiniMax Code 及其他程式開發 Agent，放進依專案整理的對話。團團透過 [Agent Client Protocol（ACP）](https://agentclientprotocol.com)連接這些程式開發執行環境（Harness）。

可使用 macOS、Windows、Linux 的 Electron 桌面版，或瀏覽器搭配本機服務。模型由你自己的 Harness 帳號或 API 服務商提供，團團不內含模型服務。

![主 Agent 將任務交接給 Alice](docs/screenshots/conversation-handoff.png)

*截圖使用簡體中文介面，也可切換為繁體中文、英語或日語。*

## 主要功能

- **找回訊息與檔案**：搜尋目前或全部對話，定位原訊息並返回閱讀位置。對話右側可調寬的檔案工作台統一瀏覽專案目錄、Git 變更、Agent 改動與聊天附件，支援圖片、Markdown、程式碼與單檔靜態 HTML 預覽、下載和查看來源；Agent 正文裡的本機檔案連結直接在工作台開啟，工作區外路徑由桌面端交系統檔案管理器；「需要我處理」集中顯示待授權、提問與失敗回覆。
- **核對協作結果**：查看 Agent 回報的編輯及來源，包含失敗、取消或中斷回覆中已完成的編輯；另可唯讀查看對話目錄內目前的 Git 工作區，不將既有或其他來源的改動歸因給 Agent。
- **引導或撤回排隊訊息**：排隊訊息提供「立即傳送」與「編輯訊息」——前者原地提升為引導，中斷同車道正在執行的任務鏈後優先執行；後者把正文、附件與引用拉回輸入框修改，已傳送的原始訊息保留在記錄中。被中斷的回覆保留已產生的內容與已完成的編輯。
- **跟進分工過程**：成員 Agent 的回覆聚合為一張精簡的協作詳情卡片，展開可逐條查看成員回覆、狀態與交接說明，主 Agent 彙整始終置頂。
- **選擇 Harness**：沿用本機既有安裝，或從 ACP Registry 安裝 Agent；也可依需要安裝團團補充的官方 DeepSeek CLI 預先發行版，詳見[安裝與驗證說明（簡體中文）](docs/harness.md)。依 Harness 提供的登入方式完成設定。
- **檔案與圖片附件**：選擇、拖放或貼上附件，切換對話和正常重新啟動會保留草稿。文字檔案直接提供內容，圖片與二進位檔案讀取取決於模型和 Harness。[附件範圍與限制](docs/conversations.md#文件与图片附件)。
- **多 Agent 協作**：一段對話可有一名或多名 Agent。用 `@` 指定成員，或由主 Agent 分工、跟進並彙整結果。所有成員共用專案工作目錄。
- **結構化脈絡交接**：交接包含任務說明、目標、重要決策及待辦事項；長訊息與結果可分頁讀取。每名 Agent 保留自己的 Harness 工作階段，交接不會複製來源 Agent 的私有工作階段歷史。
- **保留原生開發能力**：Claude Code、OpenCode、Pi、Codex 沿用原生提示詞與脈絡管理。團團顯示各 Harness 實際提供的模型、權限、推理及斜線指令選項，具體能力依 Harness 而異。
- **看見完整過程**：串流回覆、Harness 提供的思考、工具呼叫、diff、終端輸出、計畫及權限請求；支援 Markdown、Mermaid 圖表，也可個別停止任務。
- **自訂 API**：為 Claude Code、OpenCode、Pi、Codex 設定相容的服務商。直接 BYOK 模式支援 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，可對話與交接，沒有檔案或終端工具；相容性取決於 Harness 與服務商協定。
- **沿用本機設定**：探索本機 Skills 與 Claude 外掛程式，依 Agent 選用；以唯讀方式匯入 CC Switch 服務商，查看 Harness 實際回報的 Token 用量與額度。團團不會改寫 `~/.claude` / `~/.codex`。
- **四種介面語言**：簡體中文、繁體中文、英語、日語。切換介面語言不會改變對話內容與模型回覆語言。

完整清單見[功能一覽（簡體中文）](docs/features.md)。

## 下載 v0.3.1

前往 [GitHub Releases](https://github.com/bosshanz/tuantuan/releases/tag/v0.3.1) 下載桌面版：

- **macOS**：Apple 晶片（arm64）或 Intel（x64），提供 `.dmg` 和 `.zip`。
- **Windows**：x64 `.exe` 安裝程式。
- **Linux**：x64 `.AppImage`。

桌面版已包含執行環境，不必安裝 Bun。v0.3.1 的 macOS 套件使用 ad-hoc 簽署，未經 Apple 公證；Windows 安裝程式未經程式碼簽署。詳見[安裝與簽署說明（簡體中文）](docs/install.md)。

### 用 Homebrew 安裝（macOS）

```bash
brew install --cask bosshanz/tap/tuantuan
```

[這個 tap](https://github.com/bosshanz/homebrew-tap) 安裝後會自動清除隔離標記，開啟時不會再出現下方的 Gatekeeper 攔截。升級請用 `brew upgrade --cask tuantuan`。

### macOS 首次開啟（未經公證）

團團目前沒有 Apple Developer ID，macOS 會攔截第一次開啟，這是正常的：

1. 開啟 `.dmg`，把 **tuantuan.app** 拖進「應用程式」（使用 `.zip` 時在 Finder 中按兩下解壓縮，再把 `tuantuan.app` 移到「應用程式」）。不要直接在磁碟映像檔裡執行。
2. 開啟一次。macOS 提示無法驗證時按「完成」（不要按「丟到垃圾桶」）。
3. 開啟「系統設定 → 隱私權與安全性」，捲動到「安全性」，在「已阻擋“tuantuan”」旁按「強制打開」，輸入密碼後再按「打開」。macOS 14 及更早版本也可以按住 Control 點按 App →「打開」→「打開」。
4. 如果提示「已損毀，無法打開」或仍然打不開，在「終端機」執行下面的指令後再開啟：

   ```bash
   xattr -dr com.apple.quarantine /Applications/tuantuan.app
   ```

如果視窗提示服務無法啟動，記錄檔在 `~/Library/Application Support/团团/logs/server.log`。

## 快速開始（從原始碼建置）

需要 [Bun](https://bun.sh) **1.4.2**，與 CI 使用相同版本。

```bash
git clone https://github.com/bosshanz/tuantuan.git
cd tuantuan
bun install
bun run dev
```

開啟 **http://localhost:5173**。首次使用的引導會協助你選擇或安裝 Harness、依需要登入，並建立第一名 Agent。為工作目錄建立專案後，即可開始單人或多 Agent 對話。

預設介面為簡體中文。請前往 **设置 → 个人资料 → 界面语言**（設定 → 個人資料 → 介面語言），選擇**繁體中文**。

不必登入 Harness 也能體驗模擬回覆，使用以下指令啟動後選擇 Mock Harness：

```bash
TUANTUAN_MOCK_HARNESS=1 bun run dev
```

由本機 API 服務提供建置後的前端：

```bash
bun run build && bun start
```

開啟 **http://localhost:8787**。服務預設監聽 `127.0.0.1`，供本機單一使用者使用。

### 建置桌面版

完成 `bun install` 後，為目前的作業系統與架構建置安裝包：

```bash
bun run desktop:install
bun run desktop:build
```

產物位於 `desktop/release/`。平台差異與簽署步驟見[安裝與執行（簡體中文）](docs/install.md)。

## 文件

詳細文件目前使用**簡體中文**。

- [安裝與執行](docs/install.md) · [Harness 與 ACP Registry](docs/harness.md) · [對話與交接](docs/conversations.md) · [Skills 與外掛程式](docs/skills.md)
- [服務商、BYOK 與用量](docs/providers.md) · [設定與 mock](docs/configuration.md) · [介面](docs/ui.md) · [開發與測試](docs/development.md)
- [常見問題與已知限制](docs/faq.md) · [產品規則](docs/product.md) · [架構](docs/architecture.md) · [ACP 計畫](docs/plan-harness-acp.md)

[完整文件索引](docs/README.md)。

## 參與貢獻

歡迎 Issue 與 PR！請先閱讀[貢獻指南（簡體中文）](CONTRIBUTING.md)與[行為準則（英語）](CODE_OF_CONDUCT.md)。回報漏洞請遵循[安全政策（簡體中文）](SECURITY.md)。

## 商標與第三方授權

來自 [@lobehub/icons](https://github.com/lobehub/lobe-icons) 的廠商 Logo 僅用於識別對應的模型服務商。商標歸各自擁有者所有，本專案與這些公司沒有關聯，也未獲其背書。第三方授權見[第三方聲明（簡體中文）](THIRD_PARTY_NOTICES.md)，模型目錄與調整依據見[模型資料說明（英語）](server/data/NOTICE.md)。

## 授權

[MIT](LICENSE)
