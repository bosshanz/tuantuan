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
import { attachmentError, type FileAttachment } from "../../shared/attachments";
import {
  DESKTOP_CHECKPOINT_MAX_BYTES,
  type DesktopCheckpointRequest,
  type DesktopCheckpointState,
  type DesktopUpdateCheckpoint,
} from "../../shared/desktopUpdate";

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
    if (
      room.files !== undefined &&
      (!Array.isArray(room.files) ||
        !room.files.every(
          (file) =>
            record(file) &&
            typeof file.name === "string" &&
            typeof file.mimeType === "string" &&
            typeof file.data === "string",
        ) ||
        attachmentError([], room.files as FileAttachment[]) !== null)
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
      throw new Error("草稿及附件超过更新恢复容量，请先发送或移除部分附件");
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

/** One owner for update/quit handoffs, including late IPC replies after a timeout. */
export class DesktopCheckpoint {
  private pending?: {
    request: DesktopCheckpointRequest;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    saved: boolean;
  };
  private saved?: DesktopCheckpointRequest;

  constructor(
    private file: UpdateCheckpointFile,
    private send: (request: DesktopCheckpointRequest) => void,
    private changed: (state: DesktopCheckpointState) => void,
    private timeoutMs = 15_000,
  ) {}

  request(reason: DesktopCheckpointRequest["reason"]): Promise<void> {
    if (this.pending)
      return this.pending.request.reason === reason
        ? this.pending.promise
        : Promise.reject(new Error("正在保存当前工作，请稍后重试"));
    const request = { id: crypto.randomUUID(), reason };
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => this.fail(new Error("保存当前工作超时，请重试")), this.timeoutMs);
    this.pending = { request, promise, resolve, reject, timer, saved: false };
    this.changed({ ...request, phase: "preparing" });
    try {
      this.send(request);
    } catch (error) {
      this.fail(error as Error);
    }
    return promise;
  }

  save(value: unknown, requestId: unknown): void {
    const pending = this.pending;
    if (!pending || requestId !== pending.request.id || !record(value) || value.id !== pending.request.id)
      throw new Error("保存请求已过期，请重试");
    this.file.save(value);
    pending.saved = true;
    this.saved = pending.request;
  }

  reply(value: { id?: string; ok?: boolean; error?: string } | null): void {
    const pending = this.pending;
    if (!pending || value?.id !== pending.request.id) return;
    if (value.ok !== true || !pending.saved) {
      this.fail(new Error(typeof value.error === "string" ? value.error.slice(0, 1000) : "无法保存当前工作，请重试"));
      return;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.changed({ ...pending.request, phase: "saved" });
    pending.resolve();
  }

  abandonUpdate(): void {
    if (this.pending?.request.reason === "update") this.fail(new Error("更新保存已取消，请重试"));
    // Update status polling must never remove a checkpoint owned by an ordinary quit.
    if (this.saved?.reason === "update") this.clear(this.saved.id);
  }

  clear(id: unknown): void {
    this.file.clear(id);
    if (id === this.saved?.id) this.saved = undefined;
  }

  private fail(error: Error) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    if (pending.saved) {
      try {
        this.clear(pending.request.id);
      } catch (cleanupError) {
        error = new Error(`${error.message}；无法清除过期恢复数据：${(cleanupError as Error).message}`);
      }
    }
    this.changed({ ...pending.request, phase: "error", error: error.message });
    pending.reject(error);
  }
}
