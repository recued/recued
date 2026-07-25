/** D-185 Slice 4 — `handleFilePersist`: ingest a confined run-scoped temp
 *  file_ref's bytes into the data.file.received CAS warehouse, returning a
 *  durable cas_ref. Mirrors the inbound-file-collection harness; stages a real
 *  temp file under the run's scratch root and proves the confinement guard. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { TempFileRef } from '@recued/contracts';

import { createBlobStore, type BlobStore } from '../../../storage/blob-store.js';
import { createInboundFileCollection, type InboundFileCollection } from '../inbound-file-collection.js';
import { createCollectionRegistry, type CollectionRegistry } from '../../registry.js';
import { handleFilePersist } from '../file-persist-handler.js';
import {
  allocateRunScratchDir,
  cleanupRunScratch,
} from '../../../execution/run-scratch.js';

interface Harness {
  root: string;
  db: Database.Database;
  blobs: BlobStore;
  registry: CollectionRegistry;
  collection: InboundFileCollection;
}
let h: Harness;

const makeHarness = (): Harness => {
  const root = mkdtempSync(join(tmpdir(), 'd185-persist-'));
  const db = new Database(':memory:');
  const blobs = createBlobStore(join(root, 'blobs'));
  const registry = createCollectionRegistry();
  const gate = createStorageGate({ quota: 100 * 1024 * 1024, reservePct: 10, surface: 'collection:file:received' });
  const collection = createInboundFileCollection({
    db, blobs, gate, bus: createWarehouseEventBus(), slug: 'received', now: () => 1_000,
    log: () => {},
  });
  registry.register(collection);
  return { root, db, blobs, registry, collection };
};

const runIds: string[] = [];
const stageTemp = (run_id: string, name: string, content: string, mime: string): TempFileRef => {
  runIds.push(run_id);
  const dir = allocateRunScratchDir(run_id);
  const path = join(dir, name);
  writeFileSync(path, content);
  return { backing: 'temp', path, mime_type: mime, filename: name };
};

beforeEach(() => { h = makeHarness(); });
afterEach(async () => {
  for (const id of runIds.splice(0)) cleanupRunScratch(id);
  await h.collection.close();
  h.db.close();
  rmSync(h.root, { recursive: true, force: true });
});

describe('handleFilePersist', () => {
  it('ingests a temp ref into the CAS and returns a durable cas_ref', async () => {
    const ref = stageTemp('run-1', 'audio.mp3', 'AUDIO BYTES', 'audio/mpeg');
    const out = await handleFilePersist({ registry: h.registry }, { ref, run_id: 'run-1', step_id: 'keep' });

    expect(out.cas_ref).toMatch(/^file:[0-9a-f]{32}$/);
    expect(out).toMatchObject({
      record_id: out.cas_ref,
      mime_type: 'audio/mpeg',
      filename: 'audio.mp3',
      size_bytes: 11,
    });
    // The bytes are durable in the warehouse: read them back by record_id.
    const stored = await h.collection.readBytes(out.cas_ref);
    expect(stored.bytes.toString('utf8')).toBe('AUDIO BYTES');
    expect(stored.mime_type).toBe('audio/mpeg');
  });

  it('is idempotent across a resume — same (run, step, content) → same cas_ref', async () => {
    const ref = stageTemp('run-2', 'out.mp4', 'VIDEO', 'video/mp4');
    const a = await handleFilePersist({ registry: h.registry }, { ref, run_id: 'run-2', step_id: 's' });
    const b = await handleFilePersist({ registry: h.registry }, { ref, run_id: 'run-2', step_id: 's' });
    expect(a.cas_ref).toBe(b.cas_ref);
  });

  it('foreach-safe — same step_id + same filename but DISTINCT content → distinct cas_refs (no overwrite)', async () => {
    // Two foreach iterations of a transcode step both write `out.mp4`. The
    // content hash (not the filename) keys the record, so iteration 2 never
    // overwrites iteration 1.
    const a = await handleFilePersist(
      { registry: h.registry },
      { ref: stageTemp('run-5', 'out.mp4', 'VIDEO ONE', 'video/mp4'), run_id: 'run-5', step_id: 'convert' },
    );
    const b = await handleFilePersist(
      { registry: h.registry },
      { ref: stageTemp('run-5', 'out.mp4', 'VIDEO TWO', 'video/mp4'), run_id: 'run-5', step_id: 'convert' },
    );
    expect(a.cas_ref).not.toBe(b.cas_ref);
    // Both survive with their own bytes — iteration 1 was not clobbered.
    expect((await h.collection.readBytes(a.cas_ref)).bytes.toString('utf8')).toBe('VIDEO ONE');
    expect((await h.collection.readBytes(b.cas_ref)).bytes.toString('utf8')).toBe('VIDEO TWO');
  });

  it('REFUSES a temp ref whose path escapes the run scratch root (arbitrary-read guard)', async () => {
    stageTemp('run-3', 'real.mp3', 'OK', 'audio/mpeg'); // create the root
    const evil: TempFileRef = { backing: 'temp', path: '/etc/hostname', mime_type: 'text/plain', filename: 'hostname' };
    await expect(
      handleFilePersist({ registry: h.registry }, { ref: evil, run_id: 'run-3' }),
    ).rejects.toThrow(/escapes the run-scratch root|does not exist/);
  });

  it('fails closed (collection_not_found) when data.file.received is unregistered', async () => {
    const ref = stageTemp('run-4', 'x.bin', 'X', 'application/octet-stream');
    const emptyRegistry = createCollectionRegistry();
    await expect(
      handleFilePersist({ registry: emptyRegistry }, { ref, run_id: 'run-4' }),
    ).rejects.toMatchObject({ code: 'collection_not_found' });
  });
});
