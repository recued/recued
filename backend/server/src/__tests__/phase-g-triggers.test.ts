/** Phase G (D-109) — event trigger store + handler + dispatcher tests.
 *
 *  Covers:
 *    - SQLite store CRUD lifecycle.
 *    - rpc handler input validation (pattern, recipe_id, etc.).
 *    - Pattern validation via warehouse-events `isValidPattern`.
 *    - Dispatcher: subscribe on rebuild, fire on matching event,
 *      record `last_fired_at` + `last_error`.
 *    - Auto-disable after repeated errors. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWarehouseEventBus, eventPath } from '@recued/warehouse-events';
import { createEventTriggersStore } from '../triggers/store.js';
import {
  handleTriggersCreate,
  handleTriggersDelete,
  handleTriggersList,
  handleTriggersUpdate,
  makeTriggersHandlers,
} from '../triggers/handler.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createDishStore } from '../dish-store.js';

describe('event triggers — store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('creates and retrieves a row', () => {
    const store = createEventTriggersStore(db);
    const trigger = store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      dish_id: 'dsh_k1',
      watch_interval_ms: 6 * 60_000,
      created_at: 1_000,
    });
    expect(trigger.trigger_id).toBe('t-1');
    expect(trigger.dish_id).toBe('dsh_k1');
    expect(trigger.watch_interval_ms).toBe(6 * 60_000);
    expect(store.count()).toBe(1);
    expect(store.get('t-1')).toMatchObject({ trigger_id: 't-1', pattern: 'data.email.**.created' });
  });

  it('returns null for a missing row on get + update', () => {
    const store = createEventTriggersStore(db);
    expect(store.get('nope')).toBeNull();
    expect(store.update('nope', { enabled: false })).toBeNull();
  });

  it('update merges partial fields', () => {
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });
    store.update('t-1', { enabled: false, last_fired_at: 2_000, last_error: 'boom' });
    const row = store.get('t-1')!;
    expect(row.enabled).toBe(false);
    expect(row.last_fired_at).toBe(2_000);
    expect(row.last_error).toBe('boom');
    expect(row.pattern).toBe('data.email.**.created');
  });

  it('remove deletes a row', () => {
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });
    expect(store.remove('t-1')).toBe(true);
    expect(store.remove('t-1')).toBe(false);
    expect(store.count()).toBe(0);
  });

  it('listEnabled returns only enabled rows', () => {
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-on',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });
    store.create({
      trigger_id: 't-off',
      recipe_id: 'r-2',
      publisher_id: 'local',
      pattern: 'data.file.**.created',
      enabled: false,
      created_at: 2_000,
    });
    const enabled = store.listEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.trigger_id).toBe('t-on');
  });
});

describe('event triggers — rpc handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('create rejects a pattern with invalid syntax', async () => {
    const store = createEventTriggersStore(db);
    await expect(
      handleTriggersCreate(
        { store, genId: () => 't-1', now: () => 1_000 },
        { recipe_id: 'r-1', publisher_id: 'local', pattern: '..bad..' },
      ),
    ).rejects.toMatchObject({ code: 'trigger_pattern_invalid' });
  });

  it('create accepts valid patterns with *, **, literals', async () => {
    const store = createEventTriggersStore(db);
    const res = await handleTriggersCreate(
      { store, genId: () => 't-1', now: () => 1_000 },
      {
        recipe_id: 'r-1',
        publisher_id: 'local',
        pattern: 'data.email.*.message.created',
      },
    );
    expect(res.trigger.trigger_id).toBe('t-1');
    expect(res.trigger.enabled).toBe(true);
  });

  it('update 404s for a missing trigger_id', async () => {
    const store = createEventTriggersStore(db);
    await expect(
      handleTriggersUpdate({ store }, { trigger_id: 'nope', enabled: false }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('delete 404s for a missing trigger_id', async () => {
    const store = createEventTriggersStore(db);
    await expect(
      handleTriggersDelete({ store }, { trigger_id: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('list returns rows in insertion order', async () => {
    const store = createEventTriggersStore(db);
    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });
    store.create({
      trigger_id: 't-2',
      recipe_id: 'r-2',
      publisher_id: 'local',
      pattern: 'data.file.**.created',
      enabled: true,
      created_at: 2_000,
    });
    const res = await handleTriggersList({ store });
    expect(res.triggers.map((t) => t.trigger_id)).toEqual(['t-1', 't-2']);
  });

  it('slice declares all 4 method names', () => {
    const store = createEventTriggersStore(db);
    const slice = makeTriggersHandlers({ store });
    expect(slice?.methods.slice().sort()).toEqual([
      'triggers.create',
      'triggers.delete',
      'triggers.list',
      'triggers.update',
    ]);
  });

  it('enabled recipe-origin rows mint one managed dish and preserve it across disable/re-enable', async () => {
    const store = createEventTriggersStore(db);
    const dishStore = createDishStore(db);
    store.create({
      trigger_id: 't-recipe',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      enabled: false,
      created_at: 1_000,
      origin: 'recipe',
    });

    const enabled = await handleTriggersUpdate(
      { store, dishStore, now: () => 2_000 },
      { trigger_id: 't-recipe', enabled: true },
    );
    const dishId = enabled.trigger.dish_id!;
    expect(dishId.startsWith('dsh_')).toBe(true);
    expect(store.get('t-recipe')?.dish_id).toBe(dishId);
    expect(dishStore.get(dishId)).toMatchObject({
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      name: 'recipe-a',
      enabled: true,
      managed_by_trigger_id: 't-recipe',
    });

    const doubleEnabled = await handleTriggersUpdate(
      { store, dishStore, now: () => 3_000 },
      { trigger_id: 't-recipe', enabled: true },
    );
    expect(doubleEnabled.trigger.dish_id).toBe(dishId);
    expect(dishStore.list().map((d) => d.dish_id)).toEqual([dishId]);

    const disabled = await handleTriggersUpdate(
      { store, dishStore },
      { trigger_id: 't-recipe', enabled: false },
    );
    expect(disabled.trigger.dish_id).toBe(dishId);
    expect(dishStore.get(dishId)?.enabled).toBe(false);

    const reenabled = await handleTriggersUpdate(
      { store, dishStore },
      { trigger_id: 't-recipe', enabled: true },
    );
    expect(reenabled.trigger.dish_id).toBe(dishId);
    expect(dishStore.get(dishId)?.enabled).toBe(true);
    expect(dishStore.list().map((d) => d.dish_id)).toEqual([dishId]);
  });

  it('D-179 — an EMPTY config_overlay does not suppress the P5c standing-dish mint on enable', async () => {
    const store = createEventTriggersStore(db);
    const dishStore = createDishStore(db);
    store.create({
      trigger_id: 't-recipe',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      enabled: false,
      created_at: 1_000,
      origin: 'recipe',
    });
    // Enable + an empty overlay: config provides no dish, so P5c must still
    // mint the standing identity dish (the pre-fix bug enabled with none).
    const res = await handleTriggersUpdate(
      { store, dishStore, now: () => 2_000 },
      { trigger_id: 't-recipe', enabled: true, config_overlay: {} },
    );
    expect(res.trigger.dish_id).toBeDefined();
    expect(dishStore.get(res.trigger.dish_id!)).toMatchObject({
      managed_by_trigger_id: 't-recipe',
    });
  });

  it('D-179 — a NON-EMPTY config_overlay provides the managed dish (supersedes P5c; no double-mint)', async () => {
    const store = createEventTriggersStore(db);
    const dishStore = createDishStore(db);
    store.create({
      trigger_id: 't-recipe',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      enabled: false,
      created_at: 1_000,
      origin: 'recipe',
    });
    const res = await handleTriggersUpdate(
      { store, dishStore, now: () => 2_000 },
      { trigger_id: 't-recipe', enabled: true, config_overlay: { threshold: 30 } },
    );
    expect(dishStore.get(res.trigger.dish_id!)).toMatchObject({
      config_overlay: { threshold: 30 },
      managed_by_trigger_id: 't-recipe',
    });
    expect(dishStore.list()).toHaveLength(1); // P5c did not also mint an empty one
  });

  it('explicit dish_id in an enable patch wins and is binding-validated', async () => {
    const store = createEventTriggersStore(db);
    const dishStore = createDishStore(db);
    dishStore.set({
      dish_id: 'dsh_explicit',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      name: 'explicit',
      is_default: false,
      config_overlay: {},
      enabled: true,
      created_at: 1_000,
    });
    dishStore.set({
      dish_id: 'dsh_other',
      recipe_id: 'recipe-other',
      publisher_id: 'local',
      name: 'other',
      is_default: false,
      config_overlay: {},
      enabled: true,
      created_at: 1_000,
    });
    store.create({
      trigger_id: 't-recipe',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      enabled: false,
      created_at: 1_000,
      origin: 'recipe',
    });

    const enabled = await handleTriggersUpdate(
      { store, dishStore },
      { trigger_id: 't-recipe', enabled: true, dish_id: 'dsh_explicit' },
    );
    expect(enabled.trigger.dish_id).toBe('dsh_explicit');
    expect(dishStore.list().map((d) => d.dish_id).sort()).toEqual([
      'dsh_explicit',
      'dsh_other',
    ]);
    await expect(
      handleTriggersUpdate(
        { store, dishStore },
        { trigger_id: 't-recipe', dish_id: 'dsh_other' },
      ),
    ).rejects.toThrow(/instantiates recipe/);
  });

  it('user-origin rows do not auto-mint dishes when enabled', async () => {
    const store = createEventTriggersStore(db);
    const dishStore = createDishStore(db);
    store.create({
      trigger_id: 't-user',
      recipe_id: 'recipe-a',
      publisher_id: 'local',
      pattern: 'data.mail.**',
      enabled: false,
      created_at: 1_000,
      origin: 'user',
    });

    const enabled = await handleTriggersUpdate(
      { store, dishStore },
      { trigger_id: 't-user', enabled: true },
    );
    expect(enabled.trigger.dish_id).toBeUndefined();
    expect(dishStore.list()).toEqual([]);
  });
});

describe('event triggers — dispatcher', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('rebuild subscribes enabled triggers to the bus', () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn().mockResolvedValue(undefined);

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      now: () => 10_000,
    });
    dispatcher.rebuild();
    expect(dispatcher.activeSubscriptions()).toBe(1);
  });

  it('fires runRecipe on a matching event + records last_fired_at', async () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn().mockResolvedValue(undefined);

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.work.message.created',
      enabled: true,
      dish_id: 'dsh_flag',
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      now: () => 10_000,
    });
    dispatcher.rebuild();

    bus.emit({
      platform: 'email',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'msg-123',
      at: 9_500,
    });

    // Allow microtask flush
    await new Promise((r) => setImmediate(r));
    expect(runRecipe).toHaveBeenCalledOnce();
    const arg = runRecipe.mock.calls[0]![0];
    expect(arg.recipe_id).toBe('r-1');
    expect(arg.dish_id).toBe('dsh_flag');
    expect(arg.trigger_id).toBe('t-1');

    const row = store.get('t-1')!;
    expect(row.last_fired_at).toBe(10_000);
    expect(row.last_error).toBeNull();
  });

  it('captures last_error on failure and keeps the trigger enabled below the cap', async () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    // ⛔ D-268 — A BARE `Error` IS NOW "UNCLASSIFIED", WHICH DISARMS AT THE FIRST
    // FAILURE (fail closed: nobody has decided whether waiting would help). The
    // subject of THIS test is the 24h cap, so it needs a failure that earns the
    // wait — the composition root attaches the run's real code exactly so this
    // distinction reaches here.
    const runRecipe = vi.fn().mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' }),
    );

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      autoDisableAfterErrors24h: 3,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    bus.emit({
      platform: 'email',
      slug: 'a',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'm-1',
      at: 9_000,
    });
    await new Promise((r) => setImmediate(r));

    const row = store.get('t-1')!;
    expect(row.last_error).toBe('boom');
    expect(row.enabled).toBe(true);
  });

  it('auto-disables after the error cap', async () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn().mockRejectedValue(new Error('flaky'));

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      autoDisableAfterErrors24h: 2,
      now: () => 10_000,
    });
    dispatcher.rebuild();

    for (let i = 0; i < 3; i++) {
      bus.emit({
        platform: 'email',
        slug: 'a',
        entity_type: 'message',
        event_kind: 'created',
        record_id: `m-${i}`,
        at: 9_000,
      });
      await new Promise((r) => setImmediate(r));
    }

    const row = store.get('t-1')!;
    expect(row.enabled).toBe(false);
    expect(dispatcher.activeSubscriptions()).toBe(0);
  });

  it('dispose tears down subscriptions', () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn().mockResolvedValue(undefined);

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.**.created',
      enabled: true,
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
    });
    dispatcher.rebuild();
    expect(dispatcher.activeSubscriptions()).toBe(1);
    dispatcher.dispose();
    expect(dispatcher.activeSubscriptions()).toBe(0);
  });

  it('ignores triggers whose pattern path miss', async () => {
    const store = createEventTriggersStore(db);
    const bus = createWarehouseEventBus();
    const runRecipe = vi.fn();

    store.create({
      trigger_id: 't-1',
      recipe_id: 'r-1',
      publisher_id: 'local',
      pattern: 'data.email.work.message.created',
      enabled: true,
      created_at: 1_000,
    });

    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
    });
    dispatcher.rebuild();

    bus.emit({
      platform: 'email',
      slug: 'personal', // ← different slug, doesn't match
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'm-1',
      at: 9_000,
    });
    await new Promise((r) => setImmediate(r));
    expect(runRecipe).not.toHaveBeenCalled();
  });

  it('eventPath helper shape matches the subscriber pattern', () => {
    expect(eventPath('email', 'work', 'message', 'created')).toBe(
      'data.email.work.message.created',
    );
  });

  // Authoring sugar — the per-row dispatch filter gate (design § 3/§ 5):
  // evaluated read-free BEFORE the queue; a missing payload path PASSES
  // (doorbell-shaped reconciler events must not silently kill a
  // filtered row — over-fire beats silent-dead).
  describe('dispatch filter gate (authoring sugar)', () => {
    const seedFiltered = (
      store: ReturnType<typeof createEventTriggersStore>,
      extra: { filter?: Record<string, unknown>; fields?: string[] },
    ) =>
      store.create({
        trigger_id: 't-f',
        recipe_id: 'r-1',
        publisher_id: 'local',
        pattern: 'data.connection.api.hubspot.deal.**.updated',
        enabled: true,
        created_at: 1_000,
        origin: 'recipe',
        ...extra,
      });

    const dealEvent = (over: Partial<import('@recued/warehouse-events').WarehouseEvent> = {}) => ({
      platform: 'connection.api.hubspot.deal',
      slug: 'my-hubspot',
      entity_type: 'deal',
      event_kind: 'updated' as const,
      record_id: 'deal_9',
      at: 9_000,
      ...over,
    });

    it('blocks a fat event whose record value mismatches, fires on match', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      seedFiltered(store, { filter: { 'record.stage': 'negotiation' } });
      const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe } });
      dispatcher.rebuild();

      bus.emit(dealEvent({ record: { stage: 'closed_won' } }));
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).not.toHaveBeenCalled();

      bus.emit(dealEvent({ record: { stage: 'negotiation' } }));
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).toHaveBeenCalledOnce();
    });

    it('PASSES a doorbell-shaped event (no record / changed_fields) through both gates', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      seedFiltered(store, { filter: { 'record.stage': 'negotiation' }, fields: ['stage'] });
      const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe } });
      dispatcher.rebuild();

      bus.emit(dealEvent()); // reconciler-style: record_id + at only
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).toHaveBeenCalledOnce();
    });

    it('fields gate blocks a poll event whose changed_fields miss, and record_id narrowing blocks every source', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      seedFiltered(store, { fields: ['stage'], filter: { record_id: 'deal_9' } });
      const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe } });
      dispatcher.rebuild();

      bus.emit(dealEvent({ changed_fields: ['amount'] }));
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).not.toHaveBeenCalled();

      bus.emit(dealEvent({ changed_fields: ['stage'], record_id: 'deal_8' }));
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).not.toHaveBeenCalled();

      bus.emit(dealEvent({ changed_fields: ['stage', 'amount'] }));
      await new Promise((r) => setImmediate(r));
      expect(runRecipe).toHaveBeenCalledOnce();
    });
  });

  // D-124 Phase 1.3 — prev passthrough on the dispatcher payload.
  describe('prev passthrough (D-124)', () => {
    it('rides through to context.event.payload.prev on updated events', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      store.create({
        trigger_id: 't-1',
        recipe_id: 'r-1',
        publisher_id: 'local',
        pattern: 'data.calendar.work.event.updated',
        enabled: true,
        created_at: 1_000,
      });
      const dispatcher = createEventTriggerDispatcher({
        bus,
        store,
        runtime: { runRecipe },
      });
      dispatcher.rebuild();

      bus.emit({
        platform: 'calendar',
        slug: 'work',
        entity_type: 'event',
        event_kind: 'updated',
        record_id: 'cal:work:evt-1',
        at: 1_700_000_000_000,
        prev: {
          summary: 'Old standup',
          start_at: 1_699_900_000_000,
          attendees: ['a@x.com'],
        },
      });

      await new Promise((r) => setImmediate(r));
      expect(runRecipe).toHaveBeenCalledOnce();
      const arg = runRecipe.mock.calls[0]![0];
      expect(arg.context.event.payload.prev).toEqual({
        summary: 'Old standup',
        start_at: 1_699_900_000_000,
        attendees: ['a@x.com'],
      });
      expect(arg.context.event.payload.record_id).toBe('cal:work:evt-1');
    });

    it('rides through to context.event.payload.prev on deleted events', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      store.create({
        trigger_id: 't-2',
        recipe_id: 'r-2',
        publisher_id: 'local',
        pattern: 'data.calendar.**.deleted',
        enabled: true,
        created_at: 1_000,
      });
      const dispatcher = createEventTriggerDispatcher({
        bus,
        store,
        runtime: { runRecipe },
      });
      dispatcher.rebuild();

      bus.emit({
        platform: 'calendar',
        slug: 'work',
        entity_type: 'event',
        event_kind: 'deleted',
        record_id: 'cal:work:evt-9',
        at: 1_700_000_000_000,
        prev: { summary: 'Cancelled', attendees: ['a@x.com', 'b@y.com'] },
      });

      await new Promise((r) => setImmediate(r));
      const arg = runRecipe.mock.calls[0]![0];
      expect(arg.context.event.payload.prev).toEqual({
        summary: 'Cancelled',
        attendees: ['a@x.com', 'b@y.com'],
      });
    });

    it('omits payload.prev on created events (no key, not undefined)', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      store.create({
        trigger_id: 't-3',
        recipe_id: 'r-3',
        publisher_id: 'local',
        pattern: 'data.email.**.created',
        enabled: true,
        created_at: 1_000,
      });
      const dispatcher = createEventTriggerDispatcher({
        bus,
        store,
        runtime: { runRecipe },
      });
      dispatcher.rebuild();

      bus.emit({
        platform: 'email',
        slug: 'work',
        entity_type: 'message',
        event_kind: 'created',
        record_id: 'msg-1',
        at: 1_700_000_000_000,
      });

      await new Promise((r) => setImmediate(r));
      const arg = runRecipe.mock.calls[0]![0];
      expect(arg.context.event.payload.prev).toBeUndefined();
      expect('prev' in arg.context.event.payload).toBe(false);
    });

    it('omits payload.prev on synced events', async () => {
      const store = createEventTriggersStore(db);
      const bus = createWarehouseEventBus();
      const runRecipe = vi.fn().mockResolvedValue(undefined);
      store.create({
        trigger_id: 't-4',
        recipe_id: 'r-4',
        publisher_id: 'local',
        pattern: 'data.mail.**.synced',
        enabled: true,
        created_at: 1_000,
      });
      const dispatcher = createEventTriggerDispatcher({
        bus,
        store,
        runtime: { runRecipe },
      });
      dispatcher.rebuild();

      bus.emit({
        platform: 'mail',
        slug: 'work',
        entity_type: 'message',
        event_kind: 'synced',
        record_id: '',
        at: 1_700_000_000_000,
      });

      await new Promise((r) => setImmediate(r));
      const arg = runRecipe.mock.calls[0]![0];
      expect('prev' in arg.context.event.payload).toBe(false);
    });
  });
});
