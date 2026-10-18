import { Download, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { attachmentBytes, type FileAttachment } from "../../shared/attachments";
import { formatAttachmentSize } from "./composerAttachments";
import { useI18n } from "./i18n";

/** Blob URLs plus download keep HTML, SVG and other active content out of the app's document. */
export function fileAttachmentBlob(file: FileAttachment): Blob {
  if (attachmentBytes(file.data) === null) throw new Error("附件内容不是有效的 Base64");
  const decoded = atob(file.data);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return new Blob([bytes], { type: "application/octet-stream" });
}

export function FileAttachmentDownload({ file }: { file: FileAttachment }) {
  const { t: tr } = useI18n();
  const [download, setDownload] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let url: string;
    try {
      url = URL.createObjectURL(fileAttachmentBlob(file));
      setDownload({ url });
    } catch {
      setDownload({ error: tr("附件无法下载") });
      return;
    }
    return () => URL.revokeObjectURL(url);
  }, [file, tr]);
  return (
    <div className="message-file" data-message-body="">
      <FileText size={18} aria-hidden />
      <span className="attachment-info">
        <span className="attachment-name" title={file.name}>
          {file.name}
        </span>
        <span className="attachment-size">{formatAttachmentSize(attachmentBytes(file.data) ?? 0)}</span>
      </span>
      {download.error ? (
        <span role="alert">{download.error}</span>
      ) : (
        <a
          className="attachment-download"
          href={download.url}
          download={file.name}
          aria-label={tr("下载文件 {name}", { name: file.name })}
          aria-disabled={!download.url || undefined}
        >
          <Download size={16} aria-hidden />
        </a>
      )}
    </div>
  );
}
