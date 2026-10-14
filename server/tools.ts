import { ROBOT_ACTIONS, ROBOT_EXPRESSIONS } from "./device-protocol";
import type { ToolSpec } from "./llm";
import type { McpConnections } from "./mcp";
import type { Skill } from "./skills";

export interface BuiltinTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  web_fetch: {
    spec: fn("web_fetch", "抓取一个 http(s) 网页并返回纯文本（最多 20000 字符）", { url: { type: "string" } }, ["url"]),
    async run(args, signal) {
      const url = new URL(String(args.url ?? ""));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http/https URL");
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const raw = await res.text();
      const text = /html/i.test(res.headers.get("content-type") ?? "")
        ? raw
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
        : raw;
      return text.slice(0, 20_000);
    },
  },
  calculator: {
    spec: fn("calculator", "计算算术表达式，支持 + - * / % ^ 和括号", { expression: { type: "string" } }, [
      "expression",
    ]),
    async run(args) {
      return String(evaluateExpression(String(args.expression ?? "")));
    },
  },
  current_time: {
    spec: fn(
      "current_time",
      "返回当前时间（ISO 8601 与本地化格式），可指定 IANA 时区，默认 Asia/Shanghai",
      { timezone: { type: "string" } },
      [],
    ),
    async run(args) {
      const timeZone = typeof args.timezone === "string" && args.timezone ? args.timezone : "Asia/Shanghai";
      const now = new Date();
      const local = now.toLocaleString("zh-CN", { timeZone, hour12: false }); // throws RangeError on bad zone
      return JSON.stringify({ iso_utc: now.toISOString(), timezone: timeZone, local });
    },
  },
};

