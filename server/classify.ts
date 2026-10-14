import type { Difficulty, TaskType } from "./config";

export interface TaskSignals {
  text: string;
  /** Estimated prompt size in tokens (history + system). */
  contextTokens: number;
  toolCount: number;
  hasImages: boolean;
}

export interface Classification {
  taskType: TaskType;
  difficulty: Difficulty;
}

const CODE_RE =
  /```|\b(function|class|def|import|const|bug|stack ?trace|typescript|python|golang|sql|regex|api)\b|代码|报错|编译|重构|函数|接口实现/i;
const REASON_RE = /证明|推导|为什么|分析|比较|权衡|规划|方案|step by step|prove|reason|trade-?off|plan/i;
const TOOL_RE = /查一下|搜索|抓取|网页|链接|计算|现在几点|时间|https?:\/\/|fetch|search|calculate/i;
const HARD_RE = /复杂|系统设计|架构|全面|深入|多步|严格|证明|optimi[sz]e|architecture|in depth/i;

/** Deterministic classifier: the fallback when no classifier model is configured or it fails. */
export function classifyByRules(s: TaskSignals): Classification {
  let taskType: TaskType;
  if (s.hasImages) taskType = "vision";
  else if (s.contextTokens > 24000) taskType = "long_context";
  else if (CODE_RE.test(s.text)) taskType = "coding";
  else if (s.toolCount > 0 && TOOL_RE.test(s.text)) taskType = "tool_heavy";
  else if (REASON_RE.test(s.text)) taskType = "reasoning";
  else taskType = "chat";

  let difficulty: Difficulty = "easy";
  if (HARD_RE.test(s.text) || s.text.length > 1500) difficulty = "hard";
  else if (taskType !== "chat" || s.text.length > 300) difficulty = "medium";
  return { taskType, difficulty };
}
