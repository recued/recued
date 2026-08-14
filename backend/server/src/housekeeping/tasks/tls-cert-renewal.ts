/** D-148 § A.6.5 — `tls-cert-renewal` housekeeping task.
 *
 *  Lifecycle scheduler hook for scheduled TLS cert auto-renewal. The
 *  task consults the `CertSource` for the current cert, and
 *  when the cert is within `RENEWAL_THRESHOLD_MS` of its `valid_until`
 *  timestamp, calls `engine.renewTls(...)` so the rotation engine
 *  emits a signed `cert_rotation_notice` ahead of the actual cert flip
 *  (default 7d lead per `DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS`).
 *
 *  Substrate-before-wiring. The task ships now; the production cert-
 *  source adapter + the `tls` slot on `RotationEngineOptions` land in
 *  follow-up slices. Until both are wired, the task registration in
 *  `bin.ts` is no-op'd (the gate requires both `rotationEngine` AND
 *  a cert source to be present), so the engine's `acme_helper_unavailable`
 *  return path is reachable only via the `tls.renew` rpc operator path.
 *
 *  Cooldown — TWO LAYERS, different jobs. Don't collapse them.
 *
 *    1. THIS cursor's `last_seen_at` + `RENEWAL_COOLDOWN_MS` guards against
 *       ATTEMPT THRASHING: transient engine errors (`acme_helper_unavailable`
 *       while the helper restarts, `storage_io_error` mid-disk-pressure)
 *       would otherwise emit one audit row per cycle. It is a pre-filter —
 *       it can only make this task call the engine LESS often.
 *    2. `RotationEngine`'s `tls_renew_cooldown` store guards ISSUANCE QUOTA
 *       and is the actual ENFORCEMENT point, because it is the layer the
 *       operator `tls.renew` rpc also passes through. Before it existed the
 *       Settings → Certificates "Renew now" button had no cooldown at all,
 *       so repeat clicks issued repeat certificates and could exhaust a CA's
 *       weekly duplicate-certificate allowance — after which THIS task's
 *       renewals failed too.
 *
 *  🔑 They cannot drift into disagreeing about whether a renewal is allowed:
 *  layer 1 only ever suppresses a call layer 2 would have judged anyway.
 *
 *  No retry-without-cooldown on `rotation_in_progress`. The engine's
 *  `inflightOp` guard returns `rotation_in_progress` only when another
 *  caller has a `tls_private_key` rotation actively executing —
 *  typically an operator-initiated `tls.renew` rpc. The auto-renewal
 *  task defers to that caller; advancing the cursor on this branch
 *  would race the operator's outcome into the next cycle's eligibility
 *  check. The cursor stays put so the task tries again next cycle, by
 *  which point the operator's call has either succeeded (cert
 *  `valid_until` advanced past the threshold → no-op) or returned an
 *  error the operator can act on (still in the renewal window →
 *  task tries again, subject to cooldown).
 *
 *  Cursor: `{ kind: 'time', last_seen_at }` where `last_seen_at` is
 *  the timestamp of the last attempt that consumed the cooldown
 *  (success OR a non-`rotation_in_progress` error). Initial cursor is
 *  `last_seen_at: 0` so the first cycle after boot always probes.
 *
 *  Codex P2 #1 fold — suppress retries during the staged notice window.
 *  `engine.renewTls(...)` schedules the cert flip at `rotated_at = now
 *  + DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS` (7d default). During that
 *  staged window the cert source still reports the OLD cert with the
 *  OLD `valid_until` (still inside the renewal threshold), so a 6h
 *  post-success cooldown would re-fire `renewTls()` every cycle until
 *  the flip happens — burning ACME quota + accumulating conflicting
 *  staged fingerprints. On success we therefore set `last_seen_at =
 *  result.rotated_at` instead of `now` so the cooldown gate naturally
 *  reads "wait until the flip happens, then start the normal cooldown"
 *  — the task resumes ~6h after the new cert becomes current, at which
 *  point the cert source reports the new cert + valid_until ~90d ahead
 *  and the threshold gate short-circuits to `complete`. Test paths
 *  pinning `rotation_at_offset_ms: 0` still work — `now -
 *  result.rotated_at` is ~0 → still inside cooldown for 6h, same as
 *  the error-path semantics.
 *
 *  No `onInvalidate` — TLS cert state is read fresh per cycle from the
 *  cert source; nothing in the cascade engine causes an earlier cursor
 *  position to become stale.
 *
 *  Spec: D-148 § A.6.5. */

import type {
  HousekeepingCursor,
  HousekeepingStepResult,
} from '@recued/contracts';

import type { CertSource } from '../../pairing/cert-source.js';
import type { RotationEngine } from '../../keys/rotation/index.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

