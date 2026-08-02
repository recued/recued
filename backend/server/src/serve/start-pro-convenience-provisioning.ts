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
