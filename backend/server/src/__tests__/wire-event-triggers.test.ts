import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import {
  composeEventTriggers,
  type ComposeEventTriggersInput,
} from '../composition/bin/wire-event-triggers.js';
import { handleExecute } from '../execute-handler.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';

vi.mock('../execute-handler.js', () => ({
  handleExecute: vi.fn(),
}));

type Subscription = {
  pattern: string;
  handler: (event: WarehouseEvent) => void;
};

const okResult = {
  recipe_id: 'r1',
  recipe_hash: 'hash',
  success: true,
  output: { sidebar: [] },
  errors: [],
  steps: [],
  duration_ms: 1,
  validation_issues: [],
};

const makeBus = (handlers: Subscription[]): WarehouseEventBus => ({
  subscribe: vi.fn((pattern: string, handler: (event: WarehouseEvent) => void) => {
    handlers.push({ pattern, handler });
    return () => {};
  }),
} as unknown as WarehouseEventBus);

const makeEvent = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'webhook',
  slug: 'work',
  entity_type: 'message',
  event_kind: 'created',
  record_id: 'm1',
  at: 123,
  ...overrides,
});

const seedTrigger = (
  store: EventTriggersStore,
  patch: {
    trigger_id?: string;
    recipe_id?: string;
    pattern?: string;
    dish_id?: string | null;
  } = {},
) => store.create({
  trigger_id: patch.trigger_id ?? 't-1',
  recipe_id: patch.recipe_id ?? 'r1',
  publisher_id: 'p',
  pattern: patch.pattern ?? 'data.webhook.**',
  enabled: true,
  dish_id: patch.dish_id ?? null,
  created_at: 1,
});

