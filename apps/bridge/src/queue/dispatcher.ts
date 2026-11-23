/** D-148 § A.3 — bridge command dispatcher (D-169 P0 Slice 2A amends).
 *
 *  Glue layer between the FIFO queue + the action executor. Per
 *  command:
 *
 *    1. Atomically claim admission. If the bridge already has a result for
 *       this `command_id` (or for this `idempotency_key` under a
 *       different command_id), return the prior result with
 *       `idempotency_key_seen: true`. An unresolved marker returns delivery
 *       uncertainty without executing or replacing that marker. Otherwise
 *       commit a new marker before proceeding. (§ A.3.3)
 *
 *    2. Two-way grant intersection (D-169 § A.7). Per-command
 *       BridgeAuthority signing retires (DL-1). The scope shape
 *       (action × domain pattern × duration) rides as unsigned
 *       envelope fields on `BridgeCommand`. The bridge gates per
 *       action by:
 *         - the ingredient's signed `domain_allowlist` (signature
 *           verified upstream by the server before dispatch — the
 *           bridge trusts the ingredient ref's allowlist as
 *           already-verified)
 *         - the user's `BridgeIngredientGrant.granted_origins`
 *       Both must hold; failure raises `authority_invalid_grant_scope`.
 *
 *    3. Action execution via the injected executor. Bound by
 *       `command.timeout_ms` (default 30 s, max 60 s); cooperative
 *       cancel propagates if `cancelSignal` flips during execution.
 *
 *    4. Persist the result in the idempotency cache + return. After a deadline,
 *       retain observation of the original executor and record a confirmed late
 *       completion locally. The original timeout response remains unchanged.
 *       User cancellation changes the reply; a confirmed executor receipt still
 *       retires its marker and can be replayed by a later explicit retry.
 *
 *  Pure logic — chrome.* APIs sit behind the executor injection point.
 *  Tests inject in-memory implementations of all three collaborators.
 */

import {
  BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS,
  BRIDGE_COMMAND_MAX_TIMEOUT_MS,
  isCommandWithinIngredientGrant,
  type BridgeAction,
  type BridgeCommand,
  type BridgeErrorCode,
  type BridgeIngredientGrant,
  type BridgeResult,
  type BridgeResultStatus,
} from '@recued/contracts';
import { type BridgeGrantStore } from '../permissions/grants.js';
import { type IdempotencyCache, receiptResolvesInFlight, stampIdempotencyResult } from '../idempotency/cache.js';

export interface ActionExecutorRequest {
  command: BridgeCommand;
  /** Resolved at dispatch time from `command.action` (D-169 P0 Slice
   *  2A — was `command.authority.permitted_actions[0]`). */
  action: BridgeAction;
  cancel: { signalled: boolean };
}

export interface ActionExecutorOutcome {
  status: BridgeResultStatus;
  outputs?: Record<string, unknown>;
  error?: BridgeResult['error'];
}

/** Pure interface — chrome content-script DOM dispatch lives behind
 *  this. Tests inject a deterministic stub. */
export interface BridgeActionExecutor {
  execute(req: ActionExecutorRequest): Promise<ActionExecutorOutcome>;
}

export interface DispatcherDeps {
  /** Bridge identity for the result envelope. */
  bridge_version: string;
  /** Wall-clock — injectable for tests. */
  now(): number;
  /** Action executor. */
  executor: BridgeActionExecutor;
  /** Per-ingredient grant store. */
  grants: BridgeGrantStore;
  /** Idempotency cache. */
  idempotency: IdempotencyCache;
}

export interface DispatchOutcome {
  command_id: string;
  result: BridgeResult;
  /** True iff a completed receipt was reused. Used by the
   *  caller to decide whether to deduct from rate-limit / log audit
   *  rows / etc. */
  replayed_from_cache: boolean;
}

/** Resolve the action a command requests. D-169 P0 Slice 2A — reads
 *  `command.action` directly (was `command.authority.permitted_actions[0]`). */
export const resolveCommandAction = (command: BridgeCommand): BridgeAction => {
  return command.action;
};

/** D-148 § A.3.1 — clamp a command's timeout to the spec range.
 *  Returns the effective timeout the dispatcher will use. Server
 *  shouldn't send out-of-range values; bridge is defensive. */
export const clampCommandTimeout = (timeout_ms: number | undefined): number => {
  if (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms) || timeout_ms <= 0) {
    return BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS;
  }
  if (timeout_ms > BRIDGE_COMMAND_MAX_TIMEOUT_MS) {
    return BRIDGE_COMMAND_MAX_TIMEOUT_MS;
  }
  return timeout_ms;
};

