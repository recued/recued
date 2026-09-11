/** D-261: a proposal is a locator for owner review, never an execution permit.
 * Public methods deliberately contain no origin, grant or approved input. */
import { RpcError } from './rpc/types.js';

export const PREAPPROVAL_PROTOCOL_VERSION = 1 as const;
export const PREAPPROVAL_NOTIFICATION_HANDLER = 'preapproval.review.v1' as const;
export const PREAPPROVAL_LIMITS = Object.freeze({
  candidate_calls: 100,
  plan_bytes: 256 * 1024,
  pending_per_origin: 20,
  pending_per_realm: 200,
  requests_per_minute: 10,
  challenge_ms: 5 * 60 * 1000,
  default_decision_ms: 24 * 60 * 60 * 1000,
  default_dispatch_grace_ms: 15 * 60 * 1000,
  list_default: 25,
  list_max: 100,
});
export type PreapprovalLimits = { -readonly [K in keyof typeof PREAPPROVAL_LIMITS]: number };

export const PREAPPROVAL_ERROR_CODES = [
  'preapproval_unsupported', 'preapproval_no_eligible_members',
  'preapproval_unresolved', 'preapproval_target_mismatch',
  'preapproval_request_policy_conflict', 'preapproval_limit_exceeded',
  'preapproval_idempotency_conflict', 'preapproval_stale',
  'preapproval_expired', 'preapproval_cancelled',
  'preapproval_authority_changed', 'preapproval_decision_conflict',
  'preapproval_invalid_proof', 'preapproval_already_claimed',
  'preapproval_in_doubt',
] as const;
export type PreapprovalErrorCode = (typeof PREAPPROVAL_ERROR_CODES)[number];

export type PreapprovalJson = null | boolean | number | string
  | PreapprovalJson[] | { [key: string]: PreapprovalJson };
export type PreapprovalActivation =
  | { kind: 'one_shot'; run_at: number; time_zone: string }
  | { kind: 'next_schedule'; schedule_id: string; expected_revision: number }
  | { kind: 'next_auto_run'; recipe_id: string; publisher_id: string; expected_revision: number }
  | { kind: 'next_trigger'; trigger_id: string; expected_revision: number };
export interface PreparePreapproval {
  idempotency_key: string;
  subject:
    | { kind: 'recipe'; recipe_id: string; publisher_id: string; config: Record<string, PreapprovalJson> }
    | { kind: 'mail_draft'; draft_id: string; draft_revision: number };
  activation: PreapprovalActivation;
  decision_deadline: number;
  dispatch_deadline: number;
}
export type PreapprovalProposalStatus = 'awaiting_owner' | 'approved' | 'denied'
  | 'cancelled' | 'expired' | 'invalidated';
/** The operation tiers a reviewed member can carry. Mirrors the runtime's own
 *  `PreparedInvocation['risk']`; declared here so the review shape is complete. */
export type PreapprovalRiskTier = 'read' | 'write' | 'admin' | 'destructive';
export type PreapprovalExecutionStatus = 'prepared' | 'active' | 'running' | 'held'
  | 'succeeded' | 'partial' | 'failed' | 'in_doubt' | 'cancelled' | 'expired' | 'invalidated';
export type PreapprovalGrantStatus = 'active' | 'exhausted' | 'revoked' | 'expired' | 'invalidated';
export type PreapprovalMemberStatus = 'available' | 'dispatching' | 'succeeded' | 'failed'
  | 'in_doubt' | 'skipped' | 'cancelled' | 'expired' | 'invalidated';
export type PreapprovalDecision = 'approve' | 'deny' | 'cancel';
export type PreapprovalBindingFamily = 'kernel' | 'http' | 'graphql' | 'mcp' | 'cli' | 'dom' | 'ai';

