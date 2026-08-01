/** D-214 A25 — headroom of the `first_flow_survived` outcome axis.
 *
 * The powered bench A/B (substrate-bench task 153, 120 roots) reported
 * `first_flow_survived` at 23/23 = 1.000 in control and 26/26 = 1.000 in
 * treatment and read as a tidy null result. This file measures whether that
 * ceiling was a property of the scenario or of the axis, by enumerating the
 * reachable `(eligible, value)` space per arm instead of reasoning about it.
 */

import { writeFileSync } from 'node:fs';

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

const keyProvider = (): D214KeyProvider => {
  const key = new Uint8Array(32).fill(23);
  return () => key;
};

const REQUEST = 'send the quarterly report to the customer';

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

const experiment = (
  surface: ExecutionCaseExperimentDefinition['surface'],
): ExecutionCaseExperimentDefinition => ({
  experiment_id: `exp-${surface}`,
  surface,
  eligible_population: EXECUTION_CASE_ELIGIBLE_POPULATION[surface],
  starts_at: 0,
  ends_at: 10_000,
  max_roots: 4000,
  max_critique_opportunities_per_root: 2,
  max_evidence: 3,
  min_relevance_score: 1,
  primary_axes: ['first_flow_survived'],
  material_harm_bounds: { execution_failure: 0.1 },
  decision_rule: 'headroom probe only',
  planner_fingerprint: 'planner-v1',
  prompt_fingerprint: 'prompt-v1',
  retrieval_fingerprint: 'retrieval-v1',
  policy_fingerprint: 'policy-v1',
});

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

const activity = (
  turn_id: string,
  tool_name: string,
): ResolvedExecutionSpan['activities'][number] => ({
  activity_id: `activity-${turn_id}-${tool_name}`,
  timestamp: 600,
  session_id: 's1',
  turn_id,
  tool_name,
  status: 'ok',
});

/** Terminal-flow shapes a root can end in. */
const SPAN_SHAPES = {
  /** No dispatch and no plan record — nothing terminal happened. */
  no_flow: (root: string): ResolvedExecutionSpan => emptySpan(root),
  /** Exactly one (session, turn) activity group: one flow signature. */
  one_flow: (root: string): ResolvedExecutionSpan => ({
    ...emptySpan(root),
    activities: [activity('t1', 'mail.send')],
    has_substantive_flow: true,
  }),
  /** Two activity groups in different turns: two flow signatures. */
  two_flows: (root: string): ResolvedExecutionSpan => ({
    ...emptySpan(root),
    activities: [activity('t1', 'mail.send'), activity('t2', 'mail.send')],
    has_substantive_flow: true,
  }),
  /** No dispatch, but an approved-and-consumed plan is terminal. */
  approved_plan_only: (root: string): ResolvedExecutionSpan => ({
    ...emptySpan(root),
    plans: [{
      plan_id: 'plan-1',
      session_id: 's1',
      turn_id: 't1',
      status: 'approved',
      created_at: 500,
      resolved_at: 550,
      consumed_at: 560,
      execution_turn_id: 't1',
    }] as ResolvedExecutionSpan['plans'],
  }),
} as const;
type SpanShape = keyof typeof SPAN_SHAPES;

/** Critique-record shapes reaching `changedAfter(0)` and its negations. */
const CRITIQUE_SHAPES = [
  /** No critique row at all — what `surface: 'request_augmentation'` yields. */
  'none',
  'one',
  'two_same_hash',
  'two_changed_hash',
  'two_changed_hash_cross_turn',
] as const;
type CritiqueShape = (typeof CRITIQUE_SHAPES)[number];

interface Cell {
  arm: 'control' | 'treatment';
  critique: CritiqueShape;
  /** The store forces `shown` from the arm: control may never show, treatment
   * must show exactly its selection. So selection is the free dimension and
   * `shown` is derived, never independently chosen. */
  selection: 'empty' | 'selected';
  egress: boolean;
  span: SpanShape;
}

const cells = (): Cell[] => {
  const out: Cell[] = [];
  for (const arm of ['control', 'treatment'] as const) {
    for (const critique of CRITIQUE_SHAPES) {
      for (const selection of ['empty', 'selected'] as const) {
        for (const egress of [false, true]) {
          for (const span of Object.keys(SPAN_SHAPES) as SpanShape[]) {
            out.push({ arm, critique, selection, egress, span });
          }
        }
      }
    }
  }
  return out;
};

