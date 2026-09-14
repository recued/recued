/** D-268 — how hard to stop an unattended automation that just failed.
 *
 *  An unattended run (cron schedule / auto-run / event trigger) that fails has
 *  always been recorded and has never been reported. D-268 reports it — and the
 *  question that decides the whole design is **how long to keep firing before
 *  disarming**, which is what this module answers.
 *
 *  🔑 THE ANSWER IS NOT A CONSTANT, AND `CIRCUIT_BREAKER_THRESHOLD` ALONE IS THE
 *  WRONG SHAPE. Waiting five occurrences is meaningful only when waiting could
 *  help. A revoked token does not un-revoke itself; a recipe naming a connection
 *  that does not exist will name it again tomorrow. For those, five cycles is
 *  five cycles of a broken automation bought for nothing — so they stop on the
 *  FIRST failure. Only a genuinely transient environment fault earns the
 *  breaker.
 *
 *  ⛔⛔ AND `ERROR_ATTRIBUTION` CANNOT BE USED AS THIS POLICY DIRECTLY, THOUGH IT
 *  ANSWERS MOST OF IT. That table answers *whose fault*, not *will waiting
 *  help*. The two coincide for `choice` / `owner` / `conditional` and diverge
 *  inside `environment`, which holds both `NETWORK_ERROR` (wait, it may pass)
 *  and `OAUTH_REVOKED` (waiting is pointless). The divergence is not an
 *  oversight — the attribution table DECLARES its bias: *"The tie-break is
 *  `environment`. When a code could be either, the conservative direction is to
 *  REFUSE to file: a missing lesson costs nothing, a false lesson is durable."*
 *  That bias is right for keeping false lessons out of a bench corpus and
 *  BACKWARDS here, where an unnecessary stop costs one tap and an unnecessary
 *  wait costs five cycles. ⇒ {@link ENVIRONMENT_RETRY_POLICY} splits exactly
 *  that bucket, and nothing else, so the other three keep deriving from the one
 *  table that owns them.
 *
 *  ⛔⛔⛔ `RecipeError.retryable` IS NOT AN INPUT HERE, AND THE CENSUS IS WHY.
 *  The field exists (`errors.ts`) and the engine reads it
 *  (`step-runner.ts` tests `retryable === false`), so it looks like the obvious
 *  per-instance override — most specific wins. **Every `RecipeError`
 *  construction site in `packages/engine` and `execute-handler.ts` writes
 *  `retryable: false` as a literal.** The only `retryable: true` in the tree
 *  belongs to `LLMError` (the executor's cascade re-match signal) and to the
 *  vendor-merge result shape — different types entirely. Consuming it would
 *  therefore classify EVERY error as stop-at-first, silently collapsing this
 *  module to a constant and making the `retry` bucket dead code **while every
 *  test still passed**. A field that is always one value is decoration, and
 *  reading decoration as a decision is how a policy disappears without anyone
 *  noticing.
 *
 *  Spec: D-268 § 3 + amendments 1 and 3. */

import { ERROR_ATTRIBUTION } from './errors.js';

/** When a failing automation disarms itself.
 *
 *  `'first_failure'` — one failure is all the evidence there will ever be.
 *  `'breaker'`       — keep firing until `CIRCUIT_BREAKER_THRESHOLD`, because a
 *                      later attempt could genuinely succeed. */
export type AutomationStopPoint = 'first_failure' | 'breaker';

/** Why a disposition came out the way it did. Carried so a surface, an audit
 *  row or a test can say WHICH rule fired rather than re-deriving it — and so a
 *  wrong classification is visible as a wrong basis rather than as a mysterious
 *  threshold. */
export type AutomationFailureBasis =
  | 'total_refusal'
  | 'attribution_choice'
  | 'attribution_owner'
  | 'environment_permanent'
  | 'environment_transient'
  | 'unclassified';

export type AutomationFailureDisposition =
  /** ⛔ NOT A FAILURE — the recipe decided not to act and was right to. No
   *  episode, no counter, no notice. See {@link classifyAutomationFailure}. */
  | { readonly kind: 'not_a_failure' }
  | {
    readonly kind: 'failure';
    readonly stop: AutomationStopPoint;
    readonly basis: AutomationFailureBasis;
  };

/** The `environment` bucket, split by *will waiting help* — the ONLY bucket
 *  where the answer is not already determined by attribution.
 *
 *  `'retry'` — a later attempt could succeed with no human action: transport,
 *              rate limits, 5xx, timeouts, contention, a service still starting.
 *  `'stop'`  — a later attempt fails identically until a person acts: every
 *              credential fault, a missing resource, a hard limit, a refusal.
 *
 *  ⛔ KEYED ONLY OVER `environment` CODES, DELIBERATELY. A full
 *  `Record<RecipeErrorCode, …>` would restate 85 entries that
 *  {@link ERROR_ATTRIBUTION} already determines, and a field that duplicates a
 *  guarantee is the only way that guarantee breaks: re-attributing a code would
 *  silently leave the two tables disagreeing, with no compiler and no reader to
 *  catch it. Completeness is held by the ratchet test instead
 *  (`automation-failure-policy.ratchet.test.ts`), which fails when an
 *  `environment` code has no entry here AND when a non-`environment` code does. */
