/** D-192 file SOURCE family (slice 6) — the `import_scope` escape hatch (Fork A).
 *
 *  Three surfaces:
 *   - the pure contracts helpers (`deriveScopePrefix` / `compileImportScope` /
 *     `parseImportScopeConfig`) — root-anchored `**`/`*`/`?` matching, the
 *     leading-slash normalization that unifies an S3 `Key` with a Dropbox
 *     `path_display`, a safe literal-prefix derivation, and a LINEAR matcher
 *     (no ReDoS on an adversarial glob);
 *   - the `file_meta_ref` store's `listSourcePaths` (key → stored path, for the
 *     scoped delete diff);
 *   - the reconcile runner's scope behavior — the client-side glob filter +
 *     the STORED-path-bounded, fail-closed delete diff, exercised over BOTH a
 *     path-keyed vendor (S3) and an OPAQUE-keyed one (Dropbox `id`). The
 *     delete-diff scenarios (glob narrowing = cleanup; folder narrowing =
 *     fail-closed keep; a stable-scope legit delete still tombstones; a
 *     present-but-path-unreadable row is never false-deleted) are the point of
 *     the slice — the D-190 rule under a scope. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildImportScope,
  compileImportScope,
  deriveScopePrefix,
  getFileVendorDeclaration,
  parseImportScopeConfig,
  type FileVendorDeclaration,
  type ImportScope,
} from '@recued/contracts';

import {
  buildFileMetaSnapshot,
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import {
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';
import {
  runFileSourceSync,
  type FileSourceListFn,
  type FileSourceListOutcome,
} from '../file-source-sync.js';

const S3 = getFileVendorDeclaration('s3') as FileVendorDeclaration;
const DROPBOX = getFileVendorDeclaration('dropbox') as FileVendorDeclaration;
const NOW = 1_700_000_000_000;

// ────────────────────────────────────────────────────────────────
// A. Contracts — deriveScopePrefix / compileImportScope / parse
// ────────────────────────────────────────────────────────────────

describe('deriveScopePrefix', () => {
  it('cuts at the first wildcard, giving a safe literal (folder) prefix', () => {
    expect(deriveScopePrefix('Work/**')).toBe('Work/');
    expect(deriveScopePrefix('Work/2024/**/*.pdf')).toBe('Work/2024/');
    expect(deriveScopePrefix('Work/*.pdf')).toBe('Work/');
    expect(deriveScopePrefix('**/*.pdf')).toBe(''); // root — no pushdown
    expect(deriveScopePrefix('reports?/x')).toBe('reports'); // ? is a wildcard too
  });

  it('treats a no-wildcard glob as fully literal + strips a single leading slash', () => {
    expect(deriveScopePrefix('Work/report.pdf')).toBe('Work/report.pdf');
    expect(deriveScopePrefix('Work/')).toBe('Work/');
    expect(deriveScopePrefix('/Work/**')).toBe('Work/'); // leading slash normalized
  });
});

describe('compileImportScope.matches', () => {
  const m = (glob: string, path: string): boolean =>
    compileImportScope(buildImportScope(glob)).matches(path);

  it('is ROOT-ANCHORED — `Work/**` matches under Work but not a nested Work', () => {
    expect(m('Work/**', 'Work/a.pdf')).toBe(true);
    expect(m('Work/**', 'Work/sub/deep/a.pdf')).toBe(true);
    expect(m('Work/**', 'Other/Work/a.pdf')).toBe(false);
  });

  it('`**` spans any depth; `*` stays within one segment', () => {
    expect(m('Work/**/*.pdf', 'Work/a.pdf')).toBe(true); // ** = zero segments
    expect(m('Work/**/*.pdf', 'Work/x/y/a.pdf')).toBe(true);
    expect(m('Work/*.pdf', 'Work/a.pdf')).toBe(true);
    expect(m('Work/*.pdf', 'Work/sub/a.pdf')).toBe(false); // * won't cross '/'
    expect(m('Work/**/*.pdf', 'Work/a.txt')).toBe(false);
  });

  it('normalizes a leading slash on BOTH the glob and the path (S3 Key vs Dropbox path_display)', () => {
    expect(m('/Work/**', 'Work/a.pdf')).toBe(true);
    expect(m('Work/**', '/Work/a.pdf')).toBe(true);
    expect(m('Team/**', '/Team/sub/a.pdf')).toBe(true);
  });

  it('a no-wildcard glob is a directory-prefix / exact match', () => {
    expect(m('Work', 'Work/a.pdf')).toBe(true); // under the folder
    expect(m('Work/', 'Work/a.pdf')).toBe(true);
    expect(m('Work', 'Workspace/a.pdf')).toBe(false); // NOT a bare string prefix
    expect(m('Work/report.pdf', 'Work/report.pdf')).toBe(true); // exact file
    expect(m('Work/report.pdf', 'Work/report.pdfx')).toBe(false);
  });

  it('the FOLDER boundary agrees with scope.prefix — a terminal `**` / trailing slash excludes the bare sibling', () => {
    // `Work/**` and `Work/` scope STRICTLY under `Work/` (prefix `Work/`), so a
    // sibling file named exactly `Work` is out of scope — keeping the matcher
    // consistent with the pushdown + the stored-path delete diff (both key on
    // the `Work/` prefix). Only the bare `Work` (no slash) form includes it.
    expect(m('Work/**', 'Work')).toBe(false);
    expect(m('Work/**', 'Work/a.pdf')).toBe(true);
    expect(m('Work/2024/**', 'Work/2024')).toBe(false);
    expect(m('Work/', 'Work')).toBe(false);
    expect(m('Work', 'Work')).toBe(true); // the lenient bare form DOES include it
    expect(deriveScopePrefix('Work/**')).toBe('Work/'); // prefix agrees: excludes bare `Work`
  });

  it('matches a LINEAR time even for an adversarial many-wildcard glob (no ReDoS)', () => {
    const evil = compileImportScope(buildImportScope('*a*a*a*a*a*a*a*a*a*a*a*a*aZ'));
    const t0 = process.hrtime.bigint();
    const got = evil.matches('a'.repeat(500)); // long non-matching input
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(got).toBe(false);
    expect(ms).toBeLessThan(50); // a backtracking regex would take multiple SECONDS
  });
});

