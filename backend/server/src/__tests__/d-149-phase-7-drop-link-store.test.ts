/** D-149 P7 § A.5.4 — reception drop blob store tests. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import { createReceptionDropBlobStore } from '../storage/reception-drop-store.js';

const NOW = 1_700_000_000_000;

const buildDb = () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  return db;
};

const goodInsert = (overrides: Record<string, unknown> = {}) => ({
  blob_id: 'b_1',
  endpoint_id: 'e_1',
  uploaded_at: NOW,
  source_ip_hash: null,
  visitor_email_encrypted: null,
  visitor_name_encrypted: null,
  visitor_description_encrypted: null,
  filename_sanitized: 'report.pdf',
  mime_type_reported: 'application/pdf',
  mime_type_detected: 'application/pdf',
  size_bytes: 4096,
  content_hash: 'deadbeef',
  storage_path: '2026/05/deadbeef',
  scan_status: 'unscanned' as const,
  processing_outcome: 'pending' as const,
  ...overrides,
});

describe('D-149 P7 § A.5.4 — DropBlobStore', () => {
  it('insert persists a row + findById returns it', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    const row = store.insert(goodInsert());
    expect(row.blob_id).toBe('b_1');
    expect(row.processing_outcome).toBe('pending');
    expect(row.scan_status).toBe('unscanned');
    expect(row.metadata).toEqual({});
    expect(store.findById('b_1')?.content_hash).toBe('deadbeef');
  });

  it('findById returns null for unknown id', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    expect(store.findById('missing')).toBeNull();
  });

  it('listPendingForEndpoint scopes by endpoint + outcome=pending', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    store.insert(goodInsert({ blob_id: 'b_pending', processing_outcome: 'pending' }));
    store.insert(
      goodInsert({
        blob_id: 'b_processed',
        processing_outcome: 'processed',
        uploaded_at: NOW + 1,
      }),
    );
    store.insert(
      goodInsert({
        blob_id: 'b_other_endpoint',
        endpoint_id: 'e_other',
        uploaded_at: NOW + 2,
      }),
    );
    const pending = store.listPendingForEndpoint('e_1');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.blob_id).toBe('b_pending');
  });

  it('countWithinWindow excludes rejected outcomes per spec', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    // Two accepted rows + one rejected — only the two should count.
    store.insert(goodInsert({ blob_id: 'b_a', uploaded_at: NOW - 100 }));
    store.insert(
      goodInsert({
        blob_id: 'b_b',
        uploaded_at: NOW - 50,
        processing_outcome: 'processed',
      }),
    );
    store.insert(
      goodInsert({
        blob_id: 'b_rej',
        uploaded_at: NOW - 25,
        processing_outcome: 'rejected_mime',
      }),
    );
    expect(
      store.countWithinWindow({
        endpoint_id: 'e_1',
        window_start_at: NOW - 1000,
        now: NOW,
      }),
    ).toBe(2);
  });

  it('markProcessed flips outcome + sets data_file_entity_id', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    store.insert(goodInsert());
    expect(
      store.markProcessed({
        blob_id: 'b_1',
        outcome: 'processed',
        data_file_entity_id: 'df_42',
        scan_status: 'clean',
      }),
    ).toBe('updated');
    const row = store.findById('b_1');
    expect(row?.processing_outcome).toBe('processed');
    expect(row?.data_file_entity_id).toBe('df_42');
    expect(row?.scan_status).toBe('clean');
  });

  it('markProcessed returns not_found for unknown id', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    expect(
      store.markProcessed({ blob_id: 'missing', outcome: 'failed' }),
    ).toBe('not_found');
  });

  it('preserves base64 round-trip for encrypted columns', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    const cipherB64 = Buffer.from('ciphertext').toString('base64');
    store.insert(
      goodInsert({
        blob_id: 'b_pii',
        visitor_email_encrypted: cipherB64,
        visitor_name_encrypted: cipherB64,
        visitor_description_encrypted: cipherB64,
      }),
    );
    const row = store.findById('b_pii');
    expect(row?.visitor_email_encrypted).toBe(cipherB64);
    expect(row?.visitor_name_encrypted).toBe(cipherB64);
    expect(row?.visitor_description_encrypted).toBe(cipherB64);
  });

  it('falls back to pending for an unknown processing_outcome on read', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    // Insert with the closed-list outcome to satisfy the substrate's
    // insert path, then hand-corrupt the column.
    store.insert(goodInsert({ blob_id: 'b_corrupt' }));
    db.prepare(`UPDATE reception_drop_blob_metadata SET processing_outcome = 'martian' WHERE blob_id = ?`).run(
      'b_corrupt',
    );
    expect(store.findById('b_corrupt')?.processing_outcome).toBe('pending');
  });

  it('attaches metadata blob round-trip', () => {
    const db = buildDb();
    const store = createReceptionDropBlobStore(db);
    store.insert(
      goodInsert({
        blob_id: 'b_meta',
        metadata: { source: 'p7-test', count: 7 },
      }),
    );
    expect(store.findById('b_meta')?.metadata).toEqual({ source: 'p7-test', count: 7 });
  });
});