export const ENVIRONMENT_RETRY_POLICY: Readonly<Record<string, 'retry' | 'stop'>> = {
  // ── transport, contention and load: the classic "try again later" ────────
  NETWORK_ERROR: 'retry',
  CONNECTION_REFUSED: 'retry',
  CONNECTION_TIMEOUT: 'retry',
  STEP_TIMEOUT: 'retry',
  TRANSFORM_TIMEOUT: 'retry',
  API_RATE_LIMITED: 'retry',
  API_SERVER_ERROR: 'retry',
  SERVER_NOT_REACHABLE: 'retry',
  COLLECTION_SOURCE_UNREACHABLE: 'retry',
  WEBHOOK_UNAVAILABLE: 'retry',
  EVENT_TRIGGER_BACKPRESSURE: 'retry',
  LOCK_HELD: 'retry',
  DRAINING: 'retry',
  NOT_READY: 'retry',
  CACHE_MISS: 'retry',
  STORAGE_PRESSURE: 'retry',
  INGREDIENT_ADAPTER_ALL_FAILED: 'retry',
  MCP_TOOL_ERROR: 'retry',
  NOTIFICATION_SEND_FAILED: 'retry',
  DOM_WRITE_FAILED: 'retry',
  CHECKPOINT_STORE_UNAVAILABLE: 'retry',
  CHECKPOINT_WRITE_FAILED: 'retry',
  ARCHIVE_IMPORT_IN_PROGRESS: 'retry',
  RECIPE_BUDGET_EXCEEDED: 'retry',

  // ── AI: nondeterministic, so the same input can pass next time ───────────
  AI_LLM_UNAVAILABLE: 'retry',
  AI_TIMEOUT: 'retry',
  AI_OUTPUT_INVALID: 'retry',
  AI_RESPONSE_PARSE_FAILED: 'retry',
  AI_RESPONSE_VALIDATION_FAILED: 'retry',
  // A daily allowance resets; five consecutive exhaustions is the breaker's job.
  AI_TOKEN_BUDGET_EXCEEDED: 'retry',
  // ⚠ NOT retryable: a refusal is a property of the CONTENT, and the content
  // does not change between two ticks of the same recipe.
  AI_MODEL_REFUSED: 'stop',

  // ── services: the supervisor may fix a transient, never a broken install ──
  SERVICE_ALREADY_RUNNING: 'retry',
  SERVICE_NOT_RUNNING: 'retry',
  SERVICE_STORAGE_PRESSURE: 'retry',
  SERVICE_INVOKE_CONCURRENCY: 'retry',
  SERVICE_HEALTH_TIMEOUT: 'retry',
  SERVICE_CHECK_FAILED: 'retry',
  SERVICE_INSTALL_FAILED: 'stop',
  SERVICE_UPGRADE_FAILED: 'stop',
  SERVICE_UNINSTALL_FAILED: 'stop',
  SERVICE_PERMANENTLY_CRASHED: 'stop',
  CRASH_LOOP_ACTIVE: 'stop',

  // ── ⛔ CREDENTIALS — the whole reason this table exists ───────────────────
  // A token does not un-revoke itself. These are `environment` because the
  // fault is outside the recipe's CHOICE, and they are the codes for which
  // running to the breaker is purely wasted cycles.
  OAUTH_REVOKED: 'stop',
  OAUTH_EXPIRED: 'stop',
  TOKEN_REFRESH_FAILED: 'stop',
  CONNECTION_AUTH_EXPIRED: 'stop',
  MAIL_SEND_AUTH_FAILED: 'stop',
  MAIL_DRAFT_AUTH_FAILED: 'stop',
  ACCOUNT_MISMATCH: 'stop',

  // ── mail: the codes' own docs already say which is which ─────────────────
  MAIL_SEND_NETWORK_FAILED: 'retry',   // "Retryable on next run"
  MAIL_DRAFT_NETWORK_FAILED: 'retry',  // "Retryable; nothing about the message is wrong"
  MAIL_SEND_APPEND_FAILED: 'retry',
  MAIL_DRAFT_PRIOR_NOT_REMOVED: 'retry',
  MAIL_DRAFT_FOLDER_NOT_FOUND: 'stop',
  MAIL_DRAFT_ATTACHMENTS_OMITTED: 'stop',
  mail_draft_not_found: 'stop',
  mail_draft_stale: 'stop',

  // ── gone, absent, or capped: identical next time ─────────────────────────
  API_NOT_FOUND: 'stop',
  COLLECTION_RECORD_NOT_FOUND: 'stop',
  ARCHIVE_JOB_UNKNOWN: 'stop',
  CHECKPOINT_STEP_NOT_FOUND: 'stop',
  QUOTA_EXCEEDED: 'stop',
  TIER_LIMIT_EXCEEDED: 'stop',
  preapproval_unsupported: 'stop',
  preapproval_stale: 'stop',
  CLI_TOOL_FAILED: 'stop',

  // ⛔⛔ NEVER `retry`, AND NOT BECAUSE RETRYING WOULD FAIL — BECAUSE IT MIGHT
  // SUCCEED TWICE. The ack was lost, so the effect may already have landed.
  // `fire-exchange-output.ts` holds the same ruling for the peer path:
  // "uncertain delivery is never advertised as retryable".
  ACTION_DELIVERY_UNCERTAIN: 'stop',
};

