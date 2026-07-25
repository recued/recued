/** dom poll source (3rd WatchPollSource) — unit + manager integration.
 *
 *  Covers `deriveDemands` (dom-pattern parse, no-enrollment-gate
 *  derivation, coalescing, interval min-over-prefs, ignore non-dom),
 *  `poll` (entity decode → readDom → single-record wrap incl. the
 *  text:null appear/disappear case + read-error passthrough + undecodable
 *  entity), and the manager-core integration proving the dedicated `dom`
 *  event path emits via `event_scope` (NOT the connection-api scope —
 *  which would throw on the base64url entity) and round-trips to the
 *  subscriber's authored pattern. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { EventTrigger } from '@recued/contracts';
import {
  DOM_WATCH_CONNECTION,
  DOM_WATCH_POLL_SOURCE_ID,
  DOM_WATCH_VENDOR,
  encodeDomWatchTarget,
  watchKeyOf,
} from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';
import { eventPath, matchesPattern } from '@recued/warehouse-events';

import { createDomPollSource, type DomReadOutcome } from '../watch/dom-source.js';
import { createWatchPollManager, type PollManagerHandle } from '../watch/poll-manager.js';
import { createWatchStore } from '../watch/snapshot-store.js';

const URL_PATTERN = 'https://app.hubspot.com/contacts/*';
const SELECTOR = '#deal-amount';
const ENC = encodeDomWatchTarget(URL_PATTERN, SELECTOR);
const KEY = watchKeyOf(DOM_WATCH_VENDOR, ENC, DOM_WATCH_CONNECTION);

const trigger = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 't-1',
  recipe_id: 'watch-deal',
  publisher_id: 'local',
  pattern: `data.dom.element.${ENC}.updated`,
  enabled: true,
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
  origin: 'recipe',
  ...overrides,
});

const OPTS = { floorMs: 5 * 60_000, defaultMs: 15 * 60_000 };

describe('createDomPollSource — deriveDemands', () => {
  it('parses a dom pattern, derives one demand, sets event_scope', () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: 'x' }) });
    const demands = source.deriveDemands([trigger()], OPTS);
    expect(demands).toHaveLength(1);
    expect(demands[0]).toMatchObject({
      watch_key: KEY,
      vendor: DOM_WATCH_VENDOR,
      entity: ENC,
      connection_name: DOM_WATCH_CONNECTION,
      recipe_ids: ['watch-deal'],
      interval_ms: OPTS.defaultMs,
      deferred_to: null,
      event_scope: { platform: 'dom', slug: 'element', entity_type: ENC },
    });
  });

  it('ignores non-dom patterns', () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: 'x' }) });
    const demands = source.deriveDemands(
      [
        trigger({ trigger_id: 't-mail', pattern: 'data.mail.**.created' }),
        trigger({ trigger_id: 't-api', pattern: 'data.connection.api.hubspot.deal.**' }),
        trigger({ trigger_id: 't-wild', pattern: 'data.dom.element.*.updated' }),
      ],
      OPTS,
    );
    expect(demands).toEqual([]);
  });

  it('coalesces two triggers on the same (url, selector): merged subscribers, tighter interval', () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: 'x' }) });
    const demands = source.deriveDemands(
      [
        trigger({ trigger_id: 't-a', recipe_id: 'recipe-b', watch_interval_ms: 30 * 60_000 }),
        trigger({ trigger_id: 't-b', recipe_id: 'recipe-a', watch_interval_ms: 7 * 60_000 }),
      ],
      OPTS,
    );
    expect(demands).toHaveLength(1);
    expect(demands[0]!.recipe_ids).toEqual(['recipe-a', 'recipe-b']);
    expect(demands[0]!.interval_ms).toBe(7 * 60_000); // min, above the floor
  });

  it('floors the interval below the minimum', () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: 'x' }) });
    const demands = source.deriveDemands([trigger({ watch_interval_ms: 60_000 })], OPTS);
    expect(demands[0]!.interval_ms).toBe(OPTS.floorMs);
  });

  it('derives demand with NO bridge-enrollment gate (the fetch reports unavailability)', () => {
    // Unlike the mcp-resource source (gated on enrolled connections), a
    // dom watch derives from its pattern alone — a briefly-offline bridge
    // must not drop the demand (which would tear down the snapshot).
    // Unavailability surfaces at poll time as the non-error 'unavailable'
    // kind, NOT by withholding demand.
    const source = createDomPollSource({
      readDom: async () => ({ ok: false, kind: 'unavailable', reason: 'no eligible bridge' }),
    });
    expect(source.deriveDemands([trigger()], OPTS)).toHaveLength(1);
  });
});

describe('createDomPollSource — poll', () => {
  const target = { vendor: DOM_WATCH_VENDOR, entity: ENC, connection_name: DOM_WATCH_CONNECTION };

  it('decodes the entity, reads, and wraps one record keyed by the selector', async () => {
    const reads: Array<{ url_pattern: string; selector: string }> = [];
    const source = createDomPollSource({
      readDom: async (input) => {
        reads.push(input);
        return { ok: true, text: '€42,000' };
      },
    });
    const outcome = await source.poll(target);
    expect(reads).toEqual([{ url_pattern: URL_PATTERN, selector: SELECTOR }]);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.truncated).toBe(false);
    expect([...outcome.records.keys()]).toEqual([SELECTOR]);
    expect(outcome.records.get(SELECTOR)).toEqual({ text: '€42,000' });
  });

  it('treats a null text (absent selector) as a valid snapshot record, not an error', async () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: null }) });
    const outcome = await source.poll(target);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.records.get(SELECTOR)).toEqual({ text: null });
  });

  it('passes a read error straight through to the manager error path', async () => {
    const source = createDomPollSource({
      readDom: async (): Promise<DomReadOutcome> => ({
        ok: false,
        kind: 'error',
        reason: 'bridge transport failed',
      }),
    });
    expect(await source.poll(target)).toEqual({
      ok: false,
      kind: 'error',
      reason: 'bridge transport failed',
    });
  });

  it('forwards the non-error `unavailable` kind verbatim (no eligible bridge / closed tab)', async () => {
    const source = createDomPollSource({
      readDom: async (): Promise<DomReadOutcome> => ({
        ok: false,
        kind: 'unavailable',
        reason: 'no open tab matching the url pattern',
      }),
    });
    expect(await source.poll(target)).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'no open tab matching the url pattern',
    });
  });

  it('surfaces an undecodable entity as a config error (never crashes the tick)', async () => {
    const source = createDomPollSource({ readDom: async () => ({ ok: true, text: 'x' }) });
    const outcome = await source.poll({ ...target, entity: 'not.decodable' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.kind).toBe('config');
    expect(outcome.reason).toContain('not.decodable');
  });
});

// ────────────────────────────────────────────────────────────────
// Deterministic timer fake (mirrors watch-poll-manager.test.ts).
// ────────────────────────────────────────────────────────────────
const makeTimers = () => {
  const entries: Array<{ handler: () => void; token: number; cleared: boolean }> = [];
  let next = 1;
  return {
    setTimer: (handler: () => void): unknown => {
      const e = { handler, token: next++, cleared: false };
      entries.push(e);
      return e.token;
    },
    clearTimer: (token: unknown): void => {
      const e = entries.find((x) => x.token === token);
      if (e) e.cleared = true;
    },
    fireLatest: async (): Promise<void> => {
      const live = entries.filter((e) => !e.cleared);
      const e = live[live.length - 1];
      if (!e) throw new Error('no pending timer');
      e.cleared = true;
      e.handler();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
};

describe('dom source × poll-manager core — dom emit path', () => {
  it('baselines silently, then emits `updated` on the dom path the subscriber pattern matches', async () => {
    const db = new Database(':memory:');
    const store = createWatchStore(db);
    const emitted: WarehouseEvent[] = [];
    const bus: WarehouseEventBus = {
      emit: (e) => emitted.push(e),
      subscribe: () => () => {},
      dispose: () => {},
    };
    const timers = makeTimers();
    const reads: DomReadOutcome[] = [];
    const source = createDomPollSource({
      readDom: async () => {
        const next = reads.shift();
        if (!next) throw new Error('test: no scripted read');
        return next;
      },
    });
    const manager: PollManagerHandle = createWatchPollManager({
      store,
      triggersStore: { listEnabled: () => [trigger()] },
      sources: [source],
      bus,
      now: () => 100_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      initialPollDelayMs: 5,
    });

    manager.recompute();
    const entry = manager.listEntries().find((e) => e.watch_key === KEY)!;
    expect(entry.source_id).toBe(DOM_WATCH_POLL_SOURCE_ID);
    expect(entry.active).toBe(true);

    // Poll 1 — baseline persists WITHOUT firing.
    reads.push({ ok: true, text: '$1,000' });
    await timers.fireLatest();
    expect(emitted).toEqual([]);
    expect(store.snapshotCount(KEY)).toBe(1);

    // Poll 2 — element text changes → one `updated` event.
    reads.push({ ok: true, text: '$2,000' });
    await timers.fireLatest();
    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.platform).toBe('dom');
    expect(ev.slug).toBe('element');
    expect(ev.entity_type).toBe(ENC);
    expect(ev.event_kind).toBe('updated');
    expect(ev.record_id).toBe(SELECTOR);
    expect(ev.record).toEqual({ text: '$2,000' });
    expect(ev.prev).toEqual({ text: '$1,000' });

    // The emitted path matches the subscriber's authored pattern.
    const path = eventPath(ev.platform, ev.slug, ev.entity_type, ev.event_kind);
    expect(matchesPattern(`data.dom.element.${ENC}.**`, path)).toBe(true);

    await manager.stop();
    db.close();
  });

  it('a stream of `unavailable` polls never trips the error cap — the watch stays armed', async () => {
    // The bridge is offline / the watched tab is closed for many
    // intervals (the common resting state). The watch must NOT auto-
    // disable; it resumes the instant the client returns.
    const db = new Database(':memory:');
    const store = createWatchStore(db);
    const bus: WarehouseEventBus = { emit: () => {}, subscribe: () => () => {}, dispose: () => {} };
    const timers = makeTimers();
    const reads: DomReadOutcome[] = [];
    const source = createDomPollSource({
      readDom: async () => {
        const next = reads.shift();
        if (!next) throw new Error('test: no scripted read');
        return next;
      },
    });
    const manager: PollManagerHandle = createWatchPollManager({
      store,
      triggersStore: { listEnabled: () => [trigger()] },
      sources: [source],
      bus,
      now: () => 100_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      initialPollDelayMs: 5,
      errorCap: 2, // low cap — proves the skips don't accumulate against it
    });
    manager.recompute();

    // Five consecutive `unavailable` polls — well past errorCap=2.
    for (let i = 0; i < 5; i += 1) {
      reads.push({ ok: false, kind: 'unavailable', reason: 'no open tab' });
      await timers.fireLatest();
    }
    const entry = manager.listEntries().find((e) => e.watch_key === KEY)!;
    expect(entry.active).toBe(true); // still armed
    expect(entry.enabled).toBe(true); // never auto-disabled
    expect(entry.consecutive_failures).toBe(0); // skips don't count
    expect(store.snapshotCount(KEY)).toBe(0); // no baseline yet — nothing was read

    // The client returns: a real read baselines, then the next change fires.
    reads.push({ ok: true, text: 'v1' });
    await timers.fireLatest();
    expect(store.snapshotCount(KEY)).toBe(1);

    await manager.stop();
    db.close();
  });

  it('a stream of `error` polls DOES trip the error cap → auto-disable (the distinction)', async () => {
    const db = new Database(':memory:');
    const store = createWatchStore(db);
    const bus: WarehouseEventBus = { emit: () => {}, subscribe: () => () => {}, dispose: () => {} };
    const timers = makeTimers();
    const reads: DomReadOutcome[] = [];
    const source = createDomPollSource({
      readDom: async () => {
        const next = reads.shift();
        if (!next) throw new Error('test: no scripted read');
        return next;
      },
    });
    const manager: PollManagerHandle = createWatchPollManager({
      store,
      triggersStore: { listEnabled: () => [trigger()] },
      sources: [source],
      bus,
      now: () => 100_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      initialPollDelayMs: 5,
      errorCap: 2,
    });
    manager.recompute();

    for (let i = 0; i < 2; i += 1) {
      reads.push({ ok: false, kind: 'error', reason: 'bridge transport failed' });
      await timers.fireLatest();
    }
    const entry = manager.listEntries().find((e) => e.watch_key === KEY)!;
    expect(entry.enabled).toBe(false); // real failures DO auto-disable
    expect(entry.consecutive_failures).toBe(2);

    await manager.stop();
    db.close();
  });
});
