/** D-235 P3 + P4 — the whole certificate lifecycle for bring-your-own-domain
 *  hostnames: enrol, renew, and watch the delegation they both depend on.
 *
 *  The sibling of `wire-pro-cert-enrollment.ts`, and deliberately a SEPARATE
 *  service rather than a branch inside it. That one owns exactly one hostname
 *  and creates it: `<handle>.recued.net`, `ddns_managed: true`, ownership
 *  implicit, no preflight, no eligibility gate. This one owns N hostnames it
 *  never creates (the user enrols them), each of which must clear § 3.2's gates
 *  against a LIVE DNS preflight before a single CA round-trip is spent.
 *
 *  ⛔ THE FLEET-ZONE HOSTNAME IS THE RECOVERY PATH (§ 4.1). It gets its own
 *  service, its own backoff and its own failure state so that nothing a custom
 *  domain does — a deleted CNAME, a CAA that blocks the rotation, a zone the
 *  user broke — can delay or fail the address they need in order to get back in
 *  and repair it.
 *
 *  🔑 WHY ALL THREE JOBS LIVE IN ONE SERVICE. They are not merely adjacent: they
 *  share the SAME GATE. A renewal that does not re-check the delegation burns CA
 *  quota on a validation that cannot pass, and a watch that only ran at renewal
 *  time is § 5.1's whole complaint ("delete it and nothing breaks — until the
 *  cert expires ~60 days later, then everything does at once"). One service, one
 *  preflight per row, three consumers of it.
 *
 *  ⚠ ORDER WITHIN A TICK: watch → renew → enrol. The watch is DNS-only and
 *  feeds the other two. Renewal outranks enrolment because a certificate about
 *  to expire is a live surface going down, while a pending enrolment is a
 *  feature not yet started.
 */

import {
  CERT_RENEWAL_LEAD_TIME_MS,
  delegationStateFromPreflight,
  evaluateCustomDomainIssuanceEligibility,
  type CustomDomainPreflightResult,
  type HostnameProjection,
} from '@recued/contracts';

import type { HostnameRegistryStore } from '../../storage/hostname-registry.js';
import type { AcmeManagedDomainIssuer } from '../../keys/rotation/acme-domain-renewer.js';
import type { BackgroundServiceRegistry } from './wire-background-services.js';

/** Same cadence as the sibling enrollment + DDNS timers. */
export const CUSTOM_DOMAIN_ENROLLMENT_INTERVAL_MS = 5 * 60 * 1000;
export const CUSTOM_DOMAIN_ENROLLMENT_BACKOFF_START_MS = 5 * 60 * 1000;
export const CUSTOM_DOMAIN_ENROLLMENT_BACKOFF_MAX_MS = 60 * 60 * 1000;

/** § 5.1 — how often to re-resolve a delegation that is already known good.
 *
 *  ⚠ NOT the tick interval. Re-checking every 5 minutes is 288 lookups per
 *  domain per day for a record that changes approximately never, and it would
 *  make the service's DNS footprint scale with uptime rather than with risk.
 *  Six hours detects a deleted delegation ~50 days before the cert it will kill
 *  expires — enormous margin against a failure whose whole character is that it
 *  is invisible until it is an outage. */
export const DELEGATION_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CustomDomainEnrollmentDeps {
  registry: BackgroundServiceRegistry;
  hostnameRegistry: Pick<
    HostnameRegistryStore,
    'get' | 'list' | 'upsert' | 'setDelegationState'
  >;
  /** Resolved lazily — the cert stack fills its issuer ref in `composeLate`,
   *  which can land after this composer runs. */
  getInitialAcmeIssuer: () => AcmeManagedDomainIssuer | undefined;
  /** Live DNS preflight for one hostname. Injected rather than built here so
   *  the resolver seam stays in one place and tests need no network. */
  runPreflight: (hostname: string) => Promise<CustomDomainPreflightResult>;
  /** This server's Pro reservation. `null` ⇒ nothing to order against. */
  readProDdnsBinding: () => Promise<{ subscription_active: boolean } | null>;
  serverIdentityId: () => string | undefined;
  /** ⛔ A SEALED SERVER MUST DO NOTHING — the registry is unreadable and the
   *  cert stack has no signing identity. Absent ⇒ treated as unlocked, matching
   *  the sibling service's precedent for db-less harnesses. */
  isVaultUnlocked?: () => boolean;
  intervalMs?: number;
  /** Override the renewal lead window. Defaults to the D-148 30-day constant. */
  renewalLeadMs?: number;
  /** Override the delegation re-check interval. */
  delegationWatchMs?: number;
  now?: () => number;
}

