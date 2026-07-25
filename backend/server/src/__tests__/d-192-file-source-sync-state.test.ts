/** D-192 file SOURCE family — the `file_source_sync_state` health/cursor store.
 *
 *  Clones `work_entity_source_sync_state`, thinned for the read-only meta
 *  mirror: seed → markStarted → markCompleted(ok|err) → deleteForSource, with
 *  the load-bearing invariant that a degraded / failed cycle records the error +
 *  sets `degraded` WITHOUT bumping `last_success_at` (the freshness reader keys
 *  on that). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createFileSourceSyncStateStore,
  deriveFileSourceFreshness,
  ensureFileSourceSyncStateSchema,
  initialFileSourceSyncState,
  FILE_SOURCE_STALE_AFTER_MS,
  FILE_SOURCE_SYNC_STATE_TABLE,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';

const SID = 's3.conn.file';
const T0 = 1_700_000_000_000;

describe('file_source_sync_state store', () => {
  let dir: string;
  let db: Database.Database;
  let store: FileSourceSyncStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd192-fss-'));
    db = new Database(join(dir, 'test.db'));
    ensureFileSourceSyncStateSchema(db);
    store = createFileSourceSyncStateStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get returns null before any seed', () => {
    expect(store.get(SID)).toBeNull();
  });

  it('seeds a never-synced row (all-null health, the file-source stale constant)', () => {
    store.upsert(initialFileSourceSyncState(SID));
    expect(store.get(SID)).toEqual({
      source_id: SID,
      cursor_blob: null,
      last_sync_started_at: null,
      last_sync_completed_at: null,
      last_success_at: null,
      last_full_walk_at: null,
      last_error_code: null,
      last_error_message: null,
      degraded: false,
      stale_after_ms: FILE_SOURCE_STALE_AFTER_MS,
    });
  });

  it('markStarted stamps only started_at (rest intact)', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markStarted(SID, T0);
    expect(store.get(SID)).toMatchObject({
      last_sync_started_at: T0,
      last_sync_completed_at: null,
      last_success_at: null,
      degraded: false,
    });
  });

  it('markCompleted(ok) bumps completed + success + cursor, clears error/degraded', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markStarted(SID, T0);
    store.markCompleted(SID, { ok: true, cursor_blob: 'cur-1', now: T0 + 10 });
    expect(store.get(SID)).toMatchObject({
      last_sync_started_at: T0,
      last_sync_completed_at: T0 + 10,
      last_success_at: T0 + 10,
      cursor_blob: 'cur-1',
      last_error_code: null,
      last_error_message: null,
      degraded: false,
    });
  });

  it('markCompleted(ok) with no cursor persists null', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markCompleted(SID, { ok: true, now: T0 });
    expect(store.get(SID)?.cursor_blob).toBeNull();
  });

  it('markCompleted(ok, full_walk:true) stamps last_full_walk_at; a delta cycle (omitted) leaves it', () => {
    store.upsert(initialFileSourceSyncState(SID));
    // A clean FULL walk stamps the delete-authority watermark.
    store.markCompleted(SID, { ok: true, cursor_blob: 'c1', full_walk: true, now: T0 });
    expect(store.get(SID)).toMatchObject({ last_full_walk_at: T0, cursor_blob: 'c1', last_success_at: T0 });
    // A later clean DELTA cycle advances the cursor + success but NOT the full-walk watermark.
    store.markCompleted(SID, { ok: true, cursor_blob: 'c2', now: T0 + 50 });
    expect(store.get(SID)).toMatchObject({ last_full_walk_at: T0, cursor_blob: 'c2', last_success_at: T0 + 50 });
  });

  it('a degraded cycle never stamps last_full_walk_at (no clean baseline was proven)', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markCompleted(SID, { ok: true, full_walk: true, now: T0 }); // baseline @ T0
    store.markCompleted(SID, { ok: false, error_code: 'projection_failed', error_message: 'x', now: T0 + 100 });
    // The failure records the error but holds last_full_walk_at at the prior clean baseline.
    expect(store.get(SID)).toMatchObject({ degraded: true, last_full_walk_at: T0 });
  });

  it('markCompleted(err) records the error + sets degraded WITHOUT bumping last_success_at', () => {
    store.upsert(initialFileSourceSyncState(SID));
    // a prior clean cycle establishes a success timestamp
    store.markCompleted(SID, { ok: true, now: T0 });
    // then a failing cycle
    store.markCompleted(SID, {
      ok: false,
      error_code: 'fetch_config',
      error_message: 'no credential',
      now: T0 + 100,
    });
    expect(store.get(SID)).toMatchObject({
      degraded: true,
      last_error_code: 'fetch_config',
      last_error_message: 'no credential',
      last_sync_completed_at: T0 + 100,
      last_success_at: T0, // held from the prior clean cycle, never overwritten by a failure
    });
  });

  it('a clean cycle after a failure clears the degraded flag + error', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markCompleted(SID, { ok: false, error_code: 'projection_failed', error_message: 'x', now: T0 });
    expect(store.get(SID)).toMatchObject({ degraded: true, last_error_code: 'projection_failed' });
    store.markCompleted(SID, { ok: true, now: T0 + 5 });
    expect(store.get(SID)).toMatchObject({
      degraded: false,
      last_error_code: null,
      last_error_message: null,
      last_success_at: T0 + 5,
    });
  });

  it('upsert replaces an existing row', () => {
    store.upsert(initialFileSourceSyncState(SID));
    store.markCompleted(SID, { ok: true, cursor_blob: 'c', now: T0 });
    store.upsert({ ...initialFileSourceSyncState(SID), last_error_code: 'seeded', degraded: true });
    expect(store.get(SID)).toMatchObject({ last_error_code: 'seeded', degraded: true, last_success_at: null, cursor_blob: null });
  });

  it('deleteForSource removes the row (reports whether it existed)', () => {
    store.upsert(initialFileSourceSyncState(SID));
    expect(store.deleteForSource(SID)).toBe(true);
    expect(store.get(SID)).toBeNull();
    expect(store.deleteForSource(SID)).toBe(false);
  });

  it('markStarted / markCompleted on an absent row are harmless no-ops (never throw / create)', () => {
    expect(() => store.markStarted(SID, T0)).not.toThrow();
    expect(() => store.markCompleted(SID, { ok: true, now: T0 })).not.toThrow();
    expect(store.get(SID)).toBeNull();
  });

  it('reconciles the additive last_full_walk_at column onto a pre-delta-cursor table (no wipe, no crash)', () => {
    // A DB created by the sync-state slice, BEFORE delta cursors — the old shape
    // with no last_full_walk_at column + a pre-existing row.
    const legacyDir = mkdtempSync(join(tmpdir(), 'd192-fss-legacy-'));
    const legacyDb = new Database(join(legacyDir, 'test.db'));
    try {
      legacyDb.exec(`
        CREATE TABLE ${FILE_SOURCE_SYNC_STATE_TABLE} (
          source_id               TEXT PRIMARY KEY,
          cursor_blob             TEXT,
          last_sync_started_at    INTEGER,
          last_sync_completed_at  INTEGER,
          last_success_at         INTEGER,
          last_error_code         TEXT,
          last_error_message      TEXT,
          degraded                INTEGER NOT NULL DEFAULT 0,
          stale_after_ms          INTEGER NOT NULL
        );
      `);
      legacyDb
        .prepare(`INSERT INTO ${FILE_SOURCE_SYNC_STATE_TABLE} (source_id, degraded, stale_after_ms) VALUES (?, 0, ?)`)
        .run(SID, FILE_SOURCE_STALE_AFTER_MS);

      // The ensure path must ADD the column (not wipe / not crash), so the store's
      // prepared statements referencing last_full_walk_at bind cleanly.
      expect(() => ensureFileSourceSyncStateSchema(legacyDb)).not.toThrow();
      const legacyStore = createFileSourceSyncStateStore(legacyDb);
      // The legacy row survived; the new column reads null (never baselined).
      expect(legacyStore.get(SID)).toMatchObject({ last_full_walk_at: null, degraded: false });
      // And a clean full cycle stamps it (the column is real + writable).
      legacyStore.markCompleted(SID, { ok: true, full_walk: true, now: T0 });
      expect(legacyStore.get(SID)?.last_full_walk_at).toBe(T0);
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────
// D-192 Fork B hardening — deriveFileSourceFreshness (the verdict)
// ────────────────────────────────────────────────────────────────

describe('deriveFileSourceFreshness', () => {
  const NOW = 1_700_000_000_000;
  const base = (over: Partial<ReturnType<typeof initialFileSourceSyncState>> = {}) => ({
    ...initialFileSourceSyncState('dropbox.c.file'),
    ...over,
  });

  it('null state → stale + never-synced', () => {
    expect(deriveFileSourceFreshness(null, NOW)).toEqual({
      last_success_at: null, degraded: false, stale: true,
    });
  });

  it('recent clean success → fresh', () => {
    expect(deriveFileSourceFreshness(base({ last_success_at: NOW }), NOW + 1000)).toEqual({
      last_success_at: NOW, degraded: false, stale: false,
    });
  });

  it('success older than stale_after_ms → stale', () => {
    const s = base({ last_success_at: NOW });
    expect(deriveFileSourceFreshness(s, NOW + FILE_SOURCE_STALE_AFTER_MS + 1).stale).toBe(true);
    // exactly at the boundary is still fresh (strict >).
    expect(deriveFileSourceFreshness(s, NOW + FILE_SOURCE_STALE_AFTER_MS).stale).toBe(false);
  });

  it('degraded → stale regardless of a recent last_success_at', () => {
    expect(deriveFileSourceFreshness(base({ last_success_at: NOW, degraded: true }), NOW + 1))
      .toMatchObject({ degraded: true, stale: true });
  });

  it('never-synced row (last_success_at null) → stale', () => {
    expect(deriveFileSourceFreshness(base({ last_success_at: null }), NOW).stale).toBe(true);
  });
});
