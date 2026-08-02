/** Poll-manager / G6 — watch coordinator unit suite.
 *
 *  Covers the design § 3 pins end-to-end against fake stores + an
 *  injected timer/clock: demand derivation (literal connection.api
 *  patterns × enrolled vendor connections), interval min-over-prefs +
 *  floor, reconciler deference, baseline suppression (first poll
 *  persists WITHOUT firing — and the persisted flag survives a
 *  "restart"), created/updated/deleted emission with prev / record /
 *  changed_fields payloads, deleted-only-on-complete-walk, the
 *  error-cap auto-disable, pause/resume semantics (snapshot kept →
 *  catch-up diff on resume), recompute disarm when the last subscriber
 *  leaves, and stop() drain + maintenance-exit re-arm. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventTrigger } from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';
import { diffChangedFields } from '@recued/warehouse-events';

import { createConnectionApiPollSource } from '../watch/connection-api-source.js';
import {
  createWatchPollManager,
  type PollManagerDeps,
  type WatchPollSource,
  type PollManagerHandle,
} from '../watch/poll-manager.js';
import { createWatchStore, type WatchStore } from '../watch/snapshot-store.js';
import type { CanonicalPollOutcome } from '../watch/canonical-poll.js';

const KEY = 'hubspot/deal/main-crm';

const trigger = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 't-1',
  recipe_id: 'surface-stalling-deals-hubspot',
  publisher_id: 'recued-core',
  pattern: 'data.connection.api.hubspot.deal.**.updated',
  enabled: true,
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
  origin: 'recipe',
  ...overrides,
});

interface TimerEntry {
  handler: () => void;
  delayMs: number;
  token: number;
  cleared: boolean;
}

/** Deterministic timer fake — fire entries by hand. */
const makeTimers = () => {
  const entries: TimerEntry[] = [];
  let nextToken = 1;
  return {
    entries,
    setTimer: (handler: () => void, delayMs: number): unknown => {
      const entry: TimerEntry = { handler, delayMs, token: nextToken++, cleared: false };
      entries.push(entry);
      return entry.token;
    },
    clearTimer: (token: unknown): void => {
      const entry = entries.find((e) => e.token === token);
      if (entry) entry.cleared = true;
    },
    pending: () => entries.filter((e) => !e.cleared),
    /** Fire every currently-pending timer once (and consume them). */
    fireAll: async (): Promise<void> => {
      const live = entries.filter((e) => !e.cleared);
      for (const entry of live) {
        entry.cleared = true;
        entry.handler();
      }
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    /** Fire the most recent pending timer (and consume it). */
    fireLatest: async (): Promise<void> => {
      const live = entries.filter((e) => !e.cleared);
      const entry = live[live.length - 1];
      if (!entry) throw new Error('no pending timer');
      entry.cleared = true;
      entry.handler();
      // tick() is async — let the poll promise settle.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

const okOutcome = (
  records: Record<string, Record<string, unknown>>,
  truncated = false,
  // S2 — completeness defaults to "complete iff not truncated"; a test overrides it to
  // simulate a NON-paginating poll (truncated:false but complete:false).
  complete = !truncated,
): CanonicalPollOutcome => ({
  ok: true,
  records: new Map(Object.entries(records)),
  truncated,
  complete,
  skipped_no_id: 0,
});

describe('watch poll-manager', () => {
  let db: Database.Database;
  let store: WatchStore;
  let emitted: WarehouseEvent[];
  let bus: WarehouseEventBus;
  let timers: ReturnType<typeof makeTimers>;
  let busEmits: Array<{ kind: string; mechanism?: string }>;
  let triggers: EventTrigger[];
  let connections: Array<{ name: string; vendor: string | undefined }>;
  let pollOutcomes: Array<CanonicalPollOutcome | Promise<CanonicalPollOutcome>>;
  let pollCalls: Array<{ vendor: string; entity: string; connection_name: string }>;
  let hasReconciler: (v: string, e: string, c: string) => boolean;
  let now: number;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createWatchStore(db);
    emitted = [];
    bus = {
      emit: (event) => {
        emitted.push(event);
      },
      subscribe: () => () => {},
      dispose: () => {},
    };
    timers = makeTimers();
    busEmits = [];
    triggers = [trigger()];
    connections = [{ name: 'main-crm', vendor: 'hubspot' }];
    pollOutcomes = [];
    pollCalls = [];
    hasReconciler = () => false;
    now = 100_000;
  });

  afterEach(() => {
    db.close();
  });

  // The connection-api source wraps the same scripted seams the
  // pre-generalization manager took directly — every scenario below
  // exercises the source + the source-agnostic core together.
  const makeConnectionApiSource = (): WatchPollSource =>
    createConnectionApiPollSource({
      listApiConnections: () => connections,
      hasReconciler: (v, e, c) => hasReconciler(v, e, c),
      poll: async (input) => {
        pollCalls.push(input);
        const next = pollOutcomes.shift();
        if (!next) throw new Error('test: no scripted poll outcome');
        return next;
      },
    });

  const makeManager = (overrides: Partial<PollManagerDeps> = {}): PollManagerHandle =>
    createWatchPollManager({
      store,
      triggersStore: { listEnabled: () => triggers.filter((t) => t.enabled) },
      sources: [makeConnectionApiSource()],
      bus,
      eventBus: {
        emit: (event: { kind: string }) => {
          busEmits.push(event as { kind: string; mechanism?: string });
          return event as never;
        },
      } as never,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      initialPollDelayMs: 5,
      ...overrides,
    });

  describe('demand derivation', () => {
    it('arms one loop per (vendor, entity) x matching connection; non-watch patterns create no demand', () => {
      triggers = [
        trigger(),
        trigger({ trigger_id: 't-2', pattern: 'data.mail.**.created' }),
        trigger({ trigger_id: 't-3', pattern: 'data.connection.api.*.deal.**' }), // wildcard vendor — not watchable
      ];
      connections = [
        { name: 'main-crm', vendor: 'hubspot' },
        { name: 'second-crm', vendor: 'hubspot' },
        { name: 'sf', vendor: 'salesforce' },
        { name: 'no-vendor', vendor: undefined },
      ];
      const manager = makeManager();
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(2);
      const keys = manager.listEntries().map((e) => e.watch_key).sort();
      expect(keys).toEqual(['hubspot/deal/main-crm', 'hubspot/deal/second-crm']);
    });

    it('a literal connection segment NARROWS demand to that connection (codex fold)', () => {
      triggers = [
        trigger({ pattern: 'data.connection.api.hubspot.deal.main-crm.deal.updated' }),
      ];
      connections = [
        { name: 'main-crm', vendor: 'hubspot' },
        { name: 'second-crm', vendor: 'hubspot' },
      ];
      const manager = makeManager();
      manager.recompute();
      expect(manager.listEntries().map((e) => e.watch_key)).toEqual([
        'hubspot/deal/main-crm',
      ]);
    });

    it('a narrowed and a vendor-wide demand on the same key merge subscribers + keep the tighter interval', () => {
      triggers = [
        trigger({
          trigger_id: 't-narrow',
          recipe_id: 'narrow-recipe',
          pattern: 'data.connection.api.hubspot.deal.main-crm.deal.updated',
          watch_interval_ms: 6 * 60_000,
        }),
        trigger({ trigger_id: 't-wide' }),
      ];
      const manager = makeManager();
      manager.recompute();
      const entry = manager
        .listEntries()
        .find((e) => e.watch_key === 'hubspot/deal/main-crm')!;
      expect(entry.subscriber_recipe_ids).toEqual([
        'narrow-recipe',
        'surface-stalling-deals-hubspot',
      ]);
      expect(entry.effective_interval_ms).toBe(6 * 60_000);
    });

    it('uses min over subscriber interval prefs, floored', () => {
      triggers = [
        trigger({ watch_interval_ms: 60_000 }), // below the floor
        trigger({ trigger_id: 't-2', watch_interval_ms: 30 * 60_000 }),
      ];
      const manager = makeManager({ intervalFloorMs: 5 * 60_000 });
      manager.recompute();
      const entry = manager.listEntries()[0]!;
      expect(entry.effective_interval_ms).toBe(5 * 60_000);
      expect(entry.subscriber_recipe_ids).toEqual(['surface-stalling-deals-hubspot']);
    });

    it('defers keys covered by a kernel reconciler — no loop, listed with deferred_to', () => {
      hasReconciler = (v, e, c) => v === 'hubspot' && e === 'deal' && c === 'main-crm';
      const manager = makeManager();
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(0);
      const entry = manager.listEntries()[0]!;
      expect(entry.deferred_to).toBe('reconciler');
      expect(entry.active).toBe(false);
    });

    it('a second registered source arms its own keys; entries carry source_id', async () => {
      const fakePolls: string[] = [];
      const cliSource: WatchPollSource = {
        source_id: 'cli',
        deriveDemands: () => [
          {
            watch_key: 'cli/disk_report/laptop',
            vendor: 'cli',
            entity: 'disk_report',
            connection_name: 'laptop',
            recipe_ids: ['disk-watch'],
            interval_ms: 10 * 60_000,
            deferred_to: null,
          },
        ],
        poll: async (target) => {
          fakePolls.push(target.connection_name);
          return okOutcome({ r1: { id: 'r1', pct: 80 } });
        },
      };
      const manager = makeManager({ sources: [makeConnectionApiSource(), cliSource] });
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(2);
      const byKey = new Map(manager.listEntries().map((e) => [e.watch_key, e] as const));
      expect(byKey.get('hubspot/deal/main-crm')?.source_id).toBe('connection-api');
      expect(byKey.get('cli/disk_report/laptop')?.source_id).toBe('cli');

      // The cli key's tick fetches through ITS source, not connection-api.
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireAll();
      expect(fakePolls).toEqual(['laptop']);
      expect(pollCalls.map((c) => c.connection_name)).toEqual(['main-crm']);
    });

    it('a cross-source key collision keeps the first claimant and warns', () => {
      const warnings: string[] = [];
      const usurper: WatchPollSource = {
        source_id: 'usurper',
        deriveDemands: () => [
          {
            watch_key: KEY,
            vendor: 'hubspot',
            entity: 'deal',
            connection_name: 'main-crm',
            recipe_ids: ['other'],
            interval_ms: 10 * 60_000,
            deferred_to: null,
          },
        ],
        poll: async () => {
          throw new Error('the duplicate must never poll');
        },
      };
      const manager = makeManager({
        sources: [makeConnectionApiSource(), usurper],
        log: (_level, msg) => warnings.push(msg),
      });
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(1);
      expect(manager.listEntries()[0]?.source_id).toBe('connection-api');
      expect(warnings.some((w) => w.includes('usurper'))).toBe(true);
    });

    it('prunes state + snapshot when the last subscriber leaves', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();
      expect(store.snapshotCount(KEY)).toBe(1);

      triggers = [];
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(0);
      expect(manager.listEntries()).toEqual([]);
      expect(store.getState(KEY)).toBeNull();
      expect(store.snapshotCount(KEY)).toBe(0);
    });
  });

  describe('baseline suppression + diff emission', () => {
    it('first poll persists the snapshot WITHOUT firing; second poll diffs', async () => {
      const manager = makeManager();
      manager.recompute();

      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open', amount: 100 } }));
      await timers.fireLatest();
      expect(emitted).toEqual([]);
      expect(store.getState(KEY)?.baselined).toBe(true);
      expect(store.snapshotCount(KEY)).toBe(1);

      pollOutcomes.push(
        okOutcome({
          d1: { id: 'd1', stage: 'won', amount: 100 },
          d2: { id: 'd2', stage: 'open', amount: 5 },
        }),
      );
      await timers.fireLatest();

      expect(emitted).toHaveLength(2);
      const updated = emitted.find((e) => e.event_kind === 'updated')!;
      expect(updated.platform).toBe('connection.api.hubspot.deal');
      expect(updated.slug).toBe('main-crm');
      expect(updated.entity_type).toBe('deal');
      expect(updated.record_id).toBe('d1');
      expect(updated.prev).toEqual({ id: 'd1', stage: 'open', amount: 100 });
      expect(updated.record).toEqual({ id: 'd1', stage: 'won', amount: 100 });
      expect(updated.changed_fields).toEqual(['stage']);
      const created = emitted.find((e) => e.event_kind === 'created')!;
      expect(created.record_id).toBe('d2');
      expect(created.record).toEqual({ id: 'd2', stage: 'open', amount: 5 });
      expect(created.prev).toBeUndefined();
    });

    it('baseline survives a manager rebuild (restart posture) — no re-fire of the world', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();
      await manager.stop();

      // "Restart": a FRESH manager over the same SQLite store.
      const manager2 = makeManager();
      manager2.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();
      expect(emitted).toEqual([]); // unchanged record, baselined → silent

      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      expect(emitted.map((e) => e.event_kind)).toEqual(['updated']);
      await manager2.stop();
    });

    it('emits deleted (with prev) on a COMPLETE walk only', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' }, d2: { id: 'd2', stage: 'open' } }));
      await timers.fireLatest();

      // Truncated walk missing d2 — absence proves nothing: no delete,
      // snapshot keeps d2.
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }, true));
      await timers.fireLatest();
      expect(emitted).toEqual([]);
      expect(store.snapshotCount(KEY)).toBe(2);

      // Complete walk missing d2 — now it's a real deletion.
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();
      expect(emitted.map((e) => e.event_kind)).toEqual(['deleted']);
      expect(emitted[0]!.record_id).toBe('d2');
      expect(emitted[0]!.prev).toEqual({ id: 'd2', stage: 'open' });
      expect(store.snapshotCount(KEY)).toBe(1);
    });
  });

  describe('error handling + governance', () => {
    it('error-cap auto-disables the watch and emits automation_rule_changed(watch)', async () => {
      const manager = makeManager({ errorCap: 2 });
      manager.recompute();

      pollOutcomes.push({ ok: false, kind: 'error', reason: 'boom 1' });
      await timers.fireLatest();
      expect(store.getState(KEY)?.consecutive_failures).toBe(1);
      expect(manager.activeLoopCount()).toBe(1);

      pollOutcomes.push({ ok: false, kind: 'error', reason: 'boom 2' });
      await timers.fireLatest();
      const state = store.getState(KEY)!;
      expect(state.enabled).toBe(false);
      expect(state.last_error).toBe('boom 2');
      expect(manager.activeLoopCount()).toBe(0);
      expect(busEmits).toContainEqual(
        expect.objectContaining({ kind: 'automation_rule_changed', mechanism: 'watch' }),
      );
    });

    it('setEnabled(true) re-arms an error-capped watch and clears the counter', async () => {
      const manager = makeManager({ errorCap: 1 });
      manager.recompute();
      pollOutcomes.push({ ok: false, kind: 'error', reason: 'boom' });
      await timers.fireLatest();
      expect(manager.activeLoopCount()).toBe(0);

      const entry = manager.setEnabled(KEY, true);
      expect(entry?.enabled).toBe(true);
      expect(entry?.consecutive_failures).toBe(0);
      expect(entry?.last_error).toBeNull();
      expect(manager.activeLoopCount()).toBe(1);
    });

    it('setEnabled(false) pauses (loop disarmed, snapshot kept); resume diffs across the pause', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();

      expect(manager.setEnabled(KEY, false)?.active).toBe(false);
      expect(manager.activeLoopCount()).toBe(0);
      expect(store.snapshotCount(KEY)).toBe(1);

      manager.setEnabled(KEY, true);
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      expect(emitted.map((e) => e.event_kind)).toEqual(['updated']);
    });

    it('returns null for an unknown watch key', () => {
      const manager = makeManager();
      manager.recompute();
      expect(manager.setEnabled('nope/nope/nope', false)).toBeNull();
    });

    it('reports a timer poll whose failure cannot be persisted without an unhandled rejection', async () => {
      const accountingFailure = new Error('watch error store unavailable');
      const warnings: string[] = [];
      const failingStore: WatchStore = {
        ...store,
        recordPollError: () => { throw accountingFailure; },
      };
      const manager = makeManager({
        store: failingStore,
        log: (_level, message) => warnings.push(message),
      });
      manager.recompute();
      pollOutcomes.push({ ok: false, kind: 'error', reason: 'provider unavailable' });

      await timers.fireLatest();

      expect(warnings).toEqual([
        `watch '${KEY}' background poll rejected: watch error store unavailable`,
      ]);
      expect(manager.inFlight()).toBe(false);
      await manager.stop();
    });

    it('keeps pollNow failure ownership with its caller without a rejected cleanup chain', async () => {
      const accountingFailure = new Error('watch error store unavailable');
      const failingStore: WatchStore = {
        ...store,
        recordPollError: () => { throw accountingFailure; },
      };
      const manager = makeManager({ store: failingStore });
      manager.recompute();
      pollOutcomes.push({ ok: false, kind: 'error', reason: 'provider unavailable' });

      await expect(manager.pollNow(KEY)).rejects.toBe(accountingFailure);
      expect(manager.inFlight()).toBe(false);
      await manager.stop();
    });
  });

  describe('codex folds — in-flight staleness + commit-before-emit', () => {
    it('a poll completing AFTER a pause discards its result (no emit, no commit)', async () => {
      const manager = makeManager();
      manager.recompute();
      // Baseline first.
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();

      // Slow second poll: the pause lands while it is in flight.
      let releasePoll!: (outcome: CanonicalPollOutcome) => void;
      pollOutcomes.push(
        new Promise<CanonicalPollOutcome>((resolve) => {
          releasePoll = resolve;
        }),
      );
      const fired = timers.pending()[0]!;
      fired.cleared = true;
      fired.handler();
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.inFlight()).toBe(true);

      manager.setEnabled(KEY, false);
      expect(manager.activeLoopCount()).toBe(0);

      releasePoll(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(emitted).toEqual([]); // result discarded — no post-pause fire
      // Snapshot unchanged — resume diffs from the pre-pause state.
      expect(store.loadSnapshot(KEY).get('d1')!.record).toEqual({ id: 'd1', stage: 'open' });
    });

    it('a snapshot-commit failure emits NOTHING (commit-before-emit, at-most-once)', async () => {
      const manager = makeManager({ errorCap: 99 });
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();

      const failingCommit = vi
        .spyOn(store, 'commitSnapshot')
        .mockImplementation(() => {
          throw new Error('disk full');
        });
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      failingCommit.mockRestore();

      expect(emitted).toEqual([]); // never emitted the un-persisted diff
      expect(store.getState(KEY)?.last_error).toContain('disk full');

      // Next successful poll re-detects the SAME change exactly once.
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      expect(emitted.map((e) => e.event_kind)).toEqual(['updated']);
    });
  });

  describe('R21.1 — vault-locked gating', () => {
    it('recompute() while the vault is sealed disarms every loop and arms nothing', () => {
      let locked = false;
      const manager = makeManager({ isVaultUnlocked: () => !locked });
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(1);

      locked = true;
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(0);
      // Still DEMANDED — it just isn't armed while sealed (governance
      // surface keeps listing it).
      expect(manager.listEntries().map((e) => e.watch_key)).toEqual([KEY]);

      locked = false;
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(1);
    });

    it('a timer firing while sealed DISARMS the loop so the unlock recompute re-creates + polls it', async () => {
      let locked = false;
      const manager = makeManager({ isVaultUnlocked: () => !locked });
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest(); // baseline, unlocked
      expect(manager.activeLoopCount()).toBe(1);

      // Lock, then let the armed timer fire while sealed. The tick must
      // skip the poll AND disarm — a bare return would strand a timerless
      // loop that recompute() never re-schedules (permanently dormant).
      locked = true;
      await timers.fireLatest();
      expect(pollCalls).toHaveLength(1); // no poll while sealed
      expect(manager.activeLoopCount()).toBe(0); // disarmed, not dormant

      // Unlock → the coordinator calls recompute(); the loop must re-arm
      // and actually poll again.
      locked = false;
      manager.recompute();
      expect(manager.activeLoopCount()).toBe(1);
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      expect(pollCalls).toHaveLength(2);
      expect(emitted.map((e) => e.event_kind)).toEqual(['updated']);
    });

    it('a poll completing AFTER a lock discards its result so the snapshot never advances', async () => {
      let locked = false;
      const manager = makeManager({ isVaultUnlocked: () => !locked });
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest();

      // Slow second poll: the lock lands while it is in flight.
      let releasePoll!: (outcome: CanonicalPollOutcome) => void;
      pollOutcomes.push(
        new Promise<CanonicalPollOutcome>((resolve) => {
          releasePoll = resolve;
        }),
      );
      const fired = timers.pending()[0]!;
      fired.cleared = true;
      fired.handler();
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.inFlight()).toBe(true);

      locked = true; // vault sealed mid-poll
      releasePoll(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Dropped: committing would advance past a change whose event the
      // dispatcher then seals + drops — losing it forever.
      expect(emitted).toEqual([]);
      expect(store.loadSnapshot(KEY).get('d1')!.record).toEqual({ id: 'd1', stage: 'open' });

      // Unlock + recompute (the coordinator) → re-arm → re-detect once.
      locked = false;
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await timers.fireLatest();
      expect(emitted.map((e) => e.event_kind)).toEqual(['updated']);
    });
  });

  describe('pollNow (Run-Now affordance)', () => {
    it('runs the poll immediately and resolves after it lands', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await manager.pollNow(KEY);
      expect(pollCalls).toHaveLength(1);
      expect(store.getState(KEY)?.baselined).toBe(true);
    });

    it('AWAITS an in-flight poll instead of resolving before its result lands (codex MEDIUM fold)', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1', stage: 'open' } }));
      await timers.fireLatest(); // baseline

      // Slow second poll, started by the timer.
      let releasePoll!: (outcome: CanonicalPollOutcome) => void;
      pollOutcomes.push(
        new Promise<CanonicalPollOutcome>((resolve) => {
          releasePoll = resolve;
        }),
      );
      const fired = timers.pending()[0]!;
      fired.cleared = true;
      fired.handler();
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.inFlight()).toBe(true);

      let settled = false;
      const runNow = manager.pollNow(KEY).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      // Still waiting on the in-flight poll — and no SECOND fetch fired.
      expect(settled).toBe(false);
      expect(pollCalls).toHaveLength(2);

      releasePoll(okOutcome({ d1: { id: 'd1', stage: 'won' } }));
      await runNow;
      expect(settled).toBe(true);
      // The awaited run's result is visible to a post-pollNow read.
      expect(store.loadSnapshot(KEY).get('d1')!.record).toEqual({ id: 'd1', stage: 'won' });
      expect(pollCalls).toHaveLength(2);
    });

    it('no-ops on a key without an armed loop', async () => {
      const manager = makeManager();
      manager.recompute();
      manager.setEnabled(KEY, false);
      await manager.pollNow(KEY);
      expect(pollCalls).toHaveLength(0);
    });
  });

  describe('lifecycle', () => {
    it('stop() disarms all timers and recompute() re-arms (maintenance-exit posture)', async () => {
      const manager = makeManager();
      manager.recompute();
      expect(timers.pending()).toHaveLength(1);

      await manager.stop();
      expect(manager.activeLoopCount()).toBe(0);
      expect(timers.pending()).toHaveLength(0);

      manager.recompute();
      expect(manager.activeLoopCount()).toBe(1);
      expect(timers.pending()).toHaveLength(1);
    });

    it('a tick on a key whose demand vanished recomputes instead of polling', async () => {
      const manager = makeManager();
      manager.recompute();
      triggers = []; // demand gone, no recompute signal (the missed-signal case)
      await timers.fireLatest();
      expect(pollCalls).toEqual([]);
      expect(manager.activeLoopCount()).toBe(0);
    });

    it('reschedules the next tick at the effective interval after a poll', async () => {
      const manager = makeManager();
      manager.recompute();
      pollOutcomes.push(okOutcome({ d1: { id: 'd1' } }));
      await timers.fireLatest();
      const next = timers.pending();
      expect(next).toHaveLength(1);
      expect(next[0]!.delayMs).toBe(15 * 60_000);
      await manager.stop();
    });

    it('emits automation_rule_changed(watch) when the armed set changes after the boot compute', () => {
      const manager = makeManager();
      manager.recompute(); // boot baseline — silent
      expect(busEmits).toEqual([]);
      connections = [
        { name: 'main-crm', vendor: 'hubspot' },
        { name: 'second-crm', vendor: 'hubspot' },
      ];
      manager.recompute();
      expect(busEmits).toContainEqual(
        expect.objectContaining({ kind: 'automation_rule_changed', mechanism: 'watch' }),
      );
    });
  });
});

describe('diffChangedFields', () => {
  it('reports dotted leaf paths across nesting, sorted', () => {
    expect(
      diffChangedFields(
        { stage: 'open', key_dates: { close_date: 1, created_at: 2 }, amount: 5 },
        { stage: 'won', key_dates: { close_date: 9, created_at: 2 }, amount: 5 },
      ),
    ).toEqual(['key_dates.close_date', 'stage']);
  });

  it('treats added + removed leaves as changes and compares arrays by value', () => {
    expect(diffChangedFields({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(diffChangedFields({ a: [1, 2] }, { a: [2, 1], b: 'x' })).toEqual(['a', 'b']);
    expect(diffChangedFields({ gone: 1 }, {})).toEqual(['gone']);
  });
});
