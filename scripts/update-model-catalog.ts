import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { downloadModelCatalog } from "../server/model-catalog-schema";

// Explicit maintenance operation: application startup and conversations never fetch
// remote model metadata. Failed downloads/validation leave the bundled snapshot intact.
const data = await downloadModelCatalog();
const target = join(import.meta.dir, "../server/data/models-dev.json");
const temporary = `${target}.${process.pid}.tmp`;
await mkdir(dirname(target), { recursive: true });
try {
  await Bun.write(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temporary, target);
} finally {
  await rm(temporary, { force: true });
}
const models = Object.values(data.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
console.log(
  `models.dev: ${Object.keys(data.providers).length} providers, ${models} models; SHA-256 ${data.source.sha256}`,
);
