import type { MessageCatalog } from "./types";

export const fileMessages = {
  会话文件: { "zh-TW": "對話檔案", en: "Conversation files", ja: "会話のファイル" },
  关闭会话文件: { "zh-TW": "關閉對話檔案", en: "Close conversation files", ja: "会話のファイルを閉じる" },
  刷新文件列表: { "zh-TW": "重新整理檔案列表", en: "Refresh files", ja: "ファイル一覧を更新" },
  会话文件列表: { "zh-TW": "對話檔案列表", en: "Conversation file list", ja: "会話のファイル一覧" },
  "用户上传的附件与 Agent 明确引用的文件，最新的在前。": {
    "zh-TW": "使用者上傳的附件與 Agent 明確引用的檔案，最新的在前。",
    en: "Uploaded attachments and files explicitly referenced by Agents, newest first.",
    ja: "アップロードした添付ファイルとAgentが明示的に参照したファイルを新しい順に表示します。",
  },
  用户附件: { "zh-TW": "使用者附件", en: "Attachment", ja: "添付ファイル" },
  "附件保留发送时的原件，项目文件下载当前内容。": {
    "zh-TW": "附件保留傳送時的原件，專案檔案下載目前內容。",
    en: "Attachments keep the original sent bytes. Project files download their current contents.",
    ja: "添付ファイルは送信時の原本を保持します。プロジェクトファイルは現在の内容をダウンロードします。",
  },
  "Agent 文件": { "zh-TW": "Agent 檔案", en: "Agent file", ja: "Agentのファイル" },
  大小未知: { "zh-TW": "大小未知", en: "Size unknown", ja: "サイズ不明" },
  文件已不存在: { "zh-TW": "檔案已不存在", en: "File no longer exists", ja: "ファイルは削除されています" },
  "文件超过 100 MiB 下载上限": {
    "zh-TW": "檔案超過 100 MiB 下載上限",
    en: "File exceeds the 100 MiB download limit",
    ja: "ファイルがダウンロード上限の100 MiBを超えています",
  },
  "文件不可用：位于工作区外或无法读取": {
    "zh-TW": "檔案無法使用：位於工作區外或無法讀取",
    en: "Unavailable: outside the workspace or unreadable",
    ja: "利用できません：ワークスペース外、または読み取り不可",
  },
  "预览图片 {name}": { "zh-TW": "預覽圖片 {name}", en: "Preview image {name}", ja: "画像をプレビュー {name}" },
  "下载文件 {name}": { "zh-TW": "下載檔案 {name}", en: "Download file {name}", ja: "ファイルをダウンロード {name}" },
  下载: { "zh-TW": "下載", en: "Download", ja: "ダウンロード" },
  预览: { "zh-TW": "預覽", en: "Preview", ja: "プレビュー" },
  查看来源消息: { "zh-TW": "查看來源訊息", en: "View source message", ja: "元のメッセージを見る" },
  "预览失败：{reason}": {
    "zh-TW": "預覽失敗：{reason}",
    en: "Preview failed: {reason}",
    ja: "プレビューに失敗しました：{reason}",
  },
  "下载失败：{reason}": {
    "zh-TW": "下載失敗：{reason}",
    en: "Download failed: {reason}",
    ja: "ダウンロードに失敗しました：{reason}",
  },
  还没有会话文件: { "zh-TW": "尚無對話檔案", en: "No conversation files yet", ja: "会話のファイルはまだありません" },
  "发送附件后，或 Agent 在回复中引用文件后，可在这里查看。": {
    "zh-TW": "傳送附件後，或 Agent 在回覆中引用檔案後，可在此查看。",
    en: "Attachments you send and files referenced in Agent replies will appear here.",
    ja: "送信した添付ファイルやAgentの返信で参照されたファイルがここに表示されます。",
  },
  "正在加载文件…": { "zh-TW": "正在載入檔案…", en: "Loading files…", ja: "ファイルを読み込み中…" },
  "文件列表加载失败：{reason}": {
    "zh-TW": "檔案列表載入失敗：{reason}",
    en: "Could not load files: {reason}",
    ja: "ファイル一覧を読み込めませんでした：{reason}",
  },
  加载更早的文件: { "zh-TW": "載入更早的檔案", en: "Load older files", ja: "以前のファイルを読み込む" },
  继续加载以查看更早的文件: {
    "zh-TW": "繼續載入以查看更早的檔案",
    en: "Continue loading to look for older files",
    ja: "さらに読み込んで以前のファイルを探す",
  },
  "已加载 {count} 个文件": {
    "zh-TW": "已載入 {count} 個檔案",
    en: "{count} files loaded",
    ja: "{count}件のファイルを読み込み済み",
  },
  "已开始下载 {name}": {
    "zh-TW": "已開始下載 {name}",
    en: "Download started: {name}",
    ja: "ダウンロードを開始しました：{name}",
  },
  文件下载地址无效: {
    "zh-TW": "檔案下載網址無效",
    en: "Invalid file download URL",
    ja: "ファイルのダウンロードURLが無効です",
  },
  此文件不支持图片预览: {
    "zh-TW": "此檔案不支援圖片預覽",
    en: "Image preview is not supported for this file",
    ja: "このファイルは画像プレビューに対応していません",
  },
} satisfies MessageCatalog;
