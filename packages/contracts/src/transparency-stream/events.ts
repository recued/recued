/** D-145 PB7 — Transparency Stream substrate (UNIFIED).
 *
 *  Closed event taxonomy per § B.8.2. The Transparency Stream is the
 *  unified substrate covering BOTH AI-emitted events (extractions /
 *  resolutions / saves) AND engine-brokering events (capacity_check /
 *  memory_lookup / context_omitted / etc.) through one composer +
 *  one render path + one audit emission.
 *
 *  PB6 closed the per-event extraction taxonomy
 *  (`extraction-events.ts`) — those events flow into PB7 via the
 *  composer's mapping layer (`packages/engine/src/transparency-stream/
 *  extraction-mapping.ts`), so the engine's `events[]` surface and the
 *  primitive-call trace converge into one stream.
 *
 *  Adding a new transparency event kind requires a substrate D-spec
 *  change: new union variant + Recued voice template
 *  (`templates.ts`) + redaction rule (`redaction.ts`) + default
 *  visibility entry. The validator at registry load asserts every kind
 *  has matching entries on all three surfaces.
 *
 *  Spec: § B.8.2 + § B.8.2.1 + § B.8.7.1. */

import type {
  CapacityRequirement,
  CapacityRemediation,
} from '../capacity-spec.js';
import type {
  ModelTier,
  OmissionReasonCode,
} from '../recued-plan.js';
import { MODEL_TIERS } from '../recued-plan.js';

// ── PB7.1.1 — Closed transparency event union (§ B.8.2) ──────────────

/** § B.8.2 — closed event union covering all engine event sources.
 *  The composer parses by `kind`, selects a Recued-voiced template per
 *  kind, applies redaction rules per kind, and renders to chat-log
 *  read-along block + audit-log full payload.
 *
 *  Three semantic groups discriminated by kind prefix:
 *
 *    1. AI-emitted user-event mirror — `extraction.*` / `resolution.*`
 *       / `pattern.*` / `drift.*` / `action.*` / `cascade.*`. The
 *       composer's PB6 ExtractionEvent → TransparencyEvent mapping
 *       lifts these from the AI's parallel events array.
 *
 *    2. Engine-brokering — `capacity_check.*` / `memory_lookup` /
 *       `context_omitted` / `ai_call` / `bridge_dispatch` /
 *       `approval_request` / `identity_resolution` /
 *       `engine.gate_short_circuit` / `engine.catalog_assembled`.
 *       Engine emits these directly from primitive-call sites or from
 *       the D-164 prompt-cache main-turn assembly.
 *
 *    3. Failure semantics — `ai_call.malformed` / `ai_call.giving_up_*`
 *       / `standing_instruction_conflict` / `privacy.hard_fail` /
 *       `capacity_gap_mid_run` / `cost_ceiling.*` /
 *       `engine.budget_exceeded`. § B.15 user-must-see truthful-failure
 *       events; bypass Settings hide per applyVisibilityPolicy.
 *
 *  Order matters at registry-time only: the validator asserts the
 *  union's membership matches `TRANSPARENCY_EVENT_KINDS`. */
