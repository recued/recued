/** D-139 slice 3 — the record-aggregate tasks actually PRODUCE.
 *
 *  ## Why this test is shaped the way it is
 *
 *  This whole arc exists because eleven kernels were built, unit-tested and
 *  never called. A suite that asserts the kernels compute correctly is
 *  exactly the suite that already existed while nothing ran. So the
 *  assertions here are deliberately about the SEAM, not the arithmetic:
 *
 *    - the task is REGISTERED (in `STANDALONE_TASKS`, which the bin iterates)
 *    - running its `step()` lands a real row in `data_enrichment`
 *    - under the canonical `system.housekeeping.<topic>` author that the
 *      shipped alert recipes filter on
 *    - carrying a value that varies with the engagement rows, so a constant
 *      would fail
 *
 *  ⛔ AND IT RUNS THROUGH THE REAL RESOLVER. `ctx.resolveRecordEngagements`
 *  is built by the production `buildRecordEngagementsDeps` over a real
 *  `EngagementStore` and a real `EnrichmentStore` — not a stub returning
 *  canned rows. A stub here would test the stub: the failure this arc is
 *  about was never "the kernel computes wrong", it was "nothing joins the
 *  record to its engagements", and only the real join can show that. The
 *  connection store is faked because connection ENROLLMENT is not what is
 *  under test; it only feeds coverage's `sources_connected`. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type EngagementsForRecordArgs,
  composePlatformRecordTargetId,
  type EngagementRow,
  type EngagementSilenceDurationValue,
  type EnrichmentScope,
} from '@recued/contracts';

import { createEngagementStore, type EngagementStore } from '../storage/engagement-store.js';
import { createEnrichmentStore, type EnrichmentStore } from '../storage/enrichment-store.js';
import { buildRecordEngagementsDeps, type EngagementsResolverDepsInput } from '../engagement-resolver-deps.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import { RECORD_AGGREGATE_TASKS } from '../housekeeping/engagement-aggregates/record-aggregate-tasks.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const NOW = 1_714_867_200_000;
const DAY = 24 * 60 * 60 * 1000;
const SCOPE = 'connection.api.hubspot.deal' as EnrichmentScope;
const DEAL = composePlatformRecordTargetId('hubspot', 'deal', 'acme-hubspot', '47291');

const fakeConnectionStore = (): EngagementsResolverDepsInput['connectionStore'] =>
  ({
    list: () => [
      {
        pk: 'api:acme-hubspot',
        kind: 'api',
        name: 'acme-hubspot',
        display_name: 'acme-hubspot',
        config_json: JSON.stringify({ vendor: 'hubspot' }),
        auth_ciphertext: '',
        enrolled_at: 0,
        updated_at: 0,
      },
    ],
  }) as unknown as EngagementsResolverDepsInput['connectionStore'];

describe('D-139 slice 3 — record-aggregate tasks', () => {
  let dir: string;
  let db: Database.Database;
  let enrichmentStore: EnrichmentStore;
  let engagementStore: EngagementStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'd139-slice3-'));
    db = new Database(join(dir, 'test.db'));
    enrichmentStore = createEnrichmentStore(db);
    engagementStore = createEngagementStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A deal record the walk can find — scope / target_id / meta only. */
  const seedDeal = (target_id: string): void => {
    db.prepare(
      `INSERT INTO data_enrichment
         (_id, topic, scope, target_id, authored_by, ingested_at, authored_at, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `seed:${target_id}`,
      'lifecycle_stage_inferred',
      SCOPE,
      target_id,
      'seed',
      NOW,
      NOW,
      JSON.stringify({ snapshot_at: NOW, snapshot_hash: `h:${target_id}`, dealname: 'Acme Q4' }),
    );
  };

  /** An inbound engagement hung off the deal by a real edge. */
  const seedEngagement = (
    id: string,
    event_at: number,
    overrides: Partial<EngagementRow> = {},
  ): void => {
    engagementStore.upsert({
      row: {
        connection_id: 'acme-hubspot',
        target_id: id,
        vendor: 'hubspot',
        entity: 'email',
        meta: {},
        mirror_blob_hash: null,
        authorship: 'user',
        direction: 'inbound',
        dedupe_confidence: 'none',
        lifecycle_state: 'point_in_time',
        event_at,
        vendor_created_at: event_at,
        vendor_modified_at: event_at,
        ingested_at: NOW,
        body_state: 'none',
        ...overrides,
      },
    });
    engagementStore.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: id,
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: DEAL,
      vendor: 'hubspot',
      created_at: NOW,
    });
  };

  const makeCtx = (): HousekeepingContext => {
    const recordDeps = buildRecordEngagementsDeps({
      db,
      contactStore: { get: () => null, addressSet: () => [] } as never,
      connectionStore: fakeConnectionStore(),
      now: () => NOW,
    });
    return {
      db,
      bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined },
      enrichmentStore,
      recipeStore: {},
      now: () => NOW,
      emitAuditRow: () => undefined,
      resolveRecordEngagements: (args: EngagementsForRecordArgs) =>
        engagementStore.resolveEngagementsForRecord(args, recordDeps(args)),
    } as unknown as HousekeepingContext;
  };

  const readValue = <T>(topic: string): T | undefined => {
    const rows = enrichmentStore.list({
      topic: topic as never,
      scope: SCOPE,
      target_id: DEAL,
      authored_by: `system.housekeeping.${topic}`,
      limit: 1,
    });
    return rows[0]?.value as T | undefined;
  };

  // ── Registration ────────────────────────────────────────────

  it('all six tasks are in STANDALONE_TASKS — the array the bin iterates', () => {
    const registered = new Set(STANDALONE_TASKS.map((t) => t.meta.id));
    for (const task of RECORD_AGGREGATE_TASKS) {
      expect(registered.has(task.meta.id), `${task.meta.id} not registered`).toBe(true);
    }
    expect(RECORD_AGGREGATE_TASKS).toHaveLength(6);
  });

  it('every task declares its topic and is marked deterministic', () => {
    for (const task of RECORD_AGGREGATE_TASKS) {
      expect(task.topic, task.meta.id).toBeDefined();
      // Deterministic ⇒ `'auto'` trust default and the pause-AI window does
      // not apply. A true here would strand the topic behind a promotion
      // banner that reactive-shaped topics can never satisfy.
      expect(task.is_ai_surface, task.meta.id).toBe(false);
      expect(task.meta.id).toBe(`enrichment.${task.topic}`);
    }
  });

  // ── The seam: does running it write a row? ──────────────────

  it('running the silence task produces a row under the canonical housekeeping author', async () => {
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 10 * DAY);
    const ctx = makeCtx();

    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    const result = await task.step(ctx, { kind: 'complete' }, 5_000);
    expect(result.status).toBe('complete');

    const value = readValue<EngagementSilenceDurationValue>('engagement_silence_duration');
    expect(value, 'no row was written — the task ran and produced nothing').toBeDefined();
    expect(value!.days).toBe(10);
    expect(value!.last_inbound_event_at).toBe(NOW - 10 * DAY);
  });

  it('the value tracks the DATA — a different newest inbound gives a different answer', async () => {
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 10 * DAY);
    seedEngagement('e2', NOW - 3 * DAY);
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(makeCtx(), { kind: 'complete' }, 5_000);

    // 3, not 10 — pins that the row is computed rather than defaulted. A
    // constant-writing producer passes the previous test and fails this one.
    expect(readValue<EngagementSilenceDurationValue>('engagement_silence_duration')!.days).toBe(3);
  });

  it('honours the evidence filters — an OUTBOUND row does not reset the silence clock', async () => {
    seedDeal(DEAL);
    seedEngagement('inbound', NOW - 20 * DAY);
    seedEngagement('our_followup', NOW - 1 * DAY, { direction: 'outbound' });
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(makeCtx(), { kind: 'complete' }, 5_000);

    // 20, not 1. "Have THEY gone quiet" must not be answered by our own
    // follow-up — the filter is declared at the task spec and re-checked in
    // the kernel, and this asserts the pair actually reaches the query.
    expect(readValue<EngagementSilenceDurationValue>('engagement_silence_duration')!.days).toBe(20);
  });

  it('a tracking-pixel (crm_automation) row is not somebody replying', async () => {
    seedDeal(DEAL);
    seedEngagement('real', NOW - 15 * DAY);
    seedEngagement('pixel', NOW - 1 * DAY, { authorship: 'crm_automation' });
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(makeCtx(), { kind: 'complete' }, 5_000);

    expect(readValue<EngagementSilenceDurationValue>('engagement_silence_duration')!.days).toBe(15);
  });

  it('a deal with NO engagements writes an honest zero, not nothing', async () => {
    seedDeal(DEAL);
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(makeCtx(), { kind: 'complete' }, 5_000);

    const value = readValue<EngagementSilenceDurationValue>('engagement_silence_duration');
    expect(value).toBeDefined();
    expect(value!.days).toBe(0);
    // The pair that distinguishes "they replied today" from "nothing to
    // measure": a real reply carries a real timestamp.
    expect(value!.last_inbound_event_at).toBe(0);
  });

  it('every deal-rooted task produces for a seeded deal', async () => {
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 5 * DAY);
    seedEngagement('e2', NOW - 40 * DAY, { direction: 'outbound' });
    const ctx = makeCtx();

    const dealTasks = RECORD_AGGREGATE_TASKS.filter((t) => t.topic !== 'account_reentry_signal');
    for (const task of dealTasks) {
      await task.step(ctx, { kind: 'complete' }, 5_000);
      const rows = enrichmentStore.list({
        topic: task.topic as never,
        scope: SCOPE,
        target_id: DEAL,
        authored_by: `system.housekeeping.${task.topic!}`,
        limit: 1,
      });
      expect(rows.length, `${task.topic} produced no row`).toBe(1);
    }
  });

  // ── The no-op posture ───────────────────────────────────────

  it('no resolver wired ⇒ the task writes NOTHING (it does not default)', async () => {
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 10 * DAY);
    const ctx = makeCtx();
    delete (ctx as { resolveRecordEngagements?: unknown }).resolveRecordEngagements;

    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(ctx, { kind: 'complete' }, 5_000);

    // ⛔ The whole point. An unwired engagement substrate must produce NO
    // row, never a `days: 0` row — "we didn't look" and "they replied
    // today" are different claims, and writing the second when the first is
    // true is the defect that got five recipes withdrawn.
    //
    // ⚠ TWO guards enforce this (the cycle's early return AND
    // `processOneAggregateRecord`'s own), so removing EITHER ONE leaves this
    // test green — measured, both ways. Only removing BOTH reddens it. That
    // is defence in depth working, but it means a single-guard regression is
    // invisible here; if you delete one, delete the other's test too or you
    // are protected by an accident.
    expect(readValue('engagement_silence_duration')).toBeUndefined();
  });

  it('⛔ a cycle where EVERY record fails must NOT report complete', async () => {
    // The gap this closes, measured rather than imagined: while building the
    // out-of-band producer, every record threw `meta_snapshot_invalid` and
    // the cycle returned `status: 'complete'` — a green task that had written
    // nothing. The counts existed; `step` discarded them.
    //
    // Here the enrichment store is made to reject every write. The per-record
    // catch still does its job (the walk is not aborted), but the task now
    // surfaces instead of reporting success.
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 10 * DAY);
    const ctx = makeCtx();
    (ctx as { enrichmentStore: { upsert: unknown } }).enrichmentStore = {
      ...enrichmentStore,
      upsert: () => { throw new Error('meta_snapshot_invalid: simulated'); },
      isScopeSupported: enrichmentStore.isScopeSupported.bind(enrichmentStore),
      list: enrichmentStore.list.bind(enrichmentStore),
    } as never;

    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await expect(task.step(ctx, { kind: 'complete' }, 5_000))
      .rejects.toThrow(/every record failed/);
  });

  it('a cycle with NOTHING to do still reports complete — absence is not failure', async () => {
    // ⚠ The counterpart assertion, and the reason the rule is "zero produced
    // AND at least one thrown" rather than "zero produced". A portal with no
    // deals yet must not redden the task; a task that cries wolf on an empty
    // warehouse trains the owner to ignore the light.
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    const result = await task.step(makeCtx(), { kind: 'complete' }, 5_000);
    expect(result.status).toBe('complete');
  });

  it('re-running is idempotent — one chain-head row, not a duplicate per cycle', async () => {
    seedDeal(DEAL);
    seedEngagement('e1', NOW - 10 * DAY);
    const ctx = makeCtx();
    const task = RECORD_AGGREGATE_TASKS.find((t) => t.topic === 'engagement_silence_duration')!;
    await task.step(ctx, { kind: 'complete' }, 5_000);
    await task.step(ctx, { kind: 'complete' }, 5_000);

    const rows = enrichmentStore.list({
      topic: 'engagement_silence_duration',
      scope: SCOPE,
      target_id: DEAL,
      authored_by: 'system.housekeeping.engagement_silence_duration',
      limit: 10,
    });
    expect(rows).toHaveLength(1);
  });
});
