/** D-192 slice 2 — the file SOURCE family `file_meta_ref` meta-store.
 *
 *  Covers the canonical `FileMetaProjection` validation (contracts), the
 *  `buildFileMetaSnapshot` stamp (hash-over-projection, excludes snapshot_at
 *  so an unchanged re-poll doesn't churn), and the own-table
 *  `SourceMirrorStore` (upsert / list / listSnapshotHashes / deleteForSource;
 *  first-seen `created_at` preserved on conflict; scope isolation; filters).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isFileMetaProjection,
  validateFileMetaProjection,
  type FileMetaProjection,
} from '@recued/contracts';

import {
  FILE_META_TABLE,
  buildFileMetaSnapshot,
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';

const proj = (over: Partial<FileMetaProjection> = {}): FileMetaProjection => ({
  filename: 'report.pdf',
  path: '/Work/report.pdf',
  mime_type: 'application/pdf',
  size: 1024,
  mtime: 1_700_000_000_000,
  owner: 'alice@example.com',
  revision: 'rev1',
  provider: 'dropbox',
  remote_id: 'id:abc',
  ...over,
});

const SCOPE = 'dropbox.conn1.file';

let dir: string;
let db: Database.Database;
let store: FileMetaStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd192-p2-file-meta-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureFileMetaSchema(db);
  store = createFileMetaStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FileMetaProjection validation', () => {
  it('accepts a minimal (filename + provider + remote_id) and a full projection', () => {
    expect(validateFileMetaProjection({ filename: 'a.txt', provider: 's3', remote_id: 'k' })).toEqual([]);
    expect(validateFileMetaProjection(proj())).toEqual([]);
    expect(isFileMetaProjection(proj())).toBe(true);
  });

  it('rejects missing required fields, over-cap, and bad numeric fields', () => {
    expect(validateFileMetaProjection({ provider: 's3', remote_id: 'k' }).length).toBeGreaterThan(0); // no filename
    expect(validateFileMetaProjection({ filename: 'a', remote_id: 'k' }).length).toBeGreaterThan(0); // no provider
    expect(validateFileMetaProjection({ filename: 'a', provider: 's3' }).length).toBeGreaterThan(0); // no remote_id
    expect(validateFileMetaProjection(proj({ filename: 'x'.repeat(256) })).length).toBeGreaterThan(0);
    expect(validateFileMetaProjection(proj({ size: -1 })).length).toBeGreaterThan(0);
    expect(validateFileMetaProjection(proj({ size: Number.NaN })).length).toBeGreaterThan(0);
    expect(validateFileMetaProjection(proj({ mtime: Number.POSITIVE_INFINITY })).length).toBeGreaterThan(0);
    expect(validateFileMetaProjection(proj({ path: '' })).length).toBeGreaterThan(0); // present-but-empty
    expect(validateFileMetaProjection('nope' as unknown)).toEqual(['file meta must be an object']);
    expect(isFileMetaProjection({ filename: 'a' })).toBe(false);
  });
});

describe('buildFileMetaSnapshot', () => {
  it('stamps snapshot_hash + snapshot_at over the projection', () => {
    const snap = buildFileMetaSnapshot(proj(), 100);
    expect(snap.snapshot_at).toBe(100);
    expect(typeof snap.snapshot_hash).toBe('string');
    expect(snap.snapshot_hash.length).toBeGreaterThan(0);
    expect(snap.filename).toBe('report.pdf');
    expect(snap.remote_id).toBe('id:abc');
  });

  it('hashes the projection only — a re-poll at a different time is hash-stable (no churn)', () => {
    const a = buildFileMetaSnapshot(proj(), 100);
    const b = buildFileMetaSnapshot(proj(), 999);
    expect(a.snapshot_hash).toBe(b.snapshot_hash);
    expect(a.snapshot_at).not.toBe(b.snapshot_at);
  });

  it('hash differs when any projected field changes', () => {
    const base = buildFileMetaSnapshot(proj(), 100).snapshot_hash;
    expect(buildFileMetaSnapshot(proj({ revision: 'rev2' }), 100).snapshot_hash).not.toBe(base);
    expect(buildFileMetaSnapshot(proj({ size: 2048 }), 100).snapshot_hash).not.toBe(base);
    expect(buildFileMetaSnapshot(proj({ filename: 'other.pdf' }), 100).snapshot_hash).not.toBe(base);
  });

  it('throws fail-closed on an invalid projection', () => {
    expect(() => buildFileMetaSnapshot({ filename: '', provider: 's3', remote_id: 'k' } as FileMetaProjection, 100))
      .toThrow(/invalid file meta projection/);
  });

  it('hashes only the declared projection keys — extra/injected keys cannot perturb it', () => {
    const clean = buildFileMetaSnapshot(proj(), 100);
    // A caller carrying extra keys (incl. an injected snapshot_hash/at) must
    // NOT change the hash, and the stored blob must not carry the extras.
    const noisy = buildFileMetaSnapshot(
      { ...proj(), snapshot_hash: 'injected', snapshot_at: 5, foo: 'bar' } as unknown as FileMetaProjection,
      200,
    );
    expect(noisy.snapshot_hash).toBe(clean.snapshot_hash);
    expect(noisy.snapshot_at).toBe(200); // the stamp wins over the injected 5
    expect(Object.keys(noisy)).not.toContain('foo');
    // Round-tripping a built snapshot back through the builder is hash-stable.
    const rebuilt = buildFileMetaSnapshot(clean as unknown as FileMetaProjection, 300);
    expect(rebuilt.snapshot_hash).toBe(clean.snapshot_hash);
  });
});

describe('file_meta_ref store', () => {
  it('creates the table and ensureFileMetaSchema is idempotent', () => {
    const cols = db.prepare(`PRAGMA table_info(${FILE_META_TABLE})`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name).sort()).toEqual(['created_at', 'meta', 'scope', 'target_id', 'updated_at']);
    expect(() => ensureFileMetaSchema(db)).not.toThrow();
  });

  it('upsert + list round-trips the meta blob', () => {
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj(), 100), now: 100 });
    const rows = store.list(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target_id).toBe('id:abc');
    expect(rows[0]?.meta.filename).toBe('report.pdf');
    expect(rows[0]?.meta.provider).toBe('dropbox');
    expect(rows[0]?.meta.snapshot_hash).toEqual(buildFileMetaSnapshot(proj(), 100).snapshot_hash);
  });

  it('preserves first-seen created_at on conflict, updates meta + updated_at', () => {
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj(), 100), now: 100 });
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj({ revision: 'rev2' }), 200), now: 200 });
    const raw = db
      .prepare(`SELECT created_at, updated_at FROM ${FILE_META_TABLE} WHERE scope = ? AND target_id = ?`)
      .get(SCOPE, 'id:abc') as { created_at: number; updated_at: number };
    expect(raw.created_at).toBe(100);
    expect(raw.updated_at).toBe(200);
    expect(store.list(SCOPE)[0]?.meta.revision).toBe('rev2');
  });

  it('listSnapshotHashes maps target_id -> hash; an unchanged re-poll matches (skip)', () => {
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj(), 100), now: 100 });
    const hashes = store.listSnapshotHashes(SCOPE);
    expect(hashes.get('id:abc')).toBe(buildFileMetaSnapshot(proj(), 777).snapshot_hash);
    // A changed re-poll would NOT match -> reconciler treats it as changed.
    expect(hashes.get('id:abc')).not.toBe(buildFileMetaSnapshot(proj({ revision: 'rev2' }), 777).snapshot_hash);
  });

  it('deleteForSource removes a row and reports whether one was removed', () => {
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj(), 100), now: 100 });
    expect(store.deleteForSource(SCOPE, 'id:abc')).toBe(true);
    expect(store.deleteForSource(SCOPE, 'id:abc')).toBe(false);
    expect(store.list(SCOPE)).toHaveLength(0);
  });

  it('isolates scopes', () => {
    store.upsert({ scope: SCOPE, target_id: 'id:abc', meta: buildFileMetaSnapshot(proj(), 100), now: 100 });
    store.upsert({ scope: 'gdrive.conn2.file', target_id: 'id:xyz', meta: buildFileMetaSnapshot(proj({ provider: 'gdrive', remote_id: 'id:xyz' }), 100), now: 100 });
    expect(store.list(SCOPE)).toHaveLength(1);
    expect(store.listSnapshotHashes('gdrive.conn2.file').size).toBe(1);
    expect(store.listSnapshotHashes(SCOPE).has('id:xyz')).toBe(false);
  });

  it('filters list by name_contains / path_prefix / mime_exact / owner_exact and clamps limit', () => {
    store.upsert({ scope: SCOPE, target_id: 'a', meta: buildFileMetaSnapshot(proj({ filename: 'q3-report.pdf', path: '/Work/q3-report.pdf', remote_id: 'a' }), 100), now: 100 });
    store.upsert({ scope: SCOPE, target_id: 'b', meta: buildFileMetaSnapshot(proj({ filename: 'photo.png', path: '/Photos/photo.png', mime_type: 'image/png', owner: 'bob@example.com', remote_id: 'b' }), 101), now: 101 });
    expect(store.list(SCOPE, { name_contains: 'report' }).map((r) => r.target_id)).toEqual(['a']);
    expect(store.list(SCOPE, { path_prefix: '/Photos' }).map((r) => r.target_id)).toEqual(['b']);
    expect(store.list(SCOPE, { mime_exact: 'image/png' }).map((r) => r.target_id)).toEqual(['b']);
    expect(store.list(SCOPE, { owner_exact: 'bob@example.com' }).map((r) => r.target_id)).toEqual(['b']);
    expect(store.list(SCOPE, { limit: 1 })).toHaveLength(1); // ordered by updated_at DESC -> 'b' first
    expect(store.list(SCOPE, { limit: 1 })[0]?.target_id).toBe('b');
  });

  it('treats LIKE metacharacters in a filter literally', () => {
    store.upsert({ scope: SCOPE, target_id: 'a', meta: buildFileMetaSnapshot(proj({ filename: '100%_done.pdf', remote_id: 'a' }), 100), now: 100 });
    store.upsert({ scope: SCOPE, target_id: 'b', meta: buildFileMetaSnapshot(proj({ filename: '100Xdone.pdf', remote_id: 'b' }), 101), now: 101 });
    // '%' is escaped -> matches only the literal-percent name, not the wildcard.
    expect(store.list(SCOPE, { name_contains: '100%_done' }).map((r) => r.target_id)).toEqual(['a']);
  });

  it('defaults a non-finite limit (NaN / Infinity) instead of binding an invalid LIMIT', () => {
    store.upsert({ scope: SCOPE, target_id: 'a', meta: buildFileMetaSnapshot(proj({ remote_id: 'a' }), 100), now: 100 });
    expect(() => store.list(SCOPE, { limit: Number.NaN })).not.toThrow();
    expect(store.list(SCOPE, { limit: Number.NaN })).toHaveLength(1);
    expect(store.list(SCOPE, { limit: Number.POSITIVE_INFINITY })).toHaveLength(1);
  });
});

describe('deleteAllForScope + countForScope (D-192 source-data-removal)', () => {
  const NOW = 1_700_000_000_000;
  const put = (scope: string, id: string): void =>
    store.upsert({ scope, target_id: id, meta: buildFileMetaSnapshot(proj({ remote_id: id }), NOW), now: NOW });

  it('countForScope reflects the rows held for a scope (0 when empty)', () => {
    expect(store.countForScope(SCOPE)).toBe(0);
    put(SCOPE, 'a');
    put(SCOPE, 'b');
    expect(store.countForScope(SCOPE)).toBe(2);
  });

  it('deleteAllForScope removes every row for the scope, returns the count, leaves other Sources intact', () => {
    put(SCOPE, 'a');
    put(SCOPE, 'b');
    put(SCOPE, 'c');
    put('other.conn.file', 'x');
    expect(store.deleteAllForScope(SCOPE)).toBe(3);
    expect(store.countForScope(SCOPE)).toBe(0);
    expect(store.list(SCOPE)).toEqual([]);
    expect(store.countForScope('other.conn.file')).toBe(1); // a different Source untouched
  });

  it('deleteAllForScope is idempotent — an empty/re-run scope returns 0', () => {
    expect(store.deleteAllForScope('nope.conn.file')).toBe(0);
    put(SCOPE, 'a');
    expect(store.deleteAllForScope(SCOPE)).toBe(1);
    expect(store.deleteAllForScope(SCOPE)).toBe(0); // re-run safe
  });
});
