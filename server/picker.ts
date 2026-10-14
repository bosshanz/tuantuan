import type { AppConfig } from "./config";
import { postSystemOne } from "./decision";
import { chat } from "./llm";

/**
 * Picks ONE group member to answer a message that @s nobody.
 * Chain: decision model (choice over members) → LLM classifier model → keyword rules → first member.
 */

export interface Member {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface Selection {
  agentId: string;
  agentName: string;
  by: "systemone" | "llm" | "rules" | "only";
  confidence?: number;
  reason: string;
  /** Why earlier pickers in the chain were not used. */
  fallbackReason?: string;
}

/** Short description of an agent for pickers: its prompt without mock directives. */
export function memberProfile(m: Member): string {
  const text = m.systemPrompt
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 160) : "（未填写系统 Prompt）";
}

/** Latin words and CJK bigrams, lower-cased. */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? [])
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

/** Deterministic: most shared terms between the message and name+prompt; ties and zero → member order. */
export function pickByRules(text: string, members: Member[]): Selection {
  const msg = terms(text);
  let best = { i: 0, score: 0, hits: [] as string[] };
  members.forEach((m, i) => {
    const prof = terms(`${m.name} ${memberProfile(m)}`);
    const hits = [...msg].filter((t) => prof.has(t));
    if (hits.length > best.score) best = { i, score: hits.length, hits };
  });
  const m = members[best.i] as Member;
  return {
    agentId: m.id,
    agentName: m.name,
    by: "rules",
    reason: best.score > 0 ? `关键词匹配：${best.hits.slice(0, 5).join("、")}` : "没有匹配的关键词，默认交给第一个成员",
  };
}

export function buildPickerRequest(model: string, text: string, members: Member[]) {
  const criteria: Record<string, string> = {};
  for (const m of members) criteria[m.name] = memberProfile(m);
  criteria.other = "都不合适";
  return {
    model,
    state: { message: text.slice(0, 8000) },
    questions: {
      responder: { type: "choice", instructions: "这条群聊消息最适合由哪位成员回复？", criteria },
    },
  };
}

const PICKER_PROMPT =
  '你是群聊路由器。用户给出 JSON：text 为消息，candidates 为成员（name、profile）。选出最适合回复的一位，只输出 {"agent": 成员 name, "reason": 简短中文理由}。';

export async function pickResponder(
  config: AppConfig,
  text: string,
  members: Member[],
  signal?: AbortSignal,
): Promise<Selection> {
  if (members.length === 1) {
    const m = members[0] as Member;
    return { agentId: m.id, agentName: m.name, by: "only", reason: "群里只有这一个 Agent" };
  }
  const why: string[] = [];
  const d = config.decision;
  if (d) {
    try {
      const body = (await postSystemOne(d, buildPickerRequest(d.model, text, members), signal)) as {
        answers?: { responder?: { choice?: unknown; confidence?: unknown } };
      };
      const r = body?.answers?.responder;
      if (typeof r?.choice !== "string" || typeof r.confidence !== "number")
        throw new Error("决策模型返回格式不符：responder 缺少 choice/confidence");
      const m = members.find((x) => x.name === r.choice);
      if (!m) why.push(`决策模型选择了 ${r.choice}`);
      else if (r.confidence < d.minConfidence)
        why.push(`决策模型置信度 ${r.confidence.toFixed(2)} < ${d.minConfidence}（倾向 ${m.name}）`);
      else
        return {
          agentId: m.id,
          agentName: m.name,
          by: "systemone",
          confidence: r.confidence,
          reason: `决策模型按话题选择（置信度 ${r.confidence.toFixed(2)}）`,
        };
    } catch (e) {
      if (signal?.aborted) throw e;
      why.push(`决策模型失败：${(e as Error).message}`);
    }
  }
  const modelId = config.router.classifierModel;
  const model = modelId ? config.models.find((m) => m.id === modelId) : undefined;
  if (model) {
    try {
      const res = await chat(config, model, {
        json: true,
        signal,
        messages: [
          { role: "system", content: PICKER_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              text: text.slice(0, 4000),
              candidates: members.map((m) => ({ name: m.name, profile: memberProfile(m) })),
            }),
          },
        ],
      });
      const obj = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? "null") as { agent?: unknown; reason?: unknown };
      const m = members.find((x) => x.name === obj?.agent);
      if (!m) throw new Error(`选择了不存在的成员：${String(obj?.agent)}`);
      return {
        agentId: m.id,
        agentName: m.name,
        by: "llm",
        reason: `${model.id} 按话题选择${typeof obj.reason === "string" && obj.reason ? `：${obj.reason}` : ""}`,
        fallbackReason: why.length ? why.join("；") : undefined,
      };
    } catch (e) {
      if (signal?.aborted) throw e;
      why.push(`LLM 选择失败（${model.id}）：${(e as Error).message}`);
    }
  }
  return { ...pickByRules(text, members), fallbackReason: why.length ? why.join("；") : undefined };
}