describe('parseImportScopeConfig', () => {
  it('resolves absent / empty / whitespace to null (full mirror, no scope)', () => {
    expect(parseImportScopeConfig(undefined)).toEqual({ ok: true, scope: null });
    expect(parseImportScopeConfig(null)).toEqual({ ok: true, scope: null });
    expect(parseImportScopeConfig('')).toEqual({ ok: true, scope: null });
    expect(parseImportScopeConfig('   ')).toEqual({ ok: true, scope: null });
  });

  it('parses a glob into {glob, prefix}, trimming surrounding whitespace', () => {
    expect(parseImportScopeConfig('Work/**')).toEqual({
      ok: true,
      scope: { glob: 'Work/**', prefix: 'Work/' },
    });
    expect(parseImportScopeConfig('  Team/**  ')).toEqual({
      ok: true,
      scope: { glob: 'Team/**', prefix: 'Team/' },
    });
  });

  it('fails closed on a non-string or an over-cap glob (never a silent full mirror)', () => {
    expect(parseImportScopeConfig(42)).toEqual({ ok: false, reason: expect.stringMatching(/string/) });
    expect(parseImportScopeConfig('x'.repeat(2000))).toEqual({
      ok: false,
      reason: expect.stringMatching(/exceeds/),
    });
  });
});

// ────────────────────────────────────────────────────────────────
// B. Store — listSourcePaths
// ────────────────────────────────────────────────────────────────

