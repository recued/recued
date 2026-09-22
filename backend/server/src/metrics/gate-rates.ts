/** D-276 — per-step skip rates over the audit log: the query that makes an
 *  INERT GATE visible.
 *
 *  ⛔⛔ THE CASE THAT MOTIVATED IT, MEASURED 2026-09-20. 39 shipped recipes
 *  gate on a confidence value; 27 of them obtain it by listing an invented
 *  `*_confidence` key in `ai-extract`'s recipe-defined `llm.fields`, where the
 *  system prompt says "if a field is not present in a record, set its value to
 *  null" and the field can never be present in the source document. Driving
 *  `extract-tasks-from-mail`'s exact template + fields through the real
 *  `executeLLM` path, 18 calls over 6 mail bodies:
 *
 *      numeric 18 | null 0 | distinct values [0.85, 0.9, 0.95]
 *      mean WITH a real task 0.939 | mean with NO task 0.922
 *      18/18 clear the shipped 0.7 floor, including 9/9 no-task cases
 *
 *  The gate had never filtered anything, and nothing anywhere would have said
 *  so. ⇒ **A gate that passes 100% is exactly as broken as one that passes 0%,
 *  and both are one number nobody was recording.**
 *
 *  🔑 WHY A COUNT COULD NOT ANSWER IT. `RunYield.steps_skipped` has shipped
 *  since D-237, but every branching recipe skips steps on every run by design
 *  (the `thread` arm or the `single_body` arm, never both), so the aggregate
 *  is noise with one real signal inside it. D-276 adds
 *  `run_yield.skipped_step_ids`, and the rate of ONE step across runs becomes
 *  a `json_each` away.
 *
 *  ⛔⛔ WHY THIS TAKES `step_ids` AND WILL NOT DISCOVER THEM. The audit records
 *  which steps SKIPPED; a step that always ran appears in no row at all. So
 *  the inert gate — the one that never fired — is precisely the one that
 *  CANNOT be found by scanning the log, and a "show me every step" query built
 *  on this data would omit exactly the case it was written for. The caller
 *  supplies the universe, from the recipe, via `conditionalStepIds`. A step
 *  the caller names and the log never mentions is reported at `skipped: 0` —
 *  a real 0%, which is the finding.
 *
 *  ⛔ PRE-D-276 ROWS ARE EXCLUDED FROM THE DENOMINATOR, not treated as empty.
 *  `skipped_step_ids` is emitted even when empty precisely so presence means
 *  "recorded"; counting older rows as "nothing skipped" would make a gate that
 *  never fires look like one that sometimes does.
 *
 *  Aggregates in SQL over the `$.started_at` index (`audit-indexes.ts`) for the
 *  reason `anchor-metrics.ts` states: `audit_entries` is opaque JSON with a
 *  5 GB default quota, so pulling rows into JS is not a micro-cost. */

import type Database from 'better-sqlite3';

import { metricRatio, type MetricReading } from '@recued/contracts';

/** Below this many RECORDED runs, no rate is reported — the verdict is
 *  `insufficient_data` whatever the arithmetic says. A gate seen three times
 *  has told you nothing, and a confident 0% off n=3 is the kind of reading
 *  that gets acted on. */
export const GATE_RATE_MIN_RUNS = 20;

export type SkipVerdict =
  /** Fewer than `min_runs` recorded runs — the rate is withheld. */
  | 'insufficient_data'
  /** The condition never once fired. ⛔ On a `skip_when` step this is the
   *  inert gate: it has decided nothing for the whole window. */
  | 'always_ran'
  /** The condition fired on every run — everything downstream of it has
   *  never executed. Inert in the other direction, and usually worse. */
  | 'always_skipped'
  /** The condition discriminated at least once each way. */
  | 'varies';

export interface StepSkipRate {
  step_id: string;
  /** Runs in the window that RECORDED skip ids. Pre-D-276 rows excluded. */
  runs: number;
  /** Of those, how many skipped this step. */
  skipped: number;
  /** `absent` when the denominator is zero — never 0, per the rule in
   *  `anchor-metrics.ts`: an empty window is "no data", not "never skipped". */
  skip_rate: MetricReading;
  verdict: SkipVerdict;
}

