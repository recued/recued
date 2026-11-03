/** Download lifecycle: ordinary remote reads are transient. Explicit cloud
 * import retains the current download at import time, before Send. Remote edits,
 * deletion and disconnection never rewrite or erase that copy; local file
 * retention/deletion governs it. Sent messages pin immutable retained versions.
 * See internal design notes. */
/** The portable file produced when a source exports a native document. */
export interface FileExportRepresentation {
  filename: string;
  mime_type: string;
}

/** A bounded, transient owner preview over the existing file-read contract. */
export const FILE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_PREVIEW_TEXT_CHARACTERS = 100_000;
export type FilePreviewKind = 'image' | 'pdf' | 'text' | 'docx';
/** Recorded provenance only; an absent origin must not be inferred from a name. */
export interface FilePreviewOrigin {
  label: string;
  path?: string;
  source_filename?: string;
  captured_at?: number;
  saved_copy?: boolean;
}
export interface FilePreviewRequest {
  record_id: string;
  selection_revision?: string;
  /** Check the selected identity and download capability without reading bytes. */
  metadata_only?: boolean;
}
export interface FilePreviewResult {
  record_id: string;
  selection_revision?: string;
  filename: string;
  mime_type: string;
  size_bytes?: number;
  transient: boolean;
  can_download: boolean;
  origin?: FilePreviewOrigin;
  export_as?: FileExportRepresentation;
  created_at?: number;
  modified_at?: number;
  content_hash?: string;
  download_unavailable_reason?: string;
  content?: { kind: FilePreviewKind; bytes_b64: string };
  unavailable_reason?: string;
  /** Availability only. Opening a preview never starts a converter. */
  conversion?: FilePreviewConversionAvailability;
}

export type FilePreviewConverter = 'markitdown' | 'docling';
export interface FilePreviewConversionAvailability {
  readers: FilePreviewConverter[];
  unavailable_reason?: string;
}
export type FilePreviewConversionRequest =
  | { action: 'start'; record_id: string; selection_revision: string; request_id: string; converter: FilePreviewConverter }
  | { action: 'status'; conversion_id: string };
export interface FilePreviewConversionResult {
  conversion_id: string;
  record_id: string;
  selection_revision: string;
  state: 'running' | 'awaiting_approval' | 'ready' | 'failed';
  converter: FilePreviewConverter;
  run_id?: string;
  message: string;
  /** Bounded, inert extracted text; never a file ref or executable HTML. */
  text?: string;
  truncated?: boolean;
  /** Hash of the actual source handed to the converter, for original downloads. */
  source_content_hash?: string;
}

/** Format adapters are independent of the provider that supplied the bytes.
 * HTML, XML and SVG are shown as text, never executed or embedded. */
export const filePreviewKind = (mime: string): FilePreviewKind | undefined => {
  const type = mime.toLowerCase().split(';')[0]!.trim();
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/csv',
    'application/x-ndjson', 'application/yaml', 'application/x-yaml', 'image/svg+xml'].includes(type)
    || type.endsWith('+json') || type.endsWith('+xml')) return 'text';
  return undefined;
};

export interface FileCloudCapture {
  /** Original, connection-scoped file identity. This is provenance, not read authority. */
  remote_record_id: string;
  source_id: string;
  provider: string;
  /** Provider and connection display name as observed at import. */
  source_label: string;
  remote_id: string;
  filename: string;
  path?: string;
  /** Mirror metadata only; never a claim about the downloaded provider version. */
  observed_revision?: string;
  /** When the download completed, in epoch milliseconds. */
  captured_at: number;
  /** SHA-256 of the actual downloaded bytes, independent of observed_revision. */
  content_hash: string;
  /** Actual exported representation, distinct from the original cloud filename. */
  export_as?: FileExportRepresentation;
}

