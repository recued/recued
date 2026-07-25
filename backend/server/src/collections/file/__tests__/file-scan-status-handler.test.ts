/** D-173 P5 (scan-gate part B) — `InboundFileCollection.setScanStatus` + the
 *  `handleFileSetScanStatus` handler. Patches a data.file.received record's
 *  scan_status hot field to a scanner verdict, IDEMPOTENTLY (no event when
 *  unchanged), and surfaces it via the MCP-reserved `file-set-scan-status`
 *  kernel op. Mirrors the file-persist-handler harness; a recording bus wrapper
 *  captures the emitted `updated` events. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import { createInboundFileCollection, type InboundFileCollection } from '../inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import { handleFileSetScanStatus } from '../file-scan-status-handler.js';

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
  events: WarehouseEvent[];
}
let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd173-scan-'));
  const db = new Database(':memory:');
  const blobs = createBlobStore(join(root, 'blobs'));
  const registry = createCollectionRegistry();
  const events: WarehouseEvent[] = [];
  const realBus = createWarehouseEventBus();
  // Recording wrapper — capture every emit without glob-pattern plumbing.
  const bus: WarehouseEventBus = {
    ...realBus,
    emit: (e) => {
      events.push(e);
      realBus.emit(e);
    },
  };
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:file:received',
  });
  const collection = createInboundFileCollection({
    db, blobs, gate, bus, slug: 'received', now: () => 1_000, log: () => {},
  });
  registry.register(collection);
  return { root, db, blobs, registry, collection, events };
};

const ingestOne = async (source_id = 'src-1') =>
  h.collection.ingest({
    bytes: Buffer.from('hello world'),
    filename: 'doc.pdf',
    mime_type: 'application/pdf',
    origin: 'reception_drop',
    source_id,
  });

/** Run a synchronous fn that should throw an RpcError, asserting its `code`. */
const expectRpcCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code, `expected RpcError code '${code}'`).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code '${code}', but nothing was thrown`);
};

const MISSING_ID = 'file:' + '0'.repeat(32);

beforeEach(() => { h = makeHarness(); });
afterEach(async () => {
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe('InboundFileCollection.setScanStatus', () => {
  it('patches scan_status and emits `updated` carrying the prior hot_fields', async () => {
    const rec = await ingestOne();
    expect(rec.hot_fields.scan_status).toBe('unscanned');
    h.events.length = 0; // drop the ingest `created`

    const out = h.collection.setScanStatus(rec.record_id, 'clean');
    expect(out?.hot_fields.scan_status).toBe('clean');

    const updates = h.events.filter((e) => e.event_kind === 'updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.record_id).toBe(rec.record_id);
    // D-124 prev snapshot — the PRIOR verdict rides the event.
    expect((updates[0]!.prev as { scan_status?: string }).scan_status).toBe('unscanned');
  });

  it('is idempotent — re-reporting the SAME verdict emits NO event', async () => {
    const rec = await ingestOne();
    h.collection.setScanStatus(rec.record_id, 'flagged'); // unscanned -> flagged (one event)
    h.events.length = 0;

    const again = h.collection.setScanStatus(rec.record_id, 'flagged');
    expect(again?.hot_fields.scan_status).toBe('flagged');
    expect(h.events).toHaveLength(0); // unchanged -> no spurious `updated`
  });

  it('returns null for a vanished record (benign retention race)', () => {
    expect(h.collection.setScanStatus(MISSING_ID, 'clean')).toBeNull();
    expect(h.events).toHaveLength(0);
  });

  it('preserves the CAS bytes across the verdict patch (storage_ref round-trip)', async () => {
    const rec = await ingestOne();
    h.collection.setScanStatus(rec.record_id, 'flagged');
    const read = await h.collection.readBytes(rec.record_id);
    expect(read.bytes.toString('utf8')).toBe('hello world');
    expect(read.mime_type).toBe('application/pdf');
    // The record still resolves with the new verdict (hydration intact).
    expect(h.collection.get(rec.record_id)?.hot_fields.scan_status).toBe('flagged');
  });
});

describe('handleFileSetScanStatus', () => {
  it('patches the verdict and returns a flat {record_id, scan_status}', async () => {
    const rec = await ingestOne();
    const out = handleFileSetScanStatus(
      { registry: h.registry },
      { record_id: rec.record_id, status: 'clean' },
    );
    expect(out).toEqual({ record_id: rec.record_id, scan_status: 'clean' });
  });

  it('rejects a missing record_id (bad_request)', () => {
    expectRpcCode(
      () => handleFileSetScanStatus({ registry: h.registry }, { status: 'clean' }),
      'bad_request',
    );
  });

  it('rejects an invalid status (bad_request) — only the FileScanStatus union is admitted', async () => {
    const rec = await ingestOne();
    expectRpcCode(
      () => handleFileSetScanStatus({ registry: h.registry }, { record_id: rec.record_id, status: 'infected' }),
      'bad_request',
    );
  });

  it('fails closed (collection_not_found) when data.file.received is unregistered', () => {
    const empty = createCollectionRegistry();
    expectRpcCode(
      () => handleFileSetScanStatus({ registry: empty }, { record_id: MISSING_ID, status: 'clean' }),
      'collection_not_found',
    );
  });

  it('throws file_not_found for a vanished record', () => {
    expectRpcCode(
      () => handleFileSetScanStatus({ registry: h.registry }, { record_id: MISSING_ID, status: 'clean' }),
      'file_not_found',
    );
  });
});