export type TransparencyEvent =
  // ─ AI-emitted (from PB6 extraction events; § B.7) ──────────────────
  | {
      readonly kind: 'extraction.detected';
      readonly fact_type: string;
      readonly summary: string;
      readonly source_message_id: string;
    }
  | {
      readonly kind: 'extraction.saved';
      readonly entity_kind: string;
      readonly entity_id: string;
      readonly confidence: number;
    }
  | {
      readonly kind: 'extraction.queued_for_confirm';
      readonly queue_entry_id: string;
      readonly confidence: number;
    }
  | {
      readonly kind: 'extraction.skipped_low_confidence';
      readonly fact: string;
      readonly confidence: number;
    }
  | {
      readonly kind: 'resolution.alias';
      readonly alias: string;
      readonly contact_name: string;
      readonly network_domain?: string;
    }
  | {
      readonly kind: 'resolution.contact_created_mention_only';
      readonly name: string;
      readonly mention_only_id: string;
    }
  | {
      readonly kind: 'resolution.network_domain_inferred';
      readonly contact_name: string;
      readonly domain: string;
    }
  | { readonly kind: 'pattern.observation'; readonly observation: string }
  | {
      readonly kind: 'drift.signal';
      readonly topic: string;
      readonly severity: TransparencyDriftSeverity;
    }
  | { readonly kind: 'action.completed'; readonly brief_outcome: string }
  | {
      readonly kind: 'action.failed';
      readonly action: string;
      readonly brief_reason: string;
    }
  | { readonly kind: 'cascade.fired'; readonly recipe_id: string }

  // ─ Engine-brokering (from primitive calls; § B.1) ──────────────────
  | {
      readonly kind: 'capacity_check.ok';
      readonly capacities_passed: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'capacity_check.gap';
      readonly gap: CapacityRequirement;
      readonly remediation: CapacityRemediation;
    }
  | {
      readonly kind: 'memory_lookup';
      readonly query_summary: string;
      readonly result_count: number;
    }
  | {
      readonly kind: 'context_omitted';
      readonly source_ref: string;
      readonly reason_code: OmissionReasonCode;
    }
  | {
      readonly kind: 'ai_call';
      readonly tier: ModelTier;
      readonly round: number;
      readonly tokens_used?: number;
    }
  | {
      readonly kind: 'bridge_dispatch';
      readonly ingredient_slug: string;
      readonly status: TransparencyBridgeStatus;
    }
  | {
      readonly kind: 'approval_request';
      readonly approval_id: string;
      readonly capability: string;
    }
  | {
      readonly kind: 'identity_resolution';
      readonly reference: string;
      readonly resolved_contact: string;
    }
  | {
      /** D-160 O-5 — Standing Instructions surfaced to the user-visible
       *  transparency stream. Payload is the MCP-safe projection only:
       *  no `tag_responses` or `redact_context_sources` free text. */
      readonly kind: 'standing_instruction_applied';
      readonly result: TransparencyStandingInstructionAppliedResult;
    }

  // ─ D-164 prompt-cache main-turn assembly ───────────────────────────
  | {
      /** D-164 P6.7 — prompt-cache gate template fired and short-
       *  circuited the main turn (deterministic render). No AI call
       *  followed; the engine emitted the rendered text directly. */
      readonly kind: 'engine.gate_short_circuit';
      readonly template_hash: string;
    }
  | {
      /** D-164 P6.7 — main-turn catalog assembled. Fires once per turn
       *  immediately before the main AI call (or once when the gate
       *  short-circuits). Counts only — no tool names or argument
       *  values — so the audit row stays render-safe at every
       *  redaction tier. Sparse: only sections present in the
       *  assembled catalog appear as keys. */
      readonly kind: 'engine.catalog_assembled';
      readonly section_counts: Readonly<Record<string, number>>;
    }

  // ─ Failure semantics (§ B.15 — user must see truthful failures) ───
  | {
      /** Cumulative AI-call budget exceeded for this turn. Emitted by
       *  the chat orchestrator when an executor IS wired and the
       *  main-turn call fails; § B.15 user-must-see failure. */
      readonly kind: 'engine.budget_exceeded';
      readonly total_calls: number;
      readonly total_cost_cents: number;
    }
  | {
      /** The chat main-turn DECODER failed — the initial call or a
       *  mid-loop reinvoke errored (PB7 follow-on, landed with the
       *  D-137/D-164 fail-loud family). Dedicated variant so renderers
       *  and audit don't have to misread `engine.budget_exceeded`
       *  (which carries loop-abort call ACCOUNTING — its template
       *  tells a budget story, the wrong copy for a provider failure).
       *  `reason` is the closed failure class; `site` matches the
       *  executor's recovery-site vocabulary (`'initial'` = the first
       *  main-turn call, `'tool_loop'` = a reinvoke after tools ran).
       *  § B.15 user-must-see failure. */
      readonly kind: 'engine.decoder_unavailable';
      readonly reason: TransparencyDecoderUnavailableReason;
      readonly site: TransparencyDecoderUnavailableSite;
    }
  | {
      /** The chat turn SHELL failed after the user message was
       *  accepted — the post-ack body (stream loop / assistant
       *  persist) threw past the early `chat.send` ack (ack-before-
       *  run: the rpc resolves at the user-append commit point, so a
       *  shell-level throw can no longer reject it; this event is the
       *  surviving user-visible signal). Distinct from
       *  `engine.decoder_unavailable` (an executor / provider failure
       *  INSIDE the turn, which still completes with fail-loud
       *  assistant text) — here the turn lifecycle itself died and no
       *  `chat.message_complete` follows (e.g. a mid-turn vault lock
       *  failing the assistant append). Payload is deliberately bare:
       *  error detail can carry user content, so it stays in the
       *  server log; the closed kind is the whole wire story.
       *  § B.15 user-must-see failure. */
      readonly kind: 'engine.turn_failed';
    }
  | {
      readonly kind: 'ai_call.malformed';
      readonly round: number;
    }
  | {
      readonly kind: 'ai_call.giving_up_malformed';
    }
  | {
      readonly kind: 'standing_instruction_conflict';
      readonly instruction_ids: ReadonlyArray<string>;
      /** PB4 tier-bound conflicts surface a `'tier_bound'` discriminator
       *  + the conflicting min/max so the audit reader can render the
       *  resolution path without re-parsing instruction bodies. PB10
       *  Standing Instructions widens with richer conflict kinds. */
      readonly conflict_kind?: TransparencyStandingInstructionConflictKind;
      readonly min_tier?: ModelTier;
      readonly max_tier?: ModelTier;
    }
  | {
      readonly kind: 'privacy.hard_fail';
      readonly violation_class: TransparencyPrivacyViolationClass;
    }
  | {
      readonly kind: 'capacity_gap_mid_run';
      readonly gap: CapacityRequirement;
      readonly affected_intent_id?: string;
    }
  | {
      readonly kind: 'cost_ceiling.demoted';
      readonly from_tier: ModelTier;
      readonly to_tier: ModelTier;
      /** Number of single-step demotions applied (e.g. mid → fast = 1).
       *  PB4 cost-ceiling helper populates this for audit replay. */
      readonly demotion_steps?: number;
    }
  | {
      readonly kind: 'cost_ceiling.halted';
      readonly reason: TransparencyCostHaltReason;
      /** Tier the engine halted on (the lowest tier reached before the
       *  halt). Optional — present when the orchestrator threads it. */
      readonly halted_at_tier?: ModelTier;
    }

  // ─ Engine orchestration: multi-turn loop (§ B.6.1-§ B.6.3) ─────────
  | {
      readonly kind: 'recued.multi_turn.round_started';
      readonly round_index: number;
      readonly expected_max_rounds: number;
      readonly tier: ModelTier;
    }
  | {
      readonly kind: 'recued.multi_turn.round_completed';
      readonly round_index: number;
      readonly outcome: TransparencyMultiTurnRoundOutcome;
      /** Counts only — never user content. § B.6.2 audit-truthfulness:
       *  optional + omitted when unrecoverable (typical body-throw
       *  path) so the audit reader renders "unknown" not "0". */
      readonly tool_calls_executed?: number;
      readonly alternatives_returned?: number;
    }
  | {
      readonly kind: 'recued.multi_turn.loop_terminated';
      readonly total_rounds: number;
      readonly termination_reason: TransparencyMultiTurnTerminationReason;
    }
  | {
      /** D-137 Trio #E follow-on — per-turn token usage aggregate. Fires
       *  ONCE at chat turn end (after `loop_terminated` when the multi-
       *  turn loop ran, or immediately after the one-shot main-turn
       *  call when no tool loop). Sums the initial main turn + every
       *  main-turn re-invocation round. Counts only — never user
       *  content — safe for audit + transparency rendering at any
       *  redaction tier. The benchmark + future billing surface consume
       *  this event to compute per-turn cost (tokens × rates at report
       *  time; rates intentionally live downstream because they drift,
       *  vary per pool, and each consumer wants its own source of
       *  truth). Optional cache + reasoning fields are populated only
       *  when at least one provider call in the turn surfaced them
       *  (preserves "absent vs measured-zero" distinction). */
      readonly kind: 'recued.token_usage';
      readonly input_tokens: number;
      readonly output_tokens: number;
      readonly total_tokens: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_write_input_tokens?: number;
      readonly reasoning_tokens?: number;
    }

  // ─ Engine orchestration: fixed-slot drift (§ B.6.8 + § B.6.9) ──────
  | {
      readonly kind: 'fixed_slot_drift';
      readonly violation_kind: TransparencyFixedSlotViolationKind;
      readonly slot: string;
      readonly alternative_index: number;
    };