type ExecutorSettlement =
  | { outcome: ActionExecutorOutcome; duration_ms: number }
  | { error: unknown };

// A wall-clock adjustment must not turn a confirmed completion into an invalid
// receipt and quarantine otherwise healthy storage.
const elapsedSince = (startMs: number, now: () => number): number => Math.max(0, now() - startMs);

interface RunWithTimeoutResult {
  outcome: ActionExecutorOutcome;
  duration_ms: number;
  /** Always fulfills, including when the executor rejects after the deadline. */
  late_completion?: Promise<ExecutorSettlement>;
}

const runWithTimeout = async (
  executor: BridgeActionExecutor,
  req: ActionExecutorRequest,
  timeout_ms: number,
  startMs: number,
  now: () => number,
): Promise<RunWithTimeoutResult> => {
  let timeout_handle: ReturnType<typeof setTimeout> | null = null;
  const timeout_p = new Promise<{ timed_out: true }>((resolve) => {
    timeout_handle = setTimeout(() => resolve({ timed_out: true }), timeout_ms);
  });
  let winner: ExecutorSettlement | { timed_out: true };
  let completion: Promise<ExecutorSettlement>;
  try {
    completion = executor.execute(req).then(
      outcome => ({ outcome, duration_ms: elapsedSince(startMs, now) }),
      error => ({ error }),
    );
    bridgeCommandActivity.running += 1;
    void completion.then(() => {
      bridgeCommandActivity.running -= 1;
      bridgeCommandActivity.last_ended_at = now();
    });
    winner = await Promise.race([completion, timeout_p]);
  } finally {
    if (timeout_handle !== null) clearTimeout(timeout_handle);
  }
  if ('timed_out' in winner) {
    // Flip cancel signal so the executor's downstream awaits can
    // observe the timeout cooperatively.
    req.cancel.signalled = true;
    return {
      outcome: {
        status: 'timeout',
        error: {
          code: 'unknown',
          message: `bridge: command timed out after ${timeout_ms}ms`,
        },
      },
      duration_ms: elapsedSince(startMs, now),
      late_completion: completion,
    };
  }
  if ('error' in winner) throw winner.error;
  return {
    outcome: winner.outcome,
    duration_ms: winner.duration_ms,
  };
};

/** Cancellation controls this invocation's reply, without mutating the
 * canonical receipt or allowing outputs to flow into its cancelled run. */
const replyForCancellation = (result: BridgeResult, cancel: { signalled: boolean }): BridgeResult =>
  cancel.signalled && result.status === 'ok' ? { ...result, status: 'cancelled', outputs: undefined } : result;

const grantForIngredient = async (
  grants: BridgeGrantStore,
  command: BridgeCommand,
): Promise<BridgeIngredientGrant | null> => {
  return grants.get(
    command.ingredient.publisher_id,
    command.ingredient.slug,
    command.ingredient.version,
  );
};

const buildRejection = (
  command: BridgeCommand,
  bridge_version: string,
  duration_ms: number,
  code: BridgeErrorCode,
  message: string,
  detail?: string,
): BridgeResult => ({
  command_id: command.command_id,
  status: 'rejected',
  error: { code, message, detail },
  duration_ms,
  bridge_version,
  idempotency_key_seen: false,
});

/** D-148 § A.3 + D-169 § A.7 — dispatch one BridgeCommand. */
/** D-347 follow-up 19 — whether a command is running here, and when the last one ended: Keep signed in
 *  leaves the browser alone meanwhile (`keep-signed-in.ts`). A command counts until its executor settles,
 *  past a timeout too. */
export const bridgeCommandActivity: { running: number; last_ended_at: number } = { running: 0, last_ended_at: 0 };

