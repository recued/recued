/** Pro DDNS certificate ENROLLMENT — the background job the UX always assumed
 *  existed.
 *
 *  ⛔ THE GAP THIS CLOSES (measured 2026-08-06). A user signs up, connects their
 *  Recued account, and the server correctly reserves `<handle>.recued.net` and
 *  publishes its A record within seconds. Then nothing else happens — ever.
 *  Settings → Hostnames is EMPTY, and no certificate is ever ordered, because:
 *
 *    · the ONLY writers of a hostname registry row are the three user-facing
 *      `collection.hostname.{add,update,verifyOwnership}` rpcs — verified by
 *      sweeping every `.upsert(` call site server-wide; nothing creates one
 *      automatically;
 *    · first ACME issuance lives INSIDE `collection.hostname.add`, so it only
 *      runs if a paired client explicitly asks;
 *    · the `tls-cert-renewal` housekeeping task cannot help — it only RENEWS
 *      existing rows, and its hook returns `helper_unavailable` for exactly
 *      "a Pro DDNS handle whose ACME cert hasn't been provisioned yet".
 *
 *  So the stale window on enrollment was not the 6h renewal cooldown. It was
 *  UNBOUNDED: without a human opening Hostnames and adding the row by hand, a
 *  paid server never got a certificate at all. (This is also why the live drive
 *  had to pair a headless client and call `collection.hostname.add` itself — I
 *  first read that as "first issuance is user-initiated by design"; it is more
 *  accurate to say nothing initiates it.)
 *
 *  Policy this implements (owner, 2026-08-06): *honour and absorb all risks and
 *  failure; stale on expiring is fine, stale on enrollment and renewal should be
 *  minimised.* Renewal already honours it — a 30-day threshold against a 6h
 *  cooldown gives ~120 attempts. Enrollment had no runway at all, so the server
 *  now completes it in the background rather than leaving the cost with the user
 *  as a retry they must know to perform.
 *
 *  Two steps, both idempotent, so a partial failure resumes on the next tick:
 *    1. the handle is reserved but no registry row exists → create it. The row
 *       appearing IS the user-visible signal: Hostnames shows the host with no
 *       `cert_fingerprint`, which the UI renders as pending.
 *    2. a `recued_acme` row is verified with no `cert_fingerprint` → order the
 *       certificate and persist the result.
 *
 *  ⚠ Backoff is not optional here. CAs rate-limit FAILED validations (LE: 5 per
 *    account per hostname per hour), so retrying every 5 minutes would burn the
 *    limit and turn a transient DNS-propagation miss into a hard block. Starts
 *    at one interval and doubles to an hour — fast enough for the common
 *    transient case, slow enough to stay inside the limits.
 *
 *  ⚠ `ownership_status: 'verified'` is set without a challenge because Recued
 *    controls the zone: the handle reservation IS the proof, and there is no
 *    external party to verify against. This deliberately does NOT apply to BYO
 *    custom domains, which keep the `verifyOwnership` flow.
 */

import { hostnameForHandle } from '@recued/contracts';

import type { BackgroundServiceRegistry } from './wire-background-services.js';
import type { HandleStateStore } from '../../handle/index.js';
import type { HostnameRegistryStore } from '../../storage/hostname-registry.js';
import type { InitialAcmeDomainIssuer } from '../../keys/rotation/acme-domain-renewer.js';

/** Same cadence as the sibling DDNS + provisioning timers. */
export const PRO_CERT_ENROLLMENT_INTERVAL_MS = 5 * 60 * 1000;
/** First retry after a failed issuance; doubles from here. */
export const PRO_CERT_ENROLLMENT_BACKOFF_START_MS = 5 * 60 * 1000;
/** Ceiling, so a permanently-broken CA settles to hourly rather than hammering. */
export const PRO_CERT_ENROLLMENT_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Only an active reservation should carry a certificate. `grace` is excluded
 *  deliberately: the cloud has already pulled the DNS records for a lapsed
 *  subscription, so DNS-01 cannot validate and every attempt would burn CA
 *  quota to fail. */
const ENROLLABLE_SUBSCRIPTION_STATES = new Set(['active']);

export interface ProCertEnrollmentDeps {
  registry: BackgroundServiceRegistry;
  handleStateStore: HandleStateStore;
  hostnameRegistry: Pick<HostnameRegistryStore, 'get' | 'upsert'>;
  /** Resolved lazily — the cert stack fills its issuer ref in `composeLate`,
   *  which can land after this composer runs. Capturing the value here would
   *  pin `undefined` and silently disable enrollment with everything typed and
   *  green. */
  getInitialAcmeIssuer: () => InitialAcmeDomainIssuer | undefined;
  /** Stamped onto the row so it is attributable to this server identity. */
  serverIdentityId: () => string | undefined;
  /** ⛔ A SEALED SERVER MUST DO NOTHING. `fireImmediate` runs inside the boot
   *  path, which is before the operator has unlocked anything — the handle
   *  store is unreadable, the cert stack has no signing identity, and any work
   *  attempted here is wasted or wrong. Same predicate the cron, auto-run and
   *  housekeeping schedulers already gate on. Absent → treated as unlocked
   *  (db-less / test harnesses), matching that precedent. */
  isVaultUnlocked?: () => boolean;
  intervalMs?: number;
  now?: () => number;
}

