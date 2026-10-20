import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SituationSnapshot } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createEventTriggersStore } from '../triggers/store.js';
import { createEventTriggerDispatcher, type TriggerDispatchRuntime } from '../triggers/dispatcher.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); }); afterEach(() => db.close());
const snapshot = (): SituationSnapshot => ({ id: 'trip', state: 'proposed', urgency: 'routine',
  cluster: { id: 'trip', subjects: [], span: { from: 1, to: 100 }, omitted: 0, items: [] } });
const addTrigger = (store: ReturnType<typeof createEventTriggersStore>, id: string, pattern: string) => store.create({
  trigger_id: id, recipe_id: `recipe-${id}`, publisher_id: 'local', pattern, enabled: true, created_at: 0,
});

describe('D-325 real bus, trigger and revision-store drives', () => {
  it('projects both asset snapshots per subscriber before passing the payload to its recipe', async () => {
    ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    const bus = createWarehouseEventBus(); const store = createEventTriggersStore(db);
    addTrigger(store, 'allowed', 'data.work.asset.item.updated'); addTrigger(store, 'denied', 'data.work.asset.item.updated');
    const calls: Array<Parameters<TriggerDispatchRuntime['runRecipe']>[0]> = [];
    const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe: async input => { calls.push(input); } },
      readGrantsForSubscriber: trigger => ({ isVerbOpGranted: () => trigger.trigger_id === 'allowed', isCollectionReadGranted: () => true, isTopicReadGranted: () => false }) });
    dispatcher.rebuild();
    const writes = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), bus });
    const { asset } = await writes.assetCreate({ name: 'Passport', source: { kind: 'extracted', ref: 'file:one' }, document_number: 'secret-before' });
    await writes.assetUpdate({ id: asset.id, source: { kind: 'extracted', ref: 'file:two' }, document_number: 'secret-after' });
    await dispatcher.drained();
    const allowed = JSON.stringify(calls.find(call => call.trigger_id === 'allowed')?.context);
    const denied = JSON.stringify(calls.find(call => call.trigger_id === 'denied')?.context);
    expect(allowed).toContain('secret-before'); expect(allowed).toContain('secret-after');
    expect(denied).not.toContain('secret-before'); expect(denied).not.toContain('secret-after'); expect(denied).not.toContain('Passport');
    expect(denied).toContain(asset.id); expect(denied).toContain('document_number'); dispatcher.dispose();
  });
  it('catches up after sealed live events and restart, skips an already handled revision, and catches failed publication', async () => {
    const bus = createWarehouseEventBus(); const store = createEventTriggersStore(db); addTrigger(store, 'one', 'data.situation.**');
    let open = false;
    const situations = createSituationStore(db, bus); const runRecipe = vi.fn(async () => {});
    const make = () => createEventTriggerDispatcher({ bus, store, situations, runtime: { runRecipe }, isVaultUnlocked: () => open });
    const first = make(); first.rebuild(); situations.save(snapshot(), { source: 'brief' }, 1); await first.drained();
    expect(runRecipe).not.toHaveBeenCalled(); expect(situations.checkpoint('trigger:one')).toBe(0);
    open = true; await first.catchUpSituations!(); expect(runRecipe).toHaveBeenCalledTimes(1); first.dispose();
    const restarted = make(); restarted.rebuild(); await restarted.catchUpSituations!(); expect(runRecipe).toHaveBeenCalledTimes(1);
    const next = snapshot(); next.urgency = 'floor';
    createSituationStore(db, { emit: () => { throw new Error('publication failed'); } }).save(next, { source: 'passport' }, 2);
    await restarted.catchUpSituations!(); expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(situations.checkpoint('trigger:one')).toBe(2); restarted.dispose();
  });
  it('retains a failed dispatch checkpoint, retries it in order, and suppresses its own cause', async () => {
    const bus = createWarehouseEventBus(); const store = createEventTriggersStore(db); addTrigger(store, 'one', 'data.situation.**');
    const situations = createSituationStore(db); situations.save(snapshot(), { source: 'brief' }, 1);
    const next = snapshot(); next.urgency = 'floor'; situations.save(next, { source: 'recipe:recipe-one', revision: 1 }, 2);
    const runRecipe = vi.fn().mockRejectedValueOnce(Object.assign(new Error('retry later'), { code: 'NETWORK_ERROR' })).mockResolvedValue(undefined);
    const dispatcher = createEventTriggerDispatcher({ bus, store, situations, runtime: { runRecipe } }); dispatcher.rebuild();
    await dispatcher.catchUpSituations!(); expect(situations.checkpoint('trigger:one')).toBe(0);
    await dispatcher.catchUpSituations!(); expect(situations.checkpoint('trigger:one')).toBe(2); expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(runRecipe.mock.calls[1]?.[0].context)).toContain('revision'); dispatcher.dispose();
  });
  it('blocks an uncertain execution after an effect, including on a restarted dispatcher', async () => {
    const bus = createWarehouseEventBus(); const store = createEventTriggersStore(db); addTrigger(store, 'one', 'data.situation.**');
    const situations = createSituationStore(db); situations.save(snapshot(), { source: 'caller' }, 1);
    let effects = 0;
    const runtime: TriggerDispatchRuntime = { runRecipe: async input => {
      input.beforeRunStart!('run-original'); effects += 1;
      throw new Error('process lost its result after the provider accepted');
    } };
    const first = createEventTriggerDispatcher({ bus, store, situations, runtime }); first.rebuild();
    await first.catchUpSituations!(); expect(effects).toBe(1); expect(situations.checkpoint('trigger:one')).toBe(0);
    expect(situations.subscriberRun('trigger:one', 1)).toEqual({ run_id: 'run-original', state: 'in_doubt' }); first.dispose();
    const restarted = createEventTriggerDispatcher({ bus, store, situations, runtime }); restarted.rebuild();
    await restarted.catchUpSituations!(); expect(effects).toBe(1); expect(situations.checkpoint('trigger:one')).toBe(0); restarted.dispose();
  });
  it('acknowledges a completed run after a crash before checkpointing without another effect', async () => {
    const bus = createWarehouseEventBus(); const store = createEventTriggersStore(db); addTrigger(store, 'one', 'data.situation.**');
    const situations = createSituationStore(db); situations.save(snapshot(), { source: 'caller' }, 1);
    expect(situations.beginSubscriberRun('trigger:one', 1, 'run-completed', 1)).toBe(true);
    expect(situations.beginSubscriberRun('trigger:one', 1, 'competing', 1)).toBe(false);
    situations.finishSubscriberRun('trigger:one', 1, 'completed', 2);
    const runRecipe = vi.fn(async () => {});
    const dispatcher = createEventTriggerDispatcher({ bus, store, situations, runtime: { runRecipe } }); dispatcher.rebuild();
    await dispatcher.catchUpSituations!(); expect(runRecipe).not.toHaveBeenCalled(); expect(situations.checkpoint('trigger:one')).toBe(1); dispatcher.dispose();
  });
});
