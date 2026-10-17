/** Landing-page copy. Facts come from README.md and its zh-CN / zh-TW / ja translations only. */
export const LOCALES = ["en", "zh-CN", "zh-TW", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const LANG_NAME: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
};

/** Output folder per locale; English is the site root. */
export const LOCALE_PATH: Record<Locale, string> = { en: "", "zh-CN": "zh-CN/", "zh-TW": "zh-TW/", ja: "ja/" };

/** README for each locale, linked from the footer. */
export const README_FILE: Record<Locale, string> = {
  en: "README.md",
  "zh-CN": "README.zh-CN.md",
  "zh-TW": "README.zh-TW.md",
  ja: "README.ja.md",
};

type Card = { title: string; body: string };

export type Copy = {
  htmlLang: string;
  ogLocale: string;
  title: string;
  description: string;
  name: string;
  nav: { handoff: string; harnesses: string; features: string; start: string; language: string; skip: string };
  hero: { eyebrow: string; tagline: string; sub: string; meta: string };
  download: { mac: string; win: string; linux: string; any: string; notes: string };
  /** First launch of the unnotarized macOS build: Gatekeeper prompt and the way past it. */
  macFirst: {
    summary: string;
    brew: string;
    blocked: string;
    prompt: string;
    steps: [string, string, string];
    fallback: string;
  };
  video: { label: string; full: string; play: string; pause: string; soundOn: string; soundOff: string };
  score: { title: string; sub: string; label: string };
  harness: { title: string; sub: string; registry: string; registryMore: string };
  handoff: {
    title: string;
    sub: string;
    steps: [Card, Card, Card];
    room: string;
    you: string;
    user: string;
    run: string;
    fail: string;
    retry: string;
    stuck: string;
    stuckLabel: string;
    cardTitle: string;
    fields: [string, string][];
    sent: string;
    found: string;
    pass: string;
    returned: string;
    goal: string;
    caption: string;
    replay: string;
    pause: string;
    play: string;
  };
  features: { title: string; sub: string; cards: Card[] };
  start: {
    title: string;
    sub: string;
    open: string;
    mock: string;
    langNote: string | null;
    desktop: string;
    copy: string;
    copied: string;
  };
  footer: {
    trademark: string;
    license: string;
    docs: string;
    releases: string;
    contributing: string;
    security: string;
  };
};

