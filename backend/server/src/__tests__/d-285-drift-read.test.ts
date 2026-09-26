/** D-285 — `housekeeping.drift.read`: the persisted drift signals.
 *
 *  ⛔ WHY THIS RPC EXISTS, AND WHY THE TEST COMPOSES WRITER → READER.
 *  Before D-285 the ONLY way a client learned of drift was the
 *  `enrichment_drift_detected` broadcast, and a broadcast is a moment rather
 *  than a state. Measured on a live paired browser, twice: the banner renders
 *  when the producer fires with the panel open, and is GONE after a reload in
 *  the same tab seconds later — `cursor_since` intact, the row still stored,
 *  the task's own last-run cell reading "5s ago". The verdict the owner's
 *  tokens paid for was visible only to whoever happened to be looking at that
 *  second.
 *
 *  So these cases drive the REAL producer over a REAL shifted distribution
 *  and read it back through the REAL handler. A test that hand-wrote a row
 *  and read it back would pass with the producer writing under a different
 *  key, which is the one composition that has to hold. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError } from '@recued/contracts';

import {
  CONFIDENCE_DRIFT_AUTHORED_BY,
  CONFIDENCE_DRIFT_TOPIC,
  processOneConfidenceDriftTopic,
} from '../housekeeping/index.js';
import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  handleHousekeepingDriftDismiss,
  handleHousekeepingDriftRead,
  type HousekeepingRpcDeps,
} from '../housekeeping-handler.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const DAY = 24 * 60 * 60_000;
const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let config: HousekeepingConfigStore;
let state: HousekeepingStateStore;

const ctx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
  // No event bus: the broadcast is exactly the path this rpc exists to stop
  // depending on, so the read must work with nothing listening.
  eventBus: undefined as never,
});

const deps = (over: Partial<HousekeepingRpcDeps> = {}): HousekeepingRpcDeps => ({
  config,
  state,
  registry: () => [],
  runOnce: async () => { throw new Error('runOnce not used by drift.read'); },
  enrichmentStore: store,
  // Deterministic clock — the dismissal stamps `deps.now?.() ?? Date.now()`,
  // and a real clock makes every timestamp assertion a moving target.
  now: () => NOW,
  ...over,
});

/** One `purpose` row at an explicit `authored_at` — the producer windows on
 *  that column, and `upsert` stamps `now()`, so it is set explicitly. */
const seedPurpose = (authored_at: number, confidence: number, target_id: string): void => {
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id,
    value: { category: 'request', confidence, reasoning: 'stub' },
    authored_by: 'system.housekeeping.purpose',
    model_id: 'model-under-test',
    event_at: authored_at,
  });
  db.prepare(
    `UPDATE data_enrichment SET authored_at = ? WHERE topic = 'purpose' AND target_id = ?`,
  ).run(authored_at, target_id);
};

/** A distribution that really moves: 5% low-confidence in the baseline window,
 *  45% in the recent one, one model throughout (D-279 withholds across a
 *  model-set change, which would make a silent no-fire look like a defect). */
