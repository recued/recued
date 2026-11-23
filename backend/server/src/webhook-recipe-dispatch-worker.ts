/** D-201 Slice 10A — the recipe-dispatch worker: runs the recipe work the
 * webhook event outbox hands off.
 *
 * The outbox's sink only materializes target rows (`prepareDispatches`): one
 * per authorized trigger, each with its stable run id and a pin on the event's
 * decoded payload. The outer row is then `dispatched`, and this worker owns the
 * rest. It claims a target under a lease that a heartbeat renews for as long as
 * the run takes, so no timeout or attempt budget runs out on a recipe that is
 * still working, and a live claim is never taken over.
 *
 * - A claim whose worker died (a crash) is reclaimed once its lease expires,
 *   under the same run id: the runner reuses what that run left (a succeeded
 *   anchor completes the target, a killed or denied one closes it, a failed
 *   one runs again).
 * - D-201 Slice 10E — a run the server's own stop ended is not final. The
 *   restart's drain stops a run still going after its grace, and the run's
 *   record says `killed`, as the owner's Stop does. The worker marks its live
 *   claims when the server begins to stop (`noteServerStopping`) and hands a
 *   run that comes back stopped meanwhile back with its attempt; the next
 *   start runs it again on its run id. Only a kill outside a stop is final.
 *   Slice 10J: the mark stays until a new run record replaces the `killed`
 *   one, so a failure before the run starts again, a claim that fails, or the
 *   attempt ceiling never turns the restart into the owner's Stop. And a held
 *   delivery whose approved run is resuming (outside the worker) is marked
 *   too: one the drain stops becomes a dead letter, never a silent cancel.
 * - Authority is re-derived at every claim (`beginDispatch`): an uninstalled,
 *   disarmed or rebound trigger cancels the target and releases its pin.
 * - A recipe runs one delivery at a time, in the order they were handed off.
 *   A delivery waiting out a retry, held for the owner's approval, or not yet
 *   handed off lets the recipe's later ones run first (D-201 Slice 10E, the
 *   owner's call: one failing delivery never stalls its recipe). Different
 *   recipes run side by side, at most `max_active_runs` at once.
 * - Not run is not failed: a run the server refused to start (restarting or
 *   paused) hands its claim back with its attempt. A run that failed is
 *   retried on the same run id over about an hour
 *   (`WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS`); the last attempt dead-letters the
 *   target, which keeps its payload pin for the owner.
 * - A row that cannot even be claimed waits out the same schedule, step by
 *   step (Slice 10J: it waited the first step every time), and becomes a dead
 *   letter at the attempt ceiling, so it holds no slot and no recipe.
 * - Paused, vault-locked or stopping: nothing is claimed.
 */

import { settleWithin, STOP_GRACE_MS } from './lifecycle/settle-within.js';
import { isRunRefusedForNow } from './pause-approval.js';
import type { WebhookDeliveryStore } from './storage/webhook-delivery-store.js';
import type {
  WebhookConsumerStore,
  WebhookDispatchClaim,
} from './storage/webhook-consumer-store.js';
import {
  createWebhookRecipeOutboxSink,
  runClaimedWebhookDispatch,
  WebhookRunNotRestartedError,
  type WebhookRecipeRunner,
} from './webhook-recipe-consumer.js';
import {
  createWebhookOutboxRuntime,
  type WebhookOutboxRuntime,
  type WebhookOutboxRuntimeOptions,
} from './webhook-outbox-dispatcher.js';

/** A claim lasts this long unless renewed; a crashed worker's claim is
 *  reclaimed this long after its last heartbeat at the latest. */
export const WEBHOOK_DISPATCH_LEASE_MS = 30_000;
/** Claims per target, the crashed ones included, before it dead-letters. */
export const WEBHOOK_DISPATCH_MAX_ATTEMPTS = 8;
/** Runs this process keeps going at once. The outbox's former ceiling on the
 *  runs that outlived its timeout, and the trigger queue's concurrency. */
