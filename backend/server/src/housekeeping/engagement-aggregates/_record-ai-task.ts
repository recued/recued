/** D-139 slice 4 — the dispatch shell for AI-surface record aggregates.
 *
 *  Sibling of `_record-aggregate-task.ts`. Same walk, same scope resolution
 *  (both call `resolveWalkableScopes`, so the two shells can never disagree
 *  about which records exist); different per-record contract.
 *
 *  ## Why the AI kernels need their own shell rather than an option
 *
 *  A deterministic kernel is `{rows, coverage, now} → {value, coverage}` and
 *  the shell writes the row. An AI kernel takes six more inputs
 *  (`source_record_hash`, `as_of`, `event_at`, a resolved `ForceLayer`) and
 *  DOES ITS OWN WRITE through `runAIProducer`, which owns the dedup probe,
 *  the trust gate and the model-id capture. Bolting that onto the
 *  deterministic shell as optional fields would make every deterministic
 *  caller carry an LLM-shaped contract it never uses, and would put two
 *  different write paths behind one `if`.
 *
 *  ## What slice 4 is actually for
 *
 *  These two topics were unreachable in BOTH directions. `default_trust_state:
 *  'manual'` blocks any gate; promotion to `'auto'` needs
 *  `manual_run_count >= MANUAL_RUN_THRESHOLD`, which only a successful Run-Now
 *  increments (`housekeeping-handler.ts` `maybeBumpManualRun`); and Run-Now
 *  requires a REGISTERED task — `housekeeping.task.run_now` refuses with
 *  "task not registered", and Settings → Housekeeping renders its inline
 *  Run-policy control per registered task, so there was no row to flip either.
 *  A topic with no task therefore had no path to ever run, by any route the
 *  owner could reach.
 *
 *  Registering them IS the fix: the task appears in Settings with the
 *  Off/Manual/Auto control, Run-Now becomes dispatchable, and each successful
 *  manual fire counts toward the promotion banner. The `'manual'` default is
 *  preserved deliberately — these spend tokens, and the owner opting in is the
 *  point, not an obstacle to route around.
 *
 *  Spec: D-139 § A.9.2 (AI-surface canaries) + D-132
 *  § A.7 (trust + promotion). */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type CoverageMetadata,
  type CrmAlias,
  type EngagementRow,
  type EnrichmentScope,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type { ForceLayer } from '@recued/llm';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import type { TrustStore } from '../trust-store.js';
import {
  assertCycleProducedSomething,
  listRecordTargetIds,
  parseMeta,
  resolveWalkableScopes,
  type CycleOutcome,
  type RecordWalkRow,
} from './_record-aggregate-task.js';

/** Hard cap on records walked per (topic, cycle).
 *
 *  ⚠ LOWER than the deterministic shell's 500 on purpose: this one is
 *  denominated in TOKENS, not wall-clock. Every record past the cap is a
 *  model call the owner pays for, and a first Run-Now on a large portal
 *  should cost a bounded amount rather than whatever the portal happens to
 *  hold. Records not reached this cycle are reached the next. */
export const RECORD_AI_MAX_RECORDS_PER_CYCLE = 100;

export interface RecordAiSpec {
  topic: EnrichmentTopic;
  crm_alias: CrmAlias;
  description: string;
  window_ms: number;
  /** Per-record token estimate — the D-136 §A.7 walk-cap planner multiplies
   *  this by pending-row count to size the budget gate. Absent, the planner
   *  substitutes a placeholder that mis-budgets in both directions. */
  token_estimate_per_record: number;
  /** Resolves the topic's pool policy into a `ForceLayer`, once per cycle. */
  resolveLayer: (ctx: HousekeepingContext, trustStore: TrustStore | undefined) => ForceLayer;
  /** The kernel. Owns its own dedup probe, trust gate, LLM call and upsert
   *  via `runAIProducer` — this shell does NOT write. */
  produce: (
    ctx: HousekeepingContext,
    input: {
      rows: ReadonlyArray<EngagementRow>;
      scope: EnrichmentScope;
      target_id: string;
      coverage: CoverageMetadata;
      source_record_hash: string;
      as_of: number;
      now: number;
      forceLayer: ForceLayer;
      event_at?: number | null;
    },
  ) => Promise<{ produced: boolean; reason?: string }>;
}

