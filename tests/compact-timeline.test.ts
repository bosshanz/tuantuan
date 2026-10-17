import { expect, test } from "bun:test";
import { currentToolOf, type Timeline, timelineProcess } from "../shared/timeline";

const timeline = (t: Partial<Timeline>): Timeline => ({ parts: [], tools: {}, plan: null, ...t });
const tool = (id: string, status: string): Timeline["tools"][string] => ({
  toolCallId: id,
  title: `工具 ${id}`,
  kind: "execute",
  status,
  content: [],
  locations: [],
});

test("timelineProcess folds tools, thoughts and plan into one summary count", () => {
  const t = timeline({
    parts: [
      { kind: "thought", text: "a" },
      { kind: "tool", toolCallId: "t1" },
      { kind: "text", text: "做完" },
      { kind: "tool", toolCallId: "t2" },
      { kind: "thought", text: "b" },
      { kind: "image", mimeType: "image/png", data: "" },
    ],
    tools: { t1: tool("t1", "completed"), t2: tool("t2", "failed") },
    plan: [
      { content: "跑测试", status: "completed", priority: "high" },
      { content: "打包", status: "in_progress", priority: "medium" },
      { content: "发布", status: "pending", priority: "low" },
    ],
  });
  expect(timelineProcess(t)).toEqual({ tools: 2, thoughts: 2, planDone: 1, planTotal: 3, failed: 1 });
  // A tool call without an update entry still counts as one tool, never as failed.
  const orphan = timeline({ parts: [{ kind: "tool", toolCallId: "gone" }] });
  expect(timelineProcess(orphan)).toEqual({ tools: 1, thoughts: 0, planDone: 0, planTotal: 0, failed: 0 });
  expect(timelineProcess(null)).toEqual({ tools: 0, thoughts: 0, planDone: 0, planTotal: 0, failed: 0 });
});

test("currentToolOf names the running tool only while it is pending or in progress", () => {
  const withStatus = (status: string) =>
    timeline({
      parts: [
        { kind: "thought", text: "x" },
        { kind: "tool", toolCallId: "t1" },
      ],
      tools: { t1: tool("t1", status) },
    });
  expect(currentToolOf(withStatus("in_progress"))).toBe("工具 t1");
  expect(currentToolOf(withStatus("pending"))).toBe("工具 t1");
  expect(currentToolOf(withStatus("completed"))).toBeNull();
  // The newest tool already finished: nothing is running even if older tools are live.
  const stale = timeline({
    parts: [
      { kind: "tool", toolCallId: "t1" },
      { kind: "text", text: "中段" },
      { kind: "tool", toolCallId: "t2" },
    ],
    tools: { t1: tool("t1", "in_progress"), t2: tool("t2", "completed") },
  });
  expect(currentToolOf(stale)).toBeNull();
  expect(currentToolOf(timeline({ parts: [{ kind: "text", text: "纯文本" }] }))).toBeNull();
});
