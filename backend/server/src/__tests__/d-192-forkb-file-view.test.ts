/** D-192 Fork B (B1) — the unified `data.file.*` read resolver + its surfaces.
 *
 *  Three surfaces:
 *   - the pure record-id codec (`remoteFileRecordId` / `parseRemoteFileRecordId`)
 *     — a reversible `file:remote:<b64url scope>:<b64url target>` id that
 *     round-trips a `(scope, target_id)` meta-store key through slashes /
 *     colons / unicode, and fail-closes on a CAS id or junk;
 *   - the `FileViewResolver` — `getFileView` (dispatch by id shape) +
 *     `searchFileViews` (merge the CAS collection + the remote meta-store into
 *     one needle-matched, recency-sorted, deduped, capped feed), over a REAL
 *     SQLite `file_meta_ref` store + injected CAS stubs;
 *   - the store's new by-id `get` + cross-scope `searchAll`;
 *   - the `data.mirror.search` files branch end-to-end (a real store + a fake
 *     registry) surfacing remote rows alongside CAS. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleMirrorSearch } from '../collections/collection-handler.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { DataFileRecord } from '../collections/file/inbound-file-collection.js';
import {
  buildFileMetaSnapshot,
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  createFileViewResolver,
  parseRemoteFileRecordId,
  remoteFileRecordId,
} from '../file-view-resolver.js';
import {
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  initialFileSourceSyncState,
  FILE_SOURCE_STALE_AFTER_MS,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';

const NOW = 1_700_000_000_000;

// ────────────────────────────────────────────────────────────────
// Record-id codec
// ────────────────────────────────────────────────────────────────

describe('remote file record-id codec', () => {
  it('round-trips a (scope, target_id) through slashes / colons / unicode', () => {
    const cases: Array<[string, string]> = [
      ['dropbox.myconn.file', 'id:abc123'],
      ['s3.conn.file', 'Work/2024/report (final).pdf'],
      ['s3.conn.file', 'a:b:c/d'], // colons + slash in the target
      ['dropbox.конн.file', '文件.pdf'], // unicode both sides
    ];
    for (const [scope, target_id] of cases) {
      const id = remoteFileRecordId(scope, target_id);
      expect(id.startsWith('file:remote:')).toBe(true);
      expect(parseRemoteFileRecordId(id)).toEqual({ scope, target_id });
    }
  });

  it('is distinguishable from a CAS id and fails closed on junk', () => {
    expect(parseRemoteFileRecordId('file:0123456789abcdef0123456789abcdef')).toBeNull(); // CAS hex id
    expect(parseRemoteFileRecordId('file:remote:onlyonepart')).toBeNull();
    expect(parseRemoteFileRecordId('file:remote::' /* empty parts */)).toBeNull();
    expect(parseRemoteFileRecordId('file:remote:aa:bb:cc' /* 3 parts */)).toBeNull();
    expect(parseRemoteFileRecordId('garbage')).toBeNull();
    expect(parseRemoteFileRecordId('')).toBeNull();
  });

  it('STRICT-rejects a non-canonical base64url encoding (Node decode is permissive)', () => {
    // `Zm9v` is the canonical encoding of `foo`; the aliases below decode to the
    // same bytes under Node's lax decoder but must be rejected as non-canonical.
    const canonical = remoteFileRecordId('foo', 'bar');
    expect(parseRemoteFileRecordId(canonical)).toEqual({ scope: 'foo', target_id: 'bar' });
    expect(parseRemoteFileRecordId('file:remote:Zm9v!:YmFy')).toBeNull(); // stray '!' ignored by Node
    expect(parseRemoteFileRecordId('file:remote:Zm9v====:YmFy')).toBeNull(); // padding
    expect(parseRemoteFileRecordId('file:remote:Zm9v/:YmFy')).toBeNull(); // '/' is base64 (not url)
    expect(parseRemoteFileRecordId('file:remote:Z:YmFy')).toBeNull(); // 1-char (invalid b64 length)
  });
});

// ────────────────────────────────────────────────────────────────
// Store: get + searchAll
// ────────────────────────────────────────────────────────────────

const remoteMeta = (over: {
  filename: string;
  provider: string;
  remote_id: string;
  path?: string;
  mime_type?: string;
  size?: number;
  mtime?: number;
}) =>
  buildFileMetaSnapshot(
    {
      filename: over.filename,
      provider: over.provider,
      remote_id: over.remote_id,
      ...(over.path !== undefined ? { path: over.path } : {}),
      ...(over.mime_type !== undefined ? { mime_type: over.mime_type } : {}),
      ...(over.size !== undefined ? { size: over.size } : {}),
      ...(over.mtime !== undefined ? { mtime: over.mtime } : {}),
    },
    NOW,
  );

