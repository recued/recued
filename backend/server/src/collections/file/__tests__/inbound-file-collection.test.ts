import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import { handleCollectionGet } from '../../collection-handler.js';

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
  logs: Array<{ level: string; msg: string; data?: unknown }>;
}

let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd172-inbound-file-'));
  const db = new Database(':memory:');
  const blobs = createBlobStore(join(root, 'blobs'));
  const registry = createCollectionRegistry();
  const logs: Harness['logs'] = [];
  const gate = createStorageGate({
    quota: 100 * 1024 * 1024,
    reservePct: 10,
    surface: 'collection:file:received',
  });
  const collection = createInboundFileCollection({
    db,
    blobs,
    gate,
    bus: createWarehouseEventBus(),
    slug: 'received',
    now: () => 1_000,
    log: (level, msg, data) => logs.push({ level, msg, data }),
  });
  registry.register(collection);
  return { root, db, blobs, registry, collection, logs };
};

beforeEach(() => {
  h = makeHarness();
});

afterEach(async () => {
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe('data.file.received ingest', () => {
  it('uses deterministic per-ingest record ids while sharing identical CAS bytes', async () => {
    const bytes = Buffer.from('same file body');
    const first = await h.collection.ingest({
      bytes,
      filename: '../voice-note.wav',
      mime_type: 'audio/wav',
      origin: 'reception_drop',
      source_id: 'drop-1',
      scan_status: 'pending',
      now: 1_000,
    });

    expect(first.record_id).toBe(inboundFileRecordId('reception_drop', 'drop-1'));
    expect(first.record_id).toMatch(/^file:[0-9a-f]{32}$/);
    expect(first.received_at).toBe(1_000);
    expect(first.modified_at).toBe(1_000);
    expect(first.hot_fields).toMatchObject({
      filename: 'voice-note.wav',
      mime_type: 'audio/wav',
      size: bytes.length,
      content_hash: sha256(bytes),
      origin: 'reception_drop',
      scan_status: 'pending',
      media_class: 'voice',
    });
    expect(first.storage_ref).toEqual({ kind: 'cas', blob_hash: sha256(bytes) });
    expect(await h.blobs.get(sha256(bytes))).toEqual(bytes);

    const redrain = await h.collection.ingest({
      bytes,
      filename: 'renamed.wav',
      mime_type: 'audio/wav',
      origin: 'reception_drop',
      source_id: 'drop-1',
      scan_status: 'clean',
      now: 2_000,
    });
    expect(redrain.record_id).toBe(first.record_id);
    expect(redrain.received_at).toBe(1_000);
    expect(redrain.modified_at).toBe(2_000);
    expect(redrain.hot_fields.filename).toBe('renamed.wav');
    expect(redrain.hot_fields.scan_status).toBe('clean');

    const secondSource = await h.collection.ingest({
      bytes,
      filename: 'copy.wav',
      mime_type: 'audio/wav',
      origin: 'reception_drop',
      source_id: 'drop-2',
      now: 3_000,
    });
    expect(secondSource.record_id).toBe(inboundFileRecordId('reception_drop', 'drop-2'));
    expect(secondSource.record_id).not.toBe(first.record_id);
    expect(secondSource.storage_ref).toEqual(first.storage_ref);
  });

  it('accepts pre-stored CAS refs and derives image/document media classes', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const blob_hash = await h.blobs.put(imageBytes);
    const image = await h.collection.ingest({
      storage_ref: { kind: 'cas', blob_hash },
      filename: 'photo.png',
      mime_type: 'image/png',
      size_bytes: imageBytes.length,
      origin: 'messenger_media',
      source_id: 'msg-1',
      now: 1_111,
    });
    expect(image.hot_fields.media_class).toBe('image');
    expect(image.hot_fields.content_hash).toBe(blob_hash);
    expect(image.storage_ref).toEqual({ kind: 'cas', blob_hash });

    const remote = await h.collection.ingest({
      storage_ref: {
        kind: 'remote',
        provider: 'mailbox',
        remote_id: 'part-1',
        fetch_hint: 'headers-only',
      },
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      content_hash: '0'.repeat(64),
      size_bytes: 44,
      origin: 'mail_attachment',
      source_id: 'mail-1',
      now: 1_222,
    });
    expect(remote.hot_fields.media_class).toBe('document');
    expect(remote.storage_ref).toEqual({
      kind: 'remote',
      provider: 'mailbox',
      remote_id: 'part-1',
      fetch_hint: 'headers-only',
    });
    expect(remote.blob_hash).toBeUndefined();
  });

  it('rejects writes without bytes or a forward-compatible storage ref', async () => {
    await expect(
      h.collection.ingest({
        filename: 'missing.pdf',
        mime_type: 'application/pdf',
        origin: 'reception_drop',
        source_id: 'drop-missing',
      }),
    ).rejects.toThrow(/exactly one of bytes, storage_ref, or src_path/);

    await expect(
      h.collection.ingest({
        bytes: Buffer.from('x'),
        storage_ref: { kind: 'cas', blob_hash: '1'.repeat(64) },
        filename: 'both.pdf',
        mime_type: 'application/pdf',
        origin: 'reception_drop',
        source_id: 'drop-both',
      }),
    ).rejects.toThrow(/exactly one of bytes, storage_ref, or src_path/);
  });
});

describe('data.file.received resolution and CAS sweep', () => {
  it('resolves metadata through the collection handler without materializing bytes', async () => {
    const bytes = Buffer.from('resolver payload');
    const record = await h.collection.ingest({
      bytes,
      filename: 'resolver.txt',
      mime_type: 'text/plain',
      origin: 'reception_drop',
      source_id: 'drop-resolver',
      now: 4_000,
    });

    const resolved = await handleCollectionGet(
      { registry: h.registry },
      { platform: 'file', slug: 'received', record_id: record.record_id },
    );

    expect(resolved.record).not.toBeNull();
    expect(resolved.record?.record_id).toBe(record.record_id);
    expect(resolved.record?.hot_fields).toMatchObject({
      filename: 'resolver.txt',
      mime_type: 'text/plain',
      media_class: 'document',
    });
    expect((resolved.record as { storage_ref?: unknown }).storage_ref).toEqual(record.storage_ref);
    expect((resolved.record as { bytes_b64?: unknown }).bytes_b64).toBeUndefined();
    expect(resolved.record?.body_inline).toBeUndefined();
  });

  it('sweeps only CAS blobs absent from the live received keep-set', async () => {
    const sharedBytes = Buffer.from('shared content');
    const orphanHash = await h.blobs.put(Buffer.from('orphan content'));
    const first = await h.collection.ingest({
      bytes: sharedBytes,
      filename: 'first.txt',
      mime_type: 'text/plain',
      origin: 'reception_drop',
      source_id: 'drop-first',
      now: 5_000,
    });
    const second = await h.collection.ingest({
      bytes: sharedBytes,
      filename: 'second.txt',
      mime_type: 'text/plain',
      origin: 'reception_drop',
      source_id: 'drop-second',
      now: 5_001,
    });
    const sharedHash = first.storage_ref.kind === 'cas' ? first.storage_ref.blob_hash : '';
    expect(second.storage_ref).toEqual(first.storage_ref);
    expect(await h.blobs.has(sharedHash)).toBe(true);
    expect(await h.blobs.has(orphanHash)).toBe(true);

    const firstSweep = await h.collection.sweepOrphanCasBlobs();
    expect(firstSweep).toEqual({
      keep_count: 1,
      deleted_count: 1,
      covered: ['live data.file.received records with storage_ref.kind=cas'],
      truncated: false,
    });
    expect(await h.blobs.has(orphanHash)).toBe(false);
    expect(await h.blobs.has(sharedHash)).toBe(true);

    h.collection.delete(first.record_id);
    const secondSweep = await h.collection.sweepOrphanCasBlobs();
    expect(secondSweep.deleted_count).toBe(0);
    expect(secondSweep.keep_count).toBe(1);
    expect(await h.blobs.has(sharedHash)).toBe(true);

    h.collection.delete(second.record_id);
    const thirdSweep = await h.collection.sweepOrphanCasBlobs();
    expect(thirdSweep.deleted_count).toBe(1);
    expect(thirdSweep.keep_count).toBe(0);
    expect(await h.blobs.has(sharedHash)).toBe(false);
    expect(h.logs.map((log) => log.msg)).toContain('data.file.received.cas_sweep');
  });
});
