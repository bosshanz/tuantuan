import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { AppImageUpdater } from "electron-updater";

const BOOT_ARGUMENT = "--tuantuan-appimage-update=";
const RECORD_NAME = "appimage-update.json";
export interface AppImageRelaunchOptions {
  execPath: string;
  args: string[];
}
interface AppImageUpdateRecord {
  schema: 1;
  id: string;
  current: string;
  destination: string;
  previous: string;
}

/** Stage on the install filesystem. Only a new, healthy main process may remove the old executable. */
export function stageAppImage(current: string, downloaded: string) {
  if (!isAbsolute(current) || current.includes("\0") || !statSync(current).isFile() || !statSync(downloaded).isFile())
    throw new Error("AppImage 更新文件不可用，未替换当前版本");
  const destination =
    basename(downloaded) === basename(current) || !/\d+\.\d+\.\d+/.test(basename(current))
      ? current
      : join(dirname(current), basename(downloaded));
  if (destination !== current && existsSync(destination)) throw new Error("AppImage 更新目标已存在，未替换当前版本");
  const id = crypto.randomUUID();
  const temp = `${current}.${id}.update`;
  const backup = `${current}.${id}.previous`;
  try {
    copyFileSync(downloaded, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o755);
    if (destination === current) copyFileSync(current, backup, constants.COPYFILE_EXCL);
    renameSync(temp, destination);
  } catch (error) {
    rmSync(temp, { force: true });
    rmSync(backup, { force: true });
    throw error;
  }
  let finished = false;
  return {
    id,
    destination,
    previous: destination === current ? backup : current,
    rollback() {
      if (finished) return;
      if (destination === current) renameSync(backup, current);
      else rmSync(destination);
      finished = true;
    },
  };
}

function readRecord(path: string): AppImageUpdateRecord | null {
  if (!existsSync(path)) return null;
  if (statSync(path).size > 64_000) throw new Error("AppImage 更新恢复记录过大，已保留旧版本");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AppImageUpdateRecord>;
  if (
    value?.schema !== 1 ||
    typeof value.id !== "string" ||
    !/^[\w-]{1,80}$/.test(value.id) ||
    typeof value.current !== "string" ||
    typeof value.destination !== "string" ||
    typeof value.previous !== "string" ||
    ![value.current, value.destination, value.previous].every((file) => isAbsolute(file) && !file.includes("\0")) ||
    dirname(value.current) !== dirname(value.destination) ||
    dirname(value.current) !== dirname(value.previous) ||
    value.previous !== (value.destination === value.current ? `${value.current}.${value.id}.previous` : value.current)
  )
    throw new Error("AppImage 更新恢复记录无效，已保留旧版本");
  return value as AppImageUpdateRecord;
}

/** Call only after this restarted main process has a healthy server and a ready window. */
export function completeAppImageUpdate(options: {
  userDataPath: string;
  current: string | undefined;
  args: string[];
}): boolean {
  const path = join(options.userDataPath, RECORD_NAME);
  const record = readRecord(path);
  if (!record || record.destination !== options.current || !options.args.includes(`${BOOT_ARGUMENT}${record.id}`))
    return false;
  // A matching ready acknowledgement proves more than a spawn PID: the replacement completed boot.
  rmSync(record.previous, { force: true });
  rmSync(path);
  return true;
}

/** Uses declared SDK extension points, avoiding AppImageUpdater's unlink-before-move install. */
export class SafeAppImageUpdater extends AppImageUpdater {
  private installEpoch = 0;
  private handoffScheduled = false;
  constructor(
    private native: { emit(event: string): boolean },
    private relaunch: ((options: AppImageRelaunchOptions) => void) | undefined,
    ...args: ConstructorParameters<typeof AppImageUpdater>
  ) {
    super(...args);
  }
  cancelInstall() {
    ++this.installEpoch;
  }
  override async quitAndInstall(): Promise<void> {
    if (this.handoffScheduled) return;
    const epoch = ++this.installEpoch;
    const downloaded = this.installerPath;
    const current = process.env.APPIMAGE;
    if (!downloaded || !current) throw new Error("AppImage 更新文件不可用，未替换当前版本");
    if (!this.relaunch) throw new Error("AppImage 更新重启不可用，已保留当前版本");
    const path = join(this.app.userDataPath, RECORD_NAME);
    const pending = readRecord(path);
    if (pending) throw new Error(`上次 AppImage 更新尚未确认启动；旧版本保留在 ${pending.previous}`);
    const replacement = stageAppImage(current, downloaded);
    try {
      mkdirSync(this.app.userDataPath, { recursive: true });
      const record: AppImageUpdateRecord = {
        schema: 1,
        id: replacement.id,
        current,
        destination: replacement.destination,
        previous: replacement.previous,
      };
      writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      if (epoch !== this.installEpoch) throw new Error("AppImage 更新重启已取消，已保留当前版本");
      // Electron launches execPath after the old instance exits and releases its single-instance lock.
      this.relaunch({
        execPath: replacement.destination,
        args: [
          ...process.argv.slice(1).filter((arg) => !arg.startsWith(BOOT_ARGUMENT)),
          `${BOOT_ARGUMENT}${replacement.id}`,
        ],
      });
    } catch (error) {
      replacement.rollback();
      if (readRecord(path)?.id === replacement.id) rmSync(path);
      throw error;
    }
    this.handoffScheduled = true;
    // Keep both the recovery record and old executable if the next process exits before ready.
    if (replacement.destination !== current) this.emit("appimage-filename-updated", replacement.destination);
    this.native.emit("before-quit-for-update");
    this.app.quit();
  }
}
