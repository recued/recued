/** D-145 PB2 — RecuedPlan IR (contracts).
 *
 *  Per § B.5. Every Recued run produces a durable typed plan capturing
 *  the full broker decision trail: considered sources, capacity walks,
 *  included context, omitted context (reason codes only — never
 *  content), model tier, primitive calls, user-visible internal steps,
 *  user response, user events, provenance links, audit policy.
 *
 *  Storage: D-120 memory entry kind `recued_plan` with structured
 *  payload. Engine already emits to memory; this is a richer entry
 *  kind, not a new table. The actual store wrapper lives in
 *  `@recued/storage` (`createRecuedPlanStore`); this module is the
 *  type registry + builders + validator + canonical-bytes path.
 *
 *  PB2 ships pure types + closed-list enums + builder helpers + the
 *  runtime validator + the canonical-JSON helper used by the audit
 *  signing primitive. No runtime side effects, no IO, no signing
 *  primitives in this file (those live in `@recued/storage` /
 *  `backend/server/src/recued-plan/signing.ts`).
 *
 *  Two invariants are load-bearing on this substrate:
 *
 *    1. **`OmittedItem.content_stored: false`** — TypeScript literal
 *       type. `OmittedItem({ content_stored: true })` fails compile.
 *       The runtime validator (`validateRecuedPlan`) backs this up
 *       for parsed-JSON / `as unknown as` cast paths. The lint
 *       ratchet at `__tests__/d-145-phase-pb2-lint.ratchet.test.ts`
 *       greps the codebase for `Object.assign(…, { content_stored:
 *       true })` style runtime workarounds.
 *
 *    2. **`ContextItem.content_class × persist_policy`** — runtime
 *       validator on every plan write. `'social_raw_body'` MUST
 *       carry `persist_policy: 'immediate_use_only'`; `'standing_-
 *       instruction'` + `'contact_alias'` MUST NOT carry
 *       `persist_policy: 'persist'` for AI-packet exposure (audit
 *       persistence is allowed). See § B.2.3.
 *
 *  Spec: `docs/d-145-spec.md` § B.5 + § B.2.3 + § B.5.5.
 *  Hard prereq: D-148 § A.2.5 (server_identity_key for high-assurance
 *  signature emission). */

import type { CapacityCheck } from './capacity-spec.js';
import type { ExtractionEvent } from './extraction-events.js';
import { validateExtractionEvent } from './extraction-events.js';
import type { TransparencyEventEnvelope } from './transparency-stream/redaction.js';
import { TRANSPARENCY_REDACTION_TIER_SET } from './transparency-stream/redaction.js';
import { validateTransparencyEvent } from './transparency-stream/events.js';

// ── N.1 — RecuedPrimitive (closed list, 10 values) ──────────────────

/** The ten typed primitives the engine composes per § B.1. PB3 wires
 *  the orchestrator + per-primitive modules; PB2 just declares the
 *  closed list so plan IR row shapes can reference it without forward
 *  declaration. */
export const RECUED_PRIMITIVES = [
  'capacity_spec',
  'data.fetch',
  'memory.recall',
  'memory.write',
  'enrichment.lookup',
  'ai.synthesize',
  'bridge.dispatch',
  'recipe.invoke',
  'approval.request',
  'provenance.link',
] as const;
export type RecuedPrimitive = (typeof RECUED_PRIMITIVES)[number];
export const RECUED_PRIMITIVE_SET: ReadonlySet<RecuedPrimitive> = new Set(RECUED_PRIMITIVES);

// ── N.2 — PrimitiveCall + PrimitiveCallStatus ───────────────────────

/** Per-call status. Closed list per § B.15. `'ok_partial'` covers
 *  partial-failure semantics (e.g. 8 of 10 sources fetched); the
 *  closed list is mirrored in `engine-failure-status-explicit.ratchet`
 *  in PB15. `'preview_no_op'` is the Dry Run discriminator (§ B.5.4
 *  rule 1). */
export const PRIMITIVE_CALL_STATUSES = [
  'ok',
  'ok_partial',
  'capacity_gap',
  'capacity_gap_mid_run',
  'error',
  'cancelled',
  'timeout',
  'preview_no_op',
] as const;
export type PrimitiveCallStatus = (typeof PRIMITIVE_CALL_STATUSES)[number];
export const PRIMITIVE_CALL_STATUS_SET: ReadonlySet<PrimitiveCallStatus> = new Set(
  PRIMITIVE_CALL_STATUSES,
);

export interface PrimitiveCall {
  primitive: RecuedPrimitive;
  call_id: string;
  /** Audit-friendly summary of inputs — never raw args (privacy). */
  args_summary: string;
  status: PrimitiveCallStatus;
  duration_ms: number;
  /** Audit-friendly summary of outputs — never raw outcome (privacy). */
  outcome_summary: string;
  started_at: number;
  /** When called per-intent (capacity walks per § B.1.2 rule 1) — links
   *  back to the per-intent capacity walk. */
  intent_id?: string;
}

// ── N.3 — OmittedItem + OmissionReasonCode ──────────────────────────

/** § B.5.2 — TypeScript literal `false`. The substrate-enforced
 *  compile-time invariant on `OmittedItem.content_stored`. Direct
 *  attempts to set `content_stored: true` fail tsc compilation. The
 *  runtime validator + lint ratchet back this up for parsed-JSON /
 *  `as unknown as` cast paths. */