const isCustomRow = (row: HostnameProjection): boolean =>
  row.cert_source === 'recued_acme_custom';

/** Rows awaiting a FIRST certificate. ⚠ A row that already has a fingerprint is
 *  finished as far as issuance goes — re-ordering it would burn the publisher's
 *  daily ceiling on a cert it already holds. */
export const selectUnprovisionedCustomDomains = (
  rows: ReadonlyArray<HostnameProjection>,
): HostnameProjection[] =>
  rows.filter((row) => isCustomRow(row) && row.cert_fingerprint === undefined);

/** Rows whose certificate is inside the renewal lead window.
 *
 *  ⛔ THIS IS THE SET THE EXISTING RENEWAL HOOK CANNOT SEE.
 *  `resolveCanonicalDomain` resolves exactly ONE `tls_domains` row — the address
 *  a paired client would connect to — so a server whose canonical address is
 *  `<handle>.recued.net` renews that and nothing else. Every custom domain
 *  alongside it was issued and then left to expire. That is the gap P4 exists
 *  to close. */
export const selectRenewableCustomDomains = (
  rows: ReadonlyArray<HostnameProjection>,
  now: number,
  leadMs: number = CERT_RENEWAL_LEAD_TIME_MS,
): HostnameProjection[] =>
  rows.filter(
    (row) =>
      isCustomRow(row)
      && row.cert_fingerprint !== undefined
      && row.cert_expires_at !== undefined
      && row.cert_expires_at - now <= leadMs,
  );

/** Rows whose delegation has not been looked at recently enough. A row that has
 *  NEVER been checked is always due — absent is not "recently confirmed". */
export const selectDelegationWatchDue = (
  rows: ReadonlyArray<HostnameProjection>,
  now: number,
  intervalMs: number = DELEGATION_WATCH_INTERVAL_MS,
): HostnameProjection[] =>
  rows.filter(
    (row) =>
      isCustomRow(row)
      && (row.delegation_checked_at === undefined
        || now - row.delegation_checked_at >= intervalMs),
  );

