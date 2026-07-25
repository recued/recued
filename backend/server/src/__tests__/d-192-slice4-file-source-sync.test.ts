/** D-192 file SOURCE family (slice 4) — the `file_meta_ref` reconcile runner + wire.
 *
 *  Three surfaces:
 *   - `projectFileVendorRow` — declaration-driven field map (dotted reads,
 *     size/mtime coercion, provider = vendor slug), over the REAL slice-3
 *     Dropbox + S3 declarations.
 *   - `runFileSourceSync` — one cycle over an injected `listFiles` stub +
 *     a real SQLite `file_meta_ref` store: upsert / hash-skip / complete-walk
 *     delete (fail-closed on the completeness proof + on unkeyable rows) /
 *     row-failure isolation / fetch-failure passthrough.
 *   - `wireFileSourceSync` — one housekeeping task per file Source, gated on
 *     the per-vendor adapter resolver; connection observers; a driven `step`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTION_SOURCE_ID,
  getFileVendorDeclaration,
  validateFileMetaProjection,
  type FileVendorDeclaration,
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
  initialFileSourceSyncState,
  FILE_SOURCE_FULL_WALK_INTERVAL_MS,
  FILE_SOURCE_STALE_AFTER_MS,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';
import { projectFileVendorRow } from '../file-source-projector.js';
import {
  fileSourceSyncTaskId,
  runFileSourceSync,
  wireFileSourceSync,
  type FileSourceListFn,
  type FileSourceListOutcome,
  type FileSourceListRequest,
} from '../file-source-sync.js';
import { createConnectionStore, type ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  clearDefaultHousekeepingRegistry,
  getHousekeepingTask,
  listHousekeepingTasks,
  type HousekeepingAuditRow,
  type HousekeepingContext,
} from '../housekeeping/registry.js';

const NOW = 1_700_000_000_000;

const DROPBOX = getFileVendorDeclaration('dropbox') as FileVendorDeclaration;
const S3 = getFileVendorDeclaration('s3') as FileVendorDeclaration;

const dropboxRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'report.pdf',
  path_display: '/Work/report.pdf',
  size: 1024,
  server_modified: '2026-07-01T00:00:00.000Z',
  rev: 'a1b2',
  id: 'id:abc',
  ...over,
});

// ────────────────────────────────────────────────────────────────
// Projector
// ────────────────────────────────────────────────────────────────

describe('projectFileVendorRow', () => {
  it('maps declared fields, coerces mtime (ISO → ms) + size, sets provider = vendor', () => {
    const r = projectFileVendorRow(dropboxRow(), DROPBOX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection).toMatchObject({
      filename: 'report.pdf',
      path: '/Work/report.pdf',
      size: 1024,
      mtime: Date.parse('2026-07-01T00:00:00.000Z'),
      revision: 'a1b2',
      provider: 'dropbox',
      remote_id: 'id:abc',
    });
    // Dropbox declares no mime_type / owner — those keys stay absent.
    expect(r.projection.mime_type).toBeUndefined();
    expect(r.projection.owner).toBeUndefined();
    expect(validateFileMetaProjection(r.projection)).toEqual([]);
  });

  it('resolves a dotted vendor path (S3 Owner.DisplayName) + reads the leaf name the adapter normalized in', () => {
    // Slice 5: the S3 leaf hands the projector a normalized row — the full
    // `Key` for path/remote_id + a synthetic `name` = the leaf segment, which
    // `projection.filename` reads (the declaration maps `filename: 'name'`).
    const r = projectFileVendorRow(
      {
        Key: 'Work/report.pdf',
        name: 'report.pdf',
        Size: 2048,
        LastModified: '2026-07-01T00:00:00.000Z',
        ETag: '"etag1"',
        Owner: { DisplayName: 'alice' },
      },
      S3,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection).toMatchObject({
      filename: 'report.pdf', // the leaf segment, not the full key
      path: 'Work/report.pdf',
      owner: 'alice',
      provider: 's3',
      remote_id: 'Work/report.pdf',
      size: 2048,
    });
    expect(validateFileMetaProjection(r.projection)).toEqual([]);
  });

  it('coerces an epoch-string mtime and a numeric-string size', () => {
    const r = projectFileVendorRow(dropboxRow({ server_modified: '1700000000000', size: '512' }), DROPBOX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.mtime).toBe(1_700_000_000_000);
    expect(r.projection.size).toBe(512);
  });

  it('fails the row on an unparseable mtime or a bad size (loud, not silent)', () => {
    expect(projectFileVendorRow(dropboxRow({ server_modified: 'not-a-date' }), DROPBOX).ok).toBe(false);
    expect(projectFileVendorRow(dropboxRow({ size: -1 }), DROPBOX).ok).toBe(false);
    expect(projectFileVendorRow(dropboxRow({ size: 'huge' }), DROPBOX).ok).toBe(false);
  });

  it('omits absent optional fields; an absent required field yields an invalid projection (fail-closed downstream)', () => {
    const r = projectFileVendorRow({ name: 'x.pdf' /* no id */ }, DROPBOX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.remote_id).toBe('');
    expect(r.projection.path).toBeUndefined();
    // The empty required field is caught by the meta validator, not the map.
    expect(validateFileMetaProjection(r.projection).length).toBeGreaterThan(0);
    expect(() => buildFileMetaSnapshot(r.projection, NOW)).toThrow(/invalid file meta projection/);
  });
});

