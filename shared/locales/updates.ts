import type { MessageCatalog } from "./types";

export const updateMessages: MessageCatalog = {
  "正在恢复上次的工作…": {
    "zh-TW": "正在恢復上次的工作…",
    en: "Restoring your previous work…",
    ja: "前回の作業を復元中…",
  },
  "无法恢复上次的工作：{error}": {
    "zh-TW": "無法恢復上次的工作：{error}",
    en: "Couldn’t restore your previous work: {error}",
    ja: "前回の作業を復元できませんでした：{error}",
  },
  "聊天工作尚未保存：{error}": {
    "zh-TW": "聊天工作尚未儲存：{error}",
    en: "Your chat work hasn’t been saved: {error}",
    ja: "チャットの作業を保存できていません：{error}",
  },
  "正在保存工作并退出…": {
    "zh-TW": "正在儲存工作並退出…",
    en: "Saving your work and quitting…",
    ja: "作業を保存して終了中…",
  },
  无法保存当前工作: {
    "zh-TW": "無法儲存目前工作",
    en: "Couldn’t save your work",
    ja: "現在の作業を保存できませんでした",
  },
  "保存工作失败，退出已暂停。": {
    "zh-TW": "儲存工作失敗，退出已暫停。",
    en: "Couldn’t save your work. Quitting is paused.",
    ja: "作業を保存できなかったため、終了を中止しました。",
  },
  继续编辑: { "zh-TW": "繼續編輯", en: "Continue editing", ja: "編集を続ける" },
  "团团尚未准备好保存工作，请稍后重试": {
    "zh-TW": "團團尚未準備好儲存工作，請稍後重試",
    en: "Tuantuan is not ready to save your work. Please retry shortly.",
    ja: "団団はまだ作業を保存できません。しばらくしてから再試行してください。",
  },
  请打开团团窗口后重试保存: {
    "zh-TW": "請開啟團團視窗後重試儲存",
    en: "Open the Tuantuan window and retry saving.",
    ja: "団団のウインドウを開いて保存を再試行してください。",
  },
  "正在保存当前工作，请稍后重试": {
    "zh-TW": "正在儲存目前工作，請稍後重試",
    en: "Your work is being saved. Please retry shortly.",
    ja: "作業を保存中です。しばらくしてから再試行してください。",
  },
  "保存当前工作超时，请重试": {
    "zh-TW": "儲存目前工作逾時，請重試",
    en: "Saving your work timed out. Please retry.",
    ja: "作業の保存がタイムアウトしました。再試行してください。",
  },
  "保存请求已过期，请重试": {
    "zh-TW": "儲存請求已過期，請重試",
    en: "The save request expired. Please retry.",
    ja: "保存リクエストの有効期限が切れました。再試行してください。",
  },
  "更新保存已取消，请重试": {
    "zh-TW": "更新儲存已取消，請重試",
    en: "Saving for the update was cancelled. Please retry.",
    ja: "更新前の保存をキャンセルしました。再試行してください。",
  },
  "团团正在保存工作并退出，请稍后重试": {
    "zh-TW": "團團正在儲存工作並退出，請稍後重試",
    en: "Tuantuan is saving your work and quitting. Please retry later.",
    ja: "団団は作業を保存して終了中です。後で再試行してください。",
  },

  "正在恢复更新前的工作…": {
    "zh-TW": "正在恢復更新前的工作…",
    en: "Restoring your work from before the update…",
    ja: "更新前の作業を復元中…",
  },
  "无法恢复更新前的工作：{error}": {
    "zh-TW": "無法恢復更新前的工作：{error}",
    en: "Couldn’t restore your work from before the update: {error}",
    ja: "更新前の作業を復元できませんでした：{error}",
  },
  "聊天草稿中的附件过大，无法保存更新前的工作。请减少附件后重试。": {
    "zh-TW": "聊天草稿中的附件過大，無法儲存更新前的工作。請減少附件後重試。",
    en: "Attachments in your chat drafts are too large to save before updating. Remove some attachments and retry.",
    ja: "チャットの下書き添付ファイルが大きすぎるため、更新前の作業を保存できません。添付ファイルを減らして再試行してください。",
  },
  有可用更新: { "zh-TW": "有可用更新", en: "Update available", ja: "更新を利用できます" },
  关于与更新: {
    "zh-TW": "關於與更新",
    en: "About & updates",
    ja: "アプリについて・更新",
  },
  "当前版本 {version}": {
    "zh-TW": "目前版本 {version}",
    en: "Current version {version}",
    ja: "現在のバージョン {version}",
  },
  "应用更新仅桌面版支持。浏览器使用当前服务提供的版本。": {
    "zh-TW": "應用程式更新僅桌面版支援。瀏覽器使用目前服務提供的版本。",
    en: "App updates are available in the desktop app. The browser uses the version provided by the current server.",
    ja: "アプリの更新はデスクトップ版で利用できます。ブラウザでは現在のサーバーのバージョンを使用します。",
  },
  "开发版不提供应用更新。": {
    "zh-TW": "開發版不提供應用程式更新。",
    en: "App updates are unavailable in development builds.",
    ja: "開発版ではアプリの更新を利用できません。",
  },
  "此版本已停用应用更新。": {
    "zh-TW": "此版本已停用應用程式更新。",
    en: "App updates are disabled in this build.",
    ja: "このバージョンではアプリの更新が無効です。",
  },
  "通过 Homebrew 安装，请在终端运行以下命令升级。": {
    "zh-TW": "透過 Homebrew 安裝，請在終端機執行以下命令升級。",
    en: "Installed with Homebrew. Run this command in your terminal to update.",
    ja: "Homebrew でインストールされています。ターミナルで次のコマンドを実行して更新してください。",
  },
  "此安装方式需要手动更新。检查新版本后，可打开下载页面安装。": {
    "zh-TW": "此安裝方式需要手動更新。檢查新版本後，可開啟下載頁面安裝。",
    en: "This installation requires a manual update. Check for a new version, then open the download page to install it.",
    ja: "このインストールでは手動での更新が必要です。新しいバージョンを確認し、ダウンロードページからインストールできます。",
  },
  已是最新版本: {
    "zh-TW": "已是最新版本",
    en: "You’re up to date",
    ja: "最新バージョンです",
  },
  "检查是否有新版本可用。": {
    "zh-TW": "檢查是否有新版本可用。",
    en: "Check whether a new version is available.",
    ja: "新しいバージョンがあるか確認できます。",
  },
  "正在检查更新…": {
    "zh-TW": "正在檢查更新…",
    en: "Checking for updates…",
    ja: "更新を確認中…",
  },
  "新版本 {version} 可用": {
    "zh-TW": "新版本 {version} 可用",
    en: "Version {version} is available",
    ja: "バージョン {version} が利用できます",
  },
  "正在下载更新…": {
    "zh-TW": "正在下載更新…",
    en: "Downloading update…",
    ja: "更新をダウンロード中…",
  },
  "更新已下载，可以重启更新。": {
    "zh-TW": "更新已下載，可以重新啟動以更新。",
    en: "The update is downloaded and ready to restart.",
    ja: "更新をダウンロードしました。再起動して更新できます。",
  },
  "正在保存工作并重启…": {
    "zh-TW": "正在儲存工作並重新啟動…",
    en: "Saving your work and restarting…",
    ja: "作業を保存して再起動中…",
  },
  "更新未完成，请重试。": {
    "zh-TW": "更新未完成，請重試。",
    en: "The update did not complete. Please retry.",
    ja: "更新を完了できませんでした。再試行してください。",
  },
  下载进度: {
    "zh-TW": "下載進度",
    en: "Download progress",
    ja: "ダウンロードの進行状況",
  },
  "仍有 {count} 项 Agent 任务，结束后才能重启更新。": {
    "zh-TW": "仍有 {count} 項 Agent 任務，結束後才能重新啟動更新。",
    en: "There are {count} Agent tasks still running. You can restart to update after they finish.",
    ja: "Agent のタスクが {count} 件実行中です。終了後に再起動して更新できます。",
  },
  "无法确认 Agent 任务状态，恢复连接后才能重启更新。": {
    "zh-TW": "無法確認 Agent 任務狀態，恢復連線後才能重新啟動更新。",
    en: "Agent task status is unavailable. Reconnect before restarting to update.",
    ja: "Agent のタスク状況を確認できません。接続の復旧後に再起動して更新できます。",
  },
  "重启前会保存聊天草稿、引用和阅读位置。": {
    "zh-TW": "重新啟動前會儲存聊天草稿、引用和閱讀位置。",
    en: "Chat drafts, quotes, and reading positions will be saved before restarting.",
    ja: "再起動前にチャットの下書き、引用、閲覧位置を保存します。",
  },
  检查更新: {
    "zh-TW": "檢查更新",
    en: "Check for updates",
    ja: "更新を確認",
  },
  下载更新: {
    "zh-TW": "下載更新",
    en: "Download update",
    ja: "更新をダウンロード",
  },
  重启更新: {
    "zh-TW": "重新啟動更新",
    en: "Restart to update",
    ja: "再起動して更新",
  },
  稍后: {
    "zh-TW": "稍後",
    en: "Later",
    ja: "後で",
  },
  打开下载页面: {
    "zh-TW": "開啟下載頁面",
    en: "Open download page",
    ja: "ダウンロードページを開く",
  },
  "上次检查：{time}": {
    "zh-TW": "上次檢查：{time}",
    en: "Last checked: {time}",
    ja: "最終確認：{time}",
  },
  "无法完成更新操作：{error}": {
    "zh-TW": "無法完成更新操作：{error}",
    en: "Couldn’t complete the update: {error}",
    ja: "更新操作を完了できません：{error}",
  },
  自动检查更新: {
    "zh-TW": "自動檢查更新",
    en: "Automatically check for updates",
    ja: "更新を自動確認",
  },
  "后台检查新版本，下载与重启由你决定。": {
    "zh-TW": "在背景檢查新版本，下載與重新啟動由你決定。",
    en: "Checks for new versions in the background. You choose when to download and restart.",
    ja: "バックグラウンドで新しいバージョンを確認します。ダウンロードと再起動は手動で行います。",
  },
  更新说明: {
    "zh-TW": "更新說明",
    en: "Release notes",
    ja: "更新内容",
  },
  无法打开聊天草稿存储: {
    "zh-TW": "無法開啟聊天草稿儲存空間",
    en: "Couldn’t open chat draft storage",
    ja: "チャットの下書き保存領域を開けませんでした",
  },
  "聊天草稿存储被其他窗口占用，请关闭其他窗口后重试。": {
    "zh-TW": "聊天草稿儲存空間被其他視窗佔用，請關閉其他視窗後重試。",
    en: "Chat draft storage is blocked by another window. Close other windows and retry.",
    ja: "別のウインドウが下書き保存領域を使用しています。ほかのウインドウを閉じて再試行してください。",
  },
  无法保存聊天草稿: {
    "zh-TW": "無法儲存聊天草稿",
    en: "Couldn’t save chat drafts",
    ja: "チャットの下書きを保存できませんでした",
  },
  "无法恢复阅读位置，可重试加载历史或回到最新消息。": {
    "zh-TW": "無法恢復閱讀位置，可重試載入歷史或回到最新訊息。",
    en: "Couldn’t restore your reading position. Retry loading history or return to the latest message.",
    ja: "閲覧位置を復元できませんでした。履歴の読み込みを再試行するか、最新のメッセージへ移動してください。",
  },
  "正在恢复聊天草稿…": {
    "zh-TW": "正在恢復聊天草稿…",
    en: "Restoring chat drafts…",
    ja: "チャットの下書きを復元中…",
  },
  "保存工作失败，未重启更新。请重试。": {
    "zh-TW": "儲存工作失敗，未重新啟動更新。請重試。",
    en: "Couldn’t save your work. The app has not restarted to update. Please retry.",
    ja: "作業を保存できなかったため、更新のための再起動を中止しました。再試行してください。",
  },
  "聊天工作尚未保存，重启更新已暂停：{error}": {
    "zh-TW": "聊天工作尚未儲存，重新啟動更新已暫停：{error}",
    en: "Your chat work hasn’t been saved. Restarting to update is paused: {error}",
    ja: "チャットの作業が未保存のため、更新のための再起動を停止しています：{error}",
  },
};
