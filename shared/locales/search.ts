import type { MessageCatalog } from "./types";

export const searchMessages = {
  "正在加载会话…": { "zh-TW": "正在載入對話…", en: "Loading conversation…", ja: "会話を読み込み中…" },
  "搜索当前会话（⌘F / Ctrl+F）": {
    "zh-TW": "搜尋目前對話（⌘F / Ctrl+F）",
    en: "Search this conversation (⌘F / Ctrl+F)",
    ja: "この会話を検索（⌘F / Ctrl+F）",
  },
  搜索聊天记录: { "zh-TW": "搜尋聊天記錄", en: "Search chat history", ja: "チャット履歴を検索" },
  搜索当前会话: { "zh-TW": "搜尋目前對話", en: "Search this conversation", ja: "この会話を検索" },
  "搜索会话、Agent 或聊天正文…": {
    "zh-TW": "搜尋對話、Agent 或聊天內文…",
    en: "Search conversations, Agents or messages…",
    ja: "会話・Agent・本文を検索…",
  },
  "输入关键词搜索聊天正文…": {
    "zh-TW": "輸入關鍵字搜尋聊天內文…",
    en: "Search message text…",
    ja: "キーワードで本文を検索…",
  },
  清空搜索: { "zh-TW": "清空搜尋", en: "Clear search", ja: "検索をクリア" },
  关闭搜索: { "zh-TW": "關閉搜尋", en: "Close search", ja: "検索を閉じる" },
  搜索范围: { "zh-TW": "搜尋範圍", en: "Search scope", ja: "検索範囲" },
  全部会话: { "zh-TW": "所有對話", en: "All conversations", ja: "すべての会話" },
  当前会话: { "zh-TW": "目前對話", en: "This conversation", ja: "現在の会話" },
  搜索结果: { "zh-TW": "搜尋結果", en: "Search results", ja: "検索結果" },
  聊天正文: { "zh-TW": "聊天內文", en: "Messages", ja: "メッセージ本文" },
  "输入关键词，搜索已保存的聊天正文。": {
    "zh-TW": "輸入關鍵字，搜尋已儲存的聊天內文。",
    en: "Enter a keyword to search saved messages.",
    ja: "キーワードを入力して保存済みの本文を検索します。",
  },
  没有匹配的聊天正文: { "zh-TW": "沒有符合的聊天內文", en: "No matching messages", ja: "一致する本文はありません" },
  "搜索中…": { "zh-TW": "搜尋中…", en: "Searching…", ja: "検索中…" },
  "搜索失败：{reason}": {
    "zh-TW": "搜尋失敗：{reason}",
    en: "Search failed: {reason}",
    ja: "検索に失敗しました：{reason}",
  },
  重试搜索: { "zh-TW": "重試搜尋", en: "Retry search", ja: "再検索" },
  加载更多结果: { "zh-TW": "載入更多結果", en: "Load more results", ja: "さらに読み込む" },
  搜索游标无效: { "zh-TW": "搜尋游標無效", en: "Invalid search cursor", ja: "検索カーソルが無効です" },
  "搜索词最多 200 个字符，且不能包含空字符": {
    "zh-TW": "搜尋詞最多 200 個字元，且不能包含空字元",
    en: "Search text must be at most 200 characters and cannot contain a null character",
    ja: "検索語は200文字以内で、ヌル文字は使用できません",
  },
  搜索会话无效: { "zh-TW": "搜尋對話無效", en: "Invalid conversation filter", ja: "会話の検索条件が無効です" },
  "搜索条数必须是 1 到 100 的整数": {
    "zh-TW": "搜尋筆數必須是 1 到 100 的整數",
    en: "Search limit must be an integer from 1 to 100",
    ja: "検索件数は1から100の整数にしてください",
  },
} satisfies MessageCatalog;
