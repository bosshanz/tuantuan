import { z } from "zod";

// New effort IDs must not invalidate a complete catalog update. Keep them opaque;
// only a matching native runtime can establish how to send them to a provider.
const effort = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
  .nullable();
export const ReasoningOption = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }),
  z.object({ type: z.literal("effort"), values: z.array(effort) }),
  z.object({
    type: z.literal("budget_tokens"),
    min: z.number().finite().min(-1).optional(),
    max: z.number().finite().nonnegative().optional(),
  }),
]);

// Allowlist only facts used by the adapters. In particular, catalog headers, request
// bodies, npm packages and executable settings never enter a user's configuration.
export const CatalogModel = z.object({
  name: z.string(),
  reasoning: z.boolean(),
  reasoning_options: z.array(ReasoningOption).optional(),
  interleaved: z
    .union([z.literal(true), z.object({ field: z.enum(["reasoning_content", "reasoning_details"]) })])
    .optional(),
  limit: z.object({
    context: z.number().finite().nonnegative(),
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative(),
  }),
  modalities: z.object({ input: z.array(z.string()) }),
});
export const CatalogProviders = z.record(
  z.string(),
  z.object({ name: z.string(), api: z.string().optional(), models: z.record(z.string(), CatalogModel) }),
);
export const CatalogSnapshot = z.object({
  version: z.literal(1),
  source: z.object({ url: z.string(), fetchedAt: z.string(), sha256: z.string() }),
  providers: CatalogProviders,
});
export type CatalogData = z.infer<typeof CatalogSnapshot>;

export function catalogSnapshot(raw: string, fetchedAt: string): CatalogData {
  const providers = CatalogProviders.parse(JSON.parse(raw));
  if (!Object.keys(providers).length) throw new Error("models.dev returned an empty catalog");
  return {
    version: 1,
    source: {
      url: "https://models.dev/api.json",
      fetchedAt,
      sha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
    },
    providers,
  };
}

/** Bounded public download: no provider keys, user model IDs or conversation data. */
export async function downloadModelCatalog(fetcher: typeof fetch = fetch): Promise<CatalogData> {
  const response = await fetcher("https://models.dev/api.json", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status}`);
  if (!response.body) throw new Error("models.dev returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 15_000_000) throw new Error("models.dev catalog exceeds 15 MB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return catalogSnapshot(Buffer.concat(chunks).toString("utf8"), new Date().toISOString());
}
