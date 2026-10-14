import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInput } from "../server/store";

// The mock ACP agent (server/mock-agent.ts) is a dev-only harness; tests opt in.
process.env.TUANTUAN_MOCK_HARNESS = "1";
// Mock login state: present = logged in. The auth test deletes it to exercise `authenticate`.
export const MOCK_AUTH_FILE = join(tmpdir(), `tuantuan-mock-auth-${process.pid}`);
process.env.MOCK_AGENT_AUTH_FILE = MOCK_AUTH_FILE;
writeFileSync(MOCK_AUTH_FILE, "ok");

/** Agent bound to the mock ACP harness. */
export function agentInput(name: string, extra: Partial<AgentInput> = {}): AgentInput {
  return {
    name,
    color: "#336699",
    avatar: name.slice(0, 1),
    identity: "",
    harness: "mock",
    cwd: "",
    env: {},
    mcpServerIds: [],
    permissionPolicy: "ask",
    ...extra,
  };
}

export async function until<T>(get: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(10);
  }
}
