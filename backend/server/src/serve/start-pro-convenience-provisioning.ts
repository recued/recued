/** D-175 — Pro-convenience handle provisioning starter.
 *
 *  Registers the background tick that reserves the bound account's
 *  `<handle>.recued.cloud` handle with `publisher_id = serverIdentity()
 *  .public_key_fingerprint` once the bind → subscribe chain completes.
 *  Mirrors `start-ddns-update-poller.ts`: a `kind: 'timer'` service on
 *  the shared registry, `fireImmediate` so a restart provisions on boot,
 *  and idempotent (a no-op once the handle is reserved) so it safely
 *  retries every cadence until the cloud `subscription_active` gate opens
 *  — no restart needed when the user binds + subscribes mid-session.
 *
 *  It reserves through the cert-stack's OWN handle state machine (via
 *  `getHandleStateMachineRef`) rather than a fresh instance, so the
 *  machine's `onStateChanged` listener fires and updates the cert-stack
 *  `publisherIdSnapshot` — the value the ACME renewer's
 *  `resolvePublisherId` returns — without waiting for the next boot's
 *  `current()` re-seed. Absent prerequisites (no booted identity, the
 *  handle machine / entitlement source not composed — i.e. dbless or
 *  daemon-only) leave each tick a clean no-op.
 */

import { DDNS_UPDATE_INTERVAL_MS } from '@recued/contracts';

import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import type { CertStack } from '../composition/bin/wire-cert-stack.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import { provisionHandleFromBinding } from '../pro-convenience/handle-provisioner.js';

export interface StartProConvenienceProvisioningOptions {
  /** D-175 — reports a confirmed disconnection to the shared announcer. */
  readonly announceDisconnect?: (source: 'entitlement_mint') => Promise<boolean> | boolean;
  /** D-175 — clears the announcement once the cloud confirms ownership again. */
  readonly rearmDisconnect?: () => void;
  /** D-175 — shared disowned state; this loop is the only thing that can SEE a
   *  reconnection, so it is the only thing that can clear the DDNS stand-down. */
  readonly disownedFlag?:
    import('../pro-convenience/disconnect-announcer.js').ServerDisownedFlag;
  backgroundServices: BackgroundServiceRegistry;
  /** The composed cert stack — supplies the handle state machine + the
   *  binding-entitlement source. Both resolve `undefined` until
   *  `composeLate` has run, so the caller must invoke this AFTER
   *  `composeCertStackLate`. */
  certStack: Pick<
    CertStack,
    'getHandleStateMachineRef' | 'getBindingEntitlementSource'
  >;
  getSigningIdentity: () => BootedServerIdentity | undefined;
  /** Polling cadence. Defaults to `DDNS_UPDATE_INTERVAL_MS` (5 min). */
  intervalMs?: number;
}

