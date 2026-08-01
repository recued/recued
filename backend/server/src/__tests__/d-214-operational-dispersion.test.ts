/** D-214 A25 — dispersion for the report's per-root operational counts.
 *
 * `governed_calls` and `planner_rounds` previously exposed only `total`,
 * `denominator_roots` and `mean_per_root`. A mean with no spread cannot carry
 * an interval, so an arm difference in either count could never be told apart
 * from noise by a reader of the report — which is how the substrate-bench A/B
 * pilot produced a 29% apparent treatment win that reversed on the next run.
 * These ratchets pin the spread, the interval, and the invariant that binds a
 * dispersion to the exact cohort its mean was divided by.
 */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CaseInterventionEvidence,
  CaseInterventionRecord,
} from '@recued/contracts';

import {
  EXECUTION_CASE_ELIGIBLE_POPULATION,
  type ExecutionCaseExperimentDefinition,
} from '../execution-case-retrieval.js';
import {
  createExecutionCaseExperimentReporter,
  type CaseExperimentArmReport,
  type CaseExperimentReport,
} from '../execution-case-experiment.js';
import type {
  ExecutionCaseCompiler,
  ResolvedExecutionSpan,
} from '../execution-case-compiler.js';
import {
  analyzeExecutionCaseRequest,
  deriveExecutionFlowPattern,
  EXECUTION_CASE_COMPILER_VERSION,
  rebuildExecutionCases,
  type CaseSourceObservation,
} from '../execution-case-core.js';
import {
  createCaseInterventionStore,
} from '../storage/case-intervention-store.js';
import {
  createExecutionCaseStore,
} from '../storage/execution-case-store.js';
import type { D214KeyProvider } from '../storage/d214-sealed-json.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = 'send the quarterly report to the customer';

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(29);
  return () => key;
};

const admittedCase = () => {
  const requestShape = analyzeExecutionCaseRequest(REQUEST, {
    schema_version: 1,
    intent: 'send quarterly report',
    objects: ['report'],
    entities: [{ role: 'recipient', kind: 'person' }],
    constraints: ['send'],
    outcome_sought: 'customer receives report',
  }).request_shape!;
  const source: CaseSourceObservation = {
    observation_id: 'obs-1',
    report_id: 'report-1',
    root_request_id: 'historical-root',
    root_request: REQUEST,
    session_id: 'session-fixture',
    governing_contract_id: 'owner',
    principal_key: 'user_self',
    policy_fingerprint: 'policy-v1',
    request_shape: requestShape,
    flow_pattern: deriveExecutionFlowPattern([
      { tool_name: 'mail.send', risk_tier: 'write' },
    ]),
    flow_basis: 'executed',
    outcome: {
      model_claim: 'fulfilled',
      authorization: 'allowed',
      execution: 'failed',
      verification: 'failed',
      feedback: 'unknown',
    },
    evidence_kinds: ['verification_fail'],
    substantive_call_count: 2,
    span_closed: true,
    intent_drifted: false,
    consulted_case_keys: [],
    observed_at: 100,
    proposed: true,
    plan_accepted: true,
    plan_declined: false,
    executed: true,
  };
  return rebuildExecutionCases([
    source,
    {
      ...source,
      observation_id: 'obs-2',
      report_id: 'report-2',
      root_request_id: 'historical-root-2',
      flow_pattern: deriveExecutionFlowPattern([
        { tool_name: 'file.search', risk_tier: 'read' },
        { tool_name: 'mail.send', risk_tier: 'write' },
      ]),
      observed_at: 101,
    },
  ]).cases[0]!;
};

const definition: ExecutionCaseExperimentDefinition = {
  experiment_id: 'exp-dispersion',
  surface: 'request_augmentation',
  eligible_population:
    EXECUTION_CASE_ELIGIBLE_POPULATION.request_augmentation,
  starts_at: 0,
  ends_at: 10_000,
  max_roots: 500,
  max_critique_opportunities_per_root: 2,
  max_evidence: 3,
  min_relevance_score: 1,
  primary_axes: ['execution_failure'],
  material_harm_bounds: { execution_failure: 0.1 },
  decision_rule: 'dispersion ratchet only',
  planner_fingerprint: 'planner-v1',
  prompt_fingerprint: 'prompt-v1',
  retrieval_fingerprint: 'retrieval-v1',
  policy_fingerprint: 'policy-v1',
};

const emptySpan = (root_request_id: string): ResolvedExecutionSpan => ({
  root_request_id,
  activities: [],
  recipe_runs: [],
  plans: [],
  feedback: [],
  verifications: [],
  typed_correction_plan_ids: new Set(),
  first_event_id: `root:${root_request_id}`,
  last_event_id: `root:${root_request_id}`,
  pending: false,
  has_substantive_flow: false,
  has_strong_signal: false,
});

/** One root's planted shape: how many governed calls its span carries and how
 * many planner rounds were durably recorded for it. The two counts are kept
 * deliberately unequal per root so a swapped field cannot pass. */
interface PlantedRoot {
  governed_calls: number;
  planner_rounds: number;
}