/** Cert is "in the renewal window" when `valid_until - now` is at or
 *  below this threshold. 30 days matches the standard ACME renewal
 *  cadence for 90-day certs (renew at 1/3 of validity remaining).
 *  Production callers can override via the factory `threshold_ms` if
 *  the underlying issuer ships shorter-lived certs. */
export const RENEWAL_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum interval between auto-renewal attempts. Even when the cert
 *  is in the renewal window, the task waits this long between calls to
 *  `engine.renewTls(...)` so transient errors (helper restart, disk
 *  pressure) don't accumulate one audit row per cycle. 6 hours is
 *  short enough that a missed window still gets retried multiple times
 *  in a 30-day threshold, long enough that a stuck helper produces a
 *  human-readable cadence. */
export const RENEWAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Sentinel `triggered_by_client_id` for audit rows the auto-renewal
 *  task emits via the rotation engine. Lets Settings → Key Health
 *  filter operator-initiated (`tls.renew` rpc) vs scheduler-initiated
 *  rotations without parsing free-form `reason` strings. */
export const TLS_AUTO_RENEW_TRIGGER_ID = 'system:tls-auto-renew';

export interface TlsCertRenewalTaskDeps {
  engine: RotationEngine;
  certSource: CertSource;
  /** Override the renewal-window threshold. Defaults to
   *  `RENEWAL_THRESHOLD_MS` (30 days). */
  threshold_ms?: number;
  /** Override the per-attempt cooldown. Defaults to
   *  `RENEWAL_COOLDOWN_MS` (6 hours). */
  cooldown_ms?: number;
}

const cursorLastSeenAt = (cursor: HousekeepingCursor): number =>
  cursor.kind === 'time' ? cursor.last_seen_at : 0;

export const buildTlsCertRenewalTask = (
  deps: TlsCertRenewalTaskDeps,
): HousekeepingTaskInstance => {
  const threshold_ms = deps.threshold_ms ?? RENEWAL_THRESHOLD_MS;
  const cooldown_ms = deps.cooldown_ms ?? RENEWAL_COOLDOWN_MS;

  return {
    meta: {
      id: 'tls-cert-renewal',
      description:
        'Auto-renew the server TLS cert via the rotation engine when valid_until is within 30 days.',
      interruptible: true,
      kind: 'core',
      tags: ['kind:core', 'domain:tls', 'surface:deterministic'],
    },

    async step(
      ctx: HousekeepingContext,
      cursor: HousekeepingCursor,
      _budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      const now = ctx.now();
      const last_attempt_at = cursorLastSeenAt(cursor);

      if (last_attempt_at > 0 && now - last_attempt_at < cooldown_ms) {
        return { status: 'complete', cursor };
      }

      const cert = deps.certSource.getCurrentCert();
      if (cert === null) {
        return { status: 'complete', cursor };
      }

      if (cert.valid_until - now > threshold_ms) {
        return { status: 'complete', cursor };
      }

      const result = await deps.engine.renewTls({
        triggered_by_client_id: TLS_AUTO_RENEW_TRIGGER_ID,
        reason: `auto-renew (cert valid_until=${cert.valid_until})`,
      });

      // ⛔ TWO NON-CONSUMING OUTCOMES, for the same reason: neither reached
      //    the CA, so neither is an attempt this task should record.
      //
      //    `rotation_in_progress` — another caller is executing right now.
      //    `renew_cooldown` — the engine's SHARED clock says the last
      //    quota-consuming renewal is still inside its window. That clock now
      //    covers the operator `tls.renew` rpc too (Settings → Server →
      //    Certificates → "Renew now"), which is the point: a manual renew
      //    defers this task, and a scheduled one defers the button. Advancing
      //    the cursor here would stack this task's own 6h on top of the
      //    engine's, so a manual renew would silently cost the scheduler an
      //    extra cycle it never spent.
      if (
        !result.ok
        && (result.error === 'rotation_in_progress' || result.error === 'renew_cooldown')
      ) {
        return { status: 'complete', cursor };
      }

      ctx.emitAuditRow({
        ts: now,
        event_at: now,
        action: 'tls_auto_renew_attempted',
        target: 'tls_private_key',
        run_mode: 'live',
        detail: result.ok
          ? {
              ok: true,
              new_fingerprint: result.new_fingerprint,
              rotated_at: result.rotated_at,
              cert_valid_until: cert.valid_until,
            }
          : {
              ok: false,
              error: result.error,
              cert_valid_until: cert.valid_until,
            },
      });

      // Codex P2 #1 fold — on success, anchor the cooldown to the
      // staged `rotated_at` so we don't re-fire `renewTls()` every
      // cycle while the new cert is still scheduled-but-not-active.
      // On non-`rotation_in_progress` errors, anchor to `now` for the
      // standard 6h backoff.
      const last_seen_at = result.ok ? result.rotated_at : now;
      return {
        status: 'complete',
        cursor: { kind: 'time', last_seen_at },
      };
    },
  };
};
