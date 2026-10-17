import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureModelCatalog,
  ModelCatalog,
  modelApi,
  resolveModelCapabilities,
  searchCatalogModels,
} from "../server/model-catalog";
import { type CatalogData, catalogSnapshot, downloadModelCatalog } from "../server/model-catalog-schema";
import { prepareProviderRuntime } from "../server/provider-runtime";
import type { ProviderSecret } from "../server/providers";
import { MIGRATIONS, Store } from "../server/store";

const provider = (extra: Partial<ProviderSecret> = {}): ProviderSecret => ({
  id: "catalog-test",
  name: "Catalog fixture",
  preset: "custom",
  openaiBaseUrl: "https://fixture.test/v1",
  anthropicBaseUrl: "",
  model: "shared-model",
  smallModel: "",
  wireApi: "chat",
  apiKey: "private-provider-key",
  mgmtKey: "private-management-key",
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const rawCatalog = (efforts: string[] = ["low", "high", "max"]) => ({
  deepseek: {
    name: "DeepSeek fixture",
    api: "https://api.deepseek.com/v1",
    headers: { authorization: "must-not-enter-catalog" },
    models: {
      "shared-model": {
        name: "Shared model",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: efforts }],
        interleaved: { field: "reasoning_content" },
        limit: { context: 32768, output: 8192 },
        modalities: { input: ["text", "image", "audio"] },
        npm: "must-not-run",
        body: { api_key: "must-not-enter-model" },
      },
    },
  },
  "moonshotai-cn": {
    name: "Moonshot fixture",
    api: "https://api.moonshot.cn/v1",
    models: {
      "shared-model": {
        name: "Shared model (toggle only)",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        limit: { context: 32768, output: 4096 },
        modalities: { input: ["text"] },
      },
    },
  },
});
const data = (efforts?: string[]) => catalogSnapshot(JSON.stringify(rawCatalog(efforts)), "2026-10-17T00:00:00Z");
const fetchCatalog = (raw: unknown): typeof fetch => (async () => Response.json(raw)) as unknown as typeof fetch;
const capture = (extra: Partial<ProviderSecret> = {}, snapshot = data()) =>
  captureModelCatalog(provider(extra), snapshot);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("model identity and verified controls", () => {
  test("presets resolve configured providers; exact official endpoints take precedence", () => {
    expect(resolveModelCapabilities(capture({ preset: "deepseek" }))?.providerId).toBe("deepseek");
    expect(
      resolveModelCapabilities(capture({ preset: "deepseek", openaiBaseUrl: "https://api.moonshot.cn/v1" })),
    ).toMatchObject({ providerId: "moonshotai-cn", effort: false, levels: ["off", "on"] });
    expect(resolveModelCapabilities(capture({ openaiBaseUrl: "https://api.deepseek.com/v1/" }))).toMatchObject({
      providerId: "deepseek",
      effort: true,
      levels: ["off", "low", "high", "max"],
    });
  });

  test("unknown model IDs and lookalike hosts do not borrow a model's capabilities", () => {
    for (const openaiBaseUrl of [
      "https://api.deepseek.com.evil.test/v1",
      "https://api.deepseek.com@evil.test/v1",
      "https://evil.test/api.deepseek.com/v1",
      "http://api.deepseek.com/v1",
      "https://api.deepseek.com:8443/v1",
    ])
      expect(resolveModelCapabilities(capture({ openaiBaseUrl }))).toBeNull();
    expect(resolveModelCapabilities(capture({ preset: "deepseek", model: "shared-model-preview" }))).toBeNull();
    expect(resolveModelCapabilities(capture({ modelCatalog: { "shared-model": "missing/shared-model" } }))).toBeNull();
  });

  test("URL path matching uses boundaries rather than prefixes", () => {
    const snapshot = data();
    snapshot.providers.fixture = {
      ...(snapshot.providers.deepseek as CatalogData["providers"][string]),
      api: "https://fixture.test/compatible/v1",
    };
    expect(
      resolveModelCapabilities(capture({ openaiBaseUrl: "https://fixture.test/compatible/v1/models" }, snapshot))
        ?.providerId,
    ).toBe("fixture");
    for (const path of ["compatible/v10", "compatible/v1-evil", "compatible"])
      expect(resolveModelCapabilities(capture({ openaiBaseUrl: `https://fixture.test/${path}` }, snapshot))).toBeNull();
  });

  test("protocol selects the matching endpoint and fields, not the other API URL", () => {
    const fixture = capture({
      openaiBaseUrl: "https://api.moonshot.cn/v1",
      anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    });
    expect(modelApi(fixture)).toBe("openai-completions");
    expect(modelApi({ ...fixture, wireApi: "responses" })).toBe("openai-responses");
    expect(modelApi({ ...fixture, openaiBaseUrl: "" })).toBe("anthropic-messages");
    expect(resolveModelCapabilities(fixture, fixture.model, "openai-completions")).toMatchObject({
      providerId: "moonshotai-cn",
      format: "deepseek",
      effort: false,
      levels: ["off", "on"],
    });
    expect(resolveModelCapabilities(fixture, fixture.model, "anthropic-messages")).toMatchObject({
      providerId: "deepseek",
      format: "anthropic-adaptive",
      effort: true,
    });
    expect(resolveModelCapabilities(fixture, fixture.model, "openai-responses")?.levels).toEqual([]);
    const responses = capture({ preset: "deepseek", wireApi: "responses" });
    expect(resolveModelCapabilities(responses)).toMatchObject({
      api: "openai-responses",
      levels: ["off", "low", "high", "max"],
    });
  });

  test("the same model name has provider-specific effort and bounded Anthropic budgets", () => {
    const direct = resolveModelCapabilities(capture({ preset: "deepseek" }));
    const toggle = resolveModelCapabilities(capture({ preset: "kimi" }));
    expect(direct).toMatchObject({
      modelId: "shared-model",
      effort: true,
      defaultLevel: "high",
      input: ["text", "image"],
    });
    expect(toggle).toMatchObject({ modelId: "shared-model", effort: false, levels: ["off", "on"], defaultLevel: "on" });
    const anthropic = resolveModelCapabilities(
      capture({ preset: "kimi", openaiBaseUrl: "" }),
      "shared-model",
      "anthropic-messages",
    );
    expect(anthropic).toMatchObject({ effort: false, levels: ["off", "on"] });
    for (const budget of Object.values(anthropic?.budgets ?? {})) {
      expect(budget).toBeGreaterThanOrEqual(1024);
      expect(budget).toBeLessThan(anthropic?.maxTokens as number);
    }
  });

  test("explicit model aliases bind capabilities without replacing the outgoing model ID", async () => {
    const fixture = capture({ model: "company-main", modelCatalog: { "company-main": "deepseek/shared-model" } });
    expect(resolveModelCapabilities(fixture)).toMatchObject({
      providerId: "deepseek",
      modelId: "shared-model",
      effort: true,
    });
    const runtime = await prepareProviderRuntime(fixture, "opencode", {}, "2.0.29");
    try {
      const config = JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT as string);
      expect(config.model).toBe("tuantuan/company-main");
      expect(Object.keys(config.providers.tuantuan.models)).toEqual(["company-main"]);
      expect(config.providers.tuantuan.models["company-main"].settings.reasoningEffort).toBe("high");
      expect(fixture.model).toBe("company-main");
    } finally {
      runtime.cleanup();
    }
  });

  test("search trims queries, matches provider/model/name, returns bounded public choices", () => {
    expect(searchCatalogModels("  SHARED MODEL  ", 1, data())).toHaveLength(1);
    expect(searchCatalogModels("deepseek/shared-model", 50, data())).toEqual([
      { value: "deepseek/shared-model", name: "DeepSeek fixture · Shared model" },
    ]);
    expect(searchCatalogModels(" ", 50, data())).toEqual([]);
    expect(JSON.stringify(data())).not.toContain("must-not-");
  });
});

