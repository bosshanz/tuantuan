import { type AppConfig, MOCK_CONFIG } from "../server/config";

/** Mock config with zero streaming delay and an overridable hop limit. */
export function testConfig(overrides: Partial<AppConfig["limits"]> = {}, router?: AppConfig["router"]): AppConfig {
  process.env.MOCK_CHUNK_DELAY_MS = "0";
  return {
    ...MOCK_CONFIG,
    router: router ?? MOCK_CONFIG.router,
    limits: { ...MOCK_CONFIG.limits, ...overrides },
  };
}
