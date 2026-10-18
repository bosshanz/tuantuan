import type { MessageCatalog } from "./types";

export const harnessMessages = {
  团团补充目录: { "zh-TW": "團團補充目錄", en: "Tuantuan additions", ja: "Tuantuan 追加カタログ" },
  及团团补充目录: { "zh-TW": "及團團補充目錄", en: "and Tuantuan additions", ja: "および Tuantuan 追加カタログ" },
  "团团补充的官方 npm 预发布包 @deepseek-ai/dsh@0.2.1-rc.2（需要 Node ≥ 22.19）": {
    "zh-TW": "團團補充的官方 npm 預發佈套件 @deepseek-ai/dsh@0.2.1-rc.2（需要 Node ≥ 22.19）",
    en: "Official npm prerelease @deepseek-ai/dsh@0.2.1-rc.2, added by Tuantuan (requires Node ≥ 22.19)",
    ja: "Tuantuan が追加した公式 npm プレリリース @deepseek-ai/dsh@0.2.1-rc.2（Node ≥ 22.19 が必要）",
  },
  "设置 DEEPSEEK_API_KEY；也可沿用 ~/.dsh/.credentials.yaml（DSH_HOME 可改目录）。本机已保存的凭据优先于环境变量；握手不验证 Key 是否有效。":
    {
      "zh-TW":
        "設定 DEEPSEEK_API_KEY；也可沿用 ~/.dsh/.credentials.yaml（DSH_HOME 可改目錄）。本機已儲存的憑證優先於環境變數；交握不驗證 Key 是否有效。",
      en: "Set DEEPSEEK_API_KEY or keep using ~/.dsh/.credentials.yaml (DSH_HOME changes the directory). Saved native credentials take priority over environment variables. The handshake does not validate the key.",
      ja: "DEEPSEEK_API_KEY を設定するか、既存の ~/.dsh/.credentials.yaml を使用します（DSH_HOME で場所を変更可能）。保存済みの認証情報は環境変数より優先されます。ハンドシェイクでは Key の有効性を確認しません。",
    },
  "DeepSeek 官方 Harness，原生支持 ACP。团团补充官方 npm 包，尚未收录于上游 ACP Registry。": {
    "zh-TW": "DeepSeek 官方 Harness，原生支援 ACP。團團補充官方 npm 套件，尚未收錄於上游 ACP Registry。",
    en: "DeepSeek's official Harness with native ACP. Tuantuan adds the official npm package; it is not listed in the upstream ACP Registry.",
    ja: "ACP にネイティブ対応する DeepSeek 公式 Harness。公式 npm パッケージを Tuantuan が追加しています。上流の ACP Registry には未登録です。",
  },
  "DeepSeek 官方预发布版，团团补充安装入口；使用原生 ACP，不是社区桥接。": {
    "zh-TW": "DeepSeek 官方預發佈版，由團團補充安裝入口；使用原生 ACP，並非社群橋接。",
    en: "Official DeepSeek prerelease with a Tuantuan-added installer. Uses native ACP, without a community bridge.",
    ja: "DeepSeek 公式プレリリースのインストール入口を Tuantuan が追加。コミュニティ製ブリッジではなく、ネイティブ ACP を使用します。",
  },
  "删除 Agent「{name}」？\n它会退出所有会话；已有的聊天记录会保留。此操作不可撤销。": {
    "zh-TW": "刪除 Agent「{name}」？\n它會退出所有對話；現有的聊天記錄會保留。此操作無法復原。",
    en: "Delete Agent “{name}”?\nIt will leave all conversations. Existing messages will be kept. This cannot be undone.",
    ja: "Agent「{name}」を削除しますか？\nすべての会話から退出します。これまでのメッセージは保持されます。この操作は取り消せません。",
  },
  返回: {
    "zh-TW": "返回",
    en: "Back",
    ja: "戻る",
  },
  "新建 Agent": {
    "zh-TW": "新增 Agent",
    en: "New Agent",
    ja: "新しい Agent",
  },
  "自定义 API": {
    "zh-TW": "自訂 API",
    en: "Custom API",
    ja: "カスタム API",
  },
  "未绑定 Harness": {
    "zh-TW": "尚未綁定 Harness",
    en: "No Harness assigned",
    ja: "Harness 未設定",
  },
  对话: {
    "zh-TW": "對話",
    en: "Chat",
    ja: "チャット",
  },
  基本信息: {
    "zh-TW": "基本資訊",
    en: "Basic information",
    ja: "基本情報",
  },
  名称: {
    "zh-TW": "名稱",
    en: "Name",
    ja: "名前",
  },
  "例如：产品经理Alice": {
    "zh-TW": "例如：產品經理 Alice",
    en: "e.g. Alice, product manager",
    ja: "例：プロダクトマネージャー Alice",
  },
  "由哪个编码 Agent 来驱动它；也可选自定义 API（仅对话，无文件/终端）。": {
    "zh-TW": "選擇驅動它的編碼 Agent；也可使用自訂 API（僅對話，無檔案或終端功能）。",
    en: "Choose the coding Agent that powers it, or use a custom API for chat without file or terminal access.",
    ja: "実行に使うコーディング Agent を選択します。カスタム API も使えます（チャットのみ。ファイルやターミナルは使用できません）。",
  },
  检测与登录: {
    "zh-TW": "偵測與登入",
    en: "Check and sign in",
    ja: "接続確認とログイン",
  },
  未绑定: {
    "zh-TW": "尚未綁定",
    en: "Unassigned",
    ja: "未設定",
  },
  "自定义 API（BYOK）": {
    "zh-TW": "自訂 API（BYOK）",
    en: "Custom API (BYOK)",
    ja: "カスタム API（BYOK）",
  },
  工具授权: {
    "zh-TW": "工具授權",
    en: "Tool permissions",
    ja: "ツールの権限",
  },
  每次询问: {
    "zh-TW": "每次詢問",
    en: "Ask every time",
    ja: "毎回確認",
  },
  自动允许: {
    "zh-TW": "自動允許",
    en: "Allow automatically",
    ja: "自動的に許可",
  },
  身份文档: {
    "zh-TW": "身分文件",
    en: "Identity instructions",
    ja: "役割の指示",
  },
  "团团独立维护，不写进项目目录。": {
    "zh-TW": "由團團獨立維護，不會寫入專案目錄。",
    en: "Managed separately by Tuantuan; never written to the project directory.",
    ja: "Tuantuan が個別に管理し、プロジェクトのフォルダーには書き込みません。",
  },
  "作为系统提示发送。": {
    "zh-TW": "作為系統提示傳送。",
    en: "Sent as a system prompt.",
    ja: "システムプロンプトとして送信します。",
  },
  "# 角色\n你是团队里的前端工程师……\n\n# 约定\n- 改动前先说明计划": {
    "zh-TW": "# 角色\n你是團隊裡的前端工程師……\n\n# 約定\n- 修改前先說明計畫",
    en: "# Role\nYou are the team's frontend engineer…\n\n# Guidelines\n- Explain your plan before making changes",
    ja: "# 役割\nあなたはチームのフロントエンドエンジニアです……\n\n# ルール\n- 変更する前に計画を説明する",
  },
  "附上我的「关于我」": {
    "zh-TW": "附上我的「關於我」",
    en: "Include my “About me”",
    ja: "「自己紹介」を添付",
  },
  个人资料: {
    "zh-TW": "個人資料",
    en: "Profile",
    ja: "プロフィール",
  },
  " · 新会话生效": {
    "zh-TW": " · 於新對話生效",
    en: " · Applies to new conversations",
    ja: " · 新しい会話から適用",
  },
  环境变量: {
    "zh-TW": "環境變數",
    en: "Environment variables",
    ja: "環境変数",
  },
  "只给这个 Agent 的 Harness 进程，例如 API Key。每行 KEY=VALUE。": {
    "zh-TW": "僅提供給這個 Agent 的 Harness 程序，例如 API Key。每行一組 KEY=VALUE。",
    en: "Passed only to this Agent's Harness process, e.g. API keys. One KEY=VALUE per line.",
    ja: "この Agent の Harness プロセスにのみ渡します。API Key などを KEY=VALUE の形式で 1 行ずつ入力してください。",
  },
  危险操作: {
    "zh-TW": "危險操作",
    en: "Danger zone",
    ja: "危険な操作",
  },
  "删除后它会退出所有会话，聊天记录保留。": {
    "zh-TW": "刪除後它會退出所有對話，聊天記錄將保留。",
    en: "Deleting this Agent removes it from all conversations. Messages are kept.",
    ja: "削除するとすべての会話から退出します。メッセージは保持されます。",
  },
  "删除 Agent": {
    "zh-TW": "刪除 Agent",
    en: "Delete Agent",
    ja: "Agent を削除",
  },
  有未保存的修改: {
    "zh-TW": "有尚未儲存的變更",
    en: "Unsaved changes",
    ja: "未保存の変更があります",
  },
  已保存: {
    "zh-TW": "已儲存",
    en: "Saved",
    ja: "保存済み",
  },
  所有修改已保存: {
    "zh-TW": "所有變更已儲存",
    en: "All changes saved",
    ja: "すべての変更を保存しました",
  },
  填写名称后即可创建: {
    "zh-TW": "填寫名稱後即可建立",
    en: "Enter a name to create",
    ja: "名前を入力すると作成できます",
  },
  放弃修改: {
    "zh-TW": "放棄變更",
    en: "Discard changes",
    ja: "変更を破棄",
  },
  "保存中…": {
    "zh-TW": "儲存中…",
    en: "Saving…",
    ja: "保存中…",
  },
  保存修改: {
    "zh-TW": "儲存變更",
    en: "Save changes",
    ja: "変更を保存",
  },
  "创建 Agent": {
    "zh-TW": "建立 Agent",
    en: "Create Agent",
    ja: "Agent を作成",
  },
  "移除 MCP 服务「{name}」？\n所有 Agent 都将不再拿到它。": {
    "zh-TW": "移除 MCP 服務「{name}」？\n所有 Agent 都將無法再使用它。",
    en: "Remove MCP server “{name}”?\nIt will no longer be available to any Agent.",
    ja: "MCP サーバー「{name}」を削除しますか？\nすべての Agent がこのサーバーを利用できなくなります。",
  },
  "移除此 MCP 服务": {
    "zh-TW": "移除此 MCP 服務",
    en: "Remove this MCP server",
    ja: "この MCP サーバーを削除",
  },
  "移除 {name}": {
    "zh-TW": "移除 {name}",
    en: "Remove {name}",
    ja: "{name} を削除",
  },
  "MCP 服务": {
    "zh-TW": "MCP 服務",
    en: "MCP servers",
    ja: "MCP サーバー",
  },
  "新建 Harness 会话时传给它（session/new 的 mcpServers）。": {
    "zh-TW": "建立 Harness 對話時傳入（session/new 的 mcpServers）。",
    en: "Passed to the Harness when creating a session (mcpServers in session/new).",
    ja: "Harness のセッション作成時に渡します（session/new の mcpServers）。",
  },
  添加: {
    "zh-TW": "新增",
    en: "Add",
    ja: "追加",
  },
  可选: {
    "zh-TW": "可選",
    en: "Optional",
    ja: "任意",
  },
  "Streamable HTTP 地址": {
    "zh-TW": "Streamable HTTP 位址",
    en: "Streamable HTTP URL",
    ja: "Streamable HTTP の URL",
  },
  "搜索 MCP 服务": {
    "zh-TW": "搜尋 MCP 服務",
    en: "Search MCP servers",
    ja: "MCP サーバーを検索",
  },
  "还没有 MCP 服务": {
    "zh-TW": "尚無 MCP 服務",
    en: "No MCP servers yet",
    ja: "MCP サーバーがありません",
  },
  失败: {
    "zh-TW": "失敗",
    en: "Failed",
    ja: "失敗",
  },
  接口格式: {
    "zh-TW": "介面格式",
    en: "API format",
    ja: "API 形式",
  },
  " · 已保存 {hint}": {
    "zh-TW": " · 已儲存 {hint}",
    en: " · Saved {hint}",
    ja: " · 保存済み {hint}",
  },
  "留空则保持原 Key": {
    "zh-TW": "留空則保留原 Key",
    en: "Leave blank to keep the existing key",
    ja: "空欄の場合は現在のキーを維持",
  },
  模型: {
    "zh-TW": "模型",
    en: "Model",
    ja: "モデル",
  },
  "测试中…": {
    "zh-TW": "測試中…",
    en: "Testing…",
    ja: "テスト中…",
  },
  测试连接: {
    "zh-TW": "測試連線",
    en: "Test connection",
    ja: "接続をテスト",
  },
  "仅对话；多 Agent 时可交接。无文件与终端。": {
    "zh-TW": "僅對話；多 Agent 時可交接。無檔案或終端功能。",
    en: "Chat only, with handoffs between Agents. No file or terminal access.",
    ja: "チャットと Agent 間の引き継ぎに対応します。ファイルやターミナルは使用できません。",
  },
  " · 原生可用": {
    "zh-TW": " · 原生可用",
    en: " · Available natively",
    ja: " · 標準で利用可能",
  },
  命令: {
    "zh-TW": "命令",
    en: "Commands",
    ja: "コマンド",
  },
  子代理: {
    "zh-TW": "子代理",
    en: "Subagents",
    ja: "サブエージェント",
  },
  "{name} 全部可用": {
    "zh-TW": "{name} 全部可用",
    en: "Fully supported by {name}",
    ja: "{name} ですべて利用可能",
  },
  可用: {
    "zh-TW": "可用",
    en: "Available",
    ja: "利用可能",
  },
  "{name} 不支持：{missing}": {
    "zh-TW": "{name} 不支援：{missing}",
    en: "{name} does not support: {missing}",
    ja: "{name} では未対応：{missing}",
  },
  不支持: {
    "zh-TW": "不支援",
    en: "Unsupported",
    ja: "未対応",
  },
  "部分 · 无{missing}": {
    "zh-TW": "部分支援 · 缺少 {missing}",
    en: "Partial · Missing {missing}",
    ja: "一部対応 · {missing} なし",
  },
  "选择 Skill 文件夹": {
    "zh-TW": "選擇 Skill 資料夾",
    en: "Choose a Skill folder",
    ja: "Skill のフォルダーを選択",
  },
  "Skills 与插件": {
    "zh-TW": "Skills 與外掛程式",
    en: "Skills and plugins",
    ja: "Skills とプラグイン",
  },
  不含项目: {
    "zh-TW": "不含專案",
    en: "No project",
    ja: "プロジェクトなし",
  },
  "只看全局和这个 Agent 的 Skill": {
    "zh-TW": "僅查看全域及這個 Agent 的 Skill",
    en: "Show only global Skills and this Agent's Skills",
    ja: "グローバルとこの Agent の Skill のみ表示",
  },
  "搜索 Skills 与插件": {
    "zh-TW": "搜尋 Skills 與外掛程式",
    en: "Search Skills and plugins",
    ja: "Skills とプラグインを検索",
  },
  搜索: {
    "zh-TW": "搜尋",
    en: "Search",
    ja: "検索",
  },
  插件: {
    "zh-TW": "外掛程式",
    en: "Plugins",
    ja: "プラグイン",
  },
  插件列表: {
    "zh-TW": "外掛程式清單",
    en: "Plugin list",
    ja: "プラグイン一覧",
  },
  "Skill 列表": {
    "zh-TW": "Skill 清單",
    en: "Skill list",
    ja: "Skill 一覧",
  },
  "正在查找…": {
    "zh-TW": "正在尋找…",
    en: "Searching…",
    ja: "検索中…",
  },
  没有匹配的结果: {
    "zh-TW": "沒有符合的結果",
    en: "No matching results",
    ja: "一致する結果がありません",
  },
  "没有找到 Skill": {
    "zh-TW": "找不到 Skill",
    en: "No Skills found",
    ja: "Skill が見つかりません",
  },
  原生可用: {
    "zh-TW": "原生可用",
    en: "Available natively",
    ja: "標準で利用可能",
  },
  "由 {name} 从已有目录自动发现，停用请修改对应原生配置或文件": {
    "zh-TW": "由 {name} 從現有目錄自動探索；若要停用，請修改對應的原生設定或檔案",
    en: "Automatically discovered by {name} in existing directories. To disable it, change the native configuration or files.",
    ja: "{name} が既存のフォルダーから自動検出しました。無効にするには、対応する設定やファイルを変更してください。",
  },
  "原生可用项来自 Harness 已有的全局或项目目录（包括已有链接），不会随此处取消勾选而删除。 可选项仅为这个 Agent 提供按需读取索引；团团不再向共享项目添加技能链接。":
    {
      "zh-TW":
        "原生可用項目來自 Harness 現有的全域或專案目錄（包括現有連結），不會因在此取消勾選而刪除。可選項目僅為這個 Agent 提供按需讀取索引；團團不再向共用專案新增技能連結。",
      en: "Native items come from the Harness's existing global or project directories, including existing links. Unchecking here does not delete them. Optional items provide an index for this Agent to read on demand. Tuantuan no longer adds Skill links to shared projects.",
      ja: "標準で利用できる項目は、Harness の既存のグローバルまたはプロジェクトフォルダー（既存のリンクを含む）から取得します。ここで選択を解除しても削除されません。任意の項目は、この Agent が必要に応じて読むための索引を提供します。Tuantuan は共有プロジェクトに Skill のリンクを追加しません。",
    },
  "保存后可以从链接或文件夹添加 Skill": {
    "zh-TW": "儲存後即可從連結或資料夾新增 Skill",
    en: "After saving, you can add Skills from a link or folder",
    ja: "保存すると、リンクやフォルダーから Skill を追加できます",
  },
  "Skill 链接": {
    "zh-TW": "Skill 連結",
    en: "Skill link",
    ja: "Skill のリンク",
  },
  "GitHub / git / SKILL.md 链接": {
    "zh-TW": "GitHub / git / SKILL.md 連結",
    en: "GitHub / git / SKILL.md link",
    ja: "GitHub / git / SKILL.md のリンク",
  },
  查找: {
    "zh-TW": "尋找",
    en: "Find",
    ja: "検索",
  },
  文件夹: {
    "zh-TW": "資料夾",
    en: "Folder",
    ja: "フォルダー",
  },
  "添加 {name}": {
    "zh-TW": "新增 {name}",
    en: "Add {name}",
    ja: "{name} を追加",
  },
  取消: {
    "zh-TW": "取消",
    en: "Cancel",
    ja: "キャンセル",
  },
  "添加 {count}": {
    "zh-TW": "新增 {count} 項",
    en: "Add {count}",
    ja: "{count} 件を追加",
  },
  默认设置: {
    "zh-TW": "預設設定",
    en: "Default settings",
    ja: "既定の設定",
  },
  "读取不到选项：{error}": {
    "zh-TW": "無法讀取選項：{error}",
    en: "Could not load options: {error}",
    ja: "選択肢を読み込めません：{error}",
  },
  重试: {
    "zh-TW": "重試",
    en: "Retry",
    ja: "再試行",
  },
  "正在读取 Harness 选项…": {
    "zh-TW": "正在讀取 Harness 選項…",
    en: "Loading Harness options…",
    ja: "Harness の選択肢を読み込み中…",
  },
  "这个 Harness 没有可调的选项": {
    "zh-TW": "此 Harness 沒有可調整的選項",
    en: "This Harness has no configurable options",
    ja: "この Harness には変更できる設定がありません",
  },
  "跟随 Harness": {
    "zh-TW": "跟隨 Harness",
    en: "Use Harness default",
    ja: "Harness の既定値を使用",
  },
  "当前：{label}": {
    "zh-TW": "目前：{label}",
    en: "Current: {label}",
    ja: "現在：{label}",
  },
  "默认{label}": {
    "zh-TW": "預設{label}",
    en: "Default {label}",
    ja: "既定の{label}",
  },
  "自定义模型 ID": {
    "zh-TW": "自訂模型 ID",
    en: "Custom model ID",
    ja: "カスタムモデル ID",
  },
  服务商: {
    "zh-TW": "服務商",
    en: "Providers",
    ja: "プロバイダー",
  },
  本机配置: {
    "zh-TW": "本機設定",
    en: "Local configuration",
    ja: "ローカル設定",
  },
  "只用于这个 Agent": {
    "zh-TW": "僅用於這個 Agent",
    en: "Used only by this Agent",
    ja: "この Agent にのみ適用",
  },
  "直接填写下面的接口。": {
    "zh-TW": "直接填寫下方介面。",
    en: "Enter the API details below.",
    ja: "下に API の情報を入力してください。",
  },
  "沿用你自己的登录和环境变量。": {
    "zh-TW": "沿用你自己的登入資訊與環境變數。",
    en: "Use your own sign-in and environment variables.",
    ja: "既存のログイン情報と環境変数を使用します。",
  },
  管理服务商: {
    "zh-TW": "管理服務商",
    en: "Manage providers",
    ja: "プロバイダーを管理",
  },
  新手引导: {
    "zh-TW": "新手引導",
    en: "Getting started",
    ja: "はじめに",
  },
  "Harness 管理": {
    "zh-TW": "Harness 管理",
    en: "Harness management",
    ja: "Harness の管理",
  },
  "接入编码 Agent（Harness），再把它们分给团团里的 Agent": {
    "zh-TW": "連接編碼 Agent（Harness），再指派給團團裡的 Agent",
    en: "Connect coding Agents (Harnesses) and assign them to Agents in Tuantuan",
    ja: "コーディング Agent（Harness）を接続し、Tuantuan の Agent に割り当てます",
  },
  跳过: {
    "zh-TW": "略過",
    en: "Skip",
    ja: "スキップ",
  },
  重新检测: {
    "zh-TW": "重新偵測",
    en: "Check again",
    ja: "再確認",
  },
  "1 · 安装与登录": {
    "zh-TW": "1 · 安裝與登入",
    en: "1 · Install and sign in",
    ja: "1 · インストールとログイン",
  },
  "你本机装的版本优先；没有时一键装到团团自己的目录，不需要管理员权限。登录优先用 Harness 自带流程，不支持时复制命令到终端。":
    {
      "zh-TW":
        "優先使用你本機安裝的版本；若未安裝，可一鍵安裝到團團自己的目錄，無須管理員權限。優先使用 Harness 自帶的登入流程；不支援時，將命令複製到終端執行。",
      en: "Use your locally installed version when available, or install into Tuantuan's own directory with one click and no administrator privileges. Use the Harness's sign-in flow, or copy the command to a terminal if it is unsupported.",
      ja: "ローカルにインストール済みのバージョンを優先します。未インストールの場合は、管理者権限なしで Tuantuan の専用フォルダーにインストールできます。Harness のログイン手順を使用し、未対応の場合はコマンドをターミナルで実行してください。",
    },
  团团内置的适配器: {
    "zh-TW": "團團內建的轉接器",
    en: "Adapter bundled with Tuantuan",
    ja: "Tuantuan に同梱されたアダプター",
  },
  "用你本机的版本；内置 {version} 作后备": {
    "zh-TW": "使用你本機的版本；內建 {version} 作為備用",
    en: "Using your local version; bundled {version} is a fallback",
    ja: "ローカルのバージョンを使用し、同梱の {version} を予備として利用します",
  },
  "{name} 文档": {
    "zh-TW": "{name} 文件",
    en: "{name} documentation",
    ja: "{name} のドキュメント",
  },
  "登录：{auth}": {
    "zh-TW": "登入：{auth}",
    en: "Sign-in: {auth}",
    ja: "ログイン：{auth}",
  },
  登录: {
    "zh-TW": "登入",
    en: "Sign in",
    ja: "ログイン",
  },
  握手测试: {
    "zh-TW": "握手測試",
    en: "Test handshake",
    ja: "ハンドシェイクをテスト",
  },
  "等待登录完成…（可能会打开浏览器）": {
    "zh-TW": "等待登入完成…（可能會開啟瀏覽器）",
    en: "Waiting for sign-in… (a browser may open)",
    ja: "ログインの完了を待っています…（ブラウザーが開く場合があります）",
  },
  已连接: {
    "zh-TW": "已連線",
    en: "Connected",
    ja: "接続済み",
  },
  "需要 API Key": {
    "zh-TW": "需要 API Key",
    en: "API Key required",
    ja: "API Key が必要です",
  },
  已登录: {
    "zh-TW": "已登入",
    en: "Signed in",
    ja: "ログイン済み",
  },
  未登录: {
    "zh-TW": "尚未登入",
    en: "Not signed in",
    ja: "未ログイン",
  },
  登录状态未知: {
    "zh-TW": "登入狀態未知",
    en: "Sign-in status unknown",
    ja: "ログイン状態は不明です",
  },
  "登录失败：{error}": {
    "zh-TW": "登入失敗：{error}",
    en: "Sign-in failed: {error}",
    ja: "ログインに失敗しました：{error}",
  },
  "用「{name}」登录": {
    "zh-TW": "使用「{name}」登入",
    en: "Sign in with “{name}”",
    ja: "「{name}」でログイン",
  },
  "2 · 绑定到 Agent": {
    "zh-TW": "2 · 綁定到 Agent",
    en: "2 · Assign to Agents",
    ja: "2 · Agent に割り当て",
  },
  "每个 Agent 由一个 Harness 驱动。": {
    "zh-TW": "每個 Agent 由一個 Harness 驅動。",
    en: "Each Agent is powered by one Harness.",
    ja: "各 Agent は 1 つの Harness で動作します。",
  },
  "新建 {name} Agent": {
    "zh-TW": "新增 {name} Agent",
    en: "New {name} Agent",
    ja: "{name} の Agent を作成",
  },
  "{name} 的 Harness": {
    "zh-TW": "{name} 的 Harness",
    en: "Harness for {name}",
    ja: "{name} の Harness",
  },
  "（未安装）": {
    "zh-TW": "（尚未安裝）",
    en: " (not installed)",
    ja: "（未インストール）",
  },
  完成: {
    "zh-TW": "完成",
    en: "Done",
    ja: "完了",
  },
  "更新到 {version}": {
    "zh-TW": "更新至 {version}",
    en: "Update to {version}",
    ja: "{version} に更新",
  },
  卸载团团安装的版本: {
    "zh-TW": "解除安裝團團安裝的版本",
    en: "Uninstall the version installed by Tuantuan",
    ja: "Tuantuan がインストールしたバージョンを削除",
  },
  "复制{label}命令": {
    "zh-TW": "複製{label}命令",
    en: "Copy {label} command",
    ja: "{label}コマンドをコピー",
  },
  自定义路径: {
    "zh-TW": "自訂路徑",
    en: "Custom path",
    ja: "カスタムパス",
  },
  "/opt/homebrew/bin/…（留空则按 PATH 查找）": {
    "zh-TW": "/opt/homebrew/bin/…（留空則從 PATH 尋找）",
    en: "/opt/homebrew/bin/… (leave blank to search PATH)",
    ja: "/opt/homebrew/bin/…（空欄の場合は PATH から検索）",
  },
  "{name} 路径": {
    "zh-TW": "{name} 路徑",
    en: "{name} path",
    ja: "{name} のパス",
  },
  保存: {
    "zh-TW": "儲存",
    en: "Save",
    ja: "保存",
  },
  内置: {
    "zh-TW": "內建",
    en: "Bundled",
    ja: "同梱",
  },
  本机: {
    "zh-TW": "本機",
    en: "Local",
    ja: "ローカル",
  },
  团团安装: {
    "zh-TW": "團團安裝",
    en: "Installed by Tuantuan",
    ja: "Tuantuan がインストール",
  },
  "安装（{label}）": {
    "zh-TW": "安裝（{label}）",
    en: "Install ({label})",
    ja: "インストール（{label}）",
  },
  "安装中…": {
    "zh-TW": "安裝中…",
    en: "Installing…",
    ja: "インストール中…",
  },
  "{name} 安装日志": {
    "zh-TW": "{name} 安裝記錄",
    en: "{name} installation log",
    ja: "{name} のインストールログ",
  },
  安装完成: {
    "zh-TW": "安裝完成",
    en: "Installation complete",
    ja: "インストールが完了しました",
  },
  "安装失败：{error}": {
    "zh-TW": "安裝失敗：{error}",
    en: "Installation failed: {error}",
    ja: "インストールに失敗しました：{error}",
  },
  已取消: {
    "zh-TW": "已取消",
    en: "Cancelled",
    ja: "キャンセル済み",
  },
  安装: {
    "zh-TW": "安裝",
    en: "Install",
    ja: "インストール",
  },
  手动安装: {
    "zh-TW": "手動安裝",
    en: "Manual install",
    ja: "手動インストール",
  },
  "{name} 图标": {
    "zh-TW": "{name} 圖示",
    en: "{name} icon",
    ja: "{name} のアイコン",
  },
  二进制: {
    "zh-TW": "二進位檔",
    en: "Binary",
    ja: "バイナリ",
  },
  "更多 Agent": {
    "zh-TW": "更多 Agent",
    en: "More Agents",
    ja: "その他の Agent",
  },
  来自: {
    "zh-TW": "來自",
    en: "From",
    ja: "提供元：",
  },
  "ACP 官方 Registry": {
    "zh-TW": "ACP 官方 Registry",
    en: "Official ACP Registry",
    ja: "ACP 公式 Registry",
  },
  "{count} 个": {
    "zh-TW": "{count} 個",
    en: "{count} items",
    ja: "{count} 件",
  },
  " · {time} 更新": {
    "zh-TW": " · 於 {time} 更新",
    en: " · Updated {time}",
    ja: " · {time} 更新",
  },
  " · {time} 的缓存": {
    "zh-TW": " · {time} 的快取",
    en: " · Cached {time}",
    ja: " · {time} のキャッシュ",
  },
  " · 离线快照": {
    "zh-TW": " · 離線快照",
    en: " · Offline snapshot",
    ja: " · オフラインのスナップショット",
  },
  "刷新 Registry": {
    "zh-TW": "重新整理 Registry",
    en: "Refresh Registry",
    ja: "Registry を更新",
  },
  刷新: {
    "zh-TW": "重新整理",
    en: "Refresh",
    ja: "更新",
  },
  "{error}，先用已有的列表": {
    "zh-TW": "{error}，暫時使用現有清單",
    en: "{error}. Using the existing list for now.",
    ja: "{error}。既存の一覧を使用します。",
  },
  "搜索名称、作者、描述": {
    "zh-TW": "搜尋名稱、作者、描述",
    en: "Search names, authors, descriptions",
    ja: "名前、作者、説明を検索",
  },
  "搜索 Agent": {
    "zh-TW": "搜尋 Agent",
    en: "Search Agents",
    ja: "Agent を検索",
  },
  "没有匹配的 Agent": {
    "zh-TW": "沒有符合的 Agent",
    en: "No matching Agents",
    ja: "一致する Agent がありません",
  },
  "握手失败：{error}": {
    "zh-TW": "握手失敗：{error}",
    en: "Handshake failed: {error}",
    ja: "ハンドシェイクに失敗しました：{error}",
  },
  实验性: {
    "zh-TW": "實驗性",
    en: "Experimental",
    ja: "実験的",
  },
  "{name} 主页": {
    "zh-TW": "{name} 首頁",
    en: "{name} website",
    ja: "{name} のウェブサイト",
  },
  支持本机: {
    "zh-TW": "支援本機",
    en: "Supported on this computer",
    ja: "このコンピューターに対応",
  },
  本机不支持: {
    "zh-TW": "本機不支援",
    en: "Unsupported on this computer",
    ja: "このコンピューターでは未対応",
  },
  "{count} 个平台": {
    "zh-TW": "{count} 個平台",
    en: "{count} platforms",
    ja: "{count} 個のプラットフォーム",
  },
  "已安装 {version}": {
    "zh-TW": "已安裝 {version}",
    en: "Installed {version}",
    ja: "インストール済み {version}",
  },
  握手: {
    "zh-TW": "握手",
    en: "Handshake",
    ja: "ハンドシェイク",
  },
  "卸载 {name}": {
    "zh-TW": "解除安裝 {name}",
    en: "Uninstall {name}",
    ja: "{name} をアンインストール",
  },
  卸载: {
    "zh-TW": "解除安裝",
    en: "Uninstall",
    ja: "アンインストール",
  },
  "装到团团自己的目录，不需要管理员权限": {
    "zh-TW": "安裝到團團自己的目錄，無須管理員權限",
    en: "Install into Tuantuan's own directory; no administrator privileges required",
    ja: "管理者権限なしで Tuantuan の専用フォルダーにインストール",
  },
  没有适合这台电脑的安装包: {
    "zh-TW": "沒有適用於這台電腦的安裝套件",
    en: "No installer available for this computer",
    ja: "このコンピューター用のインストーラーがありません",
  },
  登录未完成: {
    "zh-TW": "登入尚未完成",
    en: "Sign-in incomplete",
    ja: "ログインが完了していません",
  },
  可以用了: {
    "zh-TW": "可以使用了",
    en: "Ready to use",
    ja: "利用できます",
  },
  需要登录: {
    "zh-TW": "需要登入",
    en: "Sign-in required",
    ja: "ログインが必要です",
  },
  握手失败: {
    "zh-TW": "握手失敗",
    en: "Handshake failed",
    ja: "ハンドシェイクに失敗しました",
  },
  "正在检查登录状态…": {
    "zh-TW": "正在檢查登入狀態…",
    en: "Checking sign-in status…",
    ja: "ログイン状態を確認中…",
  },
  "等待「{name}」登录完成…（可能会打开浏览器）": {
    "zh-TW": "等待「{name}」登入完成…（可能會開啟瀏覽器）",
    en: "Waiting for “{name}” to finish signing in… (a browser may open)",
    ja: "「{name}」のログイン完了を待っています…（ブラウザーが開く場合があります）",
  },
  "已保存 {hint}": {
    "zh-TW": "已儲存 {hint}",
    en: "Saved {hint}",
    ja: "保存済み {hint}",
  },
  "粘贴 API Key": {
    "zh-TW": "貼上 API Key",
    en: "Paste API Key",
    ja: "API Key を貼り付け",
  },
  清除: {
    "zh-TW": "清除",
    en: "Clear",
    ja: "クリア",
  },
  "已在终端打开，完成后回来重新检测": {
    "zh-TW": "已在終端開啟，完成後請回來重新偵測",
    en: "Opened in a terminal. Come back and check again when done.",
    ja: "ターミナルで開きました。完了後、ここに戻って再確認してください。",
  },
  "在终端中打开「{name}」": {
    "zh-TW": "在終端中開啟「{name}」",
    en: "Open “{name}” in a terminal",
    ja: "ターミナルで「{name}」を開く",
  },
  "在 Harness 页管理": {
    "zh-TW": "在 Harness 頁面管理",
    en: "Manage on the Harness page",
    ja: "Harness ページで管理",
  },
  "已保存，重新发送消息即可": {
    "zh-TW": "已儲存，重新傳送訊息即可",
    en: "Saved. Send your message again to continue.",
    ja: "保存しました。メッセージを再送してください。",
  },
  开始使用团团: {
    "zh-TW": "開始使用團團",
    en: "Get started with Tuantuan",
    ja: "Tuantuan を使い始める",
  },
  "选一个 Harness": {
    "zh-TW": "選擇一個 Harness",
    en: "Choose a Harness",
    ja: "Harness を選択",
  },
  已安装: {
    "zh-TW": "已安裝",
    en: "Installed",
    ja: "インストール済み",
  },
  未安装: {
    "zh-TW": "尚未安裝",
    en: "Not installed",
    ja: "未インストール",
  },
  已就绪: {
    "zh-TW": "已就緒",
    en: "Ready",
    ja: "準備完了",
  },
  "连不上：{error}": {
    "zh-TW": "無法連線：{error}",
    en: "Could not connect: {error}",
    ja: "接続できません：{error}",
  },
  或在终端运行: {
    "zh-TW": "或在終端執行",
    en: "Or run in a terminal",
    ja: "またはターミナルで実行",
  },
  "给第一个 Agent 起名": {
    "zh-TW": "為第一個 Agent 命名",
    en: "Name your first Agent",
    ja: "最初の Agent に名前を付ける",
  },
  "Agent 名称": {
    "zh-TW": "Agent 名稱",
    en: "Agent name",
    ja: "Agent 名",
  },
  创建并开始会话: {
    "zh-TW": "建立並開始對話",
    en: "Create and start a conversation",
    ja: "作成して会話を開始",
  },
  全部: {
    "zh-TW": "全部",
    en: "All",
    ja: "すべて",
  },
  重新扫描本机目录: {
    "zh-TW": "重新掃描本機目錄",
    en: "Rescan local directories",
    ja: "ローカルフォルダーを再スキャン",
  },
  导入: {
    "zh-TW": "匯入",
    en: "Import",
    ja: "インポート",
  },
  "从 git 仓库或链接导入到团团自己的目录；本机的 ~/.claude、~/.codex 只读，不会改动。": {
    "zh-TW": "從 git 儲存庫或連結匯入至團團自己的目錄；本機的 ~/.claude、~/.codex 僅供讀取，不會修改。",
    en: "Import from a git repository or link into Tuantuan's own directory. Local ~/.claude and ~/.codex directories are read only and will not be changed.",
    ja: "git リポジトリまたはリンクから Tuantuan の専用フォルダーにインポートします。ローカルの ~/.claude と ~/.codex は読み取りのみで、変更しません。",
  },
  导入链接: {
    "zh-TW": "匯入連結",
    en: "Import link",
    ja: "インポート元のリンク",
  },
  已导入: {
    "zh-TW": "已匯入",
    en: "Imported",
    ja: "インポート済み",
  },
  "{count} 项": {
    "zh-TW": "{count} 項",
    en: "{count} items",
    ja: "{count} 件",
  },
  重新拉取最新版本: {
    "zh-TW": "重新取得最新版本",
    en: "Fetch the latest version",
    ja: "最新バージョンを取得",
  },
  更新: {
    "zh-TW": "更新",
    en: "Update",
    ja: "更新",
  },
  "删除 {name}": {
    "zh-TW": "刪除 {name}",
    en: "Delete {name}",
    ja: "{name} を削除",
  },
  删除: {
    "zh-TW": "刪除",
    en: "Delete",
    ja: "削除",
  },
  "删除「{name}」？用到它的 Agent 会自动不再加载。": {
    "zh-TW": "刪除「{name}」？使用它的 Agent 將自動停止載入。",
    en: "Delete “{name}”? Agents using it will stop loading it automatically.",
    ja: "「{name}」を削除しますか？利用中の Agent は自動的に読み込まなくなります。",
  },
  类型: {
    "zh-TW": "類型",
    en: "Type",
    ja: "種類",
  },
  搜索库: {
    "zh-TW": "搜尋資源庫",
    en: "Search library",
    ja: "ライブラリを検索",
  },
  "正在扫描…": {
    "zh-TW": "正在掃描…",
    en: "Scanning…",
    ja: "スキャン中…",
  },
  "还没有 Skill 或插件": {
    "zh-TW": "尚無 Skill 或外掛程式",
    en: "No Skills or plugins yet",
    ja: "Skill やプラグインがありません",
  },
  "{name} 可用": {
    "zh-TW": "{name} 可用",
    en: "Available in {name}",
    ja: "{name} で利用可能",
  },
  "{name} 不支持": {
    "zh-TW": "{name} 不支援",
    en: "Not supported by {name}",
    ja: "{name} では未対応",
  },
  "没有匹配「{query}」的项": {
    "zh-TW": "沒有符合「{query}」的項目",
    en: "No items match “{query}”",
    ja: "「{query}」に一致する項目がありません",
  },
  选择文件夹: {
    "zh-TW": "選擇資料夾",
    en: "Choose a folder",
    ja: "フォルダーを選択",
  },
  更改: {
    "zh-TW": "變更",
    en: "Change",
    ja: "変更",
  },
  "选择文件夹…": {
    "zh-TW": "選擇資料夾…",
    en: "Choose a folder…",
    ja: "フォルダーを選択…",
  },
  关闭: {
    "zh-TW": "關閉",
    en: "Close",
    ja: "閉じる",
  },
  常用位置: {
    "zh-TW": "常用位置",
    en: "Locations",
    ja: "よく使う場所",
  },
  主目录: {
    "zh-TW": "家目錄",
    en: "Home",
    ja: "ホーム",
  },
  最近: {
    "zh-TW": "最近",
    en: "Recent",
    ja: "最近",
  },
  没有子文件夹: {
    "zh-TW": "沒有子資料夾",
    en: "No subfolders",
    ja: "サブフォルダーがありません",
  },
  显示隐藏: {
    "zh-TW": "顯示隱藏項目",
    en: "Show hidden items",
    ja: "隠し項目を表示",
  },
  选择此文件夹: {
    "zh-TW": "選擇此資料夾",
    en: "Choose this folder",
    ja: "このフォルダーを選択",
  },
  "\n{name} 会改回「本机配置」。": {
    "zh-TW": "\n{name} 將改回「本機設定」。",
    en: "\n{name} will switch back to “Local configuration”.",
    ja: "\n{name} は「ローカル設定」に戻ります。",
  },
  "删除「{name}」？{extra}": {
    "zh-TW": "刪除「{name}」？{extra}",
    en: "Delete “{name}”?{extra}",
    ja: "「{name}」を削除しますか？{extra}",
  },
  服务商与用量: {
    "zh-TW": "服務商與用量",
    en: "Providers and usage",
    ja: "プロバイダーと使用量",
  },
  "保存 API 服务商，一键给 Agent 切换；查看各 Harness 的额度": {
    "zh-TW": "儲存 API 服務商，一鍵為 Agent 切換；查看各 Harness 的額度",
    en: "Save API providers, switch Agents with one click, and check each Harness's quota",
    ja: "API プロバイダーを保存して Agent の接続先を切り替え、各 Harness の利用枠を確認できます",
  },
  额度: {
    "zh-TW": "額度",
    en: "Quota",
    ja: "利用枠",
  },
  "只读本机记录和 Harness 自己的查询结果，不读钥匙串。": {
    "zh-TW": "僅讀取本機記錄及 Harness 自己的查詢結果，不讀取鑰匙圈。",
    en: "Reads local records and results from each Harness. Does not access the keychain.",
    ja: "ローカルの記録と各 Harness の照会結果を読み取ります。キーチェーンにはアクセスしません。",
  },
  "Key 只存在团团，只注入给用它的 Agent 进程，不改 ~/.claude、~/.codex。": {
    "zh-TW": "Key 僅儲存在團團，只注入使用它的 Agent 程序，不會修改 ~/.claude、~/.codex。",
    en: "Keys are stored only in Tuantuan and injected only into Agent processes that use them. ~/.claude and ~/.codex are not changed.",
    ja: "キーは Tuantuan にのみ保存し、使用する Agent のプロセスにのみ渡します。~/.claude と ~/.codex は変更しません。",
  },
  "从 CC Switch 导入": {
    "zh-TW": "從 CC Switch 匯入",
    en: "Import from CC Switch",
    ja: "CC Switch からインポート",
  },
  "还没有服务商。不选时，Agent 用「本机配置」（你自己的登录或环境变量）。": {
    "zh-TW": "尚無服務商。未選擇時，Agent 使用「本機設定」（你自己的登入資訊或環境變數）。",
    en: "No providers yet. Without a selection, Agents use “Local configuration” with your own sign-in or environment variables.",
    ja: "プロバイダーがありません。未選択の場合、Agent は「ローカル設定」（既存のログイン情報または環境変数）を使用します。",
  },
  "剩 {count}%": {
    "zh-TW": "剩餘 {count}%",
    en: "{count}% remaining",
    ja: "残り {count}%",
  },
  "{time} 重置": {
    "zh-TW": "{time} 重設",
    en: "Resets {time}",
    ja: "{time} にリセット",
  },
  "刷新 {name} 额度": {
    "zh-TW": "重新整理 {name} 額度",
    en: "Refresh {name} quota",
    ja: "{name} の利用枠を更新",
  },
  查询额度: {
    "zh-TW": "查詢額度",
    en: "Check quota",
    ja: "利用枠を照会",
  },
  暂不支持查询: {
    "zh-TW": "暫不支援查詢",
    en: "Quota lookup not supported yet",
    ja: "利用枠の照会は未対応です",
  },
  额度未知: {
    "zh-TW": "額度未知",
    en: "Quota unknown",
    ja: "利用枠は不明です",
  },
  预付余额: {
    "zh-TW": "預付餘額",
    en: "Prepaid balance",
    ja: "プリペイド残高",
  },
  今天: {
    "zh-TW": "今天",
    en: "Today",
    ja: "今日",
  },
  "7 天": {
    "zh-TW": "7 天",
    en: "7 days",
    ja: "7 日間",
  },
  今天花费: {
    "zh-TW": "今日花費",
    en: "Spent today",
    ja: "今日の費用",
  },
  "来源：{source}": {
    "zh-TW": "來源：{source}",
    en: "Source: {source}",
    ja: "取得元：{source}",
  },
  "查询于 {time}": {
    "zh-TW": "查詢於 {time}",
    en: "Checked {time}",
    ja: "照会日時：{time}",
  },
  团团今天: {
    "zh-TW": "團團今天",
    en: "Tuantuan today",
    ja: "今日の Tuantuan",
  },
  "{count} 轮": {
    "zh-TW": "{count} 輪",
    en: "{count} turns",
    ja: "{count} ターン",
  },
  合计: {
    "zh-TW": "合計",
    en: "Total",
    ja: "合計",
  },
  今天还没有对话: {
    "zh-TW": "今天尚無對話",
    en: "No conversations today",
    ja: "今日の会話はありません",
  },
  "来源：每轮 ACP 返回的 usage": {
    "zh-TW": "來源：每輪 ACP 回傳的 usage",
    en: "Source: usage returned by ACP each turn",
    ja: "取得元：各ターンの ACP usage 応答",
  },
  "无 Key": {
    "zh-TW": "無 Key",
    en: "No key",
    ja: "キーなし",
  },
  "{name} 在用": {
    "zh-TW": "{name} 使用中",
    en: "Used by {name}",
    ja: "{name} が使用中",
  },
  "连通 · {count} ms": {
    "zh-TW": "連線成功 · {count} ms",
    en: "Connected · {count} ms",
    ja: "接続成功 · {count} ms",
  },
  "失败：{error}": {
    "zh-TW": "失敗：{error}",
    en: "Failed: {error}",
    ja: "失敗：{error}",
  },
  "余额 {amount}": {
    "zh-TW": "餘額 {amount}",
    en: "Balance {amount}",
    ja: "残高 {amount}",
  },
  "没有能用它的 Agent": {
    "zh-TW": "沒有可使用它的 Agent",
    en: "No compatible Agents",
    ja: "利用できる Agent がありません",
  },
  测速: {
    "zh-TW": "測速",
    en: "Test latency",
    ja: "応答速度をテスト",
  },
  余额: {
    "zh-TW": "餘額",
    en: "Balance",
    ja: "残高",
  },
  "切换 Agent": {
    "zh-TW": "切換 Agent",
    en: "Switch Agents",
    ja: "Agent を切り替え",
  },
  "编辑 {name}": {
    "zh-TW": "編輯 {name}",
    en: "Edit {name}",
    ja: "{name} を編集",
  },
  编辑服务商: {
    "zh-TW": "編輯服務商",
    en: "Edit provider",
    ja: "プロバイダーを編集",
  },
  添加服务商: {
    "zh-TW": "新增服務商",
    en: "Add provider",
    ja: "プロバイダーを追加",
  },
  预设: {
    "zh-TW": "預設",
    en: "Presets",
    ja: "プリセット",
  },
  获取: {
    "zh-TW": "取得",
    en: "Get key",
    ja: "キーを取得",
  },
  "{hint}（留空不变）": {
    "zh-TW": "{hint}（留空則不變）",
    en: "{hint} (leave blank to keep)",
    ja: "{hint}（空欄の場合は変更しません）",
  },
  "Management Key（选填，用于查余额）": {
    "zh-TW": "Management Key（選填，用於查詢餘額）",
    en: "Management Key (optional, for balance lookup)",
    ja: "Management Key（任意、残高の照会用）",
  },
  "Anthropic 兼容地址": {
    "zh-TW": "Anthropic 相容位址",
    en: "Anthropic-compatible URL",
    ja: "Anthropic 互換 URL",
  },
  "用于 Claude Code / OpenCode / Pi。": {
    "zh-TW": "用於 Claude Code / OpenCode / Pi。",
    en: "For Claude Code / OpenCode / Pi.",
    ja: "Claude Code / OpenCode / Pi 用です。",
  },
  "OpenAI 兼容地址": {
    "zh-TW": "OpenAI 相容位址",
    en: "OpenAI-compatible URL",
    ja: "OpenAI 互換 URL",
  },
  "用于 OpenCode / Pi / Codex；Codex 需要 Responses。": {
    "zh-TW": "用於 OpenCode / Pi / Codex；Codex 需要 Responses。",
    en: "For OpenCode / Pi / Codex. Codex requires Responses.",
    ja: "OpenCode / Pi / Codex 用です。Codex には Responses が必要です。",
  },
  "仅作用于 OpenAI 兼容地址；须与服务商实际支持的格式一致，选择不会转换接口。": {
    "zh-TW": "僅適用於 OpenAI 相容位址；須與服務商實際支援的格式一致，選擇不會轉換介面。",
    en: "Applies only to the OpenAI-compatible URL. Match the provider's supported format; this setting does not convert the API.",
    ja: "OpenAI 互換 URL にのみ適用します。プロバイダーが対応する形式を選んでください。この設定で API 形式は変換されません。",
  },
  "两个地址都填写时，OpenCode / Pi 优先使用 OpenAI 兼容地址。": {
    "zh-TW": "兩個位址皆填寫時，OpenCode / Pi 優先使用 OpenAI 相容位址。",
    en: "When both URLs are set, OpenCode / Pi prefer the OpenAI-compatible URL.",
    ja: "両方の URL を設定すると、OpenCode / Pi は OpenAI 互換 URL を優先します。",
  },
  主模型: {
    "zh-TW": "主要模型",
    en: "Main model",
    ja: "メインモデル",
  },
  "服务商的模型 ID": {
    "zh-TW": "服務商的模型 ID",
    en: "Provider's model ID",
    ja: "プロバイダーのモデル ID",
  },
  快速模型: {
    "zh-TW": "快速模型",
    en: "Fast model",
    ja: "高速モデル",
  },
  同主模型: {
    "zh-TW": "與主要模型相同",
    en: "Same as main model",
    ja: "メインモデルと同じ",
  },
  "OpenCode / Pi 需要填写主模型；Claude Code / Codex 留空时跟随 Harness。": {
    "zh-TW": "OpenCode / Pi 必須填寫主要模型；Claude Code / Codex 留空時跟隨 Harness。",
    en: "OpenCode / Pi require a main model. Claude Code / Codex use the Harness default when left blank.",
    ja: "OpenCode / Pi ではメインモデルの指定が必要です。Claude Code / Codex は空欄の場合、Harness の既定値を使用します。",
  },
  当前可用于: {
    "zh-TW": "目前可用於",
    en: "Currently compatible with",
    ja: "現在利用できる Harness",
  },
  填写兼容地址后显示: {
    "zh-TW": "填寫相容位址後顯示",
    en: "Shown after entering a compatible URL",
    ja: "互換 URL を入力すると表示されます",
  },
  "没找到 CC Switch 配置（~/.cc-switch）。": {
    "zh-TW": "找不到 CC Switch 設定（~/.cc-switch）。",
    en: "No CC Switch configuration found (~/.cc-switch).",
    ja: "CC Switch の設定（~/.cc-switch）が見つかりません。",
  },
  "只读取 {path}，不会修改它。": {
    "zh-TW": "僅讀取 {path}，不會修改它。",
    en: "Only reads {path}; it will not be changed.",
    ja: "{path} は読み取りのみで、変更しません。",
  },
  当前: {
    "zh-TW": "目前",
    en: "Current",
    ja: "現在",
  },
  "导入 {count} 个": {
    "zh-TW": "匯入 {count} 個",
    en: "Import {count}",
    ja: "{count} 件をインポート",
  },
  "30 天": {
    "zh-TW": "30 天",
    en: "30 days",
    ja: "30 日間",
  },
  未知: {
    "zh-TW": "未知",
    en: "Unknown",
    ja: "不明",
  },
  "已删除的 Agent": {
    "zh-TW": "已刪除的 Agent",
    en: "Deleted Agent",
    ja: "削除済みの Agent",
  },
  未标明模型: {
    "zh-TW": "未標明模型",
    en: "Unspecified model",
    ja: "モデル未指定",
  },
  "Token 统计": {
    "zh-TW": "Token 統計",
    en: "Token statistics",
    ja: "トークン統計",
  },
  "按每轮回复里 Harness 报告的数字统计，不估算。": {
    "zh-TW": "依每輪回覆中 Harness 回報的數字統計，不進行估算。",
    en: "Uses the numbers reported by the Harness in each reply, without estimates.",
    ja: "各返信で Harness が報告した数値を集計します。推定値は使用しません。",
  },
  时间范围: {
    "zh-TW": "時間範圍",
    en: "Time range",
    ja: "期間",
  },
  总计: {
    "zh-TW": "總計",
    en: "Total",
    ja: "合計",
  },
  输入: {
    "zh-TW": "輸入",
    en: "Input",
    ja: "入力",
  },
  输出: {
    "zh-TW": "輸出",
    en: "Output",
    ja: "出力",
  },
  "含思考 {count}": {
    "zh-TW": "含思考 {count}",
    en: "Includes {count} reasoning tokens",
    ja: "思考トークン {count} を含む",
  },
  缓存: {
    "zh-TW": "快取",
    en: "Cache",
    ja: "キャッシュ",
  },
  "读 {read} · 写 {write}": {
    "zh-TW": "讀取 {read} · 寫入 {write}",
    en: "Read {read} · Write {write}",
    ja: "読み取り {read} · 書き込み {write}",
  },
  "命中率 {rate}": {
    "zh-TW": "命中率 {rate}",
    en: "Hit rate {rate}",
    ja: "ヒット率 {rate}",
  },
  费用: {
    "zh-TW": "費用",
    en: "Cost",
    ja: "費用",
  },
  无数据: {
    "zh-TW": "無資料",
    en: "No data",
    ja: "データなし",
  },
  分组: {
    "zh-TW": "分組",
    en: "Group by",
    ja: "グループ分け",
  },
  这段时间没有记录: {
    "zh-TW": "這段時間沒有記錄",
    en: "No records for this period",
    ja: "この期間の記録がありません",
  },
  "输入 {input} · 输出 {output} · 缓存 {cache} · 命中率 {rate}": {
    "zh-TW": "輸入 {input} · 輸出 {output} · 快取 {cache} · 命中率 {rate}",
    en: "Input {input} · Output {output} · Cache {cache} · Hit rate {rate}",
    ja: "入力 {input} · 出力 {output} · キャッシュ {cache} · ヒット率 {rate}",
  },
  "每日 Token 趋势": {
    "zh-TW": "每日 Token 趨勢",
    en: "Daily token trend",
    ja: "日別のトークン推移",
  },
  "峰值 {count}": {
    "zh-TW": "峰值 {count}",
    en: "Peak {count}",
    ja: "最大 {count}",
  },
  "{name}：{delivery}。": {
    "zh-TW": "{name}：{delivery}。",
    en: "{name}: {delivery}.",
    ja: "{name}：{delivery}。",
  },
  追加到系统提示: {
    "zh-TW": "附加至系統提示",
    en: "Appended to the system prompt",
    ja: "システムプロンプトに追加",
  },
  "作为系统规则追加（_meta.rules）": {
    "zh-TW": "作為系統規則附加（_meta.rules）",
    en: "Appended as system rules (_meta.rules)",
    ja: "システムルールとして追加（_meta.rules）",
  },
  "作为 developer_instructions（CODEX_CONFIG 环境变量）": {
    "zh-TW": "作為 developer_instructions（CODEX_CONFIG 環境變數）",
    en: "Passed as developer_instructions (CODEX_CONFIG environment variable)",
    ja: "developer_instructions として指定（CODEX_CONFIG 環境変数）",
  },
  放在每个新会话的第一条消息前: {
    "zh-TW": "放在每個新對話的第一則訊息前",
    en: "Prepended to the first message of each new session",
    ja: "新しいセッションの最初のメッセージの前に挿入",
  },
  "项目 {path}": {
    "zh-TW": "專案 {path}",
    en: "Project {path}",
    ja: "プロジェクト {path}",
  },
  官方脚本: {
    "zh-TW": "官方指令碼",
    en: "Official script",
    ja: "公式スクリプト",
  },
  脚本: {
    "zh-TW": "指令碼",
    en: "Script",
    ja: "スクリプト",
  },
  "运行下面的登录命令完成 /login；或设置 ANTHROPIC_API_KEY": {
    "zh-TW": "執行下方的登入命令完成 /login；或設定 ANTHROPIC_API_KEY",
    en: "Run the sign-in command below to complete /login, or set ANTHROPIC_API_KEY",
    ja: "下のログインコマンドで /login を完了するか、ANTHROPIC_API_KEY を設定してください",
  },
  "运行 codex login（ChatGPT 账号）；或设置 OPENAI_API_KEY / CODEX_API_KEY": {
    "zh-TW": "執行 codex login（ChatGPT 帳號）；或設定 OPENAI_API_KEY / CODEX_API_KEY",
    en: "Run codex login with a ChatGPT account, or set OPENAI_API_KEY / CODEX_API_KEY",
    ja: "codex login で ChatGPT アカウントにログインするか、OPENAI_API_KEY / CODEX_API_KEY を設定してください",
  },
  "运行 grok login；或设置 XAI_API_KEY": {
    "zh-TW": "執行 grok login；或設定 XAI_API_KEY",
    en: "Run grok login, or set XAI_API_KEY",
    ja: "grok login を実行するか、XAI_API_KEY を設定してください",
  },
  "运行 opencode auth login 选择模型提供方": {
    "zh-TW": "執行 opencode auth login 選擇模型提供方",
    en: "Run opencode auth login to choose a model provider",
    ja: "opencode auth login を実行してモデルプロバイダーを選択してください",
  },
  "pi-acp 会调用本机的 pi：先装 pi 并在终端运行 pi 配置模型和 Key": {
    "zh-TW": "pi-acp 會呼叫本機的 pi：請先安裝 pi，並在終端執行 pi 設定模型與 Key",
    en: "pi-acp uses your local pi installation. Install pi, then run pi in a terminal to configure the model and key",
    ja: "pi-acp はローカルの pi を呼び出します。pi をインストールし、ターミナルで pi を実行してモデルとキーを設定してください",
  },
  "在终端运行 mcode 登录 MiniMax 账号，或按握手结果里的方式登录": {
    "zh-TW": "在終端執行 mcode 登入 MiniMax 帳號，或依握手結果中的方式登入",
    en: "Run mcode in a terminal to sign in to MiniMax, or use the method shown by the handshake",
    ja: "ターミナルで mcode を実行して MiniMax にログインするか、ハンドシェイク結果に表示された方法でログインしてください",
  },
  无需登录: {
    "zh-TW": "無須登入",
    en: "No sign-in required",
    ja: "ログイン不要",
  },
  "按握手结果里 Agent 自己声明的方式登录": {
    "zh-TW": "依握手結果中 Agent 宣告的方式登入",
    en: "Use the sign-in method reported by the Agent during the handshake",
    ja: "ハンドシェイクで Agent が示した方法でログインしてください",
  },
  "已随团团内置（@agentclientprotocol/claude-agent-acp）": {
    "zh-TW": "已隨團團內建（@agentclientprotocol/claude-agent-acp）",
    en: "Bundled with Tuantuan (@agentclientprotocol/claude-agent-acp)",
    ja: "Tuantuan に同梱（@agentclientprotocol/claude-agent-acp）",
  },
  "已随团团内置（@agentclientprotocol/codex-acp）": {
    "zh-TW": "已隨團團內建（@agentclientprotocol/codex-acp）",
    en: "Bundled with Tuantuan (@agentclientprotocol/codex-acp)",
    ja: "Tuantuan に同梱（@agentclientprotocol/codex-acp）",
  },
  "内置，仅用于测试": {
    "zh-TW": "內建，僅供測試",
    en: "Bundled, for testing only",
    ja: "同梱、テスト専用",
  },
  "npm i -g @minimax-ai/code（需要 Node ≥ 22.19）": {
    "zh-TW": "npm i -g @minimax-ai/code（需要 Node ≥ 22.19）",
    en: "npm i -g @minimax-ai/code (requires Node ≥ 22.19)",
    ja: "npm i -g @minimax-ai/code（Node ≥ 22.19 が必要）",
  },
  "在「Harness」页的「更多」里一键安装": {
    "zh-TW": "在「Harness」頁面的「更多」區塊一鍵安裝",
    en: "Install with one click under “More Agents” on the Harness page",
    ja: "「Harness」ページの「その他の Agent」からインストールできます",
  },
  "Mock（测试）": {
    "zh-TW": "Mock（測試）",
    en: "Mock (test)",
    ja: "Mock（テスト）",
  },
  "Mock CLI（安装测试）": {
    "zh-TW": "Mock CLI（安裝測試）",
    en: "Mock CLI (installation test)",
    ja: "Mock CLI（インストールテスト）",
  },
  "Mock 设置": {
    "zh-TW": "Mock 設定",
    en: "Mock setup",
    ja: "Mock の設定",
  },
  "Mock 登录": {
    "zh-TW": "Mock 登入",
    en: "Mock sign-in",
    ja: "Mock のログイン",
  },
  "立即登录（测试用）": {
    "zh-TW": "立即登入（測試用）",
    en: "Sign in immediately (for testing)",
    ja: "すぐにログイン（テスト用）",
  },
  "ZCode（社区桥接）": {
    "zh-TW": "ZCode（社群橋接）",
    en: "ZCode (community bridge)",
    ja: "ZCode（コミュニティブリッジ）",
  },
  "社区项目 zcode-acp-server：把智谱 ZCode 的无界面服务桥接成 ACP。需要先装好 ZCode 并登录（~/.zcode）。": {
    "zh-TW": "社群專案 zcode-acp-server：將智譜 ZCode 的無介面服務橋接為 ACP。需先安裝 ZCode 並登入（~/.zcode）。",
    en: "Community project zcode-acp-server bridges ZCode's headless service to ACP. Install ZCode and sign in first (~/.zcode).",
    ja: "コミュニティプロジェクト zcode-acp-server は、ZCode のヘッドレスサービスを ACP に接続します。先に ZCode をインストールしてログインしてください（~/.zcode）。",
  },
  "实验性社区桥接。0.70.0 尚不支持 ZCode 团队套餐；本机团队登录可用不代表桥接可用，1113 错误也可能来自个人 / 团队渠道不一致。":
    {
      "zh-TW":
        "實驗性社群橋接。0.70.0 尚不支援 ZCode 團隊方案；本機團隊登入可用不代表橋接可用，1113 錯誤也可能來自個人與團隊管道不一致。",
      en: "Experimental community bridge. Version 0.70.0 does not support ZCode team plans. A working local team sign-in does not guarantee bridge support; error 1113 may also indicate a personal/team channel mismatch.",
      ja: "実験的なコミュニティブリッジです。0.70.0 は ZCode のチームプランに未対応です。ローカルでチームログインできてもブリッジが使えるとは限りません。1113 エラーは個人用とチーム用の接続先の違いでも発生する場合があります。",
    },
  "智谱 GLM": {
    "zh-TW": "智譜 GLM",
    en: "Zhipu GLM",
    ja: "Zhipu GLM",
  },
  通义千问: {
    "zh-TW": "通義千問",
    en: "Qwen",
    ja: "Qwen",
  },
  硅基流动: {
    "zh-TW": "矽基流動",
    en: "SiliconFlow",
    ja: "SiliconFlow",
  },
  自定义: {
    "zh-TW": "自訂",
    en: "Custom",
    ja: "カスタム",
  },
  每周: {
    "zh-TW": "每週",
    en: "Weekly",
    ja: "毎週",
  },
  "每周（全部模型）": {
    "zh-TW": "每週（全部模型）",
    en: "Weekly (all models)",
    ja: "毎週（すべてのモデル）",
  },
  "每周 · {model}": {
    "zh-TW": "每週 · {model}",
    en: "Weekly · {model}",
    ja: "毎週 · {model}",
  },
  "{count} 分钟": {
    "zh-TW": "{count} 分鐘",
    en: "{count} min",
    ja: "{count} 分",
  },
  "{count} 小时": {
    "zh-TW": "{count} 小時",
    en: "{count} hours",
    ja: "{count} 時間",
  },
  "{count} 天": {
    "zh-TW": "{count} 天",
    en: "{count} days",
    ja: "{count} 日",
  },
  短周期: {
    "zh-TW": "短週期",
    en: "Short window",
    ja: "短期の利用枠",
  },
  长周期: {
    "zh-TW": "長週期",
    en: "Long window",
    ja: "長期の利用枠",
  },
  每周额度: {
    "zh-TW": "每週額度",
    en: "Weekly quota",
    ja: "週単位の利用枠",
  },
  每月额度: {
    "zh-TW": "每月額度",
    en: "Monthly quota",
    ja: "月単位の利用枠",
  },
  当前周期额度: {
    "zh-TW": "目前週期額度",
    en: "Current period quota",
    ja: "現在の期間の利用枠",
  },
  按需消费上限: {
    "zh-TW": "按需消費上限",
    en: "On-demand spending limit",
    ja: "従量課金の上限",
  },
  个人渠道额度: {
    "zh-TW": "個人管道額度",
    en: "Personal channel quota",
    ja: "個人用チャネルの利用枠",
  },
  "额度：点刷新向 Claude Code 查询": {
    "zh-TW": "額度：點選重新整理以向 Claude Code 查詢",
    en: "Quota: refresh to check with Claude Code",
    ja: "利用枠：更新して Claude Code に照会してください",
  },
  "额度：点刷新向 Grok 查询": {
    "zh-TW": "額度：點選重新整理以向 Grok 查詢",
    en: "Quota: refresh to check with Grok",
    ja: "利用枠：更新して Grok に照会してください",
  },
  "额度尚未查询；请点刷新，或在 Harness 登录/测试成功后同步": {
    "zh-TW": "尚未查詢額度；請點選重新整理，或在 Harness 登入／測試成功後同步",
    en: "Quota has not been checked. Refresh, or sync after a successful Harness sign-in or test.",
    ja: "利用枠は未照会です。更新するか、Harness のログインまたはテストの成功後に同期してください。",
  },
  登录失败: {
    "zh-TW": "登入失敗",
    en: "Sign-in failed",
    ja: "ログインに失敗しました",
  },
  "复制命令：{label}": {
    "zh-TW": "複製命令：{label}",
    en: "Copy command: {label}",
    ja: "コマンドをコピー：{label}",
  },
  "没有 ~/.claude/projects 记录": {
    "zh-TW": "沒有 ~/.claude/projects 記錄",
    en: "No records under ~/.claude/projects",
    ja: "~/.claude/projects に記録がありません",
  },
  "没有 ~/.codex/sessions 记录": {
    "zh-TW": "沒有 ~/.codex/sessions 記錄",
    en: "No records under ~/.codex/sessions",
    ja: "~/.codex/sessions に記録がありません",
  },
  "没有安装 Grok": {
    "zh-TW": "尚未安裝 Grok",
    en: "Grok is not installed",
    ja: "Grok がインストールされていません",
  },
  模型能力: { "zh-TW": "模型能力", en: "Model capabilities", ja: "モデルの機能" },
  "仅手动同步时连接 models.dev；失败时保留本地目录。": {
    "zh-TW": "僅手動同步時連線 models.dev；失敗時保留本機目錄。",
    en: "Connects to models.dev only when you sync manually. The local catalog is kept if syncing fails.",
    ja: "手動同期時のみ models.dev に接続します。失敗した場合はローカルカタログを保持します。",
  },
  "同步中…": { "zh-TW": "同步中…", en: "Syncing…", ja: "同期中…" },
  同步模型能力: { "zh-TW": "同步模型能力", en: "Sync model capabilities", ja: "モデルの機能を同期" },
  "内置目录 · {time}": { "zh-TW": "內建目錄 · {time}", en: "Bundled catalog · {time}", ja: "内蔵カタログ · {time}" },
  "同步于 {time}": { "zh-TW": "同步於 {time}", en: "Synced {time}", ja: "同期日時：{time}" },
  "{providers} 个服务商 · {models} 个模型": {
    "zh-TW": "{providers} 個服務商 · {models} 個模型",
    en: "{providers} providers · {models} models",
    ja: "{providers} プロバイダー · {models} モデル",
  },
  模型能力已同步: { "zh-TW": "模型能力已同步", en: "Model capabilities synced", ja: "モデルの機能を同期しました" },
  "同步未完成，继续使用本地目录。": {
    "zh-TW": "同步未完成，繼續使用本機目錄。",
    en: "Sync did not complete. The local catalog is still in use.",
    ja: "同期が完了しませんでした。ローカルカタログを引き続き使用します。",
  },
  "更新后的能力用于之后启动的 Agent，现有会话不变。": {
    "zh-TW": "更新後的能力用於之後啟動的 Agent，現有會話不變。",
    en: "Updated capabilities apply to agents started afterward. Existing sessions stay unchanged.",
    ja: "更新された機能は次回以降に起動する Agent に適用され、既存のセッションは変わりません。",
  },
  模型能力来源: { "zh-TW": "模型能力來源", en: "Model capability sources", ja: "モデル機能の参照元" },
  "填写 models.dev 的完整 provider/model 引用；留空按预设和接口地址自动识别。": {
    "zh-TW": "填寫 models.dev 的完整 provider/model 參照；留空時依預設和介面位址自動識別。",
    en: "Enter the full models.dev provider/model reference. Leave blank to detect it from the preset and API address.",
    ja: "models.dev の完全な provider/model 参照を入力します。空欄の場合はプリセットと API アドレスから自動判定します。",
  },
  "仅关联思考档位、上下文等能力，不会修改请求中的模型 ID 或接口地址。": {
    "zh-TW": "僅關聯思考等級、上下文等能力，不會修改請求中的模型 ID 或介面位址。",
    en: "This links capabilities such as thinking levels and context size. It does not change the model ID or API address sent in requests.",
    ja: "思考レベルやコンテキスト容量などの機能のみを関連付けます。リクエストのモデル ID や API アドレスは変更しません。",
  },
  主模型能力来源: { "zh-TW": "主模型能力來源", en: "Main model capability source", ja: "メインモデル機能の参照元" },
  快速模型能力来源: { "zh-TW": "快速模型能力來源", en: "Fast model capability source", ja: "高速モデル機能の参照元" },
  "快速模型与主模型相同时，沿用主模型的能力来源。": {
    "zh-TW": "快速模型與主模型相同時，沿用主模型的能力來源。",
    en: "When the fast model is the same as the main model, it shares the same capability source.",
    ja: "高速モデルがメインモデルと同じ場合は、同じ機能の参照元を使用します。",
  },
  "自动识别（留空）": { "zh-TW": "自動識別（留空）", en: "Auto-detect (leave blank)", ja: "自動判定（空欄）" },
  "对应模型 ID：{model}": { "zh-TW": "對應模型 ID：{model}", en: "Model ID: {model}", ja: "対象モデル ID：{model}" },
  "暂时无法加载建议，可手动填写完整引用。": {
    "zh-TW": "暫時無法載入建議，可手動填寫完整參照。",
    en: "Suggestions are temporarily unavailable. You can enter a full reference manually.",
    ja: "候補を読み込めません。完全な参照を手動で入力できます。",
  },
} satisfies MessageCatalog;
