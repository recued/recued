/** D-214 A25 owner-only experiment reporting.
 *
 * The report joins server-owned assignment/intervention records to existing
 * plan, audit, verification, and feedback sources at read time. It returns only
 * aggregates: no root ids, prompts, case text, args, results, audit JSON, or
 * external errors.
 */

import type {
  RuntimeCompositionRouteKind,
} from '@recued/contracts';

import type {
  ExecutionCaseCompiler,
  ResolvedExecutionSpan,
} from './execution-case-compiler.js';
import {
  isExecutionCaseGatewayDenialReason,
} from './execution-case-vocabulary.js';
import {
  CASE_EXPERIMENT_OUTCOME_AXES,
  validateExecutionCaseExperimentDefinition,
  type CaseExperimentOutcomeAxis,
  type ExecutionCaseExperimentDefinition,
} from './execution-case-retrieval.js';
import type {
  CaseExperimentAggregate,
  CaseInterventionStore,
  StoredCaseIntervention,
} from './storage/case-intervention-store.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';

export {
  CASE_EXPERIMENT_OUTCOME_AXES,
  type CaseExperimentOutcomeAxis,
} from './execution-case-retrieval.js';

export interface CaseExperimentRate {
  numerator: number;
  denominator: number;
  rate: number | null;
  /** Wilson score interval, 95%; absent when the denominator is zero. */
  uncertainty_95?: {
    low: number;
    high: number;
    method: 'wilson';
  };
}

export interface CaseExperimentArmReport {
  cohort_roots: number;
  /** Root-level outcome observability for this exact cohort. Axis rates below
   * are closed-span complete-case estimates, not unconditional outcomes. */
  closed_span_observation: CaseExperimentRate;
  axes: Record<CaseExperimentOutcomeAxis, CaseExperimentRate>;
  operational: {
    governed_calls: {
      total: number;
      denominator_roots: number;
      mean_per_root: number | null;
    };
    planner_rounds: {
      available: boolean;
      total: number;
      denominator_roots: number;
      mean_per_root: number | null;
    };
  };
}

export interface CaseExperimentCohortReport {
  control: CaseExperimentArmReport;
  treatment: CaseExperimentArmReport;
}

export interface CaseExperimentOpportunityArmReport {
  cohort_roots: number;
  opportunities_per_root: {
    numerator: number;
    denominator: number;
    mean: number | null;
  };
  qualifying_nonempty: CaseExperimentRate;
  selected_nonempty: CaseExperimentRate;
  /** A treatment record counts as exposed only when it showed evidence and
   * correlated planner egress exists. Control therefore remains zero. */
  treatment_exposure: CaseExperimentRate;
  record_to_egress: CaseExperimentRate;
  record_to_closed_span: CaseExperimentRate;
  egress_to_closed_span: CaseExperimentRate;
  augmentation_partial_source: CaseExperimentRate;
  augmentation_candidate_count_distribution: {
    denominator: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    histogram: Array<{
      candidate_count: number;
      opportunities: number;
    }>;
  };
}

export interface CaseExperimentOpportunityReport {
  control: CaseExperimentOpportunityArmReport;
  treatment: CaseExperimentOpportunityArmReport;
}

export interface CaseExperimentFingerprintStratum {
  planner_fingerprint: string;
  prompt_fingerprint: string;
  retrieval_fingerprint: string;
  policy_fingerprint: string;
  compiler_version: number;
  cohort: CaseExperimentCohortReport;
}