// ── PB7.1.2 — Closed enums on event payloads ────────────────────────

export type TransparencyDriftSeverity = 'moderate' | 'significant';
export const TRANSPARENCY_DRIFT_SEVERITIES: ReadonlyArray<TransparencyDriftSeverity> = [
  'moderate',
  'significant',
];

export type TransparencyBridgeStatus = 'pending' | 'ok' | 'gap' | 'failed';
export const TRANSPARENCY_BRIDGE_STATUSES: ReadonlyArray<TransparencyBridgeStatus> = [
  'pending',
  'ok',
  'gap',
  'failed',
];

export type TransparencyPrivacyViolationClass =
  | 'context_leak'
  | 'mcp_alias_leak'
  | 'social_content_persist'
  | 'standing_instruction_leak';
export const TRANSPARENCY_PRIVACY_VIOLATION_CLASSES: ReadonlyArray<TransparencyPrivacyViolationClass> = [
  'context_leak',
  'mcp_alias_leak',
  'social_content_persist',
  'standing_instruction_leak',
];

export type TransparencyCostHaltReason = 'min_tier_floor' | 'no_lower_tier';
export const TRANSPARENCY_COST_HALT_REASONS: ReadonlyArray<TransparencyCostHaltReason> = [
  'min_tier_floor',
  'no_lower_tier',
];

/** Closed failure classes for `engine.decoder_unavailable`. Derived by
 *  the chat turn executor from the failed call: `'no_source'` = the
 *  slot/pool/local matcher found no usable model (the detail matched
 *  its no-source pattern); `'invalid_output'` = the model answered but
 *  the AIOutput failed validation; `'provider_failure'` = everything
 *  else (thrown provider / network / executor error). */
export type TransparencyDecoderUnavailableReason =
  | 'no_source'
  | 'provider_failure'
  | 'invalid_output';
export const TRANSPARENCY_DECODER_UNAVAILABLE_REASONS: ReadonlyArray<TransparencyDecoderUnavailableReason> = [
  'no_source',
  'provider_failure',
  'invalid_output',
];

/** Which main-turn call failed — mirrors the executor's recovery-site
 *  vocabulary (`buildEmptyAiOutputFeedback`). */
export type TransparencyDecoderUnavailableSite = 'initial' | 'tool_loop';
export const TRANSPARENCY_DECODER_UNAVAILABLE_SITES: ReadonlyArray<TransparencyDecoderUnavailableSite> = [
  'initial',
  'tool_loop',
];

/** § B.6.1-§ B.6.3 — closed list of multi-turn round outcomes that
 *  flow into `recued.multi_turn.round_completed`. Mirrors the PB5
 *  `MultiTurnRoundOutcome.kind` values. */
export type TransparencyMultiTurnRoundOutcome =
  | 'continue'
  | 'completed'
  | 'aborted';
export const TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES: ReadonlyArray<TransparencyMultiTurnRoundOutcome> = [
  'continue',
  'completed',
  'aborted',
];

/** § B.6.1-§ B.6.3 — closed list of multi-turn loop termination
 *  reasons. Mirrors the PB5 `MultiTurnTerminationReason` values. */
export type TransparencyMultiTurnTerminationReason =
  | 'completed'
  | 'max_rounds_exhausted'
  | 'aborted';
export const TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS: ReadonlyArray<TransparencyMultiTurnTerminationReason> = [
  'completed',
  'max_rounds_exhausted',
  'aborted',
];

type TransparencyStandingInstructionAppliedActionKind =
  | 'require_approval'
  | 'redact_context'
  | 'min_tier'
  | 'max_tier'
  | 'ban_omission_class'
  | 'force_redirect'
  | 'tag_response';
const TRANSPARENCY_STANDING_INSTRUCTION_APPLIED_ACTION_KINDS: ReadonlyArray<TransparencyStandingInstructionAppliedActionKind> = [
  'require_approval',
  'redact_context',
  'min_tier',
  'max_tier',
  'ban_omission_class',
  'force_redirect',
  'tag_response',
];

type TransparencyStandingInstructionAppliedConflictKind =
  | 'tier_bound'
  | 'redirect_collision';
const TRANSPARENCY_STANDING_INSTRUCTION_APPLIED_CONFLICT_KINDS: ReadonlyArray<TransparencyStandingInstructionAppliedConflictKind> = [
  'tier_bound',
  'redirect_collision',
];

