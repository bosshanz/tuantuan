import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { SERVER_ROUTES } from "./server/routes";

const api = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // Keep in sync with the server: every API and WebSocket route goes to the backend.
    proxy: Object.fromEntries([
      ...SERVER_ROUTES.http.map((p) => [p, api]),
      ...SERVER_ROUTES.ws.map((p) => [p, { target: api.replace("http", "ws"), ws: true }]),
    ]),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
