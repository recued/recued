/** D-139 slice 3 — the dispatch shell for RECORD-rooted engagement
 *  aggregates.
 *
 *  ## What was missing
 *
 *  D-139 P3/P4 shipped eleven pure-compute kernels under this directory,
 *  every one tested, and not one of them had a production caller. Two
 *  things were absent: a way to get a deal's `EngagementRow[]` (slice 2's
 *  `resolveEngagementsForRecord`) and something to call the kernel on a
 *  schedule. This is the second half.
 *
 *  ## Why a FACTORY and not one task per topic
 *
 *  Five of the kernels are the same function shape —
 *  `{ rows, coverage, now } → { value, coverage }` — walking the same
 *  table over the same scopes with the same cap, cursor and upsert. Written
 *  out per topic that is five near-identical 150-line files, and the fifth
 *  copy stops honouring whatever the first one learns. A topic is a DATA
 *  entry here: alias, window, evidence filters, kernel.
 *
 *  ⛔ Kernels that DON'T fit this shape must not be forced into it. Three
 *  need a projected row type (`account_engagement_breadth`,
 *  `champion_deal_count`, `multi_account_contact`), one needs cross-source
 *  input (`out_of_band_engagement`: mail rows × CRM rows × per-contact deal
 *  confidence), and the two AI kernels carry their own
 *  `runAIProducer` dispatch with dedup probe + force-layer. Those get their
 *  own shells; widening this one with optional hooks until it covers them
 *  would make every caller pay for every other caller's shape.
 *
 *  ## Honest coverage
 *
 *  The resolver returns the coverage its deps composed (source enrollment,
 *  degradation, per-source row counts over the SAME edge predicate the
 *  query used). The kernel may narrow it further. Whatever comes back is
 *  what gets written — the producer never fabricates a coverage claim, and
 *  a record whose sources are unreadable says so instead of writing a
 *  confident zero. That distinction is the whole reason § A.9.3 exists,
 *  and getting it wrong is what made the withdrawn self-relay recipes
 *  harmful rather than merely idle.
 *
 *  Spec: D-139 § A.9.1 / § A.9.2b / § A.9.3. */

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  scopesForCrmAlias,
  type Authorship,
  type CoverageMetadata,
  type CrmAlias,
  type Direction,
  type EngagementLifecycleState,
  type EngagementRow,
  type EnrichmentMeta,
  type EnrichmentScope,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';

/** Hard cap on records walked per (topic, cycle). Deterministic and
 *  zero-token, so the cap is about cycle WALL-CLOCK rather than spend: the
 *  scheduler hands each task a budget and a task that ignores it starves
 *  its siblings. Records not reached this cycle are reached the next one —
 *  the walk is stable-ordered, and these are rolling-window aggregates
 *  whose value does not depend on being recomputed on any particular tick. */
export const RECORD_AGGREGATE_MAX_RECORDS_PER_CYCLE = 500;

export interface RecordAggregateSpec<V> {
  topic: EnrichmentTopic;
  /** Which CRM record roots this topic hangs off. Resolved through the
   *  live vendor registry, so a pack-registered CRM participates without a
   *  code change. */
  crm_alias: CrmAlias;
  /** `system.housekeeping.<topic>` — the canonical author. Shipped alert
   *  recipes read enrichment filtered to exactly this string, so it is a
   *  CONSUMED contract, not an internal detail. */
  authored_by: string;
  /** Settings → Housekeeping row copy. */
  description: string;
  /** Lookback handed to the resolver as `since`. */
  window_ms: number;
  /** Evidence-quality consumption defaults (§ A.3.2 / § A.3.3). Omitted
   *  means "the resolver's default" — NOT "everything". */
  authorship?: ReadonlyArray<Authorship>;
  direction?: ReadonlyArray<Direction>;
  lifecycle_state?: ReadonlyArray<EngagementLifecycleState>;
  /** The pure kernel. Deterministic, zero token cost. */
  compute: (input: {
    rows: ReadonlyArray<EngagementRow>;
    coverage: CoverageMetadata;
    now: number;
  }) => { value: V; coverage: CoverageMetadata };
}