export const COPY: Record<Locale, Copy> = {
  en: {
    htmlLang: "en",
    ogLocale: "en_US",
    title: "Tuantuan — A local workspace for multi-agent collaboration",
    description:
      "Bring Claude Code, Codex, OpenCode, Pi, Grok Build, and MiniMax Code into one project conversation, and hand off work between them with structured context. Open source, over ACP.",
    name: "Tuantuan",
    nav: {
      handoff: "Handoff",
      harnesses: "Harnesses",
      features: "Features",
      start: "Quick start",
      language: "Language",
      skip: "Skip to content",
    },
    hero: {
      eyebrow: "v0.1.1 · Open source",
      tagline: "Your coding agents, one room.",
      sub: "Stop copy-pasting between terminals. Bring Claude Code, Codex, OpenCode, and other coding agents into one project conversation, mention who you need, and watch them work side by side.",
      meta: "Desktop app for macOS, Windows, and Linux. Bring your own harness account or API provider.",
    },
    download: {
      mac: "Download for macOS",
      win: "Download for Windows",
      linux: "Download for Linux",
      any: "Download v0.1.1",
      notes: "Install notes",
    },
    macFirst: {
      summary: "First launch on macOS",
      brew: "With Homebrew, the tap clears the quarantine flag for you, so there is no prompt:",
      blocked: "Tuantuan is not notarized by Apple yet, so the first launch shows:",
      prompt:
        "“Apple could not verify “tuantuan” is free of malware that may harm your Mac or compromise your privacy.”",
      steps: [
        "Move tuantuan.app to Applications, open it once, and click Done.",
        "Open System Settings → Privacy & Security, scroll to Security, and click Open Anyway next to “tuantuan”.",
        "Confirm with your password, then click Open. Later launches open normally.",
      ],
      fallback: "Still blocked, or told the app is damaged? Run this in Terminal, then open it again:",
    },
    video: {
      label: "Tuantuan promo video: Six Windows",
      full: "Watch the full video",
      play: "Play video",
      pause: "Pause video",
      soundOn: "Turn sound on",
      soundOff: "Mute",
    },
    score: {
      title: "Hear a session",
      sub: "Session Score turns a staged session into music: every reply, tool call, diff, and permission request plays a note.",
      label: "Session Score promo video",
    },
    harness: {
      title: "Works with the agents you use",
      sub: "Tuantuan connects coding harnesses through the Agent Client Protocol. Add more from the ACP Registry.",
      registry: "ACP Registry",
      registryMore: "More agents",
    },
    handoff: {
      title: "Stuck? Hand it off.",
      sub: "Each agent keeps its own session. A handoff carries what the next one needs.",
      steps: [
        { title: "A gets stuck", body: "Claude Code reruns the failing test and stops making progress." },
        { title: "Structured handoff", body: "Task, goal, decisions, and pending work go to Codex." },
        { title: "B returns the diff", body: "Codex fixes it and returns the result to the same conversation." },
      ],
      room: "Fix login timeout",
      you: "You",
      user: "Fix the login timeout. Keep the tests green.",
      run: "Run bun test auth",
      fail: "2 failed · TimeoutError",
      retry: "Retry with a longer timeout",
      stuck: "Tried 3 approaches. Still timing out. Handing off to",
      stuckLabel: "Stuck",
      cardTitle: "Handoff",
      fields: [
        ["Task", "Fix the login timeout"],
        ["Goal", "auth tests pass"],
        ["Decisions", "Keep the refresh API"],
        ["Pending", "Concurrent refresh is untested"],
      ],
      sent: "Handed off with 4 fields",
      found: "Found it: two token refreshes race. One shared request fixes it.",
      pass: "12 passed",
      returned: "Result returned to Claude Code",
      goal: "Goal",
      caption: "Illustration of a handoff.",
      replay: "Replay",
      pause: "Pause",
      play: "Play",
    },
    features: {
      title: "Built for working with several agents",
      sub: "Everything below is in v0.1.1.",
      cards: [
        {
          title: "Choose your harness",
          body: "Use a local installation or install agents from the ACP Registry. Sign in the way each harness supports.",
        },
        {
          title: "Work as a team",
          body: "Mention members with @, or let a lead agent delegate, follow up, and bring results together.",
        },
        {
          title: "Hand off with context",
          body: "Handoffs carry the task, goal, decisions, and pending work. Each agent keeps its own session.",
        },
        {
          title: "Keep native workflows",
          body: "Native prompts and context management. Model, permission, reasoning, and slash-command controls come from each harness.",
        },
        {
          title: "See the work",
          body: "Streaming replies, tool calls, diffs, terminal output, plans, and permission requests. Stop any task.",
        },
        {
          title: "Bring your setup",
          body: "Your API providers, local Skills, and Claude plugins. Tuantuan never rewrites ~/.claude or ~/.codex.",
        },
      ],
    },
    start: {
      title: "Run from source",
      sub: "Requires Bun 1.4.2, the version used in CI.",
      open: "Open http://localhost:5173 and follow the first-run guide.",
      mock: "No harness login? Try simulated replies:",
      langNote: "The app starts in Simplified Chinese. Switch in 设置 → 个人资料 → 界面语言.",
      desktop: "Build the desktop app",
      copy: "Copy",
      copied: "Copied",
    },
    footer: {
      trademark:
        "Vendor logos identify the corresponding providers. Trademarks belong to their respective owners; Tuantuan is not affiliated with or endorsed by them.",
      license: "MIT License",
      docs: "Docs",
      releases: "Releases",
      contributing: "Contributing",
      security: "Security",
    },
  },
  "zh-CN": {
    htmlLang: "zh-CN",
    ogLocale: "zh_CN",
    title: "团团 Tuantuan — 本机多 Agent 协作工作台",
    description:
      "把 Claude Code、Codex、OpenCode、Pi、Grok Build、MiniMax Code 放进同一个项目会话，用结构化上下文在 Agent 之间交接任务。开源，基于 ACP。",
    name: "团团 Tuantuan",
    nav: {
      handoff: "交接",
      harnesses: "Harness",
      features: "功能",
      start: "快速开始",
      language: "语言",
      skip: "跳到正文",
    },
    hero: {
      eyebrow: "v0.1.1 · 开源",
      tagline: "你的编码 Agent，同在一室。",
      sub: "不用再在一堆终端之间复制粘贴。把 Claude Code、Codex、OpenCode 等编码 Agent 放进同一个项目会话，@ 谁谁就开工，进展实时看得见。",
      meta: "macOS、Windows、Linux 桌面版。使用你自己的 Harness 账号或 API 服务商。",
    },
    download: {
      mac: "下载 macOS 版",
      win: "下载 Windows 版",
      linux: "下载 Linux 版",
      any: "下载 v0.1.1",
      notes: "安装说明",
    },
    macFirst: {
      summary: "macOS 首次打开",
      brew: "用 Homebrew 安装时，tap 会自动清除隔离标记，不会出现拦截：",
      blocked: "团团暂未经过 Apple 公证，第一次打开会提示：",
      prompt: "“Apple无法验证“tuantuan”是否包含可能危害Mac安全或泄漏隐私的恶意软件。”",
      steps: [
        "把 tuantuan.app 移到「应用程序」，打开一次，在提示里点「完成」。",
        "打开「系统设置 → 隐私与安全性」，滚动到「安全性」，在“tuantuan”旁点「仍要打开」。",
        "输入密码确认后点「打开」。之后即可正常启动。",
      ],
      fallback: "仍然打不开或提示“已损坏”？在「终端」执行下面的命令后再打开：",
    },
    video: {
      label: "团团宣传片：六个窗口",
      full: "观看完整版",
      play: "播放视频",
      pause: "暂停视频",
      soundOn: "打开声音",
      soundOff: "静音",
    },
    score: {
      title: "听一段会话",
      sub: "Session Score 把一段演示会话变成音乐：每条回复、工具调用、diff 和权限请求都是一个音符。",
      label: "Session Score 宣传片",
    },
    harness: {
      title: "接入你在用的 Agent",
      sub: "团团通过 Agent Client Protocol 连接编码 Harness，也可从 ACP Registry 安装更多。",
      registry: "ACP Registry",
      registryMore: "更多 Agent",
    },
    handoff: {
      title: "卡住了？交出去。",
      sub: "每名 Agent 保留自己的会话，交接只带上下一位需要的内容。",
      steps: [
        { title: "A 卡住了", body: "Claude Code 反复重跑失败的测试，没有进展。" },
        { title: "结构化交接", body: "任务、目标、关键决策和未完成事项一起交给 Codex。" },
        { title: "B 交回 diff", body: "Codex 修好后，把结果交回同一个会话。" },
      ],
      room: "修复登录超时",
      you: "你",
      user: "修复登录超时，测试保持全绿。",
      run: "运行 bun test auth",
      fail: "2 项失败 · TimeoutError",
      retry: "调长超时后重试",
      stuck: "试了 3 种方案，还是超时。交给",
      stuckLabel: "卡住了",
      cardTitle: "交接",
      fields: [
        ["任务", "修复登录超时"],
        ["目标", "auth 测试全部通过"],
        ["决策", "不改刷新接口"],
        ["未完成", "并发刷新没有测试"],
      ],
      sent: "已交接 · 带上 4 项上下文",
      found: "找到了：两次 token 刷新在竞争，合并成一个共享请求即可。",
      pass: "12 项通过",
      returned: "结果已交回 Claude Code",
      goal: "目标",
      caption: "交接流程示意。",
      replay: "重播",
      pause: "暂停",
      play: "播放",
    },
    features: {
      title: "为多 Agent 协作而做",
      sub: "以下功能均已在 v0.1.1 中提供。",
      cards: [
        { title: "选择 Harness", body: "沿用本机已有安装，或从 ACP Registry 安装 Agent，按 Harness 提供的方式登录。" },
        { title: "多 Agent 协作", body: "用 @ 指定成员，或由主 Agent 分工、跟进、汇总。所有成员共用项目工作目录。" },
        { title: "带上下文交接", body: "交接携带任务、目标、关键决策和未完成事项。每名 Agent 保留自己的会话。" },
        { title: "保留原生能力", body: "沿用原生提示词与上下文管理。模型、权限、推理和斜杠命令选项来自各 Harness。" },
        { title: "完整呈现过程", body: "流式回复、工具调用、diff、终端输出、计划和权限请求，可单独停止任务。" },
        {
          title: "沿用本机配置",
          body: "自定义 API 服务商、本机 Skills 和 Claude 插件。团团不改写 ~/.claude 或 ~/.codex。",
        },
      ],
    },
    start: {
      title: "从源码运行",
      sub: "需要 Bun 1.4.2，与 CI 保持一致。",
      open: "打开 http://localhost:5173，按首次引导完成设置。",
      mock: "不想登录 Harness？先用模拟回复体验：",
      langNote: null,
      desktop: "构建桌面版",
      copy: "复制",
      copied: "已复制",
    },
    footer: {
      trademark: "厂商 Logo 仅用于标识对应服务商。商标归各自所有者所有，团团与这些公司没有关联，也未获其背书。",
      license: "MIT 许可证",
      docs: "文档",
      releases: "版本",
      contributing: "参与贡献",
      security: "安全",
    },
  },
  "zh-TW": {
    htmlLang: "zh-TW",
    ogLocale: "zh_TW",
    title: "團團 Tuantuan — 讓多個 Agent 在本機協作的工作台",
    description:
      "將 Claude Code、Codex、OpenCode、Pi、Grok Build、MiniMax Code 放進同一段專案對話，以結構化脈絡在 Agent 之間交接任務。開源，基於 ACP。",
    name: "團團 Tuantuan",
    nav: {
      handoff: "交接",
      harnesses: "Harness",
      features: "功能",
      start: "快速開始",
      language: "語言",
      skip: "跳到主要內容",
    },
    hero: {
      eyebrow: "v0.1.1 · 開源",
      tagline: "你的程式開發 Agent，同在一室。",
      sub: "不用再在一堆終端機之間複製貼上。把 Claude Code、Codex、OpenCode 等程式開發 Agent 放進同一段專案對話，@ 誰誰就動手，進度即時看得見。",
      meta: "macOS、Windows、Linux 桌面版。使用你自己的 Harness 帳號或 API 服務商。",
    },
    download: {
      mac: "下載 macOS 版",
      win: "下載 Windows 版",
      linux: "下載 Linux 版",
      any: "下載 v0.1.1",
      notes: "安裝說明",
    },
    macFirst: {
      summary: "macOS 首次開啟",
      brew: "用 Homebrew 安裝時，tap 會自動清除隔離標記，不會出現攔截：",
      blocked: "團團尚未經過 Apple 公證，第一次開啟會提示：",
      prompt: "「Apple 無法驗證“tuantuan”是否包含可能危害 Mac 安全或洩漏隱私的惡意軟體。」",
      steps: [
        "將 tuantuan.app 移到「應用程式」，開啟一次，在提示中點「完成」。",
        "開啟「系統設定 → 隱私權與安全性」，捲動到「安全性」，在“tuantuan”旁點「強制打開」。",
        "輸入密碼確認後點「打開」。之後即可正常啟動。",
      ],
      fallback: "仍然打不開或提示「已損毀」？在「終端機」執行下面的指令後再開啟：",
    },
    video: {
      label: "團團宣傳影片：六個視窗",
      full: "觀看完整版",
      play: "播放影片",
      pause: "暫停影片",
      soundOn: "開啟聲音",
      soundOff: "靜音",
    },
    score: {
      title: "聽一段對話",
      sub: "Session Score 把一段示範對話變成音樂：每則回覆、工具呼叫、diff 和權限請求都是一個音符。",
      label: "Session Score 宣傳影片",
    },
    harness: {
      title: "接入你正在用的 Agent",
      sub: "團團透過 Agent Client Protocol 連接程式開發 Harness，也可從 ACP Registry 安裝更多。",
      registry: "ACP Registry",
      registryMore: "更多 Agent",
    },
    handoff: {
      title: "卡住了？交出去。",
      sub: "每名 Agent 保留自己的工作階段，交接只帶上下一位需要的內容。",
      steps: [
        { title: "A 卡住了", body: "Claude Code 反覆重跑失敗的測試，沒有進展。" },
        { title: "結構化交接", body: "任務、目標、重要決策與待辦事項一起交給 Codex。" },
        { title: "B 交回 diff", body: "Codex 修好後，把結果交回同一段對話。" },
      ],
      room: "修復登入逾時",
      you: "你",
      user: "修復登入逾時，測試維持全綠。",
      run: "執行 bun test auth",
      fail: "2 項失敗 · TimeoutError",
      retry: "調長逾時後重試",
      stuck: "試了 3 種方案，還是逾時。交給",
      stuckLabel: "卡住了",
      cardTitle: "交接",
      fields: [
        ["任務", "修復登入逾時"],
        ["目標", "auth 測試全部通過"],
        ["決策", "不改更新介面"],
        ["待辦", "並行更新尚無測試"],
      ],
      sent: "已交接 · 附上 4 項脈絡",
      found: "找到了：兩次 token 更新互相競爭，合併成一個共用請求即可。",
      pass: "12 項通過",
      returned: "結果已交回 Claude Code",
      goal: "目標",
      caption: "交接流程示意。",
      replay: "重播",
      pause: "暫停",
      play: "播放",
    },
    features: {
      title: "為多 Agent 協作打造",
      sub: "以下功能皆已在 v0.1.1 提供。",
      cards: [
        { title: "選擇 Harness", body: "沿用本機既有安裝，或從 ACP Registry 安裝 Agent，依 Harness 提供的方式登入。" },
        {
          title: "多 Agent 協作",
          body: "用 @ 指定成員，或由主 Agent 分工、跟進並彙整結果。所有成員共用專案工作目錄。",
        },
        { title: "帶著脈絡交接", body: "交接包含任務、目標、重要決策與待辦事項。每名 Agent 保留自己的工作階段。" },
        { title: "保留原生能力", body: "沿用原生提示詞與脈絡管理。模型、權限、推理與斜線指令選項來自各 Harness。" },
        { title: "看見完整過程", body: "串流回覆、工具呼叫、diff、終端輸出、計畫與權限請求，也可個別停止任務。" },
        {
          title: "沿用本機設定",
          body: "自訂 API 服務商、本機 Skills 與 Claude 外掛程式。團團不會改寫 ~/.claude 或 ~/.codex。",
        },
      ],
    },
    start: {
      title: "從原始碼執行",
      sub: "需要 Bun 1.4.2，與 CI 使用相同版本。",
      open: "開啟 http://localhost:5173，依首次使用的引導完成設定。",
      mock: "不想登入 Harness？先用模擬回覆體驗：",
      langNote: "預設介面為簡體中文，可在 设置 → 个人资料 → 界面语言 切換為繁體中文。",
      desktop: "建置桌面版",
      copy: "複製",
      copied: "已複製",
    },
    footer: {
      trademark: "廠商 Logo 僅用於識別對應的服務商。商標歸各自擁有者所有，團團與這些公司沒有關聯，也未獲其背書。",
      license: "MIT 授權",
      docs: "文件",
      releases: "版本",
      contributing: "參與貢獻",
      security: "安全",
    },
  },
  ja: {
    htmlLang: "ja",
    ogLocale: "ja_JP",
    title: "Tuantuan — 複数のエージェントがローカルで協力するワークスペース",
    description:
      "Claude Code、Codex、OpenCode、Pi、Grok Build、MiniMax Code を 1 つのプロジェクト会話に集め、構造化されたコンテキストでエージェント間の引き継ぎができます。オープンソース、ACP 対応。",
    name: "Tuantuan",
    nav: {
      handoff: "引き継ぎ",
      harnesses: "ハーネス",
      features: "機能",
      start: "クイックスタート",
      language: "言語",
      skip: "本文へ移動",
    },
    hero: {
      eyebrow: "v0.1.1 · オープンソース",
      tagline: "コーディングエージェントを、ひとつの部屋に。",
      sub: "ターミナル間のコピペはもう要りません。Claude Code、Codex、OpenCode などのコーディングエージェントを 1 つのプロジェクト会話に集め、@ で呼べばすぐに作業開始。進み具合はその場で確認できます。",
      meta: "macOS、Windows、Linux 向けデスクトップアプリ。ハーネスのアカウントや API プロバイダーはご自身のものを使います。",
    },
    download: {
      mac: "macOS 版をダウンロード",
      win: "Windows 版をダウンロード",
      linux: "Linux 版をダウンロード",
      any: "v0.1.1 をダウンロード",
      notes: "インストールの説明",
    },
    macFirst: {
      summary: "macOS で初めて開くとき",
      brew: "Homebrew でインストールすると、tap が隔離属性を自動で外すため警告は出ません：",
      blocked: "Tuantuan はまだ Apple の公証を受けていないため、初回起動時に次の警告が出ます：",
      prompt:
        "「Apple は、“tuantuan”に Mac に損害を与えたり、プライバシーを侵害したりする可能性のあるマルウェアが含まれていないことを検証できませんでした。」",
      steps: [
        "tuantuan.app を「アプリケーション」に移して一度開き、「完了」をクリックします。",
        "「システム設定 → プライバシーとセキュリティ」を開き、「セキュリティ」までスクロールして “tuantuan” の横の「このまま開く」をクリックします。",
        "パスワードで確認して「開く」をクリックします。以降は普通に起動できます。",
      ],
      fallback:
        "それでも開けない、または「壊れている」と表示される場合は、ターミナルで次を実行してから開き直してください：",
    },
    video: {
      label: "Tuantuan の紹介動画：Six Windows",
      full: "フルバージョンを見る",
      play: "動画を再生",
      pause: "動画を一時停止",
      soundOn: "音声をオン",
      soundOff: "ミュート",
    },
    score: {
      title: "セッションを聴く",
      sub: "Session Score は演出用のセッションを音楽に変えます。返信、ツール呼び出し、diff、権限リクエストのひとつひとつが音になります。",
      label: "Session Score の紹介動画",
    },
    harness: {
      title: "使い慣れたエージェントをそのまま",
      sub: "Tuantuan は Agent Client Protocol でハーネスに接続します。ACP Registry から追加もできます。",
      registry: "ACP Registry",
      registryMore: "その他のエージェント",
    },
    handoff: {
      title: "詰まったら、引き継ぐ。",
      sub: "各エージェントは独自のセッションを保ち、引き継ぎでは次に必要な情報を渡します。",
      steps: [
        { title: "A が行き詰まる", body: "Claude Code が失敗するテストを繰り返し、先に進めません。" },
        { title: "構造化された引き継ぎ", body: "タスク、目標、決定事項、残作業を Codex に渡します。" },
        { title: "B が diff を返す", body: "Codex が修正し、結果を同じ会話に返します。" },
      ],
      room: "ログインのタイムアウトを修正",
      you: "あなた",
      user: "ログインのタイムアウトを直して。テストは通したままで。",
      run: "bun test auth を実行",
      fail: "2 件失敗 · TimeoutError",
      retry: "タイムアウトを延ばして再試行",
      stuck: "3 通り試しましたが、まだタイムアウトします。引き継ぎ先：",
      stuckLabel: "行き詰まり",
      cardTitle: "引き継ぎ",
      fields: [
        ["タスク", "ログインのタイムアウトを修正"],
        ["目標", "auth テストをすべて通す"],
        ["決定事項", "refresh API は変えない"],
        ["残作業", "同時 refresh のテストがない"],
      ],
      sent: "引き継ぎ済み · 4 項目",
      found: "原因は 2 つのトークン更新の競合でした。共有リクエスト 1 つにまとめれば解決します。",
      pass: "12 件成功",
      returned: "結果を Claude Code に返却",
      goal: "目標",
      caption: "引き継ぎの流れのイメージです。",
      replay: "もう一度",
      pause: "一時停止",
      play: "再生",
    },
    features: {
      title: "複数のエージェントで働くために",
      sub: "以下はすべて v0.1.1 で利用できます。",
      cards: [
        {
          title: "ハーネスを選択",
          body: "インストール済みのものを使うか、ACP Registry から追加。ログインは各ハーネスの方法に従います。",
        },
        {
          title: "チームで作業",
          body: "@ でメンバーを指定するか、リードエージェントに分担、進捗確認、取りまとめを任せます。",
        },
        {
          title: "コンテキストごと引き継ぐ",
          body: "タスク、目標、決定事項、残作業を引き継ぎます。各エージェントは独自のセッションを保ちます。",
        },
        {
          title: "本来の機能をそのまま",
          body: "ハーネス本来のプロンプトとコンテキスト管理を使用。モデル、権限、推論、スラッシュコマンドは各ハーネスが提供します。",
        },
        {
          title: "作業の過程が見える",
          body: "ストリーミング応答、ツール呼び出し、diff、ターミナル出力、計画、権限の承認要求。タスクは個別に停止できます。",
        },
        {
          title: "既存の環境を活かす",
          body: "独自の API プロバイダー、ローカルの Skills、Claude プラグイン。~/.claude や ~/.codex は書き換えません。",
        },
      ],
    },
    start: {
      title: "ソースから起動",
      sub: "CI と同じ Bun 1.4.2 が必要です。",
      open: "http://localhost:5173 を開き、初回ガイドに沿って設定します。",
      mock: "ログインせずに試すなら、模擬応答で起動：",
      langNote: "初期表示は簡体字中国語です。设置 → 个人资料 → 界面语言 で日本語に切り替えられます。",
      desktop: "デスクトップアプリをビルド",
      copy: "コピー",
      copied: "コピーしました",
    },
    footer: {
      trademark:
        "ロゴは対応するプロバイダーを識別するためのものです。商標は各権利者に帰属し、Tuantuan と各社に提携関係はなく、推奨を受けたものでもありません。",
      license: "MIT ライセンス",
      docs: "ドキュメント",
      releases: "リリース",
      contributing: "コントリビュート",
      security: "セキュリティ",
    },
  },
};
