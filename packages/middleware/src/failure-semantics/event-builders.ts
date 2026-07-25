/** D-145 PB15 — Transparency Stream event builders for the four
 *  failure events that PB4/PB10 didn't already cover.
 *
 *  Per § B.15.1 + § B.15.4 + § B.15.9 + § B.8.2:
 *    - `ai_call.malformed`            (§ B.15.1 round 1 malformed return)
 *    - `ai_call.giving_up_malformed`  (§ B.15.1 round 2 → degrade)
 *    - `privacy.hard_fail`            (§ B.15.9 runtime guard)
 *    - `capacity_gap_mid_run`         (§ B.15.4 capacity lost mid-run)
 *
 *  Wrap-as-envelope keeps `{event, redaction, emitted_at}` consistent
 *  with PB7's wire shape. Default redaction tier comes from the
 *  closed-list registry (`defaultRedactionForKind`). Callers should
 *  pipe the result through `PlanDraft.recordTransparencyEvent`.
 *
 *  Spec: § B.15.1 + § B.15.4 + § B.15.9 + § B.8.2 + PB7 wire shape. */

import {
  defaultRedactionForKind,
  type CapacityRequirement,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
  type TransparencyPrivacyViolationClass,
} from '@recued/contracts';

const wrapAsEnvelope = (event: TransparencyEvent): TransparencyEventEnvelope => ({
  event,
  redaction: defaultRedactionForKind(event.kind),
  emitted_at: Date.now(),
});

/** § B.15.1 round 1 — first malformed AI return. Engine retries once
 *  with an additional system-prompt note before giving up.
 *
 *  `round` is the multi-turn round index (0-based). */
export const buildAiCallMalformedEvent = (args: {
  round: number;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'ai_call.malformed',
    round: args.round,
  });

/** § B.15.1 round 2 → degrade — engine emits this BEFORE routing to
 *  the graceful-degradation path (any salvageable response text used,
 *  events[] dropped, plan failure_class='synthesis'). */
export const buildAiCallGivingUpMalformedEvent = (): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'ai_call.giving_up_malformed',
  });

/** § B.15.9 — privacy hard-fail runtime guard halt. `violation_class`
 *  pins what was about to leak:
 *    - `'context_leak'`              — generic restraint < 3 trip
 *    - `'mcp_alias_leak'`            — contact_alias entering MCP packet
 *    - `'social_content_persist'`    — social_raw_body persisting
 *    - `'standing_instruction_leak'` — SI content reaching AI packet */
export const buildPrivacyHardFailEvent = (args: {
  violation_class: TransparencyPrivacyViolationClass;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'privacy.hard_fail',
    violation_class: args.violation_class,
  });

/** § B.15.4 — capacity lost mid-run. `gap` is the typed
 *  CapacityRequirement that became unavailable (bridge_online /
 *  ingredient_installed / logged_in / etc.). `affected_intent_id`
 *  threads the per-intent capacity walk per § B.1.2 rule 1 when the
 *  gap is intent-scoped; omitted for cross-intent capacity loss. */
export const buildCapacityGapMidRunEvent = (args: {
  gap: CapacityRequirement;
  affected_intent_id?: string;
}): TransparencyEventEnvelope =>
  wrapAsEnvelope({
    kind: 'capacity_gap_mid_run',
    gap: args.gap,
    ...(args.affected_intent_id !== undefined
      ? { affected_intent_id: args.affected_intent_id }
      : {}),
  });
