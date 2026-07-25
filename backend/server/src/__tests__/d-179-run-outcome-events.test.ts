/** D-179 P4 — run-outcome bus events. */

// NOTE: execute-handler integration (handler wired into the real HTTP/WS server) is not tested here — no harness exists in the current suite infrastructure.

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  RUN_OUTCOME_PLATFORM,
  createWarehouseEventBus,
  eventPath,
  matchesPattern,
  type WarehouseEvent,
  type WarehouseEventKind,
} from '@recued/warehouse-events';
import {
  emitRunOutcome,
  originTriggerIdFromContext,
} from '../run-outcome-events.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createEventTriggersStore } from '../triggers/store.js';

const flushDispatcher = async (
  dispatcher: ReturnType<typeof createEventTriggerDispatcher>,
): Promise<void> => {
  await dispatcher.drained();
};

const createDispatcherHarness = () => {
  const db = new Database(':memory:');
  const store = createEventTriggersStore(db);
  const bus = createWarehouseEventBus();
  const runRecipe = vi.fn().mockResolvedValue(undefined);
  const dispatcher = createEventTriggerDispatcher({
    bus,
    store,
    runtime: { runRecipe },
    now: () => 10_000,
  });
  return { store, bus, runRecipe, dispatcher };
};

const createTrigger = (
  store: ReturnType<typeof createEventTriggersStore>,
  input: {
    trigger_id: string;
    pattern: string;
    recipe_id?: string;
    dish_id?: string;
  },
) =>
  store.create({
    trigger_id: input.trigger_id,
    recipe_id: input.recipe_id ?? `recipe-${input.trigger_id}`,
    publisher_id: 'local',
    pattern: input.pattern,
    enabled: true,
    dish_id: input.dish_id,
    created_at: 1_000,
  });

const runOutcomeEvent = (
  input: {
    record_id?: string;
    origin_trigger_id?: string;
  } = {},
): WarehouseEvent => ({
  platform: RUN_OUTCOME_PLATFORM,
  slug: 'my-recipe',
  entity_type: 'my-dish',
  event_kind: 'failed',
  record_id: input.record_id ?? 'run-1',
  at: 9_000,
  record: {
    recipe_id: 'my-recipe',
    dish_id: 'my-dish',
    run_id: input.record_id ?? 'run-1',
    outcome: 'failed',
    ...(input.origin_trigger_id !== undefined
      ? { origin_trigger_id: input.origin_trigger_id }
      : {}),
  },
});

describe('packages/warehouse-events — run-outcome paths', () => {
  it('uses the run platform and non-data eventPath shape', () => {
    expect(RUN_OUTCOME_PLATFORM).toBe('run');
    expect(eventPath('run', 'my-recipe', 'my-dish', 'completed')).toBe(
      'run.my-recipe.my-dish.completed',
    );
    expect(eventPath('email', 'work', 'message', 'created')).toBe(
      'data.email.work.message.created',
    );
  });

  it('accepts failed as a WarehouseEventKind', () => {
    const failedKind: WarehouseEventKind = 'failed';
    expect(failedKind).toBe('failed');
  });

  it('matches run-outcome wildcard patterns', () => {
    expect(matchesPattern('run.my-recipe.*.failed', 'run.my-recipe.my-dish.failed')).toBe(true);
    expect(matchesPattern('run.**', 'run.my-recipe.my-dish.completed')).toBe(true);
  });
});

describe('emitRunOutcome', () => {
  it('emits a run WarehouseEvent with outcome record details', () => {
    const emit = vi.fn();
    emitRunOutcome(
      { emit },
      {
        recipe_id: 'recipe-1',
        dish_id: 'dsh-1',
        run_id: 'run-1',
        outcome: 'failed',
        at: 12_345,
        duration_ms: 250,
        error: 'boom',
        origin_trigger_id: 'trigger-1',
      },
    );

    expect(emit).toHaveBeenCalledWith({
      platform: 'run',
      slug: 'recipe-1',
      entity_type: 'dsh-1',
      event_kind: 'failed',
      record_id: 'run-1',
      at: 12_345,
      record: {
        recipe_id: 'recipe-1',
        dish_id: 'dsh-1',
        run_id: 'run-1',
        outcome: 'failed',
        duration_ms: 250,
        error: 'boom',
        origin_trigger_id: 'trigger-1',
      },
    });
  });

  it('omits optional record keys when inputs are undefined', () => {
    const emit = vi.fn();
    emitRunOutcome(
      { emit },
      {
        recipe_id: 'recipe-1',
        dish_id: 'dsh-1',
        run_id: 'run-1',
        outcome: 'completed',
        at: 12_345,
      },
    );

    const event = emit.mock.calls[0]![0] as WarehouseEvent;
    expect(event.record).toEqual({
      recipe_id: 'recipe-1',
      dish_id: 'dsh-1',
      run_id: 'run-1',
      outcome: 'completed',
    });
    expect(event.record).not.toHaveProperty('duration_ms');
    expect(event.record).not.toHaveProperty('error');
    expect(event.record).not.toHaveProperty('origin_trigger_id');
  });

  it('is a no-op without a bus and swallows bus emit errors', () => {
    expect(() =>
      emitRunOutcome(undefined, {
        recipe_id: 'recipe-1',
        dish_id: 'dsh-1',
        run_id: 'run-1',
        outcome: 'completed',
        at: 12_345,
      }),
    ).not.toThrow();

    const emit = vi.fn(() => {
      throw new Error('emit failed');
    });
    expect(() =>
      emitRunOutcome(
        { emit },
        {
          recipe_id: 'recipe-1',
          dish_id: 'dsh-1',
          run_id: 'run-1',
          outcome: 'failed',
          at: 12_345,
        },
      ),
    ).not.toThrow();
  });
});

