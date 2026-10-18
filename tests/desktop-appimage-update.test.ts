import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppImageRelaunchOptions,
  completeAppImageUpdate,
  SafeAppImageUpdater,
  stageAppImage,
} from "../desktop/src/appimage-update";

const dirs: string[] = [];
const originalAppImage = process.env.APPIMAGE;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});
function files(custom = false) {
  const dir = mkdtempSync(join(tmpdir(), "tt-appimage-update-"));
  dirs.push(dir);
  const current = join(dir, custom ? "Tuantuan.AppImage" : "Tuantuan-0.2.0.AppImage");
  const cache = join(dir, "cache");
  const downloaded = join(cache, "Tuantuan-0.3.0.AppImage");
  const userDataPath = join(dir, "user-data");
  mkdirSync(cache);
  writeFileSync(current, "old executable", { mode: 0o755 });
  writeFileSync(downloaded, "new executable");
  return { dir, current, downloaded, userDataPath, recordPath: join(userDataPath, "appimage-update.json") };
}
function fixture(custom = false, relaunch?: (options: AppImageRelaunchOptions) => void) {
  const f = files(custom);
  process.env.APPIMAGE = f.current;
  let quits = 0;
  let updateQuits = 0;
  let spawnCalls = 0;
  let scheduled: AppImageRelaunchOptions | undefined;
  const native = new EventEmitter();
  native.on("before-quit-for-update", () => ++updateQuits);
  class Updater extends SafeAppImageUpdater {
    protected override get installerPath() {
      return f.downloaded;
    }
    protected override async spawnLog(): Promise<boolean> {
      spawnCalls++;
      throw new Error("must not spawn before quit");
    }
  }
  const updater = new Updater(
    native,
    (options) => {
      expect(quits).toBe(0);
      if (relaunch) relaunch(options);
      scheduled = options;
    },
    undefined,
    {
      version: "0.2.0",
      name: "Tuantuan",
      isPackaged: true,
      appUpdateConfigPath: join(f.dir, "app-update.yml"),
      userDataPath: f.userDataPath,
      baseCachePath: f.dir,
      whenReady: async () => {},
      relaunch() {},
      onQuit() {},
      quit() {
        ++quits;
      },
    },
  );
  return {
    ...f,
    updater,
    get scheduled() {
      if (!scheduled) throw new Error("no relaunch scheduled");
      return scheduled;
    },
    get quits() {
      return quits;
    },
    get updateQuits() {
      return updateQuits;
    },
    get spawnCalls() {
      return spawnCalls;
    },
  };
}

test("missing cache or conflicting destination leaves the old AppImage intact", () => {
  const { dir, current, downloaded } = files();
  expect(() => stageAppImage(current, `${downloaded}-missing`)).toThrow();
  expect(readFileSync(current, "utf8")).toBe("old executable");
  writeFileSync(join(dir, "Tuantuan-0.3.0.AppImage"), "unrelated");
  expect(() => stageAppImage(current, downloaded)).toThrow();
  expect(readFileSync(current, "utf8")).toBe("old executable");
});

test("relaunch scheduling failure restores both versioned and custom install filenames", async () => {
  for (const custom of [false, true]) {
    const f = fixture(custom, () => {
      throw new Error("relaunch blocked");
    });
    await expect(f.updater.quitAndInstall()).rejects.toThrow("relaunch blocked");
    expect(readFileSync(f.current, "utf8")).toBe("old executable");
    expect(readFileSync(f.downloaded, "utf8")).toBe("new executable");
    expect(existsSync(f.recordPath)).toBe(false);
    expect(f.quits).toBe(0);
    expect(f.updateQuits).toBe(0);
    expect(f.spawnCalls).toBe(0);
  }
});

test("an actual replacement process exiting 1 retains the old executable and recovery record", async () => {
  for (const custom of [false, true]) {
    const f = fixture(custom);
    writeFileSync(f.downloaded, "#!/bin/sh\nexit 1\n");
    await f.updater.quitAndInstall();
    const record = JSON.parse(readFileSync(f.recordPath, "utf8"));
    expect(f.quits).toBe(1);
    expect(f.updateQuits).toBe(1);
    expect(f.spawnCalls).toBe(0);
    expect(readFileSync(record.previous, "utf8")).toBe("old executable");
    // Model Electron's after-exit launch with a real executable, not a successful spawn PID.
    const child = spawnSync(f.scheduled.execPath, f.scheduled.args, { stdio: "ignore" });
    expect(child.status).toBe(1);
    expect(readFileSync(record.previous, "utf8")).toBe("old executable");
    expect(existsSync(f.recordPath)).toBe(true);
    expect(existsSync(f.downloaded)).toBe(true);
  }
});

test("only a matching healthy-boot acknowledgement cleans up the retained old package", async () => {
  for (const custom of [false, true]) {
    const f = fixture(custom);
    await f.updater.quitAndInstall();
    const record = JSON.parse(readFileSync(f.recordPath, "utf8"));
    expect(readFileSync(record.previous, "utf8")).toBe("old executable");
    expect(completeAppImageUpdate({ userDataPath: f.userDataPath, current: f.current, args: [] })).toBe(false);
    expect(
      completeAppImageUpdate({
        userDataPath: f.userDataPath,
        current: `${record.destination}-other`,
        args: f.scheduled.args,
      }),
    ).toBe(false);
    expect(
      completeAppImageUpdate({
        userDataPath: f.userDataPath,
        current: record.destination,
        args: ["--tuantuan-appimage-update=stale"],
      }),
    ).toBe(false);
    expect(readFileSync(record.previous, "utf8")).toBe("old executable");
    expect(
      completeAppImageUpdate({ userDataPath: f.userDataPath, current: record.destination, args: f.scheduled.args }),
    ).toBe(true);
    expect(existsSync(record.previous)).toBe(false);
    expect(readFileSync(record.destination, "utf8")).toBe("new executable");
    expect(existsSync(f.recordPath)).toBe(false);
    expect(
      completeAppImageUpdate({ userDataPath: f.userDataPath, current: record.destination, args: f.scheduled.args }),
    ).toBe(false);
  }
});

test("an unresolved previous boot prevents another update from overwriting its recovery files", async () => {
  const f = fixture(true);
  await f.updater.quitAndInstall();
  const record = readFileSync(f.recordPath, "utf8");
  const second = fixture();
  // Its independent application shares the same userData, as a manual recovery launch would.
  mkdirSync(second.userDataPath);
  writeFileSync(second.recordPath, record);
  await expect(second.updater.quitAndInstall()).rejects.toThrow("上次 AppImage 更新尚未确认启动");
  expect(readFileSync(second.current, "utf8")).toBe("old executable");
  expect(readFileSync(f.recordPath, "utf8")).toBe(record);
  expect(second.quits).toBe(0);
});

test("invalid recovery metadata never deletes executables", () => {
  const f = files();
  mkdirSync(f.userDataPath);
  writeFileSync(
    f.recordPath,
    JSON.stringify({
      schema: 1,
      id: "id",
      current: f.current,
      destination: f.downloaded,
      previous: f.current,
    }),
  );
  expect(() =>
    completeAppImageUpdate({
      userDataPath: f.userDataPath,
      current: f.downloaded,
      args: ["--tuantuan-appimage-update=id"],
    }),
  ).toThrow("AppImage 更新恢复记录无效");
  expect(readFileSync(f.current, "utf8")).toBe("old executable");
  expect(readFileSync(f.downloaded, "utf8")).toBe("new executable");
});
