/** D-121 Phase 6 — EventBus + handler unit tests.
 *
 *  Cursor monotonicity, ring buffer overflow, kind filtering, replay
 *  on subscribe-with-since, fell-off-ring detection, push-callback
 *  isolation (one bad listener doesn't break the chain), and
 *  best-effort emit (a throwing emit still rotates the cursor and
 *  keeps the bus usable). */

import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@recued/contracts';
import { createEventBus } from '../events/bus.js';
import {
  bridgeWarehouseEvents,
  emitApprovalPending,
  emitApprovalResolved,
  emitExecution,
  emitMemoryAudit,
  emitMemoryInsight,
  emitMemoryLink,
  emitReactiveFire,
  emitSchedule,
  emitService,
  emitEntitlement,
} from '../events/emit-sites.js';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { wireEventSubscription, makeEventsHandlers } from '../events/handler.js';

const registeredClient = { instance_id: 'paired-client' } as never;

describe('EventBus.emit + cursor', () => {
  it('cursor starts at 0 and increments per emit', () => {
    const bus = createEventBus();
    expect(bus.cursor()).toBe(0);
    const a = bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    expect(a.cursor).toBe(1);
    const b = bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' });
    expect(b.cursor).toBe(2);
    expect(bus.cursor()).toBe(2);
  });

  it('returns the stamped event', () => {
    const bus = createEventBus();
    const ev = bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    expect(ev).toMatchObject({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1', cursor: 1 });
  });
});

describe('EventBus.subscribe + push fanout', () => {
  it('delivers matching kinds; skips others', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe('client-1', { kinds: ['memory'] }, (e) => seen.push(e));
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    bus.emit({ kind: 'memory', subkind: 'link', id: 'r2' });
    expect(seen.length).toBe(2);
    expect(seen.every((e) => e.kind === 'memory')).toBe(true);
  });

  it('rejects empty kinds (programmer error)', () => {
    const bus = createEventBus();
    expect(() => bus.subscribe('c', { kinds: [] }, () => {})).toThrow(/kinds/);
  });

  it('re-subscribe replaces the previous filter for that subscriber id', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe('c', { kinds: ['memory'] }, (e) => seen.push(e));
    bus.subscribe('c', { kinds: ['warehouse'] }, (e) => seen.push(e));
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    // Second subscribe replaced the listener; only warehouse comes through.
    expect(seen.length).toBe(1);
    expect(seen[0].kind).toBe('warehouse');
  });

  it('unsubscribe removes the subscriber', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe('c', { kinds: ['memory'] }, (e) => seen.push(e));
    bus.unsubscribe('c');
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    expect(seen.length).toBe(0);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('one throwing listener does not break delivery to others', () => {
    const bus = createEventBus();
    const ok: ServerEvent[] = [];
    bus.subscribe('bad', { kinds: ['memory'] }, () => { throw new Error('boom'); });
    bus.subscribe('good', { kinds: ['memory'] }, (e) => ok.push(e));
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    expect(ok.length).toBe(1);
  });
});

describe('EventBus.replay (cursor-since)', () => {
  it('subscribe with cursor_since returns matching events from the ring', () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' }); // cursor 1
    bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' }); // 2
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' }); // 3
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe(
      'c',
      { kinds: ['memory'], cursor_since: 1 },
      (e) => replayed.push(e),
    );
    expect(ack.cursor).toBe(3);
    expect(ack.replay_count).toBe(1);
    expect(ack.fell_off_ring).toBe(false);
    expect(replayed.length).toBe(1);
    expect(replayed[0].cursor).toBe(3);
  });

  it('subscribe without cursor_since does NOT replay', () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe('c', { kinds: ['memory'] }, (e) => replayed.push(e));
    expect(ack.replay_count).toBe(0);
    expect(replayed.length).toBe(0);
  });

  it('subscribe with cursor_since at-or-past-current is a no-op replay', () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe(
      'c',
      { kinds: ['memory'], cursor_since: 100 },
      (e) => replayed.push(e),
    );
    expect(ack.replay_count).toBe(0);
    expect(replayed.length).toBe(0);
  });

  it('subscribe with cursor_since older than ring window flips fell_off_ring', () => {
    const bus = createEventBus({ ringSize: 3 });
    for (let i = 0; i < 10; i++) {
      bus.emit({ kind: 'memory', subkind: 'audit', id: `r${i}` });
    }
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe(
      'c',
      { kinds: ['memory'], cursor_since: 1 }, // ring evicted up to cursor 8
      (e) => replayed.push(e),
    );
    expect(ack.fell_off_ring).toBe(true);
    expect(ack.replay_count).toBe(0);
    expect(replayed.length).toBe(0);
  });

  it('replay preserves cursor order', () => {
    const bus = createEventBus();
    for (let i = 1; i <= 5; i++) {
      bus.emit({ kind: 'memory', subkind: 'audit', id: `r${i}` });
    }
    const cursors: number[] = [];
    bus.subscribe('c', { kinds: ['memory'], cursor_since: 0 }, (e) => cursors.push(e.cursor));
    expect(cursors).toEqual([1, 2, 3, 4, 5]);
  });

  it('replay only delivers matching kinds', () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' });
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe(
      'c',
      { kinds: ['warehouse'], cursor_since: 0 },
      (e) => replayed.push(e),
    );
    expect(ack.replay_count).toBe(1);
    expect(replayed[0].kind).toBe('warehouse');
  });
});

