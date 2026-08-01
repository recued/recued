/** D-125 Phase 1.2 — connection-store SQLite tests (server).
 *
 *  Mirrors the IDB-store test in `packages/storage/src/__tests__/
 *  connection-store.test.ts`. Both backends produce identical
 *  `ConnectionRow` shapes; the projection helper
 *  `connectionViewFromRow` (contracts) consumes both equivalently.
 *
 *  Covers:
 *    - ensureConnectionSchema is idempotent + creates table + 2 indexes
 *    - upsert / get / list / listSince / delete / count round-trips
 *    - composite PK (kind, name): same name across kinds coexists
 *    - upsert ON CONFLICT replaces in place
 *    - kind CHECK constraint rejects bogus values (defense in depth)
 *    - rowToConnectionRow projection (subtype/publisher_id/last_used_at/
 *      health_json round-trip null↔undefined)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createConnectionStore,
  ensureConnectionSchema,
  type ConnectionStoreSqlite,
  type ConnectionUpsert,
} from '../storage/connection-store.js';

let dir: string;
let db: Database.Database;
let store: ConnectionStoreSqlite;

const mkUpsert = (overrides: Partial<ConnectionUpsert> = {}): ConnectionUpsert => ({
  kind: 'api',
  name: 'hubspot',
  display_name: 'HubSpot Production',
  config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
  auth_ciphertext: 'AEAD-CIPHERTEXT-BASE64',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createConnectionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureConnectionSchema', () => {
  it('creates the connections table + 2 indexes idempotently', () => {
    ensureConnectionSchema(db);
    ensureConnectionSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`)
      .all();
    expect(tables.length).toBe(1);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='connections'`)
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);
    expect(names).toContain('idx_connections_updated_at');
    expect(names).toContain('idx_connections_kind');
    const recoveryTable = db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name='connection_credential_rotation_attempts'`,
    ).get();
    expect(recoveryTable).toBeDefined();
  });

  it('enforces composite PRIMARY KEY (kind, name)', () => {
    const pk = db
      .prepare(
        `SELECT name FROM pragma_index_list('connections')
         WHERE origin = 'pk'`,
      )
      .all() as Array<{ name: string }>;
    expect(pk.length).toBe(1);
  });

  it('rejects rows with an out-of-range kind via CHECK constraint', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO connections
            (name, kind, display_name, config_json, auth_json,
             enrolled_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('foo', 'webhook', 'Foo', '{}', 'cipher', 1, 1),
    ).toThrow();
  });

  it('adds granted_scopes_json to a legacy table via the additive migration', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'connection-store-legacy-'));
    const legacyDb = new Database(join(legacyDir, 'legacy.db'));
    try {
      // A table created before the column existed (every column EXCEPT
      // granted_scopes_json) + a pre-existing row.
      legacyDb.exec(`
        CREATE TABLE connections (
          name TEXT NOT NULL, kind TEXT NOT NULL, subtype TEXT,
          display_name TEXT NOT NULL, publisher_id TEXT,
          config_json TEXT NOT NULL, auth_json TEXT NOT NULL,
          enrolled_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          last_used_at INTEGER, health_json TEXT, subresource_path TEXT,
          PRIMARY KEY (kind, name)
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO connections (name, kind, display_name, config_json, auth_json, enrolled_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('old', 'api', 'Old', '{}', 'cipher', 1, 1);

      const colsOf = (): string[] =>
        (legacyDb.prepare(`PRAGMA table_info(connections)`).all() as Array<{ name: string }>)
          .map((c) => c.name);
      expect(colsOf()).not.toContain('granted_scopes_json');
      ensureConnectionSchema(legacyDb);
      expect(colsOf()).toContain('granted_scopes_json');

      // The legacy row reads back with the field absent (undefined, not null);
      // a fresh write through the store persists it.
      const legacyStore = createConnectionStore(legacyDb);
      expect(legacyStore.get('api', 'old')?.granted_scopes_json).toBeUndefined();
      legacyStore.upsert(mkUpsert({ name: 'fresh', granted_scopes_json: JSON.stringify(['s']) }));
      expect(legacyStore.get('api', 'fresh')?.granted_scopes_json).toBe(JSON.stringify(['s']));
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('adds bounded rejection triage to a legacy rotation-receipt table', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'connection-rotation-triage-'));
    const legacyDb = new Database(join(legacyDir, 'legacy.db'));
    try {
      legacyDb.exec(`
        CREATE TABLE connection_credential_rotation_attempts (
          attempt_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          verified_at INTEGER,
          auth_type TEXT,
          access_expires_at INTEGER,
          failure_reason TEXT
        )
      `);

      ensureConnectionSchema(legacyDb);

      const columns = legacyDb
        .prepare(`PRAGMA table_info(connection_credential_rotation_attempts)`)
        .all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toContain(
        'auth_rejection_triage_stage',
      );
      expect(columns.map(({ name }) => name)).toContain(
        'auth_rejection_resolution',
      );
      expect(columns.map(({ name }) => name)).toContain(
        'safe_stop_acknowledged_at',
      );
      expect(() => legacyDb.prepare(`
        INSERT INTO connection_credential_rotation_attempts
          (attempt_id, kind, name, status, started_at,
           auth_rejection_triage_stage)
        VALUES ('rotation-invalid-triage-0001', 'api', 'hubspot', 'pending', 1,
                'raw_provider_error')
      `).run()).toThrow();
      expect(() => legacyDb.prepare(`
        INSERT INTO connection_credential_rotation_attempts
          (attempt_id, kind, name, status, started_at,
           auth_rejection_resolution)
        VALUES ('rotation-invalid-resolution-01', 'api', 'hubspot', 'pending', 2,
                'retry_the_same_secret')
      `).run()).toThrow();
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe('credential rotation recovery receipts', () => {
  const attemptId = 'rotation-storage-test-0001';

  it('claims once and atomically commits the replacement with a secret-free receipt', () => {
    store.upsert(mkUpsert());
    const observed = vi.fn();
    store.addOnUpsert(observed);
    observed.mockClear();

    const first = store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });
    const duplicate = store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_009_000,
    });
    expect(first).toMatchObject({ claimed: true, attempt: { status: 'pending' } });
    expect(duplicate).toMatchObject({
      claimed: false,
      attempt: { status: 'pending', started_at: 1_700_000_001_000 },
    });

    const row = store.completeCredentialRotationAttempt!({
      attempt_id: attemptId,
      connection: mkUpsert({
        display_name: 'Rotated HubSpot',
        auth_ciphertext: 'NEW-AEAD-CIPHERTEXT',
        updated_at: 1_700_000_002_000,
      }),
      verification: {
        status: 'verified',
        verified_at: 1_700_000_002_000,
        auth_type: 'bearer',
      },
    });

    expect(row.display_name).toBe('Rotated HubSpot');
    expect(row.auth_ciphertext).toBe('NEW-AEAD-CIPHERTEXT');
    expect(observed).toHaveBeenCalledTimes(1);
    const receipt = store.getCredentialRotationAttempt!(attemptId);
    expect(receipt).toEqual({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      status: 'succeeded',
      started_at: 1_700_000_001_000,
      verification: {
        status: 'verified',
        verified_at: 1_700_000_002_000,
        auth_type: 'bearer',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('NEW-AEAD-CIPHERTEXT');
  });

  it('elects one pending attempt per connection while allowing other connections', () => {
    const first = store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });
    const contender = store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-storage-test-0002',
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_002_000,
    });
    const independent = store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-storage-test-0003',
      kind: 'api',
      name: 'salesforce',
      started_at: 1_700_000_003_000,
    });

    expect(first.claimed).toBe(true);
    expect(contender).toEqual({ claimed: false, attempt: first.attempt });
    expect(independent).toMatchObject({
      claimed: true,
      attempt: { name: 'salesforce', status: 'pending' },
    });
    expect(store.getPendingCredentialRotationAttempt!('api', 'hubspot'))
      .toEqual(first.attempt);

    store.failCredentialRotationAttempt!({
      attempt_id: attemptId,
      finished_at: 1_700_000_004_000,
      reason: 'auth_failed',
    });
    expect(store.getPendingCredentialRotationAttempt!('api', 'hubspot'))
      .toBeNull();
    expect(store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-storage-test-0002',
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_005_000,
    })).toMatchObject({ claimed: true, attempt: { status: 'pending' } });
  });

  it('rolls back the connection write when the pending receipt identity does not match', () => {
    const before = store.upsert(mkUpsert());
    store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });

    expect(() => store.completeCredentialRotationAttempt!({
      attempt_id: attemptId,
      connection: mkUpsert({ name: 'other', auth_ciphertext: 'MUST-NOT-LAND' }),
      verification: {
        status: 'verified',
        verified_at: 1_700_000_002_000,
        auth_type: 'bearer',
      },
    })).toThrow(/no longer pending/);

    expect(store.get('api', 'hubspot')).toEqual(before);
    expect(store.get('api', 'other')).toBeNull();
    expect(store.getCredentialRotationAttempt!(attemptId)).toMatchObject({
      status: 'pending',
    });
  });

  it('closes a failed attempt with only a bounded reason and safe auth discriminator', () => {
    store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });
    expect(store.failCredentialRotationAttempt!({
      attempt_id: attemptId,
      finished_at: 1_700_000_002_000,
      reason: 'auth_failed',
      auth_type: 'oauth2_refresh',
    })).toEqual({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      status: 'failed',
      started_at: 1_700_000_001_000,
      finished_at: 1_700_000_002_000,
      failure_reason: 'auth_failed',
      auth_type: 'oauth2_refresh',
    });
  });

  it('escalates a third consecutive auth rejection to a bounded safe stop', () => {
    const fail = (
      attempt_id: string,
      reason: 'auth_failed' | 'unreachable',
      started_at: number,
    ) => {
      store.claimCredentialRotationAttempt!({
        attempt_id,
        kind: 'api',
        name: 'hubspot',
        started_at,
      });
      return store.failCredentialRotationAttempt!({
        attempt_id,
        finished_at: started_at + 1,
        reason,
        ...(reason === 'auth_failed'
          ? {
              auth_type: 'bearer' as const,
              auth_rejection_stage: 'provider_probe' as const,
            }
          : {}),
      });
    };

    // Deliberately move the injected wall clock backwards. Receipt insertion
    // order is the causal attempt order; timestamps must not resurrect an old
    // rejection after a newer terminal result resets the streak.
    const first = fail('rotation-rejection-streak-0001', 'auth_failed', 40);
    expect(first).not.toHaveProperty('auth_rejection_triage_stage');
    expect(first).not.toHaveProperty('auth_rejection_resolution');

    const second = fail('rotation-rejection-streak-0002', 'auth_failed', 30);
    expect(second).toMatchObject({
      failure_reason: 'auth_failed',
      auth_type: 'bearer',
      auth_rejection_triage_stage: 'provider_probe',
    });
    expect(second).not.toHaveProperty('auth_rejection_resolution');

    const third = fail(
      'rotation-rejection-streak-0003',
      'auth_failed',
      20,
    );
    expect(third).toMatchObject({
      failure_reason: 'auth_failed',
      auth_type: 'bearer',
      auth_rejection_triage_stage: 'provider_probe',
      auth_rejection_resolution: 'regenerate_credential_or_contact_admin',
    });
    expect(store.getLatestCredentialRotationAttempt?.('api', 'hubspot'))
      .toEqual(third);

    fail('rotation-rejection-streak-0004', 'unreachable', 15);
    const afterReset = fail(
      'rotation-rejection-streak-0005',
      'auth_failed',
      10,
    );
    expect(afterReset).not.toHaveProperty('auth_rejection_triage_stage');
    expect(afterReset).not.toHaveProperty('auth_rejection_resolution');
    expect(store.getLatestCredentialRotationAttempt?.('api', 'hubspot'))
      .toEqual(afterReset);
  });

  it('lists and idempotently acknowledges only the exact latest safe stop', () => {
    store.upsert(mkUpsert());
    const reject = (attempt_id: string, started_at: number) => {
      store.claimCredentialRotationAttempt!({
        attempt_id,
        kind: 'api',
        name: 'hubspot',
        started_at,
      });
      return store.failCredentialRotationAttempt!({
        attempt_id,
        finished_at: started_at + 1,
        reason: 'auth_failed',
        auth_type: 'bearer',
        auth_rejection_stage: 'provider_probe',
      });
    };
    reject('rotation-safe-stop-list-0001', 10);
    reject('rotation-safe-stop-list-0002', 20);
    const safeStop = reject('rotation-safe-stop-list-0003', 30);

    expect(store.listCredentialRotationSafeStops!()).toEqual([safeStop]);
    expect(store.listCredentialRotationSafeStops!({ kind: 'mcp' })).toEqual([]);

    const acknowledged = store.acknowledgeCredentialRotationSafeStop!({
      attempt_id: safeStop.attempt_id,
      kind: 'api',
      name: 'hubspot',
      acknowledged_at: 40,
    });
    expect(acknowledged).toMatchObject({
      status: 'acknowledged',
      attempt: { safe_stop_acknowledged_at: 40 },
    });
    expect(store.listCredentialRotationSafeStops!()).toEqual([]);
    expect(store.listAcknowledgedCredentialRotationSafeStops!()).toEqual([
      acknowledged!.attempt,
    ]);
    expect(store.acknowledgeCredentialRotationSafeStop!({
      attempt_id: safeStop.attempt_id,
      kind: 'api',
      name: 'hubspot',
      acknowledged_at: 99,
    })).toMatchObject({
      status: 'already_acknowledged',
      attempt: { safe_stop_acknowledged_at: 40 },
    });

    // A newer causal row makes the old capability stale even if the old row
    // was not acknowledged by this caller.
    store.claimCredentialRotationAttempt!({
      attempt_id: 'rotation-safe-stop-list-0004',
      kind: 'api',
      name: 'hubspot',
      started_at: 50,
    });
    expect(store.listAcknowledgedCredentialRotationSafeStops!()).toEqual([]);
    expect(store.acknowledgeCredentialRotationSafeStop!({
      attempt_id: safeStop.attempt_id,
      kind: 'api',
      name: 'hubspot',
      acknowledged_at: 60,
    })).toBeNull();
  });

  it('closes a prior-process pending claim when the store boots again', () => {
    store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });

    const rebooted = createConnectionStore(db);
    expect(rebooted.getCredentialRotationAttempt!(attemptId)).toMatchObject({
      status: 'failed',
      failure_reason: 'server_error',
      started_at: 1_700_000_001_000,
    });
  });

  it('closes legacy duplicate pending rows before installing the owner index', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'rotation-owner-migration-'));
    const legacyDb = new Database(join(legacyDir, 'legacy.db'));
    try {
      ensureConnectionSchema(legacyDb);
      const insert = legacyDb.prepare(`
        INSERT INTO connection_credential_rotation_attempts
          (attempt_id, kind, name, status, started_at)
        VALUES (?, 'api', 'hubspot', 'pending', ?)
      `);
      insert.run('rotation-legacy-owner-0001', 1_700_000_001_000);
      insert.run('rotation-legacy-owner-0002', 1_700_000_002_000);

      const migrated = createConnectionStore(legacyDb);
      expect(migrated.getCredentialRotationAttempt!(
        'rotation-legacy-owner-0001',
      )).toMatchObject({ status: 'failed', failure_reason: 'server_error' });
      expect(migrated.getCredentialRotationAttempt!(
        'rotation-legacy-owner-0002',
      )).toMatchObject({ status: 'failed', failure_reason: 'server_error' });
      expect(legacyDb.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name = 'idx_connection_credential_rotation_pending_owner'
      `).get()).toEqual({
        name: 'idx_connection_credential_rotation_pending_owner',
      });
    } finally {
      legacyDb.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('deletes old receipts with the connection so a same-name re-enrollment is distinct', () => {
    store.upsert(mkUpsert());
    store.claimCredentialRotationAttempt!({
      attempt_id: attemptId,
      kind: 'api',
      name: 'hubspot',
      started_at: 1_700_000_001_000,
    });

    expect(store.delete('api', 'hubspot')).toBe(true);
    expect(store.getCredentialRotationAttempt!(attemptId)).toBeNull();
    expect(() => store.completeCredentialRotationAttempt!({
      attempt_id: attemptId,
      connection: mkUpsert({ auth_ciphertext: 'MUST-NOT-RESURRECT' }),
      verification: {
        status: 'verified',
        verified_at: 1_700_000_002_000,
        auth_type: 'bearer',
      },
    })).toThrow(/no longer pending/);
    expect(store.get('api', 'hubspot')).toBeNull();
  });
});

describe('createConnectionStore — CRUD round-trips', () => {
  it('get returns null for an unknown (kind, name)', () => {
    expect(store.get('api', 'salesforcedev')).toBeNull();
  });

  it('upsert → get round-trips the row by composite key', () => {
    store.upsert(mkUpsert());
    const fetched = store.get('api', 'hubspot');
    expect(fetched).toMatchObject({
      pk: 'api:hubspot',
      kind: 'api',
      name: 'hubspot',
      display_name: 'HubSpot Production',
      auth_ciphertext: 'AEAD-CIPHERTEXT-BASE64',
    });
  });

  it('upsert ON CONFLICT (kind, name) replaces in place', () => {
    store.upsert(mkUpsert({ display_name: 'HubSpot Production' }));
    store.upsert(mkUpsert({
      display_name: 'HubSpot Sandbox',
      updated_at: 1_700_000_010_000,
    }));
    const fetched = store.get('api', 'hubspot');
    expect(fetched?.display_name).toBe('HubSpot Sandbox');
    expect(fetched?.updated_at).toBe(1_700_000_010_000);
    expect(store.count()).toBe(1);
  });

  it('round-trips optional fields (subtype / publisher_id / last_used_at / health_json)', () => {
    store.upsert(mkUpsert({
      kind: 'mcp',
      name: 'gh-mcp',
      subtype: 'sse',
      publisher_id: 'recued-core',
      last_used_at: 1_700_000_005_000,
      health_json: JSON.stringify({ status: 'ok', last_probed_at: 1_700_000_004_000 }),
    }));
    const fetched = store.get('mcp', 'gh-mcp');
    expect(fetched?.subtype).toBe('sse');
    expect(fetched?.publisher_id).toBe('recued-core');
    expect(fetched?.last_used_at).toBe(1_700_000_005_000);
    expect(fetched?.health_json).toContain('"status":"ok"');
  });

  it('round-trips granted_scopes_json (JSON-array TEXT column)', () => {
    store.upsert(mkUpsert({
      granted_scopes_json: JSON.stringify(['crm.objects.deals.read', 'oauth']),
    }));
    expect(store.get('api', 'hubspot')?.granted_scopes_json).toBe(
      JSON.stringify(['crm.objects.deals.read', 'oauth']),
    );
  });

  it('omits absent optional fields rather than surfacing nulls', () => {
    // `ConnectionRow` declares optional fields as `?: T` (not `T | null`)
    // — the projection layer must drop missing values, not surface
    // SQLite's `null` discriminant. Recipes never see `subtype: null`.
    store.upsert(mkUpsert());
    const fetched = store.get('api', 'hubspot');
    expect(Object.prototype.hasOwnProperty.call(fetched, 'subtype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fetched, 'publisher_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fetched, 'last_used_at')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fetched, 'health_json')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(fetched, 'granted_scopes_json')).toBe(false);
  });

  it('delete returns true / false based on row presence', () => {
    store.upsert(mkUpsert());
    expect(store.delete('api', 'hubspot')).toBe(true);
    expect(store.delete('api', 'hubspot')).toBe(false);
  });

  it('commits critical pre-delete mutations with the connection removal', () => {
    store.upsert(mkUpsert());
    db.exec('CREATE TABLE deletion_proof (closed INTEGER NOT NULL)');
    db.prepare('INSERT INTO deletion_proof (closed) VALUES (0)').run();
    store.addBeforeDelete(() => {
      db.prepare('UPDATE deletion_proof SET closed = 1').run();
      return undefined;
    });

    expect(store.delete('api', 'hubspot')).toBe(true);
    expect(store.get('api', 'hubspot')).toBeNull();
    expect(db.prepare('SELECT closed FROM deletion_proof').pluck().get()).toBe(1);
  });

  it('rolls back critical pre-delete mutations and preserves the connection on failure', () => {
    store.upsert(mkUpsert());
    db.exec('CREATE TABLE deletion_proof (closed INTEGER NOT NULL)');
    db.prepare('INSERT INTO deletion_proof (closed) VALUES (0)').run();
    let postDeleteCalls = 0;
    store.addBeforeDelete(() => {
      db.prepare('UPDATE deletion_proof SET closed = 1').run();
      throw new Error('fail-close persistence failed');
    });
    store.addOnDelete(() => { postDeleteCalls += 1; });

    expect(() => store.delete('api', 'hubspot'))
      .toThrow('fail-close persistence failed');
    expect(store.get('api', 'hubspot')).not.toBeNull();
    expect(db.prepare('SELECT closed FROM deletion_proof').pluck().get()).toBe(0);
    expect(postDeleteCalls).toBe(0);
  });

  it('rejects asynchronous critical hooks and preserves the connection', () => {
    store.upsert(mkUpsert());
    store.addBeforeDelete((() => Promise.resolve()) as unknown as () => undefined);

    expect(() => store.delete('api', 'hubspot'))
      .toThrow('critical before-delete handlers must be synchronous');
    expect(store.get('api', 'hubspot')).not.toBeNull();
  });

  it('rolls back hook mutations when a hook removes the target row', () => {
    store.upsert(mkUpsert());
    db.exec('CREATE TABLE deletion_proof (closed INTEGER NOT NULL)');
    db.prepare('INSERT INTO deletion_proof (closed) VALUES (0)').run();
    let postDeleteCalls = 0;
    store.addBeforeDelete(() => {
      db.prepare('UPDATE deletion_proof SET closed = 1').run();
      db.prepare('DELETE FROM connections WHERE kind = ? AND name = ?')
        .run('api', 'hubspot');
      return undefined;
    });
    store.addOnDelete(() => { postDeleteCalls += 1; });

    expect(() => store.delete('api', 'hubspot'))
      .toThrow('connection changed during critical deletion');
    expect(store.get('api', 'hubspot')).not.toBeNull();
    expect(db.prepare('SELECT closed FROM deletion_proof').pluck().get()).toBe(0);
    expect(postDeleteCalls).toBe(0);
  });

  it('count tracks the live total', () => {
    expect(store.count()).toBe(0);
    store.upsert(mkUpsert());
    store.upsert(mkUpsert({ name: 'hubspot2' }));
    expect(store.count()).toBe(2);
  });
});

describe('createConnectionStore — composite key independence', () => {
  it('same name across different kinds coexists', () => {
    store.upsert(mkUpsert({ kind: 'api', name: 'hubspot' }));
    store.upsert(mkUpsert({
      kind: 'notification',
      name: 'hubspot',
      subtype: 'slack',
      display_name: 'HubSpot Slack',
    }));
    expect(store.count()).toBe(2);
    expect(store.get('api', 'hubspot')?.display_name).toBe('HubSpot Production');
    expect(store.get('notification', 'hubspot')?.display_name).toBe('HubSpot Slack');
  });
});

describe('createConnectionStore — list / listSince ordering', () => {
  beforeEach(() => {
    store.upsert(mkUpsert({
      kind: 'api', name: 'hubspot', updated_at: 1_700_000_010_000,
    }));
    store.upsert(mkUpsert({
      kind: 'api', name: 'salesforce', updated_at: 1_700_000_020_000,
    }));
    store.upsert(mkUpsert({
      kind: 'mcp', name: 'gh-mcp', subtype: 'sse', updated_at: 1_700_000_005_000,
    }));
    store.upsert(mkUpsert({
      kind: 'notification', name: 'team-slack', subtype: 'slack',
      updated_at: 1_700_000_030_000,
    }));
  });

  it('list() returns every row, newest updated_at first', () => {
    const all = store.list();
    expect(all.map((r) => r.name)).toEqual([
      'team-slack',
      'salesforce',
      'hubspot',
      'gh-mcp',
    ]);
  });

  it('list({ kind }) filters to one kind', () => {
    expect(store.list({ kind: 'api' }).map((r) => r.name)).toEqual([
      'salesforce',
      'hubspot',
    ]);
  });

  it('listSince filters strict-greater-than', () => {
    const recent = store.listSince(1_700_000_010_000);
    expect(recent.map((r) => r.name)).toEqual(['team-slack', 'salesforce']);
  });
});