export interface CaseExperimentReport {
  experiment_id: string;
  generated_at: number;
  outcome_analysis: {
    method: 'closed_span_complete_case';
    causal_interpretation_requires_closure_balance: true;
  };
  pre_registered: {
    eligible_population: string;
    varied_surface: ExecutionCaseExperimentDefinition['surface'];
    starts_at: number;
    ends_at: number;
    max_roots: number;
    max_critique_opportunities_per_root: number;
    primary_axes: readonly string[];
    material_harm_bounds: Readonly<Record<string, number>>;
    decision_rule: string;
  };
  readiness: {
    admitted_cases: number;
    scopes_with_cases: number;
    case_density_per_scope: {
      total_cases: number;
      denominator_scopes: number;
      mean: number | null;
      min: number | null;
      max: number | null;
    };
    first_case_at?: number;
    time_to_first_case_ms?: number;
  };
  opportunity: CaseExperimentAggregate;
  opportunity_measures: CaseExperimentOpportunityReport;
  /** Pre-exposure assignment cohort: both arms had non-empty deterministic
   * selection, irrespective of actual exposure. Axis estimates are
   * closed-span complete-case; closure balance is a causal-use prerequisite. */
  eligibility_assignment_complete_case: CaseExperimentCohortReport;
  /** Diluted rollout effect over every assigned structural opportunity. */
  all_opportunity_rollout: CaseExperimentCohortReport;
  /** Descriptive treatment exposure only; never presented as causal. */
  treatment_exposure_descriptive: CaseExperimentArmReport;
  eligibility_assignment_complete_case_by_fingerprint:
    CaseExperimentFingerprintStratum[];
  recipe_topology_diagnostic: {
    corpus_roots: number;
    dispatches: number;
    route_kind_counts: Record<RuntimeCompositionRouteKind, number>;
    recurring_dynamic_inline_subgraphs: number;
  };
}

interface RootFacts {
  root_request_id: string;
  assignment: 'control' | 'treatment';
  span_closed: boolean;
  selected_nonempty: boolean;
  shown_nonempty: boolean;
  planner_egress: boolean;
  fingerprint?: {
    planner_fingerprint: string;
    prompt_fingerprint: string;
    retrieval_fingerprint: string;
    policy_fingerprint: string;
    compiler_version: number;
  };
  axes: Record<CaseExperimentOutcomeAxis, {
    eligible: boolean;
    value: boolean;
  }>;
  governed_calls: number;
  planner_rounds?: number;
}

const isApprovalExpiry = (
  span: ResolvedExecutionSpan,
): boolean => span.recipe_runs.some((item) =>
  item.error_codes.includes('RECIPE_APPROVAL_TIMEOUT'));

const flowSignaturesByTurn = (
  span: ResolvedExecutionSpan,
): string[] => {
  const groups = new Map<string, string[]>();
  for (const activity of span.activities) {
    const key = `${activity.session_id}\0${activity.turn_id}`;
    const list = groups.get(key);
    if (list) list.push(activity.tool_name);
    else groups.set(key, [activity.tool_name]);
  }
  return [...groups.values()].map((tools) => JSON.stringify(tools));
};