export const dispatchBridgeCommand = async (
  command: BridgeCommand,
  deps: DispatcherDeps,
  cancelSignal: { signalled: boolean } = { signalled: false },
): Promise<DispatchOutcome> => {
  // Retain the identity and pair cache that admitted this invocation, including
  // while a late executor is still running after the queue has moved on.
  const { command_id, idempotency_key } = command;
  const { idempotency, bridge_version, now } = deps;
  const start = now();

  // Step 1: commit admission before any executor can act. The cache checks
  // both identities and completed receipts in the same transaction.
  const claim = await idempotency.claim(command_id, idempotency_key);
  if (claim.kind === 'completed') {
    return {
      command_id: command.command_id,
      result: replyForCancellation({ ...stampIdempotencyResult(claim.entry.result, claim.entry), command_id: command.command_id }, cancelSignal),
      replayed_from_cache: true,
    };
  }
  if (claim.kind === 'in_flight') {
    // This is evidence of admission, not evidence of success or failure. Do
    // not store this reply as a completed receipt or age out its protection.
    return {
      command_id: command.command_id,
      result: { command_id: command.command_id, status: 'error',
        error: { code: 'delivery_uncertain',
          message: 'An earlier attempt has no confirmed completion. Check the page before retrying.',
          detail: JSON.stringify({ original_command_id: claim.entry.command_id, started_at: claim.entry.started_at }) },
        duration_ms: elapsedSince(start, now), bridge_version, idempotency_key_seen: true },
      replayed_from_cache: false,
    };
  }

  // Step 2: D-169 § A.7 two-way grant intersection. The ingredient's
  // signed domain_allowlist is verified upstream at dispatch; here the
  // bridge gates on (a) the user's per-ingredient grant being present
  // and (b) `target_domain_pattern` being within both the ingredient's
  // allowlist + the grant's granted_origins. `isCommandWithinIngredientGrant`
  // checks all three axes (tuple match + allowlist membership + grant
  // membership) — preserves the bridge's defense-in-depth posture per
  // § A.3.4.1 minus the retired server-attesting-to-itself authority
  // signature check (D-169 § N.3 / DL-1).
  const action = resolveCommandAction(command);
  const grant = await grantForIngredient(deps.grants, command);
  if (!grant) {
    const result = buildRejection(
      command,
      bridge_version,
      elapsedSince(start, now),
      'authority_invalid_grant_scope',
      'bridge: no per-ingredient grant for this command',
      `(publisher_id, slug, version) = (${command.ingredient.publisher_id}, ${command.ingredient.slug}, ${command.ingredient.version})`,
    );
    await idempotency.store(command_id, idempotency_key, result);
    return { command_id: command.command_id, result, replayed_from_cache: false };
  }
  if (!isCommandWithinIngredientGrant(command.target_domain_pattern, command.ingredient, grant)) {
    const result = buildRejection(
      command,
      bridge_version,
      elapsedSince(start, now),
      'authority_invalid_grant_scope',
      'bridge: target_domain_pattern outside ingredient allowlist or user grant',
      command.target_domain_pattern,
    );
    await idempotency.store(command_id, idempotency_key, result);
    return { command_id: command.command_id, result, replayed_from_cache: false };
  }

  // Step 3: execute with timeout.
  const timeout_ms = clampCommandTimeout(command.timeout_ms);
  const exec_result = await runWithTimeout(
    deps.executor,
    { command, action, cancel: cancelSignal },
    timeout_ms,
    start,
    now,
  );

  // Persist the executor's evidence independently of the caller's cancellation.
  // A confirmed completion can retire admission even though this run stopped.
  const receipt: BridgeResult = {
    command_id,
    status: exec_result.outcome.status,
    outputs: exec_result.outcome.status === 'ok' ? exec_result.outcome.outputs : undefined,
    error: exec_result.outcome.error,
    duration_ms: exec_result.duration_ms,
    bridge_version,
    idempotency_key_seen: false,
  };

  await idempotency.store(command_id, idempotency_key, receipt);
  if (exec_result.late_completion) {
    // Attach only after the timeout receipt commits, so a completion arriving
    // during that write cannot be overwritten by the older timeout. This local
    // receipt retires the marker atomically; it sends no second reply and cannot
    // resume the timed-out recipe. A later explicit retry may replay it.
    void exec_result.late_completion.then(async settlement => {
      if ('error' in settlement) return; // A lost acknowledgement proves nothing.
      const late: BridgeResult = {
        command_id,
        status: settlement.outcome.status,
        outputs: settlement.outcome.status === 'ok' ? settlement.outcome.outputs : undefined,
        error: settlement.outcome.error,
        duration_ms: settlement.duration_ms,
        bridge_version,
        idempotency_key_seen: false,
      };
      if (receiptResolvesInFlight(late)) await idempotency.store(command_id, idempotency_key, late);
    }).catch(() => {
      // A failed commit leaves the durable marker and cache quarantine intact.
      // Worker termination can also lose this observer; neither permits retry.
    });
  }
  // Sample cancellation after the commit as well: the owner may cancel while
  // storage is saving the receipt. Return a copy, preserving cached outputs for
  // explicit retries and suppressing them on the original cancelled reply.
  return { command_id, result: replyForCancellation(receipt, cancelSignal), replayed_from_cache: false };
};
