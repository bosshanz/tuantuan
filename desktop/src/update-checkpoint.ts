import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DESKTOP_CHECKPOINT_MAX_BYTES, type DesktopUpdateCheckpoint } from "../../shared/desktopUpdate";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validCheckpoint(value: unknown): value is DesktopUpdateCheckpoint {
  if (
    !record(value) ||
    value.schema !== 1 ||
    typeof value.id !== "string" ||
    !/^[\w-]{1,80}$/.test(value.id) ||
    typeof value.route !== "string" ||
    !/^#\//.test(value.route) ||
    value.route.length > 2048 ||
    !record(value.rooms)
  )
    return false;
  return Object.entries(value.rooms).every(([id, room]) => {
    if (!/^[\w-]{1,100}$/.test(id) || !record(room) || typeof room.draft !== "string" || !Array.isArray(room.images))
      return false;
    if (
      !room.images.every(
        (image) =>
          record(image) &&
          typeof image.mimeType === "string" &&
          image.mimeType.startsWith("image/") &&
          typeof image.data === "string",
      )
    )
      return false;
    const quote = room.quote;
    if (
      quote !== null &&
      (!record(quote) ||
        typeof quote.messageId !== "string" ||
        typeof quote.senderName !== "string" ||
        !["human", "agent"].includes(quote.senderKind as string) ||
        typeof quote.text !== "string" ||
        (quote.partIndex !== undefined && (!Number.isSafeInteger(quote.partIndex) || (quote.partIndex as number) < 0)))
    )
      return false;
    const anchor = room.reading;
    return (
      anchor === null ||
      (record(anchor) && typeof anchor.id === "string" && Number.isFinite(anchor.offset) && Number.isFinite(anchor.top))
    );
  });
}

/** A private host file survives the local server's random port (and therefore origin) changing. */
export class UpdateCheckpointFile {
  constructor(private path: string) {}

  read(): DesktopUpdateCheckpoint | null {
    if (!existsSync(this.path)) return null;
    if (statSync(this.path).size > DESKTOP_CHECKPOINT_MAX_BYTES)
      throw new Error("更新恢复数据过大，未自动清除原始数据");
    const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!validCheckpoint(value)) throw new Error("更新恢复数据无效，未自动清除原始数据");
    return value;
  }

  save(value: unknown): void {
    if (!validCheckpoint(value)) throw new Error("无法保存无效的更新恢复数据");
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > DESKTOP_CHECKPOINT_MAX_BYTES)
      throw new Error("草稿及图片超过更新恢复容量，请先发送或移除部分附件");
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  clear(id: unknown): void {
    // An old renderer acknowledgement must never delete a newer checkpoint.
    if (typeof id !== "string" || this.read()?.id !== id) return;
    unlinkSync(this.path);
  }
}