const rootFacts = (
  root_request_id: string,
  assignment: 'control' | 'treatment',
  planner_rounds: number | undefined,
  span: ResolvedExecutionSpan,
  interventions: readonly StoredCaseIntervention[],
): RootFacts => {
  const feedback = new Set(span.feedback.map((item) => item.kind));
  const verification = new Set(span.verifications.map((item) => item.kind));
  const hasApprovalChoice = span.plans.length > 0;
  const approvedPlans = span.plans.filter((plan) => plan.status === 'approved');
  const flowSignatures = flowSignaturesByTurn(span);
  const approvalBindingEligible = approvedPlans.length > 0;
  const approvalBindingSurvived =
    approvalBindingEligible
    && approvedPlans.every((plan) =>
      plan.consumed_at !== null
      && plan.execution_turn_id !== null);
  const selected_nonempty = interventions.some((item) =>
    item.record.selected_evidence.length > 0);
  const shown_nonempty = interventions.some((item) =>
    item.record.shown_evidence.length > 0);
  const planner_egress = interventions.some((item) =>
    item.planner_egress_at !== undefined);
  const spanClosed =
    interventions.length > 0
    && interventions.every((item) => item.span_closed_at !== undefined);
  const critiqueInterventions = interventions
    .filter((item) => item.record.surface === 'proposal_critique')
    .sort((left, right) =>
      left.recorded_sequence - right.recorded_sequence);
  const changedAfter = (
    index: number,
  ): boolean => {
    const current = critiqueInterventions[index];
    const next = critiqueInterventions[index + 1];
    return current?.record.surface === 'proposal_critique'
      && next?.record.surface === 'proposal_critique'
      && current.record.session_id === next.record.session_id
      && current.record.turn_id === next.record.turn_id
      && current.record.candidate_flow_hash
        !== next.record.candidate_flow_hash;
  };
  const firstCritique = critiqueInterventions[0];
  const firstFlowRevised =
    assignment === 'treatment'
    && firstCritique !== undefined
    && firstCritique.record.shown_evidence.length > 0
    && firstCritique.planner_egress_at !== undefined
    && changedAfter(0);
  const hasTerminalFlow =
    span.activities.length > 0
    || span.plans.some((plan) =>
      plan.resolved_at !== null
      || plan.consumed_at !== null
      || plan.status === 'approved'
      || plan.status === 'cancelled');
  const firstFlowEligible = firstCritique === undefined
    ? flowSignatures.length === 1
    : firstFlowRevised || hasTerminalFlow;
  const firstFlowSurvived =
    firstFlowEligible && !firstFlowRevised && hasTerminalFlow;
  const critiqueFlowRevised = assignment === 'treatment'
    && critiqueInterventions.some((item, index) =>
      item.record.shown_evidence.length > 0
      && item.planner_egress_at !== undefined
      && changedAfter(index));
  const fingerprintRecord = interventions.find((item) =>
    item.record.selected_evidence.length > 0)?.record
    ?? interventions[0]?.record;
  const approvalExpired = isApprovalExpiry(span);
  const executionFailure =
    span.activities.some((item) =>
      item.status === 'error'
      && !isExecutionCaseGatewayDenialReason(item.reason))
    || span.recipe_runs.some((item) =>
      item.commit_status === 'failed'
      && !item.error_codes.includes('RECIPE_APPROVAL_TIMEOUT'));
  return {
    root_request_id,
    assignment,
    span_closed: spanClosed,
    selected_nonempty,
    shown_nonempty,
    planner_egress,
    ...(fingerprintRecord
      ? {
          fingerprint: {
            planner_fingerprint: fingerprintRecord.planner_fingerprint,
            prompt_fingerprint: fingerprintRecord.prompt_fingerprint,
            retrieval_fingerprint: fingerprintRecord.retrieval_fingerprint,
            policy_fingerprint: fingerprintRecord.policy_fingerprint,
            compiler_version: fingerprintRecord.compiler_version,
          },
        }
      : {}),
    axes: {
      explicit_acceptance: {
        eligible: spanClosed,
        value: feedback.has('accepted'),
      },
      explicit_correction: {
        eligible: spanClosed,
        value: feedback.has('corrected')
          || span.typed_correction_plan_ids.size > 0,
      },
      explicit_rejection: {
        eligible: spanClosed,
        value: feedback.has('rejected'),
      },
      explicit_undo: {
        eligible: spanClosed,
        value: feedback.has('undone'),
      },
      verification_failure: {
        eligible: spanClosed,
        value: verification.has('failed'),
      },
      verified_success: {
        eligible: spanClosed,
        value: verification.has('passed'),
      },
      execution_failure: {
        // Per-root incidence. A closed root with no attempted execution is
        // truthfully "no structured execution failure", not missing data.
        eligible: spanClosed,
        value: executionFailure,
      },
      authorization_denial: {
        // Per-root incidence for the same assignment population. Conditioning
        // on whether treatment caused an authorization opportunity would
        // compare different post-treatment subsets.
        eligible: spanClosed,
        value: span.activities.some((item) =>
          isExecutionCaseGatewayDenialReason(item.reason)),
      },
      plan_accepted: {
        eligible: spanClosed && hasApprovalChoice,
        value: approvedPlans.length > 0,
      },
      plan_declined: {
        // Owner refusal is material per-root incidence. Conditioning on whether
        // treatment surfaced an approval choice would hide treatment-induced
        // cancellations from the harm bound.
        eligible: spanClosed,
        value: span.plans.some((plan) => plan.status === 'cancelled'),
      },
      plan_abandoned: {
        // Approval timeout is likewise incidence over the closed assignment
        // cohort, not only over the post-treatment approval subset.
        eligible: spanClosed,
        value: approvalExpired,
      },
      first_flow_survived: {
        eligible: spanClosed && firstFlowEligible,
        value: firstFlowSurvived,
      },
      approval_binding_survived: {
        eligible: spanClosed && approvalBindingEligible,
        value: approvalBindingSurvived,
      },
      critique_flow_revised: {
        eligible:
          spanClosed
          && critiqueInterventions.some((item) =>
            assignment === 'treatment'
            && item.record.shown_evidence.length > 0
            && item.planner_egress_at !== undefined),
        value: critiqueFlowRevised,
      },
    },
    governed_calls: span.activities.length,
    ...(planner_rounds !== undefined ? { planner_rounds } : {}),
  };
};