export const startProConvenienceProvisioning = (
  options: StartProConvenienceProvisioningOptions,
): void => {
  // Resolve the stable substrate refs up front. A daemon-only / dbless
  // server (or one whose identity never booted) composed neither the
  // handle state machine nor the entitlement source — there is nothing to
  // provision, so skip registration entirely (mirrors
  // `start-ddns-update-poller`'s `db`/identity gate, so a minimal harness
  // needn't stub the background-service registry).
  const handle = options.certStack.getHandleStateMachineRef();
  const entitlement = options.certStack.getBindingEntitlementSource();
  if (!options.getSigningIdentity() || !handle || !entitlement) return;

  // Last reason emitted, so a steady state (e.g. `unbound` on every free
  // server) logs once rather than every cadence.
  //
  // ⛔ CLEARED BY ANY NON-SKIP TICK, and leaving it set was a silent hole in
  // exactly the signal this exists to give. The suppression is for a STEADY
  // state; once a tick gets past every gate — reserved, corrected, or even a
  // cloud `reserve_failed` — the steady state is over, and the SAME reason
  // coming back later is news, not a repeat. Without the reset, a server that
  // provisions, then loses the cloud, logs `entitlement_unavailable` exactly
  // once ever and then goes quiet — the "indistinguishable from healthy" state
  // the comment below records as having cost a live drive hours.
  let lastSkipReason: string | undefined;

  const tick = async (): Promise<void> => {
    // Re-read the identity each tick so an unbind / rotation mid-life is
    // observed; the handle machine + entitlement source are stable refs.
    const identity = options.getSigningIdentity();
    if (!identity) return;

    try {
      const outcome = await provisionHandleFromBinding({
        serverFingerprint: () =>
          identity.identity.serverIdentityKey().public_key_fingerprint,
        loadBinding: () => identity.keyStore.loadAccountBinding(),
        entitlement,
        handle,
      });
      if (outcome.outcome !== 'skipped') lastSkipReason = undefined;

      // D-175 — the SECOND disconnect detector, and the one that still runs when
      // the owner has paused DDNS (the poller skips those ticks entirely, so it
      // would never notice). Both report to the same announcer, which owns the
      // once-only rule — see its header.
      //
      // ⚠ `entitlement_disowned` ONLY. Every other skip reason is transient or
      // ordinary (`unbound` is the steady state of every Free server), and the
      // cloud reaches this one only after verifying our credential, so it is the
      // one skip that means something terminal happened to this machine.
      if (outcome.outcome === 'skipped' && outcome.reason === 'entitlement_disowned') {
        options.disownedFlag?.markDisowned();
        try {
          await options.announceDisconnect?.('entitlement_mint');
        } catch {
          /* announcing must never break the loop */
        }
      } else if (
        outcome.outcome === 'reserved'
        || outcome.outcome === 'corrected'
        // ⚠ AND THE STEADY STATE, **WHEN IT SAYS THE CLOUD CONFIRMED US**.
        // Excluding `already_reserved` outright fixed one bug and caused its
        // mirror: after a reconnection the local state is unchanged, so every
        // tick returns this outcome — and the mark never cleared, which would
        // have made the NEXT genuine disconnection silent. The outcome now
        // carries whether entitlement was confirmed, so the distinction is a
        // fact rather than a guess about which outcome implies what.
        || (outcome.outcome === 'already_reserved' && outcome.entitlement_confirmed)
      ) {
        // ⛔⛔ RE-ARM ONLY ON AN OUTCOME THAT REQUIRED AN ENTITLED RESOLUTION.
        // These two do: each drove a cloud call that the entitlement gate stands
        // in front of, so reaching them means the cloud confirmed ownership.
        //
        // ⛔ `already_reserved` WAS IN THIS LIST AND DOES NOT BELONG. It is the
        // steady-state fast path, and it returns WITHOUT consulting entitlement —
        // it proves local state matches the binding, nothing more. Reading it as
        // "the cloud confirmed us" re-armed the announcement on a disowned
        // server, which is how one disconnection becomes a notification per
        // restart: the mark cleared, the other detector announced again.
        options.rearmDisconnect?.();
        // The DDNS poller cannot learn this on its own — it has stopped asking.
        options.disownedFlag?.markConnected();
      }
      if (outcome.outcome === 'reserve_failed') {
        // A cloud rejection (e.g. `handle_subscription_lapsed` before the
        // subscription activates, a transient network error, or — on a
        // rotation re-anchor — a `handle_taken` while the old reservation
        // is still stranded cloud-side). Log + let the next tick retry;
        // the IP/cert pollers take over once the reservation lands.
        console.warn(
          `[pro-convenience-provision] reserve rejected: ${outcome.reason}`,
          outcome.message ? `(${outcome.message})` : '',
        );
      } else if (outcome.outcome === 'skipped') {
        // Every skip reason was previously SILENT, which makes a
        // non-provisioning Pro server indistinguishable from a healthy one:
        // no handle reserved, no DDNS published, no error, nothing to grep.
        // A live drive spent hours unable to tell "the tick never registered"
        // from "it ran and skipped" — and `entitlement_unavailable` (the
        // shape a mis-pointed `cloud.base_url` produces) looked identical to
        // a broken provisioner. The reason is already computed; not emitting
        // it was the whole cost.
        //
        // `unbound` is the steady state for every FREE server, so it would be
        // per-tick noise forever — log each reason ONCE per process, and let
        // a changed reason speak again.
        if (lastSkipReason !== outcome.reason) {
          lastSkipReason = outcome.reason;
          console.info(
            `[pro-convenience-provision] skipped: ${outcome.reason}` +
              ` (repeats suppressed until the reason changes)`,
          );
        }
      } else if (outcome.outcome === 'corrected') {
        // A stale persisted handle state self-healed — a rebind
        // (`via: 'change'`) or a `server_identity_key` rotation
        // (`via: 're_reserve'`). Notable + rare; the `onStateChanged`
        // listener has already refreshed the cert-stack publisher_id /
        // DDNS-host snapshots for the IP + ACME pollers.
        console.info(
          `[pro-convenience-provision] stale handle state corrected via ${outcome.via}` +
            ` → ${outcome.handle} (publisher_id ${outcome.publisher_id})`,
        );
      }
    } catch (err) {
      // A thrown tick would bubble to setInterval's default handler as an
      // unhandled rejection. Swallow + retry next tick.
      console.warn('[pro-convenience-provision] tick failed', err);
    }
  };

  options.backgroundServices.registerInterval({
    name: 'pro-convenience-provision',
    intervalMs: options.intervalMs ?? DDNS_UPDATE_INTERVAL_MS,
    // Return the work so shutdown cannot close the binding/handle stores
    // underneath an in-progress reservation.
    tick,
    fireImmediate: true,
  });
};