const COHORT: Record<'control' | 'treatment', PlantedRoot[]> = {
  // Chosen so the interval's lower bound goes negative and must clamp at zero.
  control: [
    { governed_calls: 0, planner_rounds: 1 },
    { governed_calls: 1, planner_rounds: 1 },
    { governed_calls: 2, planner_rounds: 1 },
    { governed_calls: 5, planner_rounds: 7 },
  ],
  // Chosen so the interval sits strictly inside the positive reals, exercising
  // the unclamped path.
  treatment: [
    { governed_calls: 3, planner_rounds: 2 },
    { governed_calls: 4, planner_rounds: 2 },
    { governed_calls: 5, planner_rounds: 2 },
    { governed_calls: 6, planner_rounds: 8 },
  ],
};

const plant = async () => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const key = keyProvider();
  const caseStore = createExecutionCaseStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db,
    key,
    new TextEncoder().encode('dispersion-secret'),
  );
  const row = admittedCase();
  await caseStore.replaceMaterialized(
    [row],
    new Map([[row.case_id, ['report-1']]]),
    new Map([[row.case_id, REQUEST]]),
  );
  interventionStore.assertDefinition(definition);

  const evidence: CaseInterventionEvidence = {
    case_id: row.case_id,
    case_key: row.case_key,
    role: 'augmentation',
  };
  const spans = new Map<string, ResolvedExecutionSpan>();
  const remaining: Record<'control' | 'treatment', PlantedRoot[]> = {
    control: [...COHORT.control],
    treatment: [...COHORT.treatment],
  };
  for (let i = 0; remaining.control.length > 0
    || remaining.treatment.length > 0; i += 1) {
    if (i > 10_000) throw new Error('dispersion fixture: pool exhausted');
    const root = `dispersion-root-${i}`;
    const arm = interventionStore.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: root,
      assigned_at: 1,
      definition,
      max_roots: definition.max_roots,
    });
    if (!arm) throw new Error('dispersion fixture: root cap reached');
    const planted = remaining[arm].shift();
    if (!planted) continue;
    const record: CaseInterventionRecord = {
      schema_version: 1,
      intervention_id: `intervention-${i}`,
      experiment_id: definition.experiment_id,
      root_request_id: root,
      session_id: 's1',
      turn_id: `turn-${i}`,
      governing_contract_id: 'owner',
      principal_key: 'user_self',
      assignment: arm,
      qualifying_evidence: [evidence],
      selected_evidence: [evidence],
      shown_evidence: arm === 'treatment' ? [evidence] : [],
      planner_fingerprint: definition.planner_fingerprint,
      prompt_fingerprint: definition.prompt_fingerprint,
      retrieval_fingerprint: definition.retrieval_fingerprint,
      policy_fingerprint: definition.policy_fingerprint,
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
      recorded_at: 500,
      surface: 'request_augmentation',
      candidate_source_id: `source-${i}`,
      candidate_source_count: 1,
      candidate_source_partial: false,
    };
    expect(await interventionStore.put(record)).toBe(true);
    expect(interventionStore.recordPlannerRounds({
      root_request_id: root,
      session_id: 's1',
      turn_id: `turn-${i}`,
      rounds: planted.planner_rounds,
    })).toBeGreaterThan(0);
    interventionStore.markSpanClosed(root, 601);
    spans.set(root, {
      ...emptySpan(root),
      activities: Array.from(
        { length: planted.governed_calls },
        (_unused, index) => ({
          activity_id: `activity-${i}-${index}`,
          timestamp: 600,
          session_id: 's1',
          turn_id: `turn-${i}`,
          tool_name: 'file.search',
          status: 'ok' as const,
        }),
      ),
      has_substantive_flow: planted.governed_calls > 0,
    });
  }

  const compiler = {
    resolveSpan: (root_request_id: string): ResolvedExecutionSpan =>
      spans.get(root_request_id) ?? emptySpan(root_request_id),
    runtimeCompositionDiagnostics: () => ({
      corpus_roots: 0,
      dispatches: 0,
      route_kind_counts: {
        installed_recipe: 0,
        dynamic_ingredient: 0,
        inline_recipe: 0,
        direct_tool: 0,
      },
      recurring_dynamic_inline_subgraphs: [],
      source_coverage: {
        audit_activity_rows: 0,
        recipe_run_rows: 0,
        paired_recipe_runs: 0,
        unpaired_recipe_runs: 0,
      },
    }),
  } as unknown as ExecutionCaseCompiler;

  return createExecutionCaseExperimentReporter({
    compiler,
    interventionStore,
    caseStore,
    now: () => 700,
  }).report(definition);
};

/** Sample variance on the n−1 basis, written out independently of the
 * implementation so a shared helper cannot make both sides agree on a bug. */
const sampleVariance = (values: readonly number[]): number => {
  const mean = values.reduce((total, value) => total + value, 0)
    / values.length;
  let sum = 0;
  for (const value of values) sum += (value - mean) * (value - mean);
  return sum / (values.length - 1);
};

