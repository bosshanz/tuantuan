import { resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

/**
 * Tuantuan's own MCP server, injected into group sessions so agents can hand off work
 * (`handoff`, `list_members`).
 *
 * One endpoint per (room, agent) at /mcp/<token>, speaking MCP JSON-RPC over plain HTTP POST
 * (Streamable HTTP with JSON responses). Harnesses that only take stdio MCP servers get
 * server/mcp-shim.ts, which relays stdio lines to that endpoint. The token is random and only
 * lives in memory, so it doubles as the capability: knowing it means being that agent in that room.
 */
export interface ToolCtx {
  roomId: string;
  agentId: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolProvider {
  tools(ctx: ToolCtx): ToolDef[];
  call(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<string>;
}

export const MCP_SERVER_NAME = "tuantuan";
const SHIM = resolve(import.meta.dir, "mcp-shim.ts");
const PROTOCOL = "2025-06-18";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export class TuantuanMcp {
  baseUrl = "";
  provider: ToolProvider | null = null;
  private tokens = new Map<string, ToolCtx>();
  private byPair = new Map<string, string>();

  tokenFor(ctx: ToolCtx): string {
    const key = `${ctx.roomId}|${ctx.agentId}`;
    let t = this.byPair.get(key);
    if (!t) {
      t = crypto.randomUUID().replaceAll("-", "");
      this.byPair.set(key, t);
      this.tokens.set(t, { ...ctx });
    }
    return t;
  }

  /** The ACP mcpServers entry for this agent in this room: HTTP when the harness supports it, else the stdio shim. */
  serverEntry(ctx: ToolCtx, caps: acp.McpCapabilities | undefined): acp.McpServer | null {
    if (!this.baseUrl || !this.provider || this.provider.tools(ctx).length === 0) return null;
    const url = `${this.baseUrl}/mcp/${this.tokenFor(ctx)}`;
    if (caps?.http) return { type: "http", name: MCP_SERVER_NAME, url, headers: [] };
    return {
      name: MCP_SERVER_NAME,
      command: process.execPath,
      args: [SHIM],
      env: [{ name: "TUANTUAN_MCP_URL", value: url }],
    };
  }

  async handle(token: string, req: Request): Promise<Response> {
    const ctx = this.tokens.get(token);
    if (!ctx) return new Response("unknown MCP endpoint", { status: 404 });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
    let body: Rpc | Rpc[];
    try {
      body = await req.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
    }
    const batch = Array.isArray(body) ? body : [body];
    const out: unknown[] = [];
    for (const m of batch) {
      const r = await this.rpc(ctx, m);
      if (r) out.push(r);
    }
    if (out.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0], {
      headers: { "Mcp-Session-Id": token.slice(0, 16) },
    });
  }

  private async rpc(ctx: ToolCtx, m: Rpc): Promise<unknown | null> {
    if (m.id === undefined || m.id === null) return null; // notification
    const provider = this.provider as ToolProvider;
    switch (m.method) {
      case "initialize":
        return ok(m.id, {
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "团团", version: "1.0" },
          instructions: "团团会话工具。",
        });
      case "ping":
        return ok(m.id, {});
      case "tools/list":
        return ok(m.id, { tools: provider.tools(ctx) });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        if (!provider.tools(ctx).some((t) => t.name === name)) return rpcError(m.id, -32602, `未知工具：${name}`);
        try {
          const text = await provider.call(ctx, name, args);
          return ok(m.id, { content: [{ type: "text", text }], isError: false });
        } catch (e) {
          return ok(m.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
}

const ok = (id: string | number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