describe('composeEventTriggers', () => {
  let db: Database.Database;
  let store: EventTriggersStore;
  let handlers: Subscription[];
  let warehouseBus: WarehouseEventBus;
  let eventBus: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = new Database(':memory:');
    store = createEventTriggersStore(db);
    handlers = [];
    warehouseBus = makeBus(handlers);
    eventBus = { emit: vi.fn() };
    vi.mocked(handleExecute).mockReset();
    vi.mocked(handleExecute).mockResolvedValue(okResult as never);
  });

  afterEach(() => {
    db.close();
  });

  const compose = (overrides: Partial<ComposeEventTriggersInput> = {}) =>
    composeEventTriggers({
      db,
      warehouseBus,
      // The G6 boot reconcile reads `recipeStore.listStored()` (a
      // REQUIRED ExecuteHandlerDeps field in production); everything
      // else this harness exercises goes through the mocked
      // `handleExecute`.
      executeDeps: { recipeStore: { listStored: () => [] } } as never,
      auditLog: undefined,
      eventBus: eventBus as unknown as ComposeEventTriggersInput['eventBus'],
      localManifestStore: undefined,
      ...overrides,
    });

  it('returns undefined when db is unavailable', () => {
    expect(compose({ db: undefined })).toBeUndefined();
    expect(warehouseBus.subscribe).not.toHaveBeenCalled();
  });

  it('subscribes enabled trigger patterns from the real store on compose', () => {
    seedTrigger(store, { pattern: 'mail.**' });

    compose();

    expect(warehouseBus.subscribe).toHaveBeenCalledWith('mail.**', expect.any(Function));
  });

  it('dispatches matching events through handleExecute with reactive execution metadata', async () => {
    seedTrigger(store, {});
    const bundle = compose()!;

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(handleExecute).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(handleExecute).mock.calls[0]!;
    expect(request).toMatchObject({
      recipe_id: 'r1',
      trigger_source: 'event_trigger',
      execution_source: {
        channel: 'reactive',
        actor: 'system',
        source_recipe: 'r1',
        event_kind: 'data.webhook.work.message.created',
      },
      context: {
        event: {
          topic: ['data', 'webhook', 'work', 'message', 'created'],
          kind: 'created',
          payload: {
            record_id: 'm1',
            at: 123,
            platform: 'webhook',
            slug: 'work',
            entity_type: 'message',
          },
          trigger_id: 't-1',
        },
      },
    });
    expect(request).not.toHaveProperty('config');
  });

  it('treats trigger-gate skips as non-errors and keeps the trigger enabled', async () => {
    vi.mocked(handleExecute).mockResolvedValueOnce({
      ...okResult,
      success: false,
      trigger_skipped: true,
      errors: [{ message: 'skip' }],
    } as never);
    seedTrigger(store);
    const bundle = compose()!;

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(store.get('t-1')).toMatchObject({
      enabled: true,
      last_error: null,
    });
  });

  it('stores the first execution error message on failure', async () => {
    vi.mocked(handleExecute).mockResolvedValueOnce({
      ...okResult,
      success: false,
      errors: [{ message: 'boom' }],
      steps: [],
      duration_ms: 0,
    } as never);
    seedTrigger(store);
    const bundle = compose()!;

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(store.get('t-1')).toMatchObject({
      enabled: true,
      last_error: 'boom',
    });
  });

  it('emits reactive_fire for successful, skipped, and failed dispatches', async () => {
    vi.mocked(handleExecute)
      .mockResolvedValueOnce(okResult as never)
      .mockResolvedValueOnce({
        ...okResult,
        success: false,
        trigger_skipped: true,
        errors: [{ message: 'skip' }],
      } as never)
      .mockResolvedValueOnce({
        ...okResult,
        success: false,
        errors: [{ message: 'boom' }],
      } as never);
    seedTrigger(store);
    const bundle = compose()!;

    handlers[0]!.handler(makeEvent({ record_id: 'm1' }));
    handlers[0]!.handler(makeEvent({ record_id: 'm2' }));
    handlers[0]!.handler(makeEvent({ record_id: 'm3' }));
    await bundle.dispatcher.drained();

    expect(eventBus.emit).toHaveBeenCalledTimes(3);
    expect(eventBus.emit).toHaveBeenNthCalledWith(1, {
      kind: 'reactive_fire',
      recipe_id: 'r1',
    });
    expect(eventBus.emit).toHaveBeenNthCalledWith(2, {
      kind: 'reactive_fire',
      recipe_id: 'r1',
    });
    expect(eventBus.emit).toHaveBeenNthCalledWith(3, {
      kind: 'reactive_fire',
      recipe_id: 'r1',
    });
  });

  it('returns trigger deps carrying the live store, dispatcher, and event bus', () => {
    const bundle = compose()!;

    expect(bundle.triggersDeps.store).toBeDefined();
    expect(bundle.triggersDeps.dispatcher).toBe(bundle.dispatcher);
    expect(bundle.triggersDeps.eventBus).toBe(eventBus);
  });

  // ── D-179 P2 — dish-bound triggers ─────────────────────────────

  const composeWithDish = (dish: { enabled: boolean } | null) =>
    compose({
      executeDeps: {
        recipeStore: { listStored: () => [] },
        dishStore: { get: () => (dish ? { dish_id: 'dsh_x', enabled: dish.enabled } : null) },
      } as never,
    })!;

  it('threads the trigger dish_id onto the handleExecute request (overlay resolves inside)', async () => {
    seedTrigger(store, { dish_id: 'dsh_x' });
    const bundle = composeWithDish({ enabled: true });

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(handleExecute).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(handleExecute).mock.calls[0]!;
    expect(request).toMatchObject({ dish_id: 'dsh_x' });
    expect(request).not.toHaveProperty('config');
  });

  it('SKIPS the fire silently when the bound dish is disabled (trigger stays armed, no error)', async () => {
    seedTrigger(store, { dish_id: 'dsh_x' });
    const bundle = composeWithDish({ enabled: false });

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(handleExecute).not.toHaveBeenCalled();
    const row = store.get('t-1')!;
    expect(row.enabled).toBe(true);
    expect(row.last_error).toBeNull();
  });

  it('SKIPS the fire silently when the bound dish no longer exists', async () => {
    seedTrigger(store, { dish_id: 'dsh_x' });
    const bundle = composeWithDish(null);

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(handleExecute).not.toHaveBeenCalled();
    expect(store.get('t-1')!.enabled).toBe(true);
  });

  it('dispatches dishless when no dish store is wired (best-effort degradation)', async () => {
    seedTrigger(store, { dish_id: 'dsh_x' });
    const bundle = compose()!; // executeDeps without dishStore

    handlers[0]!.handler(makeEvent());
    await bundle.dispatcher.drained();

    expect(handleExecute).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(handleExecute).mock.calls[0]!;
    expect(request).toMatchObject({ dish_id: 'dsh_x' });
  });
});
