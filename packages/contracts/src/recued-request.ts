/** D-145 PB3 — `RecuedRequest` shape (contracts).
 *
 *  Per § B.1.1. The single entry-point input to the engine. Carries
 *  the user's chat input + any context the chat surface attaches +
 *  optional pre-classification hints + audit / tier policy. Pure
 *  type + closed-list enums; no IO, no behavior.
 *
 *  The orchestrator (`packages/engine/src/orchestrator/`) consumes
 *  this shape; per-primitive modules under
 *  `packages/engine/src/primitives/` consume narrower per-primitive
 *  inputs derived from the request + intermediate primitive outputs.
 *
 *  Spec: D-145 § B.1.1 + § B.5 + § B.7. */

import type { AuditPolicy, ClassificationIntentKind, ContextBreadth, ModelTier } from './recued-plan.js';

// ── N.1 — RecuedRequestSurface (closed list, 7 values) ──────────────

/** Where the request originated. Drives surface-aware brokering
 *  decisions (e.g. extension surface can consult `current_page`;
 *  scheduled surface skips approval prompts that need a live user). */
export const RECUED_REQUEST_SURFACES = [
  'webclient',
  'extension',
  'mcp_chat',
  'recipe_invoke',
  'scheduled',
  'reactive',
  'compose',
] as const;
export type RecuedRequestSurface = (typeof RECUED_REQUEST_SURFACES)[number];
export const RECUED_REQUEST_SURFACE_SET: ReadonlySet<RecuedRequestSurface> = new Set(
  RECUED_REQUEST_SURFACES,
);

// ── N.2 — ClassificationIntent ──────────────────────────────────────

/** Optional pre-classified intent a caller may attach before invoking
 *  the orchestrator — a surviving contract fragment of the retired
 *  two-stage classifier design (§ B.17, RETIRED; D-164 P6). The live
 *  single-stage chat path neither produces nor requires it; every live
 *  caller is treated as a single `chat_only` intent at narrow breadth.
 *  Retained for the dormant `executeRecuedRequest` seam + the D-150
 *  bench facade. */
export interface ClassificationIntent {
  intent_id: string;
  kind: ClassificationIntentKind;
  /** Closed-list narrowing tags for downstream recipe filtering. */
  topic_tags: string[];
  /** Confidence score from the classifier — 0 to 1 inclusive. */
  confidence?: number;
}

// ── N.3 — RecuedRequest ─────────────────────────────────────────────

/** § B.1.1 — engine entry-point input. The orchestrator persists the
 *  derived `RecuedPlan` per `audit_policy.retain_for_days` (default 90
 *  per D-120). Sensitive requests carry `audit_policy.redact_user_-
 *  request: true` and the orchestrator stamps the redaction marker
 *  before signing. */
export interface RecuedRequest {
  /** Caller-provided UUID. Used as `plan_id` when the orchestrator
   *  emits the persisted RecuedPlan. */
  request_id: string;
  /** Groups multi-step goals (§ B.5.1). Defaults to `request_id`. */
  goal_id?: string;
  /** Raw user chat input. The orchestrator stamps
   *  `REDACTED_USER_REQUEST_MARKER` into the persisted plan when
   *  `audit_policy.redact_user_request: true`. */
  user_request: string;
  /** Conversation thread id — groups the turns of one chat session. */
  conversation_id?: string;
  /** Where the request came from. */
  surface: RecuedRequestSurface;

  // ── Optional context the chat surface attaches ──

  /** URL or path the user is currently on (extension surface). */
  current_page?: string;
  /** Recent commitment IDs (PA1 work entities) the surface considered
   *  load-bearing for context shaping. The broker rules in § B.2 may
   *  still omit them on token budget / privacy grounds. */
  recent_commitments?: string[];
  /** Free-form preference bag the surface may attach. The broker
   *  treats this as untrusted hints — never drives privacy or
   *  tier decisions directly. */
  user_preferences?: Record<string, unknown>;

  // ── Audit + tier hints ──

  /** Per-request audit policy override. The orchestrator merges this
   *  on top of the substrate-default policy (90-day retain,
   *  high_assurance: false, redact_user_request: false). */
  audit_policy?: Partial<AuditPolicy>;
  /** Per-request tier override (§ B.3.2 rule 2). The orchestrator
   *  feeds this through `selectSynthesisTier` clamped against
   *  Standing Instruction min/max bounds + budget downgrade. */
  model_hint?: ModelTier;
  /** PB13 Dry Run flag. When true, mutating primitives record
   *  `preview_no_op` status and the engine returns a preview plan
   *  without side effects. The user reviews and confirms; the
   *  orchestrator re-runs the same request without `preview`. */
  preview?: boolean;

  // ── Optional pre-classification hints (retired two-stage Stage 1) ──

  /** Optional pre-classified intents — a dormant fragment of the retired
   *  two-stage design (see `ClassificationIntent`). The live single-stage
   *  path omits them; when omitted the orchestrator treats the request as
   *  a single `chat_only` intent at narrow breadth. */
  intents?: ClassificationIntent[];
  /** Context-breadth signal from the retired two-stage classifier
   *  (dormant). Defaults to `'narrow'` when omitted. */
  context_breadth?: ContextBreadth;

