/** D-118 Phase 2 — service_instance_state table tests.
 *
 *  Covers DDL idempotence, narrow patch merge semantics, list
 *  ordering, clear/clearAll cascade behavior, deriveServiceState
 *  decision matrix, and `last_health_state` parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  createServiceStateStore,
  deriveServiceState,
  type ServiceInstanceStateStore,
} from '../service-state-table.js';

let db: Database.Database;
let store: ServiceInstanceStateStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createServiceStateStore({ db });
});

afterEach(() => {
  db.close();
});

describe('createServiceStateStore — DDL', () => {
  it('creates the table on first call and is idempotent on second', () => {
    // Calling the factory again on the same db must not throw.
    expect(() => createServiceStateStore({ db })).not.toThrow();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .all('service_instance_state');
    expect(tables.length).toBe(1);
  });

  it('the table starts empty', () => {
    expect(store.list()).toEqual([]);
  });
});

describe('upsert — first insert', () => {
  it('inserts a row with table defaults when patch is empty', () => {
    const row = store.upsert('ollama', {});
    expect(row.slug).toBe('ollama');
    expect(row.pid).toBeNull();
    expect(row.consecutive_crashes).toBe(0);
    expect(row.quota_bytes_cached).toBe(0);
    expect(row.last_health_state).toBeNull();
  });

  it('records pid + started_at on the supervisor "process started" patch', () => {
    const row = store.upsert('ollama', {
      pid: 12_345,
      started_at: 1_700_000_000_000,
    });
    expect(row.pid).toBe(12_345);
    expect(row.started_at).toBe(1_700_000_000_000);
    // Other columns left at defaults
    expect(row.consecutive_crashes).toBe(0);
  });

  it('records the full quota sample patch from the tracker', () => {
    const row = store.upsert('ollama', {
      quota_bytes_cached: 1_500_000,
      quota_bytes_sampled_at: 1_700_000_000_000,
    });
    expect(row.quota_bytes_cached).toBe(1_500_000);
    expect(row.quota_bytes_sampled_at).toBe(1_700_000_000_000);
  });
});

describe('upsert — merge semantics', () => {
  it('omitted fields preserve their previous value', () => {
    store.upsert('ollama', { pid: 100, started_at: 1_000 });
    // Patch only the health fields — pid + started_at must survive.
    const row = store.upsert('ollama', {
      last_health_at: 2_000,
      last_health_state: 'healthy',
    });
    expect(row.pid).toBe(100);
    expect(row.started_at).toBe(1_000);
    expect(row.last_health_at).toBe(2_000);
    expect(row.last_health_state).toBe('healthy');
  });

  it('explicit null clears a previously-set field (process exit pattern)', () => {
    store.upsert('ollama', { pid: 100, started_at: 1_000 });
    // Supervisor crash listener sets pid back to null.
    const row = store.upsert('ollama', {
      pid: null,
      started_at: null,
      last_exit_code: 137,
    });
    expect(row.pid).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.last_exit_code).toBe(137);
  });

  it('consecutive_crashes increments via repeated patches', () => {
    let row = store.upsert('ollama', { consecutive_crashes: 1 });
    expect(row.consecutive_crashes).toBe(1);
    row = store.upsert('ollama', { consecutive_crashes: 2 });
    expect(row.consecutive_crashes).toBe(2);
    // Resetting to 0 on a healthy start.
    row = store.upsert('ollama', { consecutive_crashes: 0 });
    expect(row.consecutive_crashes).toBe(0);
  });
});

describe('get / list / clear / clearAll', () => {
  beforeEach(() => {
    store.upsert('ollama', { pid: 100 });
    store.upsert('cloudflared', { pid: 200 });
    store.upsert('ffmpeg', { quota_bytes_cached: 50_000 });
  });

  it('get returns null for unknown slugs', () => {
    expect(store.get('unknown')).toBeNull();
  });

  it('list returns every row sorted by slug', () => {
    const slugs = store.list().map((r) => r.slug);
    expect(slugs).toEqual(['cloudflared', 'ffmpeg', 'ollama']);
  });

  it('clear removes a single row + reports change', () => {
    expect(store.clear('ollama')).toBe(true);
    expect(store.get('ollama')).toBeNull();
    expect(store.clear('ollama')).toBe(false); // already gone
    expect(store.list().length).toBe(2);
  });

  it('clearAll wipes the table — server-start reconcile prep', () => {
    store.clearAll();
    expect(store.list()).toEqual([]);
  });
});

describe('last_health_state — invalid values are coerced to null', () => {
  it('valid values round-trip', () => {
    const row = store.upsert('ollama', { last_health_state: 'unhealthy' });
    expect(row.last_health_state).toBe('unhealthy');
  });

  it('a manually-injected garbage value reads back as null', () => {
    // Simulate a corrupted row (shouldn't happen via store API, but
    // older rows or hand-edited DBs might surface).
    db.prepare(
      `INSERT INTO service_instance_state (slug, last_health_state, consecutive_crashes, quota_bytes_cached) VALUES (?, ?, 0, 0)`,
    ).run('weird', 'bogus');
    const row = store.get('weird');
    expect(row?.last_health_state).toBeNull();
  });
});

describe('deriveServiceState — pure decision matrix', () => {
  const baseRow = {
    slug: 'x',
    pid: null,
    started_at: null,
    last_crash_at: null,
    consecutive_crashes: 0,
    last_health_at: null,
    last_health_state: null,
    last_exit_code: null,
    quota_bytes_cached: 0,
    quota_bytes_sampled_at: null,
  };

  it('pid + started_at → running', () => {
    expect(
      deriveServiceState({ ...baseRow, pid: 1, started_at: 1 }),
    ).toBe('running');
  });

  it('last_crash_at set + crashes < 5 → crashed', () => {
    expect(
      deriveServiceState({
        ...baseRow,
        last_crash_at: 1,
        consecutive_crashes: 3,
      }),
    ).toBe('crashed');
  });

  it('last_crash_at set + crashes >= 5 → permanently_crashed', () => {
    expect(
      deriveServiceState({
        ...baseRow,
        last_crash_at: 1,
        consecutive_crashes: 5,
      }),
    ).toBe('permanently_crashed');
  });

  it('completely empty row → unknown (initial state pre-reconcile)', () => {
    expect(deriveServiceState(baseRow)).toBe('unknown');
  });

  it('health-only row (no pid, no crash, has last_health_at) → stopped', () => {
    expect(
      deriveServiceState({ ...baseRow, last_health_at: 1 }),
    ).toBe('stopped');
  });
});