describe('EventBus ring buffer eviction', () => {
  it('replay() returns at most ringSize items', () => {
    const bus = createEventBus({ ringSize: 3 });
    for (let i = 0; i < 5; i++) {
      bus.emit({ kind: 'memory', subkind: 'audit', id: `r${i}` });
    }
    const replayed = bus.replay(0);
    // Ring evicted the oldest two; cursor 3, 4, 5 remain.
    expect(replayed.length).toBe(3);
    expect(replayed.map((e) => e.cursor)).toEqual([3, 4, 5]);
  });

  it('emit continues working after ring overflow', () => {
    const bus = createEventBus({ ringSize: 2 });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r3' });
    expect(bus.cursor()).toBe(3);
    expect(bus.replay(0).map((e) => e.cursor)).toEqual([2, 3]);
  });
});

describe('emit-site helpers', () => {
  it('approval pending + resolved emit per-id', () => {
    const bus = createEventBus();
    emitApprovalPending(bus, 'a1');
    emitApprovalResolved(bus, 'a1');
    const evs = bus.replay(0);
    expect(evs.length).toBe(2);
    expect(evs[0]).toMatchObject({ kind: 'approval', subkind: 'pending', id: 'a1' });
    expect(evs[1]).toMatchObject({ kind: 'approval', subkind: 'resolved', id: 'a1' });
  });

  it('execution emits start/complete with stamped recipe + run id', () => {
    const bus = createEventBus();
    emitExecution(bus, { recipe_id: 'r', run_id: 'x', op: 'start' });
    emitExecution(bus, { recipe_id: 'r', run_id: 'x', op: 'complete' });
    const evs = bus.replay(0);
    expect(evs.map((e) => e.kind === 'execution' ? e.op : null)).toEqual(['start', 'complete']);
  });

  it('schedule emits updated + fired distinctly', () => {
    const bus = createEventBus();
    emitSchedule(bus, 'updated');
    emitSchedule(bus, 'fired');
    expect(bus.replay(0).map((e) => e.kind === 'schedule' ? e.op : null)).toEqual(['updated', 'fired']);
  });

  it('memory helpers cover all three subkinds', () => {
    const bus = createEventBus();
    emitMemoryAudit(bus, 'a');
    emitMemoryInsight(bus, 'i');
    emitMemoryLink(bus, 'l');
    const evs = bus.replay(0);
    expect(evs.map((e) => e.kind === 'memory' ? e.subkind : null)).toEqual(['audit', 'insight', 'link']);
  });

  it('helpers no-op when bus is undefined (best-effort)', () => {
    expect(() => emitApprovalPending(undefined, 'a1')).not.toThrow();
    expect(() => emitExecution(undefined, { recipe_id: 'r', run_id: 'x', op: 'start' })).not.toThrow();
    expect(() => emitSchedule(undefined, 'fired')).not.toThrow();
    expect(() => emitEntitlement(undefined, { isPro: true, since: 1 })).not.toThrow();
  });

  it('helpers skip emit when id is missing (defensive)', () => {
    const bus = createEventBus();
    emitApprovalPending(bus, '');
    emitMemoryAudit(bus, '');
    emitReactiveFire(bus, '');
    emitService(bus, { service_id: '', op: 'enrolled' });
    expect(bus.cursor()).toBe(0);
  });

});