export const WEBHOOK_DISPATCH_MAX_ACTIVE_RUNS = 16;
/** D-201 Slice 10E — the wait before each retry of a failed run, the owner's
 *  choice: about an hour from the first failure to the eighth, so a provider
 *  outage of a few minutes no longer dead-letters every delivery in it (10A's
 *  1 s doubling ended about 127 s after the first failure). */
export const WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000,
]);
/** Candidates read per pass. More than the free slots, so rows that cannot be
 *  claimed never fill the pass (the scan returns at most one per recipe). */
const CANDIDATES_PER_PASS = 100;
/** `drain()` stops after this many passes (each claims at most one delivery
 *  per recipe), so a store that keeps offering work cannot hold it forever. */
const MAX_DRAIN_PASSES = 1_000;

type Log = (
  level: 'warn' | 'error',
  message: string,
  metadata: Readonly<Record<string, string | number>>,
) => void;

export interface WebhookRecipeDispatchWorkerDeps {
  consumerStore: Pick<
    WebhookConsumerStore,
    | 'listRunnableDispatches'
    | 'beginDispatch'
    | 'renewDispatchLease'
    | 'releaseDispatchClaim'
    | 'cancelUnreadableDispatch'
    | 'markDispatchAwaitingApproval'
    | 'markDispatchSucceeded'
    | 'markDispatchCancelled'
    | 'markDispatchFailed'
    | 'markInterruptedByRestart'
    | 'releaseInterruptedDispatch'
    | 'deferUnclaimableDispatch'
    | 'listAwaitingApprovalDispatches'
    | 'markResumesInterruptedByRestart'
  >;
  deliveryStore: Pick<WebhookDeliveryStore, 'getEvent' | 'getDelivery'>;
  runner: WebhookRecipeRunner;
}

export interface WebhookRecipeDispatchWorkerOptions {
  lease_ms?: number;
  /** How often a live run renews its lease. Defaults to a third of it. */
  heartbeat_ms?: number;
  max_attempts?: number;
  /** Either replaces the retry schedule with a doubling one from
   *  `base_retry_ms`, capped at `max_retry_ms` (tests, tuning). */
  base_retry_ms?: number;
  max_retry_ms?: number;
  max_active_runs?: number;
  poll_interval_ms?: number;
  /** Live autonomous-execution gate: false (paused, vault locked) claims
   *  nothing, so a long pause spends no attempt. */
  canDispatch?: () => boolean;
  /** The server has begun stopping (its restart drain): claim nothing more. */
  isStopping?: () => boolean;
  /** D-201 Slice 10J — whether a run is still going in this process (the
   *  in-flight registry). At the server's stop, a held delivery whose run is
   *  going is one the owner approved, resuming outside this worker: it is
   *  marked like a claim, so the drain's stop is not read as the owner's. */
  isRunActive?: (runId: string) => boolean;
  /** Fold owner decisions on held runs into their targets. Runs on each poll,
   *  before claiming; never starts or resumes a run. */
  reconcileWaitingDispatches?: () => Promise<void>;
  /** Local upkeep on each poll, before claiming, paused or not (D-201 Slice
   *  10B: the dead-letter review limit). A throw is logged, never raised. */
  onPoll?: () => void;
  log?: Log;
}

export interface WebhookRecipeDispatchResult {
  claimed: number;
  completed: number;
  awaiting_approval: number;
  cancelled: number;
  retried: number;
  dead_lettered: number;
  /** Handed back unrun: the server refused to start the run. */
  released: number;
  /** Settled after its claim was gone (cancelled by an uninstall, or reclaimed
   *  after its lease expired). The claim's current owner decides it. */
  lost: number;
}

