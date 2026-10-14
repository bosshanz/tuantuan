/**
 * Every path prefix the server answers besides static files. The Vite dev server proxies exactly
 * these to the API (vite.config.ts), and a test keeps this list in sync with server/app.ts.
 */
export const SERVER_ROUTES = {
  http: ["/api", "/mcp"],
  ws: ["/ws", "/device"],
} as const;