/** One record's worth of work. Exported for direct test access. */
export const processOneAiRecord = async (
  spec: RecordAiSpec,
  ctx: HousekeepingContext,
  scope: EnrichmentScope,
  record: RecordWalkRow,
  forceLayer: ForceLayer,
): Promise<boolean> => {
  const resolve = ctx.resolveRecordEngagements;
  if (resolve === undefined) return false;
  const now = ctx.now();

  const result = resolve({
    scope,
    target_id: record.target_id,
    since: now - spec.window_ms,
  });

  const meta = parseMeta(record.meta_json) as
    | { snapshot_hash?: unknown; snapshot_at?: unknown }
    | null;

  const out = await spec.produce(ctx, {
    rows: result.engagements,
    scope,
    target_id: record.target_id,
    coverage: result.coverage,
    // The record's own snapshot hash anchors the dedup fingerprint, so a
    // steady-state cycle over an unchanged record costs zero tokens. The
    // fallback keeps the fingerprint STABLE (not random) for a record whose
    // meta carries no hash — a random one would re-spend every cycle.
    source_record_hash:
      typeof meta?.snapshot_hash === 'string' && meta.snapshot_hash.length > 0
        ? meta.snapshot_hash
        : `${spec.topic}:${record.target_id}`,
    as_of: now,
    now,
    forceLayer,
    event_at: typeof meta?.snapshot_at === 'number' ? meta.snapshot_at : null,
  });
  return out.produced;
};

export const runRecordAiCycle = async (
  ctx: HousekeepingContext,
  spec: RecordAiSpec,
): Promise<CycleOutcome> => {
  const scopes = resolveWalkableScopes(ctx, spec.topic, spec.crm_alias);
  if (scopes === null) return { produced: 0, skipped: 0, failed: 0, firstError: null };

  const forceLayer = spec.resolveLayer(ctx, ctx.trustStore);
  let produced = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;
  let processed = 0;
  for (const scope of scopes) {
    if (processed >= RECORD_AI_MAX_RECORDS_PER_CYCLE) break;
    const remaining = RECORD_AI_MAX_RECORDS_PER_CYCLE - processed;
    for (const record of listRecordTargetIds(ctx, scope, remaining)) {
      processed += 1;
      // One record's LLM failure must not abort the cross-vendor cycle, and
      // must not cost the remaining records their turn.
      try {
        if (await processOneAiRecord(spec, ctx, scope, record, forceLayer)) produced += 1;
        else skipped += 1;
      } catch (error) {
        // ⚠ An AI producer legitimately returns `produced: false` for a dedup
        // hit or a trust block — those are SKIPPED, and a whole cycle of them
        // is normal steady state, not an error. Only a THROW counts here.
        failed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  return { produced, skipped, failed, firstError };
};

export const buildRecordAiTask = (spec: RecordAiSpec): HousekeepingTaskInstance => ({
  meta: {
    id: `enrichment.${spec.topic}`,
    description: spec.description,
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY[spec.topic as keyof typeof ENRICHMENT_REGISTRY],
      isAiSurface: true,
    }),
  },
  topic: spec.topic,
  // ⛔ TRUE is load-bearing in three places: the scheduler's idle gate demands
  // `'auto'` for AI surfaces, the global Pause-AI window applies only to them,
  // and `maybeBumpManualRun` counts a Run-Now toward promotion ONLY for an
  // AI-surface enrichment task. Marking these deterministic would let them
  // spend tokens on idle cycles the owner never opted into.
  is_ai_surface: true,
  token_estimate_per_record: spec.token_estimate_per_record,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    assertCycleProducedSomething(`enrichment.${spec.topic}`, await runRecordAiCycle(ctx, spec));
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});
