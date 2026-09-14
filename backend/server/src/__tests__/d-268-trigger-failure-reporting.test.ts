/** D-268 — the event-trigger path.
 *
 *  This path already had an auto-disable (a 24h error cap) and already wrote
 *  `last_error`. What it had was a COUNT with no KIND and no way to tell the
 *  owner. Two consequences fall out of adding the kind, and both are tested
 *  here because both would ship silently:
 *
 *   1. a failure whose class says waiting buys nothing disarms at once;
 *   2. ⛔ a `conditional` code — a tripped guard — must not move the counter at
 *      all, or a trigger that is WORKING switches itself off after `errorCap`
 *      correct evaluations. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { NotificationMessage } from '@recued/notification';

import { createEventTriggersStore } from '../triggers/store.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
});

const EVENT = {
  platform: 'email', slug: 'work', entity_type: 'message',
  event_kind: 'created', record_id: 'msg-1', at: 9_500,
} as const;

const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });

const mk = (runRecipe: ReturnType<typeof vi.fn>, errorCap = 10) => {
  const store = createEventTriggersStore(db);
  const bus = createWarehouseEventBus();
  const notices: NotificationMessage[] = [];
  store.create({
    trigger_id: 't-1', recipe_id: 'r-1', publisher_id: 'local',
    pattern: 'data.email.work.message.created', enabled: true, created_at: 1_000,
  } as never);
  const dispatcher = createEventTriggerDispatcher({
    bus, store, runtime: { runRecipe }, now: () => 10_000,
    autoDisableAfterErrors24h: errorCap,
    onAutomationFailure: (notice: NotificationMessage) => { notices.push(notice); },
  } as never);
  dispatcher.rebuild();
  const fire = async (times = 1): Promise<void> => {
    for (let i = 0; i < times; i++) {
      bus.emit({ ...EVENT, record_id: `msg-${i}` } as never);
      await flush();
    }
  };
  return { store, notices, fire };
};

/** An error the way the composition root now raises one — carrying its code. */
const coded = (code: string): Error & { code: string } =>
  Object.assign(new Error('Provider said no.'), { code });

describe('D-268 trigger failure reporting', () => {
  it('a transient fault notifies once and stays armed below the cap', async () => {
    const { store, notices, fire } = mk(vi.fn().mockRejectedValue(coded('NETWORK_ERROR')));
    await fire(3);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed']);
    expect(store.get('t-1')!.enabled).toBe(true);
    expect(store.get('t-1')!.last_error).toBe('Provider said no.');
  });

  it('a transient fault disarms at the cap, with the stopped notice', async () => {
    const { store, notices, fire } = mk(vi.fn().mockRejectedValue(coded('NETWORK_ERROR')), 3);
    await fire(5);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed', 'r-1 has stopped']);
    expect(store.get('t-1')!.enabled).toBe(false);
  });

  it('⛔ a credential fault disarms on the FIRST failure — waiting cannot fix it', async () => {
    const { store, notices, fire } = mk(vi.fn().mockRejectedValue(coded('OAUTH_REVOKED')));
    await fire(1);
    expect(notices.map((n) => n.title)).toEqual(['r-1 has stopped']);
    expect(store.get('t-1')!.enabled).toBe(false);
  });

  it('⛔⛔ A TRIPPED GUARD IS NOT A FAILURE — it moves no counter and writes no error', async () => {
    // Without this, `errorCap` correct guard evaluations disarm a trigger that
    // is doing exactly what it was written to do.
    const { store, notices, fire } = mk(
      vi.fn().mockRejectedValue(coded('RECIPE_GUARD_TRIGGERED')), 3,
    );
    await fire(10);
    expect(notices).toEqual([]);
    const row = store.get('t-1')!;
    expect(row.enabled).toBe(true);
    // The named cause: the row records the fire and NO error, because the run
    // did not fail — not because the dispatcher skipped it.
    expect(row.last_error).toBeNull();
    expect(row.last_fired_at).toBe(10_000);
  });

  it('⛔⛔ AND THE GUARD MUST NOT LEAK INTO THE COUNTER — only a MIXED sequence can see it', async () => {
    // The single-kind test above passes whether or not the guard's append is
    // undone, because the `not_a_failure` branch returns before anything reads
    // the count. The leak is observable ONLY when a real failure arrives after
    // some guards: with the leak, three correct guard evaluations put a cap-3
    // trigger one failure from the edge, so the very first transient blip
    // disarms it. That is a working trigger switched off by its own guards.
    const runRecipe = vi.fn()
      .mockRejectedValueOnce(coded('RECIPE_GUARD_TRIGGERED'))
      .mockRejectedValueOnce(coded('RECIPE_GUARD_TRIGGERED'))
      .mockRejectedValueOnce(coded('RECIPE_GUARD_TRIGGERED'))
      .mockRejectedValueOnce(coded('NETWORK_ERROR'));
    const { store, notices, fire } = mk(runRecipe, 3);
    await fire(4);
    expect(store.get('t-1')!.enabled).toBe(true);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed']);
  });

  it('an unclassified failure fails closed — a raw Error carries no code', async () => {
    const { store, notices, fire } = mk(vi.fn().mockRejectedValue(new Error('boom')));
    await fire(1);
    expect(notices.map((n) => n.title)).toEqual(['r-1 has stopped']);
    expect(store.get('t-1')!.enabled).toBe(false);
  });

  it('⛔ total refusal — a run reporting success that produced nothing', async () => {
    const { store, notices, fire } = mk(vi.fn().mockResolvedValue({ total_refusal: true }));
    await fire(1);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed']);
    const row = store.get('t-1')!;
    // It counts, and it leaves the row's error alone: the run DID complete.
    expect(row.enabled).toBe(true);
    expect(row.last_error).toBeNull();
    expect(row.last_fired_at).toBe(10_000);
  });

  it('repeated total refusals disarm at the cap', async () => {
    const { store, notices, fire } = mk(vi.fn().mockResolvedValue({ total_refusal: true }), 3);
    await fire(4);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed', 'r-1 has stopped']);
    expect(store.get('t-1')!.enabled).toBe(false);
  });

  it('a skipped fire is untouched by any of it', async () => {
    const { store, notices, fire } = mk(vi.fn().mockResolvedValue({ skipped: true }));
    await fire(3);
    expect(notices).toEqual([]);
    expect(store.get('t-1')!.enabled).toBe(true);
    expect(store.get('t-1')!.last_fired_at).toBeNull();
  });

  it('a success clears the episode so the next failure notifies again', async () => {
    const runRecipe = vi.fn()
      .mockRejectedValueOnce(coded('NETWORK_ERROR'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(coded('NETWORK_ERROR'));
    const { notices, fire } = mk(runRecipe);
    await fire(3);
    expect(notices.map((n) => n.title)).toEqual(['r-1 failed', 'r-1 failed']);
  });
});
