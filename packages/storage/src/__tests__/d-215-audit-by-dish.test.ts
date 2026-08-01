/** D-215 slice 2 — dish-scoped audit reads.
 *
 *  Two queries back the dish surface:
 *
 *    `listByDish`      — one dish's run history (the detail view).
 *    `latestByDishes`  — the newest run for MANY dishes in ONE pass (the
 *                        list view's last-outcome cell). Calling
 *                        `listByDish` per row would be N full scans.
 *
 *  ⚠ A `json_extract(data,'$.dish_id')` INDEX was specced and dropped:
 *  `Collection` exposes no predicate query, so every `listBy*` scans in
 *  JS and an index would have had no reader. See the note in `audit.ts`.
 *
 *  🔑 `dish_id` OUTLIVES the dish row by design — an auto-run config change
 *  dissolves the prior dish, and a one-shot retires itself on success
 *  (D-215 § 5). Both leave audit intact, so these queries must keep
 *  answering for a dish that no longer exists.
 *
 *  Spec: D-215 § 4.3.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditLogStore,
  type ActivityEntry,
} from '../index.js';

const mkEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  run_id: 'run-1',
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

describe('D-215 slice 2 — listByDish', () => {
  let store: AuditLogStore;
  beforeEach(() => {
    store = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
  });

  it('returns only that dish\'s runs, newest first', async () => {
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_a', started_at: 1_000 }));
    await store.append(mkEntry({ run_id: 'a2', dish_id: 'dsh_a', started_at: 3_000 }));
    await store.append(mkEntry({ run_id: 'b1', dish_id: 'dsh_b', started_at: 2_000 }));

    const rows = await store.listByDish('dsh_a');
    expect(rows.map((r) => r.run_id)).toEqual(['a2', 'a1']);
  });

  it('honours limit AFTER sorting, so the page is the NEWEST n', async () => {
    await store.append(mkEntry({ run_id: 'old', dish_id: 'dsh_a', started_at: 1_000 }));
    await store.append(mkEntry({ run_id: 'new', dish_id: 'dsh_a', started_at: 9_000 }));

    expect((await store.listByDish('dsh_a', 1)).map((r) => r.run_id)).toEqual(['new']);
  });

  it('ignores runs with NO dish_id (a dishless / legacy row)', async () => {
    await store.append(mkEntry({ run_id: 'none', started_at: 5_000 }));
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_a', started_at: 1_000 }));

    expect((await store.listByDish('dsh_a')).map((r) => r.run_id)).toEqual(['a1']);
  });

  it('returns [] for an empty id — even against a row whose dish_id IS empty', async () => {
    // ⚠ The dishless row alone does NOT exercise the guard: its `dish_id`
    // is `undefined`, and `undefined === ''` is already false, so the
    // filter rejects it with or without the early return. Only a row
    // carrying a literal `''` distinguishes the two — without it, deleting
    // the guard is a mutation that survives.
    await store.append(mkEntry({ run_id: 'none' }));
    await store.append(mkEntry({ run_id: 'empty-id', dish_id: '' }));
    expect(await store.listByDish('')).toEqual([]);
  });

  it('still answers for a RETIRED dish — audit outlives the dish row', async () => {
    // No dish store is consulted at all; the id is the only key. This is
    // what lets the surface render a retired dish's history.
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_gone' }));
    expect((await store.listByDish('dsh_gone')).map((r) => r.run_id)).toEqual(['a1']);
  });

  it('orders by event time when the caller asks for the event axis', async () => {
    // `started_at` ascending but `event_at` descending — the two axes
    // disagree, so a test that set them in step would prove nothing.
    await store.append(mkEntry({
      run_id: 'ingested-first', dish_id: 'dsh_a', started_at: 1_000, event_at: 9_000,
    }));
    await store.append(mkEntry({
      run_id: 'ingested-second', dish_id: 'dsh_a', started_at: 2_000, event_at: 1_000,
    }));

    expect((await store.listByDish('dsh_a', undefined, 'ingestion')).map((r) => r.run_id))
      .toEqual(['ingested-second', 'ingested-first']);
    expect((await store.listByDish('dsh_a', undefined, 'event')).map((r) => r.run_id))
      .toEqual(['ingested-first', 'ingested-second']);
  });
});

describe('D-215 slice 2 — latestByDishes', () => {
  let store: AuditLogStore;
  beforeEach(() => {
    store = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
  });

  it('returns the NEWEST run per dish, for many dishes at once', async () => {
    await store.append(mkEntry({ run_id: 'a-old', dish_id: 'dsh_a', started_at: 1_000 }));
    await store.append(mkEntry({ run_id: 'a-new', dish_id: 'dsh_a', started_at: 5_000 }));
    await store.append(mkEntry({ run_id: 'b-old', dish_id: 'dsh_b', started_at: 2_000 }));
    await store.append(mkEntry({ run_id: 'b-new', dish_id: 'dsh_b', started_at: 4_000 }));

    const latest = await store.latestByDishes(['dsh_a', 'dsh_b']);
    expect(latest.get('dsh_a')?.run_id).toBe('a-new');
    expect(latest.get('dsh_b')?.run_id).toBe('b-new');
    expect(latest.size).toBe(2);
  });

  it('OMITS a dish that has never run — the caller renders "never run"', async () => {
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_a' }));
    const latest = await store.latestByDishes(['dsh_a', 'dsh_never']);
    expect(latest.has('dsh_never')).toBe(false);
    expect(latest.has('dsh_a')).toBe(true);
  });

  it('never leaks a dish that was not asked for', async () => {
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_a' }));
    await store.append(mkEntry({ run_id: 'z1', dish_id: 'dsh_z' }));
    const latest = await store.latestByDishes(['dsh_a']);
    expect([...latest.keys()]).toEqual(['dsh_a']);
  });

  it('tolerates an empty list, duplicates, and empty-string ids', async () => {
    await store.append(mkEntry({ run_id: 'a1', dish_id: 'dsh_a' }));
    await store.append(mkEntry({ run_id: 'none' }));

    expect((await store.latestByDishes([])).size).toBe(0);
    expect((await store.latestByDishes(['dsh_a', 'dsh_a'])).size).toBe(1);
    // An empty id must not match the dishless row above.
    expect((await store.latestByDishes([''])).size).toBe(0);
  });

  it('is insertion-order independent — newest wins however the rows arrive', async () => {
    // Appending the NEWEST first would let a naive "last one seen wins"
    // implementation pass the main test above while being wrong.
    await store.append(mkEntry({ run_id: 'a-new', dish_id: 'dsh_a', started_at: 5_000 }));
    await store.append(mkEntry({ run_id: 'a-old', dish_id: 'dsh_a', started_at: 1_000 }));

    expect((await store.latestByDishes(['dsh_a'])).get('dsh_a')?.run_id).toBe('a-new');
  });
});