type TransparencyStandingInstructionAppliedResult =
  | {
      readonly kind: 'ok';
      readonly action_kinds: ReadonlyArray<TransparencyStandingInstructionAppliedActionKind>;
      readonly require_approval: boolean;
      readonly force_redirect: boolean;
      readonly redact_context: boolean;
      readonly ban_omission_class: boolean;
      readonly tag_response: boolean;
      readonly redirect_to: string | null;
      readonly min_tier: ModelTier | null;
      readonly max_tier: ModelTier | null;
      readonly final_approval_required?: boolean;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: ReadonlyArray<{
        readonly kind: TransparencyStandingInstructionAppliedConflictKind;
        readonly instruction_ids: ReadonlyArray<string>;
      }>;
    };

/** § B.6.8 + § B.6.9 — closed list of fixed-slot violation kinds that
 *  surface in the Transparency Stream. Mirrors the PB5
 *  `FixedSlotInvariantViolationKind` values. */
export type TransparencyFixedSlotViolationKind =
  | 'fixed_slot_drift'
  | 'fixed_slot_unknown_field';
export const TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS: ReadonlyArray<TransparencyFixedSlotViolationKind> = [
  'fixed_slot_drift',
  'fixed_slot_unknown_field',
];

/** § B.15.8 + § B.11.3a — closed list of standing-instruction conflict
 *  discriminators. PB4 emits `'tier_bound'` for tier-bound conflicts
 *  (min > max); PB10 widens for redirect collisions / redact-vs-include
 *  conflicts. */
export type TransparencyStandingInstructionConflictKind = 'tier_bound';
export const TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS: ReadonlyArray<TransparencyStandingInstructionConflictKind> = [
  'tier_bound',
];

// ── PB7.1.3 — Closed-list kind registry ─────────────────────────────

/** § B.8.2 — closed list of every transparency event kind. The
 *  composer / template registry / redaction registry / settings
 *  registry all key off this list. Adding a kind requires a substrate
 *  D-spec change + new entries in every adjacent registry; the
 *  validator at registry load asserts completeness. */
export const TRANSPARENCY_EVENT_KINDS = [
  // AI-emitted (12)
  'extraction.detected',
  'extraction.saved',
  'extraction.queued_for_confirm',
  'extraction.skipped_low_confidence',
  'resolution.alias',
  'resolution.contact_created_mention_only',
  'resolution.network_domain_inferred',
  'pattern.observation',
  'drift.signal',
  'action.completed',
  'action.failed',
  'cascade.fired',
  // Engine-brokering (11) — D-160 O-5 added `standing_instruction_applied`;
  // D-164 P6.7 added `engine.gate_short_circuit`
  // + `engine.catalog_assembled` for the prompt-cache main-turn flow.
  'capacity_check.ok',
  'capacity_check.gap',
  'memory_lookup',
  'context_omitted',
  'ai_call',
  'bridge_dispatch',
  'approval_request',
  'identity_resolution',
  'standing_instruction_applied',
  'engine.gate_short_circuit',
  'engine.catalog_assembled',
  // Failure semantics (10) — D-164 P6.7 reclassified
  // `engine.budget_exceeded` from the retired `two_stage` group; it is
  // a turn-level failure that must bypass Settings hide. PB7 follow-on
  // added the dedicated `engine.decoder_unavailable` provider-failure
  // variant; the ack-before-run flip added `engine.turn_failed` (the
  // post-ack shell-throw signal — no `chat.message_complete` follows).
  'ai_call.malformed',
  'ai_call.giving_up_malformed',
  'standing_instruction_conflict',
  'privacy.hard_fail',
  'capacity_gap_mid_run',
  'cost_ceiling.demoted',
  'cost_ceiling.halted',
  'engine.budget_exceeded',
  'engine.decoder_unavailable',
  'engine.turn_failed',
  // Engine orchestration (5) — multi-turn + fixed-slot (§ B.6) +
  // D-137 Trio #E follow-on per-turn token usage aggregate
  'recued.multi_turn.round_started',
  'recued.multi_turn.round_completed',
  'recued.multi_turn.loop_terminated',
  'recued.token_usage',
  'fixed_slot_drift',
] as const;
export type TransparencyEventKind = (typeof TRANSPARENCY_EVENT_KINDS)[number];
export const TRANSPARENCY_EVENT_KIND_SET: ReadonlySet<TransparencyEventKind> =
  new Set(TRANSPARENCY_EVENT_KINDS);

/** Membership test — substrate's single boundary check between parsed
 *  AI / engine output and the closed taxonomy. */
export const isTransparencyEventKind = (
  value: unknown,
): value is TransparencyEventKind =>
  typeof value === 'string' &&
  TRANSPARENCY_EVENT_KIND_SET.has(value as TransparencyEventKind);

// ── PB7.1.4 — Closed-list event class for per-class filtering ───────

/** § B.8.2 — four semantic groups for per-stream-kind opt-out (Settings
 *  per § B.8.9). Each kind belongs to exactly one class. The Settings
 *  layer reads this map to honor "hide all extractions" / "show only
 *  failure events" preferences. (D-164 P6.7 retired `'two_stage'`
 *  alongside the Stage 1 / Stage 2 events.) */
export const TRANSPARENCY_EVENT_CLASSES = [
  'ai_emitted',
  'engine_brokering',
  'failure',
  /** Multi-turn loop + fixed-slot drift orchestration events (§ B.6).
   *  Settings: hide-by-default for low-noise UX; users opt in via the
   *  per-class toggle. */
  'orchestration',
] as const;
export type TransparencyEventClass = (typeof TRANSPARENCY_EVENT_CLASSES)[number];
export const TRANSPARENCY_EVENT_CLASS_SET: ReadonlySet<TransparencyEventClass> =
  new Set(TRANSPARENCY_EVENT_CLASSES);

