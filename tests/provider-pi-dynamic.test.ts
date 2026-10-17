import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureModelCatalog } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";

function provider(levels: string[]): ProviderSecret {
  return captureModelCatalog(
    {
      id: "dynamic-pi",
      name: "Dynamic fixture",
      preset: "custom",
      model: "future-model",
      smallModel: "",
      apiKey: "fixture-key",
      mgmtKey: "",
      anthropicBaseUrl: "",
      openaiBaseUrl: "http://127.0.0.1:9/v1",
      wireApi: "chat",
      modelCatalog: { "future-model": "moonshotai-cn/future-model" },
      createdAt: 0,
      updatedAt: 0,
    },
    catalogSnapshot(
      JSON.stringify({
        "moonshotai-cn": {
          name: "Fixture",
          models: {
            "future-model": {
              name: "Future model",
              reasoning: true,
              reasoning_options: levels.includes("on")
                ? [{ type: "toggle" }]
                : [{ type: "effort", values: levels.map((level) => (level === "off" ? "none" : level)) }],
              limit: { context: 128000, output: 8192 },
              modalities: { input: ["text"] },
            },
          },
        },
      }),
      "2026-10-17T00:00:00Z",
    ),
  );
}

test.skipIf(process.platform === "win32")(
  "Pi intersects future engine controls with catalog declarations through the engine's public compat module",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-pi-dynamic-"));
    const executable = join(root, "pi");
    writeFileSync(
      executable,
      `#!${process.execPath}
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const extension = args[args.indexOf("--extension") + 1];
const scenario = JSON.parse(args.at(-1));
const compat = join(dirname(extension), "node_modules", "@earendil-works", "pi-ai");
mkdirSync(compat, { recursive: true });
writeFileSync(join(compat, "package.json"), JSON.stringify({ type: "module", exports: { "./compat": "./compat.js" } }));
writeFileSync(join(compat, "compat.js"), scenario.missing ? 'export const unsupported = true;' :
  'export function getSupportedThinkingLevels(model) { return ' + JSON.stringify(scenario.native) + '.filter(level => model.thinkingLevelMap?.[level] !== null); }');
const { default: setup } = await import(extension);
let config;
await setup({ registerProvider(id, registration) { config = registration; }, on() {} });
const native = await import(join(compat, "compat.js"));
console.log(JSON.stringify({ model: config.models[0], supported: native.getSupportedThinkingLevels(config.models[0]) }));
`,
      { mode: 0o700 },
    );
    const run = async (declared: string[], native: string[], missing = false) => {
      const runtime = await prepareProviderRuntime(provider(declared), "pi", {
        HOME: root,
        PATH: process.env.PATH ?? "",
        PI_ACP_PI_COMMAND: executable,
      });
      try {
        const child = Bun.spawn([runtime.env.PI_ACP_PI_COMMAND as string, JSON.stringify({ native, missing })], {
          env: runtime.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (missing) {
          expect(code).not.toBe(0);
          expect(stderr).toContain("Pi 未提供公开思考能力接口");
          return null;
        }
        expect(code, stderr).toBe(0);
        return JSON.parse(stdout) as {
          model: { thinkingLevelMap: Record<string, string | null> };
          supported: string[];
        };
      } finally {
        runtime.cleanup();
      }
    };
    try {
      const future = await run(["off", "low", "ultra"], ["off", "low", "medium", "ultra", "future-unlisted"]);
      expect(future?.supported).toEqual(["off", "low", "ultra"]);
      expect(future?.model.thinkingLevelMap).toMatchObject({ ultra: "ultra", medium: null, "future-unlisted": null });
      expect((await run(["off", "low", "ultra"], ["off", "low"]))?.supported).toEqual(["off", "low"]);
      expect((await run(["off", "on"], ["off", "high", "on"]))?.supported).toEqual(["off", "on"]);
      expect((await run(["off", "on"], ["off", "high"]))?.supported).toEqual(["off", "high"]);
      await run(["off", "low"], ["off", "low"], true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
