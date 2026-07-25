/** D-214 proposal-time critique.
 *
 * The service observes an argument-free proposed topology before consequential
 * dispatch. It records every eligible opportunity in both experiment arms,
 * commits treatment attribution before any card can reach the planner, and
 * returns advisory evidence only. Repeating the candidate after seeing the
 * advisory falls through to the ordinary Gateway unchanged.
 */

import { randomUUID } from 'node:crypto';
import {
  type CaseInterventionEvidence,
  type CaseInterventionRecord,
  type ExecutionSource,
  type FlowCritique,
  type InternalToolRegistry,
  type ToolCall,
  type ToolEntry,
} from '@recued/contracts';

import {
  EXECUTION_CASE_COMPILER_VERSION,
  classifyExecutionFlowCases,
  deriveExecutionFlowPattern,
  executionCaseAdvisoryFits,
  rankExecutionCaseCandidates,
  renderExecutionCaseCard,
} from './execution-case-core.js';
import {
  EXECUTION_CASE_CONSULTED_KEYS_STATE_KEY,
  EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
  type ExecutionCaseExperimentDefinition,
  validateExecutionCaseExperimentDefinition,
} from './execution-case-retrieval.js';
import type {
  CaseInterventionStore,
  StoredCaseIntervention,
} from './storage/case-intervention-store.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';

export const EXECUTION_CASE_CRITIQUE_SEEN_STATE_KEY =
  'd214:proposal-critique:seen-candidates';

export interface ExecutionCaseProposalCritique {
  critique: FlowCritique;
}

export interface ExecutionCaseProposalCritic {
  critique(input: {
    session_id: string;
    turn_id: string;
    prompt: string;
    calls: ReadonlyArray<ToolCall>;
    state: Map<string, unknown>;
    source?: ExecutionSource;
  }): Promise<ExecutionCaseProposalCritique | null>;
}

export interface ExecutionCaseProposalCriticDeps {
  anchorStore: ExecutionSpanAnchorStore;
  caseStore: ExecutionCaseStore;
  interventionStore: CaseInterventionStore;
  registry: InternalToolRegistry;
  experiment: ExecutionCaseExperimentDefinition;
  ensureCasesCurrent?: () => Promise<void>;
  resolveScope(input: {
    session_id: string;
    turn_id: string;
    source?: ExecutionSource;
  }): {
    governing_contract_id: string;
    principal_key: string;
    active: boolean;
  };
  now?: () => number;
  newInterventionId?: () => string;
}

const isConsequential = (entry: ToolEntry | null): boolean =>
  entry !== null
  && (
    entry.destructive_hint === true
    || entry.classification === 'write'
    || entry.risk_tier === 'write'
    || entry.risk_tier === 'admin'
    || entry.risk_tier === 'destructive'
  );

const addStateValues = (
  state: Map<string, unknown>,
  key: string,
  values: readonly string[],
): void => {
  const prior = state.get(key);
  const set = prior instanceof Set
    ? prior as Set<string>
    : new Set<string>();
  for (const value of values) set.add(value);
  state.set(key, set);
};

const hasStateValue = (
  state: Map<string, unknown>,
  key: string,
  value: string,
): boolean => {
  const prior = state.get(key);
  return prior instanceof Set && prior.has(value);
};

const evidenceFor = (
  candidate: ReturnType<typeof deriveExecutionFlowPattern>,
  ranked: ReturnType<typeof rankExecutionCaseCandidates>,
): CaseInterventionEvidence[] => {
  const classified = classifyExecutionFlowCases(
    candidate,
    ranked.map((item) => item.row),
  );
  if (!classified.some((item) => item.role !== 'support')) return [];
  return classified.map((item) => ({
    case_id: item.row.case_id,
    case_key: item.row.case_key,
    role: item.role,
  }));
};