describe('originTriggerIdFromContext', () => {
  it('returns string context.event.trigger_id', () => {
    expect(originTriggerIdFromContext({ event: { trigger_id: 'trigger-1' } })).toBe(
      'trigger-1',
    );
  });

  it('returns undefined when context.event is missing', () => {
    expect(originTriggerIdFromContext({})).toBeUndefined();
  });

  it('returns undefined for non-object context values', () => {
    expect(originTriggerIdFromContext(null as unknown as Record<string, unknown>)).toBeUndefined();
    expect(originTriggerIdFromContext('ctx' as unknown as Record<string, unknown>)).toBeUndefined();
    expect(originTriggerIdFromContext(42 as unknown as Record<string, unknown>)).toBeUndefined();
  });

  it('returns undefined when trigger_id is not a string', () => {
    expect(originTriggerIdFromContext({ event: { trigger_id: 42 } })).toBeUndefined();
    expect(originTriggerIdFromContext({ event: { trigger_id: { id: 'trigger-1' } } })).toBeUndefined();
  });
});

describe('dispatcher self-loop guard', () => {
  it('does not fire the same run trigger that originated the event', async () => {
    const { store, bus, runRecipe, dispatcher } = createDispatcherHarness();
    createTrigger(store, { trigger_id: 'trigger-self', pattern: 'run.**' });
    dispatcher.rebuild();

    bus.emit(runOutcomeEvent({ origin_trigger_id: 'trigger-self' }));
    await flushDispatcher(dispatcher);

    expect(runRecipe).not.toHaveBeenCalled();
  });

  it('fires a different run trigger subscribed to the same event', async () => {
    const { store, bus, runRecipe, dispatcher } = createDispatcherHarness();
    createTrigger(store, { trigger_id: 'trigger-self', pattern: 'run.**' });
    createTrigger(store, { trigger_id: 'trigger-other', pattern: 'run.**' });
    dispatcher.rebuild();

    bus.emit(runOutcomeEvent({ origin_trigger_id: 'trigger-self' }));
    await flushDispatcher(dispatcher);

    expect(runRecipe).toHaveBeenCalledOnce();
    expect(runRecipe.mock.calls[0]![0].trigger_id).toBe('trigger-other');
  });

  it('fires both run triggers when origin_trigger_id is absent', async () => {
    const { store, bus, runRecipe, dispatcher } = createDispatcherHarness();
    createTrigger(store, { trigger_id: 'trigger-one', pattern: 'run.**' });
    createTrigger(store, { trigger_id: 'trigger-two', pattern: 'run.**' });
    dispatcher.rebuild();

    bus.emit(runOutcomeEvent());
    await flushDispatcher(dispatcher);

    expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(runRecipe.mock.calls.map((call) => call[0].trigger_id).sort()).toEqual([
      'trigger-one',
      'trigger-two',
    ]);
  });

  it('does not over-block ordinary data events', async () => {
    const { store, bus, runRecipe, dispatcher } = createDispatcherHarness();
    createTrigger(store, { trigger_id: 'trigger-data', pattern: 'data.email.**.created' });
    dispatcher.rebuild();

    bus.emit({
      platform: 'email',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'msg-1',
      at: 9_000,
      record: { origin_trigger_id: 'trigger-data' },
    });
    await flushDispatcher(dispatcher);

    expect(runRecipe).toHaveBeenCalledOnce();
    expect(runRecipe.mock.calls[0]![0].trigger_id).toBe('trigger-data');
  });
});

describe('end-to-end run-outcome bus round-trip', () => {
  it('delivers failed run outcomes to matching subscribers only', () => {
    const bus = createWarehouseEventBus();
    const received: WarehouseEvent[] = [];
    bus.subscribe('run.my-recipe.*.failed', (event) => {
      received.push(event);
    });

    emitRunOutcome(bus, {
      recipe_id: 'my-recipe',
      dish_id: 'my-dish',
      run_id: 'run-failed',
      outcome: 'failed',
      at: 1_000,
      error: 'boom',
    });
    emitRunOutcome(bus, {
      recipe_id: 'my-recipe',
      dish_id: 'my-dish',
      run_id: 'run-completed',
      outcome: 'completed',
      at: 2_000,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.event_kind).toBe('failed');
    expect(received[0]?.record_id).toBe('run-failed');
  });
});