/** Map a kind to its class. Closed-list registry; the validator
 *  asserts every kind in `TRANSPARENCY_EVENT_KINDS` has an entry. */
export const TRANSPARENCY_EVENT_CLASS_FOR_KIND: Readonly<
  Record<TransparencyEventKind, TransparencyEventClass>
> = Object.freeze({
  'extraction.detected': 'ai_emitted',
  'extraction.saved': 'ai_emitted',
  'extraction.queued_for_confirm': 'ai_emitted',
  'extraction.skipped_low_confidence': 'ai_emitted',
  'resolution.alias': 'ai_emitted',
  'resolution.contact_created_mention_only': 'ai_emitted',
  'resolution.network_domain_inferred': 'ai_emitted',
  'pattern.observation': 'ai_emitted',
  'drift.signal': 'ai_emitted',
  'action.completed': 'ai_emitted',
  'action.failed': 'ai_emitted',
  'cascade.fired': 'ai_emitted',
  'capacity_check.ok': 'engine_brokering',
  'capacity_check.gap': 'engine_brokering',
  memory_lookup: 'engine_brokering',
  context_omitted: 'engine_brokering',
  ai_call: 'engine_brokering',
  bridge_dispatch: 'engine_brokering',
  approval_request: 'engine_brokering',
  identity_resolution: 'engine_brokering',
  standing_instruction_applied: 'engine_brokering',
  'engine.gate_short_circuit': 'engine_brokering',
  'engine.catalog_assembled': 'engine_brokering',
  'ai_call.malformed': 'failure',
  'ai_call.giving_up_malformed': 'failure',
  standing_instruction_conflict: 'failure',
  'privacy.hard_fail': 'failure',
  capacity_gap_mid_run: 'failure',
  'cost_ceiling.demoted': 'failure',
  'cost_ceiling.halted': 'failure',
  'engine.budget_exceeded': 'failure',
  'engine.decoder_unavailable': 'failure',
  'engine.turn_failed': 'failure',
  'recued.multi_turn.round_started': 'orchestration',
  'recued.multi_turn.round_completed': 'orchestration',
  'recued.multi_turn.loop_terminated': 'orchestration',
  'recued.token_usage': 'orchestration',
  fixed_slot_drift: 'orchestration',
});

/** Convenience accessor — narrows from kind to class. */
export const classForTransparencyEventKind = (
  kind: TransparencyEventKind,
): TransparencyEventClass => TRANSPARENCY_EVENT_CLASS_FOR_KIND[kind];

// ── PB7.1.5 — Validation issue kinds ─────────────────────────────────

/** Closed-list rejection reasons emitted by `validateTransparencyEvent`.
 *  Composer / orchestrator pin membership; ratchet test asserts the
 *  count. */
export const TRANSPARENCY_EVENT_VALIDATION_KINDS = [
  /** Top-level value is not a non-null object. */
  'event_not_object',
  /** `kind` is missing or not in `TRANSPARENCY_EVENT_KINDS`. */
  'unknown_kind',
  /** Closed-enum payload field carries a value outside its enum. */
  'invalid_enum_value',
  /** A required string field is missing or not a string. */
  'missing_required_string',
  /** A required number field is missing or not a finite number. */
  'missing_required_number',
  /** A required array field is missing or not an array. */
  'missing_required_array',
  /** A required object payload (e.g. `gap`, `remediation`) is missing
   *  or not an object. */
  'missing_required_object',
] as const;
export type TransparencyEventValidationKind =
  (typeof TRANSPARENCY_EVENT_VALIDATION_KINDS)[number];
export const TRANSPARENCY_EVENT_VALIDATION_KIND_SET: ReadonlySet<TransparencyEventValidationKind> =
  new Set(TRANSPARENCY_EVENT_VALIDATION_KINDS);

export interface TransparencyEventValidationIssue {
  readonly kind: TransparencyEventValidationKind;
  /** Field path that failed (e.g. `confidence`, `gap.kind`). Present
   *  on every issue except `event_not_object` / `unknown_kind`. */
  readonly path?: string;
  readonly detail?: string;
}

/** Validate a parsed transparency event's shape against the closed
 *  taxonomy. Accepts `unknown` because callers feed AI-provider /
 *  primitive-call output whose JSON parse may be malformed; the
 *  substrate's shape gate must NEVER throw — every malformed shape
 *  surfaces as a closed-list issue so the composer can halt cleanly.
 *
 *  Returns an empty array when valid; non-empty otherwise. The
 *  composer uses this BEFORE template substitution so a malformed
 *  event halts at the gate, not inside the template engine. */
