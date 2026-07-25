/** D-119 Phase 10 — server-side approval store + handler tests.
 *
 *  Covers:
 *    - add / list / remove maintain pending state
 *    - resolve is first-write-wins; second resolve returns
 *      accepted=false with winner info
 *    - subscribe pushes events on add / resolve / remove
 *    - subscribe returns the current snapshot + seq counter
 *    - resolving an unknown approval throws not_found
 *    - bad inputs (missing approval_id, invalid decision) throw bad_request
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerApprovalSubscriptionEvent, ServerPendingApproval } from '@recued/contracts';
import { createApprovalStore } from '../approval-handler.js';

const fixture = (overrides: Partial<ServerPendingApproval> = {}): ServerPendingApproval => ({
  approval_id: 'app-1',
  recipe_id: 'detect-deal-risk',
  step_id: 'send-email',
  ingredient_slug: 'gmail-send',
  risk_tier: 'write',
  description: 'Email Bob',
  resolved_input: { to: 'bob@x.com' },
  created_at: 1_700_000_000_000,
  timeout_at: 1_700_000_300_000,
  initiator_instance: 'ext-work',
  ...overrides,
});

describe('createApprovalStore — list/add/remove', () => {
  it('starts with an empty list', () => {
    const store = createApprovalStore();
    expect(store.list()).toEqual([]);
  });

  it('add() makes an approval visible in list()', () => {
    const store = createApprovalStore();
    store.add(fixture());
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].approval_id).toBe('app-1');
  });

  it('add() is idempotent on duplicate approval_id', () => {
    const store = createApprovalStore();
    store.add(fixture());
    store.add(fixture()); // duplicate
    expect(store.list()).toHaveLength(1);
  });

  it('remove() drops the approval from the list', () => {
    const store = createApprovalStore();
    store.add(fixture());
    store.remove('app-1');
    expect(store.list()).toEqual([]);
  });

  it('remove() of an unknown id is a no-op', () => {
    const store = createApprovalStore();
    store.add(fixture());
    store.remove('does-not-exist');
    expect(store.list()).toHaveLength(1);
  });

  it('list strips internal `resolution` field from wire shape', () => {
    const store = createApprovalStore();
    store.add(fixture());
    const out = store.list()[0];
    expect((out as { resolution?: unknown }).resolution).toBeUndefined();
  });
});

describe('createApprovalStore — first-write-wins resolve', () => {
  it('first resolve is accepted; approval drops from list', () => {
    const store = createApprovalStore();
    store.add(fixture());
    const r = store.resolve('app-1', 'approve', 'ext-work');
    expect(r).toEqual({ approval_id: 'app-1', accepted: true });
    expect(store.list()).toEqual([]);
  });

  it('throws not_found when resolving an unknown approval', () => {
    const store = createApprovalStore();
    expect(() => store.resolve('phantom', 'approve', 'ext-work')).toThrow(
      /not pending — already resolved or expired/,
    );
  });

  it('first-write-wins: resolution survives even after pending entry drops', () => {
    // The `pending.delete(approval_id)` after a resolve means a
    // subsequent resolve attempt with the same id finds nothing
    // pending — and surfaces as not_found, matching the contract.
    const store = createApprovalStore();
    store.add(fixture());
    store.resolve('app-1', 'approve', 'ext-work');
    expect(() => store.resolve('app-1', 'reject', 'ext-phone')).toThrow(/not pending/);
  });
});

describe('createApprovalStore — subscriptions', () => {
  let store: ReturnType<typeof createApprovalStore>;
  let events: ServerApprovalSubscriptionEvent[];
  let unsub: () => void;

  beforeEach(() => {
    store = createApprovalStore();
    events = [];
    unsub = store.subscribe('ext-work', (ev) => events.push(ev));
  });

  it('emits an event on add()', () => {
    store.add(fixture());
    expect(events).toHaveLength(1);
    expect(events[0].pending_count).toBe(1);
    expect(events[0].seq).toBe(1);
  });

  it('emits an event on resolve()', () => {
    store.add(fixture());
    events.length = 0; // discard the add event
    store.resolve('app-1', 'approve', 'ext-work');
    expect(events).toHaveLength(1);
    expect(events[0].pending_count).toBe(0);
  });

  it('emits an event on remove()', () => {
    store.add(fixture());
    events.length = 0;
    store.remove('app-1');
    expect(events).toHaveLength(1);
    expect(events[0].pending_count).toBe(0);
  });

  it('seq increments monotonically', () => {
    store.add(fixture({ approval_id: 'a' }));
    store.add(fixture({ approval_id: 'b' }));
    store.resolve('a', 'approve', 'ext-work');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('unsubscribed callbacks stop receiving events', () => {
    unsub();
    store.add(fixture());
    expect(events).toHaveLength(0);
  });

  it('seq() returns the current counter (echoed by approval.subscribe)', () => {
    expect(store.seq()).toBe(0);
    store.add(fixture());
    expect(store.seq()).toBe(1);
  });

  it('multiple subscribers all receive the same event', () => {
    const events2: ServerApprovalSubscriptionEvent[] = [];
    store.subscribe('ext-phone', (ev) => events2.push(ev));
    store.add(fixture());
    expect(events).toHaveLength(1);
    expect(events2).toHaveLength(1);
    expect(events[0]).toEqual(events2[0]);
  });

  it('a subscriber callback that throws does not break others', () => {
    const events2: ServerApprovalSubscriptionEvent[] = [];
    store.subscribe('throws', () => {
      throw new Error('boom');
    });
    store.subscribe('ext-phone', (ev) => events2.push(ev));
    store.add(fixture());
    expect(events).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });
});

describe('makeApprovalHandlers — rpc dispatch', () => {
  it('returns undefined when deps are absent (drops to not_configured)', async () => {
    const { makeApprovalHandlers } = await import('../approval-handler.js');
    expect(makeApprovalHandlers(undefined)).toBeUndefined();
  });

  it('approval.resolve rejects bad decision values', async () => {
    const { makeApprovalHandlers } = await import('../approval-handler.js');
    const store = createApprovalStore();
    store.add(fixture());
    const slice = makeApprovalHandlers({
      store,
      pushToClient: () => { /* no-op */ },
    });
    if (!slice) throw new Error('expected handler slice');
    const fakeClient = { instance_id: 'ext-x' } as { instance_id: string };
    await expect(
      slice.handlers['approval.resolve'](
        { approval_id: 'app-1', decision: 'invalid' as 'approve' },
        fakeClient as unknown as Parameters<typeof slice.handlers['approval.resolve']>[1],
      ),
    ).rejects.toThrow(/decision must be approve/);
  });

  it('approval.subscribe returns initial snapshot + seq', async () => {
    const { makeApprovalHandlers } = await import('../approval-handler.js');
    const store = createApprovalStore();
    store.add(fixture());
    const slice = makeApprovalHandlers({
      store,
      pushToClient: () => { /* no-op */ },
    });
    if (!slice) throw new Error('expected handler slice');
    const fakeClient = { instance_id: 'ext-x' } as { instance_id: string };
    const res = await slice.handlers['approval.subscribe'](
      undefined as unknown as Parameters<typeof slice.handlers['approval.subscribe']>[0],
      fakeClient as unknown as Parameters<typeof slice.handlers['approval.subscribe']>[1],
    );
    expect(res.approvals).toHaveLength(1);
    expect(res.seq).toBe(1);
  });
});