export interface WebhookRecipeDispatchRuntime {
  start(): void;
  /** Close admission and stop polling; wait for the runs still going at most
   *  `STOP_GRACE_MS` (the restart drain kills them). */
  stop(): Promise<void>;
  isStarted(): boolean;
  /** Look for runnable work now instead of at the next poll. */
  kick(): void;
  /** D-201 Slice 10E — the server has begun to stop: mark the claims this
   *  process is running, so a run its drain stops runs again at the next
   *  start, and (Slice 10J) the held deliveries whose approved runs are
   *  resuming. Returns how many were marked; never throws. */
  noteServerStopping(): number;
  /** What this worker has done since it was made (a copy). */
  totals(): WebhookRecipeDispatchResult;
  /** Claim and run until nothing is runnable now, waiting for every run it
   *  starts (and any already going). Reports everything the worker did
   *  meanwhile, a background pass's runs included. For tests and explicit
   *  drains. */
  drain(): Promise<WebhookRecipeDispatchResult>;
}

const emptyResult = (): WebhookRecipeDispatchResult => ({
  claimed: 0,
  completed: 0,
  awaiting_approval: 0,
  cancelled: 0,
  retried: 0,
  dead_lettered: 0,
  released: 0,
  lost: 0,
});

const resultSince = (
  now: WebhookRecipeDispatchResult,
  before: WebhookRecipeDispatchResult,
): WebhookRecipeDispatchResult => {
  const delta = emptyResult();
  for (const key of Object.keys(delta) as Array<keyof WebhookRecipeDispatchResult>) {
    delta[key] = now[key] - before[key];
  }
  return delta;
};

const retryDelayFor = (
  attemptCount: number,
  baseRetryMs: number,
  maxRetryMs: number,
): number => Math.min(
  maxRetryMs,
  baseRetryMs * (2 ** Math.min(20, Math.max(0, attemptCount - 1))),
);

const integerIn = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`webhook recipe dispatch: ${label} must be in ${minimum}..${maximum}`);
  }
  return value;
};