describe('FileMetaStore.get + searchAll', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-store-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    store.upsert({
      scope: 'dropbox.c.file',
      target_id: 'id:a',
      meta: remoteMeta({ filename: 'Q3 Report.pdf', provider: 'dropbox', remote_id: 'id:a', path: '/Work/Q3 Report.pdf', mtime: NOW - 1000 }),
      now: NOW,
    });
    store.upsert({
      scope: 's3.c.file',
      target_id: 'Invoices/mar.csv',
      meta: remoteMeta({ filename: 'mar.csv', provider: 's3', remote_id: 'Invoices/mar.csv', path: 'Invoices/mar.csv', mtime: NOW }),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get() fetches one row by (scope, target_id), null on a miss', () => {
    expect(store.get('dropbox.c.file', 'id:a')?.meta.filename).toBe('Q3 Report.pdf');
    expect(store.get('dropbox.c.file', 'id:missing')).toBeNull();
    expect(store.get('nope.file', 'id:a')).toBeNull(); // right target, wrong scope
  });

  it('searchAll() matches filename OR path across scopes, newest-first, capped', () => {
    // 'report' matches the Dropbox filename only.
    expect(store.searchAll('report', 10).map((r) => r.target_id)).toEqual(['id:a']);
    // 'invoices' matches the S3 path only.
    expect(store.searchAll('invoices', 10).map((r) => r.target_id)).toEqual(['Invoices/mar.csv']);
    // a needle in BOTH → both, newest (higher mtime → updated_at) first is
    // driven by updated_at; both share NOW, insertion order holds.
    expect(store.searchAll('.', 10).length).toBe(2); // '.' in both extensions/paths
    expect(store.searchAll('.', 1).length).toBe(1); // cap honored
    expect(store.searchAll('   ', 10)).toEqual([]); // blank → empty
    expect(store.searchAll('nomatch', 10)).toEqual([]);
  });

  it('searchAll() caps by EVENT time (mtime), not ingestion time (updated_at)', () => {
    // Row A: written LATER (higher updated_at) but an OLD file (low mtime).
    // Row B: written EARLIER (lower updated_at) but a NEW file (high mtime).
    // A cap-by-updated_at would keep A and drop B; the picker's recency wants B.
    store.upsert({
      scope: 's3.c.file',
      target_id: 'old-file.txt',
      meta: remoteMeta({ filename: 'zeta-old.txt', provider: 's3', remote_id: 'old-file.txt', mtime: NOW - 10_000 }),
      now: NOW + 5000, // written last
    });
    store.upsert({
      scope: 's3.c.file',
      target_id: 'new-file.txt',
      meta: remoteMeta({ filename: 'zeta-new.txt', provider: 's3', remote_id: 'new-file.txt', mtime: NOW + 10_000 }),
      now: NOW, // written first
    });
    expect(store.searchAll('zeta', 1).map((r) => r.meta.filename)).toEqual(['zeta-new.txt']);
  });

  it('searchAll() escapes LIKE metacharacters (a literal % / _ never wildcards)', () => {
    store.upsert({
      scope: 's3.c.file',
      target_id: '100%_done.txt',
      meta: remoteMeta({ filename: '100%_done.txt', provider: 's3', remote_id: '100%_done.txt' }),
      now: NOW,
    });
    expect(store.searchAll('100%_done', 10).map((r) => r.target_id)).toEqual(['100%_done.txt']);
    expect(store.searchAll('100Xdone', 10)).toEqual([]); // _ is literal, not a single-char wildcard
  });
});

// ────────────────────────────────────────────────────────────────
// Resolver: getFileView + searchFileViews (real store + CAS stubs)
// ────────────────────────────────────────────────────────────────

const casRecord = (record_id: string, filename: string, received_at: number): DataFileRecord =>
  ({
    record_id,
    received_at,
    modified_at: received_at,
    hot_fields: {
      filename,
      mime_type: 'text/plain',
      size: 12,
      content_hash: 'h',
      origin: 'webclient_upload',
      scan_status: 'clean',
      media_class: 'document',
    },
    storage_ref: { kind: 'cas', blob_hash: `blob-${record_id}` },
  }) as unknown as DataFileRecord;

