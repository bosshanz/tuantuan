// Starts the API server (watch mode) and the Vite dev server; stops both when either exits.
export {};

const procs = [
  Bun.spawn(["bun", "--watch", "server/main.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite"], { stdout: "inherit", stderr: "inherit" }),
];
const stop = () => {
  for (const p of procs) p.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const code = await Promise.race(procs.map((p) => p.exited));
stop();
process.exit(code);
