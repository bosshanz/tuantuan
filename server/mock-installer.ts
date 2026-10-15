// Test-only installer for the "mock-cli" harness: prints progress, then drops an executable that runs
// the mock ACP agent. MOCK_INSTALL_FAIL=1 fails; MOCK_INSTALL_SLOW=1 waits so cancel can be tested.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = process.env.TUANTUAN_MOCK_INSTALL_DIR || join(tmpdir(), "tuantuan-mock-install");
const steps = ["正在下载 mock-cli 1.0.0 …", "\u001b[32m校验通过\u001b[0m", "解压到 " + dir];
for (const s of steps) {
  console.log(s);
  await Bun.sleep(process.env.MOCK_INSTALL_SLOW === "1" ? 400 : 60);
}
for (let p = 20; p <= 100; p += 40) process.stdout.write(`\r进度 ${p}%`);
process.stdout.write("\n");
if (process.env.MOCK_INSTALL_SLOW === "1") await Bun.sleep(30_000);
if (process.env.MOCK_INSTALL_FAIL === "1") {
  console.error("error: 网络不可用（mock）");
  process.exit(3);
}
mkdirSync(dir, { recursive: true });
const bin = join(dir, "mock-cli");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dir, "mock-agent.ts")}" "$@"\n`);
chmodSync(bin, 0o755);
console.log("安装完成");