const renderCommittedCritique = async (
  candidate: ReturnType<typeof deriveExecutionFlowPattern>,
  stored: StoredCaseIntervention,
  deps: ExecutionCaseProposalCriticDeps,
): Promise<FlowCritique | null> => {
  const support: FlowCritique['support'] = [];
  const contradictions: FlowCritique['contradictions'] = [];
  const alternatives: FlowCritique['alternatives'] = [];
  for (const evidence of stored.record.shown_evidence) {
    const row = await deps.caseStore.get(evidence.case_id);
    if (
      !row
      || row.case_key !== evidence.case_key
      || row.governing_contract_id
        !== stored.record.governing_contract_id
      || row.principal_key !== stored.record.principal_key
      || row.superseded_by !== undefined
      || (
        row.policy_fingerprint !== 'none'
        && row.policy_fingerprint !== deps.experiment.policy_fingerprint
      )
    ) return null;
    const card = renderExecutionCaseCard(row);
    if (evidence.role === 'support') support.push(card);
    else if (evidence.role === 'contradiction') contradictions.push(card);
    else if (evidence.role === 'alternative') {
      alternatives.push({ case: card, material_difference: ['tool_sequence'] });
    }
  }
  if (
    contradictions.length === 0
    && alternatives.length === 0
  ) return null;
  const critique: FlowCritique = {
    candidate_pattern: candidate,
    support,
    contradictions,
    alternatives,
  };
  return executionCaseAdvisoryFits(critique) ? critique : null;
};