// ────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────

const SOURCE = CONNECTION_SOURCE_ID('dropbox', 'conn1', 'file'); // dropbox.conn1.file
const CONNECTION = 'conn1';

let dir: string;
let db: Database.Database;
let store: FileMetaStore;
let syncState: FileSourceSyncStateStore;

const okList = (
  rows: ReadonlyArray<Record<string, unknown>>,
  complete = true,
): FileSourceListOutcome => ({ ok: true, walk: 'full', rows, complete });

/** A DELTA outcome — changed rows + an advanced watermark, never
 *  delete-authoritative by ABSENCE (the leaf returns this when handed a stored
 *  cursor). `removed_paths` (Option 3) carries the vendor's EXPLICIT delete
 *  tombstones (path_display) the runner reverse-looks-up + tombstones. */
const deltaList = (
  rows: ReadonlyArray<Record<string, unknown>>,
  next_cursor: string | null,
  removed_paths: readonly string[] = [],
): FileSourceListOutcome => ({ ok: true, walk: 'delta', rows, next_cursor, complete: false, removed_paths });

const scriptedList = (
  ...outcomes: FileSourceListOutcome[]
): { listFiles: FileSourceListFn; requests: FileSourceListRequest[] } => {
  const queue = [...outcomes];
  const requests: FileSourceListRequest[] = [];
  const listFiles: FileSourceListFn = async (request) => {
    requests.push(request);
    return queue.shift() ?? { ok: false, kind: 'error', reason: 'no scripted outcome' };
  };
  return { listFiles, requests };
};

const runCycle = (
  listFiles: FileSourceListFn,
  now = NOW,
): ReturnType<typeof runFileSourceSync> =>
  runFileSourceSync(
    { store, syncState, listFiles, now: () => now },
    { source_id: SOURCE, connection_name: CONNECTION, declaration: DROPBOX },
  );

