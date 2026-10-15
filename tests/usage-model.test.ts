import { expect, test } from "bun:test";
import { usageModel } from "../server/host";

test("turn model comes from _meta.quota.model_usage (Claude Code / Codex shape), largest row wins", () => {
  expect(usageModel({ quota: { model_usage: [{ model: "gpt-5.5", token_count: { totalTokens: 10 } }] } })).toBe(
    "gpt-5.5",
  );
  expect(
    usageModel({
      quota: {
        model_usage: [
          { model: "claude-haiku", token_count: { totalTokens: 20 } },
          { model: "claude-opus", token_count: { totalTokens: 900 } },
        ],
      },
    }),
  ).toBe("claude-opus");
  expect(usageModel({ usage: { totalTokens: 1 } })).toBeNull();
  expect(usageModel(undefined)).toBeNull();
});
