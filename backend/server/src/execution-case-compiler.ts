/** D-214 span closure, source projection, and deterministic case rebuild. */

import type Database from 'better-sqlite3';
import {
  type ExecutionCase,
  type ExecutionObservation,
  type ExecutionOutcome,
  type ExecutionPath,
  type ExecutionStep,
  type InternalToolRegistry,
  type RuntimeCompositionDispatch,
} from '@recued/contracts';

import {
  EXECUTION_CASE_COMPILER_VERSION,
  analyzeExecutionCaseRequest,
  deriveExecutionFlowPattern,
  executionCaseKey,
  hashExecutionCaseValue,
  isExecutionCaseIntentGrounded,
  outcomeStrengthForObservations,
  measureRuntimeComposition,
  rebuildExecutionCases,
  retainExecutionCases,
  requestShapeHash,
  type CaseEvidenceKind,
  type CaseSourceObservation,
  type FlowStepInput,
  type RuntimeCompositionDiagnostics,
} from './execution-case-core.js';
import {
  D214_INTERNAL_TOOL_NAMES,
  isExecutionCaseGatewayDenialReason,
} from './execution-case-vocabulary.js';
import type {
  ExecutionCaseFeedback,
  ExecutionCaseFeedbackStore,
} from './storage/execution-case-feedback-store.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';
import type {
  StoredExecutionReport,
  ExecutionReportStore,
} from './storage/execution-report-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';
import type {
  ExecutionSpanDissectionStore,
} from './storage/execution-span-dissection-store.js';
import type {
  ExecutionCaseVerification,
  ExecutionCaseVerificationStore,
} from './storage/execution-case-verification-store.js';

export { D214_INTERNAL_TOOL_NAMES } from './execution-case-vocabulary.js';

interface AuditActivityRow {
  activity_id: string;
  timestamp: number;
  target: string;
  detail?: string;
}

export interface ParsedChatToolActivity {
  activity_id: string;
  timestamp: number;
  session_id: string;
  turn_id: string;
  tool_name: string;
  status: 'ok' | 'error';
  reason?: string;
  recipe_id?: string;
  recipe_hash?: string;
  recipe_status?: string;
  /** Closed structured error codes only. Raw error text/details never enter the
   * D-214 projection. */
  recipe_error_codes?: string[];
}

export interface ParsedRecipeAuditEntry {
  run_id: string;
  recipe_id: string;
  recipe_hash: string;
  started_at: number;
  finished_at: number;
  commit_status: string;
  session_id: string;
  turn_id: string;
  contract_snapshot?: unknown;
  /** Structured codes distinguish a staleness-sweep expiry from an execution
   * failure without retaining external error text. */
  error_codes: string[];
}

interface PlanRow {
  plan_id: string;
  session_id: string;
  turn_id: string;
  retry_of_plan_id: string | null;
  tool: string;
  classification: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  consumed_at: number | null;
  execution_status: string | null;
  execution_turn_id: string | null;
  execution_updated_at: number | null;
}

export const parseChatToolActivityTarget = (
  target: string,
): { session_id: string; turn_id: string; tool_name: string } | null => {
  const first = target.indexOf(':');
  if (first <= 0) return null;
  const second = target.indexOf(':', first + 1);
  if (second <= first + 1 || second === target.length - 1) return null;
  return {
    session_id: target.slice(0, first),
    turn_id: target.slice(first + 1, second),
    tool_name: target.slice(second + 1),
  };
};

const parseActivity = (raw: string): AuditActivityRow | null => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.action !== 'chat_tool_call'
      || typeof value.activity_id !== 'string'
      || typeof value.timestamp !== 'number'
      || typeof value.target !== 'string'
    ) return null;
    return {
      activity_id: value.activity_id,
      timestamp: value.timestamp,
      target: value.target,
      ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    };
  } catch {
    return null;
  }
};

const parseToolActivity = (
  raw: string,
): ParsedChatToolActivity | null => {
  const activity = parseActivity(raw);
  if (!activity) return null;
  const identity = parseChatToolActivityTarget(activity.target);
  if (!identity || D214_INTERNAL_TOOL_NAMES.has(identity.tool_name)) return null;
  let detail: Record<string, unknown> = {};
  if (activity.detail) {
    try {
      const parsed = JSON.parse(activity.detail) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return {
    ...identity,
    activity_id: activity.activity_id,
    timestamp: activity.timestamp,
    status: detail.status === 'error' ? 'error' : 'ok',
    ...(typeof detail.reason === 'string' ? { reason: detail.reason } : {}),
  };
};

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`
    SELECT 1 AS ok FROM sqlite_master
     WHERE type = 'table' AND name = ?
  `).get(name) !== undefined;

const listToolActivities = (
  db: Database.Database,
  anchors: ReadonlySet<string>,
): ParsedChatToolActivity[] => {
  if (!tableExists(db, 'audit_activities')) return [];
  const rows = db.prepare(`
    SELECT data FROM audit_activities
     WHERE json_extract(data, '$.action') = 'chat_tool_call'
     ORDER BY json_extract(data, '$.timestamp') ASC, key ASC
  `).all() as Array<{ data: string }>;
  return rows.flatMap((row): ParsedChatToolActivity[] => {
    const activity = parseToolActivity(row.data);
    return activity
      && anchors.has(`${activity.session_id}\0${activity.turn_id}`)
      ? [activity]
      : [];
  });
};

const parseRecipeAuditEntry = (raw: string): ParsedRecipeAuditEntry | null => {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const source = value.execution_source;
    if (
      typeof value.run_id !== 'string'
      || typeof value.recipe_id !== 'string'
      || typeof value.recipe_hash !== 'string'
      || typeof value.started_at !== 'number'
      || typeof value.finished_at !== 'number'
      || typeof value.commit_status !== 'string'
      || source === null
      || typeof source !== 'object'
      || Array.isArray(source)
    ) return null;
    const executionSource = source as Record<string, unknown>;
    if (
      executionSource.channel !== 'chat'
      || typeof executionSource.chat_session_id !== 'string'
      || typeof executionSource.turn_id !== 'string'
    ) return null;
    const errors = Array.isArray(value.errors) ? value.errors : [];
    const error_codes = errors.flatMap((candidate): string[] => {
      if (
        candidate === null
        || typeof candidate !== 'object'
        || Array.isArray(candidate)
      ) return [];
      const code = (candidate as Record<string, unknown>).code;
      return typeof code === 'string' && code.length > 0 ? [code] : [];
    });
    return {
      run_id: value.run_id,
      recipe_id: value.recipe_id,
      recipe_hash: value.recipe_hash,
      started_at: value.started_at,
      finished_at: value.finished_at,
      commit_status: value.commit_status,
      session_id: executionSource.chat_session_id,
      turn_id: executionSource.turn_id,
      error_codes,
      ...(value.contract_snapshot !== undefined
        ? { contract_snapshot: value.contract_snapshot }
        : {}),
    };
  } catch {
    return null;
  }
};

