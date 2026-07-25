/** D-201 Slice 2 — leased at-least-once webhook event outbox dispatcher.
 *
 * The sink contract is idempotent on `idempotency_key === event.event_id`.
 * A crash after the sink side effect but before `markOutboxDispatched` therefore
 * causes a safe replay after lease expiry instead of losing accepted work.
 */

import type {
  WebhookDeliveryStore,
  WebhookOutboxClaim,
} from './storage/webhook-delivery-store.js';

export interface WebhookOutboxDispatchInput {
  idempotency_key: string;
  event: WebhookOutboxClaim['event'];
  delivery: WebhookOutboxClaim['delivery'];
}

export interface WebhookEventOutboxSink {
  /** Must collapse repeated calls carrying the same idempotency_key. */
  dispatch(input: WebhookOutboxDispatchInput): Promise<void>;
}

export interface WebhookOutboxDispatcherOptions {
  batch_size?: number;
  lease_ms?: number;
  dispatch_timeout_ms?: number;
  max_attempts?: number;
  base_retry_ms?: number;
  max_retry_ms?: number;
  log?: (
    level: 'warn' | 'error',
    message: string,
    metadata: Readonly<Record<string, string | number>>,
  ) => void;
}

export interface WebhookOutboxDispatchResult {
  claimed: number;
  dispatched: number;
  retried: number;
  dead_lettered: number;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 15 * 60 * 1_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('webhook outbox dispatch timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const retryDelayFor = (
  attemptCount: number,
  baseRetryMs: number,
  maxRetryMs: number,
): number => Math.min(
  maxRetryMs,
  baseRetryMs * (2 ** Math.min(20, Math.max(0, attemptCount - 1))),
);

export const dispatchWebhookOutboxOnce = async (
  store: WebhookDeliveryStore,
  sink: WebhookEventOutboxSink,
  options: WebhookOutboxDispatcherOptions = {},
): Promise<WebhookOutboxDispatchResult> => {
  const batchSize = options.batch_size ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.lease_ms ?? DEFAULT_LEASE_MS;
  const timeoutMs = options.dispatch_timeout_ms ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const maxAttempts = options.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseRetryMs = options.base_retry_ms ?? DEFAULT_BASE_RETRY_MS;
  const maxRetryMs = options.max_retry_ms ?? DEFAULT_MAX_RETRY_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('webhook outbox: batch_size must be in 1..100');
  }
  if (!Number.isSafeInteger(leaseMs)
    || leaseMs < 1_000
    || leaseMs > 15 * 60 * 1_000) {
    throw new Error('webhook outbox: lease_ms must be in 1000..900000');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > leaseMs) {
    throw new Error('webhook outbox: dispatch_timeout_ms must be in 1..lease_ms');
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('webhook outbox: max_attempts must be in 1..100');
  }
  if (!Number.isSafeInteger(baseRetryMs) || baseRetryMs < 0
    || !Number.isSafeInteger(maxRetryMs) || maxRetryMs < baseRetryMs
    || maxRetryMs > 24 * 60 * 60 * 1_000) {
    throw new Error('webhook outbox: retry bounds are invalid');
  }
  const exhaustedClaims = store.deadLetterExhaustedOutbox({
    max_attempts: maxAttempts,
  });
  const claims = store.claimOutbox({
    limit: batchSize,
    lease_ms: leaseMs,
    max_attempts: maxAttempts,
  });
  const result: WebhookOutboxDispatchResult = {
    claimed: claims.length,
    dispatched: 0,
    retried: 0,
    dead_lettered: exhaustedClaims,
  };

  for (const claim of claims) {
    try {
      await withTimeout(sink.dispatch({
        idempotency_key: claim.event.event_id,
        event: claim.event,
        delivery: claim.delivery,
      }), timeoutMs);
      store.markOutboxDispatched(claim.outbox_id, claim.claim_token);
      result.dispatched += 1;
    } catch {
      try {
        const state = store.markOutboxFailed({
          outbox_id: claim.outbox_id,
          claim_token: claim.claim_token,
          error_code: 'dispatch_failed',
          retry_delay_ms: retryDelayFor(
            claim.attempt_count,
            baseRetryMs,
            maxRetryMs,
          ),
          max_attempts: maxAttempts,
        });
        if (state === 'dead_letter') result.dead_lettered += 1;
        else result.retried += 1;
      } catch {
        // A newer worker may have reclaimed the expired lease. Never let this
        // stale worker overwrite that claim or persist an exception string.
        options.log?.('warn', 'webhook outbox claim lost after dispatch failure', {
          outbox_id: claim.outbox_id,
          event_id: claim.event.event_id,
        });
      }
    }
  }
  return result;
};

export interface WebhookOutboxRuntime {
  start(): void;
  /** Stop polling and wait for the active pass to settle before its stores are
   * closed. Dispatch failures remain owned by the pass/caller. */
  stop(): Promise<void>;
  isStarted(): boolean;
  drainOnce(): Promise<WebhookOutboxDispatchResult>;
}

export interface WebhookOutboxRuntimeOptions extends WebhookOutboxDispatcherOptions {
  poll_interval_ms?: number;
  /** Reconcile already-handed-off owner approvals before considering whether
   * new autonomous work may be claimed. This maintenance pass must not mint or
   * resume runs; it only folds terminal run anchors into existing targets. */
  reconcileWaitingDispatches?: () => Promise<void>;
  /** Live autonomous-execution gate. A paused or vault-locked server returns an
   * empty pass without claiming work, so a long pause cannot burn retry counts. */
  canDispatch?: () => boolean;
}

/** The listener checks `isStarted()` before exposing any profile route. */
export const createWebhookOutboxRuntime = (
  store: WebhookDeliveryStore,
  sink: WebhookEventOutboxSink,
  options: WebhookOutboxRuntimeOptions = {},
): WebhookOutboxRuntime => {
  const pollIntervalMs = options.poll_interval_ms ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs)
    || pollIntervalMs < 100
    || pollIntervalMs > 60_000) {
    throw new Error('webhook outbox runtime: poll_interval_ms must be in 100..60000');
  }
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<WebhookOutboxDispatchResult> | null = null;

  const emptyResult = (): WebhookOutboxDispatchResult => ({
    claimed: 0,
    dispatched: 0,
    retried: 0,
    dead_lettered: 0,
  });

  const runPass = async (): Promise<WebhookOutboxDispatchResult> => {
    await options.reconcileWaitingDispatches?.();
    try {
      if (options.canDispatch && !options.canDispatch()) return emptyResult();
    } catch {
      options.log?.('warn', 'webhook outbox dispatch gate unavailable', {
        code: 'dispatch_gate_unavailable',
      });
      return emptyResult();
    }
    return dispatchWebhookOutboxOnce(store, sink, options);
  };

  const drainOnce = (): Promise<WebhookOutboxDispatchResult> => {
    if (inFlight) return inFlight;
    inFlight = runPass()
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    start() {
      if (started) return;
      started = true;
      timer = setInterval(() => {
        void drainOnce().catch(() => {
          options.log?.('error', 'webhook outbox polling pass failed', {
            code: 'outbox_poll_failed',
          });
        });
      }, pollIntervalMs);
      timer.unref?.();
    },
    async stop() {
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      const activePass = inFlight;
      if (activePass) {
        try {
          await activePass;
        } catch {
          // The polling callback or explicit drain caller owns reporting the
          // failed pass; shutdown only guarantees that it has settled.
        }
      }
    },
    isStarted: () => started,
    drainOnce,
  };
};
