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
  executionCaseOfferableVerdicts,
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
  /** D-219 — the tool-loop round that emitted this call. Absent on rows written
   *  before the field shipped and on any dispatch outside the chat tool loop. */
  round_index?: number;
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
    // D-219 — which tool-loop round emitted the call. Absent on every row
    // written before this shipped, and on every non-tool-loop dispatch, so it
    // is read as UNKNOWN rather than defaulted: `round 0` would assert that a
    // historical pair was batched, which is precisely the false claim this
    // field exists to stop making.
    ...(typeof detail.round_index === 'number'
      && Number.isInteger(detail.round_index)
      && detail.round_index >= 0
      ? { round_index: detail.round_index }
      : {}),
  };
};

/** Test-only view of {@link parseToolActivity}.
 *
 *  ⚠ Exported for coverage, not for use: the round field is written by the chat
 *  orchestrator and read here, and "the writer puts it there" is a separate
 *  claim from "the reader takes it out". This lets the second be asserted
 *  against the REAL row shape rather than a hand-built object that could drift
 *  from what is actually stored. */
export const parseChatToolActivityForTest = (
  raw: string,
): ReturnType<typeof parseToolActivity> => parseToolActivity(raw);

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`
    SELECT 1 AS ok FROM sqlite_master
     WHERE type = 'table' AND name = ?
  `).get(name) !== undefined;

/** ⛔ The anchor filter belongs in SQL, and it used to be applied only in JS.
 *
 *  This ran on every compile, i.e. every governed turn since 9a: it read EVERY
 *  `chat_tool_call` row the server had ever written, `JSON.parse`d each one into
 *  an object, and then kept the two or three belonging to this span. Measured on
 *  60 turns against a seeded backlog of unrelated chat tool calls, one
 *  `finalizeTurn` cost **0.94 ms at 0 rows, 5.5 ms at 2k, 24 ms at 10k and
 *  105 ms at 40k** — linear in the whole audit history, and `audit_activities`
 *  is a long-lived shared table that gains a row per tool call forever.
 *
 *  ⚠ **SQL NARROWS; JS STILL DECIDES.** The `anchors.has(...)` check below is
 *  unchanged and remains the authority, so the SQL predicate only has to avoid
 *  UNDER-selecting.
 *
 *  ⛔ A RANGE, not `LIKE`. `LIKE 'sess:turn:%'` was the obvious spelling and it
 *  is worse twice over: `_` and `%` are LIKE wildcards, so an id containing
 *  either would silently widen the match, and `LIKE` cannot use an ordered index
 *  if one is ever added. The prefix always ends in `:` (0x3A), so its exclusive
 *  upper bound is the same string ending in `;` (0x3B) — an exact half-open
 *  range over SQLite's byte-wise string ordering, with no wildcard semantics at
 *  all. */
