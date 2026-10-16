import type { MessageCatalog } from "./types";

export const coreMessages = {
  我: {
    "zh-TW": "我",
    en: "Me",
    ja: "自分",
  },
  侧栏: {
    "zh-TW": "側欄",
    en: "Sidebar",
    ja: "サイドバー",
  },
  "团团 Tuantuan": {
    "zh-TW": "團團 Tuantuan",
    en: "Tuantuan",
    ja: "Tuantuan",
  },
  团团: {
    "zh-TW": "團團",
    en: "Tuantuan",
    ja: "Tuantuan",
  },
  搜索: {
    "zh-TW": "搜尋",
    en: "Search",
    ja: "検索",
  },
  "搜索（⌘K / Ctrl+K）": {
    "zh-TW": "搜尋（⌘K / Ctrl+K）",
    en: "Search (⌘K / Ctrl+K)",
    ja: "検索（⌘K / Ctrl+K）",
  },
  新建会话: {
    "zh-TW": "新增對話",
    en: "New conversation",
    ja: "新しい会話",
  },
  "先创建一个 Agent": {
    "zh-TW": "請先建立一個 Agent",
    en: "Create an Agent first",
    ja: "先に Agent を作成してください",
  },
  "还没有 Agent": {
    "zh-TW": "還沒有 Agent",
    en: "No Agents yet",
    ja: "Agent はまだありません",
  },
  "创建一个，就能开始会话。": {
    "zh-TW": "建立一個，就能開始對話。",
    en: "Create an Agent to start a conversation.",
    ja: "Agent を作成して会話を始めましょう。",
  },
  "创建 Agent": {
    "zh-TW": "建立 Agent",
    en: "Create Agent",
    ja: "Agent を作成",
  },
  项目: {
    "zh-TW": "專案",
    en: "Project",
    ja: "プロジェクト",
  },
  新建项目: {
    "zh-TW": "新增專案",
    en: "New project",
    ja: "新しいプロジェクト",
  },
  "{name} 设置": {
    "zh-TW": "{name} 設定",
    en: "{name} settings",
    ja: "{name} の設定",
  },
  "在 {name} 新建会话": {
    "zh-TW": "在 {name} 新增對話",
    en: "New conversation in {name}",
    ja: "{name} で新しい会話を作成",
  },
  还没有会话: {
    "zh-TW": "還沒有對話",
    en: "No conversations yet",
    ja: "会話はまだありません",
  },
  会话: {
    "zh-TW": "對話",
    en: "Conversations",
    ja: "会話",
  },
  设置: {
    "zh-TW": "設定",
    en: "Settings",
    ja: "設定",
  },
  个人资料: {
    "zh-TW": "個人資料",
    en: "Profile",
    ja: "プロフィール",
  },
  "未绑定 Harness": {
    "zh-TW": "尚未綁定 Harness",
    en: "No Harness configured",
    ja: "Harness が未設定",
  },
  "新建 Agent": {
    "zh-TW": "新增 Agent",
    en: "New Agent",
    ja: "新しい Agent",
  },
  "Skills 与插件": {
    "zh-TW": "Skills 與外掛",
    en: "Skills & plugins",
    ja: "Skills とプラグイン",
  },
  服务商与用量: {
    "zh-TW": "服務商與用量",
    en: "Providers & usage",
    ja: "プロバイダーと使用量",
  },
  通知: {
    "zh-TW": "通知",
    en: "Notifications",
    ja: "通知",
  },
  "{name} · 个人资料": {
    "zh-TW": "{name} · 個人資料",
    en: "{name} · Profile",
    ja: "{name} · プロフィール",
  },
  实时连接正常: {
    "zh-TW": "即時連線正常",
    en: "Live connection active",
    ja: "リアルタイム接続中",
  },
  "实时连接已断开，正在重连…": {
    "zh-TW": "即時連線已中斷，正在重新連線…",
    en: "Disconnected. Reconnecting…",
    ja: "接続が切れました。再接続中…",
  },
  已连接: {
    "zh-TW": "已連線",
    en: "Connected",
    ja: "接続済み",
  },
  重连中: {
    "zh-TW": "重新連線中",
    en: "Reconnecting",
    ja: "再接続中",
  },
  "加载失败：{error}": {
    "zh-TW": "載入失敗：{error}",
    en: "Could not load: {error}",
    ja: "読み込みに失敗しました：{error}",
  },
  重试: {
    "zh-TW": "重試",
    en: "Retry",
    ja: "再試行",
  },
  "选择一个 Agent 进行编辑": {
    "zh-TW": "選擇一個 Agent 進行編輯",
    en: "Select an Agent to edit",
    ja: "編集する Agent を選択",
  },
  "创建你的第一个 Agent": {
    "zh-TW": "建立你的第一個 Agent",
    en: "Create your first Agent",
    ja: "最初の Agent を作成",
  },
  正在回复: {
    "zh-TW": "正在回覆",
    en: "Responding",
    ja: "応答中",
  },
  "正在回复…": {
    "zh-TW": "正在回覆…",
    en: "Responding…",
    ja: "応答中…",
  },
  "（空回复）": {
    "zh-TW": "（空回覆）",
    en: "(Empty reply)",
    ja: "（空の応答）",
  },
  回复失败: {
    "zh-TW": "回覆失敗",
    en: "Reply failed",
    ja: "応答に失敗しました",
  },
  已取消: {
    "zh-TW": "已取消",
    en: "Cancelled",
    ja: "キャンセル済み",
  },
  已中断: {
    "zh-TW": "已中斷",
    en: "Interrupted",
    ja: "中断済み",
  },
  "{count} 条未读": {
    "zh-TW": "{count} 則未讀",
    en: "Unread: {count}",
    ja: "未読 {count} 件",
  },
  "搜索会话与 Agent": {
    "zh-TW": "搜尋對話與 Agent",
    en: "Search conversations and Agents",
    ja: "会話と Agent を検索",
  },
  "接入 Harness，绑定到 Agent": {
    "zh-TW": "接入 Harness，綁定至 Agent",
    en: "Connect a Harness to an Agent",
    ja: "Harness を Agent に接続",
  },
  "Harness 管理": {
    "zh-TW": "Harness 管理",
    en: "Manage Harnesses",
    ja: "Harness の管理",
  },
  开始一个会话: {
    "zh-TW": "開始對話",
    en: "Start a conversation",
    ja: "会話を開始",
  },
  开始: {
    "zh-TW": "開始",
    en: "Get started",
    ja: "始める",
  },
  欢迎使用团团: {
    "zh-TW": "歡迎使用團團",
    en: "Welcome to Tuantuan",
    ja: "Tuantuan へようこそ",
  },
  选择一个会话: {
    "zh-TW": "選擇一個對話",
    en: "Select a conversation",
    ja: "会話を選択",
  },
  "找不到{what}": {
    "zh-TW": "找不到{what}",
    en: "{what} not found",
    ja: "{what}が見つかりません",
  },
  "它可能已被删除。": {
    "zh-TW": "它可能已被刪除。",
    en: "It may have been deleted.",
    ja: "削除された可能性があります。",
  },
  返回列表: {
    "zh-TW": "返回清單",
    en: "Back to list",
    ja: "一覧に戻る",
  },
  操作: {
    "zh-TW": "操作",
    en: "Action",
    ja: "操作",
  },
  快速切换: {
    "zh-TW": "快速切換",
    en: "Quick switcher",
    ja: "クイック切り替え",
  },
  "搜索会话、Agent 或操作…": {
    "zh-TW": "搜尋對話、Agent 或操作…",
    en: "Search conversations, Agents, or actions…",
    ja: "会話、Agent、操作を検索…",
  },
  没有匹配的结果: {
    "zh-TW": "沒有符合的結果",
    en: "No matching results",
    ja: "一致する結果はありません",
  },
  选择: {
    "zh-TW": "選擇",
    en: "Select",
    ja: "選択",
  },
  打开: {
    "zh-TW": "開啟",
    en: "Open",
    ja: "開く",
  },
  关闭: {
    "zh-TW": "關閉",
    en: "Close",
    ja: "閉じる",
  },
  "保存中…": {
    "zh-TW": "儲存中…",
    en: "Saving…",
    ja: "保存中…",
  },
  已保存: {
    "zh-TW": "已儲存",
    en: "Saved",
    ja: "保存済み",
  },
  "保存失败：{error}": {
    "zh-TW": "儲存失敗：{error}",
    en: "Could not save: {error}",
    ja: "保存に失敗しました：{error}",
  },
  显示名: {
    "zh-TW": "顯示名稱",
    en: "Display name",
    ja: "表示名",
  },
  "显示在你自己的消息上。": {
    "zh-TW": "顯示在你自己的訊息上。",
    en: "Shown on your messages.",
    ja: "自分のメッセージに表示されます。",
  },
  关于我: {
    "zh-TW": "關於我",
    en: "About me",
    ja: "自分について",
  },
  "你的角色、习惯和想要的回答风格。会附在每个 Agent 的说明里，可在 Agent 编辑页单独关掉。": {
    "zh-TW": "你的角色、習慣和想要的回答風格。會附加到每個 Agent 的說明，可在 Agent 編輯頁個別關閉。",
    en: "Your role, preferences, and preferred response style. Added to each Agent’s instructions; you can disable it per Agent.",
    ja: "役割、好み、希望する回答スタイルを記入します。各 Agent の指示に追加され、Agent ごとに無効化できます。",
  },
  "例如：\n我是前端工程师，主要写 React / TypeScript。\n回答请用中文，先给结论，代码给完整可运行的版本。": {
    "zh-TW":
      "例如：\n我是前端工程師，主要寫 React / TypeScript。\n請用繁體中文回答，先給結論，並提供完整可執行的程式碼。",
    en: "For example:\nI’m a frontend engineer working mainly with React / TypeScript.\nAnswer in English, lead with the conclusion, and provide complete runnable code.",
    ja: "例：\nReact / TypeScript を主に使うフロントエンドエンジニアです。\n日本語で結論から答え、実行可能な完全なコードを示してください。",
  },
  外观: {
    "zh-TW": "外觀",
    en: "Appearance",
    ja: "外観",
  },
  主题: {
    "zh-TW": "主題",
    en: "Theme",
    ja: "テーマ",
  },
  跟随系统: {
    "zh-TW": "跟隨系統",
    en: "System",
    ja: "システムに合わせる",
  },
  浅色: {
    "zh-TW": "淺色",
    en: "Light",
    ja: "ライト",
  },
  深色: {
    "zh-TW": "深色",
    en: "Dark",
    ja: "ダーク",
  },
  强调色: {
    "zh-TW": "強調色",
    en: "Accent color",
    ja: "アクセントカラー",
  },
  默认: {
    "zh-TW": "預設",
    en: "Default",
    ja: "デフォルト",
  },
  时区: {
    "zh-TW": "時區",
    en: "Time zone",
    ja: "タイムゾーン",
  },
  "附在「关于我」里，Agent 说“今天”“明天”时按这个时区算。": {
    "zh-TW": "附加到「關於我」，Agent 提到「今天」「明天」時會使用此時區。",
    en: "Included in “About me” so Agents use this time zone for “today” and “tomorrow.”",
    ja: "「自分について」に追加され、Agent が「今日」「明日」を判断する際に使います。",
  },
  "跟随系统（{timezone}）": {
    "zh-TW": "跟隨系統（{timezone}）",
    en: "System ({timezone})",
    ja: "システムに合わせる（{timezone}）",
  },
  界面语言: {
    "zh-TW": "介面語言",
    en: "Interface language",
    ja: "表示言語",
  },
  "选择后自动保存并切换界面，不改变聊天内容或 Agent 的回答语言。": {
    "zh-TW": "選擇後自動儲存並切換介面，不會變更對話內容或 Agent 的回答語言。",
    en: "Automatically saves and changes the interface language. Your conversations and Agents’ response language stay unchanged.",
    ja: "選択すると自動保存され、表示言語が変わります。会話の内容や Agent の回答言語は変わりません。",
  },
  编辑头像: {
    "zh-TW": "編輯頭像",
    en: "Edit avatar",
    ja: "アバターを編集",
  },
  头像: {
    "zh-TW": "頭像",
    en: "Avatar",
    ja: "アバター",
  },
  重置: {
    "zh-TW": "重設",
    en: "Reset",
    ja: "リセット",
  },
  形状: {
    "zh-TW": "形狀",
    en: "Shape",
    ja: "形状",
  },
  颜色: {
    "zh-TW": "顏色",
    en: "Color",
    ja: "色",
  },
  "颜色 {color}": {
    "zh-TW": "顏色 {color}",
    en: "Color {color}",
    ja: "色 {color}",
  },
  "Bot 头像": {
    "zh-TW": "Bot 頭像",
    en: "Bot avatars",
    ja: "Bot アバター",
  },
  动画: {
    "zh-TW": "動畫",
    en: "Animation",
    ja: "アニメーション",
  },
  跳一下: {
    "zh-TW": "跳一下",
    en: "Bounce",
    ja: "ジャンプ",
  },
  圆球: {
    "zh-TW": "圓球",
    en: "Orb",
    ja: "球",
  },
  云朵: {
    "zh-TW": "雲朵",
    en: "Cloud",
    ja: "雲",
  },
  方块: {
    "zh-TW": "方塊",
    en: "Square",
    ja: "四角",
  },
  星芒: {
    "zh-TW": "星芒",
    en: "Star",
    ja: "星",
  },
  四叶: {
    "zh-TW": "四葉",
    en: "Clover",
    ja: "クローバー",
  },
  豆子: {
    "zh-TW": "豆子",
    en: "Bean",
    ja: "豆",
  },
  花朵: {
    "zh-TW": "花朵",
    en: "Flower",
    ja: "花",
  },
  水滴: {
    "zh-TW": "水滴",
    en: "Drop",
    ja: "しずく",
  },
  胶囊: {
    "zh-TW": "膠囊",
    en: "Capsule",
    ja: "カプセル",
  },
  三角: {
    "zh-TW": "三角",
    en: "Triangle",
    ja: "三角",
  },
  菱形: {
    "zh-TW": "菱形",
    en: "Diamond",
    ja: "ひし形",
  },
  爆炸星: {
    "zh-TW": "爆炸星",
    en: "Burst",
    ja: "バースト",
  },
  六边形: {
    "zh-TW": "六邊形",
    en: "Hexagon",
    ja: "六角形",
  },
  小猫: {
    "zh-TW": "小貓",
    en: "Cat",
    ja: "猫",
  },
  小狗: {
    "zh-TW": "小狗",
    en: "Dog",
    ja: "犬",
  },
  兔子: {
    "zh-TW": "兔子",
    en: "Rabbit",
    ja: "ウサギ",
  },
  熊猫: {
    "zh-TW": "熊貓",
    en: "Panda",
    ja: "パンダ",
  },
  山羊: {
    "zh-TW": "山羊",
    en: "Goat",
    ja: "ヤギ",
  },
  小牛: {
    "zh-TW": "小牛",
    en: "Cow",
    ja: "牛",
  },
  平静: {
    "zh-TW": "平靜",
    en: "Calm",
    ja: "平静",
  },
  开心: {
    "zh-TW": "開心",
    en: "Happy",
    ja: "嬉しい",
  },
  思考: {
    "zh-TW": "思考",
    en: "Thinking",
    ja: "思考中",
  },
  专注: {
    "zh-TW": "專注",
    en: "Focused",
    ja: "集中",
  },
  说话: {
    "zh-TW": "說話",
    en: "Speaking",
    ja: "発話中",
  },
  惊讶: {
    "zh-TW": "驚訝",
    en: "Surprised",
    ja: "驚き",
  },
  难过: {
    "zh-TW": "難過",
    en: "Sad",
    ja: "悲しい",
  },
  休眠: {
    "zh-TW": "休眠",
    en: "Sleeping",
    ja: "休眠",
  },
  草稿: {
    "zh-TW": "草稿",
    en: "Drafts",
    ja: "下書き",
  },
  "想要：{action}": {
    "zh-TW": "想要：{action}",
    en: "Wants to: {action}",
    ja: "実行したい操作：{action}",
  },
  执行操作: {
    "zh-TW": "執行操作",
    en: "perform an action",
    ja: "操作を実行",
  },
} satisfies MessageCatalog;
