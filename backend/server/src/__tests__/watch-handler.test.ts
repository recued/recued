/** Poll-manager / G6 — `watch.*` rpc handler suite. */

import { describe, expect, it } from 'vitest';
import { RpcError, type WatchStatusEntry } from '@recued/contracts';
import { listWatches, makeWatchHandlers, runNowWatch, updateWatch } from '../watch/handler.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';

const entry = (overrides: Partial<WatchStatusEntry> = {}): WatchStatusEntry => ({
  watch_key: 'hubspot/deal/main-crm',
  source_id: 'connection-api',
  connection_name: 'main-crm',
  vendor: 'hubspot',
  entity: 'deal',
  enabled: true,
  active: true,
  deferred_to: null,
  effective_interval_ms: 900_000,
  subscriber_recipe_ids: ['surface-stalling-deals-hubspot'],
  last_poll_at: null,
  last_status: null,
  last_error: null,
  baselined: false,
  consecutive_failures: 0,
  ...overrides,
});

const managerWith = (overrides: Partial<PollManagerHandle> = {}): PollManagerHandle => ({
  recompute: () => {},
  listEntries: () => [entry()],
  setEnabled: () => entry({ enabled: false, active: false }),
  pollNow: async () => {},
  stop: async () => {},
  activeLoopCount: () => 1,
  inFlight: () => false,
  ...overrides,
});

describe('watch.* handlers', () => {
  it('watch.list returns the manager entries (sources empty without a registry)', () => {
    const deps = { getManager: () => managerWith() };
    expect(listWatches(deps)).toEqual({ watches: [entry()], sources: [] });
  });

  it('watch.list rides push-source rows along when a registry is wired', () => {
    const source = {
      source_key: 'webhook/hubspot/main-crm',
      mechanism: 'webhook' as const,
      label: 'hubspot webhook — main-crm',
      emits: ['data.connection.api.hubspot.deal.main-crm.**'],
      active: true,
      inactive_reason: null,
      last_event_at: 1_000,
    };
    const deps = {
      getManager: () => managerWith(),
      getSourceRegistry: () => ({ list: () => [source] }),
    };
    expect(listWatches(deps)).toEqual({ watches: [entry()], sources: [source] });
  });

  it('watch.update validates args', () => {
    const deps = { getManager: () => managerWith() };
    expect(() => updateWatch(deps, { enabled: true })).toThrowError(RpcError);
    expect(() => updateWatch(deps, { watch_key: 'k' })).toThrowError(/enabled/);
  });

  it('watch.update forwards to setEnabled and returns the entry', () => {
    const calls: Array<[string, boolean]> = [];
    const deps = {
      getManager: () =>
        managerWith({
          setEnabled: (key, enabled) => {
            calls.push([key, enabled]);
            return entry({ enabled });
          },
        }),
    };
    const result = updateWatch(deps, { watch_key: 'hubspot/deal/main-crm', enabled: false });
    expect(calls).toEqual([['hubspot/deal/main-crm', false]]);
    expect(result.entry.enabled).toBe(false);
  });

  it('watch.update 404s on an unknown key', () => {
    const deps = { getManager: () => managerWith({ setEnabled: () => null }) };
    try {
      updateWatch(deps, { watch_key: 'nope', enabled: true });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('not_found');
    }
  });

  it('not_configured when the manager is absent (pre-boot getter posture)', () => {
    const deps = { getManager: () => undefined };
    try {
      listWatches(deps);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as RpcError).code).toBe('not_configured');
    }
  });

  it('watch.run_now validates args and 404s on an unknown key', async () => {
    const deps = { getManager: () => managerWith() };
    await expect(runNowWatch(deps, {})).rejects.toThrowError(/watch_key/);
    try {
      await runNowWatch(deps, { watch_key: 'nope' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe('not_found');
    }
  });

  it('watch.run_now 409s on inactive keys, naming why', async () => {
    const cases: Array<[Partial<WatchStatusEntry>, RegExp]> = [
      // Deference wins the message even on an enabled row.
      [{ active: false, deferred_to: 'reconciler' }, /covered by the higher-fidelity 'reconciler'/],
      [{ active: false, enabled: false }, /paused — resume it first/],
      [{ active: false }, /no armed poll loop/],
    ];
    for (const [overrides, why] of cases) {
      let polled = false;
      const deps = {
        getManager: () =>
          managerWith({
            listEntries: () => [entry(overrides)],
            pollNow: async () => { polled = true; },
          }),
      };
      try {
        await runNowWatch(deps, { watch_key: 'hubspot/deal/main-crm' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcError);
        expect((err as RpcError).code).toBe('conflict');
        expect((err as RpcError).message).toMatch(why);
      }
      // The conflict pre-check must short-circuit — pollNow silently
      // no-ops on loop-less keys, which would masquerade as success.
      expect(polled).toBe(false);
    }
  });

  it('watch.run_now awaits pollNow then returns the REFRESHED entry', async () => {
    const order: string[] = [];
    let polls = 0;
    const deps = {
      getManager: () =>
        managerWith({
          listEntries: () => {
            order.push('list');
            // Refreshed read (post-poll) carries the new poll stamp.
            return [entry(polls > 0 ? { last_poll_at: 1_000, last_status: 'ok' } : {})];
          },
          pollNow: async (key) => {
            order.push(`poll:${key}`);
            polls += 1;
          },
        }),
    };
    const result = await runNowWatch(deps, { watch_key: 'hubspot/deal/main-crm' });
    expect(order).toEqual(['list', 'poll:hubspot/deal/main-crm', 'list']);
    expect(result.entry.last_poll_at).toBe(1_000);
    expect(result.entry.last_status).toBe('ok');
  });

  it('watch.run_now falls back to the pre-poll entry if the key vanishes mid-run', async () => {
    let polled = false;
    let listed = 0;
    const deps = {
      getManager: () =>
        managerWith({
          listEntries: () => {
            listed += 1;
            // First read (active gate) sees the key; the refresh after
            // pollNow does not (disarmed mid-run by a recompute).
            return listed === 1 ? [entry()] : [];
          },
          pollNow: async () => { polled = true; },
        }),
    };
    const result = await runNowWatch(deps, { watch_key: 'hubspot/deal/main-crm' });
    expect(polled).toBe(true);
    expect(result.entry.watch_key).toBe('hubspot/deal/main-crm');
  });

  it('makeWatchHandlers: undefined deps → no slice; defined → all three methods', () => {
    expect(makeWatchHandlers(undefined)).toBeUndefined();
    const slice = makeWatchHandlers({ getManager: () => managerWith() })!;
    expect(slice.methods).toEqual(['watch.list', 'watch.update', 'watch.run_now']);
    expect(Object.keys(slice.handlers).sort()).toEqual(['watch.list', 'watch.run_now', 'watch.update']);
  });
});