export interface PreapprovalResult {
  proposal_id: string;
  revision: number;
  future_execution_ref: string;
  status: PreapprovalProposalStatus;
  coverage: 'complete' | 'partial';
  eligible_members: number;
  uncovered_calls: number;
}
export interface PreapprovalSelection {
  proposal_id: string;
  expected_revision: number;
  member_ids: string[];
}
export interface PreapprovalDecisionRequest {
  proposal_id: string;
  expected_revision: number;
  review_digest: string;
  challenge: string;
  decision: PreapprovalDecision;
  request_id: string;
}
export interface PreapprovalDecisionReceipt {
  decision_id: string;
  proposal_id: string;
  future_execution_ref: string;
  grant_id: string | null;
  proposal_revision: number;
  review_digest: string;
  decision: PreapprovalDecision;
  decided_at: number;
  execution_status: PreapprovalExecutionStatus;
}
export interface PreapprovalRevokeRequest {
  grant_id: string;
  expected_revision: number;
  request_id: string;
}
export interface PreapprovalListRequest { cursor?: string; limit?: number }

/** A path is structural. Equal args never collapse two loop/child calls. */
export type PreapprovalInvocationPath = Array<
  | { kind: 'recipe'; publisher_id: string; recipe_id: string; definition_hash: string }
  | { kind: 'step'; phase: 'trigger' | 'prefetch' | 'sequential'; step_id: string }
  | { kind: 'iteration'; index: number }
  | { kind: 'dependency'; slot: string; index: number }
>;
/** Shared by preparation and the live engine. Neither a path nor a member ID
 * grants authority; the host also requires the bound future run and claim. */
export const preapprovalStepPath = (
  recipePath: PreapprovalInvocationPath,
  phase: 'trigger' | 'prefetch' | 'sequential', stepId: string, iterations: readonly number[] = [],
): PreapprovalInvocationPath => [
  ...recipePath,
  { kind: 'step', phase, step_id: stepId },
  ...iterations.map((index): PreapprovalInvocationPath[number] => ({ kind: 'iteration', index })),
];
export const preapprovalChildPath = (
  parentPath: PreapprovalInvocationPath, slot: string, index: number,
): PreapprovalInvocationPath => [...parentPath, { kind: 'dependency', slot, index }];
export interface PreapprovalResourcePin {
  kind: string;
  key: string;
  incarnation: string;
  revision: number;
  content_hash: string;
}
export interface PreapprovalMemberReview {
  member_id: string;
  parent_member_id: string | null;
  required_child_ids: string[];
  invocation_path: PreapprovalInvocationPath;
  op_id: string;
  family: PreapprovalBindingFamily;
  /** ⛔ REQUIRED READING, NOT A HINT. Since `always` / `destructive` became
   *  eligible (2026-09-06), the tier is the single fact that most changes the
   *  owner's decision — and it was the one field the review did not carry while
   *  it was still showing content hashes nobody can verify by eye. */
  risk: PreapprovalRiskTier;
  label: string;
  detail: string;
  /** Semantic values only; credentials and private dispatch markers are absent. */
  arguments: Record<string, PreapprovalJson>;
  /** Resolved selectors and account/resource identities are part of what the
   * owner reviews, even when normalized input arguments are unchanged. */
  output: Record<string, string>;
  connection_id: string | null;
  account_id: string | null;
  resources: PreapprovalResourcePin[];
  conditional: boolean;
  eligible: boolean;
  reason: string | null;
}
export interface PreapprovalUncoveredCall {
  invocation_path: PreapprovalInvocationPath;
  op_id: string | null;
  reason: string;
  subtree: boolean;
}
export interface PreapprovalReview extends PreapprovalResult {
  review_digest: string;
  challenge: string;
  challenge_expires_at: number;
  requested_through: { contract_id: string | null; display_name: string; credential_label: string | null };
  recipe: { recipe_id: string; publisher_id: string; display_name: string };
  activation: PreapprovalActivation;
  scheduled_for: number | null;
  time_zone: string;
  decision_deadline: number;
  dispatch_deadline: number;
  members: PreapprovalMemberReview[];
  selected_member_ids: string[];
  uncovered: PreapprovalUncoveredCall[];
  interaction_notes: string[];
}
export interface PreapprovalMemberOutcome {
  member_id: string;
  parent_member_id: string | null;
  op_id: string;
  label: string;
  status: PreapprovalMemberStatus;
  action_ref: string | null;
  commit_id: string | null;
  run_id?: string | null;
  status_message: string | null;
  reconciled_outcome: 'succeeded' | 'failed' | null;
}
export interface PreapprovalInspection extends PreapprovalResult {
  retired_review?: { at: number; recipe_name: string };
  /** Full immutable material for an individual owner's get. List pages omit
   * it. No challenge is minted by inspecting an accepted execution. */
  reviewed?: Omit<PreapprovalReview, 'challenge' | 'challenge_expires_at'>;
  execution_status: PreapprovalExecutionStatus;
  status_reason: string | null;
  grant: { grant_id: string; revision: number; status: PreapprovalGrantStatus } | null;
  decision: PreapprovalDecisionReceipt | null;
  members: PreapprovalMemberOutcome[];
  created_at: number;
  updated_at: number;
}
export interface PreapprovalCapabilities {
  protocol_version: typeof PREAPPROVAL_PROTOCOL_VERSION;
  activation_kinds: PreapprovalActivation['kind'][];
  bindings: Array<{ family: PreapprovalBindingFamily; identity_version: number }>;
  child_calls: string[];
  decision_channels: Array<'webclient' | 'telegram'>;
  limits: PreapprovalLimits;
}

