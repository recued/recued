import { describe, expect, it, vi } from 'vitest';

import {
  buildAuditEntry,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { createDrainableAuditLog } from '../audit/drainable.js';

const activity = (): ActivityEntry => ({
  activity_id: 'activity-1',
  timestamp: 1,
  action: 'server_boot',
  target: 'server',
  detail: '{}',
});

const execution = (): AuditEntry => buildAuditEntry({
  run_id: 'run-1',
  recipe_id: 'recipe-1',
  recipe_hash: 'hash-1',
  now: 2,
  duration_ms: 1,
  commit_status: 'succeeded',
  config_snapshot: {},
  errors: [],
  trigger_url: null,
  trigger_source: null,
  instance_id: null,
});

describe('createDrainableAuditLog', () => {
  it('closes late admission and waits for every admitted append kind', async () => {
    let releaseActivity!: () => void;
    const activityPending = new Promise<void>((resolve) => {
      releaseActivity = resolve;
    });
    let releaseExecution!: () => void;
    const executionPending = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const logActivity = vi.fn(() => activityPending);
    const append = vi.fn(() => executionPending);
    const drainable = createDrainableAuditLog({
      logActivity,
      append,
    } as unknown as AuditLogStore);

    const activityWrite = drainable.auditLog.logActivity(activity());
    const executionWrite = drainable.auditLog.append(execution());
    let drained = false;
    const firstDrain = drainable.closeAndDrain().then(() => { drained = true; });
    const secondDrain = drainable.closeAndDrain();

    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(drainable.auditLog.logActivity({
      ...activity(),
      activity_id: 'late',
    })).resolves.toBeUndefined();
    expect(logActivity).toHaveBeenCalledOnce();

    releaseActivity();
    await activityWrite;
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseExecution();
    await executionWrite;
    await Promise.all([firstDrain, secondDrain]);
    expect(drained).toBe(true);
    expect(append).toHaveBeenCalledOnce();
  });

  it('preserves an append failure for its caller while containing it in drain', async () => {
    const failure = new Error('audit unavailable');
    const drainable = createDrainableAuditLog({
      logActivity: vi.fn(async () => { throw failure; }),
    } as unknown as AuditLogStore);

    const write = drainable.auditLog.logActivity(activity());
    await expect(write).rejects.toBe(failure);
    await expect(drainable.closeAndDrain()).resolves.toBeUndefined();
  });
});
