/** Poll-manager / G6 — persisted watch state + snapshot store suite. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWatchStore, type WatchStore } from '../watch/snapshot-store.js';

const KEY = 'hubspot/deal/main-crm';

const ensure = (store: WatchStore, watch_key = KEY) =>
  store.ensureState({
    watch_key,
    source_id: 'connection-api',
    connection_name: 'main-crm',
    vendor: 'hubspot',
    entity: 'deal',
    now: 1_000,
  });

describe('watch store — state rows', () => {
  let db: Database.Database;
  let store: WatchStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createWatchStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('ensureState inserts enabled defaults and is idempotent (existing rows untouched)', () => {
    const fresh = ensure(store);
    expect(fresh).toMatchObject({
      watch_key: KEY,
      connection_name: 'main-crm',
      vendor: 'hubspot',
      entity: 'deal',
      enabled: true,
      baselined: false,
      last_poll_at: null,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
    });

    store.setEnabled(KEY, false, 2_000);
    const again = ensure(store);
    expect(again.enabled).toBe(false); // user toggle survives re-ensure
  });

  it('setEnabled(true) clears the failure counter + last_error; disable() does NOT (the UI shows why it tripped)', () => {
    ensure(store);
    store.recordPollError(KEY, { at: 2_000, error: 'boom' });
    store.recordPollError(KEY, { at: 3_000, error: 'boom 2' });
    store.disable(KEY, 3_000);

    const tripped = store.getState(KEY)!;
    expect(tripped.enabled).toBe(false);
    expect(tripped.consecutive_failures).toBe(2);
    expect(tripped.last_error).toBe('boom 2');

    const rearmed = store.setEnabled(KEY, true, 4_000)!;
    expect(rearmed.enabled).toBe(true);
    expect(rearmed.consecutive_failures).toBe(0);
    expect(rearmed.last_error).toBeNull();
  });

  it('setEnabled on an unknown key returns null', () => {
    expect(store.setEnabled('nope', true, 1)).toBeNull();
  });

  it('recordPollSuccess latches baselined and resets the error streak; recordPollError counts up', () => {
    ensure(store);
    expect(store.recordPollError(KEY, { at: 2_000, error: 'e1' })).toBe(1);
    expect(store.recordPollError(KEY, { at: 3_000, error: 'e2' })).toBe(2);

    store.recordPollSuccess(KEY, { at: 4_000, baselined: true });
    const ok = store.getState(KEY)!;
    expect(ok).toMatchObject({
      baselined: true,
      last_poll_at: 4_000,
      last_status: 'ok',
      last_error: null,
      consecutive_failures: 0,
    });

    // baselined latches — a later success can't un-baseline.
    store.recordPollSuccess(KEY, { at: 5_000, baselined: true });
    expect(store.getState(KEY)!.baselined).toBe(true);
  });
});

describe('watch store — snapshots', () => {
  let db: Database.Database;
  let store: WatchStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createWatchStore(db);
    ensure(store);
  });

  afterEach(() => {
    db.close();
  });

  it('commitSnapshot upserts + deletes transactionally; loadSnapshot round-trips', () => {
    store.commitSnapshot(KEY, {
      upserts: [
        { record_id: 'd1', record_hash: 'h1', record: { id: 'd1', stage: 'open' } },
        { record_id: 'd2', record_hash: 'h2', record: { id: 'd2', stage: 'open' } },
      ],
      deletes: [],
    });
    expect(store.snapshotCount(KEY)).toBe(2);

    store.commitSnapshot(KEY, {
      upserts: [{ record_id: 'd1', record_hash: 'h1b', record: { id: 'd1', stage: 'won' } }],
      deletes: ['d2'],
    });
    const snapshot = store.loadSnapshot(KEY);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get('d1')).toEqual({ hash: 'h1b', record: { id: 'd1', stage: 'won' } });
  });

  it('loadSnapshot drops a corrupt row instead of throwing', () => {
    store.commitSnapshot(KEY, {
      upserts: [{ record_id: 'd1', record_hash: 'h1', record: { id: 'd1' } }],
      deletes: [],
    });
    db.prepare(
      'UPDATE watch_snapshots SET record_json = ? WHERE watch_key = ? AND record_id = ?',
    ).run('{not json', KEY, 'd1');
    expect(store.loadSnapshot(KEY).size).toBe(0);
  });

  it('prune removes state + snapshots for keys outside the keep set (and strands no orphans)', () => {
    const other = 'salesforce/opportunity/sf';
    ensure(store, other);
    store.commitSnapshot(KEY, {
      upserts: [{ record_id: 'd1', record_hash: 'h', record: {} }],
      deletes: [],
    });
    store.commitSnapshot(other, {
      upserts: [{ record_id: 'o1', record_hash: 'h', record: {} }],
      deletes: [],
    });

    store.prune(new Set([KEY]));
    expect(store.getState(KEY)).not.toBeNull();
    expect(store.snapshotCount(KEY)).toBe(1);
    expect(store.getState(other)).toBeNull();
    expect(store.snapshotCount(other)).toBe(0);
  });

  it('state + snapshots persist across a store re-open over the same db (restart posture)', () => {
    store.recordPollSuccess(KEY, { at: 9_000, baselined: true });
    store.commitSnapshot(KEY, {
      upserts: [{ record_id: 'd1', record_hash: 'h1', record: { id: 'd1' } }],
      deletes: [],
    });

    const reopened = createWatchStore(db);
    expect(reopened.getState(KEY)!.baselined).toBe(true);
    expect(reopened.loadSnapshot(KEY).get('d1')).toEqual({ hash: 'h1', record: { id: 'd1' } });
  });
});
