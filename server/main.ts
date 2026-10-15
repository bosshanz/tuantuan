import { existsSync } from "node:fs";
import { serve } from "./app";
import { visibleHarnesses } from "./harness";

const port = Number(process.env.PORT ?? 8787);
// The desktop app points these at its resources / userData; plain `bun start` uses the repo layout.
const staticDir = process.env.TUANTUAN_STATIC_DIR || (existsSync("web/dist") ? "web/dist" : undefined);
const { server, app } = serve(
  { dbPath: process.env.DB_PATH ?? "data/agent-hub.db", staticDir },
  port,
  process.env.TUANTUAN_HOST || undefined,
);

console.log(`团团 Tuantuan 已启动: http://localhost:${server.port}`);
console.log(
  `Harness: ${visibleHarnesses()
    .map((h) => h.name)
    .join("、")}（在「新手引导」里检测与登录）`,
);
if (!staticDir) console.log("未找到 web/dist，前端请通过 Vite 开发服务器访问");
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app.host.shutdown();
  app.installer.shutdown();
  server.stop(true);
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop);
// Under the desktop app: exit with it even if it dies without a goodbye (crash, kill -9).
if (process.env.TUANTUAN_PARENT_PID) {
  const parent = Number(process.env.TUANTUAN_PARENT_PID);
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      stop();
    }
  }, 2000).unref();
  process.stdin.on?.("end", stop);
}
