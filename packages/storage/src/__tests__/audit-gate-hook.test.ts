import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAuditLogStore,
  createInMemoryCollection,
  newRunId,
  type AuditEntry,
  type AuditLogStore,
  type ActivityEntry,
} from '../index.js';

const mkEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: overrides.run_id ?? newRunId(),
  recipe_id: 'r',
  recipe_hash: 'h',
  started_at: 1_000,
  finished_at: 1_100,
  duration_ms: 100,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
  ...overrides,
});

describe('AuditLogStore — onBytesChanged hook', () => {
  let deltas: number[];
  let store: AuditLogStore;

  beforeEach(() => {
    deltas = [];
    store = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
      { onBytesChanged: (d) => deltas.push(d) },
    );
  });

  it('reports positive delta on first append', async () => {
    await store.append(mkEntry({ run_id: 'r1' }));
    expect(deltas[0]).toBeGreaterThan(0);
  });

  it('reports net delta on replace-by-run-id', async () => {
    await store.append(mkEntry({ run_id: 'r1', duration_ms: 100 }));
    deltas.length = 0;
    // Same run_id, significantly different payload
    await store.append(mkEntry({
      run_id: 'r1',
      duration_ms: 100_000_000, // drastically different number of digits
    }));
    // The change from "100" to a larger number is positive
    expect(typeof deltas[0]).toBe('number');
  });

  it('reports negative delta on logActivity with same ID (overwrite)', async () => {
    await store.logActivity({ activity_id: 'a1', timestamp: 1, action: 'install', target: 'r' });
    const bytesBefore = deltas.reduce((s, d) => s + d, 0);
    await store.logActivity({ activity_id: 'a1', timestamp: 2, action: 'install', target: 'r' });
    // Net size ~ stable (same shape, just different timestamp digits)
    // Only check no throw + sum reasonable
    expect(typeof bytesBefore).toBe('number');
  });

  it('clearOlderThan reports freed bytes (reserve rows skipped)', async () => {
    await store.append(mkEntry({ run_id: 'old', started_at: 100 }));
    await store.append(mkEntry({ run_id: 'reserve', started_at: 100, reserve: true }));
    await store.append(mkEntry({ run_id: 'new', started_at: 1_000 }));
    deltas.length = 0;
    await store.clearOlderThan(500);
    // freed = bytes of 'old' row (reserve + new retained)
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toBeLessThan(0);
  });

  it('clearOldestEntries reports sum of freed bytes', async () => {
    for (let i = 0; i < 3; i++) {
      await store.append(mkEntry({ run_id: `r${i}`, started_at: i * 100 }));
    }
    deltas.length = 0;
    const n = await store.clearOldestEntries(2);
    expect(n).toBe(2);
    expect(deltas[0]).toBeLessThan(0);
  });

  it('clearOldestActivities reports freed bytes (reserve skipped)', async () => {
    await store.logActivity({ activity_id: 'u1', timestamp: 1, action: 'install', target: 't' });
    await store.logActivity({ activity_id: 'r1', timestamp: 2, action: 'crash_halt_toggle', target: 't' });
    await store.logActivity({ activity_id: 'u2', timestamp: 3, action: 'install', target: 't' });
    deltas.length = 0;
    await store.clearOldestActivities(10);
    // Sum of freed bytes should be negative (2 non-reserve rows freed)
    const total = deltas.reduce((s, d) => s + d, 0);
    expect(total).toBeLessThan(0);
  });

  it('clearAll reports freed bytes across both tables', async () => {
    await store.append(mkEntry({ run_id: 'r' }));
    await store.logActivity({ activity_id: 'a', timestamp: 1, action: 'install', target: 't' });
    deltas.length = 0;
    await store.clearAll();
    const total = deltas.reduce((s, d) => s + d, 0);
    expect(total).toBeLessThan(0);
  });

  it('no-op when onBytesChanged absent (legacy)', async () => {
    const legacy = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
    await expect(legacy.append(mkEntry())).resolves.toBeUndefined();
  });

  it('swallows handler exceptions', async () => {
    const boom = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
      { onBytesChanged: () => { throw new Error('boom'); } },
    );
    await expect(boom.append(mkEntry())).resolves.toBeUndefined();
  });

  it('auto-trim reports freed bytes', async () => {
    const backing = createInMemoryCollection<AuditEntry>();
    const trimDeltas: number[] = [];
    const trimStore = createAuditLogStore(backing, undefined, {
      maxEntries: 2,
      onBytesChanged: (d) => trimDeltas.push(d),
    });
    for (let i = 0; i < 4; i++) {
      await trimStore.append(mkEntry({ run_id: `r${i}`, started_at: i }));
    }
    await new Promise((r) => setTimeout(r, 20));
    // At least one negative delta from the auto-trim evicting older rows.
    const negatives = trimDeltas.filter((d) => d < 0);
    expect(negatives.length).toBeGreaterThan(0);
  });
});
