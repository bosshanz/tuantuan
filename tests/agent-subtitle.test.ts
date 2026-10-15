import { expect, test } from "bun:test";
import { agentSubtitle } from "../web/src/config";

test("sidebar subtitle: short harness · friendly model, no internal ids", () => {
  expect(agentSubtitle("ZCode（社区桥接）", { model: "builtin:bigmodel/glm-4.6" })).toBe("ZCode · glm-4.6");
  expect(agentSubtitle("Codex", { model: "gpt-5.5", reasoning_effort: "high" })).toBe("Codex · gpt-5.5");
  expect(agentSubtitle("Grok Build", undefined)).toBe("Grok Build");
});