const everyArmReport = (
  report: CaseExperimentReport,
): CaseExperimentArmReport[] => [
  report.eligibility_assignment_complete_case.control,
  report.eligibility_assignment_complete_case.treatment,
  report.all_opportunity_rollout.control,
  report.all_opportunity_rollout.treatment,
  report.treatment_exposure_descriptive,
  ...report.eligibility_assignment_complete_case_by_fingerprint
    .flatMap((stratum) => [stratum.cohort.control, stratum.cohort.treatment]),
];

describe('D-214 operational dispersion', () => {
  it('reports spread and an interval for each arm per-root count', async () => {
    const report = await plant();
    for (const arm of ['control', 'treatment'] as const) {
      const planted = COHORT[arm];
      const calls = planted.map((item) => item.governed_calls);
      const rounds = planted.map((item) => item.planner_rounds);
      const operational =
        report.eligibility_assignment_complete_case[arm].operational;

      expect(operational.governed_calls.denominator_roots)
        .toBe(planted.length);
      expect(operational.governed_calls.dispersion.variance)
        .toBeCloseTo(sampleVariance(calls), 12);
      expect(operational.governed_calls.dispersion.std_dev)
        .toBeCloseTo(Math.sqrt(sampleVariance(calls)), 12);
      expect(operational.planner_rounds.dispersion.variance)
        .toBeCloseTo(sampleVariance(rounds), 12);

      // The interval is the reason the block exists: a mean without one cannot
      // be compared across arms.
      const mean = calls.reduce((total, value) => total + value, 0)
        / calls.length;
      const margin = 1.959963984540054
        * Math.sqrt(sampleVariance(calls))
        / Math.sqrt(calls.length);
      const interval = operational.governed_calls.dispersion
        .mean_uncertainty_95;
      expect(interval?.method).toBe('normal_sample_mean');
      expect(interval!.low).toBeCloseTo(Math.max(0, mean - margin), 12);
      expect(interval!.high).toBeCloseTo(mean + margin, 12);
    }

    // The control cohort was chosen so the lower bound runs negative: a count
    // mean cannot, so it clamps rather than reporting an impossible bound.
    const controlCalls = report.eligibility_assignment_complete_case.control
      .operational.governed_calls;
    expect(controlCalls.mean_per_root).toBe(2);
    expect(controlCalls.dispersion.mean_uncertainty_95!.low).toBe(0);
    // …while the treatment cohort exercises the unclamped path, so a blanket
    // `Math.max(0, …)` on both bounds could not pass both halves.
    const treatmentCalls = report.eligibility_assignment_complete_case
      .treatment.operational.governed_calls;
    expect(treatmentCalls.dispersion.mean_uncertainty_95!.low)
      .toBeGreaterThan(0);
  });

  it('reports a histogram that reconstructs the planted distribution', async () => {
    const report = await plant();
    expect(
      report.eligibility_assignment_complete_case.control.operational
        .governed_calls.dispersion.histogram,
    ).toEqual([
      { count: 0, roots: 1 },
      { count: 1, roots: 1 },
      { count: 2, roots: 1 },
      { count: 5, roots: 1 },
    ]);
    // Planner rounds are planted unequal to governed calls per root, so a
    // swapped source array shows up here as the wrong histogram, not as an
    // equal-looking mean.
    expect(
      report.eligibility_assignment_complete_case.control.operational
        .planner_rounds.dispersion.histogram,
    ).toEqual([
      { count: 1, roots: 3 },
      { count: 7, roots: 1 },
    ]);
    expect(
      report.eligibility_assignment_complete_case.treatment.operational
        .planner_rounds.dispersion.histogram,
    ).toEqual([
      { count: 2, roots: 3 },
      { count: 8, roots: 1 },
    ]);
  });

  it('binds every dispersion to the exact cohort its mean was divided by', async () => {
    const report = await plant();
    const arms = everyArmReport(report);
    expect(arms.length).toBeGreaterThanOrEqual(5);
    let checked = 0;
    for (const arm of arms) {
      for (const measure of [
        arm.operational.governed_calls,
        arm.operational.planner_rounds,
      ]) {
        const { dispersion } = measure;
        const roots = dispersion.histogram.reduce(
          (total, bucket) => total + bucket.roots,
          0,
        );
        const counted = dispersion.histogram.reduce(
          (total, bucket) => total + bucket.count * bucket.roots,
          0,
        );
        // A dispersion computed over the wrong root set — all facts instead of
        // closed ones, or one arm's counts under the other arm's mean — breaks
        // one of these three identities even when every number looks credible.
        expect(dispersion.denominator_roots).toBe(measure.denominator_roots);
        expect(roots).toBe(measure.denominator_roots);
        expect(counted).toBe(measure.total);
        // Spread is undefined below two roots, never zero.
        if (dispersion.denominator_roots < 2) {
          expect(dispersion.variance).toBeNull();
          expect(dispersion.std_dev).toBeNull();
          expect(dispersion.mean_uncertainty_95).toBeUndefined();
        } else {
          expect(dispersion.variance).not.toBeNull();
          expect(dispersion.mean_uncertainty_95).toBeDefined();
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});