const wilson = (
  numerator: number,
  denominator: number,
): CaseExperimentRate['uncertainty_95'] => {
  if (denominator === 0) return undefined;
  const z = 1.959963984540054;
  const p = numerator / denominator;
  const z2 = z * z;
  const denominatorAdjusted = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / denominatorAdjusted;
  const margin =
    z
    * Math.sqrt(
      (p * (1 - p) + z2 / (4 * denominator)) / denominator,
    )
    / denominatorAdjusted;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    method: 'wilson',
  };
};

const rateFor = (
  facts: readonly RootFacts[],
  axis: CaseExperimentOutcomeAxis,
): CaseExperimentRate => {
  const eligible = facts.filter((fact) => fact.axes[axis].eligible);
  const numerator = eligible.filter((fact) => fact.axes[axis].value).length;
  const denominator = eligible.length;
  return measuredRate(numerator, denominator);
};

const measuredRate = (
  numerator: number,
  denominator: number,
): CaseExperimentRate => {
  const uncertainty = wilson(numerator, denominator);
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    ...(uncertainty ? { uncertainty_95: uncertainty } : {}),
  };
};

const opportunityArmReport = (
  assignment: 'control' | 'treatment',
  cohortRoots: number,
  interventions: readonly StoredCaseIntervention[],
): CaseExperimentOpportunityArmReport => {
  const rows = interventions.filter((item) =>
    item.record.assignment === assignment);
  const egressRows = rows.filter((item) =>
    item.planner_egress_at !== undefined);
  const augmentationRows = rows.filter((item) =>
    item.record.surface === 'request_augmentation');
  const candidateCounts = augmentationRows.map((item) =>
    item.record.surface === 'request_augmentation'
      ? item.record.candidate_source_count
      : 0);
  const histogram = new Map<number, number>();
  for (const count of candidateCounts) {
    histogram.set(count, (histogram.get(count) ?? 0) + 1);
  }
  return {
    cohort_roots: cohortRoots,
    opportunities_per_root: {
      numerator: rows.length,
      denominator: cohortRoots,
      mean: cohortRoots === 0 ? null : rows.length / cohortRoots,
    },
    qualifying_nonempty: measuredRate(
      rows.filter((item) =>
        item.record.qualifying_evidence.length > 0).length,
      rows.length,
    ),
    selected_nonempty: measuredRate(
      rows.filter((item) =>
        item.record.selected_evidence.length > 0).length,
      rows.length,
    ),
    treatment_exposure: measuredRate(
      rows.filter((item) =>
        item.record.shown_evidence.length > 0
        && item.planner_egress_at !== undefined).length,
      rows.length,
    ),
    record_to_egress: measuredRate(egressRows.length, rows.length),
    record_to_closed_span: measuredRate(
      rows.filter((item) => item.span_closed_at !== undefined).length,
      rows.length,
    ),
    egress_to_closed_span: measuredRate(
      egressRows.filter((item) =>
        item.span_closed_at !== undefined).length,
      egressRows.length,
    ),
    augmentation_partial_source: measuredRate(
      augmentationRows.filter((item) =>
        item.record.surface === 'request_augmentation'
        && item.record.candidate_source_partial).length,
      augmentationRows.length,
    ),
    augmentation_candidate_count_distribution: {
      denominator: candidateCounts.length,
      min: candidateCounts.length === 0 ? null : Math.min(...candidateCounts),
      max: candidateCounts.length === 0 ? null : Math.max(...candidateCounts),
      mean: candidateCounts.length === 0
        ? null
        : candidateCounts.reduce((total, count) => total + count, 0)
          / candidateCounts.length,
      histogram: [...histogram.entries()]
        .sort(([left], [right]) => left - right)
        .map(([candidate_count, opportunities]) => ({
          candidate_count,
          opportunities,
        })),
    },
  };
};

