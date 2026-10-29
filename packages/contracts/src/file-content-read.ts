/** Optional chunk transport for the owner file-read RPC. Omit the range for
 * the existing whole-file response. Subsequent chunks pin the first digest. */
export const FILE_READ_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
export interface FileContentReadRequest {
  record_id: string;
  offset?: number;
  length?: number;
  expected_hash?: string;
}
export interface FileContentReadResponse {
  record_id: string;
  bytes_b64: string;
  mime_type: string;
  filename: string;
  /** Total file size, including for a chunk response. */
  size_bytes: number;
  blob_hash: string;
  offset?: number;
  next_offset?: number | null;
  chunk_hash?: string;
  /** Digest of the complete verified bytes, also for non-CAS sources. */
  content_hash?: string;
}