export const composeProCertEnrollment = (deps: ProCertEnrollmentDeps): void => {
  const intervalMs = deps.intervalMs ?? PRO_CERT_ENROLLMENT_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  let retryAfter = 0;
  let backoffMs = 0;

  // ⛔ THE REGISTRY DOES NOT SERIALIZE TICKS. `wire-background-services.ts`
  //    `runTick` calls `spec.tick()` unconditionally — its `inFlight` set only
  //    exists to DRAIN on shutdown, not to skip a re-entry. An issuance here
  //    runs the cloud's 45s propagation hold plus up to its 150s budget plus CA
  //    time, which is close enough to the 5-minute interval to overlap, and a
  //    re-entrant tick would order a SECOND certificate for the same hostname.
  //    CAs rate-limit failed validations, so racing attempts can exhaust the
  //    limit and block both — the same defect just fixed in `hostname.add`.
  //    The backoff below cannot cover this: `retryAfter` is only set AFTER a
  //    failure returns, so a concurrent tick reads 0 and proceeds.
  let inFlight = false;
  let loggedIssuerWait = false;
  // ⛔ EVERY EARLY RETURN WAS SILENT, and a live run then showed a server doing
  //    NOTHING with no way to tell which gate stopped it — the same
  //    undiagnosable shape as the Pro provisioner before its skip logging.
  //    One line per DISTINCT reason per process: a boot legitimately hits
  //    several of these while substrate composes, so per-tick logging is noise,
  //    but never knowing which one is worse.
  let lastSkip = '';
  const skip = (reason: string): void => {
    if (lastSkip === reason) return;
    lastSkip = reason;
    console.info(`[pro-cert-enrollment] waiting: ${reason}`);
  };

  // ── precondition warm-up ────────────────────────────────────────────
  //
  // ⛔ SAME SHAPE AS THE DDNS POLLER'S FIRST-PUBLISH BUG. `fireImmediate` runs
  //    in the boot path, but the handle is reserved by a SIBLING timer whose
  //    HTTP round-trip lands ~26s later. So the one immediate fire is spent on
  //    a tick that cannot succeed, and without this the row would not appear —
  //    the only thing the user can see — until a full interval later.
  //
  // 🔑 The window starts at the first UNLOCKED observation, not at boot. Unlock
  //    is human-paced and unbounded (someone types a passphrase), so anchoring
  //    to boot would let the window expire while the server was still sealed
  //    and then make a just-unlocked server wait out the full interval.
  const WARMUP_INTERVAL_MS = 2_000;
  // Covers BOTH preconditions: the sibling provisioner's reserve (~26s) and
  // the cert stack's `composeLate` issuer fill.
  const WARMUP_WINDOW_MS = 120_000;
  let warmupDeadline: number | null = null;   // set on first unlocked tick
  let warmupTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearWarmup = (): void => {
    if (warmupTimer !== undefined) { clearTimeout(warmupTimer); warmupTimer = undefined; }
  };
  const scheduleWarmup = (): void => {
    if (stopped || warmupTimer !== undefined) return;
    if (warmupDeadline === null || now() >= warmupDeadline) return;
    warmupTimer = setTimeout(() => { warmupTimer = undefined; if (!stopped) void tick(); }, WARMUP_INTERVAL_MS);
    warmupTimer.unref?.();
  };

  const backOff = (): void => {
    backoffMs = backoffMs === 0
      ? PRO_CERT_ENROLLMENT_BACKOFF_START_MS
      : Math.min(backoffMs * 2, PRO_CERT_ENROLLMENT_BACKOFF_MAX_MS);
    retryAfter = now() + backoffMs;
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (now() < retryAfter) return;

      // A sealed server does nothing — and deliberately does NOT warm up, since
      // unlock is human-paced; the ordinary cadence picks it up.
      if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) { skip('vault sealed'); return; }
      // First unlocked observation opens the warm-up window (see above).
      if (warmupDeadline === null) warmupDeadline = now() + WARMUP_WINDOW_MS;

      const handleState = await deps.handleStateStore.load();
      // No handle YET is not "nothing to do" — the sibling provisioner is
      // mid-reserve. Re-tick soon rather than waiting a full interval.
      if (!handleState) { skip('no handle state yet'); scheduleWarmup(); return; }
      if (!ENROLLABLE_SUBSCRIPTION_STATES.has(handleState.subscription_state)) {
        skip(`subscription_state=${handleState.subscription_state}`); return;
      }
      const handle = handleState.current_handle;
      if (!handle || handle.length === 0) { skip('handle not reserved yet'); scheduleWarmup(); return; }
      clearWarmup();

      const serverIdentityId = deps.serverIdentityId();
      if (serverIdentityId === undefined || serverIdentityId.length === 0) { skip('no server identity id'); return; }

      const hostname = hostnameForHandle(handle);
      if (!hostname) return;

      // ── 1 · make the row exist ────────────────────────────────────────
      let row = deps.hostnameRegistry.get(hostname);
      if (!row) {
        deps.hostnameRegistry.upsert({
          server_identity_id: serverIdentityId,
          hostname,
          cert_source: 'recued_acme',
          // See the header: the reservation is the ownership proof for a
          // Recued-controlled zone. BYO domains keep `verifyOwnership`.
          ownership_status: 'verified',
          verified_at: now(),
          // ⚠ EXPLICIT, not derived. `ownership_status` is 'verified' the
          //   instant the row appears (the reservation is the proof), so the UI
          //   was showing "Verified" while there was no certificate at all. And
          //   a missing `cert_fingerprint` cannot distinguish "not tried yet"
          //   from "failed and backing off" — which is the difference a user
          //   waiting on their hostname actually cares about.
          cert_provisioning: 'pending',
          ddns_managed: true,
          enabled: true,
        });
        console.info(
          `[pro-cert-enrollment] registered ${hostname} — certificate pending`,
        );
        row = deps.hostnameRegistry.get(hostname);
        if (!row) return;
      }

      // ── 2 · order the certificate ─────────────────────────────────────
      if (row.cert_fingerprint !== undefined) { skip('already provisioned'); return; }
      if (row.cert_source !== 'recued_acme') { skip(`cert_source=${row.cert_source}`); return; }
      if (row.ownership_status !== 'verified') { skip(`ownership=${row.ownership_status}`); return; }

      const issuer = deps.getInitialAcmeIssuer();
      if (!issuer) {
        // ⛔ THE SAME DEFECT AS THE DDNS FIRST-PUBLISH BUG, ONE LAYER UP. The
        //    cert stack fills its issuer ref in `composeLate`, which lands
        //    AFTER this service's `fireImmediate` tick. So the immediate fire
        //    is spent on a tick that cannot succeed, and without a warm-up the
        //    first certificate waits a full 5-minute interval — on a brand-new
        //    Pro server, at the moment the user is watching Hostnames.
        //    Measured: an unlocked server logged NOTHING for the whole window.
        //
        // ⛔ And it returned SILENTLY, which is why that took a live run plus a
        //    log read to see — exactly the unlogged-skip pattern that made the
        //    Pro provisioner undiagnosable earlier. Log the reason ONCE per
        //    process (a fresh boot always hits this at least once, so
        //    per-tick logging would be pure noise).
        if (!loggedIssuerWait) {
          loggedIssuerWait = true;
          console.info(
            '[pro-cert-enrollment] ACME issuer not composed yet — warming up',
          );
        }
        scheduleWarmup();
        return;
      }

      const issued = await issuer.issueInitialDomain({ domain: hostname });
      if (!issued.ok) {
        backOff();
        deps.hostnameRegistry.upsert({
          hostname_id: row.hostname_id,
          server_identity_id: serverIdentityId,
          hostname,
          cert_source: 'recued_acme',
          ownership_status: 'verified',
          cert_provisioning: 'failed',
          cert_last_error: issued.reason,
          ddns_managed: true,
          enabled: true,
        });
        console.warn(
          `[pro-cert-enrollment] ${hostname}: ${issued.reason}`
            + ` — retrying in ${Math.round(backoffMs / 60_000)}min`,
        );
        return;
      }

      deps.hostnameRegistry.upsert({
        hostname_id: row.hostname_id,
        server_identity_id: serverIdentityId,
        hostname,
        cert_source: 'recued_acme',
        cert_fingerprint: issued.new_fingerprint,
        cert_expires_at: issued.cert_expires_at,
        ownership_status: 'verified',
        cert_provisioning: 'ready',
        ddns_managed: true,
        enabled: true,
      });
      backoffMs = 0;
      retryAfter = 0;
      console.info(
        `[pro-cert-enrollment] ${hostname} certificate ready`
          + ` (expires ${new Date(issued.cert_expires_at).toISOString().slice(0, 10)})`,
      );
    } catch (err) {
      // A thrown tick would surface as an unhandled rejection on the interval.
      // Back off so a persistent fault does not spin.
      backOff();
      console.warn('[pro-cert-enrollment] tick failed', err);
    } finally {
      // `finally`, not the end of `try` — an early `return` from any of the
      // precondition gates above would otherwise leave the flag stuck true and
      // wedge enrollment for the life of the process.
      inFlight = false;
    }
  };

  deps.registry.registerInterval({
    name: 'pro-cert-enrollment',
    intervalMs,
    tick,
    // Fires inside boot, so the vault gate + warm-up above are what make it
    // meaningful: it returns instantly on a sealed or handle-less server and
    // re-ticks every 2s once both preconditions hold.
    fireImmediate: true,
    onStop: () => { stopped = true; clearWarmup(); },
  });
};
