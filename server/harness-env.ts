import type { HarnessSpec } from "./harness";

const ISOLATION = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;

/**
 * Env for a harness process: login-shell env (incl. ANTHROPIC_* / OPENAI_* from CC Switch etc.)
 * plus optional skill-layer env, plus the agent's own overrides. Never clears provider vars.
 * Skill-layer must not set CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME — those hide the
 * user's login and model_provider (settings.json / config.toml / auth.json).
 */
export function harnessProcessEnv(
  loginEnv: Record<string, string>,
  skillEnv: Record<string, string>,
  agentEnv: Record<string, string>,
  spec: Pick<HarnessSpec, "identity">,
  identity: string,
): Record<string, string> {
  const safeSkill = { ...skillEnv };
  for (const k of ISOLATION) delete safeSkill[k];
  const env: Record<string, string> = { ...loginEnv, ...safeSkill, ...agentEnv };
  if (spec.identity === "codex-env" && identity.trim()) {
    // Merge into whatever CODEX_CONFIG the login shell already had (provider stays).
    env.CODEX_CONFIG = mergeCodexConfig(loginEnv.CODEX_CONFIG, identity);
  }
  return env;
}

/** Merge identity as developer_instructions without wiping model_provider / other keys. */
export function mergeCodexConfig(existing: string | undefined, identity: string): string {
  let prev: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      prev = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      prev = {};
    }
  }
  const prior = typeof prev.developer_instructions === "string" ? prev.developer_instructions.trim() : "";
  const next = identity.trim();
  return JSON.stringify({
    ...prev,
    developer_instructions: prior && prior !== next ? `${prior}\n\n${next}` : next,
  });
}