describe('createFileViewResolver', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-resolver-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    store.upsert({
      scope: 'dropbox.c.file',
      target_id: 'id:a',
      meta: remoteMeta({ filename: 'remote-notes.md', provider: 'dropbox', remote_id: 'id:a', path: '/Work/remote-notes.md', size: 99, mtime: NOW }),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const resolverWith = (cas: DataFileRecord[]) =>
    createFileViewResolver({
      fileMetaStore: store,
      casGet: (id) => cas.find((r) => r.record_id === id) ?? null,
      casList: () => cas,
    });

  it('getFileView resolves a remote id from the meta-store (projected, storage_ref:remote)', () => {
    const r = resolverWith([]);
    const id = remoteFileRecordId('dropbox.c.file', 'id:a');
    const v = r.getFileView(id);
    expect(v).toMatchObject({
      record_id: id,
      posture: 'remote',
      storage_ref: { kind: 'remote', provider: 'dropbox', remote_id: 'id:a' },
      filename: 'remote-notes.md',
      path: '/Work/remote-notes.md',
      size: 99,
      provider: 'dropbox',
    });
  });

  it('getFileView resolves a CAS id from the collection; null for a gone / unknown id', () => {
    const r = resolverWith([casRecord('file:0123456789abcdef0123456789abcdef', 'local.txt', NOW)]);
    expect(r.getFileView('file:0123456789abcdef0123456789abcdef')).toMatchObject({
      posture: 'cas',
      filename: 'local.txt',
      storage_ref: { kind: 'cas' },
    });
    expect(r.getFileView(remoteFileRecordId('dropbox.c.file', 'id:gone'))).toBeNull(); // remote miss
    expect(r.getFileView('file:deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull(); // cas miss
    expect(r.getFileView('not-a-file-id')).toBeNull();
  });

  it('searchFileViews merges CAS + remote, dedups, recency-sorts, and caps', () => {
    const cas = [
      casRecord('file:11111111111111111111111111111111', 'local-notes.txt', NOW - 5000),
      casRecord('file:22222222222222222222222222222222', 'unrelated.txt', NOW - 6000),
    ];
    const r = resolverWith(cas);
    // 'notes' matches the CAS `local-notes.txt` (filename) AND the remote
    // `remote-notes.md` (filename). The remote row's mtime (NOW) is newest.
    const views = r.searchFileViews('notes', 10);
    expect(views.map((v) => v.filename)).toEqual(['remote-notes.md', 'local-notes.txt']); // recency DESC
    expect(views.map((v) => v.posture)).toEqual(['remote', 'cas']);
    // cap honored.
    expect(r.searchFileViews('notes', 1).map((v) => v.filename)).toEqual(['remote-notes.md']);
    // blank → empty.
    expect(r.searchFileViews('  ', 10)).toEqual([]);
  });

  it('searchFileViews surfaces CAS rows by FILENAME (the prior path-only match was dead for CAS)', () => {
    const r = resolverWith([casRecord('file:33333333333333333333333333333333', 'budget.xlsx', NOW)]);
    expect(r.searchFileViews('budget', 10).map((v) => v.record_id)).toEqual([
      'file:33333333333333333333333333333333',
    ]);
  });

  it('a resolver with no meta-store surfaces CAS only (no crash)', () => {
    const r = createFileViewResolver({
      casGet: () => null,
      casList: () => [casRecord('file:44444444444444444444444444444444', 'only-cas.txt', NOW)],
    });
    expect(r.searchFileViews('cas', 10).map((v) => v.filename)).toEqual(['only-cas.txt']);
    expect(r.getFileView(remoteFileRecordId('x.file', 'y'))).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// mirror.search files branch — end to end (real store + fake registry)
// ────────────────────────────────────────────────────────────────

const fakeFileCollection = (slug: string, records: DataFileRecord[]): Collection =>
  ({
    platform: 'file',
    slug,
    get: (id: string) => records.find((r) => r.record_id === id) ?? null,
    list: () => records,
  }) as unknown as Collection;

const registryOf = (...collections: Collection[]): CollectionRegistry =>
  ({ list: () => collections }) as unknown as CollectionRegistry;

describe('handleMirrorSearch — files branch (Fork B)', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-mirror-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    store.upsert({
      scope: 'dropbox.c.file',
      target_id: 'id:a',
      meta: remoteMeta({ filename: 'Roadmap.pdf', provider: 'dropbox', remote_id: 'id:a', path: '/Work/Roadmap.pdf', mtime: NOW }),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces a remote mirror row (reversible file:remote id + path sublabel) alongside CAS', async () => {
    const registry = registryOf(
      fakeFileCollection('received', [casRecord('file:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Roadmap-local.txt', NOW - 1000)]),
    );
    const { results } = await handleMirrorSearch({ registry, fileMetaStore: store }, { kind: 'files', query: 'roadmap' });
    // Both the remote pdf AND the CAS local file match 'roadmap'.
    const remoteId = remoteFileRecordId('dropbox.c.file', 'id:a');
    expect(results).toContainEqual({ entity_id: `file:${remoteId}`, label: 'Roadmap.pdf', sublabel: '/Work/Roadmap.pdf' });
    expect(results.some((r) => r.entity_id === 'file:file:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('without a meta-store wired, only CAS files surface (unchanged behavior)', async () => {
    const registry = registryOf(
      fakeFileCollection('received', [casRecord('file:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'roadmap.txt', NOW)]),
    );
    const { results } = await handleMirrorSearch({ registry }, { kind: 'files', query: 'roadmap' });
    expect(results.map((r) => r.entity_id)).toEqual(['file:file:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('surfaces remote rows even with NO file collection registered (mirror-only boot)', async () => {
    // The remote posture lives in its own store, so it must not be gated on a
    // CAS collection being registered — a registry with no `file` platform
    // collection still returns the vendor-mirrored match.
    const registry = registryOf(); // zero collections
    const { results } = await handleMirrorSearch({ registry, fileMetaStore: store }, { kind: 'files', query: 'roadmap' });
    const remoteId = remoteFileRecordId('dropbox.c.file', 'id:a');
    expect(results).toEqual([{ entity_id: `file:${remoteId}`, label: 'Roadmap.pdf', sublabel: '/Work/Roadmap.pdf' }]);
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 Fork B hardening — DataFileView.freshness (remote mirror staleness)
// ────────────────────────────────────────────────────────────────

describe('createFileViewResolver — remote freshness (Fork B hardening)', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;
  let syncState: FileSourceSyncStateStore;
  const SCOPE = 'dropbox.c.file';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-forkb-freshness-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    store.upsert({
      scope: SCOPE, target_id: 'id:a',
      meta: remoteMeta({ filename: 'notes.md', provider: 'dropbox', remote_id: 'id:a', mtime: NOW }),
      now: NOW,
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const resolverWith = (opts: { syncState?: FileSourceSyncStateStore; now?: number }) =>
    createFileViewResolver({
      fileMetaStore: store,
      casGet: () => null,
      casList: () => [],
      ...(opts.syncState ? { syncState: opts.syncState } : {}),
      ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
    });
  const freshnessOf = (r: ReturnType<typeof resolverWith>) =>
    r.getFileView(remoteFileRecordId(SCOPE, 'id:a'))?.freshness;

  it('stamps FRESH when the Source synced recently and is not degraded', () => {
    syncState.upsert({ ...initialFileSourceSyncState(SCOPE), last_success_at: NOW });
    expect(freshnessOf(resolverWith({ syncState, now: NOW + 1000 }))).toEqual({
      last_success_at: NOW, degraded: false, stale: false,
    });
  });

  it('stamps STALE when the last success is older than stale_after_ms', () => {
    syncState.upsert({ ...initialFileSourceSyncState(SCOPE), last_success_at: NOW });
    const later = NOW + FILE_SOURCE_STALE_AFTER_MS + 1;
    expect(freshnessOf(resolverWith({ syncState, now: later }))?.stale).toBe(true);
  });

  it('stamps STALE + degraded when the Source is degraded (regardless of last_success_at)', () => {
    syncState.upsert({ ...initialFileSourceSyncState(SCOPE), last_success_at: NOW, degraded: true });
    expect(freshnessOf(resolverWith({ syncState, now: NOW + 1 }))).toMatchObject({ degraded: true, stale: true });
  });

  it('stamps STALE + never-synced when there is no sync-state row for the Source', () => {
    // No syncState.upsert for SCOPE → the resolver sees null → never-synced.
    expect(freshnessOf(resolverWith({ syncState, now: NOW }))).toEqual({
      last_success_at: null, degraded: false, stale: true,
    });
  });

  it('omits freshness entirely when no sync-state store is wired (back-compat)', () => {
    expect(freshnessOf(resolverWith({ now: NOW }))).toBeUndefined();
  });

  it('a CAS view never carries freshness', () => {
    const r = createFileViewResolver({
      fileMetaStore: store, syncState,
      casGet: (id) => casRecord(id, 'local.txt', NOW),
      casList: () => [],
      now: () => NOW,
    });
    expect(r.getFileView('file:0123456789abcdef0123456789abcdef')?.freshness).toBeUndefined();
  });
});
