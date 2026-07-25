/** R20 (Option A) — pending chat-plans store unit test.
 *
 *  The store is a webclient-local aggregator over the per-pair bus: it
 *  accumulates `chat.plan_proposed` frames and drops them on
 *  `chat.plan_resolved`, with no durability (live-session only — by design).
 */

import { describe, expect, it } from 'vitest';

import { createPendingChatPlansStore } from '../approvals/pending-chat-plans-store.js';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';

const makeFakeSubscriber = () => {
  const byKind = new Map<string, Set<(e: unknown) => void>>();
  let unsubCount = 0;
  const on = (kind: string, listener: (e: unknown) => void): (() => void) => {
    const set = byKind.get(kind) ?? new Set();
    set.add(listener);
    byKind.set(kind, set);
    return () => {
      unsubCount += 1;
      set.delete(listener);
    };
  };
  return {
    on: on as unknown as BroadcastSubscriber['on'],
    fire: (kind: string, event: unknown): void => {
      for (const fn of [...(byKind.get(kind) ?? [])]) fn(event);
    },
    count: (kind: string): number => byKind.get(kind)?.size ?? 0,
    unsubCount: (): number => unsubCount,
  };
};

const proposed = (plan_id: string): unknown => ({
  kind: 'chat.plan_proposed',
  session_id: 's1',
  turn_id: 't1',
  plan_id,
  tool: 'mail-send',
  tier: 2,
  args: { to: 'a@b.com' },
  cursor: 1,
});

const resolved = (plan_id: string): unknown => ({
  kind: 'chat.plan_resolved',
  session_id: 's1',
  turn_id: 't1',
  plan: {
    plan_id,
    session_id: 's1',
    turn_id: 't1',
    tool: 'mail-send',
    tier: 2,
    classification: 'write',
    args: {},
  },
  cursor: 2,
});

describe('R20 — pending chat-plans store', () => {
  it('accumulates proposed plans + stamps proposed_at; notifies on add', () => {
    let clock = 1000;
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({ subscribe: sub.on, now: () => clock });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.list()).toEqual([]);

    sub.fire('chat.plan_proposed', proposed('p1'));
    expect(notified).toBe(1);
    expect(store.list().map((p) => p.plan_id)).toEqual(['p1']);
    expect(store.list()[0]!.proposed_at).toBe(1000);
    expect(store.list()[0]!.tool).toBe('mail-send');
    expect(store.list()[0]!.tier).toBe(2);

    clock = 2000;
    sub.fire('chat.plan_proposed', proposed('p2'));
    expect(store.list().map((p) => p.plan_id)).toEqual(['p1', 'p2']);
    expect(store.list()[1]!.proposed_at).toBe(2000);
    store.dispose();
  });

  it('drops a plan on chat.plan_resolved (by plan.plan_id); no-op + no notify on unknown', () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({ subscribe: sub.on });
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    sub.fire('chat.plan_proposed', proposed('p1'));
    sub.fire('chat.plan_proposed', proposed('p2'));
    notified = 0;

    sub.fire('chat.plan_resolved', resolved('p1'));
    expect(notified).toBe(1);
    expect(store.list().map((p) => p.plan_id)).toEqual(['p2']);

    sub.fire('chat.plan_resolved', resolved('unknown'));
    expect(notified).toBe(1); // no change → no notify
    store.dispose();
  });

  it('dispose unsubscribes from the bus + clears state; later frames ignored', () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({ subscribe: sub.on });
    expect(sub.count('chat.plan_proposed')).toBe(1);
    expect(sub.count('chat.plan_resolved')).toBe(1);
    sub.fire('chat.plan_proposed', proposed('p1'));
    expect(store.list()).toHaveLength(1);

    store.dispose();
    expect(sub.unsubCount()).toBe(2);
    expect(store.list()).toEqual([]);
    sub.fire('chat.plan_proposed', proposed('p2'));
    expect(store.list()).toEqual([]);
  });

  it('a listener unsubscribe is honored', () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({ subscribe: sub.on });
    let notified = 0;
    const off = store.subscribe(() => {
      notified += 1;
    });
    sub.fire('chat.plan_proposed', proposed('p1'));
    expect(notified).toBe(1);
    off();
    sub.fire('chat.plan_proposed', proposed('p2'));
    expect(notified).toBe(1);
    store.dispose();
  });
});
