/** Content search over the owner's current saved-file library. */
export interface DocumentContentMatch {
  file_ref: string;
  filename: string;
  content_hash: string;
  converter: string;
  extraction_complete: boolean;
  excerpt: string;
  excerpt_offset: number;
}

export interface DocumentContentCoverage {
  files_in_scope: number;
  indexed: number;
  pending: number;
  unreadable: number;
  missing_converter: number;
  too_large: number;
  empty_extraction: number;
  unsupported_encoding: number;
  converted: number;
  scope_limited: boolean;
  scope_changed: boolean;
}

export interface DocumentContentSearchResult {
  status: 'searched';
  query: string;
  scope: 'session' | 'all';
  /** File membership, source versions and converter profiles for this result. */
  scope_version: string;
  matches: DocumentContentMatch[];
  coverage: DocumentContentCoverage;
  partial: boolean;
  matches_truncated: boolean;
  next_cursor?: string;
  next_offset?: number;
  index_unavailable?: boolean;
  hint: string;
}

export interface OwnerDocumentSearchRequest {
  request_id: string;
  query: string;
  cursor?: string;
  offset?: number;
}

export interface OwnerDocumentSearchReply {
  request_id: string;
  state: 'running' | 'held' | 'ready' | 'unavailable' | 'expired' | 'changed';
  result?: DocumentContentSearchResult;
  run_id?: string;
  message?: string;
}