describe("bounded catalog download and atomic replacement", () => {
  test("new effort IDs survive sync and restart without inventing their priority", async () => {
    let persisted = data();
    const catalog = new ModelCatalog(persisted, (next) => {
      persisted = next;
    });
    const old = catalog.capture(provider({ preset: "deepseek" }));
    await catalog.sync(fetchCatalog(rawCatalog(["high", "ultra", "vendor-v2", "default"])));
    expect(resolveModelCapabilities(old)?.levels).toEqual(["off", "low", "high", "max"]);
    const restored = new ModelCatalog(persisted, () => {});
    expect(resolveModelCapabilities(restored.capture(provider({ preset: "deepseek" })))).toMatchObject({
      levels: ["off", "high", "ultra", "vendor-v2"],
      defaultLevel: "high",
    });
    await catalog.sync(fetchCatalog(rawCatalog(["ultra"])));
    expect(resolveModelCapabilities(catalog.capture(provider({ preset: "deepseek" })))).toMatchObject({
      levels: ["off", "ultra"],
      defaultLevel: undefined,
    });
  });

  test("malformed effort identifiers cannot replace a valid catalog", async () => {
    const catalog = new ModelCatalog(data(), () => {
      throw new Error("must not persist malformed IDs");
    });
    const before = catalog.status();
    for (const effort of ["", "high\n", "x".repeat(65), "value;option=on"]) {
      await expect(catalog.sync(fetchCatalog(rawCatalog([effort])))).rejects.toThrow();
      expect(catalog.status()).toEqual(before);
    }
  });

  test("sync requests only the public fixed endpoint, without provider credentials or executable catalog fields", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const result = await downloadModelCatalog((async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json(rawCatalog());
    }) as unknown as typeof fetch);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://models.dev/api.json");
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(requests[0]?.init?.headers).toBeUndefined();
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("must-not-");
    expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isNaN(Date.parse(result.source.fetchedAt))).toBe(false);
  });

  test("oversized streaming responses cancel before replacing the catalog", async () => {
    let cancelled = false;
    const catalog = new ModelCatalog(data(), () => {
      throw new Error("must not persist oversized data");
    });
    const before = catalog.status();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8_000_000));
        controller.enqueue(new Uint8Array(8_000_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(catalog.sync((async () => new Response(body)) as unknown as typeof fetch)).rejects.toThrow(
      "exceeds 15 MB",
    );
    expect(cancelled).toBe(true);
    expect(catalog.status()).toEqual(before);
  });

  test("HTTP, empty, malformed and invalid catalogs keep the current data and do not persist", async () => {
    let writes = 0;
    const catalog = new ModelCatalog(data(), () => {
      writes++;
    });
    const before = catalog.status();
    const fetchers: (typeof fetch)[] = [
      (async () => {
        throw new Error("fixture network unavailable");
      }) as unknown as typeof fetch,
      (async () => new Response("no", { status: 503 })) as unknown as typeof fetch,
      (async () => new Response(null)) as unknown as typeof fetch,
      (async () => new Response("not-json")) as unknown as typeof fetch,
      fetchCatalog({}),
      fetchCatalog({ deepseek: { name: "broken", models: { x: { name: "No required model facts" } } } }),
    ];
    for (const fetcher of fetchers) {
      await expect(catalog.sync(fetcher)).rejects.toThrow();
      expect(catalog.status()).toEqual(before);
      expect(catalog.has("deepseek/shared-model")).toBe(true);
    }
    expect(writes).toBe(0);
    await catalog.sync(fetchCatalog(rawCatalog(["low"])));
    expect(writes).toBe(1);
  });

  test("persistence failure preserves in-memory and on-disk snapshots and allows retry", async () => {
    let persisted = data();
    let fail = true;
    const catalog = new ModelCatalog(persisted, (next) => {
      if (fail) throw new Error("fixture disk full");
      persisted = next;
    });
    const before = catalog.status();
    const oldDigest = persisted.source.sha256;
    await expect(catalog.sync(fetchCatalog(rawCatalog(["low"])))).rejects.toThrow("fixture disk full");
    expect(catalog.status()).toEqual(before);
    expect(persisted.source.sha256).toBe(oldDigest);
    fail = false;
    await catalog.sync(fetchCatalog(rawCatalog(["low"])));
    expect(persisted.source.sha256).not.toBe(oldDigest);
  });

  test("concurrent sync calls share one download and one atomic commit", async () => {
    const response = deferred<Response>();
    let requests = 0;
    let writes = 0;
    const catalog = new ModelCatalog(data(), () => {
      writes++;
    });
    const fetcher = (async () => {
      requests++;
      return response.promise;
    }) as unknown as typeof fetch;
    const first = catalog.sync(fetcher);
    const second = catalog.sync(fetcher);
    expect(first).toBe(second);
    expect(requests).toBe(1);
    expect(writes).toBe(0);
    response.resolve(Response.json(rawCatalog(["low"])));
    expect(await first).toEqual(await second);
    expect(writes).toBe(1);
  });

  test("existing provider captures stay frozen while new captures use successfully synced facts", async () => {
    const catalog = new ModelCatalog(data(), () => {});
    const old = catalog.capture(provider({ preset: "deepseek" }));
    expect(resolveModelCapabilities(old)?.levels).toEqual(["off", "low", "high", "max"]);
    await catalog.sync(fetchCatalog(rawCatalog(["low"])));
    expect(resolveModelCapabilities(old)?.levels).toEqual(["off", "low", "high", "max"]);
    expect(resolveModelCapabilities(catalog.capture(old))?.levels).toEqual(["off", "low", "high", "max"]);
    expect(resolveModelCapabilities(catalog.capture(provider({ preset: "deepseek" })))?.levels).toEqual(["off", "low"]);
  });
});

