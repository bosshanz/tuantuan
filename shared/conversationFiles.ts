export interface ConversationFile {
  id: string;
  messageId: string;
  seq: number;
  name: string;
  mimeType: string;
  source: "attachment" | "agent";
  senderName: string;
  createdAt: number;
  path?: string;
  size: number | null;
  state: "available" | "missing" | "unavailable";
  image: boolean;
  downloadUrl?: string;
}

export interface ConversationFilesPage {
  items: ConversationFile[];
  nextCursor: string | null;
}

export const CONVERSATION_FILES_PAGE_SIZE = 30;
export const CONVERSATION_FILES_LIMIT_MAX = 100;
export const CONVERSATION_FILE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