export const validateTransparencyEvent = (
  event: unknown,
): ReadonlyArray<TransparencyEventValidationIssue> => {
  const issues: TransparencyEventValidationIssue[] = [];
  if (event === null || typeof event !== 'object') {
    issues.push({ kind: 'event_not_object', detail: String(event) });
    return issues;
  }
  const e = event as { readonly kind?: unknown };
  if (!isTransparencyEventKind(e.kind)) {
    issues.push({ kind: 'unknown_kind', detail: String(e.kind) });
    return issues;
  }
  // Per-kind field-shape gate. Each branch matches the union variant's
  // required + optional fields. Any field shape failure surfaces as a
  // closed-list issue without throwing.
  const ev = event as Record<string, unknown>;
  switch (e.kind as TransparencyEventKind) {
    case 'extraction.detected':
      requireString(ev, 'fact_type', issues);
      requireString(ev, 'summary', issues);
      requireString(ev, 'source_message_id', issues);
      break;
    case 'extraction.saved':
      requireString(ev, 'entity_kind', issues);
      requireString(ev, 'entity_id', issues);
      requireFiniteNumber(ev, 'confidence', issues);
      break;
    case 'extraction.queued_for_confirm':
      requireString(ev, 'queue_entry_id', issues);
      requireFiniteNumber(ev, 'confidence', issues);
      break;
    case 'extraction.skipped_low_confidence':
      requireString(ev, 'fact', issues);
      requireFiniteNumber(ev, 'confidence', issues);
      break;
    case 'resolution.alias':
      requireString(ev, 'alias', issues);
      requireString(ev, 'contact_name', issues);
      // network_domain optional; type-check only when present.
      if (ev.network_domain !== undefined && typeof ev.network_domain !== 'string') {
        issues.push({
          kind: 'missing_required_string',
          path: 'network_domain',
          detail: typeof ev.network_domain,
        });
      }
      break;
    case 'resolution.contact_created_mention_only':
      requireString(ev, 'name', issues);
      requireString(ev, 'mention_only_id', issues);
      break;
    case 'resolution.network_domain_inferred':
      requireString(ev, 'contact_name', issues);
      requireString(ev, 'domain', issues);
      break;
    case 'pattern.observation':
      requireString(ev, 'observation', issues);
      break;
    case 'drift.signal':
      requireString(ev, 'topic', issues);
      requireEnum(ev, 'severity', TRANSPARENCY_DRIFT_SEVERITIES, issues);
      break;
    case 'action.completed':
      requireString(ev, 'brief_outcome', issues);
      break;
    case 'action.failed':
      requireString(ev, 'action', issues);
      requireString(ev, 'brief_reason', issues);
      break;
    case 'cascade.fired':
      requireString(ev, 'recipe_id', issues);
      break;
    case 'capacity_check.ok':
      requireArray(ev, 'capacities_passed', issues);
      break;
    case 'capacity_check.gap':
      requireObject(ev, 'gap', issues);
      requireObject(ev, 'remediation', issues);
      break;
    case 'memory_lookup':
      requireString(ev, 'query_summary', issues);
      requireFiniteNumber(ev, 'result_count', issues);
      break;
    case 'context_omitted':
      requireString(ev, 'source_ref', issues);
      requireString(ev, 'reason_code', issues);
      break;
    case 'ai_call':
      requireEnum(ev, 'tier', MODEL_TIERS, issues);
      requireFiniteNumber(ev, 'round', issues);
      // tokens_used optional; type-check only when present.
      if (ev.tokens_used !== undefined && !Number.isFinite(ev.tokens_used)) {
        issues.push({
          kind: 'missing_required_number',
          path: 'tokens_used',
          detail: String(ev.tokens_used),
        });
      }
      break;
    case 'bridge_dispatch':
      requireString(ev, 'ingredient_slug', issues);
      requireEnum(ev, 'status', TRANSPARENCY_BRIDGE_STATUSES, issues);
      break;
    case 'approval_request':
      requireString(ev, 'approval_id', issues);
      requireString(ev, 'capability', issues);
      break;
    case 'identity_resolution':
      requireString(ev, 'reference', issues);
      requireString(ev, 'resolved_contact', issues);
      break;
    case 'standing_instruction_applied':
      requireObject(ev, 'result', issues);
      if (
        ev.result !== null &&
        typeof ev.result === 'object' &&
        !Array.isArray(ev.result)
      ) {
        validateStandingInstructionAppliedResult(
          ev.result as Record<string, unknown>,
          issues,
        );
      }
      break;
    case 'engine.gate_short_circuit':
      requireString(ev, 'template_hash', issues);
      break;
    case 'engine.catalog_assembled':
      requireObject(ev, 'section_counts', issues);
      // Per-section value gate — only when the object check passed.
      if (
        ev.section_counts !== null &&
        typeof ev.section_counts === 'object' &&
        !Array.isArray(ev.section_counts)
      ) {
        const counts = ev.section_counts as Record<string, unknown>;
        for (const sectionName of Object.keys(counts)) {
          const count = counts[sectionName];
          if (!Number.isFinite(count) || (count as number) < 0) {
            issues.push({
              kind: 'missing_required_number',
              path: `section_counts.${sectionName}`,
              detail: String(count),
            });
          }
        }
      }
      break;
    case 'engine.budget_exceeded':
      requireFiniteNumber(ev, 'total_calls', issues);
      requireFiniteNumber(ev, 'total_cost_cents', issues);
      break;
    case 'engine.decoder_unavailable':
      requireEnum(ev, 'reason', TRANSPARENCY_DECODER_UNAVAILABLE_REASONS, issues);
      requireEnum(ev, 'site', TRANSPARENCY_DECODER_UNAVAILABLE_SITES, issues);
      break;
    case 'engine.turn_failed':
      // Deliberately bare — the closed kind is the whole wire story
      // (error detail stays in the server log; it can carry user
      // content).
      break;
    case 'ai_call.malformed':
      requireFiniteNumber(ev, 'round', issues);
      break;
    case 'ai_call.giving_up_malformed':
      break;
    case 'standing_instruction_conflict':
      requireArray(ev, 'instruction_ids', issues);
      // conflict_kind / min_tier / max_tier optional; type-check only
      // when present.
      if (
        ev.conflict_kind !== undefined &&
        (typeof ev.conflict_kind !== 'string' ||
          !TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS.includes(
            ev.conflict_kind as TransparencyStandingInstructionConflictKind,
          ))
      ) {
        issues.push({
          kind: 'invalid_enum_value',
          path: 'conflict_kind',
          detail: String(ev.conflict_kind),
        });
      }
      if (
        ev.min_tier !== undefined &&
        (typeof ev.min_tier !== 'string' ||
          !MODEL_TIERS.includes(ev.min_tier as ModelTier))
      ) {
        issues.push({
          kind: 'invalid_enum_value',
          path: 'min_tier',
          detail: String(ev.min_tier),
        });
      }
      if (
        ev.max_tier !== undefined &&
        (typeof ev.max_tier !== 'string' ||
          !MODEL_TIERS.includes(ev.max_tier as ModelTier))
      ) {
        issues.push({
          kind: 'invalid_enum_value',
          path: 'max_tier',
          detail: String(ev.max_tier),
        });
      }
      break;
    case 'privacy.hard_fail':
      requireEnum(
        ev,
        'violation_class',
        TRANSPARENCY_PRIVACY_VIOLATION_CLASSES,
        issues,
      );
      break;
    case 'capacity_gap_mid_run':
      requireObject(ev, 'gap', issues);
      // affected_intent_id optional.
      if (
        ev.affected_intent_id !== undefined &&
        typeof ev.affected_intent_id !== 'string'
      ) {
        issues.push({
          kind: 'missing_required_string',
          path: 'affected_intent_id',
          detail: typeof ev.affected_intent_id,
        });
      }
      break;
    case 'cost_ceiling.demoted':
      requireEnum(ev, 'from_tier', MODEL_TIERS, issues);
      requireEnum(ev, 'to_tier', MODEL_TIERS, issues);
      // demotion_steps optional; finite-number check only when present.
      if (
        ev.demotion_steps !== undefined &&
        !Number.isFinite(ev.demotion_steps)
      ) {
        issues.push({
          kind: 'missing_required_number',
          path: 'demotion_steps',
          detail: String(ev.demotion_steps),
        });
      }
      break;
    case 'cost_ceiling.halted':
      requireEnum(ev, 'reason', TRANSPARENCY_COST_HALT_REASONS, issues);
      // halted_at_tier optional; tier-enum check only when present.
      if (
        ev.halted_at_tier !== undefined &&
        (typeof ev.halted_at_tier !== 'string' ||
          !MODEL_TIERS.includes(ev.halted_at_tier as ModelTier))
      ) {
        issues.push({
          kind: 'invalid_enum_value',
          path: 'halted_at_tier',
          detail: String(ev.halted_at_tier),
        });
      }
      break;
    case 'recued.multi_turn.round_started':
      requireFiniteNumber(ev, 'round_index', issues);
      requireFiniteNumber(ev, 'expected_max_rounds', issues);
      requireEnum(ev, 'tier', MODEL_TIERS, issues);
      break;
    case 'recued.multi_turn.round_completed':
      requireFiniteNumber(ev, 'round_index', issues);
      requireEnum(ev, 'outcome', TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES, issues);
      // tool_calls_executed / alternatives_returned optional;
      // finite-number check only when present.
      if (
        ev.tool_calls_executed !== undefined &&
        !Number.isFinite(ev.tool_calls_executed)
      ) {
        issues.push({
          kind: 'missing_required_number',
          path: 'tool_calls_executed',
          detail: String(ev.tool_calls_executed),
        });
      }
      if (
        ev.alternatives_returned !== undefined &&
        !Number.isFinite(ev.alternatives_returned)
      ) {
        issues.push({
          kind: 'missing_required_number',
          path: 'alternatives_returned',
          detail: String(ev.alternatives_returned),
        });
      }
      break;
    case 'recued.multi_turn.loop_terminated':
      requireFiniteNumber(ev, 'total_rounds', issues);
      requireEnum(
        ev,
        'termination_reason',
        TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS,
        issues,
      );
      break;
    case 'recued.token_usage':
      requireFiniteNumber(ev, 'input_tokens', issues);
      requireFiniteNumber(ev, 'output_tokens', issues);
      requireFiniteNumber(ev, 'total_tokens', issues);
      // Optional cache / reasoning fields — finite-number check only
      // when present so absent stays distinguishable from measured-zero.
      for (const field of ['cache_read_input_tokens', 'cache_write_input_tokens', 'reasoning_tokens'] as const) {
        const v = (ev as Record<string, unknown>)[field];
        if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
          issues.push({
            kind: 'missing_required_number',
            path: field,
            detail: String(v),
          });
        }
      }
      break;
    case 'fixed_slot_drift':
      requireEnum(
        ev,
        'violation_kind',
        TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS,
        issues,
      );
      requireString(ev, 'slot', issues);
      requireFiniteNumber(ev, 'alternative_index', issues);
      break;
  }
  return issues;
};

