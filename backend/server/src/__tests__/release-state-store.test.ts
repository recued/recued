import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createReleaseStateStore } from '../update/release-state-store.js';

describe('createReleaseStateStore', () => {
  it('mints + persists a stable salt on first load', () => {
    const db = new Database(':memory:');
    const store = createReleaseStateStore(db);
    const a = store.load();
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.highest_accepted_sequence).toBe(0);
    // same salt across a fresh store over the same db (persisted)
    const b = createReleaseStateStore(db).load();
    expect(b.salt).toBe(a.salt);
  });

  it('round-trips the anti-replay floor', () => {
    const db = new Database(':memory:');
    const store = createReleaseStateStore(db);
    const s = store.load();
    store.save({ ...s, highest_accepted_sequence: 184 });
    expect(createReleaseStateStore(db).load().highest_accepted_sequence).toBe(184);
  });

  it('creates server_state idempotently (no throw if already present)', () => {
    const db = new Database(':memory:');
    createReleaseStateStore(db);
    expect(() => createReleaseStateStore(db)).not.toThrow();
  });
});
