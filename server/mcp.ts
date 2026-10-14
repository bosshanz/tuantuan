import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Owns live MCP client connections (streamable HTTP), keyed by server id.
 * Connections are opened lazily and dropped on any error so the next call reconnects;
 * errors are always surfaced to the caller.
 */
export class McpConnections {
  private clients = new Map<string, Promise<Client>>();

  private connect(id: string, url: string): Promise<Client> {
    let p = this.clients.get(id);
    if (!p) {
      p = (async () => {
        const client = new Client({ name: "tuantuan", version: "0.1.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        return client;
      })();
      this.clients.set(id, p);
      p.catch(() => this.clients.delete(id));
    }
    return p;
  }

  async listTools(id: string, url: string): Promise<McpToolInfo[]> {
    try {
      const client = await this.connect(id, url);
      const { tools } = await client.listTools();
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch (e) {
      await this.drop(id);
      throw new Error(`MCP 服务 ${url} 列出工具失败: ${(e as Error).message}`);
    }
  }

  async callTool(
    id: string,
    url: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      const client = await this.connect(id, url);
      result = await client.callTool({ name, arguments: args }, undefined, { signal });
    } catch (e) {
      await this.drop(id);
      throw new Error(`MCP 调用 ${name} 失败: ${(e as Error).message}`);
    }
    const content = (result.content ?? []) as { type: string; text?: string }[];
    const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} 内容]`)).join("\n");
    if (result.isError) throw new Error(`MCP 工具 ${name} 返回错误: ${text}`);
    return text;
  }

  async drop(id: string): Promise<void> {
    const p = this.clients.get(id);
    this.clients.delete(id);
    if (p) await p.then((c) => c.close()).catch(() => {});
  }
}