const listRecipeAuditEntries = (
  db: Database.Database,
  anchors?: ReadonlySet<string>,
): ParsedRecipeAuditEntry[] => {
  if (!tableExists(db, 'audit_entries')) return [];
  const rows = db.prepare(`
    SELECT data FROM audit_entries
     WHERE json_extract(data, '$.execution_source.channel') = 'chat'
     ORDER BY json_extract(data, '$.started_at') ASC, key ASC
  `).all() as Array<{ data: string }>;
  return rows.flatMap((row): ParsedRecipeAuditEntry[] => {
    const entry = parseRecipeAuditEntry(row.data);
    if (!entry) return [];
    return anchors === undefined
      || anchors.has(`${entry.session_id}\0${entry.turn_id}`)
      ? [entry]
      : [];
  });
};

const pairRecipeRuns = (
  activities: readonly ParsedChatToolActivity[],
  recipeRuns: readonly ParsedRecipeAuditEntry[],
  registry: InternalToolRegistry,
): {
  activities: ParsedChatToolActivity[];
  paired_run_ids: Set<string>;
} => {
  const remaining = new Map<string, ParsedRecipeAuditEntry[]>();
  for (const run of recipeRuns) {
    const key = `${run.session_id}\0${run.turn_id}`;
    const list = remaining.get(key);
    if (list) list.push(run);
    else remaining.set(key, [run]);
  }
  const paired_run_ids = new Set<string>();
  const enriched = activities.map((activity): ParsedChatToolActivity => {
    const key = `${activity.session_id}\0${activity.turn_id}`;
    const candidates = remaining.get(key) ?? [];
    const entry = registry.getByName(activity.tool_name);
    const index = candidates.findIndex((run) =>
      run.recipe_id === activity.tool_name
      || (
        activity.tool_name === 'recipe.run'
        && run.recipe_id !== 'run-ingredient'
      )
      || (
        entry?.tier === 3
        && run.recipe_id === 'run-ingredient'
      ));
    if (index < 0) return { ...activity };
    const [run] = candidates.splice(index, 1);
    if (!run) return { ...activity };
    paired_run_ids.add(run.run_id);
    return {
      ...activity,
      recipe_id: run.recipe_id,
      recipe_hash: run.recipe_hash,
      recipe_status: run.commit_status,
      recipe_error_codes: [...run.error_codes],
      ...(run.commit_status === 'failed'
        && !run.error_codes.includes('RECIPE_APPROVAL_TIMEOUT')
        && activity.status !== 'error'
        ? { status: 'error' as const }
        : {}),
    };
  });
  return { activities: enriched, paired_run_ids };
};

const listAllPlans = (
  db: Database.Database,
): PlanRow[] => {
  if (!tableExists(db, 'chat_plans')) return [];
  return db.prepare(`
    SELECT plan_id, session_id, turn_id, retry_of_plan_id, tool,
           classification, status, created_at, resolved_at, consumed_at,
           execution_status, execution_turn_id, execution_updated_at
      FROM chat_plans
     ORDER BY created_at ASC, plan_id ASC
  `).all() as PlanRow[];
};

const listTypedCorrections = (
  db: Database.Database,
  planIds: ReadonlySet<string>,
): Set<string> => {
  if (!tableExists(db, 'correction_events') || planIds.size === 0) {
    return new Set();
  }
  const rows = db.prepare(`
    SELECT source_plan_id, kind, payload_blob
      FROM correction_events
     WHERE kind = 'plan_outcome_corrected'
  `).all() as Array<{
    source_plan_id: string | null;
    kind: string;
    payload_blob: string;
  }>;
  const out = new Set<string>();
  for (const row of rows) {
    let payloadPlanId: string | undefined;
    try {
      const payload = JSON.parse(row.payload_blob) as Record<string, unknown>;
      if (typeof payload.plan_id === 'string') payloadPlanId = payload.plan_id;
    } catch {
      continue;
    }
    const planId = row.source_plan_id ?? payloadPlanId;
    if (planId && planIds.has(planId)) out.add(planId);
  }
  return out;
};

const isApprovalExpiry = (
  run: Pick<ParsedRecipeAuditEntry, 'error_codes'>,
): boolean => run.error_codes.includes('RECIPE_APPROVAL_TIMEOUT');

const isTerminalRecipeStatus = (status: string | undefined): boolean =>
  status !== undefined
  && status !== 'pending'
  && status !== 'running'
  && status !== 'awaiting_approval';

export interface ResolvedExecutionSpan {
  root_request_id: string;
  activities: ParsedChatToolActivity[];
  recipe_runs: ParsedRecipeAuditEntry[];
  plans: PlanRow[];
  feedback: ExecutionCaseFeedback[];
  verifications: ExecutionCaseVerification[];
  typed_correction_plan_ids: Set<string>;
  first_event_id: string;
  last_event_id: string;
  pending: boolean;
  has_substantive_flow: boolean;
  has_strong_signal: boolean;
  /** Strong signals plus durable weak negatives that must be projected now so
   * independent roots can eventually reach the recurrence floor. */
  has_compilable_signal: boolean;
}

export interface ExecutionCaseCompilerDeps {
  db: Database.Database;
  anchorStore: ExecutionSpanAnchorStore;
  dissectionStore: ExecutionSpanDissectionStore;
  reportStore: ExecutionReportStore;
  caseStore: ExecutionCaseStore;
  feedbackStore: ExecutionCaseFeedbackStore;
  verificationStore: ExecutionCaseVerificationStore;
  registry: InternalToolRegistry;
  max_cases_per_scope?: number;
}

