/** D-149 P7 § A.5.4 — `reception_drop_blob_metadata` store.
 *
 *  Mirrors the P6 form-submission pattern: the substrate visitor thread
 *  persists pre-encrypted PII columns (built by the handler via
 *  `drop-pii.ts`) plus filesystem blob metadata; engine-side reactive
 *  triggers (D-115 substrate) consume pending rows asynchronously per
 *  Must Hold I-12.
 *
 *  Encryption discipline:
 *
 *    - `visitor_email_encrypted` — sealed under the drop-PII AEAD key
 *      via `drop-pii.ts` with AAD `(endpoint_id, blob_id, 'visitor_email')`.
 *    - `visitor_name_encrypted` — sealed with AAD `(.., 'visitor_name')`.
 *    - `visitor_description_encrypted` — sealed with AAD `(.., 'visitor_description')`.
 *
 *  Filesystem blob bytes are server-local + content-hash-keyed under
 *  `drop_blobs/<year>/<month>/<sha256>` per § A.5.4 line 825. The store
 *  interface accepts pre-encrypted base64 strings; this module stays
 *  crypto-free + parallel to the form-store pattern.
 *
 *  Spec: D-149 § A.5.4 + § N.6. */

import type Database from 'better-sqlite3';
import {
  DROP_LINK_PROCESSING_OUTCOME_SET,
  DROP_LINK_SCAN_STATUS_SET,
  type DropLinkProcessingOutcome,
  type DropLinkScanStatus,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Row shape (mirrors reception-store CREATE TABLE)
// ────────────────────────────────────────────────────────────────

interface DropBlobRow {
  blob_id: string;
  endpoint_id: string;
  uploaded_at: number;
  source_ip_hash: string | null;
  visitor_email_encrypted: Buffer | null;
  visitor_name_encrypted: Buffer | null;
  visitor_description_encrypted: Buffer | null;
  filename_sanitized: string;
  mime_type_reported: string;
  mime_type_detected: string;
  size_bytes: number;
  content_hash: string;
  storage_path: string;
  data_file_entity_id: string | null;
  scan_status: string | null;
  processing_outcome: string;
  metadata_blob: string | null;
}

// ────────────────────────────────────────────────────────────────
// Public projections
// ────────────────────────────────────────────────────────────────

export interface DropBlobSummary {
  readonly blob_id: string;
  readonly endpoint_id: string;
  readonly uploaded_at: number;
  readonly source_ip_hash: string | null;
  readonly visitor_email_encrypted: string | null;
  readonly visitor_name_encrypted: string | null;
  readonly visitor_description_encrypted: string | null;
  readonly filename_sanitized: string;
  readonly mime_type_reported: string;
  readonly mime_type_detected: string;
  readonly size_bytes: number;
  readonly content_hash: string;
  readonly storage_path: string;
  readonly data_file_entity_id: string | null;
  readonly scan_status: DropLinkScanStatus | null;
  readonly processing_outcome: DropLinkProcessingOutcome;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DropBlobInsertInput {
  readonly blob_id: string;
  readonly endpoint_id: string;
  readonly uploaded_at: number;
  readonly source_ip_hash: string | null;
  /** Base64 ciphertext built via `sealDropPiiField`. Nullable when the
   *  visitor omitted the field. */
  readonly visitor_email_encrypted: string | null;
  readonly visitor_name_encrypted: string | null;
  readonly visitor_description_encrypted: string | null;
  readonly filename_sanitized: string;
  readonly mime_type_reported: string;
  readonly mime_type_detected: string;
  readonly size_bytes: number;
  readonly content_hash: string;
  /** Relative path from the drop_blobs root (e.g.,
   *  `2026/05/<sha256>`). Substrate writes only the relative form; the
   *  absolute root stays in bin.ts so a moved data dir doesn't break
   *  existing rows. */
  readonly storage_path: string;
  readonly scan_status?: DropLinkScanStatus | null;
  readonly processing_outcome: DropLinkProcessingOutcome;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DropBlobStore {
  insert(input: DropBlobInsertInput): DropBlobSummary;
  findById(blob_id: string): DropBlobSummary | null;
  /** Count uploads accepted for an endpoint within a rolling window —
   *  substrate uses this for the per-day cap enforcement. */
  countWithinWindow(input: {
    endpoint_id: string;
    window_start_at: number;
    now: number;
  }): number;
  listPendingForEndpoint(endpoint_id: string, limit?: number): ReadonlyArray<DropBlobSummary>;
  markProcessed(input: {
    blob_id: string;
    outcome: Exclude<DropLinkProcessingOutcome, 'pending'>;
    data_file_entity_id?: string | null;
    scan_status?: DropLinkScanStatus | null;
  }): 'updated' | 'not_found';
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const parseJsonObject = (raw: string | null): Readonly<Record<string, unknown>> => {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const blobToBase64 = (raw: Buffer | null): string | null => {
  if (raw === null) return null;
  return raw.toString('base64');
};

const base64ToBlob = (raw: string | null): Buffer | null => {
  if (raw === null) return null;
  return Buffer.from(raw, 'base64');
};

const rowToSummary = (row: DropBlobRow): DropBlobSummary => {
  const outcomeRaw = row.processing_outcome;
  // Defense in depth — fall back to `'pending'` for rows whose outcome
  // column was hand-edited / migrated from a future enum value. The
  // closed-list set is the source of truth.
  const outcome: DropLinkProcessingOutcome = DROP_LINK_PROCESSING_OUTCOME_SET.has(
    outcomeRaw as DropLinkProcessingOutcome,
  )
    ? (outcomeRaw as DropLinkProcessingOutcome)
    : 'pending';
  const scanRaw = row.scan_status;
  const scan: DropLinkScanStatus | null =
    scanRaw !== null && DROP_LINK_SCAN_STATUS_SET.has(scanRaw as DropLinkScanStatus)
      ? (scanRaw as DropLinkScanStatus)
      : null;
  return {
    blob_id: row.blob_id,
    endpoint_id: row.endpoint_id,
    uploaded_at: row.uploaded_at,
    source_ip_hash: row.source_ip_hash,
    visitor_email_encrypted: blobToBase64(row.visitor_email_encrypted),
    visitor_name_encrypted: blobToBase64(row.visitor_name_encrypted),
    visitor_description_encrypted: blobToBase64(row.visitor_description_encrypted),
    filename_sanitized: row.filename_sanitized,
    mime_type_reported: row.mime_type_reported,
    mime_type_detected: row.mime_type_detected,
    size_bytes: row.size_bytes,
    content_hash: row.content_hash,
    storage_path: row.storage_path,
    data_file_entity_id: row.data_file_entity_id,
    scan_status: scan,
    processing_outcome: outcome,
    metadata: parseJsonObject(row.metadata_blob),
  };
};

// ────────────────────────────────────────────────────────────────
// Store impl
// ────────────────────────────────────────────────────────────────

export const createReceptionDropBlobStore = (
  db: Database.Database,
): DropBlobStore => {
  const insertStmt = db.prepare(`
    INSERT INTO reception_drop_blob_metadata (
      blob_id, endpoint_id, uploaded_at, source_ip_hash,
      visitor_email_encrypted, visitor_name_encrypted, visitor_description_encrypted,
      filename_sanitized, mime_type_reported, mime_type_detected,
      size_bytes, content_hash, storage_path,
      data_file_entity_id, scan_status, processing_outcome, metadata_blob
    ) VALUES (
      @blob_id, @endpoint_id, @uploaded_at, @source_ip_hash,
      @visitor_email_encrypted, @visitor_name_encrypted, @visitor_description_encrypted,
      @filename_sanitized, @mime_type_reported, @mime_type_detected,
      @size_bytes, @content_hash, @storage_path,
      NULL, @scan_status, @processing_outcome, @metadata_blob
    )
  `);

  const findByIdStmt = db.prepare(
    `SELECT * FROM reception_drop_blob_metadata WHERE blob_id = @blob_id`,
  );

  const countWindowStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM reception_drop_blob_metadata
     WHERE endpoint_id = @endpoint_id
       AND uploaded_at >= @window_start_at
       AND uploaded_at <= @now
       AND processing_outcome != 'rejected_size'
       AND processing_outcome != 'rejected_mime'
       AND processing_outcome != 'rejected_filename'
       AND processing_outcome != 'rejected_domain'
  `);

  const listPendingStmt = db.prepare(`
    SELECT * FROM reception_drop_blob_metadata
     WHERE endpoint_id = @endpoint_id
       AND processing_outcome = 'pending'
     ORDER BY uploaded_at ASC
     LIMIT @limit
  `);

  const markProcessedStmt = db.prepare(`
    UPDATE reception_drop_blob_metadata
       SET processing_outcome = @outcome,
           data_file_entity_id = @data_file_entity_id,
           scan_status = COALESCE(@scan_status, scan_status)
     WHERE blob_id = @blob_id
  `);

  return {
    insert(input) {
      insertStmt.run({
        blob_id: input.blob_id,
        endpoint_id: input.endpoint_id,
        uploaded_at: input.uploaded_at,
        source_ip_hash: input.source_ip_hash,
        visitor_email_encrypted: base64ToBlob(input.visitor_email_encrypted),
        visitor_name_encrypted: base64ToBlob(input.visitor_name_encrypted),
        visitor_description_encrypted: base64ToBlob(input.visitor_description_encrypted),
        filename_sanitized: input.filename_sanitized,
        mime_type_reported: input.mime_type_reported,
        mime_type_detected: input.mime_type_detected,
        size_bytes: input.size_bytes,
        content_hash: input.content_hash,
        storage_path: input.storage_path,
        scan_status: input.scan_status ?? null,
        processing_outcome: input.processing_outcome,
        metadata_blob: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      const row = findByIdStmt.get({ blob_id: input.blob_id }) as DropBlobRow | undefined;
      if (!row) {
        throw new Error('ReceptionDropBlobStore.insert: row missing after insert');
      }
      return rowToSummary(row);
    },

    findById(blob_id) {
      const row = findByIdStmt.get({ blob_id }) as DropBlobRow | undefined;
      return row ? rowToSummary(row) : null;
    },

    countWithinWindow(input) {
      const row = countWindowStmt.get({
        endpoint_id: input.endpoint_id,
        window_start_at: input.window_start_at,
        now: input.now,
      }) as { n: number };
      return row.n;
    },

    listPendingForEndpoint(endpoint_id, limit = 100) {
      const rows = listPendingStmt.all({ endpoint_id, limit }) as DropBlobRow[];
      return rows.map(rowToSummary);
    },

    markProcessed(input) {
      const result = markProcessedStmt.run({
        blob_id: input.blob_id,
        outcome: input.outcome,
        data_file_entity_id: input.data_file_entity_id ?? null,
        scan_status: input.scan_status ?? null,
      });
      return result.changes > 0 ? 'updated' : 'not_found';
    },
  };
};
