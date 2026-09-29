/** D-315 — the trigger queue and a mail fact's events.
 *
 *  A mail fact's event is ONE email's news about a thing: the queue keeps each
 *  one, with its email and its origin, instead of merging it into the tail as
 *  it does a record's rapid edits — merged, a live email would run as a
 *  backfill (or the reverse) and the run would link only the last email. And a
 *  producer that can wait (a backfill that runs recipes) waits for room rather
 *  than have its events refused at the queue's ceiling. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { MAIL_FACT_EVENT_PLATFORM, type EventTrigger } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { createHeldMailFactEvents } from '../mail-facts/held-events.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createEventTriggersStore } from '../triggers/store.js';

import {
  createTriggerDispatchQueue,
  queueKey,
  TRIGGER_QUEUE_MAX_DEPTH_PER_KEY,
  TRIGGER_QUEUE_PRODUCER_DEPTH,
  TRIGGER_QUEUE_PRODUCER_KEYS,
} from '../triggers/queue.js';

const trigger: EventTrigger = {
  trigger_id: 't-1',
  recipe_id: 'r-1',
  publisher_id: 'local',
  pattern: 'data.mail_fact.shipment.thing.*',
  enabled: true,
  origin: 'user',
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
};

const factEvent = (at: number, email: string, origin?: 'backfill'): WarehouseEvent => ({
  platform: MAIL_FACT_EVENT_PLATFORM,
  slug: 'shipment',
  entity_type: 'thing',
  event_kind: 'updated',
  record_id: 'thing-1',
  at,
  record: { fact: { email: { record_id: email } }, state: 'in_transit' },
  prev: { state: at === 1 ? null : 'in_transit' },
  changed_fields: ['last_email_at'],
  ...(origin !== undefined ? { origin } : {}),
});

const defer = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('D-315 — the trigger queue keeps each email about a thing', () => {
  it('runs every email, each with its own origin and email, where a record’s edits merge', async () => {
    const held = defer();
    const seen: WarehouseEvent[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: async (_trigger, event) => {
        seen.push(event);
        if (event.at === 1) await held.promise;
      },
    });
    queue.enqueue(trigger, factEvent(1, 'm-1'));
    queue.enqueue(trigger, factEvent(2, 'm-2', 'backfill'));
    queue.enqueue(trigger, factEvent(3, 'm-3'));
    queue.enqueue(trigger, factEvent(4, 'm-4', 'backfill'));
    await flush();
    expect(queue.size(queueKey('t-1', 'thing-1'))).toBe(4);

    held.resolve();
    await queue.drained();
    expect(seen.map((event) => [event.at, (event.record as { fact: { email: { record_id: string } } }).fact.email.record_id, event.origin ?? 'live']))
      .toEqual([[1, 'm-1', 'live'], [2, 'm-2', 'backfill'], [3, 'm-3', 'live'], [4, 'm-4', 'backfill']]);
    // Each keeps its own prev: none was merged into another's.
    expect(seen.map((event) => (event.prev as { state: string | null }).state)).toEqual([null, 'in_transit', 'in_transit', 'in_transit']);
  });

  it('still merges a record’s rapid edits at the tail', async () => {
    const held = defer();
    const seen: number[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: async (_trigger, event) => {
        seen.push(event.at);
        if (event.at === 1) await held.promise;
      },
    });
    for (const at of [1, 2, 3, 4]) {
      queue.enqueue({ ...trigger, pattern: 'data.mail.**.updated' }, {
        platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'updated', record_id: 'thing-1', at,
      });
    }
    await flush();
    expect(queue.size(queueKey('t-1', 'thing-1'))).toBe(TRIGGER_QUEUE_MAX_DEPTH_PER_KEY);
    held.resolve();
    await queue.drained();
    expect(seen).toEqual([1, 4]);
  });

  it('keeps every email about one thing, however many: each was announced once', async () => {
    const held = defer();
    const seen: number[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: async (_trigger, event) => {
        seen.push(event.at);
        if (event.at === 1) await held.promise;
      },
    });
    for (let at = 1; at <= 100; at += 1) queue.enqueue(trigger, factEvent(at, `m-${at}`));
    await flush();
    expect(queue.size(queueKey('t-1', 'thing-1'))).toBe(100);
    held.resolve();
    await queue.drained();
    expect(seen).toEqual(Array.from({ length: 100 }, (_, n) => n + 1));
  });

  it('never refuses a mail fact’s event at the ceiling, where it refuses any other', async () => {
    const held = defer();
    const queue = createTriggerDispatchQueue({ maxKeys: 4, processEvent: async () => { await held.promise; } });
    // One email's fan-out: ten things.
    for (let n = 1; n <= 10; n += 1) expect(queue.enqueue(trigger, { ...factEvent(n, 'm-1'), record_id: `thing-${n}` })).toBe(true);
    expect(queue.activeKeys()).toBe(10);
    expect(queue.enqueue({ ...trigger, pattern: 'data.mail.**.created' }, {
      platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id: 'mail:1', at: 1,
    })).toBe(false);
    expect(queue.droppedEvents()).toBe(1);
    held.resolve();
    await queue.drained();
  });
});

describe('D-315 — a producer that can wait waits for room', () => {
  it('room() resolves at once below the mark and only once keys drain at it', async () => {
    const held = new Map<string, ReturnType<typeof defer>>();
    const queue = createTriggerDispatchQueue({
      maxConcurrentKeys: 1,
      processEvent: async (_trigger, event) => {
        const gate = defer();
        held.set(event.record_id, gate);
        await gate.promise;
      },
    });
    let ready = false;
    await queue.room(2);
    queue.enqueue(trigger, factEvent(1, 'm-1'));
    queue.enqueue(trigger, { ...factEvent(2, 'm-2'), record_id: 'thing-2' });
    const room = queue.room(2).then(() => { ready = true; });
    await flush();
    expect(ready).toBe(false);

    held.get('thing-1')!.resolve();
    await room;
    expect(ready).toBe(true);
    expect(queue.activeKeys()).toBe(1);

    await flush();
    held.get('thing-2')!.resolve();
    await queue.drained();
  });

  it('room() waits while a key is as deep as a producer may make it, and wakes as its recipe catches up', async () => {
    const gates: (() => void)[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: () => new Promise<void>((resolve) => { gates.push(resolve); }),
    });
    for (let at = 1; at <= TRIGGER_QUEUE_PRODUCER_DEPTH; at += 1) queue.enqueue(trigger, factEvent(at, `m-${at}`));
    let ready = false;
    const room = queue.room(TRIGGER_QUEUE_PRODUCER_KEYS, TRIGGER_QUEUE_PRODUCER_DEPTH).then(() => { ready = true; });
    await flush();
    // One key, far below the key mark — but as deep as the depth mark.
    expect(ready).toBe(false);
    // Its recipe finishes one run: the key is one shallower.
    gates.shift()!();
    await room;
    expect(ready).toBe(true);
    while (gates.length > 0 || queue.activeKeys() > 0) {
      gates.shift()?.();
      await flush();
    }
    await queue.drained();
  });
});

describe('D-315 — a producer that can wait waits for a sealed vault to open', () => {
  it('room() stays shut while the vault is locked: every fire would be dropped then', async () => {
    const db = new Database(':memory:');
    let unlocked = false;
    const dispatcher = createEventTriggerDispatcher({
      bus: createWarehouseEventBus(),
      store: createEventTriggersStore(db),
      runtime: { runRecipe: async () => undefined },
      isVaultUnlocked: () => unlocked,
      vaultPollMs: 5,
    });
    let ready = false;
    const room = dispatcher.room().then(() => { ready = true; });
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(ready).toBe(false);
    unlocked = true;
    await room;
    expect(ready).toBe(true);
    db.close();
  });

  const sealable = (runRecipe: () => Promise<{ run_id: string }>, captureTrigger?: (...args: unknown[]) => object | null) => {
    const db = new Database(':memory:');
    const store = createEventTriggersStore(db);
    store.create({ ...trigger, trigger_id: 't-fact', recipe_id: 'r-fact' } as never);
    store.create({ ...trigger, trigger_id: 't-mail', recipe_id: 'r-mail', pattern: 'data.mail.**.created' } as never);
    const bus = createWarehouseEventBus();
    const vault = { unlocked: true };
    const dispatcher = createEventTriggerDispatcher({
      bus, store, runtime: { runRecipe }, isVaultUnlocked: () => vault.unlocked, vaultPollMs: 5,
      // The owned preapproval driver: each fire is captured as it is queued.
      ...(captureTrigger !== undefined ? { getPreapprovalDriver: () => ({ captureTrigger }) as never } : {}),
    });
    dispatcher.rebuild();
    const mailEvent = (record_id: string): WarehouseEvent => ({
      platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id, at: 1,
    });
    return { db, bus, vault, dispatcher, mailEvent };
  };

  it('a mail fact’s fire queued before the vault sealed waits for it: its fact announces once', async () => {
    const runRecipe = vi.fn(async () => ({ run_id: 'run-1' }));
    const { db, bus, vault, dispatcher, mailEvent } = sealable(runRecipe);
    vault.unlocked = false;
    // A change of state: a change of the time alone wakes no row (ruling 44).
    bus.emit({ ...factEvent(1, 'm-1'), changed_fields: ['state'] });
    bus.emit(mailEvent('mail:1'));
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(runRecipe).not.toHaveBeenCalled();
    vault.unlocked = true;
    await dispatcher.drained();
    // The fact's recipe ran once the vault opened; the mail event was dropped,
    // as every other event is while the vault is sealed.
    expect(runRecipe.mock.calls.map((call) => (call as unknown as [{ recipe_id: string }])[0].recipe_id)).toEqual(['r-fact']);
    db.close();
  });

  it('with preapproval, a mail fact’s event that came while the vault was sealed is captured once it opens, and runs', async () => {
    const runRecipe = vi.fn(async () => ({ run_id: 'run-1' }));
    const captureTrigger = vi.fn(() => ({ kind: 'candidate' }));
    const { db, bus, vault, dispatcher, mailEvent } = sealable(runRecipe, captureTrigger);
    vault.unlocked = false;
    bus.emit({ ...factEvent(1, 'm-1'), changed_fields: ['state'] });
    bus.emit(mailEvent('mail:1'));
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(captureTrigger).not.toHaveBeenCalled();
    expect(runRecipe).not.toHaveBeenCalled();
    vault.unlocked = true;
    await dispatcher.drained();
    // The fact's fire, captured and run; the mail event dropped as it came.
    expect(captureTrigger).toHaveBeenCalledTimes(1);
    expect(runRecipe.mock.calls.map((call) => (call as unknown as [{ recipe_id: string }])[0].recipe_id)).toEqual(['r-fact']);
    db.close();
  });

  it('with preapproval, mail facts’ events held while sealed go in the order they came — one that comes as it opens, behind them', async () => {
    const runRecipe = vi.fn(async () => ({ run_id: 'run' }));
    const captureTrigger = vi.fn((..._args: unknown[]) => ({ kind: 'candidate' }));
    const { db, bus, vault, dispatcher } = sealable(runRecipe, captureTrigger);
    vault.unlocked = false;
    bus.emit({ ...factEvent(1, 'm-1'), changed_fields: ['state'] });
    bus.emit({ ...factEvent(2, 'm-2'), changed_fields: ['state'] });
    vault.unlocked = true;
    // Before the dispatcher looks at the vault again.
    bus.emit({ ...factEvent(3, 'm-3'), changed_fields: ['state'] });
    await dispatcher.drained();
    expect(captureTrigger.mock.calls.map((call) => (call[1] as WarehouseEvent).at)).toEqual([1, 2, 3]);
    expect(runRecipe).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('with preapproval, a capture that throws as the vault opens stops none of the others held', async () => {
    const runRecipe = vi.fn(async () => ({ run_id: 'run' }));
    let captures = 0;
    const captureTrigger = vi.fn((..._args: unknown[]) => {
      captures += 1;
      if (captures === 1) throw new Error('capture failed');
      return { kind: 'candidate' };
    });
    const { db, bus, vault, dispatcher } = sealable(runRecipe, captureTrigger);
    vault.unlocked = false;
    bus.emit({ ...factEvent(1, 'm-1'), changed_fields: ['state'] });
    bus.emit({ ...factEvent(2, 'm-2'), changed_fields: ['state'] });
    vault.unlocked = true;
    await dispatcher.drained();
    expect(captureTrigger).toHaveBeenCalledTimes(2);
    expect(runRecipe).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('with preapproval, disposed while the vault is sealed, it releases nothing it held', async () => {
    const runRecipe = vi.fn(async () => ({ run_id: 'run-1' }));
    const captureTrigger = vi.fn(() => ({ kind: 'candidate' }));
    const { db, bus, vault, dispatcher } = sealable(runRecipe, captureTrigger);
    vault.unlocked = false;
    bus.emit({ ...factEvent(1, 'm-1'), changed_fields: ['state'] });
    dispatcher.dispose();
    vault.unlocked = true;
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(captureTrigger).not.toHaveBeenCalled();
    expect(runRecipe).not.toHaveBeenCalled();
    db.close();
  });

  it('room() looks at the vault again once the queue has room: sealed meanwhile, it stays shut', async () => {
    const running = defer();
    const runRecipe = vi.fn(async () => { await running.promise; return { run_id: 'run-1' }; });
    const { db, bus, vault, dispatcher, mailEvent } = sealable(runRecipe);
    for (let at = 0; at < TRIGGER_QUEUE_PRODUCER_KEYS; at += 1) bus.emit(mailEvent(`mail:${at}`));
    let ready = false;
    const room = dispatcher.room().then(() => { ready = true; });
    await flush();
    expect(ready).toBe(false);
    // Sealed while the producer waits for the queue, which then drains.
    vault.unlocked = false;
    running.resolve();
    await dispatcher.drained();
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(ready).toBe(false);
    vault.unlocked = true;
    await room;
    expect(ready).toBe(true);
    db.close();
  });
});

describe('D-315 — a fact’s events wait until a trigger can hear them (§5)', () => {
  it('holds them until opened, then sends them in order, each once the queue has room', async () => {
    const sent: number[] = [];
    const events = createHeldMailFactEvents((event) => { sent.push(event.at); });
    events.emit(factEvent(1, 'm-1'));
    events.emit(factEvent(2, 'm-2'));
    expect(sent).toEqual([]);

    const gates: (() => void)[] = [];
    const room = vi.fn(() => new Promise<void>((resolve) => { gates.push(resolve); }));
    const opened = events.open(room);
    await flush();
    expect(sent).toEqual([]);
    gates.shift()!();
    await flush();
    expect(sent).toEqual([1]);
    // One that comes while they go out waits behind them.
    events.emit(factEvent(3, 'm-3'));
    gates.shift()!();
    await flush();
    expect(sent).toEqual([1, 2]);
    gates.shift()!();
    await opened;
    expect(sent).toEqual([1, 2, 3]);
    expect(room).toHaveBeenCalledTimes(3);

    // Open, they go straight out; opening again changes nothing.
    events.emit(factEvent(4, 'm-4'));
    expect(sent).toEqual([1, 2, 3, 4]);
    await events.open(room);
    expect(room).toHaveBeenCalledTimes(3);
  });

  it('sends the rest when one cannot be sent', async () => {
    const sent: number[] = [];
    const warn = vi.fn();
    const events = createHeldMailFactEvents((event) => {
      if (event.at === 1) throw new Error('a subscriber broke');
      sent.push(event.at);
    }, { warn });
    events.emit(factEvent(1, 'm-1'));
    events.emit(factEvent(2, 'm-2'));
    await events.open();
    expect(sent).toEqual([2]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
