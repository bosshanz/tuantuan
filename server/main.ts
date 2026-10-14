import { existsSync } from "node:fs";
import { serve } from "./app";
import { describeProviders, loadConfig } from "./config";
import { loadSkills } from "./skills";

const { config, source } = loadConfig();
const skills = loadSkills(process.env.SKILLS_DIR ?? "skills");
const port = Number(process.env.PORT ?? 8787);
const staticDir = existsSync("web/dist") ? "web/dist" : undefined;
const { server } = serve(
  { config, configSource: source, skills, dbPath: process.env.DB_PATH ?? "data/agent-hub.db", staticDir },
  port,
);

console.log(
  `团团 Tuantuan API 已启动: http://localhost:${server.port}  (配置: ${source}, 模型 ${config.models.length} 个)`,
);
console.log(
  source === "builtin-mock"
    ? `未设置 AGENT_HUB_MODELS，也没有 ${process.env.AGENT_HUB_CONFIG ?? "config/providers.json"}，使用内置 mock`
    : `Providers:\n${describeProviders(config).join("\n")}`,
);
if (source !== "builtin-mock") console.log(`启用模型: ${config.models.map((m) => m.id).join(", ")}`);
console.log(
  config.decision
    ? `Auto 分类器: 决策模型 ${config.decision.model}（${config.decision.endpoint}，最低置信度 ${config.decision.minConfidence}，超时 ${config.decision.timeoutMs}ms）→ ${config.router.classifierModel ?? "规则"}`
    : `Auto 分类器: ${config.router.classifierModel ?? "规则"}（未设置 DECISION_BASE_URL，未启用决策模型）`,
);
console.log(`Skills: ${skills.skills.map((s) => s.name).join(", ") || "无"}`);
for (const e of skills.errors) console.warn(`Skill 加载失败 ${e.dir}: ${e.error}`);
if (!staticDir) console.log("未找到 web/dist，前端请通过 Vite 开发服务器访问");