describe('runFileSourceSync', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice4-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    // The wire seeds this in prod; seed here so `markStarted`/`markCompleted`
    // (UPDATEs) have a row to write.
    syncState.upsert(initialFileSourceSyncState(SOURCE));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts fetched rows on a first cycle + passes the request shape', async () => {
    const script = scriptedList(okList([
      dropboxRow({ id: 'r1', name: 'a.pdf' }),
      dropboxRow({ id: 'r2', name: 'b.pdf' }),
    ]));
    const result = await runCycle(script.listFiles);
    expect(result).toEqual({ ok: true, upserted: 2, unchanged: 0, deleted: 0, failed_rows: 0, unkeyable: 0, complete: true, walk: 'full' });
    expect(store.list(SOURCE).map((r) => r.target_id).sort()).toEqual(['r1', 'r2']);
    // First boot: no stored watermark ⇒ the runner asks for a FULL walk (cursor null).
    expect(script.requests[0]).toMatchObject({ source_id: SOURCE, connection_name: CONNECTION, vendor: 'dropbox', cursor: null });
  });

  it('hash-skips an unchanged re-list (no re-write, no churn)', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })])).listFiles);
    const second = await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })])).listFiles, NOW + 5);
    expect(second).toMatchObject({ upserted: 0, unchanged: 1, deleted: 0 });
  });

  it('re-writes only a changed row', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1', rev: 'a' }), dropboxRow({ id: 'r2', rev: 'a' })])).listFiles);
    const second = await runCycle(
      scriptedList(okList([dropboxRow({ id: 'r1', rev: 'a' }), dropboxRow({ id: 'r2', rev: 'b' })])).listFiles,
      NOW + 5,
    );
    expect(second).toMatchObject({ upserted: 1, unchanged: 1, deleted: 0 });
    expect(store.list(SOURCE).find((r) => r.target_id === 'r2')?.meta.revision).toBe('b');
  });

  it('tombstones a row absent from a PROVABLY complete walk', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })])).listFiles);
    const second = await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })], true)).listFiles, NOW + 5);
    expect(second).toMatchObject({ deleted: 1, unchanged: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']);
  });

  it('never deletes from an INCOMPLETE walk (fail-closed on the completeness proof)', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })])).listFiles);
    const second = await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })], /* complete */ false)).listFiles, NOW + 5);
    expect(second).toMatchObject({ deleted: 0, complete: false });
    expect(store.list(SOURCE).map((r) => r.target_id).sort()).toEqual(['r1', 'r2']);
  });

  it('fail-closes deletes when the walk carried an unkeyable row', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })])).listFiles);
    // A complete walk, but one row has no keyable remote_id → we cannot prove
    // r1 absent, so nothing is deleted even though r1 is missing here.
    const second = await runCycle(scriptedList(okList([{ name: 'orphan.pdf' /* no id */ }], true)).listFiles, NOW + 5);
    expect(second).toMatchObject({ unkeyable: 1, deleted: 0 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']);
  });

  it('counts a projection-failed row as present (not deleted) but still deletes a genuinely-absent sibling', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })])).listFiles);
    // r1 comes back unprojectable (bad mtime) — keyed + present, so not deleted;
    // r2 is genuinely absent from a complete, fully-keyable walk → deleted.
    const second = await runCycle(
      scriptedList(okList([dropboxRow({ id: 'r1', server_modified: 'not-a-date' })], true)).listFiles,
      NOW + 5,
    );
    expect(second).toMatchObject({ failed_rows: 1, unkeyable: 0, deleted: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // r1 stale-but-kept, r2 gone
  });

  it('passes a fetch failure through as a non-ok cycle', async () => {
    const result = await runCycle(scriptedList({ ok: false, kind: 'config', reason: 'no credential' }).listFiles);
    expect(result).toEqual({ ok: false, kind: 'config', reason: 'no credential' });
    expect(store.list(SOURCE)).toHaveLength(0);
  });

  it('records a clean full cycle on the sync-state row (started + completed + success, cursor + full-walk watermarks stamped)', async () => {
    await runCycle(
      scriptedList({ ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' })], complete: true, next_cursor: 'cur-1' }).listFiles,
    );
    expect(syncState.get(SOURCE)).toMatchObject({
      last_sync_started_at: NOW,
      last_sync_completed_at: NOW,
      last_success_at: NOW,
      degraded: false,
      last_error_code: null,
      cursor_blob: 'cur-1', // the leaf's next_cursor is persisted (delta watermark)
      last_full_walk_at: NOW, // a clean FULL walk stamps the delete-authority watermark
    });
  });

  it('records a degraded cycle (a row failed projection) — degraded, error_code, NO last_success bump', async () => {
    await runCycle(
      scriptedList(okList([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2', server_modified: 'not-a-date' })])).listFiles,
    );
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'projection_failed',
      last_success_at: null, // a partial cycle never counts as a fresh success
      last_sync_completed_at: NOW,
    });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // healthy row still landed
  });

  it('records unkeyable rows as a degraded cycle (rows_unkeyed)', async () => {
    await runCycle(scriptedList(okList([{ name: 'orphan.pdf' /* no id */ }], true)).listFiles);
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'rows_unkeyed',
      last_success_at: null,
    });
  });

  it('records a fetch failure as degraded (fetch_<kind>), never a success', async () => {
    await runCycle(scriptedList({ ok: false, kind: 'config', reason: 'no credential' }).listFiles);
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'fetch_config',
      last_error_message: 'no credential',
      last_success_at: null,
    });
  });

  it('a degraded cycle does not erase a prior clean success timestamp', async () => {
    await runCycle(scriptedList(okList([dropboxRow({ id: 'r1' })])).listFiles); // clean @ NOW
    await runCycle(
      scriptedList(okList([dropboxRow({ id: 'r1', server_modified: 'not-a-date' })], true)).listFiles,
      NOW + 5,
    ); // degraded @ NOW+5
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_success_at: NOW, // held from the prior clean cycle, NOT bumped to NOW+5
      last_sync_completed_at: NOW + 5,
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Delta / hybrid cursor model (Dropbox `full_then_delta`)
// ────────────────────────────────────────────────────────────────

describe('runFileSourceSync — delta cursor (hybrid)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice4-delta-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    syncState.upsert(initialFileSourceSyncState(SOURCE));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first boot full-walks (cursor null), captures the delta watermark + stamps last_full_walk_at', async () => {
    const script = scriptedList({ ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' })], complete: true, next_cursor: 'c1' });
    const result = await runCycle(script.listFiles);
    expect(result).toMatchObject({ walk: 'full', upserted: 1, complete: true });
    expect(script.requests[0]?.cursor).toBeNull();
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'c1', last_full_walk_at: NOW });
  });

  it('a next cycle rides the stored cursor: upserts changes, deletes NOTHING (absence≠gone), advances the cursor, holds last_full_walk_at', async () => {
    const script = scriptedList(
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })], complete: true, next_cursor: 'c1' },
      deltaList([dropboxRow({ id: 'r3', name: 'new.pdf' })], 'c2'),
    );
    await runCycle(script.listFiles, NOW);                          // full baseline: r1, r2
    const delta = await runCycle(script.listFiles, NOW + 60_000);   // delta: +r3, r1/r2 absent
    expect(script.requests[1]?.cursor).toBe('c1');                  // rode the watermark, not a full re-list
    expect(delta).toMatchObject({ walk: 'delta', upserted: 1, deleted: 0 });
    // r1 + r2 are ABSENT from the delta but MUST NOT be tombstoned — the safety invariant.
    expect(store.list(SOURCE).map((r) => r.target_id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'c2', last_full_walk_at: NOW, last_success_at: NOW + 60_000 });
  });

  it('re-baselines with a FULL walk once last_full_walk_at ages past the interval — removals reconcile then', async () => {
    const stale = NOW + FILE_SOURCE_FULL_WALK_INTERVAL_MS + 1;
    const script = scriptedList(
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })], complete: true, next_cursor: 'c1' },
      // A cursor IS stored, but the aged watermark forces a full re-list:
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' })], complete: true, next_cursor: 'c2' },
    );
    await runCycle(script.listFiles, NOW);           // baseline r1, r2
    const rebase = await runCycle(script.listFiles, stale);
    expect(script.requests[1]?.cursor).toBeNull();   // forced full (delete re-baseline)
    expect(rebase).toMatchObject({ walk: 'full', deleted: 1 }); // r2 tombstoned on the re-list
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']);
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'c2', last_full_walk_at: stale });
  });

  it('a degraded delta cycle does NOT advance the cursor (idempotent replay next window)', async () => {
    const script = scriptedList(
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' })], complete: true, next_cursor: 'c1' },
      deltaList([dropboxRow({ id: 'r2', server_modified: 'not-a-date' })], 'c2'), // r2 fails projection
    );
    await runCycle(script.listFiles, NOW);
    const degraded = await runCycle(script.listFiles, NOW + 60_000);
    expect(degraded).toMatchObject({ walk: 'delta', failed_rows: 1 });
    expect(syncState.get(SOURCE)).toMatchObject({
      degraded: true,
      last_error_code: 'projection_failed',
      cursor_blob: 'c1',       // NOT advanced to 'c2' — the same delta replays next window
      last_full_walk_at: NOW,
    });
  });

  it('honors the LEAF walk verdict: a full-walk answer to a delta request (reset fallback) re-bases + re-stamps last_full_walk_at', async () => {
    const script = scriptedList(
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })], complete: true, next_cursor: 'c1' },
      // The runner will REQUEST a delta (cursor present, not due), but the leaf
      // answers with a FULL walk — exactly what the Dropbox reset fallback does.
      { ok: true, walk: 'full', rows: [dropboxRow({ id: 'r1' })], complete: true, next_cursor: 'fresh' },
    );
    await runCycle(script.listFiles, NOW);           // baseline r1,r2; cursor c1, last_full_walk_at NOW
    const t2 = NOW + 60_000;                          // < interval ⇒ the runner requests a delta
    const rebase = await runCycle(script.listFiles, t2);
    expect(script.requests[1]?.cursor).toBe('c1');   // it DID request a delta (rode the stored cursor)
    expect(rebase).toMatchObject({ walk: 'full', deleted: 1 }); // but the full answer re-based + tombstoned r2
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']);
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'fresh', last_full_walk_at: t2 });
  });

  it('a `full`-mode vendor (S3) never rides a cursor even when one is stored', async () => {
    // A delta-capable vendor WOULD ride this stored cursor; S3 is `list.mode: 'full'`.
    const s3Source = CONNECTION_SOURCE_ID('s3', 's3conn', 'file');
    syncState.upsert({ ...initialFileSourceSyncState(s3Source), cursor_blob: 'stale', last_full_walk_at: NOW });
    const script = scriptedList(
      okList([{ Key: 'a.pdf', name: 'a.pdf', Size: 1, LastModified: '2026-07-01T00:00:00.000Z', ETag: '"e"' }]),
    );
    await runFileSourceSync(
      { store, syncState, listFiles: script.listFiles, now: () => NOW + 5 },
      { source_id: s3Source, connection_name: 's3conn', declaration: S3 },
    );
    expect(script.requests[0]?.cursor).toBeNull(); // full-mode ⇒ never a delta
  });
});