describe('warehouse → ServerEvent bridge', () => {
  it('translates created/updated/deleted into warehouse insert/update/delete', () => {
    const bus = createEventBus();
    const wb = createWarehouseEventBus();
    const detach = bridgeWarehouseEvents(bus, wb);

    wb.emit({ platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id: 'm1', at: 1 });
    wb.emit({ platform: 'calendar', slug: 'home', entity_type: 'event', event_kind: 'updated', record_id: 'e1', at: 2 });
    wb.emit({ platform: 'file', slug: 'docs', entity_type: 'file', event_kind: 'deleted', record_id: 'f1', at: 3 });

    const evs = bus.replay(0);
    expect(evs).toHaveLength(3);
    expect(evs[0]).toMatchObject({ kind: 'warehouse', collection: 'mail', op: 'insert', id: 'm1' });
    expect(evs[1]).toMatchObject({ kind: 'warehouse', collection: 'calendar', op: 'update', id: 'e1' });
    expect(evs[2]).toMatchObject({ kind: 'warehouse', collection: 'file', op: 'delete', id: 'f1' });

    detach();
  });

  it('skips synced ticks (collection-level batch signal)', () => {
    const bus = createEventBus();
    const wb = createWarehouseEventBus();
    bridgeWarehouseEvents(bus, wb);
    wb.emit({ platform: 'mail', slug: 'w', entity_type: 'message', event_kind: 'synced', record_id: '', at: 1 });
    expect(bus.cursor()).toBe(0);
  });

  it('detach unsubscribes the bridge listener', () => {
    const bus = createEventBus();
    const wb = createWarehouseEventBus();
    const detach = bridgeWarehouseEvents(bus, wb);
    detach();
    wb.emit({ platform: 'mail', slug: 'w', entity_type: 'message', event_kind: 'created', record_id: 'm1', at: 1 });
    expect(bus.cursor()).toBe(0);
  });
});

