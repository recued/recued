/** Phase 7 (D-110) — instance-store smoke tests.
 *
 *  Covers the round-trip: schema creation, upsert timestamps, update
 *  narrow columns, list ordering, and round-tripping the JSON-encoded
 *  caps shape. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileCollectionCaps } from '@recued/contracts';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../collections/instance-store.js';

const sampleCaps = (overrides: Partial<FileCollectionCaps> = {}): FileCollectionCaps => ({
  read: 'yes',
  write: 'yes',
  delete: 'yes',
  watch: 'realtime',
  mirror: 'optional',
  auth: 'none',
  path_style: 'posix',
  ...overrides,
});

describe('collection_instances store (Phase 7 / D-110)', () => {
  let db: Database.Database;
  let store: CollectionInstanceStore;
  let clock: number;

  beforeEach(() => {
    db = new Database(':memory:');
    clock = 1_700_000_000_000;
    store = createInstanceStore({ db, now: () => clock });
  });

  afterEach(() => {
    db.close();
  });

  it('creates the schema idempotently', () => {
    // A second createInstanceStore on the same db must not throw.
    expect(() => createInstanceStore({ db })).not.toThrow();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='collection_instances'`,
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it('upsert + get round-trips caps, config, and timestamps', () => {
    const returned = store.upsert({
      platform: 'file',
      slug: 'myhomedir',
      adapter_type: 'fs',
      config: { path: '/Users/me/docs' },
      caps: sampleCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    expect(returned.created_at).toBe(clock);
    expect(returned.updated_at).toBe(clock);

    const row = store.get('file', 'myhomedir');
    expect(row).not.toBeNull();
    expect(row!.adapter_type).toBe('fs');
    expect(row!.config).toEqual({ path: '/Users/me/docs' });
    expect((row!.caps as FileCollectionCaps).write).toBe('yes');
    expect((row!.caps as FileCollectionCaps).path_style).toBe('posix');
  });

  it('preserves created_at on upsert-as-update', () => {
    store.upsert({
      platform: 'file',
      slug: 'myhomedir',
      adapter_type: 'fs',
      config: { path: '/a' },
      caps: sampleCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });

    clock += 5_000;
    const second = store.upsert({
      platform: 'file',
      slug: 'myhomedir',
      adapter_type: 'fs',
      config: { path: '/b' },
      caps: sampleCaps({ write: 'no' }),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    expect(second.created_at).toBe(1_700_000_000_000);
    expect(second.updated_at).toBe(1_700_000_005_000);

    const row = store.get('file', 'myhomedir');
    expect(row!.config).toEqual({ path: '/b' });
    expect((row!.caps as FileCollectionCaps).write).toBe('no');
  });

  it('list returns rows ordered by created_at ascending', () => {
    store.upsert({
      platform: 'file',
      slug: 'b',
      adapter_type: 'fs',
      config: {},
      caps: sampleCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    clock += 1_000;
    store.upsert({
      platform: 'file',
      slug: 'a',
      adapter_type: 's3',
      config: {},
      caps: sampleCaps({ auth: 'keys' }),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    clock += 1_000;
    store.upsert({
      platform: 'mail',
      slug: 'gmail-primary',
      adapter_type: 'gmail',
      config: {},
      caps: sampleCaps({ auth: 'oauth', path_style: 'uri' }),
      auth_state: 'healthy',
      last_synced_at: null,
    });

    const all = store.list();
    expect(all.map((r) => r.slug)).toEqual(['b', 'a', 'gmail-primary']);

    const file = store.list('file');
    expect(file.map((r) => r.slug)).toEqual(['b', 'a']);

    const mail = store.list('mail');
    expect(mail).toHaveLength(1);
    expect(mail[0].adapter_type).toBe('gmail');
  });

  it('updateAuthState flips one column without touching caps', () => {
    store.upsert({
      platform: 'file',
      slug: 'oauth-drive',
      adapter_type: 'fs',
      config: {},
      caps: sampleCaps({ auth: 'oauth' }),
      auth_state: 'healthy',
      last_synced_at: null,
    });

    clock += 10_000;
    const updated = store.updateAuthState('file', 'oauth-drive', {
      auth_state: 'expired',
      last_synced_at: clock,
    });
    expect(updated).not.toBeNull();
    expect(updated!.auth_state).toBe('expired');
    expect(updated!.last_synced_at).toBe(clock);
    expect((updated!.caps as FileCollectionCaps).auth).toBe('oauth'); // caps shape preserved

    const missing = store.updateAuthState('file', 'ghost', {
      auth_state: 'expired',
    });
    expect(missing).toBeNull();
  });

  it('updateCaps replaces caps_json only', () => {
    store.upsert({
      platform: 'file',
      slug: 'probe',
      adapter_type: 'fs',
      config: { path: '/tmp' },
      caps: sampleCaps({ write: 'no', delete: 'no' }),
      auth_state: 'healthy',
      last_synced_at: 42,
    });

    clock += 1;
    const updated = store.updateCaps('file', 'probe', sampleCaps());
    expect(updated).not.toBeNull();
    expect((updated!.caps as FileCollectionCaps).write).toBe('yes');
    expect((updated!.caps as FileCollectionCaps).delete).toBe('yes');
    expect(updated!.config).toEqual({ path: '/tmp' });
    expect(updated!.last_synced_at).toBe(42);
  });

  it('delete returns true when a row was removed, false otherwise', () => {
    store.upsert({
      platform: 'file',
      slug: 'doomed',
      adapter_type: 'fs',
      config: {},
      caps: sampleCaps(),
      auth_state: 'healthy',
      last_synced_at: null,
    });
    expect(store.delete('file', 'doomed')).toBe(true);
    expect(store.get('file', 'doomed')).toBeNull();
    expect(store.delete('file', 'doomed')).toBe(false);
  });

  it('auth_state falls back to healthy when DB contains an unknown value', () => {
    // Simulate a legacy row written by older code / a user editing the DB.
    db.prepare(
      `INSERT INTO collection_instances
         (platform, slug, adapter_type, config_json, caps_json,
          auth_state, last_synced_at, created_at, updated_at)
       VALUES ('file', 'legacy', 'fs', '{}', ?, 'weird', NULL, 1, 1)`,
    ).run(JSON.stringify(sampleCaps()));

    const row = store.get('file', 'legacy');
    expect(row).not.toBeNull();
    expect(row!.auth_state).toBe('healthy');
  });
});
