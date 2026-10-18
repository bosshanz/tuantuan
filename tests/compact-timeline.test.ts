import { expect, test } from "bun:test";
import { currentToolOf, type Timeline, timelineBodyPhases, timelineProcess } from "../shared/timeline";

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

test("body phases share stable timeline indices and preserve each group's raw text and images", () => {
  const t = timeline({
    parts: [
      { kind: "text", text: " \n" },
      { kind: "thought", text: "不进入正文" },
      { kind: "text", text: "先确认目标。\n\n" },
      { kind: "text", text: "保留换行\n" },
      { kind: "image", mimeType: "image/png", data: "first-image" },
      { kind: "text", text: "\n图后说明" },
      { kind: "text", text: " \n" },
      { kind: "tool", toolCallId: "boundary" },
      { kind: "image", mimeType: "image/png", data: "second-image" },
      { kind: "image", mimeType: "image/png", data: "adjacent-image" },
      { kind: "thought", text: "另一段思考" },
      { kind: "text", text: "\n" },
      { kind: "text", text: "第二段\n结果" },
      { kind: "tool", toolCallId: "trailing" },
      { kind: "text", text: " \t" },
    ],
  });
  const phases = timelineBodyPhases(t);
  expect(phases.map((phase) => phase.start)).toEqual([2, 8, 12]);
  expect(phases.map((phase) => phase.parts.map(({ index }) => index))).toEqual([[2, 3, 4, 5], [8, 9], [12]]);
  expect(phases.map((phase) => phase.text)).toEqual(["先确认目标。\n\n保留换行\n\n图后说明", "", "第二段\n结果"]);
  expect(phases[0]?.parts[0]?.part === t.parts[2]).toBe(true);
  expect(
    timelineBodyPhases({ ...t, parts: [...t.parts, { kind: "text", text: "后来追加" }] }).map((p) => p.start),
  ).toEqual([2, 8, 12, 15]);
});

test("absent timelines and whitespace-only body content never create a phase", () => {
  expect(timelineBodyPhases(null)).toEqual([]);
  expect(timelineBodyPhases(undefined)).toEqual([]);
  expect(
    timelineBodyPhases(
      timeline({
        parts: [
          { kind: "text", text: "\n \t" },
          { kind: "thought", text: "内部" },
        ],
      }),
    ),
  ).toEqual([]);
});