const bad = (): never => { throw new RpcError('bad_request', 'Invalid pre-approval request.', 400); };
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return bad();
  return value as Record<string, unknown>;
};
const closed = (value: unknown, required: string[], optional: string[] = []): Record<string, unknown> => {
  const row = object(value);
  if (required.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return bad();
  return row;
};
const string = (value: unknown, max = 512): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return bad();
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad();
  return value;
};
export const parsePreapprovalId = (value: unknown, prefix: 'pap' | 'paf' | 'pag' | 'pam' | 'pad'): string => {
  const id = string(value, 40);
  if (!new RegExp(`^${prefix}_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(id)) return bad();
  return id;
};
export const parsePreapprovalHash = (value: unknown): string => {
  const hash = string(value, 71);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) return bad();
  return hash;
};
export const parsePreapprovalLocator = (value: unknown): { proposal_id: string } => {
  const row = closed(value, ['proposal_id']);
  return { proposal_id: parsePreapprovalId(row.proposal_id, 'pap') };
};
/** No coercion, prototype keys, cycles, non-finite numbers or unbounded depth. */
export const parsePreapprovalJson = (value: unknown, depth = 0, seen = new Set<object>()): PreapprovalJson => {
  if (depth > 32) return bad();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : bad();
  if (typeof value !== 'object' || seen.has(value)) return bad();
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => parsePreapprovalJson(item, depth + 1, seen));
    const row = object(value);
    const result: Record<string, PreapprovalJson> = {};
    for (const key of Object.keys(row)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return bad();
      result[key] = parsePreapprovalJson(row[key], depth + 1, seen);
    }
    return result;
  } finally { seen.delete(value); }
};
export const parsePreapprovalActivation = (value: unknown): PreapprovalActivation => {
  const kind = object(value).kind;
  if (kind === 'one_shot') {
    const row = closed(value, ['kind', 'run_at', 'time_zone']);
    const time_zone = string(row.time_zone, 128);
    try { new Intl.DateTimeFormat('en', { timeZone: time_zone }); } catch { return bad(); }
    return { kind, run_at: integer(row.run_at), time_zone };
  }
  if (kind === 'next_schedule') {
    const row = closed(value, ['kind', 'schedule_id', 'expected_revision']);
    return { kind, schedule_id: string(row.schedule_id), expected_revision: integer(row.expected_revision) };
  }
  if (kind === 'next_auto_run') {
    const row = closed(value, ['kind', 'recipe_id', 'publisher_id', 'expected_revision']);
    return { kind, recipe_id: string(row.recipe_id), publisher_id: string(row.publisher_id), expected_revision: integer(row.expected_revision) };
  }
  if (kind === 'next_trigger') {
    const row = closed(value, ['kind', 'trigger_id', 'expected_revision']);
    return { kind, trigger_id: string(row.trigger_id), expected_revision: integer(row.expected_revision) };
  }
  return bad();
};
export const parsePreparePreapproval = (value: unknown): PreparePreapproval => {
  const row = closed(value, ['idempotency_key', 'subject', 'activation', 'decision_deadline', 'dispatch_deadline']);
  const subject = object(row.subject);
  let parsedSubject: PreparePreapproval['subject'];
  if (subject.kind === 'recipe') {
    closed(subject, ['kind', 'recipe_id', 'publisher_id', 'config']);
    const config = parsePreapprovalJson(object(subject.config)) as Record<string, PreapprovalJson>;
    if (new TextEncoder().encode(JSON.stringify(config)).byteLength > PREAPPROVAL_LIMITS.plan_bytes) return bad();
    parsedSubject = { kind: 'recipe', recipe_id: string(subject.recipe_id), publisher_id: string(subject.publisher_id), config };
  } else if (subject.kind === 'mail_draft') {
    closed(subject, ['kind', 'draft_id', 'draft_revision']);
    parsedSubject = { kind: 'mail_draft', draft_id: string(subject.draft_id), draft_revision: integer(subject.draft_revision) };
  } else return bad();
  const decision_deadline = integer(row.decision_deadline);
  const dispatch_deadline = integer(row.dispatch_deadline);
  const activation = parsePreapprovalActivation(row.activation);
  if (decision_deadline >= dispatch_deadline || (activation.kind === 'one_shot'
    && (decision_deadline > activation.run_at || activation.run_at >= dispatch_deadline))) return bad();
  return { idempotency_key: string(row.idempotency_key, 128), subject: parsedSubject,
    activation, decision_deadline, dispatch_deadline };
};
export const parsePreapprovalSelection = (value: unknown): PreapprovalSelection => {
  const row = closed(value, ['proposal_id', 'expected_revision', 'member_ids']);
  if (!Array.isArray(row.member_ids) || row.member_ids.length === 0
    || row.member_ids.length > PREAPPROVAL_LIMITS.candidate_calls) return bad();
  const member_ids = row.member_ids.map(id => parsePreapprovalId(id, 'pam'));
  if (new Set(member_ids).size !== member_ids.length) return bad();
  return { proposal_id: parsePreapprovalId(row.proposal_id, 'pap'),
    expected_revision: integer(row.expected_revision), member_ids };
};
export const parsePreapprovalDecision = (value: unknown): PreapprovalDecisionRequest => {
  const row = closed(value, ['proposal_id', 'expected_revision', 'review_digest', 'challenge', 'decision', 'request_id']);
  if (row.decision !== 'approve' && row.decision !== 'deny' && row.decision !== 'cancel') return bad();
  const challenge = string(row.challenge, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return bad();
  return { proposal_id: parsePreapprovalId(row.proposal_id, 'pap'),
    expected_revision: integer(row.expected_revision), review_digest: parsePreapprovalHash(row.review_digest),
    challenge, decision: row.decision, request_id: string(row.request_id, 128) };
};
export const parsePreapprovalRevoke = (value: unknown): PreapprovalRevokeRequest => {
  const row = closed(value, ['grant_id', 'expected_revision', 'request_id']);
  return { grant_id: parsePreapprovalId(row.grant_id, 'pag'),
    expected_revision: integer(row.expected_revision), request_id: string(row.request_id, 128) };
};
export const parsePreapprovalList = (value: unknown): Required<PreapprovalListRequest> => {
  const row = closed(value ?? {}, [], ['cursor', 'limit']);
  const limit = row.limit === undefined ? PREAPPROVAL_LIMITS.list_default : integer(row.limit);
  if (limit < 1 || limit > PREAPPROVAL_LIMITS.list_max) return bad();
  return { cursor: row.cursor === undefined ? '' : parsePreapprovalId(row.cursor, 'pap'), limit };
};