describe('events handler — subscribe rpc', () => {
  it('returns ack + delivers replay through pushToClient', async () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });

    const sent: unknown[] = [];
    const fakeClient = registeredClient;
    const slice = makeEventsHandlers({
      bus,
      pushToClient: (_c, payload) => sent.push(payload),
      subscriberId: () => 'c',
    })!;

    const ack = await slice.handlers['events.subscribe'](
      { kinds: ['memory'], cursor_since: 0 },
      fakeClient,
    );

    expect(ack.cursor).toBe(1);
    expect(ack.replay_count).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'server_event',
      event: { kind: 'memory', subkind: 'audit', id: 'r1', cursor: 1 },
    });
  });

  it('rejects empty kinds via RpcError', async () => {
    const bus = createEventBus();
    const slice = makeEventsHandlers({
      bus,
      pushToClient: () => {},
      subscriberId: () => 'c',
    })!;
    await expect(
      slice.handlers['events.subscribe']({ kinds: [] }, registeredClient),
    ).rejects.toThrow(/kinds/);
  });

  it('rejects unknown kinds via RpcError (D-148 P12 — closed enum gate)', async () => {
    const bus = createEventBus();
    const slice = makeEventsHandlers({
      bus,
      pushToClient: () => {},
      subscriberId: () => 'c',
    })!;
    // 'session' was retired by D-148 P12 — a stale client still
    // requesting it must be rejected at the wire so the retirement
    // is enforceable across reconnects rather than silently
    // returning ack with zero matching events.
    await expect(
      slice.handlers['events.subscribe'](
        { kinds: ['session'] as never },
        registeredClient,
      ),
    ).rejects.toThrow(/unknown kind 'session'/);
    await expect(
      slice.handlers['events.subscribe'](
        { kinds: ['memory', 'not_a_kind'] as never },
        registeredClient,
      ),
    ).rejects.toThrow(/unknown kind 'not_a_kind'/);
  });

  it('rejects unregistered and revoked callers without installing a subscription', async () => {
    const bus = createEventBus();
    const pushToClient = vi.fn();
    const slice = makeEventsHandlers({
      bus,
      pushToClient,
      subscriberId: () => 'untrusted-client',
    })!;

    await expect(
      slice.handlers['events.subscribe'](
        { kinds: ['execution'] },
        { instance_id: null } as never,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    // A surviving bearer from a revoked pair is deliberately not authority:
    // the WS identity resolver leaves both paired ids null before dispatch.
    await expect(
      slice.handlers['events.subscribe'](
        { kinds: ['execution'], cursor_since: 0 },
        {
          instance_id: null,
          token_instance_id: null,
          client_token_id: 'surviving-revoked-token',
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });

    expect(bus.subscriberCount()).toBe(0);
    expect(pushToClient).not.toHaveBeenCalled();
  });

  it('returns undefined when deps are absent', () => {
    expect(makeEventsHandlers(undefined)).toBeUndefined();
  });

  it('wireEventSubscription delivers live events post-subscribe', () => {
    const bus = createEventBus();
    const sent: unknown[] = [];
    const client = {} as Parameters<typeof wireEventSubscription>[1];
    wireEventSubscription(
      {
        bus,
        pushToClient: (_c, payload) => sent.push(payload),
        subscriberId: () => 'c',
      },
      client,
      { kinds: ['memory'] },
    );
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    expect(sent).toHaveLength(1);
  });
});

describe('idempotency under duplicate delivery', () => {
  it('emits keep monotonic cursor; bus has no concept of duplicate (caller handles)', () => {
    const bus = createEventBus();
    // Bus deliberately does NOT dedupe — at-least-once on the wire,
    // idempotency at the cache layer (warehouse upsert, memory hash).
    // Emitting the same logical event twice produces two cursor stamps.
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    expect(bus.cursor()).toBe(2);
    const evs = bus.replay(0);
    expect(evs.length).toBe(2);
    expect(evs[0].cursor).toBe(1);
    expect(evs[1].cursor).toBe(2);
  });

  it('a stale subscribe-with-since does not re-emit replayed events to other subscribers', () => {
    const bus = createEventBus();
    const liveSeen: ServerEvent[] = [];
    bus.subscribe('live', { kinds: ['memory'] }, (e) => liveSeen.push(e));
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' });
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' });
    expect(liveSeen).toHaveLength(2);

    const replayedSeen: ServerEvent[] = [];
    bus.subscribe(
      'replay',
      { kinds: ['memory'], cursor_since: 0 },
      (e) => replayedSeen.push(e),
    );
    // Replay landed in the new subscriber, not the live one.
    expect(replayedSeen).toHaveLength(2);
    expect(liveSeen).toHaveLength(2);
  });
});

describe('Stripe → entitlement broadcast', () => {
  it('emitEntitlement stamps isPro + since (server-side bridge for cloud webhook)', () => {
    const bus = createEventBus();
    emitEntitlement(bus, { isPro: true, since: 1700000000000 });
    const ev = bus.replay(0)[0];
    expect(ev).toMatchObject({ kind: 'entitlement', isPro: true, since: 1700000000000 });
  });

  it('subscribed clients see entitlement events in cursor order', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe('c', { kinds: ['entitlement'] }, (e) => seen.push(e));
    emitEntitlement(bus, { isPro: false, since: 1 });
    emitEntitlement(bus, { isPro: true, since: 2 });
    expect(seen.map((e) => (e.kind === 'entitlement' ? e.isPro : null))).toEqual([false, true]);
  });

  it('latency-bound smoke check: emit-to-listener is synchronous', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe('c', { kinds: ['entitlement'] }, (e) => seen.push(e));
    const before = performance.now();
    emitEntitlement(bus, { isPro: true, since: Date.now() });
    const after = performance.now();
    expect(seen).toHaveLength(1);
    // Same-process emit is sub-ms; spec wants <5s end-to-end, this is
    // the in-process leg of that chain.
    expect(after - before).toBeLessThan(50);
  });
});

