/** Synthetic ACP quota server: tests fail if an unsupported command becomes a model turn. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";

const configPath = process.env.MOCK_QUOTA_CONFIG ?? "";
const config = () =>
  JSON.parse(readFileSync(configPath, "utf8")) as {
    authFile: string;
    log: string;
    unsupported?: boolean;
    delay?: number;
    usageDelay?: number;
    markdown?: string;
    quotaError?: boolean;
    initializeError?: boolean;
    authSensitive?: boolean;
    accountGate?: string;
    zcode?: unknown;
  };
const record = (method: string) => appendFileSync(config().log, `${JSON.stringify({ pid: process.pid, method })}\n`);
const input = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk);
  },
});
const output = new ReadableStream<Uint8Array>({
  start(controller) {
    process.stdin.on("data", (data: Buffer) => controller.enqueue(new Uint8Array(data)));
    process.stdin.on("end", () => controller.close());
  },
});
acp
  .agent({ name: "quota-fixture" })
  .onRequest(acp.methods.agent.initialize, () => {
    record("initialize");
    if (config().initializeError) throw acp.RequestError.internalError(undefined, "fixture initialize failure");
    return { protocolVersion: acp.PROTOCOL_VERSION, authMethods: [{ id: "fixture-login", name: "Fixture login" }] };
  })
  .onRequest(acp.methods.agent.authenticate, () => {
    record("authenticate");
    writeFileSync(config().authFile, "fixture");
    return {};
  })
  .onRequest(acp.methods.agent.session.new, (ctx) => {
    record("session/new");
    const c = config();
    if (!existsSync(c.authFile)) throw acp.RequestError.authRequired();
    if (c.authSensitive) record("session/new:success");
    const sessionId = `fixture-${process.pid}`;
    setTimeout(() => {
      void ctx.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: c.unsupported ? [] : [{ name: "usage", description: "Native quota command" }],
        },
      });
    }, c.delay ?? 25);
    return { sessionId, _meta: { antigravity: { tier: { name: "Google AI Pro", id: "pro" } } } };
  })
  .onRequest("account/usage_stats", { parse: () => ({}) }, async () => {
    record("account/usage_stats");
    const captured = config();
    const authenticated = existsSync(captured.authFile);
    const response =
      captured.authSensitive && !authenticated
        ? { glm: { kind: "auth_error" } }
        : (captured.zcode ?? { glm: { kind: "unavailable" } });
    if (captured.authSensitive) record(`captured:${authenticated ? "success" : "auth_error"}`);
    if (captured.delay) await Bun.sleep(captured.delay);
    if (captured.authSensitive && !authenticated && captured.accountGate)
      while (!existsSync(captured.accountGate)) await Bun.sleep(10);
    if (captured.quotaError) throw acp.RequestError.internalError(undefined, "fixture failure");
    if (captured.authSensitive) record(`completed:${authenticated ? "success" : "auth_error"}`);
    return response;
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const raw = ctx.params.prompt;
    const valid = raw.length === 1 && raw[0]?.type === "text" && raw[0].text === "/usage";
    if (!valid || config().unsupported) {
      record("MODEL_CALL");
      throw acp.RequestError.internalError(undefined, "forbidden model call");
    }
    record("prompt:/usage");
    if (!existsSync(config().authFile)) throw acp.RequestError.authRequired();
    if (config().quotaError) throw acp.RequestError.internalError(undefined, "fixture failure");
    const usageDelay = config().usageDelay;
    if (usageDelay) await Bun.sleep(usageDelay);
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: config().markdown ?? "### Quota Limits\n- data not available yet" },
      },
    });
    return { stopReason: "end_turn" as const };
  })
  .connect(acp.ndJsonStream(input, output));
