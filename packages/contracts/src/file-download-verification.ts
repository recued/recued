/** Owner-selected content checks. No bytes, content hashes or download URLs on the wire. */
export const FILE_DOWNLOAD_VERIFICATION_MAX_BYTES = 10 * 1024 * 1024;
export interface FileDownloadChoice {
  remote_id: string;
  filename: string;
  path?: string;
  output_filename: string;
  mode: 'download' | 'export';
  mime_type: string;
  size_bytes?: number;
  unavailable_reason?: string;
}
export interface FileDownloadChoices {
  source_id: string;
  connection_name: string;
  updated_at: number;
  available: boolean;
  files: readonly FileDownloadChoice[];
  next_cursor?: string;
  reason?: string;
  max_bytes: number;
}
export interface FileDownloadVerification {
  review_id: string;
  remote_id: string;
  filename: string;
  path?: string;
  output_filename: string;
  mode: 'download' | 'export';
  mime_type: string;
  comparison: 'same_bytes' | 'same_file_and_format';
  /** Pending means the current account passed; selected authentication has not passed yet. */
  status: 'pending' | 'verified';
  max_bytes: number;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const size = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const choice = (v: unknown): boolean => record(v) && text(v.remote_id,255) && text(v.filename,255) && text(v.output_filename)
  && (v.path === undefined || text(v.path))
  && (v.mode === 'download' || v.mode === 'export') && text(v.mime_type,255)
  && (v.size_bytes === undefined || size(v.size_bytes)) && (v.unavailable_reason === undefined || text(v.unavailable_reason));
export const isFileDownloadChoices = (v: unknown): v is FileDownloadChoices => record(v) && text(v.source_id) && text(v.connection_name)
  && size(v.updated_at) && typeof v.available === 'boolean' && v.max_bytes === FILE_DOWNLOAD_VERIFICATION_MAX_BYTES
  && Array.isArray(v.files) && v.files.length <= 25 && v.files.every(choice)
  && new Set(v.files.map(f => record(f) ? f.remote_id : null)).size === v.files.length
  && (v.next_cursor === undefined || text(v.next_cursor,255)) && (v.reason === undefined || text(v.reason))
  && (v.available || v.files.length === 0 && v.next_cursor === undefined && text(v.reason));
export const isFileDownloadVerification = (v: unknown): v is FileDownloadVerification => record(v) && choice(v)
  && v.unavailable_reason === undefined && typeof v.review_id === 'string' && /^[a-f0-9]{64}$/.test(v.review_id)
  && (v.status === 'pending' || v.status === 'verified') && v.max_bytes === FILE_DOWNLOAD_VERIFICATION_MAX_BYTES
  && (v.mode === 'download' ? v.comparison === 'same_bytes' : v.comparison === 'same_file_and_format');