// ────────────────────────────────────────────────────────────────
// Explicit delta deletes (Option 3) — a delta's own vendor tombstones
// (`removed_paths`) tombstone the mirror THIS cycle, reverse-looked-up by path.
// ────────────────────────────────────────────────────────────────

describe('runFileSourceSync — explicit delta deletes (Option 3)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice4-xdelete-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    syncState.upsert(initialFileSourceSyncState(SOURCE));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fullBaseline = (
    rows: ReadonlyArray<Record<string, unknown>>,
    next_cursor = 'c1',
  ): FileSourceListOutcome => ({ ok: true, walk: 'full', rows, complete: true, next_cursor });

  it('tombstones the mirror row a delta explicitly reports removed (path→id reverse lookup), immediately — no 24h wait', async () => {
    const script = scriptedList(
      fullBaseline([
        dropboxRow({ id: 'r1', name: 'a.pdf', path_display: '/a.pdf' }),
        dropboxRow({ id: 'r2', name: 'b.pdf', path_display: '/b.pdf' }),
      ]),
      deltaList([], 'c2', ['/b.pdf']), // the vendor SAID /b.pdf is gone
    );
    await runCycle(script.listFiles, NOW);
    const del = await runCycle(script.listFiles, NOW + 60_000);
    expect(del).toMatchObject({ walk: 'delta', deleted: 1, upserted: 0 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // r2 tombstoned by path
    // A clean delta (no failed/unkeyable rows) advances the cursor past the tombstone.
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'c2', last_success_at: NOW + 60_000 });
  });

  it('coexists with absence: an EXPLICIT tombstone deletes, but an ABSENT row on the same delta is KEPT (absence≠gone)', async () => {
    const script = scriptedList(
      fullBaseline([
        dropboxRow({ id: 'r1', name: 'a.pdf', path_display: '/a.pdf' }),
        dropboxRow({ id: 'r2', name: 'b.pdf', path_display: '/b.pdf' }),
      ]),
      // r1 explicitly removed; r2 not mentioned at all; r3 added.
      deltaList([dropboxRow({ id: 'r3', name: 'c.pdf', path_display: '/c.pdf' })], 'c2', ['/a.pdf']),
    );
    await runCycle(script.listFiles, NOW);
    const mix = await runCycle(script.listFiles, NOW + 60_000);
    expect(mix).toMatchObject({ walk: 'delta', deleted: 1, upserted: 1 });
    // r1 gone (explicit), r2 survives (absence is not deletion on a delta), r3 added.
    expect(store.list(SOURCE).map((r) => r.target_id).sort()).toEqual(['r2', 'r3']);
  });

  it('MOVE safety: a re-pathed file (same id, new path, upserted) is NEVER false-deleted by its old-path tombstone', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // Dropbox reports a move as `deleted /A/x.pdf` + `file /B/x.pdf` (SAME id).
      deltaList([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/B/x.pdf' })], 'c2', ['/A/x.pdf']),
    );
    await runCycle(script.listFiles, NOW);
    const mv = await runCycle(script.listFiles, NOW + 60_000);
    expect(mv).toMatchObject({ walk: 'delta', deleted: 0, upserted: 1 }); // re-pathed, NOT deleted
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived the move
    expect(store.list(SOURCE)[0]?.meta.path).toBe('/B/x.pdf'); // now at the new path (guard #1: post-upsert reverse map)
  });

  it('MOVE safety (residual): a moved file whose NEW-path row failed to project is still kept via the polledKeys guard', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // The move's new-path entry fails projection (bad mtime) → the mirror row
      // keeps its OLD path, so guard #1 (post-upsert reverse map) would resolve
      // /A/x.pdf → r1; only `polledKeys` (r1 was keyed before projection) saves it.
      deltaList(
        [dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/B/x.pdf', server_modified: 'not-a-date' })],
        'c2',
        ['/A/x.pdf'],
      ),
    );
    await runCycle(script.listFiles, NOW);
    const mv = await runCycle(script.listFiles, NOW + 60_000);
    expect(mv).toMatchObject({ walk: 'delta', deleted: 0, failed_rows: 1 }); // NOT deleted
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived (polledKeys guard #2)
  });

  it('PATH-REUSE: delete then re-create at the same path in one delta tombstones only the STALE id, keeps the new one', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'id1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // Same path, new id — the reverse map holds BOTH ids (Set); polledKeys keeps id2.
      deltaList([dropboxRow({ id: 'id2', name: 'x.pdf', path_display: '/A/x.pdf' })], 'c2', ['/A/x.pdf']),
    );
    await runCycle(script.listFiles, NOW);
    const reuse = await runCycle(script.listFiles, NOW + 60_000);
    expect(reuse).toMatchObject({ walk: 'delta', deleted: 1, upserted: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['id2']); // stale id1 gone, new id2 kept
  });

  it('a removed path with no matching mirror row is a no-op (never over-deletes)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'a.pdf', path_display: '/a.pdf' })]),
      deltaList([], 'c2', ['/never/mirrored.pdf']),
    );
    await runCycle(script.listFiles, NOW);
    const noop = await runCycle(script.listFiles, NOW + 60_000);
    expect(noop).toMatchObject({ walk: 'delta', deleted: 0 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']);
  });

  it('applies an explicit delete even on a DEGRADED delta cycle, and does NOT advance the cursor (idempotent replay)', async () => {
    const script = scriptedList(
      fullBaseline([
        dropboxRow({ id: 'r1', name: 'a.pdf', path_display: '/a.pdf' }),
        dropboxRow({ id: 'r2', name: 'b.pdf', path_display: '/b.pdf' }),
      ]),
      // A tombstone for /a.pdf rides alongside a row that fails projection — the
      // tombstone is a positive signal, applied regardless of the degradation.
      deltaList([dropboxRow({ id: 'r9', name: 'bad.pdf', server_modified: 'not-a-date' })], 'c2', ['/a.pdf']),
    );
    await runCycle(script.listFiles, NOW);
    const deg = await runCycle(script.listFiles, NOW + 60_000);
    expect(deg).toMatchObject({ walk: 'delta', deleted: 1, failed_rows: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r2']); // r1 removed, r2 kept
    // Degraded ⇒ cursor NOT advanced; the replay re-applies the (now no-op) tombstone idempotently.
    expect(syncState.get(SOURCE)).toMatchObject({ degraded: true, cursor_blob: 'c1' });
  });

  it('SUPPRESSES all explicit deletes when the delta carries an UNKEYABLE row (an unidentified move destination — fail-closed like absence-deletes)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // The moved file re-appears at /B/x.pdf but WITHOUT an `id` (malformed) →
      // it counts as UNKEYABLE and never enters `polledKeys`, so the `polledKeys`
      // move-guard can't protect it. Honoring the /A/x.pdf tombstone would then
      // false-delete the very file that moved. The `unkeyable === 0` gate
      // suppresses ALL explicit deletes this cycle (fail-closed).
      deltaList(
        [{ name: 'x.pdf', path_display: '/B/x.pdf', size: 1024, server_modified: '2026-07-01T00:00:00.000Z', rev: 'a1b2' }],
        'c2',
        ['/A/x.pdf'],
      ),
    );
    await runCycle(script.listFiles, NOW);
    const out = await runCycle(script.listFiles, NOW + 60_000);
    expect(out).toMatchObject({ walk: 'delta', deleted: 0, unkeyable: 1 }); // NOT deleted
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived — not false-deleted
    // Degraded (unkeyable) ⇒ cursor held ⇒ the delta replays once the row keys cleanly.
    expect(syncState.get(SOURCE)).toMatchObject({ degraded: true, cursor_blob: 'c1' });
  });
});

