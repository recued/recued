/** Durable all-session pending Chat-plan recovery store.
 *
 * The adversarial cases here protect the subscription-before-snapshot
 * invariant: neither a proposal nor a resolution racing an RPC response may
 * be lost, and a reconnect snapshot must supersede an older in-flight read.
 */

import type { ChatPlanRecord } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  createPendingChatPlansStore,
  pendingChatPlanHref,
  pendingChatPlanResolutionCopy,
} from '../approvals/pending-chat-plans-store.js';
import type { WebclientReconnectSubscriber } from '../realtime/connection-status.js';
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

const makeFakeReconnect = () => {
  const listeners = new Set<() => void>();
  const reconnect: WebclientReconnectSubscriber = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    reconnect,
    fire: (): void => {
      for (const listener of [...listeners]) listener();
    },
    count: (): number => listeners.size,
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const record = (
  plan_id: string,
  overrides: Partial<ChatPlanRecord> = {},
): ChatPlanRecord => ({
  plan: {
    plan_id,
    session_id: 's1',
    turn_id: `turn-${plan_id}`,
    tool: 'mail-send',
    tier: 2,
    classification: 'write',
    args: { to: 'a@b.com' },
    args_hash: `hash-${plan_id}`,
    status: 'proposed',
    created_at: 1_000,
  },
  payload_available: true,
  ...overrides,
});

const proposed = (
  plan_id: string,
  overrides: Record<string, unknown> = {},
): unknown => ({
  kind: 'chat.plan_proposed',
  session_id: 's1',
  turn_id: `turn-${plan_id}`,
  plan_id,
  tool: 'mail-send',
  tier: 2,
  args: { to: 'a@b.com' },
  args_hash: `hash-${plan_id}`,
  cursor: 1,
  ...overrides,
});

const resolved = (
  plan_id: string,
  status: 'approved' | 'cancelled' = 'cancelled',
): unknown => ({
  kind: 'chat.plan_resolved',
  session_id: 's1',
  turn_id: `turn-${plan_id}`,
  plan: {
    ...record(plan_id).plan,
    status,
    resolved_at: 2_000,
  },
  cursor: 2,
});

const messageComplete = (
  session_id: string,
  turn_id: string,
  message_id: string,
): unknown => ({
  kind: 'chat.message_complete',
  session_id,
  turn_id,
  final: {
    id: message_id,
    session_id,
    role: 'assistant',
    content: 'Review this action.',
    created_at: 2_000,
  },
  cursor: 3,
});

describe('durable pending Chat-plans store', () => {
  it('hydrates pending plans across sessions with durable ordering and addresses', async () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      listPending: async () => ({
        plans: [
          record('p1', { message_id: 'm1' }),
          record('p2', {
            plan: {
              ...record('p2').plan,
              session_id: 's2',
              retry_of_plan_id: 'p-used',
              created_at: 2_000,
            },
            payload_available: false,
          }),
        ],
      }),
    });

    expect(store.state().phase).toBe('loading');
    await store.whenLoaded();
    expect(store.state()).toEqual({ phase: 'ready', error: null });
    expect(store.list()).toMatchObject([
      {
        plan_id: 'p1',
        session_id: 's1',
        message_id: 'm1',
        proposed_at: 1_000,
        payload_available: true,
      },
      {
        plan_id: 'p2',
        session_id: 's2',
        retry_of_plan_id: 'p-used',
        proposed_at: 2_000,
        payload_available: false,
      },
    ]);
    expect(pendingChatPlanHref(store.list()[0]!)).toBe(
      '#chat/session/s1/plan/p1/answer/m1',
    );
    expect(pendingChatPlanHref(store.list()[1]!)).toBe(
      '#chat/session/s2/plan/p2',
    );
    store.dispose();
  });

  it('keeps a proposal that arrives while the initial snapshot is in flight', async () => {
    const sub = makeFakeSubscriber();
    const snapshot = deferred<{ plans: ReadonlyArray<ChatPlanRecord> }>();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      listPending: () => snapshot.promise,
      now: () => 9_000,
    });

    sub.fire('chat.plan_proposed', proposed('p-live', { created_at: 8_000 }));
    expect(store.list()[0]).toMatchObject({
      plan_id: 'p-live',
      proposed_at: 8_000,
    });
    snapshot.resolve({ plans: [record('p-old')] });
    await store.whenLoaded();

    expect(store.list().map((plan) => plan.plan_id)).toEqual([
      'p-old',
      'p-live',
    ]);
    store.dispose();
  });

  it('replays a racing resolution so a stale snapshot cannot resurrect it', async () => {
    const sub = makeFakeSubscriber();
    const snapshot = deferred<{ plans: ReadonlyArray<ChatPlanRecord> }>();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      listPending: () => snapshot.promise,
    });

    sub.fire('chat.plan_resolved', resolved('p-stale'));
    snapshot.resolve({ plans: [record('p-stale')] });
    await store.whenLoaded();

    expect(store.list()).toEqual([]);
    expect(store.latestResolution()).toMatchObject({
      plan_id: 'p-stale',
      outcome: 'cancelled',
      resolved_at: 2_000,
    });
    store.dispose();
  });

  it('links a live proposal to the exact completed assistant message', () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({ subscribe: sub.on });
    sub.fire('chat.plan_proposed', proposed('p1'));
    sub.fire(
      'chat.message_complete',
      messageComplete('s1', 'turn-p1', 'assistant-message'),
    );

    expect(store.list()[0]?.message_id).toBe('assistant-message');
    expect(pendingChatPlanHref(store.list()[0]!)).toBe(
      '#chat/session/s1/plan/p1/answer/assistant-message',
    );
    store.dispose();
  });

  it('lets a reconnect snapshot supersede a slower pre-reconnect response', async () => {
    const sub = makeFakeSubscriber();
    const reconnect = makeFakeReconnect();
    const first = deferred<{ plans: ReadonlyArray<ChatPlanRecord> }>();
    const second = deferred<{ plans: ReadonlyArray<ChatPlanRecord> }>();
    let calls = 0;
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      reconnect: reconnect.reconnect,
      listPending: () => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    });

    reconnect.fire();
    second.resolve({ plans: [record('p-new')] });
    await store.whenLoaded();
    first.resolve({ plans: [record('p-stale')] });
    await first.promise;
    await Promise.resolve();

    expect(store.list().map((plan) => plan.plan_id)).toEqual(['p-new']);
    expect(store.state().phase).toBe('ready');
    store.dispose();
  });

  it('retains live/last-known rows on failure and reconciles on reconnect', async () => {
    const sub = makeFakeSubscriber();
    const reconnect = makeFakeReconnect();
    const failure = new Error('offline');
    let calls = 0;
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      reconnect: reconnect.reconnect,
      listPending: async () => {
        calls += 1;
        if (calls === 1) throw failure;
        return { plans: [record('p-authoritative')] };
      },
    });
    sub.fire('chat.plan_proposed', proposed('p-live'));
    await store.whenLoaded();

    expect(store.state()).toEqual({ phase: 'error', error: failure });
    expect(store.list().map((plan) => plan.plan_id)).toEqual(['p-live']);

    reconnect.fire();
    await store.whenLoaded();
    expect(store.state()).toEqual({ phase: 'ready', error: null });
    expect(store.list().map((plan) => plan.plan_id)).toEqual([
      'p-authoritative',
    ]);
    store.dispose();
  });

  it('drops resolved plans and retains only the latest live handoff', () => {
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
    expect(store.list().map((plan) => plan.plan_id)).toEqual(['p2']);
    expect(store.latestResolution()).toMatchObject({
      plan_id: 'p1',
      session_id: 's1',
      turn_id: 'turn-p1',
      tool: 'mail-send',
      outcome: 'cancelled',
    });
    expect(store.latestResolution()?.message_id).toBeUndefined();
    sub.fire(
      'chat.message_complete',
      messageComplete('s1', 'turn-p1', 'late-assistant-message'),
    );
    expect(notified).toBe(2);
    expect(store.latestResolution()?.message_id).toBe(
      'late-assistant-message',
    );
    sub.fire('chat.plan_resolved', resolved('unknown'));
    expect(notified).toBe(3);
    expect(store.latestResolution()?.plan_id).toBe('unknown');
    store.dispose();
  });

  it('applies a successful local approval immediately and keeps its exact Chat link', () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      now: () => 3_000,
    });
    sub.fire('chat.plan_proposed', proposed('p1'));
    sub.fire(
      'chat.message_complete',
      messageComplete('s1', 'turn-p1', 'assistant-message'),
    );
    const plan = store.list()[0]!;

    store.recordResolution(plan, 'approve');

    expect(store.list()).toEqual([]);
    expect(store.latestResolution()).toEqual({
      plan_id: 'p1',
      session_id: 's1',
      turn_id: 'turn-p1',
      message_id: 'assistant-message',
      tool: 'mail-send',
      outcome: 'approved',
      resolved_at: 3_000,
    });
    expect(pendingChatPlanHref(store.latestResolution()!)).toBe(
      '#chat/session/s1/plan/p1/answer/assistant-message',
    );

    // The canonical broadcast has no message id; it must not downgrade the
    // stronger local handoff.
    sub.fire('chat.plan_resolved', resolved('p1', 'approved'));
    expect(store.latestResolution()?.message_id).toBe('assistant-message');

    store.dismissResolution('p1');
    expect(store.latestResolution()).toBeNull();
    store.dispose();
  });

  it('does not resurrect a resolved plan from a delayed proposal or stale snapshot', async () => {
    const sub = makeFakeSubscriber();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      listPending: async () => ({
        plans: [record('p1', { message_id: 'assistant-message' })],
      }),
      now: () => 3_000,
    });
    await store.whenLoaded();
    const plan = store.list()[0]!;

    store.recordResolution(plan, 'approve');
    sub.fire('chat.plan_proposed', proposed('p1'));
    expect(store.list()).toEqual([]);

    await store.refresh();
    expect(store.list()).toEqual([]);
    expect(store.latestResolution()).toMatchObject({
      plan_id: 'p1',
      outcome: 'approved',
    });
    store.dispose();
  });

  it('keeps a missed reconnect resolution terminal against later stale data', async () => {
    const sub = makeFakeSubscriber();
    let calls = 0;
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      listPending: async () => {
        calls += 1;
        return calls === 2
          ? { plans: [] }
          : { plans: [record('p1', { message_id: 'assistant-message' })] };
      },
      now: () => 4_000,
    });
    await store.whenLoaded();

    await store.refresh();

    expect(store.list()).toEqual([]);
    expect(store.latestResolution()).toEqual({
      plan_id: 'p1',
      session_id: 's1',
      turn_id: 'turn-p1',
      message_id: 'assistant-message',
      tool: 'mail-send',
      outcome: 'no_longer_pending',
      resolved_at: 4_000,
    });
    expect(pendingChatPlanResolutionCopy(store.latestResolution()!)).toEqual({
      title: 'Approval updated: mail-send',
      detail:
        'This is not waiting for you any more. Open Chat to see where it got to.',
      linkLabel: 'Open Chat',
    });

    sub.fire('chat.plan_proposed', proposed('p1'));
    await store.refresh();
    expect(store.list()).toEqual([]);
    expect(store.latestResolution()?.outcome).toBe('no_longer_pending');
    store.dispose();
  });

  it('dispose unsubscribes from all bus/reconnect seams and ignores late work', () => {
    const sub = makeFakeSubscriber();
    const reconnect = makeFakeReconnect();
    const never = deferred<{ plans: ReadonlyArray<ChatPlanRecord> }>();
    const store = createPendingChatPlansStore({
      subscribe: sub.on,
      reconnect: reconnect.reconnect,
      listPending: () => never.promise,
    });
    expect(sub.count('chat.plan_proposed')).toBe(1);
    expect(sub.count('chat.plan_resolved')).toBe(1);
    expect(sub.count('chat.message_complete')).toBe(1);
    expect(reconnect.count()).toBe(1);

    sub.fire('chat.plan_proposed', proposed('p1'));
    store.dispose();
    expect(sub.unsubCount()).toBe(3);
    expect(reconnect.count()).toBe(0);
    expect(store.list()).toEqual([]);
    expect(store.latestResolution()).toBeNull();
    sub.fire('chat.plan_proposed', proposed('p2'));
    never.resolve({ plans: [record('p-late')] });
    expect(store.list()).toEqual([]);
  });
});
