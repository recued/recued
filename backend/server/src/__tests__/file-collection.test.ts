import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CollectionRecord } from '@recued/contracts';
import {
  createStorageGate,
  type StorageGate,
} from '@recued/storage-gate';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
  type WarehouseEventBus,
} from '@recued/warehouse-events';

import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import { createFileCollection } from '../collections/file/file-collection.js';
import { globToRegExp, matchesAnyIgnore } from '../collections/file/fs-adapter.js';

const BIG_QUOTA = 100 * 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness {
  root: string;
  db: Database.Database;
  gate: StorageGate;
  blobs: BlobStore;
  bus: WarehouseEventBus;
  events: WarehouseEvent[];
  close(): void;
}

const newHarness = (): Harness => {
  // Keep the DB + CAS blobs OUTSIDE the watched root so sqlite's
  // WAL / SHM artefacts never appear in the collection.
  const base = mkdtempSync(join(tmpdir(), 'file-collection-'));
  const root = join(base, 'watched');
  const data = join(base, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, 'test.db'));
  db.pragma('journal_mode = WAL');
  const gate = createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:work' });
  const blobs = createBlobStore(join(data, 'blobs'));
  const bus = createWarehouseEventBus();
  const events: WarehouseEvent[] = [];
  bus.subscribe('**', (e) => { events.push(e); });
  return {
    root, db, gate, blobs, bus, events,
    close() {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
};

const findRecordByPath = (
  collection: ReturnType<typeof createFileCollection>,
  path: string,
): CollectionRecord | undefined =>
  collection.list({ platform: 'file', slug: 'work' })
    .find((r) => r.hot_fields.path === path);

const waitForRecord = async (
  collection: ReturnType<typeof createFileCollection>,
  path: string,
  predicate: (record: CollectionRecord) => boolean = () => true,
): Promise<CollectionRecord | undefined> => {
  const deadline = Date.now() + 3_000;
  do {
    const record = findRecordByPath(collection, path);
    if (record && predicate(record)) return record;
    await sleep(50);
  } while (Date.now() < deadline);
  return findRecordByPath(collection, path);
};

const waitForEvent = async (
  events: readonly WarehouseEvent[],
  eventKind: WarehouseEvent['event_kind'],
): Promise<WarehouseEvent | undefined> => {
  const deadline = Date.now() + 3_000;
  do {
    const event = events.find((e) => e.event_kind === eventKind);
    if (event) return event;
    await sleep(50);
  } while (Date.now() < deadline);
  return events.find((e) => e.event_kind === eventKind);
};

// ────────────────────────────────────────────────────────────────
// Glob matcher unit tests
// ────────────────────────────────────────────────────────────────

describe('globToRegExp + matchesAnyIgnore', () => {
  it('matches a literal filename anywhere in the tree', () => {
    const re = [globToRegExp('.DS_Store')];
    expect(matchesAnyIgnore(re, '.DS_Store')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/.DS_Store')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/other.txt')).toBe(false);
  });

  it('double-star matches nested segments', () => {
    const re = [globToRegExp('**/node_modules/**')];
    expect(matchesAnyIgnore(re, 'node_modules/a.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'a/node_modules/b.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'a/b/node_modules/c/d.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'src/app.ts')).toBe(false);
  });

  it('single-star does not cross path separators', () => {
    const re = [globToRegExp('*.log')];
    expect(matchesAnyIgnore(re, 'a.log')).toBe(true);
    expect(matchesAnyIgnore(re, 'logs/a.log')).toBe(true);
    expect(matchesAnyIgnore(re, 'a.log/something')).toBe(false);
  });

  it('anchored pattern matches only from root', () => {
    const re = [globToRegExp('/top.txt')];
    expect(matchesAnyIgnore(re, 'top.txt')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/top.txt')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Initial scan
// ────────────────────────────────────────────────────────────────

describe('createFileCollection — initial scan', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('indexes every file in the root on start', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'hello');
    mkdirSync(join(h.root, 'sub'), { recursive: true });
    writeFileSync(join(h.root, 'sub', 'b.md'), '# Heading');

    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();

    const records = collection.list({ platform: 'file', slug: 'work' });
    const paths = records.map((r) => r.hot_fields.path).sort();
    expect(paths).toEqual(['a.txt', 'sub/b.md']);
    await collection.close();
  });

  it('respects ignore patterns', async () => {
    writeFileSync(join(h.root, 'keep.txt'), 'keep');
    writeFileSync(join(h.root, '.DS_Store'), '');
    mkdirSync(join(h.root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), '');

    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root,
        ignore: ['.DS_Store', '**/node_modules/**'],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const paths = collection.list({ platform: 'file', slug: 'work' })
      .map((r) => r.hot_fields.path);
    expect(paths).toEqual(['keep.txt']);
    await collection.close();
  });

  it('emits a created event per scanned file', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'hello');

    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    expect(h.events.filter((e) => e.event_kind === 'created').length).toBe(1);
    expect(h.events[0].platform).toBe('file');
    expect(h.events[0].slug).toBe('work');
    await collection.close();
  });
});

// ────────────────────────────────────────────────────────────────
// MIME sniffing
// ────────────────────────────────────────────────────────────────

describe('MIME sniffing + hot fields', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('maps well-known extensions + falls back to octet-stream', async () => {
    writeFileSync(join(h.root, 'note.md'), '# hi');
    writeFileSync(join(h.root, 'config.json'), '{}');
    writeFileSync(join(h.root, 'blob.unknown'), 'xxx');

    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const byName = new Map(
      collection.list({ platform: 'file', slug: 'work' })
        .map((r) => [r.hot_fields.path, r.hot_fields.mime_type] as const),
    );
    expect(byName.get('note.md')).toBe('text/markdown');
    expect(byName.get('config.json')).toBe('application/json');
    expect(byName.get('blob.unknown')).toBe('application/octet-stream');
    await collection.close();
  });

  it('records path + size + mtime hot fields', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'hello');
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const rec = collection.list({ platform: 'file', slug: 'work' })[0];
    expect(rec.hot_fields.path).toBe('a.txt');
    expect(rec.hot_fields.size).toBe(5);
    expect(typeof rec.hot_fields.mtime).toBe('number');
    expect(rec.size_bytes).toBe(5);
    await collection.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Body storage split
// ────────────────────────────────────────────────────────────────

const DEFAULT_MAX = 10 * 1024 * 1024;
const INLINE_CUTOFF = 64 * 1024;

describe('body storage split', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('stores ≤ 64 KB bodies inline (UTF-8 for text)', async () => {
    const content = 'short text';
    writeFileSync(join(h.root, 'tiny.txt'), content);
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const rec = collection.list({ platform: 'file', slug: 'work' })[0];
    expect(rec.body_inline).toBe(content);
    expect(rec.blob_hash).toBeUndefined();
    await collection.close();
  });

  it('spills > 64 KB bodies to CAS', async () => {
    const content = 'x'.repeat(INLINE_CUTOFF + 100);
    writeFileSync(join(h.root, 'big.txt'), content);
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const rec = collection.list({ platform: 'file', slug: 'work' })[0];
    expect(rec.body_inline).toBeUndefined();
    expect(typeof rec.blob_hash).toBe('string');
    // CAS blob readable by hash.
    const bytes = await h.blobs.get(rec.blob_hash!);
    expect(bytes?.toString('utf8')).toBe(content);
    await collection.close();
  });

  it('records metadata only when size > max_body_bytes (body stays on disk)', async () => {
    // Use a tiny cap so we don't need to actually write 10 MB in a test.
    const content = 'x'.repeat(INLINE_CUTOFF + 1_000);
    writeFileSync(join(h.root, 'huge.txt'), content);
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: INLINE_CUTOFF + 100, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const rec = collection.list({ platform: 'file', slug: 'work' })[0];
    expect(rec.body_inline).toBeUndefined();
    expect(rec.blob_hash).toBeUndefined();
    expect(rec.hot_fields.on_disk_only).toBe(true);
    expect(rec.size_bytes).toBe(content.length);
    await collection.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Live fs.watch — create / modify / delete
// ────────────────────────────────────────────────────────────────

// These exercise the real OS file watcher, whose modify/delete event
// delivery is timing-dependent and can be dropped/coalesced under parallel
// load (they pass in isolation). `retry` absorbs a transient missed event so
// CI stays deterministic; set RECUED_SKIP_FS_WATCH_LIVE=1 to skip the block
// entirely on a runner whose watcher misbehaves (escape hatch).
describe.skipIf(process.env.RECUED_SKIP_FS_WATCH_LIVE === '1')(
  'live fs.watch',
  { retry: 3 },
  () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('fires change events when a new file appears', async () => {
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    // Write after start so the event flows through fs.watch rather
    // than the initial scan.
    writeFileSync(join(h.root, 'new.txt'), 'created live');
    const rec = await waitForRecord(collection, 'new.txt');
    expect(rec).toBeDefined();
    expect(rec?.body_inline).toBe('created live');
    await collection.close();
  });

  it('updates the record when content changes', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'v1');
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    writeFileSync(join(h.root, 'a.txt'), 'v2-updated');
    const rec = await waitForRecord(
      collection,
      'a.txt',
      (record) => record.body_inline === 'v2-updated',
    );
    expect(rec?.body_inline).toBe('v2-updated');
    const updated = await waitForEvent(h.events, 'updated');
    expect(updated).toBeDefined();
    await collection.close();
  });

  it('removes the record when a file is deleted', async () => {
    writeFileSync(join(h.root, 'goner.txt'), 'x');
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    unlinkSync(join(h.root, 'goner.txt'));
    const deleted = await waitForEvent(h.events, 'deleted');
    expect(deleted).toBeDefined();
    const records = collection.list({ platform: 'file', slug: 'work' });
    expect(records.find((r) => r.hot_fields.path === 'goner.txt')).toBeUndefined();
    await collection.close();
  });
});

// ────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────

describe('close + health', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('close() stops the fs watcher and leaves health in disconnected', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'x');
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    await collection.close();
    writeFileSync(join(h.root, 'b.txt'), 'added-after-close');
    await sleep(700);
    // No new record from the post-close write.
    const paths = collection.list({ platform: 'file', slug: 'work' }).map((r) => r.hot_fields.path);
    expect(paths).not.toContain('b.txt');
    expect(collection.health().state).toBe('disconnected');
  });

  it('runRetention short-circuits with retention_disabled when retention_days=0', async () => {
    writeFileSync(join(h.root, 'a.txt'), 'x');
    const collection = createFileCollection({
      db: h.db, blobs: h.blobs, gate: h.gate, bus: h.bus, slug: 'work',
      config: () => ({
        path: h.root, ignore: [],
        max_body_bytes: DEFAULT_MAX, retention_days: 0, quota_bytes: BIG_QUOTA,
      }),
    });
    await collection.sync.start();
    const result = await collection.runRetention();
    expect(result.skipped_reason).toBe('retention_disabled');
    await collection.close();
  });
});
