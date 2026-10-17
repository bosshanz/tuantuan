import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import type { HarnessStatus } from "./harness";
import { readManifest } from "./managed";

const generations = new Map<string, number>();

/** Mark installed code stale without interrupting any process or active turn. */
export function invalidateHarnessRuntime(harnessId: string): void {
  generations.set(harnessId, (generations.get(harnessId) ?? 0) + 1);
}

/** Resolve the same engine the selected codex-acp adapter will launch. */
export function resolveCodexCommand(
  env: Record<string, string>,
  adapterLaunch?: { command: string; args: string[]; cwd?: string },
): string[] | null {
  if (env.CODEX_PATH) {
    const executable = Bun.which(env.CODEX_PATH, { PATH: env.PATH });
    if (!executable) throw new Error(`找不到 CODEX_PATH 可执行文件：${env.CODEX_PATH}`);
    return [executable];
  }
  if (adapterLaunch) {
    try {
      const script = adapterLaunch.args[0];
      const hasInterpreter = script && /\.[cm]?js$/i.test(script);
      const entry = realpathSync(
        hasInterpreter ? script : (Bun.which(adapterLaunch.command, { PATH: env.PATH }) ?? adapterLaunch.command),
      );
      if (!/\.[cm]?js$/i.test(entry)) return null;
      const interpreter = hasInterpreter
        ? adapterLaunch.command
        : readFileSync(entry, "utf8")
            .split("\n", 1)[0]
            ?.match(/^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)\s*$/)?.[1];
      const runtime = interpreter ? Bun.which(interpreter, { PATH: env.PATH }) : null;
      if (!runtime) return null;
      return [runtime, createRequire(entry).resolve("@openai/codex/bin/codex.js")];
    } catch {
      // A private binary adapter may embed its own engine. Do not substitute a global CLI.
      return null;
    }
  }
  const require = createRequire(import.meta.url);
  const adapter = createRequire(require.resolve("@agentclientprotocol/codex-acp/package.json"));
  return [process.execPath, adapter.resolve("@openai/codex/bin/codex.js")];
}

function fileIdentity(path: string) {
  try {
    const real = realpathSync(path);
    const stat = statSync(real, { bigint: true });
    return [real, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  } catch {
    return [path, "unavailable"];
  }
}

function commandIdentity(command: string[], env: Record<string, string>) {
  return command.flatMap((argument, index) => {
    const path = index === 0 ? (Bun.which(argument, { PATH: env.PATH }) ?? argument) : argument;
    if (index > 0 && !isAbsolute(path)) return [];
    const identity = fileIdentity(path);
    if (identity[1] === "unavailable") return index === 0 ? [identity] : [];
    // Updating a package can leave its launcher unchanged while replacing its
    // implementation or native dependency. Its manifest is part of that identity.
    let directory = dirname(identity[0] as string);
    for (let depth = 0; depth < 6; depth++) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) return [identity, fileIdentity(manifest)];
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return [identity];
  });
}

function claudeEngine(status: { command: string; args: string[] }, env: Record<string, string>): string[] | null {
  if (env.CLAUDE_CODE_EXECUTABLE) {
    return [Bun.which(env.CLAUDE_CODE_EXECUTABLE, { PATH: env.PATH }) ?? env.CLAUDE_CODE_EXECUTABLE];
  }
  try {
    const script = status.args[0];
    const entry = realpathSync(script && /\.[cm]?js$/i.test(script) ? script : status.command);
    const adapter = createRequire(entry);
    const sdkEntry = adapter.resolve("@anthropic-ai/claude-agent-sdk");
    const sdk = createRequire(sdkEntry);
    const platforms =
      process.platform === "linux"
        ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
        : [`${process.platform}-${process.arch}`];
    const files = [sdkEntry];
    for (const platform of platforms) {
      try {
        const manifest = sdk.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
        files.push(join(dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude"), manifest);
      } catch {
        /* A platform package need not be installed on this machine. */
      }
    }
    return files;
  } catch {
    return null;
  }
}

function codexEngineFiles(command: string[]): string[] {
  const entry = command.find((argument) => /\.[cm]?js$/i.test(argument));
  if (!entry) return command;
  try {
    const require = createRequire(entry);
    const manifest = require.resolve("@openai/codex/package.json");
    const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { optionalDependencies?: Record<string, unknown> };
    const files = [...command, manifest];
    for (const name of Object.keys(metadata.optionalDependencies ?? {})) {
      if (!name.startsWith(`@openai/codex-${process.platform}-${process.arch}`)) continue;
      try {
        const dependency = require.resolve(`${name}/package.json`);
        files.push(dependency);
        const directories = [dirname(dependency)];
        // Platform packages contain a small vendor tree. Observe the actual
        // engine too when its launcher/package metadata stays unchanged.
        for (let index = 0; index < directories.length && index < 32; index++) {
          for (const file of readdirSync(directories[index] as string, { withFileTypes: true })) {
            const path = join(directories[index] as string, file.name);
            if (file.isDirectory() && file.name !== "node_modules" && directories.length < 32) directories.push(path);
            else if (file.isFile() && /^(?:codex|codex\.exe)$/.test(file.name)) files.push(path);
          }
        }
      } catch {
        /* Optional packages for another libc/platform may be absent. */
      }
    }
    return files;
  } catch {
    return command;
  }
}

/** File observations, not an assumption that adapter/Registry versions are engine versions. */
export function harnessRuntimeIdentity(
  status: Pick<HarnessStatus, "id" | "command" | "args" | "version" | "source" | "registryId">,
  env: Record<string, string>,
): string {
  let engine: string[] | null = null;
  try {
    if (status.id === "codex" && status.command)
      engine = resolveCodexCommand(env, { command: status.command, args: status.args });
    else if (status.id === "pi") {
      const pi = Bun.which(env.PI_ACP_PI_COMMAND || (process.platform === "win32" ? "pi.cmd" : "pi"), {
        PATH: env.PATH,
      });
      if (pi) engine = [pi];
    } else if (status.id === "claude-code" && status.command)
      engine = claudeEngine({ command: status.command, args: status.args }, env);
  } catch {
    /* Invalid explicit engine paths are diagnosed by the launch path. */
  }
  if (status.id === "codex" && engine) engine = codexEngineFiles(engine);
  const managed = status.source === "managed" && status.registryId ? readManifest(status.registryId) : null;
  return JSON.stringify([
    status.id,
    generations.get(status.id) ?? 0,
    status.source,
    status.version,
    status.command
      ? { command: status.command, args: status.args, files: commandIdentity([status.command, ...status.args], env) }
      : null,
    managed ? [managed.version, managed.installedAt] : null,
    engine ? commandIdentity(engine, env) : null,
  ]);
}