export type ContentStoredFalse = false;

export const OMISSION_REASON_CODES = [
  'privacy_class',
  'token_budget',
  'permission_scope',
  'recency_filter',
  'hallucination_risk',
  'cost_tier',
  'capacity_gap',
  'duplication',
] as const;
export type OmissionReasonCode = (typeof OMISSION_REASON_CODES)[number];
export const OMISSION_REASON_CODE_SET: ReadonlySet<OmissionReasonCode> = new Set(
  OMISSION_REASON_CODES,
);

export interface OmittedItem {
  /** What was considered (path; never content). */
  source_ref: string;
  reason_code: OmissionReasonCode;
  /** Short summary, no payload. */
  reason_detail?: string;
  /** Hard invariant — TS literal type. The runtime validator + lint
   *  ratchet back this up for parsed-JSON / cast paths. */
  content_stored: ContentStoredFalse;
}

// ── N.4 — ContextItem + ContextContentClass + persist_policy ────────

/** § B.2.3 — closed enum, substrate-managed. Expansion requires
 *  substrate D-spec work. Each class carries an implicit
 *  `persist_policy` envelope per § B.2.3:
 *
 *    - `social_raw_body` MUST be `'immediate_use_only'`
 *    - `standing_instruction` + `contact_alias` MUST NOT be
 *      `'persist'` when included for AI-packet exposure
 *    - Everything else defaults to `'persist'`. */
export const CONTEXT_CONTENT_CLASSES = [
  'work_entity',
  'mail_subject_meta',
  'mail_body_excerpt',
  'calendar_event',
  'contact_profile_meta',
  'contact_alias',
  'engagement_evidence',
  'standing_instruction',
  'memory_recall_summary',
  'enrichment_value',
  'social_raw_body',
  'social_derived_summary',
  'response_synthesis',
  'system_provenance',
] as const;
export type ContextContentClass = (typeof CONTEXT_CONTENT_CLASSES)[number];
export const CONTEXT_CONTENT_CLASS_SET: ReadonlySet<ContextContentClass> = new Set(
  CONTEXT_CONTENT_CLASSES,
);

/** § B.2.3 — closed list per `ContextItem.persist_policy`:
 *
 *    - `'persist'`: full payload persists in plan + AI packet OK
 *    - `'immediate_use_only'`: payload available to current request
 *      only; not written to plan; cleared post-response. The hard
 *      privacy gate for `social_raw_body` and any future bridge-
 *      fetched ephemera that must NEVER reach `data_memory.payload`.
 *    - `'redacted_only'`: only `redacted_payload` persists; full
 *      content stripped. */
export const CONTEXT_PERSIST_POLICIES = [
  'persist',
  'immediate_use_only',
  'redacted_only',
] as const;
export type ContextPersistPolicy = (typeof CONTEXT_PERSIST_POLICIES)[number];
export const CONTEXT_PERSIST_POLICY_SET: ReadonlySet<ContextPersistPolicy> = new Set(
  CONTEXT_PERSIST_POLICIES,
);

/** § B.2.3 — for the runtime validator + AI-packet composer. Each
 *  content class declares which persist policies are admissible.
 *  `'social_raw_body'` is the hardest gate: only
 *  `'immediate_use_only'` ever, no exceptions. `'standing_instruction'`
 *  + `'contact_alias'` admit `'redacted_only'` for audit retention but
 *  reject `'persist'` so AI packets route through the redaction path.
 *  Closed-list registry. */
export const CONTEXT_CLASS_PERSIST_POLICIES: Readonly<
  Record<ContextContentClass, ReadonlyArray<ContextPersistPolicy>>
> = {
  work_entity: ['persist'],
  mail_subject_meta: ['persist'],
  mail_body_excerpt: ['persist', 'redacted_only'],
  calendar_event: ['persist'],
  contact_profile_meta: ['persist'],
  contact_alias: ['redacted_only'],
  engagement_evidence: ['persist', 'redacted_only'],
  standing_instruction: ['redacted_only'],
  memory_recall_summary: ['persist'],
  enrichment_value: ['persist'],
  social_raw_body: ['immediate_use_only'],
  social_derived_summary: ['persist'],
  response_synthesis: ['persist'],
  system_provenance: ['persist'],
};

export interface ContextItem {
  /** Path; never content. Resolver-shaped (`data.contact.<id>...`). */
  source_ref: string;
  content_class: ContextContentClass;
  persist_policy: ContextPersistPolicy;
  /** Substrate-generated audit-clean summary. Required when
   *  persist_policy = 'redacted_only' or 'immediate_use_only';
   *  optional otherwise. */
  redacted_payload?: string;
  /** Pointer to D-120 row when persist_policy = 'persist'. Opaque
   *  string; resolver decodes per-collection. */
  payload_ref?: string;
  /** For token-budget audit (no payload, just count). */
  size_bytes_observed?: number;
}

// ── N.5 — PlanStatus + FailureClass ─────────────────────────────────