// ────────────────────────────────────────────────────────────────
// Explicit delta deletes by ID (`removed_keys`) — the ID-keyed sibling of
// `removed_paths`, for vendors whose delete tombstone carries the remote id
// directly (Drive `changes` `fileId` / Graph `/delta` `id`). The runner deletes
// the mirror key DIRECTLY — no path reverse lookup — under the same fail-closed
// posture. Driven with the Dropbox declaration as a generic KEYED-ROW VEHICLE:
// the runner acts on the OUTCOME fields, not the declaration slug (a real Drive/
// Graph leaf, the next slice, is what populates `removed_keys`).
// ────────────────────────────────────────────────────────────────

describe('runFileSourceSync — explicit delta deletes by ID (removed_keys)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice4-xkeydelete-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    syncState.upsert(initialFileSourceSyncState(SOURCE));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fullBaseline = (
    rows: ReadonlyArray<Record<string, unknown>>,
    next_cursor = 'c1',
  ): FileSourceListOutcome => ({ ok: true, walk: 'full', rows, complete: true, next_cursor });

  /** A DELTA outcome carrying ID-keyed vendor tombstones (`removed_keys`) — what
   *  a Drive/Graph leaf produces (vs. `deltaList`'s path-keyed `removed_paths`). */
  const deltaListKeys = (
    rows: ReadonlyArray<Record<string, unknown>>,
    next_cursor: string | null,
    removed_keys: readonly string[] = [],
  ): FileSourceListOutcome => ({ ok: true, walk: 'delta', rows, next_cursor, complete: false, removed_keys });

  it('tombstones the mirror row a delta explicitly reports removed BY ID, directly (no reverse lookup), immediately', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })]),
      deltaListKeys([], 'c2', ['r2']), // the vendor SAID id r2 is gone
    );
    await runCycle(script.listFiles, NOW);
    const del = await runCycle(script.listFiles, NOW + 60_000);
    expect(del).toMatchObject({ walk: 'delta', deleted: 1, upserted: 0 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // r2 tombstoned by id
    // A clean delta advances the cursor past the tombstone.
    expect(syncState.get(SOURCE)).toMatchObject({ cursor_blob: 'c2', last_success_at: NOW + 60_000 });
  });

  it('coexists with absence: an EXPLICIT id tombstone deletes, but an ABSENT row on the same delta is KEPT (absence≠gone)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })]),
      // r1 explicitly removed by id; r2 not mentioned at all; r3 added.
      deltaListKeys([dropboxRow({ id: 'r3', name: 'c.pdf', path_display: '/c.pdf' })], 'c2', ['r1']),
    );
    await runCycle(script.listFiles, NOW);
    const mix = await runCycle(script.listFiles, NOW + 60_000);
    expect(mix).toMatchObject({ walk: 'delta', deleted: 1, upserted: 1 });
    // r1 gone (explicit), r2 survives (absence is not deletion on a delta), r3 added.
    expect(store.list(SOURCE).map((r) => r.target_id).sort()).toEqual(['r2', 'r3']);
  });

  it('coexists with removed_paths: a delta carrying BOTH path- and id-keyed tombstones applies both (independent blocks)', async () => {
    const script = scriptedList(
      fullBaseline([
        dropboxRow({ id: 'r1', name: 'a.pdf', path_display: '/a.pdf' }),
        dropboxRow({ id: 'r2', name: 'b.pdf', path_display: '/b.pdf' }),
        dropboxRow({ id: 'r3', name: 'c.pdf', path_display: '/c.pdf' }),
      ]),
      // /a.pdf removed by PATH; r2 removed by ID; r3 untouched.
      { ok: true, walk: 'delta', rows: [], next_cursor: 'c2', complete: false, removed_paths: ['/a.pdf'], removed_keys: ['r2'] },
    );
    await runCycle(script.listFiles, NOW);
    const both = await runCycle(script.listFiles, NOW + 60_000);
    expect(both).toMatchObject({ walk: 'delta', deleted: 2 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r3']); // r1 (path) + r2 (id) gone
  });

  it('delete+re-list safety: an id in BOTH removed_keys AND the upserted rows is KEPT (the live re-list wins)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // The same id rides as a tombstone AND a changed row (a delete+recreate, or a
      // vendor that emits both in one drain) — polledKeys keeps the live row and
      // skips the tombstone; the upsert wins.
      deltaListKeys([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/B/x.pdf' })], 'c2', ['r1']),
    );
    await runCycle(script.listFiles, NOW);
    const mv = await runCycle(script.listFiles, NOW + 60_000);
    expect(mv).toMatchObject({ walk: 'delta', deleted: 0, upserted: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived
    expect(store.list(SOURCE)[0]?.meta.path).toBe('/B/x.pdf'); // the upsert applied (polledKeys guard)
  });

  it('delete+re-list safety (residual): a re-listed id whose row FAILED projection is still kept via polledKeys', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/A/x.pdf' })]),
      // r1 rides as a tombstone AND a changed row that fails projection (bad mtime)
      // → keyed BEFORE projection ⇒ in polledKeys ⇒ the tombstone is skipped.
      deltaListKeys(
        [dropboxRow({ id: 'r1', name: 'x.pdf', path_display: '/B/x.pdf', server_modified: 'not-a-date' })],
        'c2',
        ['r1'],
      ),
    );
    await runCycle(script.listFiles, NOW);
    const mv = await runCycle(script.listFiles, NOW + 60_000);
    expect(mv).toMatchObject({ walk: 'delta', deleted: 0, failed_rows: 1 }); // NOT deleted
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived (polledKeys)
  });

  it('a removed_keys list mixing a KNOWN and an UNKNOWN id deletes only the known one (iterates; unknown is a harmless no-op)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })]),
      // r2 is mirrored (→ deleted); 'never-mirrored' resolves to no row (→ no-op).
      // Asserting deleted === 1 (not 0, not 2) pins BOTH that the loop runs AND
      // that the unknown id never over-deletes a bystander.
      deltaListKeys([], 'c2', ['never-mirrored', 'r2']),
    );
    await runCycle(script.listFiles, NOW);
    const mixed = await runCycle(script.listFiles, NOW + 60_000);
    expect(mixed).toMatchObject({ walk: 'delta', deleted: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // r2 gone, unknown never existed
  });

  it('applies an explicit id delete even on a DEGRADED delta cycle, and does NOT advance the cursor (idempotent replay)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2' })]),
      // A tombstone for r1 rides alongside a row that fails projection — a positive
      // signal, applied regardless of the degradation.
      deltaListKeys([dropboxRow({ id: 'r9', name: 'bad.pdf', server_modified: 'not-a-date' })], 'c2', ['r1']),
    );
    await runCycle(script.listFiles, NOW);
    const deg = await runCycle(script.listFiles, NOW + 60_000);
    expect(deg).toMatchObject({ walk: 'delta', deleted: 1, failed_rows: 1 });
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r2']); // r1 removed, r2 kept
    // Degraded ⇒ cursor NOT advanced; the replay re-applies the (now no-op) tombstone idempotently.
    expect(syncState.get(SOURCE)).toMatchObject({ degraded: true, cursor_blob: 'c1' });
  });

  it('SUPPRESSES all explicit id deletes when the delta carries an UNKEYABLE row (fail-closed like absence-deletes)', async () => {
    const script = scriptedList(
      fullBaseline([dropboxRow({ id: 'r1' })]),
      // A changed row WITHOUT an `id` (unkeyable) may be an unidentified re-appearance
      // of a removed id; honoring the r1 tombstone could false-delete a file we
      // cannot correlate. The `unkeyable === 0` gate suppresses ALL explicit deletes.
      deltaListKeys(
        [{ name: 'x.pdf', path_display: '/B/x.pdf', size: 1024, server_modified: '2026-07-01T00:00:00.000Z', rev: 'a1b2' }],
        'c2',
        ['r1'],
      ),
    );
    await runCycle(script.listFiles, NOW);
    const out = await runCycle(script.listFiles, NOW + 60_000);
    expect(out).toMatchObject({ walk: 'delta', deleted: 0, unkeyable: 1 }); // NOT deleted
    expect(store.list(SOURCE).map((r) => r.target_id)).toEqual(['r1']); // survived — not false-deleted
    // Degraded (unkeyable) ⇒ cursor held ⇒ the delta replays once the row keys cleanly.
    expect(syncState.get(SOURCE)).toMatchObject({ degraded: true, cursor_blob: 'c1' });
  });
});

