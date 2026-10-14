import { existsSync } from "node:fs";
import { serve } from "./app";
import { visibleHarnesses } from "./harness";

const port = Number(process.env.PORT ?? 8787);
const staticDir = existsSync("web/dist") ? "web/dist" : undefined;
const { server, app } = serve({ dbPath: process.env.DB_PATH ?? "data/agent-hub.db", staticDir }, port);

console.log(`团团 Tuantuan 已启动: http://localhost:${server.port}`);
console.log(
  `Harness: ${visibleHarnesses()
    .map((h) => h.name)
    .join("、")}（在「新手引导」里检测与登录）`,
);
if (!staticDir) console.log("未找到 web/dist，前端请通过 Vite 开发服务器访问");
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    app.host.shutdown();
    process.exit(0);
  });