export const PLAN_STATUSES = [
  'completed',
  'cancelled_by_user',
  'cancelled_capacity_gap',
  'cancelled_si_conflict',
  'cancelled_no_alternative',
  'cancelled_privacy_violation',
  'cancelled_cost_ceiling',
  'cancelled_malformed_ai',
  'preview_no_op',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_STATUS_SET: ReadonlySet<PlanStatus> = new Set(PLAN_STATUSES);

export const FAILURE_CLASSES = [
  'retrieval',
  'omission',
  'synthesis',
  'legibility',
  'capacity',
  'privacy',
  'cost',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export const FAILURE_CLASS_SET: ReadonlySet<FailureClass> = new Set(FAILURE_CLASSES);

// ── N.6 — ContextSelectionTrace + NarrowingReasonCode ───────────────

/** Closed list — the recipe-narrowing drop taxonomy (base codes from
 *  the retired two-stage recipe filter, § B.17.3) + § A.6.1 (D-137 P1.3
 *  widening for the `filter-tools` engine intermediate). Adding a code =
 *  substrate change. The widening introduces three Tier-aware reasons:
 *
 *    - `tier3_disabled` — Tier 3 (`connection.mcp.*`) entry filtered out
 *      because Mary disabled the tool in Settings → Connections (or its
 *      classification is `'unknown'` and Mary hasn't classified it yet)
 *    - `intent_kind_gate` — entry filtered out because the request's
 *      intent kinds don't admit this tier (e.g., a Tier 2 recipe when
 *      the intent set carries neither `recipe_action` nor `query`)
 *    - `kind_gated` — Tier 2 recipe filtered out by Mary's per-kind
 *      catalog scope toggle (D-126 8-kind closed list × recipe's
 *      `requires_kinds` derivation per § A.1.1)
 *
 *  Existing codes are unchanged from the retired recipe filter's drop
 *  taxonomy. */
export const NARROWING_REASON_CODES = [
  'topic_mismatch',
  'intent_kind_incompatible',
  'low_confidence',
  'cap_exceeded',
  'standing_instruction',
  'privacy_class',
  'tier3_disabled',
  'intent_kind_gate',
  'kind_gated',
] as const;
export type NarrowingReasonCode = (typeof NARROWING_REASON_CODES)[number];
export const NARROWING_REASON_CODE_SET: ReadonlySet<NarrowingReasonCode> = new Set(
  NARROWING_REASON_CODES,
);

/** Closed list — the intent kinds from the retired two-stage Stage 1
 *  classifier (§ B.17.2.1). The classifier itself is deleted (D-164 P6);
 *  the union survives because `ClassificationIntent` (recued-request.ts)
 *  still references it via `ClassificationIntentKind` and the public
 *  contract barrel exports it. */
export const CLASSIFICATION_INTENT_KINDS = [
  'commitment_extract',
  'task_extract',
  'recipe_action',
  'query',
  'chat_only',
] as const;
export type ClassificationIntentKind = (typeof CLASSIFICATION_INTENT_KINDS)[number];
export const CLASSIFICATION_INTENT_KIND_SET: ReadonlySet<ClassificationIntentKind> = new Set(
  CLASSIFICATION_INTENT_KINDS,
);

export type ContextBreadth = 'narrow' | 'wide';
export const CONTEXT_BREADTHS: ReadonlyArray<ContextBreadth> = ['narrow', 'wide'];

/** Per-tier capability-filter selection trace per D-137 § A.6.1. The
 *  `tools` block widens `ContextSelectionTrace` with per-tier counts +
 *  IDs + drop reason buckets for the chat agent's union catalog
 *  narrowing. Recipe-only / non-chat callers leave `tools`
 *  undefined; the chat orchestrator populates it from its main-turn
 *  catalog projection.
 *
 *  Privacy invariant per § B.5.1: counts + IDs + reason codes
 *  only — NEVER tool argument values or result content. The tools
 *  block mirrors the same discipline as the recipe block. */
export interface ContextSelectionToolsTrace {
  tier1_selected_count: number;
  tier1_selected_ids: string[];
  tier2_selected_count: number;
  tier2_selected_ids: string[];
  tier2_dropped_count: number;
  tier2_dropped_reasons: Partial<Record<NarrowingReasonCode, number>>;
  tier3_selected_count: number;
  tier3_selected_ids: string[];
  tier3_dropped_count: number;
  tier3_dropped_reasons: Partial<Record<NarrowingReasonCode, number>>;
}

export interface ContextSelectionTrace {
  // Recipe catalog narrowing (carries over from the PB17 era; the
  // D-164 prompt-cache catalog substrate populates `recipe_candidates_-
  // selected` from the `recipes` section of the assembled catalog and
  // leaves `recipe_candidates_dropped` empty until per-recipe gating
  // resurfaces).
  recipe_candidates_considered: number;
  recipe_candidates_selected: string[];
  recipe_candidates_dropped: Array<{
    recipe_slug: string;
    reason_code: NarrowingReasonCode;
  }>;

  // Commitment context pull
  commitment_context_pulled: boolean;
  /** Count only; row IDs go to included_context with content_stored
   *  discipline. */
  commitment_rows_count: number;

  // D-164 P6.7 — catalog-assembly snapshot (Open Q1 option (b)).
  // Replaces the four `stage1_*` fields the PB17 classifier echoed.
  // Same audit-shape category — counts + a fired-or-not boolean — so
  // audit readers stay round-trippable across the substrate swap.
  /** Per-section entry counts from `assembleCatalog`. Sparse: only
   *  sections present in the assembled catalog appear as keys (e.g.
   *  `{ 'entity-query': 4, 'recipes': 12 }`). Mirrors the `engine.-
   *  catalog_assembled` transparency payload field-for-field. */
  catalog_section_counts: Readonly<Record<string, number>>;
  /** True when the prompt-cache gate template fired and the main turn
   *  was bypassed (deterministic render). Mirrors the `engine.gate_-
   *  short_circuit` transparency emission. */
  catalog_short_circuited: boolean;

  /** D-137 § A.6.1 — per-tier capability-filter selection trace.
   *  Recipe-only / non-chat callers leave this undefined; the chat
   *  orchestrator populates it from its main-turn catalog projection. */
  tools?: ContextSelectionToolsTrace;
}

// ── N.7 — Forward-compat types (PB6 + PB7 + PB3 widen) ──────────────

/** PB7 widened the open envelope to the closed taxonomy per
 *  `transparency-stream/redaction.ts`. The plan IR's
 *  `user_visible_internal_steps: TransparencyEventEnvelope[]` row
 *  shape is sourced from that module; this file imports it for in-
 *  file uses (`user_visible_internal_steps` + `appendTransparencyEvent`
 *  signature). The contracts barrel re-exports both the wire envelope
 *  type and the closed `TransparencyEvent` union via the canonical
 *  `transparency-stream/index.ts` barrel. */

/** PB6 widens the open-envelope shape to the closed taxonomy per
 *  § B.7.1 — sourced from `extraction-events.ts` so the plan IR's
 *  `user_events: ExtractionEvent[]` field carries exactly the events
 *  PB6's composer emits. The contracts barrel re-exports the type from
 *  the canonical module; this file imports it for the in-file uses
 *  (`user_events`, `appendExtractionEvent` signature). */

/** § B.5.1 — provenance link emitted by `provenance.link` primitive
 *  per § B.1 row 10. Mirrors the existing D-120 `EmittedLink` shape
 *  (`packages/contracts/src/links.ts`) but scoped to the plan-IR
 *  surface. PB3's provenance.link primitive populates it; PB2 just
 *  declares the field. */
export interface ProvenanceLink {
  /** memory_id (the plan's plan_id) — links the touched entity back
   *  to this plan in the D-120 link graph. */
  memory_id: string;
  entity_id: string;
  /** Per-collection link kind. PB3 widens to the existing `LinkKind`
   *  union; PB2 keeps it open so the plan IR can carry future
   *  engine-emitted relationship kinds. */
  kind: string;
  ts: number;
  /** D-120 P7.5 bistemporal stamp. */
  event_at?: number;
}

// ── N.8 — AuditPolicy ────────────────────────────────────────────────

export interface AuditPolicy {
  /** Typically 90 (D-120 default). Configurable per-request. Caller-
   *  side discipline; the plan IR records the intent at write time. */
  retain_for_days: number;
  /** Signs the plan with `server_identity_key` per D-148 § A.2.5.
   *  When true, `RecuedPlan.signature` MUST be populated by the
   *  signing wrapper (`signRecuedPlan`); the runtime validator
   *  rejects `high_assurance: true && !signature`. */
  high_assurance: boolean;
  /** Sensitive requests redact their own `user_request` field — the
   *  IR carries `'<redacted>'` instead of the raw text. The runtime
   *  validator enforces the redaction shape. */
  redact_user_request: boolean;
}

// ── N.9 — ModelTier ──────────────────────────────────────────────────

export const MODEL_TIERS = ['fast', 'mid', 'reasoning'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const MODEL_TIER_SET: ReadonlySet<ModelTier> = new Set(MODEL_TIERS);

// ── N.10 — RecuedPlan IR (top-level shape) ───────────────────────────

export interface RecuedPlan {
  plan_id: string;
  /** Groups multi-step goals — multiple plans may share a goal_id. */
  goal_id: string;
  /** User chat input. When `audit_policy.redact_user_request === true`,
   *  this carries `REDACTED_USER_REQUEST_MARKER` (`'<redacted>'`). */
  user_request: string;

  // Pre-flight
  considered_sources: string[];
  capacity_checks: CapacityCheck[];

  // Context shaping
  included_context: ContextItem[];
  /** Reason codes only; NOT content (compile-time enforced). */
  omitted_context: OmittedItem[];
  /** Per § B.5.1 — engine narrowing record. */
  selection_trace: ContextSelectionTrace;

  // Execution
  model_tier: ModelTier;
  ai_provider: string;
  /** Resolved via packages/llm. */
  ai_model_id: string;
  /** Ordered trace with timestamps + outcomes. */
  primitive_calls: PrimitiveCall[];

  // Status + failure attribution (closed-list per § B.15.11)
  status: PlanStatus;
  /** Required when status != 'completed'. The runtime validator
   *  enforces the pairing. */
  failure_class?: FailureClass;

  // User-facing
  user_visible_internal_steps: TransparencyEventEnvelope[];
  /** Truthful + actionable per § B.15.11; never silently empty. */
  user_response: string;
  user_events: ExtractionEvent[];

  // Audit
  provenance_links: ProvenanceLink[];
  audit_policy: AuditPolicy;

  // Metadata
  /** Unix-ms. Maps to `event_at` in storage per § B.5.3. */
  started_at: number;
  /** Unix-ms. */
  completed_at: number;
  total_tokens?: number;
  total_cost_cents?: number;

  /** Server-signed when `audit_policy.high_assurance: true`. Base64
   *  Ed25519 signature over the canonical-JSON of this plan minus
   *  `signature` + `signer_fingerprint` per the existing pair-blob
   *  canonicalizer. The signing primitive lives in
   *  `backend/server/src/recued-plan/signing.ts`. */
  signature?: string;
  /** D-148 § A.2.5 — public-key fingerprint (`sha256:<hex>`) of the
   *  `server_identity_key` that produced `signature`. The verifier
   *  uses this to look up the right public key from a key-history
   *  store, so plans signed by a pre-rotation key still verify after
   *  `server_identity_rotate`. Populated alongside `signature`. */
  signer_fingerprint?: string;
}

// ── N.11 — Constants ─────────────────────────────────────────────────

/** D-120 memory entry kind for RecuedPlan rows per § B.5.3. The
 *  storage wrapper (`@recued/storage` `createRecuedPlanStore`) keys
 *  on this constant so callers don't drift on the literal. */
export const RECUED_PLAN_MEMORY_KIND = 'recued_plan' as const;

/** § B.5.5 — when `audit_policy.redact_user_request: true`, the IR
 *  carries this marker instead of the raw text. The substrate-side
 *  redaction primitive (`redactUserRequest`) replaces the field
 *  before persistence; the runtime validator asserts the shape. */
export const REDACTED_USER_REQUEST_MARKER = '<redacted>' as const;

// ── N.12 — Validator (runtime) ───────────────────────────────────────

/** PB2 validator issue kinds. Closed list — drift requires a spec
 *  change. The validator collects every issue (does NOT bail on the
 *  first) so callers see every problem at once; see `validateRecuedPlan`. */
export const RECUED_PLAN_VALIDATION_ISSUE_KINDS = [
  'unknown_status',
  'unknown_failure_class',
  'failure_class_required_when_not_completed',
  'failure_class_forbidden_when_completed',
  'unknown_model_tier',
  'unknown_primitive',
  'unknown_primitive_call_status',
  'unknown_omission_reason_code',
  'omitted_item_content_stored_not_false',
  'unknown_content_class',
  'unknown_persist_policy',
  'persist_policy_class_mismatch',
  'redacted_payload_missing',
  'unknown_narrowing_reason_code',
  /** D-164 P6.7 — `catalog_section_counts` carries non-finite or
   *  negative values. The closed-list `unknown_intent_kind` /
   *  `unknown_context_breadth` issue kinds retired alongside the
   *  PB17 Stage 1 classifier; counts replace closed enums in the
   *  catalog-assembly snapshot. */
  'invalid_catalog_section_count',
  'high_assurance_signature_missing',
  'redact_user_request_marker_missing',
  'completed_at_before_started_at',
  // Codex P2 fold (2026-05-10) — wraps every issue
  // `validateExtractionEvent` raises (`unknown_kind` /
  // `confidence_not_finite` / `confidence_out_of_range`) so parsed-
  // JSON / mutated / off-list user_events never reach persistence.
  'invalid_user_event',
  // PB7 (2026-05-10) — round-trip integrity for
  // `user_visible_internal_steps`. Wraps every issue
  // `validateTransparencyEvent` raises so off-list event kinds /
  // shape mismatches surface at persistence time.
  'invalid_internal_step',
] as const;
export type RecuedPlanValidationIssueKind =
  (typeof RECUED_PLAN_VALIDATION_ISSUE_KINDS)[number];

export interface RecuedPlanValidationIssue {
  kind: RecuedPlanValidationIssueKind;
  /** Optional field path for context (e.g. `'omitted_context[3]'`). */
  path?: string;
  /** Human-readable. Never echoes user-content fields verbatim. */
  detail: string;
}

export class RecuedPlanValidationError extends Error {
  readonly code = 'RECUED_PLAN_MALFORMED' as const;
  readonly issues: ReadonlyArray<RecuedPlanValidationIssue>;
  constructor(issues: ReadonlyArray<RecuedPlanValidationIssue>) {
    super(`RecuedPlan malformed: ${issues.length} issue(s)`);
    this.name = 'RecuedPlanValidationError';
    this.issues = issues;
  }
}

const validateOmittedItem = (
  item: OmittedItem,
  path: string,
  issues: RecuedPlanValidationIssue[],
): void => {
  if (!OMISSION_REASON_CODE_SET.has(item.reason_code)) {
    issues.push({
      kind: 'unknown_omission_reason_code',
      path,
      detail: `omitted_item.reason_code '${(item as { reason_code?: string }).reason_code ?? '<undefined>'}' is not in OMISSION_REASON_CODES`,
    });
  }
  // Runtime backstop for the compile-time `ContentStoredFalse` literal.
  // Catches `as unknown as OmittedItem` / parsed-JSON / Object.assign
  // workarounds at write time.
  if ((item as { content_stored: unknown }).content_stored !== false) {
    issues.push({
      kind: 'omitted_item_content_stored_not_false',
      path,
      detail: `omitted_item.content_stored MUST be the literal false (got ${JSON.stringify(
        (item as { content_stored: unknown }).content_stored,
      )})`,
    });
  }
};

const validateContextItem = (
  item: ContextItem,
  path: string,
  issues: RecuedPlanValidationIssue[],
): void => {
  if (!CONTEXT_CONTENT_CLASS_SET.has(item.content_class)) {
    issues.push({
      kind: 'unknown_content_class',
      path,
      detail: `context_item.content_class '${(item as { content_class?: string }).content_class ?? '<undefined>'}' is not in CONTEXT_CONTENT_CLASSES`,
    });
    return;
  }
  if (!CONTEXT_PERSIST_POLICY_SET.has(item.persist_policy)) {
    issues.push({
      kind: 'unknown_persist_policy',
      path,
      detail: `context_item.persist_policy '${(item as { persist_policy?: string }).persist_policy ?? '<undefined>'}' is not in CONTEXT_PERSIST_POLICIES`,
    });
    return;
  }
  const allowed = CONTEXT_CLASS_PERSIST_POLICIES[item.content_class];
  if (!allowed.includes(item.persist_policy)) {
    issues.push({
      kind: 'persist_policy_class_mismatch',
      path,
      detail: `content_class '${item.content_class}' does not admit persist_policy '${item.persist_policy}' (allowed: ${allowed.join(', ')})`,
    });
  }
  // Substrate-required redacted_payload for non-persist policies.
  if (
    (item.persist_policy === 'redacted_only' || item.persist_policy === 'immediate_use_only')
    && (item.redacted_payload === undefined || item.redacted_payload === '')
  ) {
    issues.push({
      kind: 'redacted_payload_missing',
      path,
      detail: `context_item.persist_policy '${item.persist_policy}' requires a non-empty redacted_payload`,
    });
  }
};

const validatePrimitiveCall = (
  call: PrimitiveCall,
  path: string,
  issues: RecuedPlanValidationIssue[],
): void => {
  if (!RECUED_PRIMITIVE_SET.has(call.primitive)) {
    issues.push({
      kind: 'unknown_primitive',
      path,
      detail: `primitive_call.primitive '${(call as { primitive?: string }).primitive ?? '<undefined>'}' is not in RECUED_PRIMITIVES`,
    });
  }
  if (!PRIMITIVE_CALL_STATUS_SET.has(call.status)) {
    issues.push({
      kind: 'unknown_primitive_call_status',
      path,
      detail: `primitive_call.status '${(call as { status?: string }).status ?? '<undefined>'}' is not in PRIMITIVE_CALL_STATUSES`,
    });
  }
};

const validateSelectionTrace = (
  trace: ContextSelectionTrace,
  issues: RecuedPlanValidationIssue[],
): void => {
  for (const drop of trace.recipe_candidates_dropped) {
    if (!NARROWING_REASON_CODE_SET.has(drop.reason_code)) {
      issues.push({
        kind: 'unknown_narrowing_reason_code',
        path: `selection_trace.recipe_candidates_dropped[${drop.recipe_slug}]`,
        detail: `narrowing reason '${drop.reason_code}' is not in NARROWING_REASON_CODES`,
      });
    }
  }
  // D-164 P6.7 — catalog-assembly snapshot. Counts must be finite +
  // non-negative; sparse keys (`undefined` entries) are valid by
  // construction since `Object.keys` skips them.
  for (const section of Object.keys(trace.catalog_section_counts)) {
    const count = trace.catalog_section_counts[section];
    if (!Number.isFinite(count) || (count as number) < 0) {
      issues.push({
        kind: 'invalid_catalog_section_count',
        path: `selection_trace.catalog_section_counts.${section}`,
        detail: `catalog_section_counts['${section}'] must be a non-negative finite number (got ${String(count)})`,
      });
    }
  }
  // Codex P2.2 fold (D-137 P1.3 review). The `tools` per-tier block is
  // optional at the contract level (recipe-only / non-chat callers
  // leave it undefined), but when populated by the D-137 chat
  // orchestrator, the per-tier reason
  // buckets MUST contain only `NarrowingReasonCode` keys. Mirror the
  // recipe_candidates_dropped validation pattern so the runtime
  // contract refuses arbitrary keys.
  if (trace.tools) {
    for (const reasonKey of Object.keys(trace.tools.tier2_dropped_reasons)) {
      if (!NARROWING_REASON_CODE_SET.has(reasonKey as NarrowingReasonCode)) {
        issues.push({
          kind: 'unknown_narrowing_reason_code',
          path: `selection_trace.tools.tier2_dropped_reasons[${reasonKey}]`,
          detail: `narrowing reason '${reasonKey}' is not in NARROWING_REASON_CODES`,
        });
      }
    }
    for (const reasonKey of Object.keys(trace.tools.tier3_dropped_reasons)) {
      if (!NARROWING_REASON_CODE_SET.has(reasonKey as NarrowingReasonCode)) {
        issues.push({
          kind: 'unknown_narrowing_reason_code',
          path: `selection_trace.tools.tier3_dropped_reasons[${reasonKey}]`,
          detail: `narrowing reason '${reasonKey}' is not in NARROWING_REASON_CODES`,
        });
      }
    }
  }
};

/** Validate a `RecuedPlan`. Collects every issue (does NOT bail on the
 *  first) so callers see every problem at once. The store wrapper
 *  (`@recued/storage` `createRecuedPlanStore`) calls
 *  `assertValidRecuedPlan` defensively before persistence; downstream
 *  consumers never see partially-validated plans.
 *
 *  Substrate-level guard backing the compile-time
 *  `ContentStoredFalse` literal — catches `as unknown as` /
 *  parsed-JSON / `Object.assign` workarounds at write time. */
export const validateRecuedPlan = (
  plan: RecuedPlan,
): RecuedPlanValidationIssue[] => {
  const issues: RecuedPlanValidationIssue[] = [];

  if (!PLAN_STATUS_SET.has(plan.status)) {
    issues.push({
      kind: 'unknown_status',
      path: 'status',
      detail: `plan.status '${(plan as { status?: string }).status ?? '<undefined>'}' is not in PLAN_STATUSES`,
    });
  }

  if (!MODEL_TIER_SET.has(plan.model_tier)) {
    issues.push({
      kind: 'unknown_model_tier',
      path: 'model_tier',
      detail: `plan.model_tier '${(plan as { model_tier?: string }).model_tier ?? '<undefined>'}' is not in MODEL_TIERS`,
    });
  }

  if (plan.failure_class !== undefined && !FAILURE_CLASS_SET.has(plan.failure_class)) {
    issues.push({
      kind: 'unknown_failure_class',
      path: 'failure_class',
      detail: `plan.failure_class '${plan.failure_class}' is not in FAILURE_CLASSES`,
    });
  }

  // Status / failure_class pairing per § B.15.11: required when
  // status != 'completed' / 'preview_no_op'; forbidden otherwise.
  const isTerminalSuccess =
    plan.status === 'completed' || plan.status === 'preview_no_op';
  if (!isTerminalSuccess && plan.failure_class === undefined) {
    issues.push({
      kind: 'failure_class_required_when_not_completed',
      path: 'failure_class',
      detail: `plan.status '${plan.status}' requires failure_class to be set`,
    });
  }
  if (isTerminalSuccess && plan.failure_class !== undefined) {
    issues.push({
      kind: 'failure_class_forbidden_when_completed',
      path: 'failure_class',
      detail: `plan.status '${plan.status}' must not carry failure_class (got '${plan.failure_class}')`,
    });
  }

  for (let i = 0; i < plan.omitted_context.length; i++) {
    validateOmittedItem(plan.omitted_context[i]!, `omitted_context[${i}]`, issues);
  }

  for (let i = 0; i < plan.included_context.length; i++) {
    validateContextItem(plan.included_context[i]!, `included_context[${i}]`, issues);
  }

  for (let i = 0; i < plan.primitive_calls.length; i++) {
    validatePrimitiveCall(plan.primitive_calls[i]!, `primitive_calls[${i}]`, issues);
  }

  // Codex P2 fold (2026-05-10) — re-runs the closed-list extraction-
  // event validator over every user_events row. Without this, a plan
  // with parsed-JSON / mutated rows carrying the old PB2
  // `{ kind, payload }` envelope or an off-list event kind passes the
  // persistence guard despite the narrowed contract.
  for (let i = 0; i < plan.user_events.length; i++) {
    const eventIssues = validateExtractionEvent(plan.user_events[i]);
    for (const sub of eventIssues) {
      issues.push({
        kind: 'invalid_user_event',
        path: `user_events[${i}]`,
        detail: `user_events[${i}] sub-issue '${sub.kind}' (detail: ${sub.detail ?? '<undefined>'})`,
      });
    }
  }

  // PB7 — round-trip integrity for `user_visible_internal_steps`. Same
  // pattern as `user_events`: re-run the closed-taxonomy validator
  // over every envelope's `event` so parsed-JSON / mutated rows
  // carrying off-list `kind` values surface at persistence time.
  //
  // Codex P2 fold (2026-05-10) — also validates the WRAPPING envelope
  // shape (`redaction` ∈ closed tier list, `emitted_at` finite number,
  // `provenance_ref` string when present). Without this, a parsed
  // plan carrying `{ event: validEvent, redaction: 'bogus',
  // emitted_at: 'not_a_number' }` slipped through the persistence
  // guard despite breaking PB7's wire shape.
  for (let i = 0; i < plan.user_visible_internal_steps.length; i++) {
    const envelope = plan.user_visible_internal_steps[i];
    const path = `user_visible_internal_steps[${i}]`;
    if (envelope === null || typeof envelope !== 'object') {
      issues.push({
        kind: 'invalid_internal_step',
        path,
        detail: `envelope is not an object (got ${envelope === null ? 'null' : typeof envelope})`,
      });
      continue;
    }
    const env = envelope as {
      event?: unknown;
      redaction?: unknown;
      emitted_at?: unknown;
      provenance_ref?: unknown;
    };
    if (!TRANSPARENCY_REDACTION_TIER_SET.has(env.redaction as never)) {
      issues.push({
        kind: 'invalid_internal_step',
        path: `${path}.redaction`,
        detail: `redaction is not in TRANSPARENCY_REDACTION_TIERS (got '${String(env.redaction)}')`,
      });
    }
    if (!Number.isFinite(env.emitted_at)) {
      issues.push({
        kind: 'invalid_internal_step',
        path: `${path}.emitted_at`,
        detail: `emitted_at is not a finite number (got '${String(env.emitted_at)}')`,
      });
    }
    if (
      env.provenance_ref !== undefined &&
      typeof env.provenance_ref !== 'string'
    ) {
      issues.push({
        kind: 'invalid_internal_step',
        path: `${path}.provenance_ref`,
        detail: `provenance_ref is set but not a string (got '${typeof env.provenance_ref}')`,
      });
    }
    const eventIssues = validateTransparencyEvent(env.event);
    for (const sub of eventIssues) {
      issues.push({
        kind: 'invalid_internal_step',
        path: `${path}.event`,
        detail: `${path}.event sub-issue '${sub.kind}'${sub.path ? ` at '${sub.path}'` : ''} (detail: ${sub.detail ?? '<undefined>'})`,
      });
    }
  }

  validateSelectionTrace(plan.selection_trace, issues);

  // High-assurance signature required when audit_policy says so. PB2
  // doesn't sign; the storage / server layer does. The validator just
  // pins the shape so downstream stores reject pre-signing writes.
  if (plan.audit_policy.high_assurance && !plan.signature) {
    issues.push({
      kind: 'high_assurance_signature_missing',
      path: 'signature',
      detail: `audit_policy.high_assurance is true but signature is missing`,
    });
  }

  // Redact-user-request shape per § B.5.5.
  if (
    plan.audit_policy.redact_user_request
    && plan.user_request !== REDACTED_USER_REQUEST_MARKER
  ) {
    issues.push({
      kind: 'redact_user_request_marker_missing',
      path: 'user_request',
      detail: `audit_policy.redact_user_request is true but user_request is not the redaction marker '${REDACTED_USER_REQUEST_MARKER}'`,
    });
  }

  if (plan.completed_at < plan.started_at) {
    issues.push({
      kind: 'completed_at_before_started_at',
      path: 'completed_at',
      detail: `completed_at (${plan.completed_at}) precedes started_at (${plan.started_at})`,
    });
  }

  return issues;
};

/** Throw `RecuedPlanValidationError` when the plan has issues. The
 *  storage wrapper calls this defensively before persistence. */
export const assertValidRecuedPlan = (plan: RecuedPlan): void => {
  const issues = validateRecuedPlan(plan);
  if (issues.length > 0) throw new RecuedPlanValidationError(issues);
};

// ── N.13 — Builder helpers ───────────────────────────────────────────

/** Append a primitive call to a plan's `primitive_calls[]`. Pure
 *  function — returns a new plan (never mutates input). PB3 wires the
 *  per-primitive append paths through this helper so the engine's
 *  ordered trace stays consistent. */
export const appendPrimitiveCall = (
  plan: RecuedPlan,
  call: PrimitiveCall,
): RecuedPlan => ({
  ...plan,
  primitive_calls: [...plan.primitive_calls, call],
});

/** Append an omitted-context entry. The `content_stored: false`
 *  parameter is positional + literal-typed so callers can't elide it.
 *  Pure function — returns a new plan. */
export const appendOmittedItem = (
  plan: RecuedPlan,
  item: OmittedItem,
): RecuedPlan => ({
  ...plan,
  omitted_context: [...plan.omitted_context, item],
});

/** Append an included-context entry. Pure function. */
export const appendIncludedContext = (
  plan: RecuedPlan,
  item: ContextItem,
): RecuedPlan => ({
  ...plan,
  included_context: [...plan.included_context, item],
});

/** Append a transparency event envelope to user-visible internal
 *  steps. PB7 widens the event taxonomy; PB2's helper appends
 *  whatever shape the substrate accepts. */
export const appendTransparencyEvent = (
  plan: RecuedPlan,
  event: TransparencyEventEnvelope,
): RecuedPlan => ({
  ...plan,
  user_visible_internal_steps: [...plan.user_visible_internal_steps, event],
});

/** Append a user-facing extraction event. PB6 widens the taxonomy. */
export const appendExtractionEvent = (
  plan: RecuedPlan,
  event: ExtractionEvent,
): RecuedPlan => ({
  ...plan,
  user_events: [...plan.user_events, event],
});

/** Append a provenance link. PB3's `provenance.link` primitive
 *  populates this; PB2 ships the helper so the orchestrator's wiring
 *  stays consistent across primitives. */
export const appendProvenanceLink = (
  plan: RecuedPlan,
  link: ProvenanceLink,
): RecuedPlan => ({
  ...plan,
  provenance_links: [...plan.provenance_links, link],
});

/** Append a capacity check. PB3's capacity_spec walker invokes this
 *  for every check it runs (cache hits + misses + gaps). */
export const appendCapacityCheck = (
  plan: RecuedPlan,
  check: CapacityCheck,
): RecuedPlan => ({
  ...plan,
  capacity_checks: [...plan.capacity_checks, check],
});

// ── N.14 — Privacy primitives ────────────────────────────────────────

/** § B.5.5 — replace `user_request` with the redaction marker.
 *  Substrate-level expression of the no-content-storage invariant.
 *  Pure function — caller decides when to invoke. The server-side
 *  signing wrapper invokes it before signing when
 *  `audit_policy.redact_user_request: true`. */
export const redactUserRequest = (plan: RecuedPlan): RecuedPlan => ({
  ...plan,
  user_request: REDACTED_USER_REQUEST_MARKER,
  audit_policy: { ...plan.audit_policy, redact_user_request: true },
});

// ── N.15 — Canonical bytes (signing path) ────────────────────────────

/** Strip both `signature` AND `signer_fingerprint` from a plan to
 *  produce the byte sequence the signature commits to. Mirrors
 *  `stripSignatureFields` in the audit-signing path so one
 *  canonicalizer covers both surfaces.
 *
 *  Pure function — never mutates input. The signing wrapper
 *  (`signRecuedPlan` in `backend/server/src/recued-plan/signing.ts`)
 *  feeds the result through `canonicalJSONStringify` to produce the
 *  bytes Ed25519 signs over. */
export const stripPlanSignatureFields = (plan: RecuedPlan): RecuedPlan => {
  if (plan.signature === undefined && plan.signer_fingerprint === undefined) {
    return plan;
  }
  const { signature: _signature, signer_fingerprint: _fingerprint, ...rest } = plan;
  return rest as RecuedPlan;
};