const cellKey = (cell: Cell): string =>
  [
    cell.arm,
    cell.critique,
    cell.selection,
    cell.egress ? 'egress' : 'no-egress',
    cell.span,
  ].join('/');

interface Measured {
  key: string;
  arm: 'control' | 'treatment';
  eligible: boolean;
  value: boolean;
}

/** Enumerates every cell against the REAL reporter and returns each cell's
 * measured `(eligible, value)` for `first_flow_survived`. Cells the store
 * refuses to record are reported as refusals rather than skipped. */
const enumerateAxis = async (
  surface: ExecutionCaseExperimentDefinition['surface'],
): Promise<{
  measured: Measured[];
  refused: string[];
  collapsed: string[];
}> => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const key = keyProvider();
  const caseStore = createExecutionCaseStore(db, key);
  const interventionStore = createCaseInterventionStore(
    db,
    key,
    new TextEncoder().encode('headroom-probe-secret'),
  );
  const row = admittedCase();
  await caseStore.replaceMaterialized(
    [row],
    new Map([[row.case_id, ['report-1']]]),
    new Map([[row.case_id, REQUEST]]),
  );
  const definition = experiment(surface);
  interventionStore.assertDefinition(definition);

  const augmentationEvidence: CaseInterventionEvidence = {
    case_id: row.case_id,
    case_key: row.case_key,
    role: 'augmentation',
  };
  const critiqueEvidence: CaseInterventionEvidence = {
    case_id: row.case_id,
    case_key: row.case_key,
    role: 'support',
  };

  // Assignment is a keyed hash of the root id, so roots are drawn until each
  // cell has one in its required arm.
  const pool: Record<'control' | 'treatment', string[]> = {
    control: [],
    treatment: [],
  };
  const want = cells();
  const needed = { control: 0, treatment: 0 };
  for (const cell of want) needed[cell.arm] += 1;
  for (let i = 0; pool.control.length < needed.control
    || pool.treatment.length < needed.treatment; i += 1) {
    if (i > 20_000) throw new Error('headroom probe: root pool exhausted');
    const root = `probe-root-${i}`;
    const arm = interventionStore.assignment({
      experiment_id: definition.experiment_id,
      root_request_id: root,
      assigned_at: 1,
      definition,
      max_roots: definition.max_roots,
    });
    if (arm && pool[arm].length < needed[arm]) pool[arm].push(root);
  }

  const cursor = { control: 0, treatment: 0 };
  const spans = new Map<string, ResolvedExecutionSpan>();
  const assigned = new Map<string, Cell>();
  const refused: string[] = [];
  const collapsed: string[] = [];

  for (const cell of want) {
    const root = pool[cell.arm][cursor[cell.arm]++]!;
    const evidenceFor = (
      one: CaseInterventionEvidence,
    ) => {
      const selected = cell.selection === 'selected' ? [one] : [];
      return {
        qualifying_evidence: [one],
        selected_evidence: selected,
        // Derived, not chosen: control shows nothing, treatment shows exactly
        // what it selected.
        shown_evidence: cell.arm === 'treatment' ? selected : [],
      };
    };
    const base = {
      schema_version: 1 as const,
      experiment_id: definition.experiment_id,
      root_request_id: root,
      session_id: 's1',
      governing_contract_id: 'owner',
      principal_key: 'user_self',
      assignment: cell.arm,
      planner_fingerprint: definition.planner_fingerprint,
      prompt_fingerprint: definition.prompt_fingerprint,
      retrieval_fingerprint: definition.retrieval_fingerprint,
      policy_fingerprint: definition.policy_fingerprint,
      compiler_version: EXECUTION_CASE_COMPILER_VERSION,
    };
    const augmentation = (index: number): CaseInterventionRecord => ({
      ...base,
      ...evidenceFor(augmentationEvidence),
      turn_id: 't1',
      intervention_id: `${cellKey(cell)}#aug${index}`,
      recorded_at: 500 + index,
      surface: 'request_augmentation',
      candidate_source_id: `source-${index}`,
      candidate_source_count: 1,
      candidate_source_partial: false,
    });
    const critique = (
      index: number,
      hash: string,
      turn_id: string,
    ): CaseInterventionRecord => ({
      ...base,
      ...evidenceFor(critiqueEvidence),
      turn_id,
      intervention_id: `${cellKey(cell)}#crit${index}`,
      recorded_at: 500 + index,
      surface: 'proposal_critique',
      candidate_flow_hash: hash,
    });
    const records: CaseInterventionRecord[] = cell.critique === 'none'
      ? [augmentation(0)]
      : cell.critique === 'one'
        ? [critique(0, 'hash-a', 't1')]
        : cell.critique === 'two_same_hash'
          ? [critique(0, 'hash-a', 't1'), critique(1, 'hash-a', 't1')]
          : cell.critique === 'two_changed_hash'
            ? [critique(0, 'hash-a', 't1'), critique(1, 'hash-b', 't1')]
            : [critique(0, 'hash-a', 't1'), critique(1, 'hash-b', 't2')];
    let deduped = false;
    try {
      for (const record of records) {
        // `put` returning false is the store collapsing a repeated
        // opportunity, NOT a refusal: a same-turn critique pair with one flow
        // hash shares an opportunity key. Counting that as a refusal would
        // leave the cell silently unmeasured instead of measured as the
        // single-critique shape it collapses to.
        if (!(await interventionStore.put(record))) deduped = true;
      }
    } catch (error) {
      refused.push(`${cellKey(cell)} :: ${(error as Error).message}`);
      continue;
    }
    if (deduped) collapsed.push(cellKey(cell));
    if (cell.egress) {
      for (const item of await interventionStore.listForRoot(
        definition.experiment_id,
        root,
      )) {
        interventionStore.markPlannerEgress(
          item.record.intervention_id,
          600,
        );
      }
    }
    interventionStore.markSpanClosed(root, 601);
    spans.set(root, SPAN_SHAPES[cell.span](root));
    assigned.set(root, cell);
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

  // The reporter only exposes aggregates, so each cell is measured by asking
  // for a one-root cohort: a definition-scoped report over a single root.
  const measured: Measured[] = [];
  for (const [root, cell] of assigned) {
    const oneRoot = {
      ...compiler,
      resolveSpan: compiler.resolveSpan,
    } as ExecutionCaseCompiler;
    const report = await createExecutionCaseExperimentReporter({
      compiler: oneRoot,
      interventionStore: {
        ...interventionStore,
        listAssignments: (experiment_id: string) =>
          interventionStore
            .listAssignments(experiment_id)
            .filter((item) => item.root_request_id === root),
      },
      caseStore,
      now: () => 700,
    }).report(definition);
    // `all_opportunity_rollout` carries every assigned root; the eligibility
    // cohort drops selection-empty roots, so the rollout is the superset that
    // makes the reachability question answerable.
    const axis = report
      .all_opportunity_rollout[cell.arm].axes.first_flow_survived;
    measured.push({
      key: cellKey(cell),
      arm: cell.arm,
      eligible: axis.denominator === 1,
      value: axis.numerator === 1,
    });
  }
  return { measured, refused, collapsed };
};