describe('createFileMetaStore.listSourcePaths', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;
  const SCOPE = 's3.conn.file';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice6-store-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns key → stored path, omitting rows with no stored path', () => {
    store.upsert({
      scope: SCOPE,
      target_id: 'Work/a.pdf',
      meta: buildFileMetaSnapshot({ filename: 'a.pdf', provider: 's3', remote_id: 'Work/a.pdf', path: 'Work/a.pdf' }, NOW),
      now: NOW,
    });
    // A pathless projection is valid (path is optional) → omitted from the map.
    store.upsert({
      scope: SCOPE,
      target_id: 'no-path',
      meta: buildFileMetaSnapshot({ filename: 'x.pdf', provider: 's3', remote_id: 'no-path' }, NOW),
      now: NOW,
    });
    const paths = store.listSourcePaths(SCOPE);
    expect(paths.get('Work/a.pdf')).toBe('Work/a.pdf');
    expect(paths.has('no-path')).toBe(false);
    expect(paths.size).toBe(1);
    expect(store.listSourcePaths('other.scope').size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// C. Runner — scope filter + fail-closed, STORED-path-bounded deletes
// ────────────────────────────────────────────────────────────────

/** A raw S3 leaf row (post-normalization: the leaf split `Key` → leaf `name`).
 *  `remote_id` and `path` both read `Key`, so the key IS the path. */
const s3Row = (key: string): Record<string, unknown> => ({
  Key: key,
  name: key.slice(key.lastIndexOf('/') + 1),
  Size: 10,
  LastModified: '2026-07-01T00:00:00.000Z',
  ETag: '"e"',
});

/** A raw Dropbox leaf row — `remote_id` reads the OPAQUE `id`, `path` reads
 *  `path_display` (leading slash). */
const dbxRow = (id: string, path: string): Record<string, unknown> => ({
  '.tag': 'file',
  name: path.slice(path.lastIndexOf('/') + 1),
  path_display: path,
  id,
  size: 10,
  server_modified: '2026-07-01T00:00:00.000Z',
  rev: 'r1',
});

const okScoped = (
  rows: ReadonlyArray<Record<string, unknown>>,
  scope: ImportScope | null,
  complete = true,
): FileSourceListOutcome => ({ ok: true, walk: 'full', rows, complete, scope });

const scriptedList = (...outcomes: FileSourceListOutcome[]): FileSourceListFn => {
  const queue = [...outcomes];
  return async () => queue.shift() ?? { ok: false, kind: 'error', reason: 'no scripted outcome' };
};

describe('runFileSourceSync — import_scope', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileMetaStore;
  let syncState: FileSourceSyncStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice6-run-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    // These tests assert scope filtering, not health — the runner's
    // markStarted/markCompleted UPDATEs simply no-op on the unseeded row.
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const runS3 = (
    source_id: string,
    listFiles: FileSourceListFn,
    now = NOW,
  ): ReturnType<typeof runFileSourceSync> =>
    runFileSourceSync(
      { store, syncState, listFiles, now: () => now },
      { source_id, connection_name: 'c', declaration: S3 },
    );

  const runDbx = (
    source_id: string,
    listFiles: FileSourceListFn,
    now = NOW,
  ): ReturnType<typeof runFileSourceSync> =>
    runFileSourceSync(
      { store, syncState, listFiles, now: () => now },
      { source_id, connection_name: 'c', declaration: DROPBOX },
    );

  it('client-side filters an out-of-glob row out of the mirror (defends a broad pushdown)', async () => {
    const SRC = 's3.c.file';
    const scope = buildImportScope('Work/**');
    const result = await runS3(SRC, scriptedList(okScoped([s3Row('Work/a.pdf'), s3Row('Other/b.pdf')], scope)));
    expect(result).toMatchObject({ ok: true, upserted: 1 });
    expect(store.list(SRC).map((r) => r.target_id)).toEqual(['Work/a.pdf']); // Other/ dropped
  });

  it('glob narrowing (SAME prefix) cleans up rows the walk saw + the glob rejected', async () => {
    const SRC = 's3.c.file';
    // Cycle 1 — scope `Work/**` mirrors both.
    await runS3(SRC, scriptedList(okScoped([s3Row('Work/a.pdf'), s3Row('Work/b.txt')], buildImportScope('Work/**'))));
    expect(store.list(SRC).map((r) => r.target_id).sort()).toEqual(['Work/a.pdf', 'Work/b.txt']);
    // Cycle 2 — scope narrows to `Work/**/*.pdf` (same prefix `Work/`); the leaf
    // still returns both (same pushdown), the client filter drops `b.txt`, and
    // the stored-path-bounded diff tombstones it (it's UNDER the prefix).
    const c2 = await runS3(
      SRC,
      scriptedList(okScoped([s3Row('Work/a.pdf'), s3Row('Work/b.txt')], buildImportScope('Work/**/*.pdf'))),
      NOW + 5,
    );
    expect(c2).toMatchObject({ deleted: 1 });
    expect(store.list(SRC).map((r) => r.target_id)).toEqual(['Work/a.pdf']);
  });

  it('folder narrowing (prefix change, S3) NEVER tombstones a sibling outside the new prefix (fail-closed)', async () => {
    const SRC = 's3.c.file';
    await runS3(
      SRC,
      scriptedList(okScoped([s3Row('Work/2024/a.pdf'), s3Row('Work/2025/b.pdf')], buildImportScope('Work/**'))),
    );
    // Scope narrows to `Work/2024/**`. The leaf (Prefix `Work/2024/`) returns
    // only the 2024 file; the 2025 sibling was NOT walked, so its absence is
    // unproven → it must NOT be tombstoned (D-190 rule).
    const c2 = await runS3(
      SRC,
      scriptedList(okScoped([s3Row('Work/2024/a.pdf')], buildImportScope('Work/2024/**'))),
      NOW + 5,
    );
    expect(c2).toMatchObject({ deleted: 0, complete: true });
    expect(store.list(SRC).map((r) => r.target_id).sort()).toEqual(['Work/2024/a.pdf', 'Work/2025/b.pdf']);
  });

  it('folder narrowing with OPAQUE keys (Dropbox) also fails closed — the slice-6 stored-path fix', async () => {
    const SRC = 'dropbox.c.file';
    await runDbx(
      SRC,
      scriptedList(
        okScoped(
          [dbxRow('id:a', '/Work/2024/a.pdf'), dbxRow('id:b', '/Work/2025/b.pdf')],
          buildImportScope('Work/**'),
        ),
      ),
    );
    // A Dropbox `id` is opaque (can't be prefix-tested by key). Without the
    // stored-path bound, id:b (path /Work/2025/b.pdf, un-walked under the new
    // `/Work/2024` folder) would be FALSE-deleted. The stored-path diff keeps it.
    const c2 = await runDbx(
      SRC,
      scriptedList(okScoped([dbxRow('id:a', '/Work/2024/a.pdf')], buildImportScope('Work/2024/**'))),
      NOW + 5,
    );
    expect(c2).toMatchObject({ deleted: 0, complete: true });
    expect(store.list(SRC).map((r) => r.target_id).sort()).toEqual(['id:a', 'id:b']);
  });

  it('a STABLE-scope legit delete still tombstones under a scope (opaque keys, Dropbox)', async () => {
    const SRC = 'dropbox.c.file';
    await runDbx(
      SRC,
      scriptedList(
        okScoped([dbxRow('id:a', '/Work/a.pdf'), dbxRow('id:b', '/Work/b.pdf')], buildImportScope('Work/**')),
      ),
    );
    // Same scope; id:b genuinely deleted from Dropbox (absent from a complete
    // walk of `/Work`). Its stored path IS under the prefix → eligible → gone.
    const c2 = await runDbx(
      SRC,
      scriptedList(okScoped([dbxRow('id:a', '/Work/a.pdf')], buildImportScope('Work/**'))),
      NOW + 5,
    );
    expect(c2).toMatchObject({ deleted: 1 });
    expect(store.list(SRC).map((r) => r.target_id)).toEqual(['id:a']);
  });

  it('a present-but-path-unreadable row under a scope is KEPT (not false-deleted) + counted degraded', async () => {
    const SRC = 'dropbox.c.file';
    await runDbx(
      SRC,
      scriptedList(
        okScoped([dbxRow('id:x', '/Work/x.pdf'), dbxRow('id:gone', '/Work/gone.pdf')], buildImportScope('Work/**')),
      ),
    );
    // Cycle 2 — id:x returns with NO path_display (degraded vendor row), id:gone
    // is genuinely absent. id:x must stay present (kept in polledKeys → not
    // deleted); id:gone (stored path under prefix, absent) is tombstoned.
    const pathless = { '.tag': 'file', name: 'x.pdf', id: 'id:x', size: 10, server_modified: '2026-07-02T00:00:00.000Z', rev: 'r2' };
    const c2 = await runDbx(SRC, scriptedList(okScoped([pathless], buildImportScope('Work/**'))), NOW + 5);
    expect(c2).toMatchObject({ failed_rows: 1, deleted: 1 });
    expect(store.list(SRC).map((r) => r.target_id)).toEqual(['id:x']); // id:x kept, id:gone gone
  });

  it('a ROOT scope (empty prefix) leaves every prior key eligible for the diff', async () => {
    const SRC = 's3.c.file';
    // `**/*.pdf` — prefix '' (no pushdown). Filters non-pdf out; a genuinely
    // absent prior pdf is deleted (whole tree walked → all keys eligible).
    await runS3(SRC, scriptedList(okScoped([s3Row('a.pdf'), s3Row('old.pdf'), s3Row('notes.txt')], buildImportScope('**/*.pdf'))));
    expect(store.list(SRC).map((r) => r.target_id).sort()).toEqual(['a.pdf', 'old.pdf']); // notes.txt filtered
    const c2 = await runS3(SRC, scriptedList(okScoped([s3Row('a.pdf')], buildImportScope('**/*.pdf'))), NOW + 5);
    expect(c2).toMatchObject({ deleted: 1 });
    expect(store.list(SRC).map((r) => r.target_id)).toEqual(['a.pdf']); // old.pdf tombstoned
  });

  it('an incomplete scoped walk never deletes (completeness proof still gates)', async () => {
    const SRC = 's3.c.file';
    await runS3(SRC, scriptedList(okScoped([s3Row('Work/a.pdf'), s3Row('Work/b.pdf')], buildImportScope('Work/**'))));
    const c2 = await runS3(
      SRC,
      scriptedList(okScoped([s3Row('Work/a.pdf')], buildImportScope('Work/**'), /* complete */ false)),
      NOW + 5,
    );
    expect(c2).toMatchObject({ deleted: 0, complete: false });
    expect(store.list(SRC).map((r) => r.target_id).sort()).toEqual(['Work/a.pdf', 'Work/b.pdf']);
  });
});