export interface RecordWalkRow {
  target_id: string;
  meta_json: string | null;
}

/** DISTINCT target_id walk over one platform-reference scope in
 *  `data_enrichment` — the same walk `commitmentTrackerTask` uses, which is
 *  what makes the record set here identical to the set the reconcilers
 *  populate. `MAX(meta)` picks one snapshot per target; the row's meta is
 *  carried onto the output so the enrichment row keeps its record context.
 *
 *  ⚠ ORDER BY target_id is load-bearing with the per-cycle cap: an
 *  unordered walk under a LIMIT can revisit the same head forever and never
 *  reach the tail. */
export const listRecordTargetIds = (
  ctx: HousekeepingContext,
  scope: string,
  limit: number,
): RecordWalkRow[] =>
  ctx.db
    .prepare(
      `SELECT target_id, MAX(meta) AS meta_json
         FROM data_enrichment
        WHERE scope = ?
          AND target_id IS NOT NULL
          AND meta IS NOT NULL
        GROUP BY target_id
        ORDER BY target_id ASC
        LIMIT ?`,
    )
    .all(scope, limit) as RecordWalkRow[];

export const parseMeta = (meta_json: string | null): EnrichmentMeta | null => {
  if (meta_json === null) return null;
  try {
    return JSON.parse(meta_json) as EnrichmentMeta;
  } catch {
    return null;
  }
};

/** One record's worth of work. Exported for direct test access. */
export const processOneAggregateRecord = <V>(
  ctx: HousekeepingContext,
  spec: RecordAggregateSpec<V>,
  scope: EnrichmentScope,
  record: RecordWalkRow,
): boolean => {
  const resolve = ctx.resolveRecordEngagements;
  if (resolve === undefined) return false;
  const now = ctx.now();

  const result = resolve({
    scope,
    target_id: record.target_id,
    since: now - spec.window_ms,
    ...(spec.authorship !== undefined ? { authorship: spec.authorship } : {}),
    ...(spec.direction !== undefined ? { direction: spec.direction } : {}),
    ...(spec.lifecycle_state !== undefined ? { lifecycle_state: spec.lifecycle_state } : {}),
  });

  const out = spec.compute({
    rows: result.engagements,
    coverage: result.coverage,
    now,
  });

  const meta = parseMeta(record.meta_json);
  ctx.enrichmentStore.upsert({
    topic: spec.topic,
    scope,
    target_id: record.target_id,
    value: out.value as unknown as Record<string, unknown>,
    authored_by: spec.authored_by,
    event_at: now,
    ...(meta !== null ? { meta } : {}),
  });
  return true;
};

/** One cycle across every writable scope for the spec's alias. */
export interface CycleOutcome {
  produced: number;
  skipped: number;
  /** Records whose processing THREW. Distinct from `skipped` — see the
   *  comment at the catch site. */
  failed: number;
  /** First thrown message, or null. The rest are usually the same cause. */
  firstError: string | null;
}