  // ── Metadata ──

  /** Unix-ms when the surface accepted the user's input. The
   *  orchestrator stamps `RecuedPlan.started_at` from this field
   *  when present, otherwise from `Date.now()`. */
  received_at?: number;
}

// ── N.4 — Validator (runtime) ───────────────────────────────────────

/** PB3 validator issue kinds. Closed list — drift requires a spec
 *  change. The validator collects every issue (does NOT bail on the
 *  first) so callers see every problem at once. */
export const RECUED_REQUEST_VALIDATION_ISSUE_KINDS = [
  'request_id_missing',
  'request_id_malformed',
  'user_request_missing',
  'unknown_surface',
  'unknown_model_hint',
  'unknown_context_breadth',
  'unknown_intent_kind',
  'intent_id_collision',
  'intent_confidence_out_of_range',
  'received_at_negative',
] as const;
export type RecuedRequestValidationIssueKind =
  (typeof RECUED_REQUEST_VALIDATION_ISSUE_KINDS)[number];

export interface RecuedRequestValidationIssue {
  kind: RecuedRequestValidationIssueKind;
  path?: string;
  detail: string;
}

export class RecuedRequestValidationError extends Error {
  readonly code = 'RECUED_REQUEST_MALFORMED' as const;
  readonly issues: ReadonlyArray<RecuedRequestValidationIssue>;
  constructor(issues: ReadonlyArray<RecuedRequestValidationIssue>) {
    super(`RecuedRequest malformed: ${issues.length} issue(s)`);
    this.name = 'RecuedRequestValidationError';
    this.issues = issues;
  }
}

const REQUEST_ID_REGEX = /^[A-Za-z0-9_\-:]{1,200}$/;

/** Validate a `RecuedRequest`. Pure function — collects every issue
 *  rather than bailing on the first. The orchestrator calls
 *  `assertValidRecuedRequest` defensively before deriving its plan
 *  so downstream primitives never see a partial-validated request. */
export const validateRecuedRequest = (
  request: RecuedRequest,
): RecuedRequestValidationIssue[] => {
  const issues: RecuedRequestValidationIssue[] = [];

  if (!request.request_id || request.request_id.length === 0) {
    issues.push({
      kind: 'request_id_missing',
      path: 'request_id',
      detail: 'request_id is required',
    });
  } else if (!REQUEST_ID_REGEX.test(request.request_id)) {
    issues.push({
      kind: 'request_id_malformed',
      path: 'request_id',
      detail: `request_id '${request.request_id}' does not match ${REQUEST_ID_REGEX}`,
    });
  }

  if (request.user_request === undefined || request.user_request === null) {
    issues.push({
      kind: 'user_request_missing',
      path: 'user_request',
      detail: 'user_request is required (may be empty string)',
    });
  }

  if (!RECUED_REQUEST_SURFACE_SET.has(request.surface)) {
    issues.push({
      kind: 'unknown_surface',
      path: 'surface',
      detail: `surface '${(request as { surface?: string }).surface ?? '<undefined>'}' is not in RECUED_REQUEST_SURFACES`,
    });
  }

  if (
    request.model_hint !== undefined
    && request.model_hint !== 'fast'
    && request.model_hint !== 'mid'
    && request.model_hint !== 'reasoning'
  ) {
    issues.push({
      kind: 'unknown_model_hint',
      path: 'model_hint',
      detail: `model_hint '${request.model_hint}' must be 'fast' | 'mid' | 'reasoning'`,
    });
  }

  if (
    request.context_breadth !== undefined
    && request.context_breadth !== 'narrow'
    && request.context_breadth !== 'wide'
  ) {
    issues.push({
      kind: 'unknown_context_breadth',
      path: 'context_breadth',
      detail: `context_breadth '${request.context_breadth}' must be 'narrow' | 'wide'`,
    });
  }

  if (request.intents !== undefined) {
    const seen = new Set<string>();
    for (let i = 0; i < request.intents.length; i++) {
      const intent = request.intents[i]!;
      if (seen.has(intent.intent_id)) {
        issues.push({
          kind: 'intent_id_collision',
          path: `intents[${i}].intent_id`,
          detail: `duplicate intent_id '${intent.intent_id}'`,
        });
      }
      seen.add(intent.intent_id);

      if (intent.confidence !== undefined && (intent.confidence < 0 || intent.confidence > 1)) {
        issues.push({
          kind: 'intent_confidence_out_of_range',
          path: `intents[${i}].confidence`,
          detail: `confidence ${intent.confidence} is not in [0, 1]`,
        });
      }
    }
  }

  if (request.received_at !== undefined && request.received_at < 0) {
    issues.push({
      kind: 'received_at_negative',
      path: 'received_at',
      detail: `received_at ${request.received_at} must be ≥ 0`,
    });
  }

  return issues;
};

/** Throw `RecuedRequestValidationError` when the request has issues.
 *  The orchestrator calls this defensively before deriving its plan. */
export const assertValidRecuedRequest = (request: RecuedRequest): void => {
  const issues = validateRecuedRequest(request);
  if (issues.length > 0) throw new RecuedRequestValidationError(issues);
};
