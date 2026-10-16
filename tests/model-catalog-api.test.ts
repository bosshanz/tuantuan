import { afterAll, beforeAll, expect, test } from "bun:test";
import { serve } from "../server/app";
import { resolveModelCapabilities } from "../server/model-catalog";
import { catalogSnapshot } from "../server/model-catalog-schema";
import type { Provider } from "../server/providers";
import "./helpers";

const { app, server } = serve({ dbPath: ":memory:" }, 0);
const base = `http://127.0.0.1:${server.port}`;
const rawCatalog = (name = "Fixture model") => ({
  deepseek: {
    name: "DeepSeek fixture",
    api: "https://api.deepseek.com/v1",
    headers: { authorization: "catalog-header-secret" },
    models: Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        index ? `fixture-model-${index}` : "shared-model",
        {
          name: `${name} ${index}`,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }, { type: "toggle" }],
          limit: { context: 32768, output: 8192 },
          modalities: { input: ["text"] },
          npm: "catalog-executable-package",
          body: { api_key: "catalog-body-secret" },
        },
      ]),
    ),
  },
  "moonshotai-cn": {
    name: "Moonshot fixture",
    models: {
      "shared-model": {
        name: "Toggle only",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        limit: { context: 32768, output: 8192 },
        modalities: { input: ["text"] },
      },
    },
  },
});
const fixtureFetch = (name?: string): typeof fetch =>
  (async () => Response.json(rawCatalog(name))) as unknown as typeof fetch;
async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
const input = {
  name: "Mapped fixture",
  preset: "deepseek",
  openaiBaseUrl: "https://fixture.test/v1",
  anthropicBaseUrl: "",
  model: "shared-model",
  smallModel: "company-small",
  wireApi: "chat",
  apiKey: "provider-api-private-9876",
  mgmtKey: "provider-management-private-4321",
  modelCatalog: { "shared-model": "moonshotai-cn/shared-model", "company-small": "deepseek/shared-model" },
};
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of [
    "provider-api-private",
    "provider-management-private",
    "catalog-header-secret",
    "catalog-body-secret",
    "catalog-executable-package",
  ])
    expect(text).not.toContain(secret);
  expect(text).not.toContain('"apiKey"');
  expect(text).not.toContain('"mgmtKey"');
};

beforeAll(async () => {
  await app.store.modelCatalog.sync(fixtureFetch());
});
afterAll(() => {
  app.host.shutdown();
  server.stop(true);
  app.store.db.close();
});

test("models API searches the public local catalog and limits results without credentials", async () => {
  type Result = {
    origin: string;
    url: string;
    sha256: string;
    models: number;
    error: string | null;
    items: { value: string; name: string }[];
  };
  const empty = await api<Result>("GET", "/api/providers/models");
  expect(empty.status).toBe(200);
  expect(empty.data).toMatchObject({
    origin: "synced",
    url: "https://models.dev/api.json",
    models: 61,
    error: null,
    items: [],
  });
  const search = await api<Result>("GET", "/api/providers/models?query=FiXtUrE");
  expect(search.status).toBe(200);
  expect(search.data.items).toHaveLength(50);
  expect(search.data.items[0]).toMatchObject({
    value: "deepseek/shared-model",
    name: "DeepSeek fixture · Fixture model 0",
  });
  const exact = await api<Result>("GET", "/api/providers/models?query=moonshotai-cn%2Fshared-model");
  expect(exact.data.items).toEqual([{ value: "moonshotai-cn/shared-model", name: "Moonshot fixture · Toggle only" }]);
  expect((await api<Result>("GET", `/api/providers/models?query=${"q".repeat(300)}`)).data.items).toEqual([]);
  noSecrets(search.data);
  expect(search.data).not.toHaveProperty("providers.deepseek");
});

test("sync API delegates only to its store's catalog, returns updated metadata and restores its stub", async () => {
  const original = app.store.modelCatalog.sync;
  let calls = 0;
  app.store.modelCatalog.sync = () => {
    calls++;
    return original.call(app.store.modelCatalog, fixtureFetch("Synced fixture"));
  };
  try {
    const synced = await api<{ origin: string; error: string | null; sha256: string; models: number }>(
      "POST",
      "/api/providers/models/sync",
      { apiKey: "must-not-forward-user-input" },
    );
    expect(synced.status).toBe(200);
    expect(calls).toBe(1);
    expect(synced.data).toMatchObject({ origin: "synced", models: 61, error: null });
    expect(synced.data.sha256).toBe(
      catalogSnapshot(JSON.stringify(rawCatalog("Synced fixture")), "fixture").source.sha256,
    );
    noSecrets(synced.data);
    const search = await api<{ items: { name: string }[] }>("GET", "/api/providers/models?query=shared-model");
    expect(search.data.items[0]?.name).toBe("DeepSeek fixture · Synced fixture 0");
  } finally {
    app.store.modelCatalog.sync = original;
  }
});

test("sync API reports failures as 502 and retains the prior working catalog", async () => {
  const original = app.store.modelCatalog.sync;
  const before = app.store.modelCatalog.status();
  app.store.modelCatalog.sync = () =>
    original.call(app.store.modelCatalog, (async () => {
      throw new Error("fixture offline");
    }) as unknown as typeof fetch);
  try {
    const failed = await api<{ error: string }>("POST", "/api/providers/models/sync");
    expect(failed.status).toBe(502);
    expect(failed.data.error).toContain("fixture offline");
    expect(app.store.modelCatalog.status()).toEqual(before);
    expect(app.store.modelCatalog.has("deepseek/shared-model")).toBe(true);
  } finally {
    app.store.modelCatalog.sync = original;
  }
});