export interface ExecutionCaseCompiler {
  /** Resolve an approval-resume turn back to its initiating root from the
   * durable plan execution edge. Ambiguity fails safe to the turn's own root. */
  resolveRootForClose(session_id: string, turn_id: string): string | undefined;
  resolveSpan(root_request_id: string): ResolvedExecutionSpan;
  compileReport(report_id: string): Promise<number>;
  /** Replay every closed report from authoritative span stores under the
   * current compiler before replacing materialized cases. */
  recompileAll(): Promise<number>;
  /** Lazy startup/experiment gate. Retrieval must await this before reading. */
  ensureCurrent(): Promise<void>;
  rebuild(): Promise<number>;
  deleteSource(report_id: string): Promise<number>;
  /** A26 argument-free measurement over durable chat dispatch history. */
  runtimeCompositionDiagnostics(): RuntimeCompositionDiagnostics;
  diagnostics(): Promise<{
    compiler_version: number;
    source_reports: number;
    source_observations: number;
    eligible_cases_before_retention: number;
    materialized_cases: number;
    storage_pressure_evictions: number;
    contested_cases: number;
    superseded_cases: number;
    scopes: number;
    evidence_family_case_counts: Record<string, number>;
    request_shape_source_reports: {
      grounded_dissection: number;
      ungrounded_dissection_fallback: number;
      missing_dissection_fallback: number;
    };
  }>;
}

const verificationFor = (
  verifications: readonly ExecutionCaseVerification[],
): ExecutionOutcome['verification'] => {
  const latest = [...verifications].sort((left, right) =>
    left.recorded_at - right.recorded_at
    || left.verification_id.localeCompare(right.verification_id)).at(-1);
  return latest?.kind ?? 'unavailable';
};

const evidenceFromVerification = (
  verifications: readonly ExecutionCaseVerification[],
): CaseEvidenceKind[] => {
  const kinds = new Set(verifications.map((item) => item.kind));
  return [
    ...(kinds.has('passed') ? ['verification_pass' as const] : []),
    ...(kinds.has('failed') ? ['verification_fail' as const] : []),
  ];
};

const feedbackAxisFor = (
  feedback: readonly ExecutionCaseFeedback[],
): ExecutionOutcome['feedback'] => {
  const latest = [...feedback].sort((left, right) =>
    left.recorded_at - right.recorded_at
    || left.feedback_id.localeCompare(right.feedback_id)).at(-1);
  return latest?.kind ?? 'unknown';
};

const evidenceFromFeedback = (
  feedback: readonly ExecutionCaseFeedback[],
): CaseEvidenceKind[] => {
  const kinds = new Set(feedback.map((item) => item.kind));
  return [
    ...(kinds.has('accepted')
      ? ['typed_acceptance' as const]
      : []),
    ...(kinds.has('corrected')
      ? ['typed_correction' as const]
      : []),
    ...(kinds.has('rejected')
      ? ['typed_rejection' as const]
      : []),
    ...(kinds.has('undone')
      ? ['typed_undo' as const]
      : []),
  ];
};

const flowStep = (
  toolName: string,
  registry: InternalToolRegistry,
  input: Partial<FlowStepInput> = {},
): FlowStepInput => {
  const entry = registry.getByName(toolName);
  return {
    tool_name: toolName,
    operation_ids: [toolName],
    approval_boundary: input.approval_boundary ?? 'none',
    verification_boundary: input.verification_boundary ?? 'unavailable',
    risk_tier: entry?.risk_tier
      ?? (entry?.classification === 'write' ? 'write' : 'read'),
    entity_kinds: [],
    topic_tags: entry?.topic_tags ?? [],
    ...input,
  };
};

const pathStep = (
  input: FlowStepInput,
  ordinal: number,
  disposition: ExecutionStep['disposition'],
): ExecutionStep => ({
  ordinal,
  tool_name: input.tool_name,
  ...(input.recipe_id ? { recipe_id: input.recipe_id } : {}),
  ...(input.recipe_hash ? { recipe_hash: input.recipe_hash } : {}),
  operation_ids: [...(input.operation_ids ?? [])],
  dependency_ordinals: [...(input.dependency_ordinals ?? [])],
  disposition,
  approval_boundary: input.approval_boundary ?? 'none',
  verification_boundary: input.verification_boundary ?? 'unavailable',
});

const outcomeObservationProjection = (
  source: CaseSourceObservation,
  steps: readonly FlowStepInput[],
): ExecutionObservation => {
  const pathSteps = steps.map((step, ordinal) =>
    pathStep(
      step,
      ordinal,
      source.executed
        ? source.outcome.execution === 'failed' ? 'failed' : 'executed'
        : source.outcome.authorization === 'denied' ? 'denied' : 'skipped',
    ));
  const path: ExecutionPath = {
    proposed: source.proposed ? pathSteps : [],
    authorized:
      source.outcome.authorization === 'allowed'
      || source.outcome.authorization === 'not_required'
        ? pathSteps
        : [],
    executed: source.executed ? pathSteps : [],
  };
  return {
    report_id: source.report_id,
    compiler_version: EXECUTION_CASE_COMPILER_VERSION,
    request_shape: source.request_shape,
    execution_path: path,
    flow_pattern: source.flow_pattern,
    flow_basis: source.flow_basis,
    outcome: source.outcome,
    outcome_strength: outcomeStrengthForObservations([source]),
  };
};