export const createWebhookRecipeDispatchRuntime = (
  deps: WebhookRecipeDispatchWorkerDeps,
  options: WebhookRecipeDispatchWorkerOptions = {},
): WebhookRecipeDispatchRuntime => {
  const leaseMs = integerIn(options.lease_ms ?? WEBHOOK_DISPATCH_LEASE_MS, 1_000, 15 * 60 * 1_000, 'lease_ms');
  const heartbeatMs = integerIn(
    options.heartbeat_ms ?? Math.floor(leaseMs / 3),
    100,
    Math.floor(leaseMs / 2),
    'heartbeat_ms',
  );
  const maxAttempts = integerIn(options.max_attempts ?? WEBHOOK_DISPATCH_MAX_ATTEMPTS, 1, 100, 'max_attempts');
  const doubling = options.base_retry_ms !== undefined || options.max_retry_ms !== undefined;
  const baseRetryMs = integerIn(options.base_retry_ms ?? 1_000, 0, 24 * 60 * 60 * 1_000, 'base_retry_ms');
  const maxRetryMs = integerIn(options.max_retry_ms ?? 15 * 60 * 1_000, baseRetryMs, 24 * 60 * 60 * 1_000, 'max_retry_ms');
  /** The wait after a target's `attemptCount`th attempt failed. */
  const retryDelay = (attemptCount: number): number => doubling
    ? retryDelayFor(attemptCount, baseRetryMs, maxRetryMs)
    : WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS[Math.min(
        Math.max(0, attemptCount - 1),
        WEBHOOK_DISPATCH_RETRY_SCHEDULE_MS.length - 1,
      )]!;
  const maxActiveRuns = integerIn(options.max_active_runs ?? WEBHOOK_DISPATCH_MAX_ACTIVE_RUNS, 1, 100, 'max_active_runs');
  const pollIntervalMs = integerIn(options.poll_interval_ms ?? 1_000, 100, 60_000, 'poll_interval_ms');
  const { consumerStore, deliveryStore, runner } = deps;

  let started = false;
  let accepting = true;
  let timer: ReturnType<typeof setInterval> | null = null;
  let passInFlight: Promise<void> | null = null;
  let passAgain = false;
  let stopPromise: Promise<void> | null = null;
  /** The runs this process has going, by dispatch id. */
  const active = new Map<string, Promise<boolean>>();
  /** Their claims, by dispatch id, and the recipes they belong to: a recipe
   *  with a run going here is busy whatever its lease says (a lapsed lease —
   *  a clock jump, a renewal that failed — must not start a second run). */
  const activeClaims = new Map<string, { claim_token: string; recipe: string }>();
  const activeRecipes = new Set<string>();
  const recipeKey = (input: { publisher_id: string; recipe_id: string }): string =>
    `${input.publisher_id}\u0000${input.recipe_id}`;
  /** Everything this worker did since it was made; `drain()` reports the
   *  difference across its own span. */
  const result = emptyResult();
  /** Targets whose claim failed, logged once each: one is retried on every
   *  pass (it may have been a race), and a log line a second is noise. */
  const reportedClaimFailures = new Set<string>();

  /** Closed by `stop()`, or the server already stopping. A throwing predicate
   *  reads as stopping: claiming on an unknown answer could spend attempts on
   *  runs the server refuses. */
  const stopping = (): boolean => {
    if (!accepting) return true;
    try {
      return options.isStopping?.() === true;
    } catch {
      return true;
    }
  };

  const mayClaim = (): boolean => {
    if (stopping()) return false;
    try {
      return !options.canDispatch || options.canDispatch();
    } catch {
      options.log?.('warn', 'webhook recipe dispatch gate unavailable', {
        code: 'dispatch_gate_unavailable',
      });
      return false;
    }
  };

  /** Run one claim to its settled state. Never rejects. Resolves true when
   *  the server refused to start the run (restarting or paused). */
  const runClaim = async (
    claim: WebhookDispatchClaim,
    evidence: Parameters<typeof runClaimedWebhookDispatch>[2],
  ): Promise<boolean> => {
    let renewalFailureLogged = false;
    const heartbeat = setInterval(() => {
      try {
        if (!consumerStore.renewDispatchLease({
          dispatch_id: claim.dispatch_id,
          claim_token: claim.claim_token,
          lease_ms: leaseMs,
        })) {
          // Cancelled (an uninstall) or reclaimed: the run finishes, and its
          // settle below finds the claim gone.
          clearInterval(heartbeat);
        }
      } catch {
        // ⛔ ONE FAILED RENEWAL DOES NOT END THE HEARTBEAT (Slice 10E). It used
        // to, and the lapsed lease then let a second run of the recipe start.
        // A database that is closing (a stop) throws on every tick until the
        // run settles; the lease then expires and the next start reclaims the
        // target under the same run id.
        if (!renewalFailureLogged && !stopping()) {
          renewalFailureLogged = true;
          options.log?.('warn', 'webhook recipe dispatch lease renewal failed', {
            code: 'dispatch_lease_renewal_failed',
            dispatch_id: claim.dispatch_id,
            run_id: claim.run_id,
          });
        }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    const lost = (message: string): void => {
      result.lost += 1;
      options.log?.('warn', message, {
        dispatch_id: claim.dispatch_id,
        run_id: claim.run_id,
      });
    };
    let outcome: Awaited<ReturnType<typeof runClaimedWebhookDispatch>>;
    try {
      outcome = await runClaimedWebhookDispatch(runner, claim, evidence);
    } catch (error) {
      clearInterval(heartbeat);
      if (isRunRefusedForNow(error)) {
        // ⛔ NOT RUN IS NOT FAILED. The server is restarting or paused and
        // started nothing: the claim goes back with its attempt.
        try {
          consumerStore.releaseDispatchClaim(claim.dispatch_id, claim.claim_token);
          result.released += 1;
        } catch {
          lost('webhook recipe dispatch claim lost before hand-back');
        }
        return true;
      }
      try {
        const state = consumerStore.markDispatchFailed({
          dispatch_id: claim.dispatch_id,
          claim_token: claim.claim_token,
          error_code: 'run_failed',
          retry_delay_ms: retryDelay(claim.attempt_count),
          max_attempts: maxAttempts,
          // D-201 Slice 10J — it failed before a new run record replaced the
          // one a restart stopped: the restart's mark stays.
          ...(error instanceof WebhookRunNotRestartedError ? { keep_restart_mark: true } : {}),
        });
        if (state === 'dead_letter') {
          result.dead_lettered += 1;
          options.log?.('error', 'webhook recipe dispatch dead-lettered after its last attempt', {
            code: 'dispatch_dead_letter',
            dispatch_id: claim.dispatch_id,
            run_id: claim.run_id,
            attempts: claim.attempt_count,
          });
        } else {
          result.retried += 1;
        }
      } catch {
        lost('webhook recipe dispatch claim lost after run failure');
      }
      return false;
    }
    clearInterval(heartbeat);
    if (outcome === 'interrupted') {
      // The server's stop ended the run (Slice 10E): not the recipe's failure
      // and not the owner's Stop. Back with its attempt, marked, for the next
      // start to run again on its run id.
      try {
        consumerStore.releaseInterruptedDispatch(claim.dispatch_id, claim.claim_token);
        result.released += 1;
      } catch {
        lost('webhook recipe dispatch claim lost before its stopped run was handed back');
      }
      return true;
    }
    try {
      if (outcome === 'awaiting_approval') {
        consumerStore.markDispatchAwaitingApproval(claim.dispatch_id, claim.claim_token);
        result.awaiting_approval += 1;
      } else if (outcome === 'terminal_non_success') {
        consumerStore.markDispatchCancelled(claim.dispatch_id, claim.claim_token);
        result.cancelled += 1;
      } else if (outcome === 'door_missing' || outcome === 'door_closed') {
        // D-201 Slice 10U (10Q finding 9) — its recipe's webhook has no live
        // door, so nothing ran: a dead letter for the owner at once (no attempt
        // runs until the door is made or opened), never a silent cancel. A
        // restart's mark stays: nothing replaced the run it marked.
        consumerStore.markDispatchFailed({
          dispatch_id: claim.dispatch_id,
          claim_token: claim.claim_token,
          error_code: outcome,
          retry_delay_ms: 0,
          max_attempts: 1,
          keep_restart_mark: true,
        });
        result.dead_lettered += 1;
        options.log?.('error', 'webhook recipe dispatch kept for the owner: its recipe has no live webhook door', {
          code: outcome,
          dispatch_id: claim.dispatch_id,
          run_id: claim.run_id,
        });
      } else if (outcome === 'in_doubt') {
        // D-201 Slice 10W — tried again, and the server's stop caught a step
        // in doubt again: the owner's dead letter again, whose try again goes
        // on from that step.
        consumerStore.markDispatchFailed({
          dispatch_id: claim.dispatch_id,
          claim_token: claim.claim_token,
          error_code: 'approved_run_in_doubt',
          retry_delay_ms: 0,
          max_attempts: 1,
        });
        result.dead_lettered += 1;
        options.log?.('error', 'webhook recipe dispatch kept for the owner: a step of its approved run is in doubt', {
          code: 'approved_run_in_doubt',
          dispatch_id: claim.dispatch_id,
          run_id: claim.run_id,
        });
      } else {
        consumerStore.markDispatchSucceeded(claim.dispatch_id, claim.claim_token);
        result.completed += 1;
      }
    } catch {
      lost('webhook recipe dispatch claim lost after the run settled');
    }
    return false;
  };

  /** Claim what is runnable now (at most one delivery per recipe, no recipe
   *  with a live claim) and start each run. Returns the runs it started, each
   *  resolving true when the server refused to start it. */
  const claimAndStart = (
    onSettled: (refused: boolean) => void,
  ): Promise<boolean>[] => {
    const startedRuns: Promise<boolean>[] = [];
    if (!mayClaim()) return startedRuns;
    const free = maxActiveRuns - active.size;
    if (free <= 0) return startedRuns;
    // More candidates than free slots: one that cannot be claimed is passed
    // over within the pass instead of taking a slot from the next recipe.
    const candidates = consumerStore.listRunnableDispatches({ limit: CANDIDATES_PER_PASS });
    for (const candidate of candidates) {
      if (stopping() || maxActiveRuns - active.size <= 0) break;
      if (active.has(candidate.dispatch_id)) continue;
      if (activeRecipes.has(recipeKey(candidate))) continue;
      let claim: WebhookDispatchClaim | null;
      let event: ReturnType<typeof deliveryStore.getEvent>;
      let delivery: ReturnType<typeof deliveryStore.getDelivery>;
      // One row that cannot be read or claimed (corrupt, or gone under a race)
      // is logged and passed over: it must not hold back the candidates after
      // it, on this pass or on every pass after.
      try {
        event = deliveryStore.getEvent(candidate.event_id);
        delivery = event === null ? null : deliveryStore.getDelivery(event.delivery_id);
        if (event === null || delivery === null) {
          if (consumerStore.cancelUnreadableDispatch(candidate.dispatch_id)) {
            options.log?.('error', 'webhook recipe dispatch cancelled: its event is gone', {
              code: 'dispatch_event_missing',
              dispatch_id: candidate.dispatch_id,
            });
          }
          continue;
        }
        claim = consumerStore.beginDispatch({
          dispatch_id: candidate.dispatch_id,
          event,
          delivery,
          lease_ms: leaseMs,
          max_attempts: maxAttempts,
        });
      } catch {
        if (!reportedClaimFailures.has(candidate.dispatch_id)
          && reportedClaimFailures.size < 1_000) {
          reportedClaimFailures.add(candidate.dispatch_id);
          options.log?.('error', 'webhook recipe dispatch could not be claimed', {
            code: 'dispatch_claim_failed',
            dispatch_id: candidate.dispatch_id,
          });
        }
        // Slice 10E — it waits out the retry schedule like a failed run, so
        // it stops heading its recipe's queue, and becomes a dead letter for
        // the owner at the attempt ceiling. Slice 10J — the schedule's step for
        // the attempt this failure spends, as for a failed run (it waited the
        // first step every time, and dead-lettered about 3.5 minutes in).
        try {
          const deferred = consumerStore.deferUnclaimableDispatch({
            dispatch_id: candidate.dispatch_id,
            retry_delay_ms: retryDelay(candidate.attempt_count + 1),
            max_attempts: maxAttempts,
          });
          if (deferred === 'dead_letter') result.dead_lettered += 1;
        } catch {
          // Unreadable even for that: the next pass offers it again.
        }
        continue;
      }
      if (claim === null) continue;
      result.claimed += 1;
      const settledClaim = claim;
      const key = recipeKey(settledClaim);
      activeClaims.set(settledClaim.dispatch_id, {
        claim_token: settledClaim.claim_token,
        recipe: key,
      });
      activeRecipes.add(key);
      const run: Promise<boolean> = runClaim(settledClaim, { event, delivery }).then((refused) => {
        if (active.get(settledClaim.dispatch_id) === run) {
          active.delete(settledClaim.dispatch_id);
          activeClaims.delete(settledClaim.dispatch_id);
          activeRecipes.delete(key);
        }
        onSettled(refused);
        return refused;
      });
      active.set(settledClaim.dispatch_id, run);
      startedRuns.push(run);
    }
    return startedRuns;
  };

  /** Background passes (the poll, a kick, a run settling). Single-flight; a
   *  request during a pass runs one more pass after it. */
  const schedulePass = (reconcile: boolean): void => {
    if (!started || !accepting) return;
    if (passInFlight) {
      passAgain = true;
      return;
    }
    const pass = async (): Promise<void> => {
      if (reconcile && !stopping()) {
        try {
          options.onPoll?.();
        } catch {
          options.log?.('error', 'webhook recipe dispatch upkeep failed', {
            code: 'dispatch_upkeep_failed',
          });
        }
        await options.reconcileWaitingDispatches?.();
      }
      // A run settling may free its recipe's next delivery: look again. Not
      // after a refusal (the server is restarting or paused): the next poll
      // looks, by when the gate knows, instead of reclaiming at once.
      claimAndStart((refused) => {
        if (!refused) schedulePass(false);
      });
    };
    passInFlight = pass()
      .catch(() => {
        options.log?.('error', 'webhook recipe dispatch pass failed', {
          code: 'dispatch_pass_failed',
        });
      })
      .finally(() => {
        passInFlight = null;
        if (passAgain) {
          passAgain = false;
          schedulePass(false);
        }
      });
  };

  return {
    start() {
      if (started || !accepting) return;
      started = true;
      timer = setInterval(() => schedulePass(true), pollIntervalMs);
      timer.unref?.();
      schedulePass(true);
    },
    stop() {
      if (stopPromise) return stopPromise;
      accepting = false;
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      // Nothing more is claimed; what runs now is all there is. Those are
      // in-process recipe runs the restart drain kills, so they get the grace
      // and no more (the outbox's stop has the same shape).
      stopPromise = settleWithin(
        Promise.allSettled([...(passInFlight ? [passInFlight] : []), ...active.values()]),
        STOP_GRACE_MS,
      ).then(() => undefined);
      return stopPromise;
    },
    isStarted: () => started,
    kick() {
      schedulePass(false);
    },
    noteServerStopping() {
      let marked = 0;
      if (activeClaims.size > 0) {
        try {
          marked += consumerStore.markInterruptedByRestart(
            [...activeClaims].map(([dispatch_id, { claim_token }]) => ({ dispatch_id, claim_token })),
          );
        } catch {
          options.log?.('error', 'webhook recipe dispatch could not mark its runs for the restart', {
            code: 'dispatch_restart_mark_failed',
          });
        }
      }
      // D-201 Slice 10J — a held delivery whose run is going is one the owner
      // approved, resuming outside this worker. Its record will say `killed`
      // if the drain stops it, as the owner's Stop does: mark it now.
      const isRunActive = options.isRunActive;
      if (isRunActive !== undefined) {
        try {
          const resuming = consumerStore.listAwaitingApprovalDispatches().filter((held) => {
            try {
              return isRunActive(held.run_id);
            } catch {
              return false;
            }
          });
          if (resuming.length > 0) {
            marked += consumerStore.markResumesInterruptedByRestart(resuming);
          }
        } catch {
          options.log?.('error', 'webhook recipe dispatch could not mark approved runs for the restart', {
            code: 'dispatch_restart_mark_failed',
          });
        }
      }
      return marked;
    },
    totals: () => ({ ...result }),
    async drain() {
      const before = { ...result };
      if (!accepting) return emptyResult();
      if (passInFlight) await passInFlight;
      if (!stopping()) await options.reconcileWaitingDispatches?.();
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
        const released = result.released;
        const startedRuns = claimAndStart(() => undefined);
        // A run a background pass started is waited for too: a recipe's next
        // delivery becomes runnable when its previous one settles.
        const going = [...active.values()];
        if (startedRuns.length === 0 && going.length === 0) break;
        await Promise.allSettled(going);
        // The server refused a run (restarting or paused): what was handed
        // back waits for a later drain.
        if (result.released > released) break;
      }
      return resultSince(result, before);
    },
  };
};

export interface WebhookRecipeDeliveryRuntimeDeps {
  deliveryStore: WebhookDeliveryStore;
  consumerStore: WebhookConsumerStore;
  runner: WebhookRecipeRunner;
}

export interface WebhookRecipeDeliveryRuntimeOptions {
  canDispatch?: () => boolean;
  isStopping?: () => boolean;
  /** D-201 Slice 10J — the worker's `isRunActive`. */
  isRunActive?: (runId: string) => boolean;
  reconcileWaitingDispatches?: () => Promise<void>;
  /** Run on the worker's poll (the dead-letter review limit). */
  onPoll?: () => void;
  log?: Log;
  outbox?: Omit<
    WebhookOutboxRuntimeOptions,
    'canDispatch' | 'isStopping' | 'log' | 'reconcileWaitingDispatches'
  >;
  worker?: Omit<
    WebhookRecipeDispatchWorkerOptions,
    'canDispatch' | 'isStopping' | 'log' | 'reconcileWaitingDispatches' | 'onPoll' | 'isRunActive'
  >;
}

export interface WebhookRecipeDeliveryRuntime {
  /** Starts the worker, then the outbox, so handed-off work has a taker. */
  start(): void;
  /** Stops the outbox (no new handoff), then the worker. */
  stop(): Promise<void>;
  /** Both halves running: what the listener requires before exposing a route. */
  isStarted(): boolean;
  /** One outbox pass (hand the claimed events off), then the worker's drain. */
  drainOnce(): Promise<WebhookRecipeDispatchResult & { handed_off: number }>;
  readonly outbox: WebhookOutboxRuntime;
  readonly worker: WebhookRecipeDispatchRuntime;
}

/** D-201 Slice 10A — the production webhook recipe path: the event outbox
 *  hands each event off to its targets, and the worker runs them. */
export const createWebhookRecipeDeliveryRuntime = (
  deps: WebhookRecipeDeliveryRuntimeDeps,
  options: WebhookRecipeDeliveryRuntimeOptions = {},
): WebhookRecipeDeliveryRuntime => {
  const shared = {
    ...(options.canDispatch ? { canDispatch: options.canDispatch } : {}),
    ...(options.isStopping ? { isStopping: options.isStopping } : {}),
  };
  const worker = createWebhookRecipeDispatchRuntime(
    {
      consumerStore: deps.consumerStore,
      deliveryStore: deps.deliveryStore,
      runner: deps.runner,
    },
    {
      ...options.worker,
      ...shared,
      ...(options.reconcileWaitingDispatches
        ? { reconcileWaitingDispatches: options.reconcileWaitingDispatches }
        : {}),
      ...(options.isRunActive ? { isRunActive: options.isRunActive } : {}),
      ...(options.onPoll ? { onPoll: options.onPoll } : {}),
      ...(options.log ? { log: options.log } : {}),
    },
  );
  const outbox = createWebhookOutboxRuntime(
    deps.deliveryStore,
    createWebhookRecipeOutboxSink(deps.consumerStore),
    {
      ...options.outbox,
      ...shared,
      ...(options.log ? { log: options.log } : {}),
      // The handed-off targets become runnable once the row is marked.
      onDispatched: () => worker.kick(),
    },
  );
  return {
    start() {
      worker.start();
      outbox.start();
    },
    async stop() {
      await outbox.stop();
      await worker.stop();
    },
    isStarted: () => outbox.isStarted() && worker.isStarted(),
    async drainOnce() {
      // From before the outbox pass: its handoff wakes the worker, whose runs
      // may start before the drain below does.
      const before = worker.totals();
      const handed = await outbox.drainOnce();
      await worker.drain();
      return { ...resultSince(worker.totals(), before), handed_off: handed.dispatched };
    },
    outbox,
    worker,
  };
};
