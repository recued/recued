import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService } from '../situations/asset-reminder-service.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

/** ⛔ A drain step awaits the stop, with 5 s, and the minute interval's own stop
 *  waits for the tick it started, in the same step. A pass sends through every
 *  channel and reaches Home Assistant, either of which can take far longer. */
describe('asset reminders — stopping for a restart', () => {
  it('stops within the grace while a pass hangs, releases the minute tick, and stops Home Assistant with it', async () => {
    const db = new Database(':memory:');
    ensureWorkEntitySchema(db);
    const work = createWorkEntityStore(db);
    autoRegisterRecuedBuiltinSources(work);
    const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work) });
    const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', withdraw: async () => {} });
    const projectHousehold = vi.fn(() => new Promise<void>(() => {}));
    const stopHousehold = vi.fn(async () => {});
    const service = createAssetReminderService({
      db, work, dispatchers, occurrences, timeZone: () => 'UTC', isQuiet: () => false, projectHousehold, stopHousehold,
    });
    let ticked = false;
    void service.tick().then(() => { ticked = true; });
    await vi.waitFor(() => expect(projectHousehold).toHaveBeenCalledTimes(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stopped = false;
    const stopping = service.stop().then(() => { stopped = true; });
    try {
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      vi.useRealTimers();
    }
    expect(stopped).toBe(true);
    expect(ticked).toBe(true);
    await stopping;
    expect(stopHousehold).toHaveBeenCalledTimes(1);

    // Stopped: no further pass starts.
    await service.tick();
    expect(projectHousehold).toHaveBeenCalledTimes(1);
    db.close();
  });
});
