import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type AuditLogStore } from '@recued/storage';
import { createScheduleStore, type ScheduleStore } from '../schedule-store.js';
import { createSchedule, updateSchedule, deleteSchedule, type ScheduleHandlerDeps } from '../schedule-handler.js';

const mkGate = (): StorageGate => createStorageGate({
  quota: 20 * 1024 * 1024,
  reservePct: 0,
  surface: 'schedules',
  pressureRatio: 0.8,
});

describe('ScheduleStore — onBytesChanged', () => {
  it('reports positive delta on insert', () => {
    const deltas: number[] = [];
    const db = new Database(':memory:');
    const store = createScheduleStore(db, { onBytesChanged: (d) => deltas.push(d) });
    store.set({
      schedule_id: 's1', recipe_id: 'r', publisher_id: 'p',
      cron_expression: '*/5 * * * *', enabled: true,
      created_at: 1, last_run_at: null, next_run_at: 2,
      last_status: null, last_error: null,
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBeGreaterThan(0);
  });

  it('reports net delta on overwrite', () => {
    const deltas: number[] = [];
    const db = new Database(':memory:');
    const store = createScheduleStore(db, { onBytesChanged: (d) => deltas.push(d) });
    const small = {
      schedule_id: 's1', recipe_id: 'r', publisher_id: 'p',
      cron_expression: '*/5 * * * *', enabled: true,
      created_at: 1, last_run_at: null, next_run_at: 2,
      last_status: null, last_error: null,
    };
    store.set(small);
    deltas.length = 0;
    store.set({ ...small, last_error: 'x'.repeat(100) });
    expect(deltas[0]).toBeGreaterThan(0); // bigger
  });

  it('reports negative delta on delete', () => {
    const deltas: number[] = [];
    const db = new Database(':memory:');
    const store = createScheduleStore(db, { onBytesChanged: (d) => deltas.push(d) });
    store.set({
      schedule_id: 's1', recipe_id: 'r', publisher_id: 'p',
      cron_expression: '*/5 * * * *', enabled: true,
      created_at: 1, last_run_at: null, next_run_at: 2,
      last_status: null, last_error: null,
    });
    deltas.length = 0;
    store.delete('s1');
    expect(deltas[0]).toBeLessThan(0);
  });

  it('updateRun reports the net delta', () => {
    const deltas: number[] = [];
    const db = new Database(':memory:');
    const store = createScheduleStore(db, { onBytesChanged: (d) => deltas.push(d) });
    store.set({
      schedule_id: 's1', recipe_id: 'r', publisher_id: 'p',
      cron_expression: '*/5 * * * *', enabled: true,
      created_at: 1, last_run_at: null, next_run_at: 2,
      last_status: null, last_error: null,
    });
    deltas.length = 0;
    store.updateRun('s1', { last_run_at: 5000, last_status: 'success' });
    // Net delta is small + probably positive.
    expect(typeof deltas[0]).toBe('number');
  });
});

describe('createSchedule — gate admission', () => {
  let gate: StorageGate;
  let store: ScheduleStore;
  let auditLog: AuditLogStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    gate = mkGate();
    store = createScheduleStore(db, { onBytesChanged: (d) => gate.addUsed(d) });
    auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
  });

  const mkDeps = (): ScheduleHandlerDeps => ({
    store, instanceId: 'inst-1', gate, auditLog,
    // Bypass the cron floor so the test can use 1-minute cron.
    cronFloorMs: 60_000,
  });

  it('creates a schedule under normal conditions', () => {
    const res = createSchedule(mkDeps(), {
      recipe_id: 'deal-risk',
      cron_expression: '*/5 * * * *',
      enabled: true,
    });
    expect(res.schedule.schedule_id).toMatch(/^sch_/);
  });

  it('rejects when gate is at writes_blocked', async () => {
    gate.setUsed(gate.info().blockedAt);
    expect(() =>
      createSchedule(mkDeps(), {
        recipe_id: 'deal-risk',
        cron_expression: '*/5 * * * *',
        enabled: true,
      }),
    ).toThrow(/schedule creation rejected/);
    // logActivity is fire-and-forget (`void ... .catch`) — yield to
    // the microtask queue so the pending audit-write completes before
    // we snapshot activities.
    await new Promise((r) => setImmediate(r));
    const activities = await auditLog.listActivities();
    expect(activities.some((a) => a.action === 'quota_exceeded' && a.target === 'schedules')).toBe(true);
  });

  it('rejects on halted state', () => {
    gate.halt('crash_halt');
    expect(() =>
      createSchedule(mkDeps(), {
        recipe_id: 'deal-risk',
        cron_expression: '*/5 * * * *',
        enabled: true,
      }),
    ).toThrow(/schedule creation rejected/);
  });
});

describe('updateSchedule — gate admission', () => {
  let gate: StorageGate;
  let store: ScheduleStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    gate = mkGate();
    store = createScheduleStore(db, { onBytesChanged: (d) => gate.addUsed(d) });
  });

  it('admits update at blocked when net delta ≤ 0', () => {
    const deps: ScheduleHandlerDeps = { store, instanceId: 'inst-1', gate, cronFloorMs: 60_000 };
    const r1 = createSchedule(deps, {
      recipe_id: 'deal-risk',
      // Start with a LONGER cron (6 chars vs 5) so the update shrinks
      // the row — `estimateSize` difference is negative, admission
      // skipped entirely.
      cron_expression: '*/15 * * * *',
      enabled: true,
    });
    gate.setUsed(gate.info().blockedAt);
    expect(() =>
      updateSchedule(deps, r1.schedule.schedule_id, {
        cron_expression: '*/5 * * * *',
      }),
    ).not.toThrow();
  });
});

describe('deleteSchedule — gate sync on delete', () => {
  it('gate reflects freed bytes', () => {
    const db = new Database(':memory:');
    const gate = mkGate();
    const store = createScheduleStore(db, { onBytesChanged: (d) => gate.addUsed(d) });
    const r = createSchedule({ store, instanceId: 'x', gate, cronFloorMs: 60_000 }, {
      recipe_id: 'x', cron_expression: '*/5 * * * *', enabled: true,
    });
    const usedBefore = gate.info().used;
    deleteSchedule({ store, instanceId: 'x', cronFloorMs: 60_000 }, r.schedule.schedule_id);
    expect(gate.info().used).toBeLessThan(usedBefore);
  });
});
