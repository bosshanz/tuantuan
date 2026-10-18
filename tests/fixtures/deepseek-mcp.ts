import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const marker = process.argv[2];
if (!marker) throw new Error("Missing isolated MCP marker path");
writeFileSync(marker, JSON.stringify({ pid: process.pid, cwd: process.cwd(), token: process.env.DEEPSEEK_MCP_TOKEN }));
const server = new McpServer({ name: "tuantuan-deepseek-fixture", version: "1.0.0" });
server.registerTool("fixture_echo", { inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `MCP fixture: ${text}` }],
}));
await server.connect(new StdioServerTransport());