const listToolActivities = (
  db: Database.Database,
  anchors: ReadonlySet<string>,
): ParsedChatToolActivity[] => {
  if (!tableExists(db, 'audit_activities')) return [];
  if (anchors.size === 0) return [];
  const bounds = [...anchors].flatMap((anchor) => {
    const separator = anchor.indexOf('\0');
    const prefix =
      `${anchor.slice(0, separator)}:${anchor.slice(separator + 1)}:`;
    return [prefix, `${prefix.slice(0, -1)};`];
  });
  const rows = db.prepare(`
    SELECT data FROM audit_activities
     WHERE json_extract(data, '$.action') = 'chat_tool_call'
       AND (${[...anchors].map(() =>
         `(json_extract(data, '$.target') >= ?`
         + ` AND json_extract(data, '$.target') < ?)`).join(' OR ')})
     ORDER BY json_extract(data, '$.timestamp') ASC, key ASC
  `).all(...bounds) as Array<{ data: string }>;
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

/** `<publisher>/<slug>` → `<slug>`, else null.
 *
 *  The model invokes an installed recipe by its QUALIFIED name — the
 *  `recipe.run` descriptor (§ A.13) says so — but `RecipeStore` is keyed by the
 *  BARE recipe_id with the publisher in a separate column, and
 *  `resolveRecipeId` (`chat-tool-handlers.ts`) strips the prefix before
 *  execution. So the audit row records `send-email` while the chat activity
 *  records `bench/send-email`, and a name-equality match can never bridge them.
 *
 *  That gap is not cosmetic: an unpaired run leaves `failed` false, and the
 *  evidence deriver's else-branch then files `unverified_success` — a POSITIVE
 *  kind. Every installed recipe that FAILED was being recorded as precedent
 *  that it WORKED. Measured on substrate-bench 155 (a denied `bench/send-email`
 *  filed `['unverified_success','model_claim']`), and pinned in
 *  `d-214-recipe-run-pairing.test.ts`.
 *
 *  Same rule as `resolveRecipeId`: split on the FIRST slash, require a
 *  non-empty prefix and suffix. Two publishers can ship one slug, so this can
 *  in principle mis-pair — but only for two same-slug recipes dispatched in the
 *  SAME session and turn, and the existing `recipe.run` clause below already
 *  matches ANY non-`run-ingredient` run in the turn, which is strictly looser
 *  than this. */
const bareRecipeId = (toolName: string): string | null => {
  const slash = toolName.indexOf('/');
  if (slash <= 0 || slash === toolName.length - 1) return null;
  return toolName.slice(slash + 1);
};

/** Every run error code that means THE OWNER (or policy on their behalf)
 * REFUSED, as opposed to the flow breaking.
 *
 * Named rather than inlined because V8 originally hardcoded one string.
 * `RECIPE_APPROVAL_DENIED` — message "You blocked this step. The recipe stopped
 * without making the change." — is declared in the `RecipeErrorCode` union and
 * currently emitted by nothing, so today only `RECIPE_POLICY_DENIED` occurs.
 * The moment anything emits the other, a one-string check would silently file
 * an owner refusal as a capability failure again, which is the exact defect V7
 * and V8 were fixing. A hand-copied vocabulary is how this class of bug
 * recurs; deriving the check from one named set is how it stops.
 *
 * ⛔ `RECIPE_APPROVAL_TIMEOUT` is deliberately NOT here — an expiry is
 * `abandoned`, a third outcome that is neither a refusal nor a breakage. */
const OWNER_REFUSAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'RECIPE_POLICY_DENIED',
  'RECIPE_APPROVAL_DENIED',
]);

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
    const bare = bareRecipeId(activity.tool_name);
    const index = candidates.findIndex((run) =>
      run.recipe_id === activity.tool_name
      || run.recipe_id === bare
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
  /** At least one governed activity or plan. THE recording gate since D-219
   * slice 9a: a span with neither yields zero observations by construction. */
  has_substantive_flow: boolean;
  /** ⚠ NOTHING READS THIS — no consumer since the original D-214 build, and it
   * is left in place rather than swept because it predates this arc. Its
   * companion `has_compilable_signal` (strong signals plus durable weak
   * negatives) WAS the recording gate and was removed with slice 9a, which
   * orphaned it: every turn holding governed work is recorded now, so there is
   * nothing left for a signal predicate to decide. */
  has_strong_signal: boolean;
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
  /** ⛔ D-219 item 2 — the owner says "unlearn this", and it has to STAY
   *  unlearned.
   *
   *  ⛔⛔ **DELETING THE MATERIALIZED CASE WOULD BE A NO-OP THAT LOOKS LIKE A
   *  FIX.** A case is a PROJECTION: `rebuildMaterialized` re-derives every one
   *  of them from the source observations, so a row removed here is back on the
   *  next compile — which is the next governed turn. The button would report
   *  success, the owner would believe the thing was gone, and it would be
   *  showing again within minutes. Forgetting therefore means removing what
   *  ADMITS it: the source reports (with their observations, source joins and
   *  compiled markers) plus the owner verdicts recorded against their roots.
   *
   *  ⚠ **A shared source takes its other case with it, and that is disclosed
   *  rather than prevented.** One report yields one observation per activity
   *  group, and those normally share a request shape (they come from one root
   *  request) — but nothing guarantees it, and refusing to delete a shared
   *  report would be worse: the forgotten case keeps a live source and returns
   *  on the next rebuild, i.e. a forget that silently does not forget. The
   *  result reports what actually went so the caller can say so.
   *
   *  Returns `removed: false` for an unknown case id — nothing was there to
   *  forget, which is not an error. */
  forgetCase(case_id: string): Promise<{
    removed: boolean;
    reports: number;
    observations: number;
    feedback: number;
    /** Root VERIFICATIONS dropped. ⛔ Not cosmetic: these are `strongKinds`
     *  evidence, so leaving them re-admitted the case with no fresh owner
     *  verdict — the defect this count now makes visible to a caller. */
    verifications: number;
    /** Cases materialized AFTER the rebuild. A drop of more than one means a
     *  shared source report took another case with it. */
    cases_remaining: number;
  }>;
  /** ⛔ D-219 — retention for the corpus 9a made grow on every governed turn.
   *
   *  Drops source reports (and their observations, source joins and compiled
   *  markers) that are older than `before` AND back no materialized case.
   *
   *  ⛔ THE "BACKS NO CASE" HALF IS LOAD-BEARING, not an optimisation.
   *  `rebuildMaterialized` preserves a prior projection only while EVERY one of
   *  its source reports still exists, so pruning a supporting report would not
   *  shrink storage — it would silently DELETE the precedent on the next
   *  rebuild. Retention that eats what it is retaining is amnesia. */
  pruneSourcesOlderThan(before: number): Promise<{
    reports: number;
    observations: number;
  }>;
  /** A26 argument-free measurement over durable chat dispatch history. */
  runtimeCompositionDiagnostics(): RuntimeCompositionDiagnostics;
  diagnostics(): Promise<{
    compiler_version: number;
    source_reports: number;
    source_observations: number;
    eligible_cases_before_retention: number;
    offerable_observations: number;
    offerable_verdict_counts: Record<string, number>;
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
    // ⚠ `entry.tier`, NOT `risk_tier` — adjacent names, unrelated axes.
    // `risk_tier` is read/write; `tier` is 1 = core primitive / 2 = installed
    // recipe / 3 = MCP passthrough, which is what admission depth turns on.
    // Undefined when the registry does not know the tool, which empties the
    // whole `tool_tiers` array rather than guessing.
    ...(entry?.tier !== undefined ? { tier: entry.tier } : {}),
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
    const hasStrongSignal =
      feedback.length > 0
      || verifications.length > 0
      || typed_correction_plan_ids.size > 0
      || activities.some((activity) =>
        activity.status === 'error'
        || isExecutionCaseGatewayDenialReason(activity.reason))
      || recipe_runs.some((run) =>
        run.commit_status === 'failed' && !isApprovalExpiry(run));
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
    };
  };

  const rebuildMaterialized = async (): Promise<number> => {
    // ⛔ `allReportIds()`, NOT `listAll()`. The only thing this function wants
    // from the report table is the SET OF IDS THAT STILL EXIST, and `listAll`
    // opened four AEAD-sealed fields per row to hand back plaintext that was
    // discarded on the next line. Measured over 200 sequential turns it was the
    // largest single per-turn cost — ~6.3 ms per compile at 100 reports, rising
    // with the corpus, because every turn re-decrypted the whole table.
    //
    // ⚠ The two remaining reads are NOT additive: they run in one `Promise.all`
    // and each is CPU-bound on AEAD opens, so a naive per-call timing shows one
    // blocked behind the other. `caseStore.listAll()` measured 2.4 ms/call
    // against an EMPTY table for exactly that reason — it is bounded by
    // `max_cases_per_scope` and is not the growth.
    const currentReportIds = new Set(deps.reportStore.allReportIds());
    const [observations, priorMaterialized] = await Promise.all([
      deps.caseStore.listObservations(),
      deps.caseStore.listAll(),
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

  /** ⛔ D-219 — rebuild ONLY the case keys a compile actually touched.
   *
   *  The full rebuild decrypts every stored observation on every turn, which is
   *  what makes per-turn cost proportional to the whole corpus (measured
   *  quadratic over a session's life). A closing turn changes the grouping of
   *  the keys its own observations file under and NOTHING ELSE, so those are the
   *  only groups that need re-deriving.
   *
   *  ⚠ Everything that is a GLOBAL decision still runs globally, because each is
   *  bounded by `max_cases_per_scope` rather than by the corpus:
   *  - **staleness** is re-evaluated over every case, not just the rebuilt ones.
   *    A tool that disappeared makes OLD cases stale too, and a card proposing a
   *    tool that no longer exists is exactly what the flag prevents.
   *  - **retention** runs over the merged set, so a new case can still evict an
   *    old one at the cap.
   *  - **the write** replaces the whole materialized set, as before.
   *
   *  ⛔ Returns `null` — meaning "caller must do the full rebuild" — whenever the
   *  scoped result could differ from the global one:
   *  - any stored observation predates the `case_key` column (a pre-migration
   *    row would be silently missing from its group, changing what admits);
   *  - any prior case was compiled by an OLDER compiler, which is the only
   *    condition under which the supersession/lineage branch does anything.
   *  Failing to the full rebuild is always correct and merely slow; guessing is
   *  not recoverable. */
  const rebuildMaterializedForCaseKeys = async (
    caseKeys: readonly string[],
  ): Promise<number | null> => {
    if (caseKeys.length === 0) return null;
    if (deps.caseStore.keylessObservationCount() > 0) return null;
    const priorMaterialized = await deps.caseStore.listAll();
    if (priorMaterialized.some((row) =>
      row.compiler_version < EXECUTION_CASE_COMPILER_VERSION)) return null;

    const keys = new Set(caseKeys);
    const observations =
      await deps.caseStore.listObservationsForCaseKeys([...keys]);
    const rebuilt = rebuildExecutionCases(observations);
    // Prior rows for the touched keys are REPLACED by what was just derived;
    // a key whose observations no longer admit simply contributes nothing, so
    // the case disappears — which is the same outcome the full rebuild reaches.
    // ⛔ AN UNTOUCHED CASE IS CARRIED FORWARD ONLY WHILE SOMETHING STILL BACKS
    // IT, and this is not belt-and-braces — a test caught the scoped rebuild
    // leaving a stale case standing where the full one dropped it.
    //
    // The affected-key set cannot always see the key an observation LEFT.
    // `reprojectClosedReports` (the owner recording or retracting a verdict)
    // calls `deleteUnsupported` — which removes the observation AND the
    // case-source join — BEFORE `compileReport` runs, so by then the old key is
    // unreadable. The full rebuild never had this problem because it derives
    // every case from observations and an unbacked one simply does not reappear.
    //
    // So the carry-forward is checked directly, which is the same rule
    // `rebuildMaterialized` states for preserving a prior projection: every one
    // of its source reports must still exist. Ids only — nothing is decrypted
    // to establish it.
    const currentReportIds = new Set(deps.reportStore.allReportIds());
    const untouched = priorMaterialized.filter((row) => {
      if (keys.has(row.case_key)) return false;
      const sources = deps.caseStore.sourceReportIds(row.case_id);
      return sources.length > 0
        && sources.every((reportId) => currentReportIds.has(reportId));
    });
    const merged = [...untouched, ...rebuilt.cases];
    for (const row of merged) {
      for (const flow of row.flows) {
        flow.stale =
          flow.tools.some((tool) => deps.registry.getByName(tool) === null);
      }
    }
    const retained = retainExecutionCases(merged, deps.max_cases_per_scope);
    const sourceReportIdsByCase = new Map<string, readonly string[]>();
    for (const row of retained) {
      const sources = rebuilt.source_report_ids_by_case.get(row.case_id)
        // An untouched case keeps the join it already had. Read as ids only —
        // no sealed payload is opened to preserve it.
        ?? deps.caseStore.sourceReportIds(row.case_id);
      if (sources.length > 0) sourceReportIdsByCase.set(row.case_id, sources);
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
      // ⛔ Load-bearing: this rebuild has no observation for the cases it left
      // alone, so without it every untouched case would lose its representative
      // prompt and stage-1 retrieval would quietly degrade to a term join.
      { preserveMissingPrompts: true },
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
          session_id: stored.session_id,
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
          // V20 — carried from the audit row, never derived here. Absent on a
          // pre-V20 row, which `deriveExecutionFlowPattern` turns into an empty
          // `round_ordinals` for the WHOLE flow rather than a partial array.
          ...(activity.round_index !== undefined
            ? { round_index: activity.round_index }
            : {}),
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
      // A denial reaches the span by TWO routes, and reading only the first
      // filed the commoner one as a capability failure.
      //
      //   1. An activity-level refusal — the dispatch itself errors with a
      //      gateway denial reason (`policy_denied`, `classification_blocked`).
      //   2. A PREFLIGHT refusal — the owner denies a HELD run after the turn.
      //      `denyRun` flips the run anchor to failed with
      //      `RECIPE_POLICY_DENIED`, and the pairing marks the dispatching
      //      activity `status: 'error'` while leaving `reason` UNDEFINED. So
      //      route 2 is invisible to a reason-only predicate, and
      //      `failed && !denied` recorded the owner's refusal as "this broke".
      //
      // Route 2 is the shape substrate-bench produces and arguably the
      // commonest real one: a held action the owner declines. Missing it is the
      // same defect the ruling was about — owner judgement recorded as a
      // capability fact — just on the path that actually occurs.
      const denied = group.activities.some((activity) =>
        isExecutionCaseGatewayDenialReason(activity.reason)
        || (activity.recipe_error_codes ?? []).some((code) =>
          OWNER_REFUSAL_ERROR_CODES.has(code)));
      // D-214 admission attribution — every code this group's runs reported.
      const groupFailureCodes = group.activities.flatMap(
        (activity) => activity.recipe_error_codes ?? [],
      );
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
        // A DENIAL IS NOT A FAILURE. `execution_failure` is evidence about
        // CAPABILITY — the flow was attempted and did not work, so repeating it
        // will not work either. `gateway_denial` is evidence about the OWNER'S
        // JUDGEMENT — the flow works fine and the owner chose not to run it
        // that time. Filing a denial as both told the card "this broke" when
        // the truth was "you said no", and the model could not tell a flow that
        // fails from one the owner declined.
        //
        // The exclusion is not new semantics: `outcome.execution` twenty lines
        // below already reads `abandoned || denied ? 'not_executed' : failed
        // ? 'failed' : 'succeeded'`, and the experiment axis already excludes
        // gateway-denial reasons from `execution_failure`. This evidence array
        // was the one place still conflating them — measured in
        // `d-214-evidence-derivation-bench` via a surviving mutation.
        //
        // The warning is NOT lost: `gateway_denial` is itself a strong negative
        // in `materialNegativeFamilies`, so one denial still marks the flow a
        // material contradiction and still reaches the card. What changes is
        // that it arrives as "previously declined" rather than "previously
        // failed" — which is a question for the owner to answer again, not a
        // capability fact for the substrate to conclude on their behalf.
        // ⛔ ATTRIBUTION GATE. `failed` alone is not a lesson. `MIN_CALLS_NEGATIVE
        // = 1` lets a single failure file as durable precedent, justified as
        // "for this ask, not tool A" — which holds only when the failure is
        // attributable to the CHOICE. A stopwatch (`RECIPE_BUDGET_EXCEEDED`), a
        // lost ack (`ACTION_DELIVERY_UNCERTAIN`) or a rate limit says nothing
        // about whether the tool suited the ask, and filing it teaches the model
        // to avoid a flow that was never at fault. Measured: an LLM bench run
        // produced three cases, two of them single-observation stopwatch noise.
        //
        // ⚠ Refuses only what is POSITIVELY environmental. An empty or unmapped
        // code list files exactly as before — the inverse polarity was tried and
        // refused every uncoded failure, which is a far larger change than the
        // noise it removes.
        ...(failed && !denied && !abandoned
          ? ['execution_failure' as const]
          : []),
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
          session_id: identity.session_id,
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
          // WHY it failed, not merely THAT it did. Codes only — the thrown
          // message interpolates values (MAIL_SEND_SELF_LOOP_TO embeds the
          // recipient address), so the card renders the static
          // `ERROR_MESSAGES[code]` instead. Empty unless something failed.
          ...((): { failure_codes?: string[] } => {
            const codes = [...new Set(
              group.activities.flatMap((a) => a.recipe_error_codes ?? []),
            )].sort();
            return codes.length > 0 ? { failure_codes: codes } : {};
          })(),
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
      // ⛔ BOTH SIDES of the recompile. The keys this report's observations
      // filed under BEFORE, because deleting them can empty a case; and the
      // keys they file under AFTER, because a re-derived observation can MOVE
      // to a different case (a dissection arriving changes the request shape).
      // Taking only one side leaves a stale case standing or a new one absent.
      const affected = new Set(deps.caseStore.caseKeysForReports([report_id]));
      deps.caseStore.deleteObservation(report_id);
      const count = await compileReportSource(report_id, false);
      for (const key of deps.caseStore.caseKeysForReports([report_id])) {
        affected.add(key);
      }
      // `null` means the scoped path could not guarantee the global result.
      const scoped = await rebuildMaterializedForCaseKeys([...affected]);
      if (scoped === null) await rebuildMaterialized();
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
    async forgetCase(case_id) {
      while (replayInFlight) await replayInFlight;
      // Collected BEFORE anything is deleted: after the first removal the
      // case-source join is gone, and a second read would find nothing left to
      // delete while the remaining reports still admit the case.
      const reportIds = deps.caseStore.sourceReportIds(case_id);
      if (reportIds.length === 0) {
        // Unknown or already-forgotten. ⚠ Deliberately NOT a rebuild: on a
        // corpus with nothing to drop that is the most expensive no-op in the
        // system, for the same reason the retention pruner refuses one.
        return {
          removed: false,
          reports: 0,
          observations: 0,
          feedback: 0,
          verifications: 0,
          cases_remaining: (await deps.caseStore.listAll()).length,
        };
      }
      const roots = new Set<string>();
      // ⛔⛔ THE LATCH MUST BE HELD ACROSS THE ROOT READS TOO. It used to be
      // assigned only after this loop, and the loop AWAITS — so a compile or a
      // verifier could start inside that window and rebuild from a corpus this
      // call was about to mutate. The read moved INSIDE `work` so one latch
      // covers read-then-delete, which is the whole point of taking it.
      const work = (async () => {
        for (const reportId of reportIds) {
          const stored = await deps.reportStore.get(reportId);
          if (stored) roots.add(stored.report.root_request_id);
        }
        deps.caseStore.clearCompilerVersion();
        let observations = 0;
        for (const reportId of reportIds) {
          observations += deps.caseStore.observationCount(reportId);
          deps.caseStore.deleteUnsupported(reportId);
          deps.reportStore.delete(reportId);
        }
        // ⛔ The owner's verdicts go too. With the span gone nothing can replay
        // them, so leaving them would store a fact about the owner that no code
        // can ever read — the exact shape this arc keeps finding and removing.
        // It is also what a person means by "forget": the answer they gave is
        // the asset, so unlearning has to include it.
        let feedback = 0;
        // ⛔⛔ AND THE ROOT'S VERIFICATIONS, WHICH THIS MISSED ENTIRELY. Found by
        // a Codex audit on 2026-07-29 and verified: `verification_pass` and
        // `verification_fail` are both in `strongKinds`, and `compileReport`
        // reloads them per root — so a forgotten case was RE-ADMITTED with no
        // fresh owner verdict at all, which is the one thing forget promises.
        //
        // ⚠ The test that was supposed to prove otherwise only ever exercised
        // the UNWITNESSED path ("same shape, no answer → stays gone") and I
        // generalised it. A retained verification was never constructed.
        let verifications = 0;
        for (const root of roots) {
          feedback += deps.feedbackStore.deleteForRoot(root);
          verifications += deps.verificationStore.deleteForRoot(root);
        }
        const materialized = await rebuildMaterialized();
        deps.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);
        return {
          removed: true,
          reports: reportIds.length,
          observations,
          feedback,
          verifications,
          cases_remaining: materialized,
          materialized,
        };
      })();
      // The SAME latch every other corpus mutation takes — a forget racing a
      // compile would rebuild from a half-deleted corpus.
      replayInFlight = work
        .then((result) => result.materialized)
        .finally(() => {
          replayInFlight = undefined;
        });
      const result = await work;
      return {
        removed: result.removed,
        reports: result.reports,
        observations: result.observations,
        feedback: result.feedback,
        verifications: result.verifications,
        cases_remaining: result.cases_remaining,
      };
    },
    async pruneSourcesOlderThan(before) {
      while (replayInFlight) await replayInFlight;
      const [reports, cases] = await Promise.all([
        deps.reportStore.listAll(),
        deps.caseStore.listAll(),
      ]);
      // Every report any materialized case still rests on. Collected BEFORE
      // anything is deleted, because this is the set that must survive.
      const supporting = new Set<string>();
      for (const row of cases) {
        for (const id of deps.caseStore.sourceReportIds(row.case_id)) {
          supporting.add(id);
        }
      }
      const doomed = reports.filter((stored) =>
        !supporting.has(stored.report.report_id)
        // A report that never closed cannot close later — its span was
        // abandoned mid-flight — so age it from when it was written.
        && (stored.closed_at ?? stored.report.reported_at) < before);
      // ⚠ Nothing to do means NOTHING TO DO. A rebuild here would be the most
      // expensive no-op in the system: it reads every observation and rebuilds
      // every case, which is precisely the cost this retention exists to bound.
      if (doomed.length === 0) return { reports: 0, observations: 0 };
      const work = (async () => {
        deps.caseStore.clearCompilerVersion();
        let observations = 0;
        for (const stored of doomed) {
          const reportId = stored.report.report_id;
          observations += deps.caseStore.observationCount(reportId);
          // Removes the observations, the case-source join AND the compiled
          // marker in one transaction. ⛔ The marker matters: a compiled-report
          // row outliving its report makes `canCompileIncrementally` refuse
          // forever, silently downgrading EVERY later turn to a full replay.
          deps.caseStore.deleteUnsupported(reportId);
          deps.reportStore.delete(reportId);
        }
        const materialized = await rebuildMaterialized();
        deps.caseStore.setCompilerVersion(EXECUTION_CASE_COMPILER_VERSION);
        return { reports: doomed.length, observations, materialized };
      })();
      // Serialised against every other corpus mutation through the SAME latch
      // the replay/compile paths use — a prune racing a compile would rebuild
      // from a half-deleted corpus. The latch is number-shaped, so the prune's
      // own richer result is returned separately rather than cast through it.
      replayInFlight = work
        .then((result) => result.materialized)
        .finally(() => {
          replayInFlight = undefined;
        });
      const { reports: prunedReports, observations } = await work;
      return { reports: prunedReports, observations };
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
        // D-219 slice 6 — how many CLOSED observations the owner could still be
        // asked about, and which answers would actually file. After slices 2–4
        // the substrate admits almost nothing unaided, so this is the number
        // that says whether the corpus is empty because nothing HAPPENED or
        // because nobody was ASKED. Measurable before anything renders it.
        offerable_observations: observations.filter((observation) =>
          executionCaseOfferableVerdicts(observation).length > 0).length,
        offerable_verdict_counts: observations.reduce<Record<string, number>>(
          (acc, observation) => {
            for (const verdict of executionCaseOfferableVerdicts(observation)) {
              acc[verdict] = (acc[verdict] ?? 0) + 1;
            }
            return acc;
          },
          {},
        ),
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