/** Decide how a just-failed unattended run should be treated.
 *
 *  ⛔ THE DIRECT EVIDENCE WINS. When the run carries an error code, that code
 *  decides — `total_refusal` is consulted only in its absence. A refusal count
 *  is INFERRED from two integers; an error code is a fact the run reported, and
 *  an inference must never outrank it.
 *
 *  ⛔⛔ `total_refusal` STOPS AT THE BREAKER, NOT AT THE FIRST — a deliberate
 *  exception to the unclassified rule one line below it, and the reason is the
 *  strength of the evidence rather than the severity of the outcome. An
 *  unclassified ERROR is a run that FAILED: something is definitely wrong and
 *  stopping is cheap. A total refusal is a run the engine's own contract calls a
 *  SUCCESS, whose problem is inferred from `items_failed === items_total`; the
 *  most plausible single cause is a transient upstream storm (`API_RATE_LIMITED`
 *  is `warn` severity precisely because it describes the moment, not the
 *  recipe). Treating the inferred signal as MORE decisive than the direct one
 *  would be backwards. The owner is still notified on the first refusal — only
 *  the disarm waits.
 *
 *  🔑🔑 OWNER RULING, 2026-09-13 — UNCLASSIFIED STOPS AT THE FIRST OCCURRENCE,
 *  AND IT IS PINNED HERE RATHER THAN IN THE SPEC. The build surfaced that
 *  uncoded failures were the TEST CORPUS'S DEFAULT (a bare `new Error('boom')`,
 *  a stub's placeholder `'test_err'`), which raised the question of whether
 *  failing closed disarms too eagerly in production. Ruled: **it stops.** An
 *  unnecessary stop costs one tap on a notice the owner is already holding; an
 *  unnecessary wait costs five cycles of an automation that may be permanently
 *  broken, silently. A dismissal that lives only in a research record is one the
 *  next audit re-raises, so it lives at the code site it governs.
 *
 *  ⛔ THIS DOES NOT TOUCH `total_refusal`, WHICH ALSO CARRIES NO CODE. The two
 *  are separated by the resolution order below, not by the same rule: a total
 *  refusal is matched BEFORE the unclassified fallback and keeps running to the
 *  breaker, because a run the engine calls a SUCCESS is weaker evidence than a
 *  run that actually failed. Collapsing them would make an inferred signal more
 *  decisive than a direct one.
 *
 *  ⚠ `conditional` RETURNS `not_a_failure`, AND GETTING THIS WRONG DISARMS
 *  WORKING AUTOMATIONS. *"A guard tripped, a fail-on matched, a prerequisite was
 *  absent. Nothing broke and nothing was chosen badly: the flow worked exactly
 *  as written."* Counting those toward a breaker switches off the recipes that
 *  are behaving correctly — and it would look exactly like the feature working. */
export const classifyAutomationFailure = (input: {
  /** The failing run's first error code, when it reported one. */
  readonly code?: string | undefined;
  /** D-237 — every `foreach` item attempted was refused while the run reported
   *  `success: true`. Consulted only when `code` is absent. */
  readonly total_refusal?: boolean | undefined;
}): AutomationFailureDisposition => {
  const code = input.code;
  if (code !== undefined && code !== '') {
    const attribution = (ERROR_ATTRIBUTION as Record<string, string | undefined>)[code];
    switch (attribution) {
      case 'conditional':
        return { kind: 'not_a_failure' };
      case 'choice':
        return { kind: 'failure', stop: 'first_failure', basis: 'attribution_choice' };
      case 'owner':
        return { kind: 'failure', stop: 'first_failure', basis: 'attribution_owner' };
      case 'environment': {
        const policy = ENVIRONMENT_RETRY_POLICY[code];
        if (policy === 'retry') {
          return { kind: 'failure', stop: 'breaker', basis: 'environment_transient' };
        }
        // ⛔ A MISSING ENTRY FAILS CLOSED rather than defaulting to `retry`. The
        // ratchet test makes this branch unreachable in a built tree; it stays
        // because an unreachable branch that stops is safe and an unreachable
        // branch that waits is not.
        return { kind: 'failure', stop: 'first_failure', basis: 'environment_permanent' };
      }
      default:
        // A code this build does not know. Same posture as no code at all —
        // owner-ruled 2026-09-13, see the note above.
        return { kind: 'failure', stop: 'first_failure', basis: 'unclassified' };
    }
  }
  if (input.total_refusal === true) {
    return { kind: 'failure', stop: 'breaker', basis: 'total_refusal' };
  }
  // No code at all: a raw `Error` thrown from an adapter or the runtime. Stops
  // at the first occurrence — owner-ruled 2026-09-13, see the note above.
  return { kind: 'failure', stop: 'first_failure', basis: 'unclassified' };
};