const armReport = (facts: readonly RootFacts[]): CaseExperimentArmReport => {
  const axes = Object.fromEntries(
    CASE_EXPERIMENT_OUTCOME_AXES.map((axis) => [axis, rateFor(facts, axis)]),
  ) as Record<CaseExperimentOutcomeAxis, CaseExperimentRate>;
  // Until the durable span-close join lands, call/round totals are partial
  // progress rather than a final operational outcome. Keep them in attrition,
  // not in a denominator that would bias the mean downward.
  const closedFacts = facts.filter((fact) => fact.span_closed);
  const governedCalls = closedFacts.reduce(
    (total, fact) => total + fact.governed_calls,
    0,
  );
  const plannerRoundFacts = closedFacts.filter(
    (fact): fact is RootFacts & { planner_rounds: number } =>
      fact.planner_rounds !== undefined,
  );
  const plannerRounds = plannerRoundFacts.reduce(
    (total, fact) => total + fact.planner_rounds,
    0,
  );
  return {
    cohort_roots: facts.length,
    closed_span_observation: measuredRate(
      closedFacts.length,
      facts.length,
    ),
    axes,
    operational: {
      governed_calls: {
        total: governedCalls,
        denominator_roots: closedFacts.length,
        mean_per_root:
          closedFacts.length === 0
            ? null
            : governedCalls / closedFacts.length,
      },
      planner_rounds: {
        available: plannerRoundFacts.length > 0,
        total: plannerRounds,
        denominator_roots: plannerRoundFacts.length,
        mean_per_root:
          plannerRoundFacts.length === 0
            ? null
            : plannerRounds / plannerRoundFacts.length,
      },
    },
  };
};

const cohortReport = (
  facts: readonly RootFacts[],
): CaseExperimentCohortReport => ({
  control: armReport(facts.filter((fact) => fact.assignment === 'control')),
  treatment: armReport(
    facts.filter((fact) => fact.assignment === 'treatment'),
  ),
});

const fingerprintKey = (
  fingerprint: NonNullable<RootFacts['fingerprint']>,
): string => JSON.stringify(fingerprint);

export interface ExecutionCaseExperimentReporter {
  report(
    definition: ExecutionCaseExperimentDefinition,
  ): Promise<CaseExperimentReport>;
}

