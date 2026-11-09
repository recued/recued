/** D-188 — the pause as the emergency stop (the owner's ruling of 2026-11-08): the server's own
 *  services hold with it, and Resume starts them again. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerStateStore, isServerPausedIn } from '../server-state.js';
import { ensureHousekeepingSchema } from '../housekeeping/index.js';
import { isAiPaused } from '../housekeeping/trust-store.js';
import { createHousekeepingSchedulerRegistry } from '../composition/bin/housekeeping-scheduler-instance.js';
import { runGatedCatalogOperation } from '../source-mirror/fetch.js';
import { SERVER_PAUSED_DETAIL } from '../pause-approval.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const openDb = (): Database.Database => {
  const db = new Database(':memory:');
  dbs.push(db);
  return db;
};

describe('the stored pause, read from the database', () => {
  it('follows the server state, and reads false before any server opened the database', () => {
    const fresh = openDb();
    expect(isServerPausedIn(fresh)).toBe(false);
    const state = createServerStateStore(fresh);
    state.setPaused(true);
    expect(isServerPausedIn(fresh)).toBe(true);
    state.setPaused(false);
    expect(isServerPausedIn(fresh)).toBe(false);
  });

  it('pauses background AI with it, as Pause AI does', () => {
    const db = openDb();
    ensureHousekeepingSchema(db);
    const state = createServerStateStore(db);
    expect(isAiPaused(db, Date.now())).toBe(false);
    state.setPaused(true);
    expect(isAiPaused(db, Date.now())).toBe(true);
    state.setPaused(false);
    expect(isAiPaused(db, Date.now())).toBe(false);
  });
});

describe('housekeeping on Resume', () => {
  const makeScheduler = () => ({ start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), runOnce: vi.fn() });

  it('starts the scheduler the pause stopped, once', async () => {
    const registry = createHousekeepingSchedulerRegistry();
    const scheduler = makeScheduler();
    registry.setScheduler(scheduler as never);
    await registry.stop();
    expect(registry.getScheduler()).toBeUndefined();
    registry.resume();
    expect(registry.getScheduler()).toBe(scheduler);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
    registry.resume();
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it('does nothing when nothing was stopped', () => {
    const registry = createHousekeepingSchedulerRegistry();
    registry.resume();
    expect(registry.getScheduler()).toBeUndefined();
  });
});

describe('a catalog operation run outside a recipe', () => {
  it('is not called while paused, and says why', async () => {
    const manifestsGet = vi.fn();
    const outcome = await runGatedCatalogOperation({
      executorConfig: { manifests: { get: manifestsGet }, isServerPaused: () => true } as never,
      profiles: { get: vi.fn() } as never,
    }, {
      connection_name: 'hubspot',
      manifest: {} as never,
      catalogSlug: 'hubspot-catalog',
      operationKey: 'deal.update',
      args: {},
      auditRecipe: { recipe_id: 'test' } as never,
      stepId: 'step',
    } as never);
    expect(outcome).toEqual({
      ok: false,
      kind: 'policy',
      reason: `${SERVER_PAUSED_DETAIL}; 'hubspot-catalog' was not called`,
    });
    expect(manifestsGet).not.toHaveBeenCalled();
  });
});