export const runRecordAggregateCycle = <V>(
  ctx: HousekeepingContext,
  spec: RecordAggregateSpec<V>,
): CycleOutcome => {
  // Not wired (dbless / pre-wire) ⇒ the task no-ops rather than writing
  // rows computed over an absent engagement substrate.
  const scopes = resolveWalkableScopes(ctx, spec.topic, spec.crm_alias);
  if (scopes === null) return { produced: 0, skipped: 0, failed: 0, firstError: null };

  let produced = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;
  // Per-CYCLE cap, not per-scope: N vendors must not multiply the ceiling.
  let processed = 0;
  for (const scope of scopes) {
    if (processed >= RECORD_AGGREGATE_MAX_RECORDS_PER_CYCLE) break;
    const enrichmentScope = scope;
    const remaining = RECORD_AGGREGATE_MAX_RECORDS_PER_CYCLE - processed;
    for (const record of listRecordTargetIds(ctx, scope, remaining)) {
      processed += 1;
      // One record's failure must not abort the cross-vendor cycle.
      try {
        if (processOneAggregateRecord(ctx, spec, enrichmentScope, record)) produced += 1;
        else skipped += 1;
      } catch (error) {
        // ⛔ FAILED IS NOT SKIPPED. Conflating them is how a systematically
        // broken input reads as ordinary no-op: "nothing to do" and "nothing
        // worked" look identical from the outside, and the caller then
        // reports success either way. Keep the first message — the rest are
        // almost always the same cause repeated per record.
        failed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  return { produced, skipped, failed, firstError };
};

/** ⛔ A CYCLE WHERE NOTHING SUCCEEDED AND SOMETHING FAILED IS AN ERROR, and
 *  must not return `'complete'`.
 *
 *  These shells swallow per-record throws on purpose — one bad record must
 *  not abort a cross-vendor walk. But the swallow used to be TOTAL: the
 *  counts were returned and `step` discarded them, so a producer whose every
 *  record threw reported `status: 'complete'` and the owner saw a green task
 *  that had written nothing. Measured, not theorised: that is exactly what
 *  happened while building the out-of-band producer — every record threw
 *  `meta_snapshot_invalid` and the cycle reported success, and the cause was
 *  only findable by calling the per-record function directly.
 *
 *  Throwing here routes into `scheduler.ts`'s `recordError`, which stamps
 *  `last_error` + `consecutive_errors` and flips `last_status: 'error'` —
 *  the channel Settings → Housekeeping already renders.
 *
 *  ⚠ Deliberately NOT "any failure errors the task": one bad record among
 *  five hundred is noise, and a task that reddens on it would train the
 *  owner to ignore the light. Only total failure — zero produced, at least
 *  one thrown — is systemic by construction. */
export const assertCycleProducedSomething = (
  task_id: string,
  result: { produced: number; failed: number; firstError: string | null },
): void => {
  if (result.produced > 0 || result.failed === 0) return;
  throw new Error(
    `${task_id}: every record failed (${result.failed}) and none produced — ${result.firstError ?? 'no error captured'}`,
  );
};

/** The scope set a record-rooted producer may walk: every scope the alias
 *  resolves to through the LIVE vendor registry, narrowed to those the topic
 *  can actually WRITE.
 *
 *  ⛔ `isScopeSupported`, not a static `valid_scopes` intersection — the
 *  static form silently skips every pack-registered CRM, which is the whole
 *  reason `commitmentTrackerTask` moved off it (D-192 S4c3b). Shared by the
 *  deterministic and AI shells so the two can never disagree about which
 *  records exist.
 *
 *  ⚠ Returns `null` when the engagement resolver is unwired — the caller
 *  must treat that as "produce nothing", never as "no records". */
export const resolveWalkableScopes = (
  ctx: HousekeepingContext,
  topic: EnrichmentTopic,
  crm_alias: CrmAlias,
): ReadonlyArray<EnrichmentScope> | null => {
  if (ctx.resolveRecordEngagements === undefined) return null;
  const registry = ctx.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  return [...scopesForCrmAlias(crm_alias, registry)]
    .filter((s) => ctx.enrichmentStore.isScopeSupported(topic, s))
    .map((s) => s as EnrichmentScope);
};

export const buildRecordAggregateTask = <V>(
  spec: RecordAggregateSpec<V>,
): HousekeepingTaskInstance => ({
  meta: {
    id: `enrichment.${spec.topic}`,
    description: spec.description,
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY[spec.topic as keyof typeof ENRICHMENT_REGISTRY],
      isAiSurface: false,
    }),
  },
  topic: spec.topic,
  // Deterministic: no LLM call, so no pause-AI honouring and an `'auto'`
  // trust default. `isEligibleForIdleCycle` is the gate that reads this.
  is_ai_surface: false,

  // eslint-disable-next-line @typescript-eslint/require-await
  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    assertCycleProducedSomething(`enrichment.${spec.topic}`, runRecordAggregateCycle(ctx, spec));
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});
