import type { MessageCatalog } from "./types";

export const attentionMessages = {
  "{count} 项待处理": { "zh-TW": "{count} 項待處理", en: "{count} pending", ja: "{count}件の未対応項目" },
  该请求已处理或已结束: {
    "zh-TW": "此請求已處理或已結束",
    en: "This request has been handled or has ended",
    ja: "このリクエストは対応済み、または終了しています",
  },
  "列表可能已过期，请刷新后再处理": {
    "zh-TW": "清單可能已過期，請重新整理後再處理",
    en: "This list may be outdated. Refresh before acting.",
    ja: "一覧が古い可能性があります。更新してから操作してください。",
  },
  需要我处理: { "zh-TW": "需要我處理", en: "Needs my attention", ja: "対応が必要" },
  待确认: { "zh-TW": "待確認", en: "Unconfirmed", ja: "未確認" },
  等待批准: { "zh-TW": "等待批准", en: "Awaiting approval", ja: "承認待ち" },
  等待回答: { "zh-TW": "等待回答", en: "Awaiting an answer", ja: "回答待ち" },
  请求失败: { "zh-TW": "請求失敗", en: "Request failed", ja: "リクエスト失敗" },
  请求中断: { "zh-TW": "請求中斷", en: "Request interrupted", ja: "リクエスト中断" },
  标为已处理: { "zh-TW": "標為已處理", en: "Mark as handled", ja: "対応済みにする" },
  从待办移除: { "zh-TW": "從待辦移除", en: "Remove from list", ja: "一覧から削除" },
  "移除中…": { "zh-TW": "正在移除…", en: "Removing…", ja: "削除中…" },
  "移除失败：{reason}": {
    "zh-TW": "移除失敗：{reason}",
    en: "Could not remove: {reason}",
    ja: "削除できませんでした：{reason}",
  },
  前往会话批准: { "zh-TW": "前往對話批准", en: "Open conversation to approve", ja: "会話で承認" },
  前往会话回答: { "zh-TW": "前往對話回答", en: "Open conversation to answer", ja: "会話で回答" },
  查看问题: { "zh-TW": "查看問題", en: "View issue", ja: "問題を確認" },
  查看: { "zh-TW": "檢視", en: "View", ja: "表示" },
  回复中断: { "zh-TW": "回覆中斷", en: "Reply interrupted", ja: "返信が中断されました" },
  未归属项目: { "zh-TW": "未歸屬專案", en: "No project", ja: "プロジェクト未設定" },
  "汇总所有项目中等待你的批准、回答和未处理的失败。": {
    "zh-TW": "彙整所有專案中等待你的批准、回答和未處理的失敗。",
    en: "Approvals, questions and unhandled failures across all projects.",
    ja: "すべてのプロジェクトの承認待ち、回答待ち、未対応の失敗を表示します。",
  },
  "连接已断开，待办状态尚未确认。重新连接后会自动刷新。": {
    "zh-TW": "連線已中斷，待辦狀態尚未確認。重新連線後會自動重新整理。",
    en: "Disconnected. Attention items are unconfirmed and will refresh when reconnected.",
    ja: "接続が切れているため、現在の状態は未確認です。再接続後に自動更新します。",
  },
  "待办加载失败：{reason}": {
    "zh-TW": "待辦載入失敗：{reason}",
    en: "Could not load attention items: {reason}",
    ja: "対応項目を読み込めませんでした：{reason}",
  },
  "下方保留上次已加载的内容。": {
    "zh-TW": "下方保留上次已載入的內容。",
    en: "Previously loaded items are shown below.",
    ja: "前回読み込んだ項目を引き続き表示しています。",
  },
  "正在加载待办…": { "zh-TW": "正在載入待辦…", en: "Loading attention items…", ja: "対応項目を読み込み中…" },
  暂时没有需要你处理的事项: {
    "zh-TW": "暫時沒有需要你處理的事項",
    en: "Nothing needs your attention right now",
    ja: "現在、対応が必要な項目はありません",
  },
  有工具操作等待你的批准: {
    "zh-TW": "有工具操作等待你的批准",
    en: "A tool action is waiting for your approval",
    ja: "ツール操作の承認を待っています",
  },
  "Agent 有问题等待你回答": {
    "zh-TW": "Agent 有問題等待你回答",
    en: "An agent is waiting for your answer",
    ja: "Agent が回答を待っています",
  },
  "标记失败：{reason}。请重试。": {
    "zh-TW": "標記失敗：{reason}。請重試。",
    en: "Could not mark as handled: {reason}. Please try again.",
    ja: "対応済みにできませんでした：{reason}。再試行してください。",
  },
  "更多待办加载失败：{reason}": {
    "zh-TW": "更多待辦載入失敗：{reason}",
    en: "Could not load more attention items: {reason}",
    ja: "追加の対応項目を読み込めませんでした：{reason}",
  },
  重试加载更多: { "zh-TW": "重試載入更多", en: "Retry loading more", ja: "追加読み込みを再試行" },
  加载更多待办: { "zh-TW": "載入更多待辦", en: "Load more items", ja: "対応項目をさらに読み込む" },
  "批准和回答请在会话中完成。标为已处理只隐藏失败待办，原消息仍会保留。": {
    "zh-TW": "批准和回答請在對話中完成。標為已處理只隱藏失敗待辦，原訊息仍會保留。",
    en: "Approve and answer in the conversation. Marking a failure as handled hides this item and keeps the original message.",
    ja: "承認と回答は会話内で行ってください。対応済みにすると失敗した項目だけが非表示になり、元のメッセージは残ります。",
  },
  "待办分页位置无效，请刷新列表": {
    "zh-TW": "待辦分頁位置無效，請重新整理清單",
    en: "This attention page is invalid. Refresh the list.",
    ja: "ページ位置が無効です。一覧を更新してください。",
  },
  "待办每页数量必须为 1 到 50": {
    "zh-TW": "待辦每頁數量必須為 1 到 50",
    en: "Attention page size must be between 1 and 50",
    ja: "1ページの項目数は1から50の間で指定してください",
  },
  待办消息不存在: {
    "zh-TW": "待辦訊息不存在",
    en: "Attention message not found",
    ja: "対応項目のメッセージが見つかりません",
  },
  "只有失败或中断的 Agent 消息可以标为已处理": {
    "zh-TW": "只有失敗或中斷的 Agent 訊息可以標為已處理",
    en: "Only failed or interrupted agent messages can be marked as handled",
    ja: "失敗または中断した Agent メッセージのみ対応済みにできます",
  },
} satisfies MessageCatalog;