export interface StepSkipRatesOptions {
  recipe_id: string;
  /** The steps that COULD skip — normally `conditionalStepIds(recipe)`. */
  step_ids: readonly string[];
  /** Inclusive lower bound on `$.started_at` (ms). Omit for all time. */
  since?: number;
  /** Exclusive upper bound on `$.started_at` (ms). Omit for all time. */
  until?: number;
  min_runs?: number;
}

/** The steps a recipe can skip — those carrying a `skip_when`. Structurally
 *  typed so this file does not depend on the recipe type.
 *
 *  🔑 This is the gate set. An unconditional step reported at `always_ran`
 *  would be unremarkable noise; scoping the report to `skip_when` steps makes
 *  every `always_ran` row a finding. */
export const conditionalStepIds = (
  recipe: { steps?: ReadonlyArray<{ id?: unknown; skip_when?: unknown }> } | null | undefined,
): string[] => {
  const out: string[] = [];
  for (const s of recipe?.steps ?? []) {
    if (s.skip_when === undefined || s.skip_when === null || s.skip_when === '') continue;
    if (typeof s.id === 'string' && s.id !== '') out.push(s.id);
  }
  return out;
};

const RECORDED = `json_extract(ae.data, '$.run_yield.skipped_step_ids') IS NOT NULL`;

const windowClause = (since?: number, until?: number): string =>
  `${since !== undefined ? ` AND json_extract(ae.data, '$.started_at') >= @since` : ''}`
  + `${until !== undefined ? ` AND json_extract(ae.data, '$.started_at') < @until` : ''}`;

/** Skip rate per named step for one recipe over a window. */
export const stepSkipRates = (
  db: Database.Database,
  opts: StepSkipRatesOptions,
): StepSkipRate[] => {
  const { recipe_id, step_ids, since, until } = opts;
  const min_runs = opts.min_runs ?? GATE_RATE_MIN_RUNS;
  if (step_ids.length === 0) return [];

  const bind: Record<string, unknown> = { recipe_id };
  if (since !== undefined) bind.since = since;
  if (until !== undefined) bind.until = until;
  const where = `json_extract(ae.data, '$.recipe_id') = @recipe_id AND ${RECORDED}`
    + windowClause(since, until);

  const runs = (db
    .prepare(`SELECT COUNT(*) AS n FROM audit_entries ae WHERE ${where}`)
    .get(bind) as { n: number } | undefined)?.n ?? 0;

  // Only SKIPPED ids are stored, so this yields nothing for a step that always
  // ran — which is why the caller's `step_ids` drives the output, not this.
  const hits = db
    .prepare(
      `SELECT je.value AS step_id, COUNT(DISTINCT ae.key) AS skipped
         FROM audit_entries ae,
              json_each(json_extract(ae.data, '$.run_yield.skipped_step_ids')) je
        WHERE ${where}
        GROUP BY je.value`,
    )
    .all(bind) as Array<{ step_id: string; skipped: number }>;

  const byStep = new Map(hits.map((h) => [h.step_id, h.skipped]));

  return step_ids.map((step_id) => {
    const skipped = byStep.get(step_id) ?? 0;
    return {
      step_id,
      runs,
      skipped,
      skip_rate: metricRatio(skipped, runs),
      verdict: classifySkipRate(skipped, runs, min_runs),
    };
  });
};

/** Pure verdict, exported so a caller can re-classify at a different floor
 *  without re-querying. */
export const classifySkipRate = (
  skipped: number,
  runs: number,
  min_runs: number = GATE_RATE_MIN_RUNS,
): SkipVerdict => {
  if (runs < min_runs) return 'insufficient_data';
  if (skipped === 0) return 'always_ran';
  if (skipped === runs) return 'always_skipped';
  return 'varies';
};

/** The conditions that decided nothing — every row whose verdict is one of the
 *  two extremes. This is the report worth surfacing; `stepSkipRates` is the
 *  substrate under it. */
export const inertConditions = (rows: readonly StepSkipRate[]): StepSkipRate[] =>
  rows.filter((r) => r.verdict === 'always_ran' || r.verdict === 'always_skipped');