export const createExecutionCaseProposalCritic = (
  deps: ExecutionCaseProposalCriticDeps,
): ExecutionCaseProposalCritic => ({
  async critique(input) {
    await deps.ensureCasesCurrent?.();
    const experiment = deps.experiment;
    if (experiment.surface !== 'proposal_critique') return null;
    validateExecutionCaseExperimentDefinition(experiment);
    const now = deps.now?.() ?? Date.now();
    if (now < experiment.starts_at || now >= experiment.ends_at) return null;
    if (
      !input.calls.some((call) =>
        isConsequential(deps.registry.getByName(call.tool)))
    ) return null;

    // Deliberately ignore `call.args`. Candidate identity and every rendered
    // flow field are derived only from registry metadata and call order.
    const candidate = deriveExecutionFlowPattern(
      input.calls.map((call, ordinal) => {
        const entry = deps.registry.getByName(call.tool);
        return {
          tool_name: call.tool,
          operation_ids: [call.tool],
          dependency_ordinals: ordinal === 0 ? [] : [ordinal - 1],
          risk_tier:
            entry?.risk_tier
            ?? (entry?.destructive_hint
              ? 'destructive'
              : entry?.classification ?? 'unknown'),
          entity_kinds: [],
          topic_tags: entry?.topic_tags ?? [],
        };
      }),
    );
    const candidateHash = candidate.exact_signature;
    if (
      hasStateValue(
        input.state,
        EXECUTION_CASE_CRITIQUE_SEEN_STATE_KEY,
        candidateHash,
      )
    ) return null;

    const anchor = deps.anchorStore.getAnchor(
      input.session_id,
      input.turn_id,
    );
    if (!anchor) return null;
    const scope = deps.resolveScope({
      session_id: input.session_id,
      turn_id: input.turn_id,
      ...(input.source ? { source: input.source } : {}),
    });
    if (!scope.active) return null;

    const prior = await deps.interventionStore.listForRoot(
      experiment.experiment_id,
      anchor.root_request_id,
    );
    let committed = prior.find((item) =>
      item.record.surface === 'proposal_critique'
      && item.record.session_id === input.session_id
      && item.record.turn_id === input.turn_id
      && item.record.candidate_flow_hash === candidateHash);
    if (!committed) {
      const opportunities = prior.filter((item) =>
        item.record.surface === 'proposal_critique').length;
      if (
        opportunities
        >= experiment.max_critique_opportunities_per_root
      ) return null;
      const assignment = deps.interventionStore.assignment({
        experiment_id: experiment.experiment_id,
        root_request_id: anchor.root_request_id,
        assigned_at: now,
        definition: experiment,
        max_roots: experiment.max_roots,
      });
      if (assignment === undefined) return null;

      const scoped = await deps.caseStore.listScope(scope, {
        include_superseded: false,
        limit: 512,
      });
      const ranked = rankExecutionCaseCandidates(
        input.prompt,
        scoped
          .map((item) => item.row)
          .filter((row) =>
            row.policy_fingerprint === 'none'
            || row.policy_fingerprint === experiment.policy_fingerprint),
        experiment.min_relevance_score,
        Math.max(experiment.max_evidence * 8, 16),
      );
      const qualifying = evidenceFor(candidate, ranked);
      const rankedById = new Map(
        ranked.map(({ row }) => [row.case_id, row]),
      );
      const selected: CaseInterventionEvidence[] = [];
      const support: FlowCritique['support'] = [];
      const contradictions: FlowCritique['contradictions'] = [];
      const alternatives: FlowCritique['alternatives'] = [];
      for (const evidence of qualifying) {
        if (selected.length >= experiment.max_evidence) break;
        const row = rankedById.get(evidence.case_id);
        if (!row) continue;
        const card = renderExecutionCaseCard(row);
        const nextSupport = evidence.role === 'support'
          ? [...support, card]
          : support;
        const nextContradictions = evidence.role === 'contradiction'
          ? [...contradictions, card]
          : contradictions;
        const nextAlternatives = evidence.role === 'alternative'
          ? [...alternatives, {
              case: card,
              material_difference: ['tool_sequence'],
            }]
          : alternatives;
        if (!executionCaseAdvisoryFits({
          candidate_pattern: candidate,
          support: nextSupport,
          contradictions: nextContradictions,
          alternatives: nextAlternatives,
        } satisfies FlowCritique)) continue;
        selected.push(evidence);
        if (evidence.role === 'support') support.push(card);
        else if (evidence.role === 'contradiction') contradictions.push(card);
        else {
          alternatives.push({
            case: card,
            material_difference: ['tool_sequence'],
          });
        }
      }
      const record: CaseInterventionRecord = {
        schema_version: 1,
        intervention_id:
          deps.newInterventionId?.() ?? randomUUID(),
        experiment_id: experiment.experiment_id,
        root_request_id: anchor.root_request_id,
        session_id: input.session_id,
        turn_id: input.turn_id,
        governing_contract_id: scope.governing_contract_id,
        principal_key: scope.principal_key,
        assignment,
        qualifying_evidence: qualifying,
        selected_evidence: selected,
        shown_evidence: assignment === 'treatment' ? selected : [],
        planner_fingerprint: experiment.planner_fingerprint,
        prompt_fingerprint: experiment.prompt_fingerprint,
        retrieval_fingerprint: experiment.retrieval_fingerprint,
        policy_fingerprint: experiment.policy_fingerprint,
        compiler_version: EXECUTION_CASE_COMPILER_VERSION,
        recorded_at: now,
        surface: 'proposal_critique',
        candidate_flow_hash: candidateHash,
      };
      try {
        await deps.interventionStore.put(record);
        committed = await deps.interventionStore.getForOpportunity(record);
        if (!committed) {
          // A concurrent continuation may have consumed the final
          // pre-registered root slot after the read-side count above. Treat
          // only an observed full cap as benign; a missing commit below the cap
          // remains an instrumentation failure.
          const after = await deps.interventionStore.listForRoot(
            experiment.experiment_id,
            anchor.root_request_id,
          );
          if (
            after.filter((item) =>
              item.record.surface === 'proposal_critique').length
            >= experiment.max_critique_opportunities_per_root
          ) return null;
          throw new Error('missing intervention commit');
        }
      } catch {
        deps.interventionStore.markUnhealthy(
          experiment.experiment_id,
          'record_write_failed',
          now,
        );
        deps.interventionStore.markRootInvalid(
          experiment.experiment_id,
          anchor.root_request_id,
          'record_write_failed',
          now,
        );
        return null;
      }
    }

    // Mark only after a durable record exists. This also suppresses a repeated
    // candidate in the same cooperative turn, allowing Gateway to make the
    // authoritative decision on the model's post-critique retry.
    addStateValues(
      input.state,
      EXECUTION_CASE_CRITIQUE_SEEN_STATE_KEY,
      [candidateHash],
    );
    if (
      committed.record.assignment !== 'treatment'
      || committed.record.shown_evidence.length === 0
    ) return null;
    const critique = await renderCommittedCritique(candidate, committed, deps);
    if (!critique) {
      deps.interventionStore.markUnhealthy(
        experiment.experiment_id,
        'treatment_render_mismatch',
        now,
      );
      deps.interventionStore.markRootInvalid(
        experiment.experiment_id,
        anchor.root_request_id,
        'treatment_render_mismatch',
        now,
      );
      return null;
    }
    addStateValues(
      input.state,
      EXECUTION_CASE_CONSULTED_KEYS_STATE_KEY,
      committed.record.shown_evidence.map((item) => item.case_key),
    );
    addStateValues(
      input.state,
      EXECUTION_CASE_INTERVENTION_IDS_STATE_KEY,
      [committed.record.intervention_id],
    );
    return {
      critique,
    };
  },
});