/** Optional metadata from older servers/records may be absent or incomplete. */
export const isFileCloudCapture = (value: unknown): value is FileCloudCapture => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ['remote_record_id', 'source_id', 'provider', 'source_label', 'remote_id', 'filename']
    .every(key => typeof v[key] === 'string' && v[key].length > 0)
    && (v.path === undefined || typeof v.path === 'string')
    && (v.observed_revision === undefined || typeof v.observed_revision === 'string')
    && typeof v.captured_at === 'number' && Number.isSafeInteger(v.captured_at) && v.captured_at >= 0
    && typeof v.content_hash === 'string' && /^[a-f0-9]{64}$/.test(v.content_hash)
    && (v.export_as === undefined || (v.export_as !== null && typeof v.export_as === 'object'
      && 'filename' in v.export_as && typeof v.export_as.filename === 'string' && v.export_as.filename.length > 0
      && 'mime_type' in v.export_as && typeof v.export_as.mime_type === 'string' && v.export_as.mime_type.length > 0));
};

/** Owner file lifecycle. The revision covers both the file and its users. */
export interface FileUsage {
  session_id: string;
  message_id?: string;
  turn_id?: string;
  state: string;
}

export interface FileLifecyclePreview {
  record_id: string;
  filename: string;
  revision: string;
  archived: boolean;
  deleted: boolean;
  /** True for an archived library record that can be restored. Older servers omit
   * this field and do not accept the restore action. */
  can_restore?: boolean;
  /** Only the saved-library record can be renamed; retained attachment versions stay immutable. */
  can_rename?: boolean;
  /** Authoritative library metadata time, when the saved record still exists. */
  modified_at?: number;
  message_count: number;
  conversation_count: number;
  queued_count: number;
  delivery_count: number;
  in_use: boolean;
  usages: FileUsage[];
  usages_truncated: boolean;
  cloud_capture?: FileCloudCapture;
}

export interface FileLifecycleMutation {
  record_id: string;
  action: 'archive' | 'restore' | 'delete';
  revision: string;
}

/** Rename saved-library metadata. Accepted attachments retain their captured names. */
export interface FileRenameRequest {
  record_id: string;
  filename: string;
  revision: string;
}

/** Metadata only. The revision pins the owner's selection until queue admission;
 * accepted messages use the existing immutable attachment version instead. */
export interface FileAttachmentSelection {
  file_id: string;
  media_class: string;
  filename: string;
  mime_type: string;
  size: number;
  selection_revision: string;
}

export interface FileAttachmentListRequest {
  query?: string;
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface FileAttachmentListResult {
  files: FileAttachmentSelection[];
  next_cursor?: string;
}

/** Connected-source browsing reads metadata only. Import explicitly saves bytes. */
export interface CloudFileSource {
  /** Saved connection identity only; no credential or provider URL in navigation. */
  authentication_connection?: string;
  source_id: string;
  label: string;
  provider: string;
  last_synced_at: number | null;
  stale: boolean;
}

export interface CloudFileSelection {
  record_id: string;
  source_id?: string;
  filename: string;
  path?: string;
  mime_type?: string;
  size?: number;
  mtime?: number;
  selection_revision: string;
  unavailable_reason?: string;
  download_unavailable_reason?: string;
  export_as?: FileExportRepresentation;
}

export interface CloudFileListRequest {
  source_id: string;
  query?: string;
  limit?: number;
  cursor?: string;
}

export interface CloudFileListResult {
  files: CloudFileSelection[];
  next_cursor?: string;
}

export interface CloudFileImportRequest {
  record_id: string;
  selection_revision: string;
  /** Stable across retries of this import, independent of chat.send. */
  import_id: string;
}

/** One retained version, grouped across its messages in this conversation. */
export interface ConversationFile {
  file_id: string;
  source_file_id: string;
  filename: string;
  mime_type: string;
  media_class: string;
  size: number;
  availability: 'available' | 'deleted' | 'missing';
  archived: boolean;
  legacy_capture: boolean;
  /** Frozen with the retained version; survives source disconnection and file deletion. */
  cloud_capture?: FileCloudCapture;
  message_count: number;
  last_message_id: string;
  last_message_at: number;
  /** Ordered by first use among this conversation's retained versions. */
  version_number: number;
  version_count: number;
}

export interface ConversationFileListRequest {
  session_id: string;
  query?: string;
  media_class?: 'image' | 'voice' | 'document' | 'other';
  limit?: number;
  cursor?: string;
}

export interface ConversationFileListResult {
  files: ConversationFile[];
  next_cursor?: string;
}