export const createExecutionCaseCompiler = (
  deps: ExecutionCaseCompilerDeps,
): ExecutionCaseCompiler => {
  const resolveRootForClose = (
    session_id: string,
    turn_id: string,
  ): string | undefined => {
    const localRoot = deps.anchorStore.resolveRoot(session_id, turn_id);
    const roots = new Set<string>();
    for (const plan of listAllPlans(deps.db)) {
      if (
        plan.session_id !== session_id
        || plan.execution_turn_id !== turn_id
      ) continue;
      const origin = deps.anchorStore.resolveRoot(
        plan.session_id,
        plan.turn_id,
      );
      if (origin) roots.add(origin);
    }
    // A single durable execution edge is authoritative. Multiple initiating
    // roots on one turn are ambiguous and must not be guessed together.
    if (roots.size > 1) return undefined;
    return roots.size === 1 ? [...roots][0] : localRoot;
  };

  const resolveSpan = (root_request_id: string): ResolvedExecutionSpan => {
    const anchors = deps.anchorStore.listAnchors(root_request_id);
    const anchorSet = new Set<string>(
      anchors.map((anchor) => `${anchor.session_id}\0${anchor.turn_id}`),
    );
    const allPlans = listAllPlans(deps.db);
    const includedPlanIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const plan of allPlans) {
        const proposedKey = `${plan.session_id}\0${plan.turn_id}`;
        const executionKey = plan.execution_turn_id === null
          ? undefined
          : `${plan.session_id}\0${plan.execution_turn_id}`;
        if (
          !anchorSet.has(proposedKey)
          && (executionKey === undefined || !anchorSet.has(executionKey))
          && (
            plan.retry_of_plan_id === null
            || !includedPlanIds.has(plan.retry_of_plan_id)
          )
        ) continue;
        if (!includedPlanIds.has(plan.plan_id)) {
          includedPlanIds.add(plan.plan_id);
          changed = true;
        }
        if (!anchorSet.has(proposedKey)) {
          anchorSet.add(proposedKey);
          changed = true;
        }
        if (executionKey !== undefined && !anchorSet.has(executionKey)) {
          anchorSet.add(executionKey);
          changed = true;
        }
      }
    }
    const rawActivities = listToolActivities(deps.db, anchorSet);
    const recipe_runs = listRecipeAuditEntries(deps.db, anchorSet);
    const { activities } = pairRecipeRuns(
      rawActivities,
      recipe_runs,
      deps.registry,
    );
    const plans = allPlans.filter((plan) => includedPlanIds.has(plan.plan_id));
    const feedback = deps.feedbackStore.listForRoot(root_request_id);
    const verifications =
      deps.verificationStore.listForRoot(root_request_id);
    const typed_correction_plan_ids = listTypedCorrections(
      deps.db,
      new Set(plans.map((plan) => plan.plan_id)),
    );
    const events = [
      ...activities.map((activity) => ({
        id: activity.activity_id,
        at: activity.timestamp,
      })),
      ...recipe_runs.map((run) => ({
        id: run.run_id,
        at: run.finished_at,
      })),
      ...plans.map((plan) => ({ id: plan.plan_id, at: plan.created_at })),
      ...feedback.map((item) => ({
        id: item.feedback_id,
        at: item.recorded_at,
      })),
      ...verifications.map((item) => ({
        id: item.verification_id,
        at: item.recorded_at,
      })),
    ].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const hasTerminalRunForPlan = (plan: PlanRow): boolean =>
      activities.some((activity) =>
        activity.tool_name === plan.tool
        && (
          activity.turn_id === plan.execution_turn_id
          || activity.turn_id === plan.turn_id
        )
        && isTerminalRecipeStatus(activity.recipe_status));
    const pending = plans.some((plan) =>
      plan.status === 'proposed'
      || (
        (
          plan.execution_status === 'running'
          || plan.execution_status === 'held'
        )
        && !hasTerminalRunForPlan(plan)
      ));
    const hasApprovalExpiry = recipe_runs.some(isApprovalExpiry);
    const hasStrongSignal =
      feedback.length > 0
      || verifications.length > 0
      || typed_correction_plan_ids.size > 0
      || activities.some((activity) =>
        activity.status === 'error'
        || isExecutionCaseGatewayDenialReason(activity.reason))
      || recipe_runs.some((run) =>
        run.commit_status === 'failed' && !isApprovalExpiry(run));
    const activitySignaturesByTurn = new Map<string, string[]>();
    for (const activity of activities) {
      const key = `${activity.session_id}\0${activity.turn_id}`;
      const list = activitySignaturesByTurn.get(key);
      const token = JSON.stringify([
        activity.tool_name,
        activity.recipe_id ?? '',
        activity.recipe_hash ?? '',
      ]);
      if (list) list.push(token);
      else activitySignaturesByTurn.set(key, [token]);
    }
    const turnFlowSignatures = [...activitySignaturesByTurn.values()]
      .map((tokens) => JSON.stringify(tokens));
    const hasObservedSupersession =
      turnFlowSignatures.length > 1
      && new Set(turnFlowSignatures).size > 1;
    const hasWeakSignal =
      plans.some((plan) => plan.status === 'cancelled')
      || hasObservedSupersession
      || hasApprovalExpiry;
    return {
      root_request_id,
      activities,
      recipe_runs,
      plans,
      feedback,
      verifications,
      typed_correction_plan_ids,
      first_event_id: events[0]?.id ?? `root:${root_request_id}`,
      last_event_id: events.at(-1)?.id ?? `root:${root_request_id}`,
      pending,
      has_substantive_flow: activities.length > 0 || plans.length > 0,
      has_strong_signal: hasStrongSignal,
      has_compilable_signal: hasStrongSignal || hasWeakSignal,
    };
  };

  const rebuildMaterialized = async (): Promise<number> => {
    const [observations, priorMaterialized, reports] = await Promise.all([
      deps.caseStore.listObservations(),
      deps.caseStore.listAll(),
      deps.reportStore.listAll(),
    ]);
    const rebuilt = rebuildExecutionCases(observations);
    for (const row of rebuilt.cases) {
      for (const flow of row.flows) {
        if (flow.tools.some((tool) => deps.registry.getByName(tool) === null)) {
          flow.stale = true;
        }
      }
    }
    const current = retainExecutionCases(
      rebuilt.cases,
      deps.max_cases_per_scope,
    );
    const sourceReportIdsByCase = new Map(
      rebuilt.source_report_ids_by_case,
    );
    const currentReportIds = new Set(
      reports.map((item) => item.report.report_id),
    );
    const currentCaseKeys = new Set(current.map((row) => row.case_key));
    const currentById = new Map(current.map((row) => [row.case_id, row]));
    const archivedBySuccessor = new Map<string, ExecutionCase[]>();

    // A compiler upgrade may change shape/key semantics. Preserve the prior
    // projection only when every one of its source reports still exists, then
    // attach it to the current case with the strongest source overlap. Same-key
    // rows are not forks: the new compiler reproduced the same case semantics.
    for (const prior of priorMaterialized) {
      if (
        prior.compiler_version >= EXECUTION_CASE_COMPILER_VERSION
        || currentCaseKeys.has(prior.case_key)
      ) continue;
      const priorSources = deps.caseStore.sourceReportIds(prior.case_id);
      if (
        priorSources.length === 0
        || priorSources.some((reportId) => !currentReportIds.has(reportId))
      ) continue;
      const priorSourceSet = new Set(priorSources);
      const successor = current
        .filter((row) =>
          row.governing_contract_id === prior.governing_contract_id
          && row.principal_key === prior.principal_key)
        .map((row) => ({
          row,
          overlap: (rebuilt.source_report_ids_by_case.get(row.case_id) ?? [])
            .filter((reportId) => priorSourceSet.has(reportId)).length,
        }))
        .filter((item) => item.overlap > 0)
        .sort((left, right) =>
          right.overlap - left.overlap
          || right.row.last_seen_at - left.row.last_seen_at
          || left.row.case_id.localeCompare(right.row.case_id))[0]?.row;
      if (!successor) continue;
      const archived: ExecutionCase = { ...prior };
      delete archived.supersedes;
      delete archived.superseded_by;
      sourceReportIdsByCase.set(archived.case_id, priorSources);
      const list = archivedBySuccessor.get(successor.case_id);
      if (list) list.push(archived);
      else archivedBySuccessor.set(successor.case_id, [archived]);
    }

    const combined = [...current];
    for (const [successorId, archived] of archivedBySuccessor) {
      const successor = currentById.get(successorId);
      if (!successor) continue;
      archived.sort((left, right) =>
        left.compiler_version - right.compiler_version
        || left.last_seen_at - right.last_seen_at
        || left.case_id.localeCompare(right.case_id));
      let predecessorId = successor.supersedes;
      for (const row of archived) {
        if (predecessorId) {
          row.supersedes = predecessorId;
          const predecessor =
            currentById.get(predecessorId)
            ?? combined.find((item) => item.case_id === predecessorId);
          if (predecessor) predecessor.superseded_by = row.case_id;
        }
        predecessorId = row.case_id;
        combined.push(row);
      }
      if (predecessorId) successor.supersedes = predecessorId;
      archived.at(-1)!.superseded_by = successor.case_id;
    }

    const retained = retainExecutionCases(
      combined,
      deps.max_cases_per_scope,
    );
    const retainedIds = new Set(retained.map((row) => row.case_id));
    for (const caseId of [...sourceReportIdsByCase.keys()]) {
      if (!retainedIds.has(caseId)) sourceReportIdsByCase.delete(caseId);
    }
    const representativePromptByCase = new Map<string, string>();
    for (const row of retained) {
      const reportIds = new Set(
        rebuilt.source_report_ids_by_case.get(row.case_id) ?? [],
      );
      const observation = observations.find((item) =>
        reportIds.has(item.report_id));
      if (observation) {
        representativePromptByCase.set(row.case_id, observation.root_request);
      }
    }
    await deps.caseStore.replaceMaterialized(
      retained,
      sourceReportIdsByCase,
      representativePromptByCase,
    );
    return retained.length;
  };

  const compileReportSource = async (
    report_id: string,
    rebuildAfter = true,
  ): Promise<number> => {
    const stored = await deps.reportStore.get(report_id);
    if (!stored || stored.closed_at === undefined) return 0;
    const report = stored.report;
    // The per-report projection is derived too. Clear the prior compiler's
    // attachment first so a newly ineligible/zero-observation report cannot
    // retain a stale positive or negative summary.
    deps.reportStore.clearObservation(report_id);
    const rootRequest = report.root_request;
    const dissection = await deps.dissectionStore.get(report.root_request_id);
    const analysis = analyzeExecutionCaseRequest(rootRequest, dissection);
    const requestShape = analysis.request_shape;
    if (!requestShape) return 0;
    const span = resolveSpan(report.root_request_id);
    const observations: Array<{
      source: CaseSourceObservation;
      steps: FlowStepInput[];
    }> = [];
    // Every cancelled proposal remains its own negative flow observation.
    for (const plan of span.plans.filter((item) => item.status === 'cancelled')) {
      const planFeedback = span.feedback.filter((item) =>
        item.source_plan_id === plan.plan_id);
      const planFeedbackEvidence = evidenceFromFeedback(planFeedback);
      const steps = [
        flowStep(plan.tool, deps.registry, {
          approval_boundary: 'held',
        }),
      ];
      const evidence: CaseEvidenceKind[] = [
        'untyped_decline',
        ...(span.typed_correction_plan_ids.has(plan.plan_id)
          ? ['typed_correction' as const]
          : []),
        ...planFeedbackEvidence,
        'model_claim',
      ];
      const outcome: ExecutionOutcome = {
        model_claim: report.model_claim,
        authorization: 'dismissed',
        execution: 'not_executed',
        verification: 'unavailable',
        feedback: span.typed_correction_plan_ids.has(plan.plan_id)
          ? 'corrected'
          : feedbackAxisFor(planFeedback),
      };
      const flow = deriveExecutionFlowPattern(steps);
      observations.push({
        source: {
          observation_id: `${report.report_id}:plan:${plan.plan_id}`,
          report_id: report.report_id,
          root_request_id: report.root_request_id,
          root_request: rootRequest,
          governing_contract_id: report.governing_contract_id,
          principal_key: report.principal_key ?? '',
          compiler_version: EXECUTION_CASE_COMPILER_VERSION,
          policy_fingerprint: stored.policy_fingerprint,
          request_shape: requestShape,
          flow_pattern: flow,
          flow_basis: 'proposed',
          outcome,
          evidence_kinds: [...new Set(evidence)],
          substantive_call_count: 1,
          span_closed: true,
          intent_drifted: false,
          consulted_case_keys: report.consulted_case_keys,
          observed_at: report.reported_at,
          proposed: true,
          plan_accepted: false,
          plan_declined: true,
          executed: false,
        },
        steps,
      });
    }

    // A span is a conversation. Distinct durable turns therefore form distinct
    // flow observations rather than one concatenated mega-sequence. A later
    // different flow makes the earlier one an observed weak negative; the last
    // flow may be positive only when its per-turn dissection still hashes to the
    // initiating intent core.
    const activityGroups = new Map<string, ParsedChatToolActivity[]>();
    for (const activity of span.activities) {
      const key = `${activity.session_id}\0${activity.turn_id}`;
      const list = activityGroups.get(key);
      if (list) list.push(activity);
      else activityGroups.set(key, [activity]);
    }
    const grouped = [...activityGroups.values()]
      .map((activities) => ({
        activities: [...activities].sort((left, right) =>
          left.timestamp - right.timestamp
          || left.activity_id.localeCompare(right.activity_id)),
      }))
      .sort((left, right) =>
        left.activities[0]!.timestamp - right.activities[0]!.timestamp
        || left.activities[0]!.activity_id.localeCompare(
          right.activities[0]!.activity_id,
        ));
    const rootShapeHash = requestShapeHash(requestShape);
    const groupFlows = grouped.map((group) => {
      const groupPlans = span.plans.filter((plan) =>
        plan.execution_turn_id === group.activities[0]!.turn_id
        || (
          plan.turn_id === group.activities[0]!.turn_id
          && group.activities.some((activity) =>
            activity.tool_name === plan.tool)
        ));
      const steps = group.activities.map((activity) =>
        flowStep(activity.tool_name, deps.registry, {
          ...(activity.recipe_id
            ? { recipe_id: activity.recipe_id }
            : {}),
          ...(activity.recipe_hash
            ? { recipe_hash: activity.recipe_hash }
            : {}),
          approval_boundary:
            groupPlans.some((plan) =>
              plan.tool === activity.tool_name && plan.status === 'approved')
              ? 'approved'
              : isExecutionCaseGatewayDenialReason(activity.reason)
                ? 'denied'
                : 'none',
        }));
      return {
        ...group,
        groupPlans,
        steps,
        flow: deriveExecutionFlowPattern(steps),
      };
    });
    for (let groupIndex = 0; groupIndex < groupFlows.length; groupIndex += 1) {
      const group = groupFlows[groupIndex]!;
      const identity = group.activities[0]!;
      const superseded = groupFlows.slice(groupIndex + 1).some((later) =>
        later.flow.exact_signature !== group.flow.exact_signature);
      const isLast = groupIndex === groupFlows.length - 1;
      const verification = isLast
        ? verificationFor(span.verifications)
        : 'unavailable';
      if (isLast && group.steps[0]) {
        group.steps[group.steps.length - 1] = {
          ...group.steps[group.steps.length - 1]!,
          verification_boundary: verification,
        };
        group.flow = deriveExecutionFlowPattern(group.steps);
      }
      const abandoned = group.activities.some((activity) =>
        activity.recipe_error_codes?.includes(
          'RECIPE_APPROVAL_TIMEOUT',
        ) === true);
      const failed = !abandoned && group.activities.some((activity) =>
        activity.status === 'error'
        || activity.recipe_status === 'failed');
      const denied = group.activities.some((activity) =>
        isExecutionCaseGatewayDenialReason(activity.reason));
      const groupFeedback = isLast
        ? span.feedback.filter((item) =>
            item.source_plan_id === undefined
            || group.groupPlans.some((plan) =>
              plan.plan_id === item.source_plan_id))
        : [];
      const feedbackEvidenceForGroup = evidenceFromFeedback(groupFeedback);
      const feedbackAxisForGroup = feedbackAxisFor(groupFeedback);
      const verificationEvidence = isLast
        ? evidenceFromVerification(span.verifications)
        : [];
      let intentDrifted = false;
      if (isLast && groupIndex > 0) {
        const dissectionForTurn = await deps.dissectionStore.getForTurn(
          report.root_request_id,
          identity.session_id,
          identity.turn_id,
        );
        if (dissectionForTurn) {
          const turnIntentGrounded = isExecutionCaseIntentGrounded(
            rootRequest,
            dissectionForTurn.intent,
          );
          const turnShape = analyzeExecutionCaseRequest(
            rootRequest,
            dissectionForTurn,
          ).request_shape;
          intentDrifted =
            !turnIntentGrounded
            || !turnShape
            || requestShapeHash(turnShape) !== rootShapeHash;
        } else {
          // A changed later flow without a request-only dissection is
          // ambiguous. Suppressing its positive is the fail-safe direction;
          // every observed negative still files under the initiating shape.
          intentDrifted = groupFlows
            .slice(0, groupIndex)
            .some((prior) =>
              prior.flow.exact_signature !== group.flow.exact_signature);
        }
      }
      const evidence: CaseEvidenceKind[] = [
        ...(failed ? ['execution_failure' as const] : []),
        ...(denied ? ['gateway_denial' as const] : []),
        ...(superseded ? ['flow_superseded' as const] : []),
        ...(abandoned ? ['abandoned' as const] : []),
        ...feedbackEvidenceForGroup,
        ...verificationEvidence,
        ...(!superseded
          && !failed
          && !denied
          && !abandoned
          && feedbackEvidenceForGroup.length === 0
          && verificationEvidence.length === 0
          ? ['unverified_success' as const]
          : []),
        'model_claim',
      ];
      const groupFeedbackAxis = isLast
        ? feedbackAxisForGroup
        : 'unknown';
      const outcome: ExecutionOutcome = {
        model_claim: report.model_claim,
        authorization: abandoned
          ? 'expired'
          : denied
          ? 'denied'
          : group.groupPlans.some((plan) => plan.status === 'approved')
            ? 'allowed'
            : 'not_required',
        execution: abandoned || denied
          ? 'not_executed'
          : failed ? 'failed' : 'succeeded',
        verification,
        feedback: groupFeedbackAxis,
      };
      observations.push({
        source: {
          observation_id:
            `${report.report_id}:turn:${identity.session_id}:${identity.turn_id}:`
            + group.flow.exact_signature,
          report_id: report.report_id,
          root_request_id: report.root_request_id,
          root_request: rootRequest,
          governing_contract_id: report.governing_contract_id,
          principal_key: report.principal_key ?? '',
          compiler_version: EXECUTION_CASE_COMPILER_VERSION,
          policy_fingerprint: stored.policy_fingerprint,
          request_shape: requestShape,
          flow_pattern: group.flow,
          flow_basis: denied || abandoned ? 'proposed' : 'executed',
          outcome,
          evidence_kinds: [...new Set(evidence)],
          substantive_call_count: group.activities.length,
          span_closed: true,
          intent_drifted: intentDrifted,
          consulted_case_keys: report.consulted_case_keys,
          observed_at: Math.max(
            report.reported_at,
            group.activities.at(-1)!.timestamp,
          ),
          proposed: group.groupPlans.length > 0,
          plan_accepted: group.groupPlans.some((plan) =>
            plan.status === 'approved'),
          plan_declined: false,
          executed: !denied && !abandoned,
        },
        steps: group.steps,
      });
    }

    for (const observation of observations) {
      await deps.caseStore.putObservation(observation.source);
    }
    if (observations[0]) {
      await deps.reportStore.attachObservation(
        report.report_id,
        outcomeObservationProjection(
          observations[0].source,
          observations[0].steps,
        ),
      );
    }
    // A report with no analyzable request shape or no flow still needs a
    // durable compiler marker; otherwise every retrieval would replay it.
    deps.caseStore.markReportCompiled(
      report.report_id,
      EXECUTION_CASE_COMPILER_VERSION,
    );
    if (rebuildAfter) await rebuildMaterialized();
    return observations.length;
  };

  let replayInFlight: Promise<number> | undefined;
  let fullReplayInFlight = false;
  const compiledCoverageIsCurrent = (): boolean => {
    const closedReportIds = deps.reportStore.closedReportIds();
    const compiledReports = deps.caseStore.compiledReportVersions();
    return compiledReports.size === closedReportIds.length
      && closedReportIds.every((reportId) =>
        compiledReports.get(reportId) === EXECUTION_CASE_COMPILER_VERSION);
  };

  const canCompileIncrementally = (report_id: string): boolean => {
    if (
      deps.caseStore.compilerVersion() !== EXECUTION_CASE_COMPILER_VERSION
    ) return false;
    const closedReportIds = deps.reportStore.closedReportIds();
    if (!closedReportIds.includes(report_id)) return false;
    const closed = new Set(closedReportIds);
    const compiledReports = deps.caseStore.compiledReportVersions();
    for (const id of closedReportIds) {
      if (id === report_id) continue;
      if (
        compiledReports.get(id) !== EXECUTION_CASE_COMPILER_VERSION
      ) return false;
    }
    for (const id of compiledReports.keys()) {
      if (id !== report_id && !closed.has(id)) return false;
    }
    return true;
  };

  const recompileAll = (): Promise<number> => {
    if (replayInFlight) {
      return fullReplayInFlight
        ? replayInFlight
        : replayInFlight.then(() => recompileAll());
    }
    fullReplayInFlight = true;
    replayInFlight = (async () => {
      let materialized = 0;
      for (;;) {
        const [allReports, priorObservations] = await Promise.all([
          deps.reportStore.listAll(),
          deps.caseStore.listObservations(),
        ]);
        const reports = allReports
          .filter((stored) => stored.closed_at !== undefined);
        const replayBoundary = reports
          .map((stored) => stored.report.report_id)
          .sort();
        // Invalidate the completion stamp before touching derived rows. If the
        // process stops or one source fails to replay, the next reader retries
        // the authoritative rebuild instead of accepting a partial projection.
        deps.caseStore.clearCompilerVersion();
        deps.caseStore.clearCompiledReports();
        // Reports and correlated raw stores are authoritative. Clear every
        // derived source, including an orphan left by an interrupted legacy
        // migration, so a stale version cannot make ensureCurrent replay
        // forever after the valid reports have been rebuilt.
        for (const reportId of new Set(
          priorObservations.map((item) => item.report_id),
        )) {
          deps.caseStore.deleteObservation(reportId);
        }
        for (const stored of reports) {
          await compileReportSource(stored.report.report_id, false);
        }
        materialized = await rebuildMaterialized();
        const currentBoundary = deps.reportStore.closedReportIds();
        if (
          currentBoundary.length === replayBoundary.length
          && currentBoundary.every((id, index) => id === replayBoundary[index])
        ) {
          deps.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);
          return materialized;
        }
        // A report closed or was deleted during replay. Keep the stamp absent
        // and fold the new authoritative boundary before releasing readers.
      }
    })().finally(() => {
      replayInFlight = undefined;
      fullReplayInFlight = false;
    });
    return replayInFlight;
  };

  const ensureCurrent = async (): Promise<void> => {
    if (replayInFlight) {
      await replayInFlight;
    }
    if (
      deps.caseStore.compilerVersion() === EXECUTION_CASE_COMPILER_VERSION
      && compiledCoverageIsCurrent()
    ) return;
    await recompileAll();
  };

  const compileReport = async (report_id: string): Promise<number> => {
    if (replayInFlight) await replayInFlight;
    if (
      deps.caseStore.compilerVersion() === EXECUTION_CASE_COMPILER_VERSION
      && compiledCoverageIsCurrent()
    ) return deps.caseStore.observationCount(report_id);
    if (!canCompileIncrementally(report_id)) {
      await ensureCurrent();
      return deps.caseStore.observationCount(report_id);
    }

    // Normal closure or typed-feedback record/retract changes one report.
    // Serialize it with replay work, keep the completion stamp absent until
    // replacement succeeds,
    // and preserve old source joins long enough to build upgrade lineage.
    replayInFlight = (async () => {
      deps.caseStore.clearCompilerVersion();
      deps.caseStore.deleteObservation(report_id);
      const count = await compileReportSource(report_id, false);
      await rebuildMaterialized();
      if (compiledCoverageIsCurrent()) {
        deps.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);
      }
      return count;
    })().finally(() => {
      replayInFlight = undefined;
    });
    return replayInFlight;
  };

  const rebuild = async (): Promise<number> => {
    await ensureCurrent();
    while (replayInFlight) await replayInFlight;
    replayInFlight = rebuildMaterialized().finally(() => {
      replayInFlight = undefined;
    });
    return replayInFlight;
  };

  return {
    resolveRootForClose,
    resolveSpan,
    compileReport,
    recompileAll,
    ensureCurrent,
    rebuild,
    async deleteSource(report_id) {
      while (replayInFlight) await replayInFlight;
      replayInFlight = (async () => {
        deps.caseStore.clearCompilerVersion();
        deps.caseStore.deleteUnsupported(report_id);
        deps.reportStore.delete(report_id);
        const materialized = await rebuildMaterialized();
        deps.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);
        return materialized;
      })().finally(() => {
        replayInFlight = undefined;
      });
      return replayInFlight;
    },
    runtimeCompositionDiagnostics() {
      const activityRows = tableExists(deps.db, 'audit_activities')
        ? deps.db.prepare(`
            SELECT data FROM audit_activities
             WHERE json_extract(data, '$.action') = 'chat_tool_call'
             ORDER BY json_extract(data, '$.timestamp') ASC,
                      json_extract(data, '$.activity_id') ASC
          `).all() as Array<{ data: string }>
        : [];
      const rawActivities = activityRows.flatMap(
        (row): ParsedChatToolActivity[] => {
          const parsed = parseToolActivity(row.data);
          return parsed ? [parsed] : [];
        },
      );
      const recipeRuns = listRecipeAuditEntries(deps.db);
      const paired = pairRecipeRuns(
        rawActivities,
        recipeRuns,
        deps.registry,
      );
      const events: Array<{
        root_request_id: string;
        at: number;
        id: string;
        route_kind: RuntimeCompositionDispatch['route_kind'];
        tool_name: string;
        recipe_id?: string;
        recipe_hash?: string;
        operation_ids: string[];
      }> = [];
      for (const activity of paired.activities) {
        const root = deps.anchorStore.resolveRoot(
          activity.session_id,
          activity.turn_id,
        );
        if (!root || D214_INTERNAL_TOOL_NAMES.has(activity.tool_name)) continue;
        const route_kind =
          activity.recipe_id === 'run-ingredient'
            ? 'dynamic_ingredient' as const
            : activity.recipe_id !== undefined
              ? activity.tool_name === 'recipe.run'
                ? 'inline_recipe' as const
                : 'installed_recipe' as const
              : 'direct_tool' as const;
        events.push({
          root_request_id: root,
          at: activity.timestamp,
          id: activity.activity_id,
          route_kind,
          tool_name: activity.tool_name,
          ...(activity.recipe_id
            ? { recipe_id: activity.recipe_id }
            : {}),
          ...(activity.recipe_hash
            ? { recipe_hash: activity.recipe_hash }
            : {}),
          operation_ids: [activity.tool_name],
        });
      }
      for (const run of recipeRuns) {
        if (paired.paired_run_ids.has(run.run_id)) continue;
        const root = deps.anchorStore.resolveRoot(run.session_id, run.turn_id);
        if (!root) continue;
        const installed = deps.registry.getByName(run.recipe_id)?.tier === 2;
        events.push({
          root_request_id: root,
          at: run.started_at,
          id: run.run_id,
          route_kind:
            run.recipe_id === 'run-ingredient'
              ? 'dynamic_ingredient'
              : installed ? 'installed_recipe' : 'inline_recipe',
          tool_name: run.recipe_id,
          recipe_id: run.recipe_id,
          recipe_hash: run.recipe_hash,
          operation_ids: [run.recipe_id],
        });
      }
      events.sort((left, right) =>
        left.at - right.at || left.id.localeCompare(right.id));
      const ordinalByRoot = new Map<string, number>();
      const dispatches: RuntimeCompositionDispatch[] = events.map((event) => {
        const ordinal = ordinalByRoot.get(event.root_request_id) ?? 0;
        ordinalByRoot.set(event.root_request_id, ordinal + 1);
        return {
          root_request_id: event.root_request_id,
          ordinal,
          route_kind: event.route_kind,
          tool_name: event.tool_name,
          ...(event.recipe_id ? { recipe_id: event.recipe_id } : {}),
          ...(event.recipe_hash ? { recipe_hash: event.recipe_hash } : {}),
          operation_ids: event.operation_ids,
          dependency_ordinals: ordinal === 0 ? [] : [ordinal - 1],
        };
      });
      return {
        ...measureRuntimeComposition(dispatches),
        source_coverage: {
          audit_activity_rows: rawActivities.length,
          recipe_run_rows: recipeRuns.length,
          paired_recipe_runs: paired.paired_run_ids.size,
          unpaired_recipe_runs:
            recipeRuns.length - paired.paired_run_ids.size,
        },
      };
    },
    async diagnostics() {
      await ensureCurrent();
      const [reports, observations, materialized] = await Promise.all([
        deps.reportStore.listAll(),
        deps.caseStore.listObservations(),
        deps.caseStore.listAll(),
      ]);
      const request_shape_source_reports = {
        grounded_dissection: 0,
        ungrounded_dissection_fallback: 0,
        missing_dissection_fallback: 0,
      };
      await Promise.all(reports.map(async ({ report }) => {
        const dissection = await deps.dissectionStore.get(
          report.root_request_id,
        );
        if (!dissection) {
          request_shape_source_reports.missing_dissection_fallback += 1;
        } else if (
          isExecutionCaseIntentGrounded(
            report.root_request,
            dissection.intent,
          )
        ) {
          request_shape_source_reports.grounded_dissection += 1;
        } else {
          request_shape_source_reports.ungrounded_dissection_fallback += 1;
        }
      }));
      const eligible = rebuildExecutionCases(observations).cases;
      const evidence_family_case_counts: Record<string, number> = {};
      for (const row of materialized) {
        for (const family of row.outcome_strength.evidence_families) {
          evidence_family_case_counts[family] =
            (evidence_family_case_counts[family] ?? 0) + 1;
        }
      }
      return {
        compiler_version: EXECUTION_CASE_COMPILER_VERSION,
        source_reports: reports.length,
        source_observations: observations.length,
        eligible_cases_before_retention: eligible.length,
        materialized_cases: materialized.length,
        storage_pressure_evictions:
          Math.max(0, eligible.length - materialized.length),
        contested_cases: materialized.filter((row) =>
          row.outcome_strength.contested).length,
        superseded_cases: materialized.filter((row) =>
          row.superseded_by !== undefined).length,
        scopes: new Set(materialized.map((row) =>
          `${row.governing_contract_id}\0${row.principal_key}`)).size,
        evidence_family_case_counts,
        request_shape_source_reports,
      };
    },
  };
};

export const policyFingerprintForSpan = (input: {
  governing_contract_id: string;
  tools: readonly string[];
  registry: InternalToolRegistry;
  /** False means the span required no authorization decision at all. */
  authorization_applied?: boolean;
  /** Dispatch-time snapshots from recipe/run audit rows, when present. */
  contract_snapshots?: readonly unknown[];
}): string => {
  if (
    input.tools.length === 0
    || input.authorization_applied === false
  ) return 'none';
  return hashExecutionCaseValue({
    governing_contract_id: input.governing_contract_id,
    tools: input.tools.map((tool) => {
      const entry = input.registry.getByName(tool);
      return {
        tool,
        classification: entry?.classification ?? 'unknown',
        risk_tier: entry?.risk_tier ?? 'none',
        destructive_hint: entry?.destructive_hint === true,
      };
    }),
    contract_snapshots: [...(input.contract_snapshots ?? [])],
  });
};

export const caseKeyForObservation = (
  observation: CaseSourceObservation,
): string =>
  executionCaseKey({
    governing_contract_id: observation.governing_contract_id,
    principal_key: observation.principal_key,
    request_shape_hash: requestShapeHash(observation.request_shape),
    policy_fingerprint: observation.policy_fingerprint,
  });