// ── PB7.1.6 — Internal field-shape helpers ──────────────────────────

const requireString = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (typeof ev[path] !== 'string') {
    issues.push({
      kind: 'missing_required_string',
      path,
      detail: typeof ev[path],
    });
  }
};

const requireFiniteNumber = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (!Number.isFinite(ev[path])) {
    issues.push({
      kind: 'missing_required_number',
      path,
      detail: String(ev[path]),
    });
  }
};

const requireArray = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (!Array.isArray(ev[path])) {
    issues.push({
      kind: 'missing_required_array',
      path,
      detail: typeof ev[path],
    });
  }
};

const requireObject = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  const v = ev[path];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    issues.push({
      kind: 'missing_required_object',
      path,
      detail: v === null ? 'null' : typeof v,
    });
  }
};

const requireEnum = <T extends string>(
  ev: Record<string, unknown>,
  path: string,
  enumList: ReadonlyArray<T>,
  issues: TransparencyEventValidationIssue[],
): void => {
  const v = ev[path];
  if (typeof v !== 'string' || !enumList.includes(v as T)) {
    issues.push({
      kind: 'invalid_enum_value',
      path,
      detail: String(v),
    });
  }
};

const requireBoolean = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (typeof ev[path] !== 'boolean') {
    issues.push({
      kind: 'invalid_enum_value',
      path,
      detail: String(ev[path]),
    });
  }
};