const summarize = (
  label: string,
  result: Awaited<ReturnType<typeof enumerateAxis>>,
): string => {
  const lines: string[] = [`── ${label} ──`];
  for (const arm of ['control', 'treatment'] as const) {
    const rows = result.measured.filter((item) => item.arm === arm);
    const eligible = rows.filter((item) => item.eligible);
    const falses = eligible.filter((item) => !item.value);
    lines.push(
      `${arm}: cells=${rows.length} eligible=${eligible.length} `
      + `value_false_while_eligible=${falses.length}`,
    );
    for (const row of falses) lines.push(`   FALSE ← ${row.key}`);
  }
  lines.push(`refused by store: ${result.refused.length}`);
  for (const item of new Set(result.refused.map((row) =>
    row.split(' :: ')[1]))) lines.push(`   REFUSED: ${item}`);
  lines.push(`collapsed to one opportunity: ${result.collapsed.length}`);
  for (const item of result.collapsed) lines.push(`   COLLAPSED: ${item}`);
  return lines.join('\n');
};

const falseCells = (
  result: Awaited<ReturnType<typeof enumerateAxis>>,
  arm: 'control' | 'treatment',
): string[] => result.measured
  .filter((item) => item.arm === arm && item.eligible && !item.value)
  .map((item) => item.key)
  .sort();

