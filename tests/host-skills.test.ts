import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContentBlock,
  methods,
  type PromptRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { HarnessHost } from "../server/host";
import { setSkillLinked } from "../server/skills";
import { Store } from "../server/store";
import { agentInput } from "./helpers";

const scratch = mkdtempSync(join(tmpdir(), "tt-host-skills-"));
const oldHome = process.env.TUANTUAN_SKILLS_HOME;
process.env.TUANTUAN_SKILLS_HOME = join(scratch, "home");
const store = new Store(":memory:");
const events = { session() {}, permission() {}, terminal() {} };
const hosts: HarnessHost[] = [];
function host() {
  const value = new HarnessHost(store, join(scratch, "data"), events);
  hosts.push(value);
  return value;
}
afterAll(async () => {
  for (const value of hosts) value.shutdown();
  await Bun.sleep(100);
  store.db.close();
  if (oldHome === undefined) delete process.env.TUANTUAN_SKILLS_HOME;
  else process.env.TUANTUAN_SKILLS_HOME = oldHome;
  rmSync(scratch, { recursive: true, force: true });
});

test("a long-lived ACP session refreshes only its Agent's index, picker, and read grants each turn", async () => {
  const cwd = join(scratch, "project");
  mkdirSync(cwd);
  const project = store.createProject("scoped", cwd);
  const a = store.createAgent(agentInput("ScopedA", { env: { MOCK_AGENT_SESSION_DIR: join(scratch, "sessions-a") } }));
  const b = store.createAgent(agentInput("ScopedB"));
  const room = store.createRoom("shared", [a.id, b.id], { projectId: project.id });
  const source = join(scratch, "selected");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "---\nname: chosen\ndescription: Selected fixture\n---\nSECRET SKILL BODY");
  const h = host();
  setSkillLinked(join(scratch, "data"), a.id, source, true);
  const before = await h.session(room, a, "test identity");
  const sessionId = before.slot.view.sessionId;
  if (!sessionId) throw new Error("missing mock session");
  const request = spyOn(before.proc.acp.agent, "request");
  const updates: string[] = [];
  const run = () =>
    h.prompt(
      room,
      a,
      "test identity",
      [{ type: "text", text: "hello" }],
      (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
          updates.push(update.content.text);
      },
      new AbortController().signal,
    );
  const read = before.proc.acp as unknown as { readTextFile(p: ReadTextFileRequest): Promise<ReadTextFileResponse> };
  try {
    await run();
    expect(updates.join("")).toContain("收到：「hello」");
    const prompts = () =>
      request.mock.calls
        .filter(([method]) => method === methods.agent.session.prompt)
        .map(([, params]) => params as PromptRequest);
    const indexOf = (blocks: ContentBlock[] = []) =>
      blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .find((text) => text.includes("<tuantuan-skills>"));
    expect(indexOf(prompts()[0]?.prompt)).toContain(join(source, "SKILL.md"));
    expect(indexOf(prompts()[0]?.prompt)).not.toContain("SECRET SKILL BODY");
    expect(h.view(room.id, a.id)?.skills.map((skill) => skill.name)).toContain("chosen");
    expect(await read.readTextFile({ sessionId: sessionId, path: join(source, "SKILL.md") })).toEqual({
      content: "---\nname: chosen\ndescription: Selected fixture\n---\nSECRET SKILL BODY",
    });
    const other = await h.session(room, b, "other identity");
    expect(other.slot.view.skills.map((skill) => skill.name)).not.toContain("chosen");
    const otherRead = other.proc.acp as unknown as typeof read;
    await expect(
      otherRead.readTextFile({ sessionId: other.slot.view.sessionId ?? "", path: join(source, "SKILL.md") }),
    ).rejects.toThrow();
    expect(existsSync(join(cwd, ".agents"))).toBe(false);
    const notifications = h as unknown as { onUpdate(proc: unknown, notification: SessionNotification): void };
    notifications.onUpdate(before.proc, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "$native-reported", description: "Actual harness capability" }],
      },
    });
    setSkillLinked(join(scratch, "data"), a.id, source, false);
    await run();
    expect(indexOf(prompts()[1]?.prompt)).toContain("[]");
    expect(h.view(room.id, a.id)?.skills.map((skill) => skill.name)).not.toContain("chosen");
    expect(h.view(room.id, a.id)?.skills.map((skill) => skill.name)).toContain("native-reported");
    expect((await h.session(room, a, "test identity")).proc).toBe(before.proc);
    await expect(read.readTextFile({ sessionId: sessionId, path: join(source, "SKILL.md") })).rejects.toThrow();
    // Restart and resume the saved ACP session: the next prompt must receive a fresh selection too.
    request.mockRestore();
    h.shutdown();
    const resumed = host();
    setSkillLinked(join(scratch, "data"), a.id, source, true);
    const attached = await resumed.session(room, a, "test identity");
    expect(attached.slot.view.sessionId).toBe(before.slot.view.sessionId);
    const resumedRequest = spyOn(attached.proc.acp.agent, "request");
    try {
      await resumed.prompt(
        room,
        a,
        "test identity",
        [{ type: "text", text: "after resume" }],
        () => {},
        new AbortController().signal,
      );
      const prompt = resumedRequest.mock.calls.find(
        ([method]) => method === methods.agent.session.prompt,
      )?.[1] as PromptRequest;
      expect(indexOf(prompt.prompt)).toContain(join(source, "SKILL.md"));
    } finally {
      resumedRequest.mockRestore();
    }
  } finally {
    request.mockRestore();
  }
});

test("slash commands preserve raw blocks before delayed declarations and defer first-prompt identity", async () => {
  const cwd = join(scratch, "native-command-project");
  mkdirSync(cwd);
  const project = store.createProject("native commands", cwd);
  const agent = store.createAgent(agentInput("NativeCommands", { env: { MOCK_AGENT_COMMAND_DELAY_MS: "100" } }));
  const room = store.createRoom("native commands", [agent.id], { projectId: project.id });
  const h = host();
  const attached = await h.session(room, agent, "identity deferred to normal chat");
  expect(attached.slot.view.commands).toEqual([]);
  const request = spyOn(attached.proc.acp.agent, "request");
  const prompt = (blocks: ContentBlock[]) =>
    h.prompt(room, agent, "identity deferred to normal chat", blocks, () => {}, new AbortController().signal);
  const sent = () =>
    request.mock.calls
      .filter(([method]) => method === methods.agent.session.prompt)
      .map(([, params]) => (params as PromptRequest).prompt);
  try {
    const raw: ContentBlock[] = [{ type: "text", text: "/plan with arguments" }];
    await prompt(raw);
    expect(sent()[0]).toEqual(raw);
    expect(attached.slot.view.commands.map((command) => command.name)).toContain("plan");
    expect(attached.slot.identityPending).toBe(true);
    await prompt([{ type: "text", text: "ordinary message" }]);
    expect(JSON.stringify(sent()[1])).toContain("<tuantuan-identity>");
    expect(JSON.stringify(sent()[1])).toContain("<tuantuan-skills>");
    expect(attached.slot.identityPending).toBe(false);
    await prompt(raw);
    expect(sent()[2]).toEqual(raw);
    const unknown: ContentBlock[] = [{ type: "text", text: "  /not-yet-declared argument" }];
    await prompt(unknown);
    expect(sent()[3]).toEqual(unknown);
  } finally {
    request.mockRestore();
  }
});