describe('subscriberCount + isolation', () => {
  it('subscriberCount tracks active subscriptions', () => {
    const bus = createEventBus();
    expect(bus.subscriberCount()).toBe(0);
    bus.subscribe('a', { kinds: ['memory'] }, () => {});
    bus.subscribe('b', { kinds: ['memory'] }, () => {});
    expect(bus.subscriberCount()).toBe(2);
    bus.unsubscribe('a');
    expect(bus.subscriberCount()).toBe(1);
  });

  it('approval observer + bus emit interleave works with a real spy', () => {
    const bus = createEventBus();
    const onPending = vi.fn((id: string) => emitApprovalPending(bus, id));
    onPending('a1');
    onPending('a2');
    expect(onPending).toHaveBeenCalledTimes(2);
    expect(bus.replay(0)).toHaveLength(2);
  });
});

describe('EventBus — credential bearer scrubbed from the replay ring', () => {
  it('token.rotated fans out LIVE with the bearer, but the replay copy is scrubbed', () => {
    const bus = createEventBus();
    const live: ServerEvent[] = [];
    bus.subscribe('live', { kinds: ['token.rotated'] }, (e) => live.push(e));
    bus.emit({
      kind: 'token.rotated',
      target_token_id: 't1',
      new_token_id: 't2',
      bearer: 'SECRET',
      issued_at: 1,
    });
    // Live fan-out is unchanged — the target consumes the real bearer inline.
    expect(live).toHaveLength(1);
    expect((live[0] as { bearer: string }).bearer).toBe('SECRET');
    // The replay ring retains the metadata (new_token_id) but BLANKS the
    // bearer, so a low-cursor replay can never harvest reusable auth material.
    const replayed = bus.replay(0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.kind).toBe('token.rotated');
    expect((replayed[0] as unknown as { bearer: string }).bearer).toBe('');
    expect((replayed[0] as unknown as { new_token_id: string }).new_token_id).toBe('t2');
    // A late subscriber replaying from cursor 0 likewise gets the scrubbed copy.
    const lateReplayed: ServerEvent[] = [];
    bus.subscribe(
      'late',
      { kinds: ['token.rotated'], cursor_since: 0 },
      (e) => lateReplayed.push(e),
    );
    expect(lateReplayed).toHaveLength(1);
    expect((lateReplayed[0] as unknown as { bearer: string }).bearer).toBe('');
  });

  it('a low-cursor replay interleaving token.rotated stays cursor-ordered with no false fell-off', () => {
    const bus = createEventBus();
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r1' }); // cursor 1
    bus.emit({
      kind: 'token.rotated',
      target_token_id: 't',
      new_token_id: 'n',
      bearer: 'SECRET',
      issued_at: 1,
    }); // cursor 2 (retained, scrubbed — ring stays dense)
    bus.emit({ kind: 'memory', subkind: 'audit', id: 'r2' }); // cursor 3
    const replayed: ServerEvent[] = [];
    const ack = bus.subscribe(
      'c',
      { kinds: ['memory', 'token.rotated'], cursor_since: 0 },
      (e) => replayed.push(e),
    );
    // Dense ring → all three replay in cursor order, fell_off stays false.
    expect(ack.replay_count).toBe(3);
    expect(replayed.map((e) => e.cursor)).toEqual([1, 2, 3]);
    expect(ack.fell_off_ring).toBe(false);
    // The replayed rotation carries NO bearer.
    const rotated = replayed.find((e) => e.kind === 'token.rotated') as unknown as { bearer: string };
    expect(rotated.bearer).toBe('');
  });
});
