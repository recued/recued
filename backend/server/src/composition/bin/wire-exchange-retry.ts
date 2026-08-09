/** D-232 § 24 — the retry actuator.
 *
 *  ⛔⛔ THIS IS THE ONLY PART OF THE EXCHANGE FEATURE THAT CAN CAUSE HARM BY
 *  WORKING. Everything else reports; this ACTS, and the act is "send it again".
 *  So it is deliberately thin: the DECISION lives entirely in
 *  `planExchangeRetry` (pure, in contracts, with its four refusals and their
 *  reasons), and this file only finds candidates and dispatches the ones the
 *  planner admits. A policy question that gets answered here instead of there is
 *  a policy question with no tests.
 *
 *  🔑 THE AUDIT LOG IS THE OUTBOX. There is no retry queue, no attempt counter,
 *  no next-attempt column — every attempt is ALREADY a carrier run filed under
 *  the exchange ref, carrying its own args in `config_snapshot`. So attempts are
 *  counted from the trail, the payload to re-send is the one that failed, and
 *  the idempotency key (`exchange_ref`) is on every attempt by construction.
 *  A separate outbox would be a second record that can drift from the runs it
 *  claims to describe — the same reason § 23 derives status rather than storing
 *  it.
 *
 *  ⚠ WHY IT IS DRIVEN BY HEALTH RECOVERY RATHER THAN A BARE TIMER. § 22 made
 *  connection health real, so this can ask "is the peer back?" instead of
 *  knocking to find out. A timer alone would re-send into a connection already
 *  known to be down, which is the hammering the backoff exists to prevent.
 */

import {
  planExchangeRetry,
  effectiveConnectionHealth,
  type ConnectionHealth,
  type ExchangeRetryRow,
} from '@recued/contracts';

export interface ExchangeRetryDeps {
  readonly registry: {
    registerInterval: (spec: {
      name: string;
      intervalMs: number;
      tick: () => Promise<void> | void;
      fireImmediate?: boolean;
      onStop?: () => void;
    }) => () => void;
  };
  /** Refs with an undeliverable latest attempt, newest first. */
  readonly pendingRefs: () => Promise<ReadonlyArray<string>>;
  readonly rowsForRef: (ref: string) => Promise<ReadonlyArray<ExchangeRetryRow>>;
  /** The callback op the exchange named, for the answered check. */
  readonly callbackForRef: (ref: string) => string | undefined;
  /** Connection health for the peer an attempt was addressed to. */
  readonly healthForRef: (ref: string) => ConnectionHealth | undefined;
  readonly classify: (errors: readonly unknown[]) => { kind: never; reason: string };
  /** Re-send. Returns nothing; the resulting run files itself under the ref. */
  readonly resend: (ref: string, args: Record<string, unknown>) => Promise<void>;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly log?: (line: string) => void;
}

export const EXCHANGE_RETRY_INTERVAL_MS = 60_000;

export const composeExchangeRetry = (deps: ExchangeRetryDeps): void => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  // ⛔ NOT REENTRANT. A tick can take as long as the peers it dispatches to, and
  // `runTick` does not serialize — a second pass while the first is mid-resend
  // would send the same ref twice, which is the one outcome retry must never
  // produce. Same hazard `composeProCertEnrollment` documents for issuance.
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      for (const ref of await deps.pendingRefs()) {
        // ⚠ HEALTH FIRST, and it is a REAL question now (§ 22). Re-sending into
        // a connection known to be unreachable is the hammering the backoff
        // exists to prevent; waiting for recovery is both kinder to the peer and
        // far more likely to succeed.
        const health = deps.healthForRef(ref);
        if (health !== undefined && effectiveConnectionHealth(health, now()) === 'unreachable') {
          continue;
        }
        const plan = planExchangeRetry(
          ref,
          await deps.rowsForRef(ref),
          deps.callbackForRef(ref),
          deps.classify as never,
          now(),
        );
        if (!plan.retry) continue;
        log(`[exchange-retry] re-sending ${ref.slice(0, 12)}… attempt ${String(plan.attempt)}`);
        try {
          await deps.resend(ref, plan.args);
        } catch (e) {
          // ⛔ ONE REF'S FAILURE MUST NOT STOP THE SWEEP. The next ref is a
          // different peer; a dead one must not strand everyone behind it.
          log(`[exchange-retry] ${ref.slice(0, 12)}… resend failed: ${(e as Error).message}`);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  deps.registry.registerInterval({
    name: 'exchange-retry',
    intervalMs: deps.intervalMs ?? EXCHANGE_RETRY_INTERVAL_MS,
    tick,
    // ⚠ NOT immediate. Every candidate is by definition already inside a
    // backoff window at boot, so an immediate fire can only re-read what it
    // cannot yet act on — and a server that restarts in a loop would turn that
    // into a burst against a peer that is already struggling.
    fireImmediate: false,
  });
};
