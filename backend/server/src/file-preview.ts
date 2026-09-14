import { FILE_PREVIEW_MAX_BYTES, filePreviewKind, RpcError,
  type FilePreviewRequest, type FilePreviewResult } from '@recued/contracts';
import { handleFileRead, type FileReadDeps } from './collections/file/file-read-handler.js';

export interface PreviewSelection {
  filename: string;
  mime_type?: string;
  size?: number;
  selection_revision: string;
  download_unavailable_reason?: string;
  export_as?: { filename: string; mime_type: string };
}

/** Reuse selection checks and the audited read, without importing, indexing or
 * retaining content. Rechecking after the await retires deleted/changed files. */
export const previewFile = async (
  deps: FileReadDeps, request: FilePreviewRequest,
  select: (id: string) => PreviewSelection,
): Promise<FilePreviewResult> => {
  if (!request || typeof request.record_id !== 'string' || !request.record_id || request.record_id.length > 12000
    || (request.selection_revision !== undefined && (typeof request.selection_revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.selection_revision)))) {
    throw new RpcError('bad_request', 'Choose a file to preview.', 400);
  }
  const selected = select(request.record_id);
  const changed = () => new RpcError('file_selection_changed', 'This file changed. Close the preview and select it again.', 409);
  if (request.selection_revision !== undefined && request.selection_revision !== selected.selection_revision) throw changed();
  const mime = selected.export_as?.mime_type ?? selected.mime_type ?? 'application/octet-stream';
  const initial: FilePreviewResult = { record_id: request.record_id,
    filename: selected.export_as?.filename ?? selected.filename, mime_type: mime,
    ...(!selected.export_as && selected.size !== undefined ? { size_bytes: selected.size } : {}),
    transient: request.record_id.startsWith('file:remote:'), can_download: !selected.download_unavailable_reason };
  if (selected.download_unavailable_reason) return { ...initial, unavailable_reason: selected.download_unavailable_reason };
  if (!filePreviewKind(mime)) return { ...initial, unavailable_reason: 'This file format has no preview yet. You can download it.' };
  if (!selected.export_as && selected.size !== undefined && selected.size > FILE_PREVIEW_MAX_BYTES) {
    return { ...initial, unavailable_reason: 'Files larger than 25 MiB can be downloaded, but cannot be previewed here.' };
  }
  let file;
  try {
    file = await handleFileRead(deps, { record_id: request.record_id }, undefined, { maxBytes: FILE_PREVIEW_MAX_BYTES });
  } catch (error) {
    if (!(error instanceof RpcError) || !['file_too_large', 'remote_too_large'].includes(error.code)) throw error;
    if (select(request.record_id).selection_revision !== selected.selection_revision) throw changed();
    return { ...initial, unavailable_reason: 'This file exceeds the preview download limit. You can try downloading it to open it.' };
  }
  if (select(request.record_id).selection_revision !== selected.selection_revision) throw changed();
  const kind = filePreviewKind(file.mime_type);
  const result = { ...initial, filename: file.filename, mime_type: file.mime_type, size_bytes: file.size_bytes };
  return kind ? { ...result, content: { kind, bytes_b64: file.bytes_b64 } }
    : { ...result, unavailable_reason: 'The downloaded format has no preview yet. You can download it.' };
};