describe("Store catalog persistence and migration", () => {
  test("the appended migration preserves an existing provider and initializes automatic capability lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-catalog-migration-"));
    const file = join(root, "data.sqlite");
    const migration = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN model_catalog"));
    expect(migration).toBeGreaterThan(0);
    const db = new Database(file);
    for (const sql of MIGRATIONS.slice(0, migration)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${migration}`);
    db.query(
      "INSERT INTO providers (id,name,preset,anthropic_base_url,openai_base_url,api_key,mgmt_key,model,small_model,wire_api,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "existing",
      "Existing",
      "deepseek",
      "",
      "https://api.deepseek.com/v1",
      "old-private-key",
      "",
      "deepseek-v4-pro",
      "",
      "chat",
      11,
      12,
    );
    db.close();
    let store: Store | undefined;
    try {
      store = new Store(file);
      expect(store.getProvider("existing")).toMatchObject({
        name: "Existing",
        apiKey: "old-private-key",
        modelCatalog: {},
        createdAt: 11,
        updatedAt: 12,
      });
      expect(resolveModelCapabilities(store.getProvider("existing") as ProviderSecret)?.providerId).toBe("deepseek");
      expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    } finally {
      store?.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart restores synced facts and new Store provider snapshots capture the restored catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-catalog-store-"));
    const file = join(root, "data.sqlite");
    let store: Store | undefined;
    try {
      store = new Store(file);
      const saved = store.saveProvider(provider({ preset: "deepseek" }));
      const before = store.getProvider(saved.id) as ProviderSecret;
      await store.modelCatalog.sync(fetchCatalog(rawCatalog(["low"])));
      const digest = store.modelCatalog.status().sha256;
      expect(resolveModelCapabilities(before)).toBeNull();
      expect(resolveModelCapabilities(store.getProvider(saved.id) as ProviderSecret)?.levels).toEqual(["off", "low"]);
      expect(store.listProviders()[0]?.model).toBe("shared-model");
      expect(store.getSetting<CatalogData>("modelCatalog", data()).source.sha256).toBe(digest);
      store.db.close();
      store = new Store(file);
      expect(store.modelCatalog.status()).toMatchObject({ origin: "synced", sha256: digest, error: null });
      expect(resolveModelCapabilities(store.getProvider(saved.id) as ProviderSecret)?.levels).toEqual(["off", "low"]);
      expect(store.db.query("PRAGMA table_info(providers)").all()).toContainEqual(
        expect.objectContaining({ name: "model_catalog" }),
      );
    } finally {
      store?.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid cached schema falls back to the bundled catalog with a visible diagnostic", () => {
    const catalog = new ModelCatalog({ version: 1, providers: {} }, () => {});
    expect(catalog.status()).toMatchObject({ origin: "bundled", error: expect.stringContaining("缓存损坏") });
    expect(catalog.status().models).toBeGreaterThan(100);
    expect(catalog.has("deepseek/deepseek-v4-pro")).toBe(true);
  });

  test("a malformed JSON cache cannot prevent Store restart and falls back to bundled facts", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-catalog-corrupt-"));
    const file = join(root, "data.sqlite");
    let store: Store | undefined;
    try {
      store = new Store(file);
      store.db.query("INSERT INTO settings VALUES (?, ?)").run("modelCatalog", "{broken-json");
      store.db.close();
      store = undefined;
      store = new Store(file);
      expect(store.modelCatalog.status()).toMatchObject({
        origin: "bundled",
        error: expect.stringContaining("缓存损坏"),
      });
    } finally {
      store?.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sync persistence failure in SQLite leaves the saved cache and running catalog unchanged", async () => {
    const store = new Store(":memory:");
    try {
      await store.modelCatalog.sync(fetchCatalog(rawCatalog()));
      const before = store.modelCatalog.status();
      const cached = store.getSetting("modelCatalog", null);
      store.db.exec(
        "CREATE TRIGGER reject_catalog BEFORE INSERT ON settings WHEN NEW.key = 'modelCatalog' BEGIN SELECT RAISE(FAIL, 'fixture disk failure'); END;",
      );
      await expect(store.modelCatalog.sync(fetchCatalog(rawCatalog(["low"])))).rejects.toThrow("fixture disk failure");
      expect(store.modelCatalog.status()).toEqual(before);
      expect(store.getSetting("modelCatalog", null)).toEqual(cached);
    } finally {
      store.db.close();
    }
  });
});
