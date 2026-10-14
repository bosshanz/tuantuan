import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/ws": { target: api.replace("http", "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