test("provider catalog mappings round-trip, omitted edits keep them, blank bindings restore automatic lookup", async () => {
  const created = await api<Provider>("POST", "/api/providers", input);
  expect(created.status).toBe(201);
  expect(created.data.modelCatalog).toEqual(input.modelCatalog);
  expect(created.data.keyHint).toContain("9876");
  noSecrets(created.data);
  const saved = app.store.getProvider(created.data.id);
  expect(saved?.apiKey).toBe(input.apiKey);
  expect(resolveModelCapabilities(saved as NonNullable<typeof saved>)).toMatchObject({
    providerId: "moonshotai-cn",
    effort: false,
  });

  const { modelCatalog: _catalog, ...withoutCatalog } = input;
  const edited = await api<Provider>("PUT", `/api/providers/${created.data.id}`, {
    ...withoutCatalog,
    name: "Renamed fixture",
    apiKey: "",
    mgmtKey: "",
  });
  expect(edited.status).toBe(200);
  expect(edited.data.modelCatalog).toEqual(input.modelCatalog);
  expect(edited.data.updatedAt).toBeGreaterThan(created.data.updatedAt);
  expect(app.store.getProvider(created.data.id)?.apiKey).toBe(input.apiKey);
  expect(app.store.getProvider(created.data.id)?.mgmtKey).toBe(input.mgmtKey);
  noSecrets(edited.data);

  const cleared = await api<Provider>("PUT", `/api/providers/${created.data.id}`, {
    ...withoutCatalog,
    apiKey: "",
    modelCatalog: { ...input.modelCatalog, "shared-model": "  " },
  });
  expect(cleared.status).toBe(200);
  expect(cleared.data.modelCatalog?.["shared-model"]).toBe("");
  expect(cleared.data.modelCatalog?.["company-small"]).toBe("deepseek/shared-model");
  expect(resolveModelCapabilities(app.store.getProvider(created.data.id) as NonNullable<typeof saved>)).toMatchObject({
    providerId: "deepseek",
    effort: true,
  });
  const list = await api<{ items: Provider[] }>("GET", "/api/providers");
  expect(list.data.items.find(({ id }) => id === created.data.id)?.modelCatalog).toEqual(cleared.data.modelCatalog);
  noSecrets(list.data);
  const automatic = await api<Provider>("PUT", `/api/providers/${created.data.id}`, {
    ...withoutCatalog,
    apiKey: "",
    modelCatalog: {},
  });
  expect(automatic.data.modelCatalog).toEqual({});
  await api("DELETE", `/api/providers/${created.data.id}`);
});

test("invalid binding references or excessive maps are rejected without changing stored mappings", async () => {
  const created = await api<Provider>("POST", "/api/providers", input);
  try {
    for (const modelCatalog of [
      { "shared-model": "missing/shared-model" },
      { "shared-model": "deepseek/unknown-model" },
      { "shared-model": "https://api.deepseek.com/shared-model" },
      { "": "deepseek/shared-model" },
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`alias-${index}`, "deepseek/shared-model"])),
    ]) {
      const result = await api<{ error: string }>("PUT", `/api/providers/${created.data.id}`, {
        ...input,
        modelCatalog,
      });
      expect(result.status).toBe(400);
      expect(result.data.error).toBeTruthy();
      expect(app.store.getProvider(created.data.id)?.modelCatalog).toEqual(input.modelCatalog);
      noSecrets(result.data);
    }
    const rejected = await api("POST", "/api/providers", {
      ...input,
      modelCatalog: { "shared-model": "missing/shared-model" },
    });
    expect(rejected.status).toBe(400);
    expect(app.store.listProviders().filter(({ name }) => name === input.name)).toHaveLength(1);
  } finally {
    await api("DELETE", `/api/providers/${created.data.id}`);
  }
});

test("catalog removals preserve existing bindings without blocking unrelated edits", async () => {
  const created = await api<Provider>("POST", "/api/providers", input);
  try {
    const next = rawCatalog();
    delete (next["moonshotai-cn"].models as Record<string, unknown>)["shared-model"];
    await app.store.modelCatalog.sync((async () => Response.json(next)) as unknown as typeof fetch);
    const edited = await api<Provider>("PUT", `/api/providers/${created.data.id}`, {
      ...input,
      name: "Renamed after catalog removal",
      apiKey: "",
    });
    expect(edited.status).toBe(200);
    expect(edited.data.modelCatalog).toEqual(input.modelCatalog);
    const saved = app.store.getProvider(created.data.id);
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("Provider missing after edit");
    expect(resolveModelCapabilities(saved)).toBeNull();
    expect(saved?.apiKey).toBe(input.apiKey);

    const rejected = await api("PUT", `/api/providers/${created.data.id}`, {
      ...input,
      modelCatalog: { ...input.modelCatalog, "another-alias": "moonshotai-cn/shared-model" },
    });
    expect(rejected.status).toBe(400);
    expect(app.store.getProvider(created.data.id)?.modelCatalog).toEqual(input.modelCatalog);
  } finally {
    await app.store.modelCatalog.sync(fixtureFetch());
    await api("DELETE", `/api/providers/${created.data.id}`);
  }
});
