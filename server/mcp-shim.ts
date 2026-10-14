#!/usr/bin/env bun
/**
 * stdio ↔ HTTP relay for Tuantuan's MCP server (see server/tuantuan-mcp.ts). Harnesses that only
 * accept stdio MCP servers launch this; every JSON-RPC line on stdin is POSTed to
 * $TUANTUAN_MCP_URL and the response is written back as one line on stdout.
 */
const url = process.env.TUANTUAN_MCP_URL;
if (!url) {
  console.error("TUANTUAN_MCP_URL is not set");
  process.exit(2);
}

let buf = "";
let chain = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) chain = chain.then(() => relay(line));
  }
});
process.stdin.on("end", () => void chain.then(() => process.exit(0)));

async function relay(line: string) {
  let id: unknown = null;
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null;
  } catch {}
  try {
    const res = await fetch(url as string, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: line,
    });
    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    process.stdout.write(`${text.trim()}\n`);
  } catch (e) {
    if (id !== null)
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `团团连接失败：${(e as Error).message}` } })}\n`,
      );
  }
}
