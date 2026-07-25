/** D-145 PB15 — fixed-slot-alternatives-empty failure mapping.
 *
 *  Per § B.15.7. When AI returns `alternatives: []` AND the primary
 *  `result: null` (no acceptable solution found), engine:
 *
 *    1. Records the empty alternatives + `conflict` explanation in
 *       primitive_calls.
 *    2. Composes user_response: "I couldn't find a way to do this
 *       without changing what you asked for — here's why: <conflict>."
 *    3. Offers user explicit options: (a) relax a fixed_slot, (b)
 *       cancel the request, (c) escalate to higher AI tier.
 *    4. Plan IR records empty alternatives as `failure_class:
 *       'no_acceptable_alternative'` (mapped to closed-list
 *       'synthesis' per `failure-class-map.ts`).
 *
 *  Pure helper — takes the conflict explanation (caller's responsibility
 *  to extract from the AI's raw response, sanitized to audit-clean
 *  text) and returns the composed failure result.
 *
 *  Spec: § B.15.7 + § B.6.7. */

import {
  composeFailureResult,
  type ComposedFailureResult,
} from './compose-failure-result.js';

export interface NoAlternativeInput {
  /** Caller-supplied conflict explanation. The orchestration policy
   *  extracts this from the AI's raw response (sanitized — closed-
   *  list reason codes preferred; free-form text only when audit-
   *  clean). Maximum length 240 chars; substrate truncates with
   *  ellipsis above that to keep `user_response` bounded. */
  readonly conflict_explanation: string;
  /** Closed-list discriminator the caller suggests for the user
   *  next-action: relax (fixed_slot loosenable), cancel, or escalate
   *  (next tier available). Surfaced for downstream UI to render
   *  matching CTAs. Optional. */
  readonly next_action_options?: ReadonlyArray<'relax' | 'cancel' | 'escalate'>;
}

export const MAX_CONFLICT_EXPLANATION_LEN = 240;

/** Build the `cancelled_no_alternative` failure result. */
export const composeNoAlternativeFailure = (
  input: NoAlternativeInput,
): ComposedFailureResult => {
  const trimmed = input.conflict_explanation.length > MAX_CONFLICT_EXPLANATION_LEN
    ? `${input.conflict_explanation.slice(0, MAX_CONFLICT_EXPLANATION_LEN - 1)}…`
    : input.conflict_explanation;

  const optionsClause =
    input.next_action_options !== undefined && input.next_action_options.length > 0
      ? ` Options: ${input.next_action_options.join(', ')}.`
      : '';

  const override =
    `I couldn't find a way to do this without changing what you asked for — here's why: ${trimmed}.${optionsClause}`;

  return composeFailureResult({
    status: 'cancelled_no_alternative',
    override_user_response: override,
  });
};
