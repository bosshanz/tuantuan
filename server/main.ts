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
  `agent-hub API 已启动: http://localhost:${server.port}  (配置: ${source}, 模型 ${config.models.length} 个)`,
);
console.log(
  source === "builtin-mock"
    ? `未找到配置文件 ${process.env.AGENT_HUB_CONFIG ?? "config/providers.json"}，使用内置 mock（.env 里的 Key/URL 不会生效）`
    : `Providers:\n${describeProviders(config).join("\n")}`,
);
console.log(`Skills: ${skills.skills.map((s) => s.name).join(", ") || "无"}`);
for (const e of skills.errors) console.warn(`Skill 加载失败 ${e.dir}: ${e.error}`);
if (!staticDir) console.log("未找到 web/dist，前端请通过 Vite 开发服务器访问");
