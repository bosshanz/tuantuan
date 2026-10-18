export interface ImageAttachment {
  mimeType: string;
  /** Base64 without a data URL prefix. */
  data: string;
}

export interface FileAttachment extends ImageAttachment {
  name: string;
}

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** Strict canonical base64, measured without decoding another copy of the payload. */
export function attachmentBytes(data: string): number | null {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (padding) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const last = alphabet.indexOf(data[data.length - padding - 1] ?? "");
    if (last < 0 || (padding === 2 ? last % 16 : last % 4) !== 0) return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function validAttachmentName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name.trim().length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/]/.test(name) &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function validAttachmentMimeType(mimeType: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(mimeType);
}

/** Shared by the composer and the server; validation never silently drops an attachment. */
export function attachmentError(images: readonly ImageAttachment[], files: readonly FileAttachment[]): string | null {
  if (images.length + files.length > MAX_ATTACHMENT_COUNT) return "每条消息最多添加 8 个附件";
  let total = 0;
  for (const image of images) {
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(image.mimeType)) return "不支持的图片类型";
    if (!image.data.length) return "图片内容为空";
  }
  for (const file of files) {
    if (!validAttachmentName(file.name)) return "附件名称无效";
    if (!validAttachmentMimeType(file.mimeType)) return "附件类型无效";
  }
  for (const attachment of [...images, ...files]) {
    if (attachment.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return "每个附件不能超过 5 MiB";
    const bytes = attachmentBytes(attachment.data);
    if (bytes === null) return "附件内容不是有效的 Base64";
    if (bytes > MAX_ATTACHMENT_BYTES) return "每个附件不能超过 5 MiB";
    total += bytes;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) return "每条消息的附件合计不能超过 20 MiB";
  }
  return null;
}
