import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { MessageStatus, Store } from "../server/store";
import { emptyTimeline } from "../shared/timeline";

/** Exercise request-scoped edits in a real browser against persisted, interleaved messages. */
export async function sessionChangesSmoke(browser: Browser, base: string, store: Store) {
  const scratch = mkdtempSync(join(tmpdir(), "tt-run-changes-e2e-"));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`request changes fixture ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const agents: { id: string; name: string }[] = [];
  let projectId = "";
  let roomId = "";
  try {
    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src", "shared.ts"), "current on disk\n");
    const leader = await post<{ id: string; name: string }>("/api/agents", { name: "改动主理人", harness: "mock" });
    agents.push(leader);
    const reviewer = await post<{ id: string; name: string }>("/api/agents", { name: "改动审查员", harness: "mock" });
    agents.push(reviewer);
    projectId = (await post<{ id: string }>("/api/projects", { name: "按请求回归", cwd: scratch })).id;
    roomId = (
      await post<{ id: string }>("/api/rooms", {
        name: "按请求回看改动",
        agentIds: agents.map((agent) => agent.id),
        mainAgentId: leader.id,
        projectId,
      })
    ).id;

    const human = (content: string) => {
      const id = crypto.randomUUID();
      return store.insertMessage({
        id,
        roomId,
        runId: id,
        hop: 0,
        senderKind: "human",
        senderId: null,
        senderName: "我",
        content,
        status: "done",
      });
    };
    const edit = (runId: string, agent: (typeof agents)[number], text: string, status: MessageStatus = "done") => {
      const toolCallId = crypto.randomUUID();
      const message = store.insertMessage({
        roomId,
        runId,
        hop: 1,
        senderKind: "agent",
        senderId: agent.id,
        senderName: agent.name,
        content: `${text} 回复`,
        status,
      });
      return store.updateReply(message.id, {
        content: message.content,
        status,
        timeline: {
          ...emptyTimeline(),
          parts: [
            { kind: "text", text: message.content },
            { kind: "tool", toolCallId },
          ],
          tools: {
            [toolCallId]: {
              toolCallId,
              title: "修改共享文件",
              kind: "edit",
              status: "completed",
              locations: [{ path: "src/shared.ts" }],
              content: [{ type: "diff", path: "src/shared.ts", oldText: "original\n", newText: `${text}\n` }],
            },
          },
        },
      });
    };
    const first = human("第一轮改动共享文件");
    edit(first.id, leader, "第一轮主理人内容");
    for (let index = 0; index < 42; index++) human(`中间请求 ${index + 1}`);
    const second = human("@改动审查员 第二轮改动共享文件");
    edit(second.id, reviewer, "第二轮审查员内容");
    edit(first.id, reviewer, "第一轮中断前内容", "interrupted");

    await page.goto(`${base}/#/c/${roomId}`);
    const firstRow = page.locator(`[data-message-id="${first.id}"]`);
    await firstRow.getByRole("button", { name: "查看本轮改动", exact: true }).click();
    const workbench = page.getByRole("complementary", { name: "会话文件与改动", exact: true });
    const row = workbench.locator('.session-change-row[data-path="src/shared.ts"]');
    const details = workbench.locator(".session-change-edit");
    await row.waitFor();
    await row.click();
    await details.filter({ hasText: "第一轮主理人内容" }).waitFor();
    await details.filter({ hasText: "第一轮中断前内容" }).waitFor();
    if ((await details.count()) !== 2 || (await details.filter({ hasText: "第二轮审查员内容" }).count()) !== 0)
      throw new Error("first request included edits from a different interleaved run");
    await details.filter({ hasText: "第一轮中断前内容" }).getByText("已中断", { exact: true }).waitFor();

    const scope = workbench.getByRole("combobox", { name: "改动范围", exact: true });
    await scope.selectOption({ label: "最近一次请求" });
    await row.waitFor();
    await row.click();
    await details.filter({ hasText: "第二轮审查员内容" }).waitFor();
    if ((await details.count()) !== 1 || (await details.filter({ hasText: "第一轮主理人内容" }).count()) !== 0)
      throw new Error("latest request detail mixed edits from earlier requests");

    await scope.selectOption({ label: "全部历史" });
    await row.waitFor();
    await row.click();
    await details.filter({ hasText: "第一轮主理人内容" }).waitFor();
    await details.filter({ hasText: "第二轮审查员内容" }).waitFor();
    if ((await details.count()) !== 3) throw new Error("all-history detail omitted a completed edit");

    await workbench.getByRole("button", { name: "加载更早请求", exact: true }).click();
    const firstOption = scope.locator(`option[value="request:${first.id}"]`);
    await firstOption.waitFor({ state: "attached" });
    await scope.selectOption(`request:${first.id}`);
    await row.waitFor();
    await row.click();
    await details.filter({ hasText: "第一轮中断前内容" }).waitFor();
    if ((await details.count()) !== 2) throw new Error("selecting an older request did not filter the detail");

    await firstRow.getByRole("button", { name: "查看本轮改动", exact: true }).click();
    await row.waitFor();
    await row.click();
    await details.filter({ hasText: "第一轮中断前内容" }).waitFor();
    if ((await details.count()) !== 2) throw new Error("request shortcut did not replace the all-history scope");
    if (errors.length) throw new Error(`request changes browser errors: ${errors.join("; ")}`);
    console.log(
      "PASS request changes: original-message shortcut, interleaved same-path edits, interrupted reply, latest and all history",
    );
  } finally {
    await page.close();
    if (roomId) await fetch(`${base}/api/rooms/${roomId}`, { method: "DELETE" });
    if (projectId) await fetch(`${base}/api/projects/${projectId}`, { method: "DELETE" });
    for (const agent of agents) await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
    rmSync(scratch, { recursive: true, force: true });
  }
}
