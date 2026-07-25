/** SMB-finance wedge slice 3 — inbound file collection `readBytes` + the
 *  `file_ref` record-id predicate + the `connection_download` origin.
 *
 *  `readBytes` is the server-internal CAS read the cli executor uses to
 *  materialize a docling `source` file_ref to a temp file. `isInboundFileRecordId`
 *  is the dual-lane gate (a `file:<32 hex>` ref is materialized; a local path is
 *  passed through). The `connection_download` origin labels a downloaded body. */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createBlobStore } from '../storage/blob-store.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createStorageGate } from '@recued/storage-gate';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  isInboundFileRecordId,
  INBOUND_FILE_RECORD_ID_PATTERN,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';

const NOW = 1_800_000_000_000;
const BIG_QUOTA = 1024 * 1024 * 1024;

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const newColl = (): InboundFileCollection => {
  const dir = mkdtempSync(join(tmpdir(), 'd3-inbound-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const coll = createInboundFileCollection({
    db,
    blobs: createBlobStore(join(dataDir, 'blobs')),
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:received' }),
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => NOW,
  });
  cleanup.push(() => db.close());
  return coll;
};

describe('isInboundFileRecordId — dual-lane gate', () => {
  it('matches a canonical file_ref record_id (file:<32 hex>) and nothing else', () => {
    const ref = inboundFileRecordId('connection_download', 'run-1:file.download:1AbC');
    expect(ref).toMatch(INBOUND_FILE_RECORD_ID_PATTERN);
    expect(isInboundFileRecordId(ref)).toBe(true);

    // local paths / URIs / wrong shapes pass through (the manual lane)
    expect(isInboundFileRecordId('/Users/me/invoice.pdf')).toBe(false);
    expect(isInboundFileRecordId('file:///Users/me/invoice.pdf')).toBe(false);
    expect(isInboundFileRecordId('https://example.com/a.pdf')).toBe(false);
    expect(isInboundFileRecordId('file:short')).toBe(false);
    expect(isInboundFileRecordId('file:' + 'Z'.repeat(32))).toBe(false); // non-hex
    expect(isInboundFileRecordId(undefined)).toBe(false);
  });
});

describe('inbound file collection — readBytes + connection_download origin', () => {
  it('ingests a connection_download body and reads its CAS bytes back', async () => {
    const coll = newColl();
    const bytes = Buffer.from('%PDF-1.7 downloaded invoice bytes');
    const rec = await coll.ingest({
      bytes,
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      origin: 'connection_download',
      source_id: 'run-1:file.download:1AbC',
    });

    expect(rec.hot_fields.origin).toBe('connection_download');
    expect(isInboundFileRecordId(rec.record_id)).toBe(true);

    const read = await coll.readBytes(rec.record_id);
    expect(read.bytes.equals(bytes)).toBe(true);
    expect(read.filename).toBe('invoice.pdf');
    expect(read.mime_type).toBe('application/pdf');
  });

  it('readBytes throws on an unknown record', async () => {
    const coll = newColl();
    await expect(coll.readBytes('file:' + 'a'.repeat(32))).rejects.toThrow(/unknown record/);
  });
});