const requireNullableString = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (ev[path] !== null && typeof ev[path] !== 'string') {
    issues.push({
      kind: 'missing_required_string',
      path,
      detail: typeof ev[path],
    });
  }
};

const requireNullableModelTier = (
  ev: Record<string, unknown>,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  const v = ev[path];
  if (v !== null && (typeof v !== 'string' || !MODEL_TIERS.includes(v as ModelTier))) {
    issues.push({
      kind: 'invalid_enum_value',
      path,
      detail: String(v),
    });
  }
};

const validateStringArrayValues = (
  values: unknown,
  path: string,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (!Array.isArray(values)) return;
  values.forEach((value, index) => {
    if (typeof value !== 'string') {
      issues.push({
        kind: 'missing_required_string',
        path: `${path}[${index}]`,
        detail: typeof value,
      });
    }
  });
};

const validateStandingInstructionAppliedResult = (
  result: Record<string, unknown>,
  issues: TransparencyEventValidationIssue[],
): void => {
  if (result.kind !== 'ok' && result.kind !== 'conflict') {
    issues.push({
      kind: 'invalid_enum_value',
      path: 'result.kind',
      detail: String(result.kind),
    });
    return;
  }
  if (result.kind === 'ok') {
    requireArray(result, 'action_kinds', issues);
    if (Array.isArray(result.action_kinds)) {
      result.action_kinds.forEach((actionKind, index) => {
        if (
          typeof actionKind !== 'string' ||
          !TRANSPARENCY_STANDING_INSTRUCTION_APPLIED_ACTION_KINDS.includes(
            actionKind as TransparencyStandingInstructionAppliedActionKind,
          )
        ) {
          issues.push({
            kind: 'invalid_enum_value',
            path: `result.action_kinds[${index}]`,
            detail: String(actionKind),
          });
        }
      });
    }
    for (const field of [
      'require_approval',
      'force_redirect',
      'redact_context',
      'ban_omission_class',
      'tag_response',
    ] as const) {
      requireBoolean(result, field, issues);
    }
    requireNullableString(result, 'redirect_to', issues);
    requireNullableModelTier(result, 'min_tier', issues);
    requireNullableModelTier(result, 'max_tier', issues);
    if (
      result.final_approval_required !== undefined &&
      typeof result.final_approval_required !== 'boolean'
    ) {
      issues.push({
        kind: 'invalid_enum_value',
        path: 'result.final_approval_required',
        detail: String(result.final_approval_required),
      });
    }
    return;
  }

  requireArray(result, 'conflicts', issues);
  if (!Array.isArray(result.conflicts)) return;
  result.conflicts.forEach((conflict, index) => {
    const path = `result.conflicts[${index}]`;
    if (conflict === null || typeof conflict !== 'object' || Array.isArray(conflict)) {
      issues.push({
        kind: 'missing_required_object',
        path,
        detail: conflict === null ? 'null' : typeof conflict,
      });
      return;
    }
    const row = conflict as Record<string, unknown>;
    if (
      typeof row.kind !== 'string' ||
      !TRANSPARENCY_STANDING_INSTRUCTION_APPLIED_CONFLICT_KINDS.includes(
        row.kind as TransparencyStandingInstructionAppliedConflictKind,
      )
    ) {
      issues.push({
        kind: 'invalid_enum_value',
        path: `${path}.kind`,
        detail: String(row.kind),
      });
    }
    requireArray(row, 'instruction_ids', issues);
    validateStringArrayValues(row.instruction_ids, `${path}.instruction_ids`, issues);
  });
};

// ── PB7.1.7 — Substrate self-check ──────────────────────────────────

/** Defensive runtime check — every closed-list constant is non-empty
 *  + frozen + members are unique + class registry is exhaustive. The
 *  orchestrator can call this at boot; the ratchet test asserts on the
 *  same invariants. */
export const assertTransparencyEventInvariants = (): void => {
  const checkClosedList = <T extends string>(
    name: string,
    list: ReadonlyArray<T>,
    set: ReadonlySet<T>,
  ): void => {
    if (list.length === 0) {
      throw new Error(`${name} must be non-empty`);
    }
    if (set.size !== list.length) {
      throw new Error(`${name} contains duplicates`);
    }
  };
  checkClosedList(
    'TRANSPARENCY_EVENT_KINDS',
    TRANSPARENCY_EVENT_KINDS,
    TRANSPARENCY_EVENT_KIND_SET,
  );
  checkClosedList(
    'TRANSPARENCY_EVENT_CLASSES',
    TRANSPARENCY_EVENT_CLASSES,
    TRANSPARENCY_EVENT_CLASS_SET,
  );
  checkClosedList(
    'TRANSPARENCY_EVENT_VALIDATION_KINDS',
    TRANSPARENCY_EVENT_VALIDATION_KINDS,
    TRANSPARENCY_EVENT_VALIDATION_KIND_SET,
  );
  // Class registry must cover every kind exactly once.
  for (const kind of TRANSPARENCY_EVENT_KINDS) {
    const cls = TRANSPARENCY_EVENT_CLASS_FOR_KIND[kind];
    if (!TRANSPARENCY_EVENT_CLASS_SET.has(cls)) {
      throw new Error(
        `TRANSPARENCY_EVENT_CLASS_FOR_KIND['${kind}'] = '${cls}' is not in TRANSPARENCY_EVENT_CLASSES`,
      );
    }
  }
  const registryKinds = Object.keys(TRANSPARENCY_EVENT_CLASS_FOR_KIND);
  if (registryKinds.length !== TRANSPARENCY_EVENT_KINDS.length) {
    throw new Error(
      `TRANSPARENCY_EVENT_CLASS_FOR_KIND has ${registryKinds.length} entries; expected ${TRANSPARENCY_EVENT_KINDS.length}`,
    );
  }
};