/** Recursive-descent arithmetic evaluator; no eval. Throws on malformed input or non-finite results. */
export function evaluateExpression(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|[-+*/%^()]|\S/gi) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const primary = (): number => {
    const t = take();
    if (t === "(") {
      const v = additive();
      if (take() !== ")") throw new Error("括号不匹配");
      return v;
    }
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw new Error(`无法识别的符号: ${t ?? "表达式结尾"}`);
  };
  // Unary minus binds looser than ^ so "-2^2" is -4, as in conventional math notation.
  const unary = (): number => {
    if (peek() === "-") {
      take();
      return -unary();
    }
    if (peek() === "+") {
      take();
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = primary();
    if (peek() === "^") {
      take();
      return base ** unary();
    }
    return base;
  };
  const multiplicative = (): number => {
    let v = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("除数为 0");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const additive = (): number => {
    let v = multiplicative();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + multiplicative() : v - multiplicative();
    return v;
  };
  if (tokens.length === 0) throw new Error("表达式为空");
  const value = additive();
  if (pos !== tokens.length) throw new Error(`多余的符号: ${tokens[pos]}`);
  if (!Number.isFinite(value)) throw new Error("结果不是有限数");
  return value;
}

export interface McpServerRef {
  id: string;
  url: string;
}

/** Sends a body command to the device of the current room and resolves with its ack. */
export interface DeviceControl {
  command(kind: "expression" | "action", name: string, signal?: AbortSignal): Promise<string>;
}

export const ROBOT_TOOL_NAMES = ["robot_express", "robot_action"] as const;

export const HANDOFF_TOOL = "handoff";

/** Agent-to-agent hand-off is an explicit tool call; plain "@名字" in reply text never triggers anyone. */
export interface HandoffControl {
  /** Other agents in the room, by name. */
  targets: { id: string; name: string }[];
  /** Records the hand-off; the orchestrator runs the target after this reply finishes. */
  record(target: { id: string; name: string }, task: string): void;
}

export interface ToolRuntime {
  specs: ToolSpec[];
  /** Runs a tool by its function name; throws with a truthful message on any failure. */
  execute(name: string, argsJson: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Builds the tools an agent can call for one turn. Tool ids stored on agents:
 *   "builtin:<name>"  or  "mcp:<serverId>:<toolName>"
 * `load_skill` is added automatically when the agent has skills.
 */
export async function buildToolRuntime(opts: {
  toolIds: string[];
  skills: Skill[];
  mcpServers: McpServerRef[];
  mcp: McpConnections;
  /** Present when the conversation belongs to a device; adds robot_express / robot_action. */
  device?: DeviceControl;
  /** Present in group rooms with other agents; adds the `handoff` tool. */
  handoff?: HandoffControl;
}): Promise<{ runtime: ToolRuntime; warnings: string[] }> {
  const specs: ToolSpec[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>>();
  const warnings: string[] = [];
  const mcpToolsByServer = new Map<
    string,
    Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>
  >();

  for (const id of opts.toolIds) {
    const [kind, a, ...rest] = id.split(":");
    if (kind === "builtin" && a && BUILTIN_TOOLS[a]) {
      const tool = BUILTIN_TOOLS[a];
      specs.push(tool.spec);
      handlers.set(a, tool.run);
    } else if (kind === "mcp" && a && rest.length > 0) {
      const toolName = rest.join(":");
      const server = opts.mcpServers.find((s) => s.id === a);
      if (!server) {
        warnings.push(`MCP 服务 ${a} 已不存在，工具 ${toolName} 不可用`);
        continue;
      }
      let listing = mcpToolsByServer.get(server.id);
      if (!listing) {
        listing = opts.mcp.listTools(server.id, server.url);
        mcpToolsByServer.set(server.id, listing);
      }
      try {
        const info = (await listing).find((t) => t.name === toolName);
        if (!info) {
          warnings.push(`MCP 服务 ${server.url} 不再提供工具 ${toolName}`);
          continue;
        }
        const fnName = `mcp_${server.id.slice(0, 8)}_${toolName}`.replace(/[^\w-]/g, "_").slice(0, 64);
        specs.push({
          type: "function",
          function: { name: fnName, description: info.description, parameters: info.inputSchema },
        });
        handlers.set(fnName, (args, signal) => opts.mcp.callTool(server.id, server.url, toolName, args, signal));
      } catch (e) {
        warnings.push((e as Error).message);
      }
    } else {
      warnings.push(`未知工具 ${id}`);
    }
  }

  if (opts.skills.length > 0) {
    const byName = new Map(opts.skills.map((s) => [s.name, s]));
    specs.push(
      fn(
        "load_skill",
        "加载一个 Skill 的完整说明（正文），在任务与该 Skill 描述相关时调用",
        { name: { type: "string", enum: opts.skills.map((s) => s.name) } },
        ["name"],
      ),
    );
    handlers.set("load_skill", async (args) => {
      const skill = byName.get(String(args.name));
      if (!skill) throw new Error(`没有名为 ${String(args.name)} 的 Skill`);
      return skill.body;
    });
  }

  if (opts.handoff && opts.handoff.targets.length > 0) {
    const h = opts.handoff;
    specs.push(
      fn(
        HANDOFF_TOOL,
        "把当前用户请求中的一部分工作交给群里另一个 Agent，对方会在你回复后立即接手。只在用户这次的请求确实需要对方现在动手时调用；不要用来介绍、推荐或预告别人能做什么。",
        {
          agent: { type: "string", enum: h.targets.map((t) => t.name), description: "接手的 Agent 名称" },
          task: { type: "string", description: "交给对方的具体任务，一两句话" },
        },
        ["agent", "task"],
      ),
    );
    handlers.set(HANDOFF_TOOL, async (args) => {
      const target = h.targets.find((t) => t.name === String(args.agent));
      if (!target) throw new Error(`群里没有名为 ${String(args.agent)} 的其他 Agent`);
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("task 不能为空");
      h.record(target, task);
      return `已交接给 ${target.name}，对方会在你回复后接手。请在回复里用一句话告诉用户你交给了谁、交了什么，不要再写 @。`;
    });
  }

  if (opts.device) {
    const device = opts.device;
    specs.push(
      fn(
        "robot_express",
        "设置桌面机器人的表情，用来配合你的回复表达情绪",
        { expression: { type: "string", enum: [...ROBOT_EXPRESSIONS] } },
        ["expression"],
      ),
      fn("robot_action", "让桌面机器人做一个身体动作", { action: { type: "string", enum: [...ROBOT_ACTIONS] } }, [
        "action",
      ]),
    );
    handlers.set("robot_express", (args, signal) => device.command("expression", String(args.expression), signal));
    handlers.set("robot_action", (args, signal) => device.command("action", String(args.action), signal));
  }

  return {
    warnings,
    runtime: {
      specs,
      async execute(name, argsJson, signal) {
        const handler = handlers.get(name);
        if (!handler) throw new Error(`工具 ${name} 不存在或未授权给该 Agent`);
        let args: unknown;
        try {
          args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
        } catch {
          throw new Error(`工具参数不是合法 JSON: ${argsJson.slice(0, 200)}`);
        }
        if (typeof args !== "object" || args === null || Array.isArray(args))
          throw new Error("工具参数必须是 JSON 对象");
        return handler(args as Record<string, unknown>, signal);
      },
    },
  };
}