export const createExecutionCaseExperimentReporter = (deps: {
  compiler: ExecutionCaseCompiler;
  interventionStore: CaseInterventionStore;
  caseStore: ExecutionCaseStore;
  now?: () => number;
}): ExecutionCaseExperimentReporter => ({
  async report(definition) {
    validateExecutionCaseExperimentDefinition(definition);
    deps.interventionStore.assertDefinition(definition);
    await deps.compiler.ensureCurrent?.();
    const [opportunity, interventions, cases, observations] = await Promise.all([
      deps.interventionStore.aggregate(definition.experiment_id),
      deps.interventionStore.listForExperiment(definition.experiment_id),
      deps.caseStore.listAll(),
      deps.caseStore.listObservations(),
    ]);
    const byRoot = new Map<string, StoredCaseIntervention[]>();
    for (const item of interventions) {
      const list = byRoot.get(item.record.root_request_id);
      if (list) list.push(item);
      else byRoot.set(item.record.root_request_id, [item]);
    }
    const facts = deps.interventionStore
      .listAssignments(definition.experiment_id)
      .map((assignment) =>
        rootFacts(
          assignment.root_request_id,
          assignment.assignment,
          assignment.planner_rounds,
          deps.compiler.resolveSpan(assignment.root_request_id),
          byRoot.get(assignment.root_request_id) ?? [],
        ));
    const eligibilityFacts = facts.filter((fact) => fact.selected_nonempty);
    const exposedFacts = facts.filter((fact) =>
      fact.assignment === 'treatment'
      && fact.shown_nonempty
      && fact.planner_egress);
    const strata = new Map<string, {
      fingerprint: NonNullable<RootFacts['fingerprint']>;
      facts: RootFacts[];
    }>();
    for (const fact of eligibilityFacts) {
      if (!fact.fingerprint) continue;
      const key = fingerprintKey(fact.fingerprint);
      const existing = strata.get(key);
      if (existing) existing.facts.push(fact);
      else strata.set(key, { fingerprint: fact.fingerprint, facts: [fact] });
    }
    const topology = deps.compiler.runtimeCompositionDiagnostics();
    const firstCaseAt = cases.length === 0
      ? undefined
      : Math.min(...cases.map((item) => item.first_seen_at));
    const caseCountsByScope = new Map<string, number>();
    for (const observation of observations) {
      const scope =
        `${observation.governing_contract_id}\0${observation.principal_key}`;
      if (!caseCountsByScope.has(scope)) caseCountsByScope.set(scope, 0);
    }
    for (const row of cases) {
      const scope =
        `${row.governing_contract_id}\0${row.principal_key}`;
      caseCountsByScope.set(scope, (caseCountsByScope.get(scope) ?? 0) + 1);
    }
    const scopeCounts = [...caseCountsByScope.values()];
    const generated_at = deps.now?.() ?? Date.now();
    return {
      experiment_id: definition.experiment_id,
      generated_at,
      outcome_analysis: {
        method: 'closed_span_complete_case',
        causal_interpretation_requires_closure_balance: true,
      },
      pre_registered: {
        eligible_population: definition.eligible_population,
        varied_surface: definition.surface,
        starts_at: definition.starts_at,
        ends_at: definition.ends_at,
        max_roots: definition.max_roots,
        max_critique_opportunities_per_root:
          definition.max_critique_opportunities_per_root,
        primary_axes: definition.primary_axes,
        material_harm_bounds: definition.material_harm_bounds,
        decision_rule: definition.decision_rule,
      },
      readiness: {
        admitted_cases: cases.length,
        scopes_with_cases:
          [...caseCountsByScope.values()].filter((count) => count > 0).length,
        case_density_per_scope: {
          total_cases: cases.length,
          denominator_scopes: caseCountsByScope.size,
          mean: caseCountsByScope.size === 0
            ? null
            : cases.length / caseCountsByScope.size,
          min: scopeCounts.length === 0 ? null : Math.min(...scopeCounts),
          max: scopeCounts.length === 0 ? null : Math.max(...scopeCounts),
        },
        ...(firstCaseAt !== undefined
          ? {
              first_case_at: firstCaseAt,
              time_to_first_case_ms: Math.max(
                0,
                firstCaseAt - definition.starts_at,
              ),
            }
          : {}),
      },
      opportunity,
      opportunity_measures: {
        control: opportunityArmReport(
          'control',
          opportunity.assigned_roots.control,
          interventions,
        ),
        treatment: opportunityArmReport(
          'treatment',
          opportunity.assigned_roots.treatment,
          interventions,
        ),
      },
      eligibility_assignment_complete_case: cohortReport(eligibilityFacts),
      all_opportunity_rollout: cohortReport(facts),
      treatment_exposure_descriptive: armReport(exposedFacts),
      eligibility_assignment_complete_case_by_fingerprint:
        [...strata.values()]
          .sort((left, right) =>
            fingerprintKey(left.fingerprint)
              .localeCompare(fingerprintKey(right.fingerprint)))
          .map(({ fingerprint, facts: stratumFacts }) => ({
            ...fingerprint,
            cohort: cohortReport(stratumFacts),
          })),
      recipe_topology_diagnostic: {
        corpus_roots: topology.corpus_roots,
        dispatches: topology.dispatches,
        route_kind_counts: topology.route_kind_counts,
        recurring_dynamic_inline_subgraphs:
          topology.recurring_dynamic_inline_subgraphs.length,
      },
    };
  },
});