const eligibleCount = (
  result: Awaited<ReturnType<typeof enumerateAxis>>,
  arm: 'control' | 'treatment',
): number => result.measured
  .filter((item) => item.arm === arm && item.eligible).length;

describe('D-214 first_flow_survived headroom', () => {
  it('has no headroom in either arm under the request-augmentation surface', async () => {
    const result = await enumerateAxis('request_augmentation');
    const grid = summarize('surface=request_augmentation', result);
    if (process.env.D214_HEADROOM_PROBE_OUT) {
      writeFileSync(process.env.D214_HEADROOM_PROBE_OUT, `${grid}\n`);
    }

    // Not vacuous: the axis IS reached in both arms. Without this, "no cell is
    // false" would also hold over an empty eligible set.
    expect(eligibleCount(result, 'control'), grid).toBeGreaterThan(0);
    expect(eligibleCount(result, 'treatment'), grid).toBeGreaterThan(0);

    // The measurement that matters. `first_flow_survived` can only be false
    // through a revised first PROPOSAL CRITIQUE, and this surface never
    // produces one, so the axis is pinned at 1.000 in BOTH arms for every
    // reachable span and intervention shape. A run reporting 23/23 and 26/26
    // here is not a null result — it is the only value the axis can take, so
    // no scenario, however hard the request, can make it discriminate.
    expect(falseCells(result, 'control'), grid).toEqual([]);
    expect(falseCells(result, 'treatment'), grid).toEqual([]);

    // The exclusion is enforced at the store, not only by the two runtime
    // gates (`execution-case-critic.ts` returns null unless the surface is
    // `proposal_critique`; `execution-case-retrieval.ts` returns unless it is
    // `request_augmentation`). A critique record cannot even be persisted
    // under an augmentation experiment.
    expect(new Set(result.refused.map((row) => row.split(' :: ')[1])), grid)
      .toEqual(new Set(['case-intervention-store: intervention definition mismatch']));
    expect(result.refused.length, grid).toBe(128);
  }, 120_000);

  it('has headroom only in treatment under the proposal-critique surface', async () => {
    const result = await enumerateAxis('proposal_critique');
    const grid = summarize('surface=proposal_critique', result);

    expect(eligibleCount(result, 'control'), grid).toBeGreaterThan(0);
    expect(eligibleCount(result, 'treatment'), grid).toBeGreaterThan(0);

    // Control is a structural constant: no span shape, critique sequence, or
    // egress state drives a control root to false. Control is therefore not a
    // comparison arm for this axis — it is a tautology, and a treatment rate
    // is being compared against a fixed 1.000.
    //
    // ⚠ TWO independent layers hold this, so THIS outcome assertion cannot
    // tell you one of them died. Measured by mutation: deleting the
    // `assignment === 'treatment'` guard from `firstFlowRevised` leaves this
    // test GREEN, because revision also requires shown evidence and the store
    // refuses a control record that shows any. Each layer carries its own
    // ratchet elsewhere — the store rule at
    // `d-214-execution-case-experiment.test.ts` ('control cannot show
    // evidence') — and neither may be retired on the strength of this file.
    expect(falseCells(result, 'control'), grid).toEqual([]);

    // Treatment's headroom exists and is narrow: the first critique must have
    // shown evidence, reached planner egress, and been followed in the SAME
    // turn by a critique carrying a different flow hash.
    expect(falseCells(result, 'treatment'), grid).toEqual([
      'treatment/two_changed_hash/selected/egress/approved_plan_only',
      'treatment/two_changed_hash/selected/egress/no_flow',
      'treatment/two_changed_hash/selected/egress/one_flow',
      'treatment/two_changed_hash/selected/egress/two_flows',
    ]);

    // The "different hash" half of that condition is also held twice. A
    // same-turn critique pair sharing one flow hash shares one opportunity
    // key, so the store collapses it to a single row and the pair can never
    // reach the axis at all. Measured by mutation: making `changedAfter`
    // ignore the hash leaves this file GREEN for exactly that reason. Pinning
    // the collapse here keeps the store-side layer visible from the axis side.
    expect(result.collapsed, grid).toEqual(
      expect.arrayContaining([
        'control/two_same_hash/selected/egress/one_flow',
        'treatment/two_same_hash/selected/egress/one_flow',
      ]),
    );
    expect(
      result.collapsed.every((key) => key.includes('two_same_hash')),
      grid,
    ).toBe(true);
  }, 120_000);
});
