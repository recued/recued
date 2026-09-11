/** D-139 P4 — the shell for record aggregates whose kernel does NOT take
 *  `EngagementRow[]`.
 *
 *  Three kernels take a PROJECTED input instead: `account_engagement_breadth`
 *  wants each engagement paired with its contact edge, `champion_deal_count`
 *  wants a per-deal win/loss tally, `multi_account_contact` wants domains
 *  rather than rows at all. That is the only reason they outlived the six on
 *  `buildRecordAggregateTask` — everything else about them is identical:
 *  same walk, same cap, same cursor, same upsert, same failure accounting.
 *
 *  So this factory adds exactly one seam — `project` — between resolving a
 *  record's engagements and running its kernel. It does NOT add optional
 *  hooks to the deterministic shell, because every caller there would then
 *  carry a projection contract it never uses.
 *
 *  ⛔ `project` MAY RETURN NULL, and null is not an error. A contact record
 *  with no resolvable email cannot be projected into any of these inputs;
 *  writing a row for it would assert a computed answer about a record we
 *  could not read. Null ⇒ skipped, which the cycle accounting keeps distinct
 *  from failed.
 *
 *  Spec: D-139 § A.9.2b. */

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type CoverageMetadata,
  type CrmAlias,
  type EngagementsResolverResult,
  type EnrichmentMeta,
  type EnrichmentScope,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type { HousekeepingContext, HousekeepingTaskInstance } from '../registry.js';
import {
  assertCycleProducedSomething,
  listRecordTargetIds,
  parseMeta,
  resolveWalkableScopes,
  type CycleOutcome,
  type RecordWalkRow,
} from './_record-aggregate-task.js';

export const PROJECTED_MAX_RECORDS_PER_CYCLE = 500;

export interface ProjectedRecordSpec<TInput, V> {
  topic: EnrichmentTopic;
  crm_alias: CrmAlias;
  authored_by: string;
  description: string;
  window_ms: number;
  /** Turn one record + its resolved engagements into the kernel's input.
   *  `null` ⇒ this record cannot be answered for; skip it rather than
   *  writing a value derived from what we could not read. */
  project: (
    ctx: HousekeepingContext,
    args: {
      scope: EnrichmentScope;
      record: RecordWalkRow;
      resolved: EngagementsResolverResult;
      coverage: CoverageMetadata;
      now: number;
    },
  ) => TInput | null;
  compute: (input: TInput) => { value: V; coverage: CoverageMetadata };
}

export const processOneProjectedRecord = <TInput, V>(
  ctx: HousekeepingContext,
  spec: ProjectedRecordSpec<TInput, V>,
  scope: EnrichmentScope,
  record: RecordWalkRow,
): boolean => {
  const resolve = ctx.resolveRecordEngagements;
  if (resolve === undefined) return false;
  const now = ctx.now();

  const resolved = resolve({
    scope,
    target_id: record.target_id,
    since: now - spec.window_ms,
  });

  const input = spec.project(ctx, { scope, record, resolved, coverage: resolved.coverage, now });
  if (input === null) return false;

  const out = spec.compute(input);
  const meta = parseMeta(record.meta_json);
  ctx.enrichmentStore.upsert({
    topic: spec.topic,
    scope,
    target_id: record.target_id,
    value: out.value as unknown as Record<string, unknown>,
    authored_by: spec.authored_by,
    event_at: now,
    ...(meta !== null ? { meta: meta as EnrichmentMeta } : {}),
  });
  return true;
};

export const runProjectedRecordCycle = <TInput, V>(
  ctx: HousekeepingContext,
  spec: ProjectedRecordSpec<TInput, V>,
): CycleOutcome => {
  const scopes = resolveWalkableScopes(ctx, spec.topic, spec.crm_alias);
  if (scopes === null) return { produced: 0, skipped: 0, failed: 0, firstError: null };

  let produced = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | null = null;
  let processed = 0;
  for (const scope of scopes) {
    if (processed >= PROJECTED_MAX_RECORDS_PER_CYCLE) break;
    const remaining = PROJECTED_MAX_RECORDS_PER_CYCLE - processed;
    for (const record of listRecordTargetIds(ctx, scope, remaining)) {
      processed += 1;
      try {
        if (processOneProjectedRecord(ctx, spec, scope, record)) produced += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
  return { produced, skipped, failed, firstError };
};

export const buildProjectedRecordTask = <TInput, V>(
  spec: ProjectedRecordSpec<TInput, V>,
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
  is_ai_surface: false,

  // eslint-disable-next-line @typescript-eslint/require-await
  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    assertCycleProducedSomething(`enrichment.${spec.topic}`, runProjectedRecordCycle(ctx, spec));
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});
