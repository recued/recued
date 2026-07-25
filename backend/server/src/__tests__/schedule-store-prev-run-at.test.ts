/** Schedule-store roll-forward of `prev_run_at` on every fire.
 *
 *  Phase 5 Smart Backfill reads the schedule's observed cadence from
 *  the gap between `prev_run_at` and `last_run_at`, so the store has
 *  to roll the prior `last_run_at` into `prev_run_at` automatically
 *  whenever the patch advances `last_run_at`. */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createScheduleStore } from '../schedule-store.js';
import type { Schedule } from '@recued/scheduler';

function mkStore() {
  const db = new Database(':memory:');
  return createScheduleStore(db);
}

const baseSchedule = (over: Partial<Schedule> = {}): Schedule => ({
  schedule_id: over.schedule_id ?? 's1',
  recipe_id: over.recipe_id ?? 'r1',
  publisher_id: 'recued-core',
  cron_expression: '0 * * * *',
  enabled: true,
  created_at: 0,
  last_run_at: over.last_run_at ?? null,
  prev_run_at: over.prev_run_at ?? null,
  next_run_at: over.next_run_at ?? null,
  last_status: null,
  last_error: null,
});

describe('ScheduleStore — prev_run_at roll-forward', () => {
  it('rolls last_run_at into prev_run_at on advancing fire', () => {
    const store = mkStore();
    store.set(baseSchedule({ last_run_at: 1000 }));
    store.updateRun('s1', { last_run_at: 5000 });
    const after = store.get('s1')!;
    expect(after.last_run_at).toBe(5000);
    expect(after.prev_run_at).toBe(1000);
  });

  it('skips the roll when the patch repeats the existing last_run_at (idempotent)', () => {
    const store = mkStore();
    store.set(baseSchedule({ last_run_at: 1000, prev_run_at: 500 }));
    store.updateRun('s1', { last_run_at: 1000 });
    const after = store.get('s1')!;
    // prev unchanged because the patch was a no-op on last_run_at
    expect(after.prev_run_at).toBe(500);
  });

  it('skips the roll when last_run_at is not in the patch', () => {
    const store = mkStore();
    store.set(baseSchedule({ last_run_at: 1000, prev_run_at: 500 }));
    store.updateRun('s1', { last_status: 'success' });
    const after = store.get('s1')!;
    // prev unchanged — only metadata was updated, not the timestamp
    expect(after.prev_run_at).toBe(500);
    expect(after.last_status).toBe('success');
  });

  it('first fire sets prev_run_at to null (was null before)', () => {
    const store = mkStore();
    store.set(baseSchedule({ last_run_at: null }));
    store.updateRun('s1', { last_run_at: 5000 });
    const after = store.get('s1')!;
    expect(after.last_run_at).toBe(5000);
    expect(after.prev_run_at).toBeNull();
  });

  it('two consecutive fires populate the observed-interval pair correctly', () => {
    const store = mkStore();
    store.set(baseSchedule());
    store.updateRun('s1', { last_run_at: 1000 });
    store.updateRun('s1', { last_run_at: 5000 });
    const after = store.get('s1')!;
    expect(after.last_run_at).toBe(5000);
    expect(after.prev_run_at).toBe(1000);
    // Smart Backfill would compute interval = 4000.
  });
});
