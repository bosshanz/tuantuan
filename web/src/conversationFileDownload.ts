import type { ConversationFile } from "../../shared/conversationFiles";

export async function readConversationFile(roomId: string, file: ConversationFile, signal: AbortSignal) {
  if (!file.downloadUrl || file.state !== "available") throw new Error("文件不可用");
  const url = new URL(file.downloadUrl, location.origin);
  const expected = `/api/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.id)}/content`;
  if (url.origin !== location.origin || url.pathname !== expected) throw new Error("文件下载地址无效");
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

export function saveConversationFile(bytes: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