const seedRealShift = (): void => {
  const earliest = NOW - 365 * DAY;
  for (let i = 0; i < 300; i += 1) {
    seedPurpose(earliest + i * 60_000, i < 15 ? 0.2 : 0.95, `base_${String(i)}`);
  }
  for (let i = 0; i < 100; i += 1) {
    seedPurpose(NOW - 3 * DAY + i * 60_000, i < 45 ? 0.2 : 0.95, `recent_${String(i)}`);
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-285-drift-read-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  config = createHousekeepingConfigStore(db);
  state = createHousekeepingStateStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-285 — housekeeping.drift.read', () => {
  it('returns what the producer actually wrote, keyed the way it writes it', async () => {
    seedRealShift();
    const outcome = processOneConfidenceDriftTopic(ctx(), 'purpose', NOW);
    expect(outcome.fired).not.toBeNull();

    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_topic).toBe('purpose');
    expect(rows[0]!.severity).toBe(outcome.fired);
    expect(rows[0]!.computed_at).toBe(NOW);
  });

  it('carries the windows + distributions the broadcast cannot', async () => {
    // ⛔ This is the difference that makes the drawer renderable. The event
    // payload has no bins — `driftSignalFromEvent` fills them with `[]` and
    // says so — so a read that returned only what the event carries would
    // leave the drawer exactly as dark as it was.
    seedRealShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', NOW);

    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows[0]!.baseline_distribution.length).toBeGreaterThan(0);
    expect(rows[0]!.recent_distribution.length).toBeGreaterThan(0);
    expect(rows[0]!.baseline_window.sample_count).toBe(300);
    expect(rows[0]!.recent_window.sample_count).toBe(100);
  });

  it('returns an empty list when the producer has never fired', async () => {
    // Not an error, and not a synthesised all-clear: nothing has been measured.
    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows).toEqual([]);
  });

  it('DROPS a value-less row rather than defaulting it to a clear verdict', async () => {
    // ⚠ `upsert` validates against the registry's `value_schema`, so garbage
    // cannot arrive through the writer — verified: handing it `{ not: 'a
    // signal' }` throws `EnrichmentValueInvalidError`. The reachable case is
    // the one the SCHEMA allows: `value` is nullable since D-136 P6, for
    // failure placeholders and for tombstones that NULL the column on cleanup.
    // Such a row is dropped, never read as a verdict — a `'none'` invented for
    // a row carrying no measurement is a false all-clear about the owner's AI,
    // the one failure this surface must not have.
    seedRealShift();
    processOneConfidenceDriftTopic(ctx(), 'purpose', NOW);
    db.prepare(
      `INSERT INTO data_enrichment
         (_id, topic, derived_entity_id, value, authored_by, ingested_at, authored_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).run('drift_tombstoned', CONFIDENCE_DRIFT_TOPIC, 'drift_tombstoned',
      CONFIDENCE_DRIFT_AUTHORED_BY, NOW, NOW);

    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows.map((r) => r.source_topic)).toEqual(['purpose']);
    expect(rows.some((r) => r.severity === 'none')).toBe(false);
  });

  it('refuses when no enrichment store is wired, rather than reporting calm', async () => {
    await expect(handleHousekeepingDriftRead(deps({ enrichmentStore: undefined })))
      .rejects.toBeInstanceOf(RpcError);
  });
});

describe('D-285 follow-up — the dismissal has to outlive the tab', () => {
  /** ⛔ WHAT WENT WRONG. D-285 made the panel LOAD the stored row on every
   *  mount while the dismissal was still `setState`, so the banner came back
   *  on every load — measured live: dismiss, reload, VISIBLE again. The read
   *  traded a verdict nobody saw for one nobody could get rid of. */
  const fire = () => {
    seedRealShift();
    const outcome = processOneConfidenceDriftTopic(ctx(), 'purpose', NOW);
    expect(outcome.fired).not.toBeNull();
  };

  it('persists, so the next READ already knows', async () => {
    fire();
    await handleHousekeepingDriftDismiss(deps(), { source_topic: 'purpose' });

    // Read it back the way a freshly-mounted panel would — no shared state
    // between the write and this call.
    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows[0]!.dismissed_at).toBe(NOW);
  });

  it('keeps the FIRST timestamp on a repeat, rather than sliding it forward', async () => {
    fire();
    await handleHousekeepingDriftDismiss(deps({ now: () => NOW }), { source_topic: 'purpose' });
    const second = await handleHousekeepingDriftDismiss(
      deps({ now: () => NOW + 60_000 }),
      { source_topic: 'purpose' },
    );
    // A double click or a retry must not rewrite when they waved it away.
    expect(second.effective.dismissed_at).toBe(NOW);
  });

  it('leaves the rest of the signal exactly as the producer wrote it', async () => {
    fire();
    const before = (await handleHousekeepingDriftRead(deps())).rows[0]!;
    const after = (await handleHousekeepingDriftDismiss(deps(), { source_topic: 'purpose' })).effective;

    expect({ ...after, dismissed_at: undefined })
      .toEqual({ ...before, dismissed_at: undefined });
  });

  it('refuses a topic with no stored signal instead of answering "fine"', async () => {
    // A dismissal for something the server does not hold means the client is
    // out of step; a silent ok would hide that behind a banner that keeps
    // coming back.
    fire();
    await expect(handleHousekeepingDriftDismiss(deps(), { source_topic: 'summary' }))
      .rejects.toBeInstanceOf(RpcError);
  });

  it('refuses an empty topic and a missing store', async () => {
    await expect(handleHousekeepingDriftDismiss(deps(), { source_topic: '' }))
      .rejects.toBeInstanceOf(RpcError);
    await expect(
      handleHousekeepingDriftDismiss(deps({ enrichmentStore: undefined }), { source_topic: 'purpose' }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('the PRODUCER carries the dismissal while severity holds — the re-arm rule', async () => {
    // 🔑 This is what scopes a dismissal to ONE computation, and the handler
    // leans on it: dismiss once, and later cycles that reach the same verdict
    // stay quiet, while a new severity raises the banner again.
    fire();
    await handleHousekeepingDriftDismiss(deps(), { source_topic: 'purpose' });

    processOneConfidenceDriftTopic(ctx(), 'purpose', NOW + 60_000);

    const { rows } = await handleHousekeepingDriftRead(deps());
    expect(rows[0]!.dismissed_at).toBe(NOW);
  });
});
