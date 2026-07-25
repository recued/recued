/** D-148 P4 — broadcast subscriber dispatch. */

import { describe, expect, it } from 'vitest';
import {
  ALL_BROADCAST_EVENT_KINDS,
  DEFAULT_SUBSCRIPTIONS,
} from '@recued/contracts';
import {
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
  createBroadcastSubscriber,
} from '../realtime/subscriber.js';

const sortUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

describe('D-148 P4 — broadcast subscriber', () => {
  it('default subscription set covers live webclient consumers', () => {
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('approval');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('cert.rotation_notice');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('exposure_changed');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('notification.ask');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('reception.endpoint_changed');
    // R2 build step 4c.4 — the #recipes route's runnability pills patch in
    // place from the carried snapshot (M-CHAT-1: listener lands with this).
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('recipe_runnability_changed');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('token.rotated');
    // D-181 slice 5b — the Runs "Active" section re-lists off the live
    // long-op governor deltas, so `execution` is now a required webclient
    // subscription (previously a deliberately-excluded dead kind).
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('execution');
    // Bridge channel deliberately excluded — bridges aren't surfaced
    // through webclient UI today.
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).not.toContain('bridge' as never);
  });

  // M-XSURF-1 follow-on — transport subscription parity is necessary but
  // not sufficient. The contract-level DEFAULT_SUBSCRIPTIONS remains the
  // paired-client catch-all; the webclient list is narrower and should not
  // keep legacy kinds that have no webclient listener.
  it('ratchet: webclient subscriptions are known bus kinds and legacy dead kinds stay out', () => {
    const all = sortUnique(ALL_BROADCAST_EVENT_KINDS);

    // `DEFAULT_SUBSCRIPTIONS` is the canonical paired-client set — also the
    // whole enum (the bridge is the only deliberately-narrow surface, pinned
    // by its own ratchet in `apps/bridge`).
    expect(sortUnique(DEFAULT_SUBSCRIPTIONS)).toEqual(all);

    for (const kind of WEBCLIENT_DEFAULT_SUBSCRIPTIONS) {
      expect(ALL_BROADCAST_EVENT_KINDS).toContain(kind);
    }
    // `execution` graduated from this dead set in D-181 slice 5b (the Runs
    // "Active" section listens for it); `warehouse` + `memory` graduated in R18
    // (the #data route live-updates its lists + open timeline off them). Only the
    // legacy `notification` approval-bus kind still has no webclient listener.
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).not.toContain('notification' as never);
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('warehouse');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('memory');

    // No duplicate kinds crept into either list (dedup would otherwise shrink
    // it below the source length).
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toHaveLength(
      sortUnique(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).length,
    );
    expect(DEFAULT_SUBSCRIPTIONS).toHaveLength(all.length);
  });

  it('on(kind) only fires for matching kind', () => {
    const sub = createBroadcastSubscriber();
    const seen: unknown[] = [];
    sub.on('execution', (e) => seen.push(e));
    sub.dispatch({ kind: 'execution', recipe_id: 'r1', run_id: 'u1', op: 'progress', cursor: 1 });
    sub.dispatch({ kind: 'memory', subkind: 'audit', id: 'm1', cursor: 2 });
    expect(seen.length).toBe(1);
    expect((seen[0] as { run_id: string }).run_id).toBe('u1');
  });

  it('onAny fires for every kind', () => {
    const sub = createBroadcastSubscriber();
    let n = 0;
    sub.onAny(() => (n += 1));
    sub.dispatch({ kind: 'execution', recipe_id: 'r1', run_id: 'u1', op: 'progress', cursor: 1 });
    sub.dispatch({ kind: 'memory', subkind: 'audit', id: 'm1', cursor: 2 });
    expect(n).toBe(2);
  });

  it('listener unsubscribe is honored', () => {
    const sub = createBroadcastSubscriber();
    const seen: unknown[] = [];
    const off = sub.on('approval', (e) => seen.push(e));
    sub.dispatch({ kind: 'approval', subkind: 'pending', id: 'a1', cursor: 1 });
    off();
    sub.dispatch({ kind: 'approval', subkind: 'pending', id: 'a2', cursor: 2 });
    expect(seen.length).toBe(1);
  });

  it('malformed inbound message is dropped', () => {
    const sub = createBroadcastSubscriber();
    let n = 0;
    sub.onAny(() => (n += 1));
    sub.dispatch(null);
    sub.dispatch('not-a-server-event');
    sub.dispatch({ /* missing kind */ recipe_id: 'r1' });
    expect(n).toBe(0);
  });

  it('listener throw is isolated; subsequent listeners still fire', () => {
    const sub = createBroadcastSubscriber();
    sub.on('execution', () => {
      throw new Error('boom');
    });
    let n = 0;
    sub.on('execution', () => (n += 1));
    sub.dispatch({ kind: 'execution', recipe_id: 'r1', run_id: 'u1', op: 'progress', cursor: 1 });
    expect(n).toBe(1);
  });

  it('size() reports listener counts', () => {
    const sub = createBroadcastSubscriber();
    sub.on('approval', () => {});
    sub.on('approval', () => {});
    sub.onAny(() => {});
    expect(sub.size('approval')).toBe(2);
    expect(sub.size('warehouse')).toBe(0);
    expect(sub.size()).toBe(3);
  });
});
