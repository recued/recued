/** D-205 item #1 — `contact_source_sync_state`, the row that finally listens.
 *
 *  Real SQLite, no mocks. The store's whole reason to exist is that a contact cycle's
 *  outcome used to be returned to a caller that discarded it, so the failure modes
 *  worth testing are all about an outcome going missing: a row that isn't there, a
 *  count that gets blanked, a blob that won't parse.
 *
 *  Spec: D-205 §9.1. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_SOURCE_SYNC_STATE_TABLE,
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  initialContactSourceSyncState,
  type ContactSourceCycleCounts,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';

let dir: string;
let db: Database.Database;
let store: ContactSourceSyncStateStore;

const SID = 'hubspot.work.contact';

const counts = (over: Partial<ContactSourceCycleCounts> = {}): ContactSourceCycleCounts => ({
  hydrated: 0,
  unchanged: 0,
  skipped: 0, created: 0, promoted: 0,
  disconnected: 0,
  failed_rows: 0,
  unkeyable: 0,
  ambiguous: 0,
  conflicted: 0,
  repointed: 0,
  mirror_failed: 0,
  linked: 0,
  complete: true,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contact-sync-state-'));
  db = new Database(join(dir, 'test.db'));
  ensureContactSourceSyncStateSchema(db);
  store = createContactSourceSyncStateStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-205 item #1 — the cycle record', () => {
  it('a CLEAN cycle bumps success, clears the flags, and keeps the counts', () => {
    store.upsert(initialContactSourceSyncState(SID));
    store.markStarted(SID, 1_000);

    store.markCompleted(SID, { now: 2_000, error: null, counts: counts({ hydrated: 7 }) });

    const s = store.get(SID)!;
    expect(s.last_sync_started_at).toBe(1_000);
    expect(s.last_sync_completed_at).toBe(2_000);
    expect(s.last_success_at).toBe(2_000);
    expect(s.degraded).toBe(false);
    expect(s.last_error_code).toBeNull();
    expect(s.last_cycle?.hydrated).toBe(7);
  });

  it('a DEGRADED cycle records the error and KEEPS its counts — they are the diagnosis', () => {
    // The divergence from the file store, which passes a degraded cycle as `ok: false`
    // and loses its counts entirely. A contact cycle's failures are COUNTED rather than
    // thrown (one bad payload must not abort a walk over 10k records), so the counts are
    // the only evidence there is.
    store.upsert(initialContactSourceSyncState(SID));

    store.markCompleted(SID, {
      now: 2_000,
      error: { code: 'records_failed', message: '12 record(s) failed — hs_1: no address' },
      counts: counts({ failed_rows: 12, hydrated: 0 }),
    });

    const s = store.get(SID)!;
    expect(s.degraded).toBe(true);
    expect(s.last_error_code).toBe('records_failed');
    expect(s.last_error_message).toMatch(/hs_1: no address/);
    expect(s.last_cycle?.failed_rows).toBe(12);
    // A degraded cycle does NOT bump success — the Source reads stale however recently
    // it ran, which is the entire point.
    expect(s.last_success_at).toBeNull();
    expect(s.last_sync_completed_at).toBe(2_000);
  });

  it('a REFUSED cycle (no counts) does not BLANK the last cycle that actually walked', () => {
    // A credential expires and the leaf starts refusing every cycle. The last real
    // cycle's counts are the most recent thing anyone knows about this Source; blanking
    // them on each refusal would destroy the diagnosis exactly when it is wanted.
    store.upsert(initialContactSourceSyncState(SID));
    store.markCompleted(SID, { now: 1_000, error: null, counts: counts({ hydrated: 40 }) });

    store.markCompleted(SID, {
      now: 2_000,
      error: { code: 'config', message: 'no credential' },
    });

    const s = store.get(SID)!;
    expect(s.degraded).toBe(true);
    expect(s.last_error_code).toBe('config');
    expect(s.last_cycle?.hydrated).toBe(40); // still there
  });

  it('RECOVERS — a clean cycle clears a prior error', () => {
    store.upsert(initialContactSourceSyncState(SID));
    store.markCompleted(SID, {
      now: 1_000,
      error: { code: 'records_failed', message: 'boom' },
      counts: counts({ failed_rows: 3 }),
    });

    store.markCompleted(SID, { now: 2_000, error: null, counts: counts({ hydrated: 3 }) });

    const s = store.get(SID)!;
    expect(s.degraded).toBe(false);
    expect(s.last_error_code).toBeNull();
    expect(s.last_error_message).toBeNull();
    expect(s.last_success_at).toBe(2_000);
  });
});

describe('D-205 item #1 — an outcome must never go missing', () => {
  it('records a cycle even when the row was never seeded — an UPDATE would have vanished', () => {
    // 🔑 The store's own failure mode, closed. The wire seeds the row at task
    // registration, so in production it is always there — but the file store's bare
    // `UPDATE ... WHERE source_id = ?` against a MISSING row affects zero rows and
    // reports success. A store whose entire purpose is to stop a failed cycle vanishing
    // silently must not have, as its own failure mode, a cycle outcome vanishing
    // silently. So a missing row is CREATED.
    expect(store.get(SID)).toBeNull(); // never seeded

    store.markStarted(SID, 1_000);
    store.markCompleted(SID, {
      now: 2_000,
      error: { code: 'records_failed', message: 'every record failed' },
      counts: counts({ failed_rows: 500 }),
    });

    const s = store.get(SID)!;
    expect(s.degraded).toBe(true);
    expect(s.last_cycle?.failed_rows).toBe(500);
    expect(s.stale_after_ms).toBeGreaterThan(0); // NOT NULL — the column is required
  });

  it('a CORRUPT last_cycle blob degrades to null rather than throwing', () => {
    // A row that cannot be READ is one more silent failure, and a throw here would take
    // the whole freshness cycle down with it.
    store.upsert(initialContactSourceSyncState(SID));
    db.prepare(`UPDATE ${CONTACT_SOURCE_SYNC_STATE_TABLE} SET last_cycle = ? WHERE source_id = ?`)
      .run('{not json', SID);

    const s = store.get(SID);

    expect(s).not.toBeNull();
    expect(s?.last_cycle).toBeNull();
  });

  it('round-trips every counter, including the boolean', () => {
    // `complete` is the one non-numeric count, so it is the one JSON could quietly lose.
    store.upsert(initialContactSourceSyncState(SID));
    const c = counts({
      hydrated: 1, unchanged: 2, skipped: 3, created: 0, promoted: 0, disconnected: 4, failed_rows: 5,
      unkeyable: 6, ambiguous: 7, conflicted: 8, repointed: 9, mirror_failed: 10,
      linked: 11, complete: false,
    });

    store.markCompleted(SID, { now: 1_000, error: null, counts: c });

    expect(store.get(SID)?.last_cycle).toEqual(c);
  });
});

describe('D-205 item #1 — lifecycle', () => {
  it('a fresh Source starts honestly never-synced, not clean', () => {
    store.upsert(initialContactSourceSyncState(SID));
    const s = store.get(SID)!;
    expect(s.last_success_at).toBeNull();
    expect(s.degraded).toBe(false);
    expect(s.last_cycle).toBeNull();
  });

  it('deleteForSource drops the row — runtime state dies with the task', () => {
    store.upsert(initialContactSourceSyncState(SID));
    expect(store.deleteForSource(SID)).toBe(true);
    expect(store.get(SID)).toBeNull();
    expect(store.deleteForSource(SID)).toBe(false);
  });

  it('is scoped per Source INSTANCE — two connections to one vendor are two Sources', () => {
    // The same key the blobs and the contributions use. Two HubSpot portals must not
    // share one health row, or a broken sandbox would mark prod degraded.
    const other = 'hubspot.personal.contact';
    store.upsert(initialContactSourceSyncState(SID));
    store.upsert(initialContactSourceSyncState(other));

    store.markCompleted(SID, {
      now: 1_000,
      error: { code: 'records_failed', message: 'boom' },
      counts: counts({ failed_rows: 9 }),
    });

    expect(store.get(SID)?.degraded).toBe(true);
    expect(store.get(other)?.degraded).toBe(false);
  });
});
