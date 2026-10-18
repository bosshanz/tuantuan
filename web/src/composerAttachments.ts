import {
  attachmentBytes,
  type FileAttachment,
  IMAGE_MIME_TYPES,
  type ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../../shared/attachments";

export interface ComposerAttachments {
  images: ImageAttachment[];
  files: FileAttachment[];
}

export function selectedAttachmentError(current: ComposerAttachments, selected: readonly File[]): string | null {
  if (current.images.length + current.files.length + selected.length > MAX_ATTACHMENT_COUNT)
    return "每条消息最多添加 8 个附件";
  if (selected.some((file) => file.size > MAX_ATTACHMENT_BYTES)) return "每个附件不能超过 5 MiB";
  const bytes = [...current.images, ...current.files].reduce(
    (sum, attachment) => sum + (attachmentBytes(attachment.data) ?? 0),
    0,
  );
  if (bytes + selected.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES)
    return "每条消息的附件合计不能超过 20 MiB";
  return null;
}

export function readComposerAttachment(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) {
        reject(new Error("无法读取附件内容"));
        return;
      }
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data: reader.result.slice(reader.result.indexOf(",") + 1),
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取附件内容"));
    reader.onabort = () => reject(new Error("附件读取已取消"));
    reader.readAsDataURL(file);
  });
}

export function splitComposerAttachments(attachments: readonly FileAttachment[]): ComposerAttachments {
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const attachment of attachments) {
    if ((IMAGE_MIME_TYPES as readonly string[]).includes(attachment.mimeType))
      images.push({ mimeType: attachment.mimeType, data: attachment.data });
    else files.push(attachment);
  }
  return { images, files };
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}