export const composeCustomDomainEnrollment = (
  deps: CustomDomainEnrollmentDeps,
): void => {
  const intervalMs = deps.intervalMs ?? CUSTOM_DOMAIN_ENROLLMENT_INTERVAL_MS;
  const renewalLeadMs = deps.renewalLeadMs ?? CERT_RENEWAL_LEAD_TIME_MS;
  const delegationWatchMs = deps.delegationWatchMs ?? DELEGATION_WATCH_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  let retryAfter = 0;
  let backoffMs = 0;
  // ⛔ THE REGISTRY DOES NOT SERIALIZE TICKS (see the sibling service): an
  //    issuance runs the cloud's propagation hold plus CA time, which can
  //    overlap the 5-minute interval, and a re-entrant tick would order a
  //    SECOND certificate for the same hostname. CAs rate-limit failed
  //    validations, so racing attempts can exhaust the limit and block both.
  let inFlight = false;
  let stopped = false;
  // One line per DISTINCT reason per hostname. A boot legitimately hits several
  // of these while substrate composes, so per-tick logging is noise — but never
  // knowing which gate stopped the service is worse.
  const lastSkip = new Map<string, string>();
  const skip = (hostname: string, reason: string): void => {
    if (lastSkip.get(hostname) === reason) return;
    lastSkip.set(hostname, reason);
    console.info(`[custom-domain-certs] ${hostname}: waiting — ${reason}`);
  };

  const backOff = (): void => {
    backoffMs = backoffMs === 0
      ? CUSTOM_DOMAIN_ENROLLMENT_BACKOFF_START_MS
      : Math.min(backoffMs * 2, CUSTOM_DOMAIN_ENROLLMENT_BACKOFF_MAX_MS);
    retryAfter = now() + backoffMs;
  };

  const recordFailure = (
    row: HostnameProjection,
    serverIdentityId: string,
    reason: string,
  ): void => {
    deps.hostnameRegistry.upsert({
      hostname_id: row.hostname_id,
      server_identity_id: serverIdentityId,
      hostname: row.hostname,
      cert_source: 'recued_acme_custom',
      ownership_status: row.ownership_status,
      ...(row.verification_method !== undefined
        ? { verification_method: row.verification_method }
        : {}),
      ...(row.cert_fingerprint !== undefined
        ? { cert_fingerprint: row.cert_fingerprint }
        : {}),
      ...(row.cert_expires_at !== undefined
        ? { cert_expires_at: row.cert_expires_at }
        : {}),
      cert_provisioning: 'failed',
      cert_last_error: reason,
      listener_ports: row.listener_ports,
      enabled: row.enabled,
    });
  };

  /** § 5.1 — re-resolve the delegations that are due and persist what we saw.
   *  Returns the fresh preflight per hostname so the renew/enrol steps below
   *  reuse it instead of paying for a second lookup. */
  const runDelegationWatch = async (
    rows: ReadonlyArray<HostnameProjection>,
    at: number,
  ): Promise<Map<string, CustomDomainPreflightResult>> => {
    const fresh = new Map<string, CustomDomainPreflightResult>();
    for (const row of selectDelegationWatchDue(rows, at, delegationWatchMs)) {
      const preflight = await deps.runPreflight(row.hostname);
      fresh.set(row.hostname, preflight);
      const state = delegationStateFromPreflight(preflight);
      // ⚠ PERSISTED EVEN WHEN NOTHING CHANGED. `delegation_checked_at` is what
      //   makes "confirmed good an hour ago" distinguishable from "never
      //   looked" — without the write, a permanently-unchecked row and a
      //   permanently-healthy one are the same row.
      deps.hostnameRegistry.setDelegationState({
        hostname: row.hostname,
        state,
        checked_at: at,
      });
      if (state === 'broken') {
        console.warn(
          `[custom-domain-certs] ${row.hostname}: _acme-challenge delegation is`
            + ` no longer resolving to this server — renewal will fail`
            + `${row.cert_expires_at !== undefined
              ? ` (certificate expires ${new Date(row.cert_expires_at).toISOString().slice(0, 10)})`
              : ''}`,
        );
      }
    }
    return fresh;
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      if (now() < retryAfter) return;
      if (deps.isVaultUnlocked && !deps.isVaultUnlocked()) return;

      const at = now();
      const rows = deps.hostnameRegistry.list();
      const custom = rows.filter(isCustomRow);
      if (custom.length === 0) {
        // Nothing enrolled. Silent on purpose — the steady state for the
        // overwhelming majority of servers.
        lastSkip.clear();
        return;
      }

      // ── 1 · watch ────────────────────────────────────────────────────
      // DNS only, no CA, no entitlement — runs even for a server whose
      // subscription lapsed, because the answer ("your delegation is gone")
      // is still true and still worth showing.
      const freshPreflights = await runDelegationWatch(custom, at);

      const serverIdentityId = deps.serverIdentityId();
      if (serverIdentityId === undefined || serverIdentityId.length === 0) return;
      const binding = await deps.readProDdnsBinding();
      const issuer = deps.getInitialAcmeIssuer();
      if (!issuer) return;

      const preflightFor = async (
        hostname: string,
      ): Promise<CustomDomainPreflightResult> =>
        freshPreflights.get(hostname) ?? deps.runPreflight(hostname);

      // ── 2 · renew ────────────────────────────────────────────────────
      // ⚠ ONE CA OPERATION PER TICK, here and below. Each runs a CA round-trip
      //   plus the cloud's DNS-01 propagation hold; several back to back would
      //   hold the service busy for minutes and could spend the publisher's
      //   whole daily ceiling before the operator saw the first failure.
      const renewable = selectRenewableCustomDomains(
        deps.hostnameRegistry.list(), at, renewalLeadMs,
      );
      for (const row of renewable) {
        const preflight = await preflightFor(row.hostname);
        // ⛔ A NARROWER GATE THAN ISSUANCE, DELIBERATELY. Renewal re-checks the
        //    things that can still stop the CA — the delegation must resolve,
        //    the subscription must pay for it, the hostname must still be in
        //    use — but NOT ownership (the delegation IS the live ownership
        //    proof, § 8.3) and NOT the per-server cap (lowering a cap must not
        //    silently kill certificates the user already holds and serves).
        const delegation = delegationStateFromPreflight(preflight);
        if (delegation !== 'ok') {
          skip(row.hostname, `renewal blocked: delegation=${delegation}`);
          continue;
        }
        if (binding?.subscription_active !== true) {
          skip(row.hostname, 'renewal blocked: subscription_inactive');
          continue;
        }
        if (!row.enabled) {
          skip(row.hostname, 'renewal blocked: hostname_disabled');
          continue;
        }

        lastSkip.delete(row.hostname);
        const renewed = await issuer.renewDomain({ domain: row.hostname });
        if (!renewed.ok) {
          backOff();
          recordFailure(row, serverIdentityId, renewed.reason);
          console.warn(
            `[custom-domain-certs] ${row.hostname}: renewal failed (${renewed.reason})`
              + ` — retrying in ${Math.round(backoffMs / 60_000)}min`,
          );
          return;
        }
        deps.hostnameRegistry.upsert({
          hostname_id: row.hostname_id,
          server_identity_id: serverIdentityId,
          hostname: row.hostname,
          cert_source: 'recued_acme_custom',
          cert_fingerprint: renewed.new_fingerprint,
          // ⚠ THE NEW EXPIRY MUST LAND HERE OR THE ROW STAYS "DUE". The
          //   renewal-due selector reads `cert_expires_at`; carrying the OLD
          //   one forward would make a successfully renewed domain re-select
          //   on the very next tick and renew again, every tick, until the
          //   daily ceiling stopped it.
          cert_expires_at: renewed.cert_expires_at,
          ownership_status: row.ownership_status,
          ...(row.verification_method !== undefined
            ? { verification_method: row.verification_method }
            : {}),
          cert_provisioning: 'ready',
          listener_ports: row.listener_ports,
          enabled: row.enabled,
        });
        backoffMs = 0;
        retryAfter = 0;
        console.info(`[custom-domain-certs] ${row.hostname} certificate renewed`);
        return;
      }

      // ── 3 · enrol ────────────────────────────────────────────────────
      const pending = selectUnprovisionedCustomDomains(deps.hostnameRegistry.list());
      if (pending.length === 0) return;
      const enrolled_custom_count = custom.length;

      for (const row of pending) {
        const preflight = await preflightFor(row.hostname);
        const decision = evaluateCustomDomainIssuanceEligibility({
          row: {
            cert_source: row.cert_source,
            ownership_status: row.ownership_status,
            ...(row.verification_method !== undefined
              ? { verification_method: row.verification_method }
              : {}),
            enabled: row.enabled,
          },
          preflight,
          subscription_active: binding?.subscription_active === true,
          enrolled_custom_count,
        });
        if (!decision.eligible) {
          // ⚠ NOT a backoff and NOT a `cert_provisioning: 'failed'`. Nothing was
          //   attempted — the user has DNS to fix, and a row that says "failed"
          //   would read as "Recued tried and the CA said no". The blockers are
          //   what the UI renders; the row stays `pending`, which is true.
          skip(row.hostname, decision.blockers.join(','));
          continue;
        }

        lastSkip.delete(row.hostname);
        const issued = await issuer.issueInitialDomain({ domain: row.hostname });
        if (!issued.ok) {
          backOff();
          recordFailure(row, serverIdentityId, issued.reason);
          console.warn(
            `[custom-domain-certs] ${row.hostname}: ${issued.reason}`
              + ` — retrying in ${Math.round(backoffMs / 60_000)}min`,
          );
          return;
        }

        deps.hostnameRegistry.upsert({
          hostname_id: row.hostname_id,
          server_identity_id: serverIdentityId,
          hostname: row.hostname,
          cert_source: 'recued_acme_custom',
          cert_fingerprint: issued.new_fingerprint,
          cert_expires_at: issued.cert_expires_at,
          ownership_status: row.ownership_status,
          ...(row.verification_method !== undefined
            ? { verification_method: row.verification_method }
            : {}),
          cert_provisioning: 'ready',
          listener_ports: row.listener_ports,
          enabled: row.enabled,
        });
        backoffMs = 0;
        retryAfter = 0;
        console.info(
          `[custom-domain-certs] ${row.hostname} certificate ready`
            + ` (expires ${new Date(issued.cert_expires_at).toISOString().slice(0, 10)})`,
        );
        return;
      }
    } catch (err) {
      // A thrown tick surfaces as an unhandled rejection on the interval.
      backOff();
      console.warn('[custom-domain-certs] tick failed', err);
    } finally {
      // `finally`, not the end of `try` — an early `return` from any gate above
      // would otherwise wedge the flag true for the life of the process.
      inFlight = false;
    }
  };

  deps.registry.registerInterval({
    name: 'custom-domain-enrollment',
    intervalMs,
    tick,
    // ⚠ NOT `fireImmediate`. Unlike the fleet-zone service there is nothing to
    //   race to: a custom domain only exists once the user enrolled it, which
    //   they did through a UI that already ran a preflight, so there is no
    //   "user is watching a blank panel at boot" case to warm up for — and an
    //   immediate fire would spend a DNS preflight per enrolled domain inside
    //   the boot path.
    fireImmediate: false,
    onStop: () => { stopped = true; },
  });

  // Referenced so the stop hook is not dead weight if a future tick wants it.
  void stopped;
};