// ────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────

const upsertApiConnection = (
  cs: ConnectionStoreSqlite,
  name: string,
  vendor: string,
): void => {
  cs.upsert({
    kind: 'api',
    name,
    display_name: name,
    config_json: JSON.stringify({ vendor }),
    auth_ciphertext: 'ciphertext',
    enrolled_at: NOW,
    updated_at: NOW,
  });
};

const stubCtx = (audit: HousekeepingAuditRow[] = []): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: (row) => {
    audit.push(row);
  },
});

describe('wireFileSourceSync', () => {
  let connectionStore: ConnectionStoreSqlite;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-slice4-wire-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileMetaSchema(db);
    store = createFileMetaStore(db);
    ensureFileSourceSyncStateSchema(db);
    syncState = createFileSourceSyncStateStore(db);
    connectionStore = createConnectionStore(db);
    clearDefaultHousekeepingRegistry();
  });
  afterEach(() => {
    clearDefaultHousekeepingRegistry();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers no task without a resolver (slice-4 default) even for a declared file vendor', () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    wireFileSourceSync({ connectionStore, store, syncState });
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('registers no task for a connection whose vendor has no file declaration', () => {
    upsertApiConnection(connectionStore, 'hs', 'hubspot');
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter: () => async () => okList([]) });
    expect(listHousekeepingTasks()).toHaveLength(0);
  });

  it('registers one core reconcile task per file Source (boot scan + later enrollment)', () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    const resolveAdapter = (vendor: string): FileSourceListFn | undefined =>
      vendor === 'dropbox' ? async () => okList([]) : undefined;
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter });

    const bootTaskId = fileSourceSyncTaskId(CONNECTION_SOURCE_ID('dropbox', 'c1', 'file'));
    const bootTask = getHousekeepingTask(bootTaskId);
    expect(bootTask?.meta).toMatchObject({ id: bootTaskId, kind: 'core', idle_eligible: true, interruptible: false });

    // A later enrollment lands through the upsert observer.
    upsertApiConnection(connectionStore, 'c2', 'dropbox');
    expect(getHousekeepingTask(fileSourceSyncTaskId(CONNECTION_SOURCE_ID('dropbox', 'c2', 'file')))).toBeDefined();
    // An S3 connection with no leaf in this resolver registers nothing.
    upsertApiConnection(connectionStore, 's3conn', 's3');
    expect(getHousekeepingTask(fileSourceSyncTaskId(CONNECTION_SOURCE_ID('s3', 's3conn', 'file')))).toBeUndefined();
    expect(listHousekeepingTasks()).toHaveLength(2);
  });

  it('deregisters a file Source task when its connection is deleted', () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter: () => async () => okList([]) });
    const taskId = fileSourceSyncTaskId(CONNECTION_SOURCE_ID('dropbox', 'c1', 'file'));
    expect(getHousekeepingTask(taskId)).toBeDefined();
    connectionStore.delete('api', 'c1');
    expect(getHousekeepingTask(taskId)).toBeUndefined();
  });

  it('the wired task step drives the runner + lands rows + records a clean sync-state row', async () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    const resolveAdapter = (vendor: string): FileSourceListFn | undefined =>
      vendor === 'dropbox'
        ? async () => okList([dropboxRow({ id: 'r1', name: 'a.pdf' }), dropboxRow({ id: 'r2', name: 'b.pdf' })])
        : undefined;
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter });

    const sid = CONNECTION_SOURCE_ID('dropbox', 'c1', 'file');
    const task = getHousekeepingTask(fileSourceSyncTaskId(sid));
    expect(task).toBeDefined();
    const result = await task!.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result).toMatchObject({ status: 'complete' });
    expect(store.list(sid).map((r) => r.target_id).sort()).toEqual(['r1', 'r2']);
    // Health lands on the sync-state row (replacing the slice-4 audit-row stopgap).
    expect(syncState.get(sid)).toMatchObject({ last_success_at: NOW, degraded: false, last_error_code: null });
  });

  it('records a fetch failure on the sync-state row (never a silent success)', async () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    const resolveAdapter = (vendor: string): FileSourceListFn | undefined =>
      vendor === 'dropbox' ? async () => ({ ok: false, kind: 'config', reason: 'no credential' }) : undefined;
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter });

    const sid = CONNECTION_SOURCE_ID('dropbox', 'c1', 'file');
    const task = getHousekeepingTask(fileSourceSyncTaskId(sid))!;
    // Never throws (retry next window), but the failure is recorded as degraded.
    const result = await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(result).toMatchObject({ status: 'complete' });
    expect(syncState.get(sid)).toMatchObject({
      degraded: true,
      last_error_code: 'fetch_config',
      last_success_at: null,
    });
  });

  it('records a degraded cycle (a row failed to project) on the sync-state row + lands the healthy row', async () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    const resolveAdapter = (vendor: string): FileSourceListFn | undefined =>
      vendor === 'dropbox'
        ? async () => okList([dropboxRow({ id: 'r1' }), dropboxRow({ id: 'r2', server_modified: 'not-a-date' })])
        : undefined;
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter });

    const sid = CONNECTION_SOURCE_ID('dropbox', 'c1', 'file');
    const task = getHousekeepingTask(fileSourceSyncTaskId(sid))!;
    await task.step(stubCtx(), { kind: 'complete' }, 60_000);
    expect(syncState.get(sid)).toMatchObject({
      degraded: true,
      last_error_code: 'projection_failed',
      last_success_at: null,
    });
    expect(store.list(sid).map((r) => r.target_id)).toEqual(['r1']);
  });

  it('seeds a sync-state row on registration + deletes it on unregister', () => {
    upsertApiConnection(connectionStore, 'c1', 'dropbox');
    wireFileSourceSync({ connectionStore, store, syncState, resolveAdapter: () => async () => okList([]) });
    const sid = CONNECTION_SOURCE_ID('dropbox', 'c1', 'file');
    // Seeded never-synced at registration (so markStarted / markCompleted have a row).
    expect(syncState.get(sid)).toMatchObject({
      degraded: false,
      last_success_at: null,
      stale_after_ms: FILE_SOURCE_STALE_AFTER_MS,
    });
    connectionStore.delete('api', 'c1');
    expect(syncState.get(sid)).toBeNull(); // runtime state dies with the task
  });
});
