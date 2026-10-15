import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the server lives. Packaged: everything the Bun server needs sits outside app.asar in
 * resources/ (Bun can't read asar): resources/server (server + shared + web/dist + production
 * node_modules with the ACP adapters and their native engines) and resources/bin/bun.
 * Dev: the repo checkout and the bun on PATH.
 */
export interface ServerLayout {
  bun: string;
  root: string;
  entry: string;
  staticDir: string | undefined;
}

export function serverLayout(opts: { packaged: boolean; resourcesPath: string; appPath: string }): ServerLayout {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  if (opts.packaged) {
    const root = join(opts.resourcesPath, "server");
    return {
      bun: join(opts.resourcesPath, "bin", exe),
      root,
      entry: join(root, "server", "main.ts"),
      staticDir: join(root, "web", "dist"),
    };
  }
  const root = resolve(opts.appPath, "..");
  const dist = join(root, "web", "dist");
  return {
    bun: process.env.TUANTUAN_BUN || "bun",
    root,
    entry: join(root, "server", "main.ts"),
    staticDir: existsSync(dist) ? dist : undefined,
  };
}
