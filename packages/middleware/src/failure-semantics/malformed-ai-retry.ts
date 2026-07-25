/** D-145 PB15 — malformed AI retry-once-then-degrade wrapper.
 *
 *  Per § B.15.1. When `ai.synthesize` returns a response that doesn't
 *  match the AIOutput shape (missing `response`, malformed `events[]`,
 *  invalid event_kind, fixed_slot drift, etc.), the engine routes
 *  through structured recovery:
 *
 *    1. **First malformed return** → emit `ai_call.malformed`
 *       Transparency Stream event; retry the same `ai.synthesize` call
 *       once with an additional system-prompt note "Your previous
 *       response did not match the expected shape; please respond
 *       with valid AIOutput JSON."
 *    2. **Second malformed return** → emit
 *       `ai_call.giving_up_malformed`; route to graceful-degradation
 *       path:
 *         - Use any salvageable `response` text as user_response
 *         - Drop `events[]` entirely (don't auto-save corrupt
 *           extractions)
 *         - Set plan `failure_class: 'synthesis'` for benchmark
 *           accounting
 *
 *  Pure-ish: takes an injected `validate` predicate (caller decides
 *  what "malformed" means — adapter shape / event taxonomy / fixed_slot
 *  enforcement / etc.) and an `emit` callback for the transparency
 *  envelopes. The wrapper itself never persists; orchestration policy
 *  threads the result into the plan.
 *
 *  Spec: § B.15.1 + § B.7 + § B.8.2. */

import type { TransparencyEventEnvelope } from '@recued/contracts';

import {
  buildAiCallGivingUpMalformedEvent,
  buildAiCallMalformedEvent,
} from './event-builders.js';

/** Predicate the caller supplies. Return `{ kind: 'ok', value }` to
 *  accept the AI response, or `{ kind: 'malformed', reason }` to
 *  trigger retry / degrade. `reason` is closed-list / discriminator
 *  string the caller controls — never user content. */
export type ValidateAiResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'malformed'; readonly reason: string };

/** Salvage extractor — when round 2 also fails, the caller may extract
 *  whatever text is recoverable from the raw return (e.g. parse only
 *  the `.response` field). Return undefined when nothing salvageable.
 *  The wrapper never echoes raw content; it merely passes the
 *  caller's salvage value through. */
export type SalvageExtractor<TRaw> = (raw: TRaw) => string | undefined;

export interface MalformedAiRetryInput<TRaw, TParsed> {
  /** Round 0 (first attempt). Caller invokes the adapter however it
   *  likes; the wrapper just observes the result through `validate`. */
  readonly attempt: (prompt_note?: string) => Promise<TRaw>;
  /** Validate the raw return; produce `TParsed` when shaped correctly,
   *  else a malformed-reason discriminator. */
  readonly validate: (raw: TRaw) => ValidateAiResult<TParsed>;
  /** Pluck whatever salvageable text exists from a malformed round 2
   *  return. Optional — when omitted the degraded `user_response`
   *  resolves to undefined (caller composes a default). */
  readonly salvage?: SalvageExtractor<TRaw>;
  /** Round index for `ai_call.malformed.round`. Defaults to 0 when the
   *  caller is at the start of a multi-turn loop. */
  readonly round?: number;
  /** Engine callback that records the transparency envelope on the
   *  plan draft. The wrapper invokes it once on first malformed (with
   *  the `ai_call.malformed` envelope) and once on second malformed
   *  (with the `ai_call.giving_up_malformed` envelope). */
  readonly emit: (envelope: TransparencyEventEnvelope) => void;
  /** § B.15.1 retry prompt note (verbatim). Substrate constant so
   *  every caller produces the same retry copy. Override only via the
   *  helper's named arg; ad-hoc strings would defeat the
   *  reproducibility of malformed-retry replay traces. */
  readonly retry_prompt_note?: string;
}

/** § B.15.1 — verbatim retry prompt note. Closed-character substrate
 *  string; matches the spec wording. */
export const MALFORMED_AI_RETRY_PROMPT_NOTE =
  'Your previous response did not match the expected shape; please respond with valid AIOutput JSON.';

export interface MalformedAiRetryOk<TParsed> {
  readonly kind: 'ok';
  readonly value: TParsed;
  /** True when the first attempt was malformed + the retry recovered.
   *  Audit replay distinguishes retry-recovered from first-time-ok. */
  readonly recovered_after_retry: boolean;
}

export interface MalformedAiRetryDegraded {
  readonly kind: 'degraded';
  /** Whatever the salvage extractor produced from the round 2 return,
   *  or undefined when no extractor / no salvageable text. The caller
   *  composes the final user_response (typically by combining with
   *  the failure template). */
  readonly salvaged_response?: string;
  /** Closed-list reason strings from both rounds (for audit replay). */
  readonly round1_reason: string;
  readonly round2_reason: string;
}

export type MalformedAiRetryResult<TParsed> =
  | MalformedAiRetryOk<TParsed>
  | MalformedAiRetryDegraded;

/** Run the at-most-2-attempts retry loop. */
export const withMalformedAiRetry = async <TRaw, TParsed>(
  input: MalformedAiRetryInput<TRaw, TParsed>,
): Promise<MalformedAiRetryResult<TParsed>> => {
  const round = input.round ?? 0;

  // Round 1 — first attempt.
  const first = await input.attempt();
  const firstValidated = input.validate(first);
  if (firstValidated.kind === 'ok') {
    return { kind: 'ok', value: firstValidated.value, recovered_after_retry: false };
  }

  // First malformed — emit transparency event + retry once with prompt note.
  input.emit(buildAiCallMalformedEvent({ round }));

  const retryPromptNote = input.retry_prompt_note ?? MALFORMED_AI_RETRY_PROMPT_NOTE;
  const second = await input.attempt(retryPromptNote);
  const secondValidated = input.validate(second);
  if (secondValidated.kind === 'ok') {
    return { kind: 'ok', value: secondValidated.value, recovered_after_retry: true };
  }

  // Second malformed — emit giving-up event + degrade.
  input.emit(buildAiCallGivingUpMalformedEvent());
  const salvaged = input.salvage !== undefined ? input.salvage(second) : undefined;
  return {
    kind: 'degraded',
    ...(salvaged !== undefined && salvaged.length > 0 ? { salvaged_response: salvaged } : {}),
    round1_reason: firstValidated.reason,
    round2_reason: secondValidated.reason,
  };
};
