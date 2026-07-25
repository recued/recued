/** D-176 — Authoritative-write DNS provider seam + canonical hostname row.
 *
 *  This is the *cloud → authoritative-DNS* write side: the edge reconciler
 *  fans an effective record change to one or more providers — the Recued
 *  PowerDNS apply-agent at launch, the Cloudflare DNS API as the launch
 *  bridge / shadow co-target, and Route 53 only ever as an optional seam
 *  target. It generalizes the minimal `DnsProvider` currently inline in
 *  `backend/api/src/routes/ddns.ts` (single `upsertARecord`).
 *
 *  Named `AuthoritativeDnsProvider` (not `DdnsProvider`) to stay clearly
 *  distinct from `@recued/server-network`'s `DdnsAdapter`, which is a
 *  *different layer*: the server→DDNS-endpoint client push (a user's server
 *  telling a DDNS provider its current IP — recued-cloud / DuckDNS / Dynu /
 *  BYO). That seam stays where it is. */

/** Address record types Recued publishes for `<handle>.recued.cloud`. */
export type DnsAddressType = 'A' | 'AAAA';

/** A single authoritative address RRset entry. */
export interface DnsAddressRecord {
  /** Fully-qualified name, e.g. `alice.recued.cloud`. */
  hostname: string;
  type: DnsAddressType;
  /** IP literal — IPv4 for `A`, IPv6 for `AAAA`. */
  value: string;
  /** TTL in seconds. */
  ttl: number;
}

/** Authoritative-write seam. One implementation per backend
 *  (`RecuedAuthoritativeProvider`, `CloudflareDnsProvider`, a test fake, and
 *  — only if ever justified — a Route 53 provider). The edge wraps a fan-out
 *  over N of these (launch N = 1).
 *
 *  Per-record + idempotent by design. The reconciler tolerates transient
 *  partial publication (a failed apply lands in the outbox/Queue and retries
 *  → eventual consistency; resolution is unaffected while an apply is pending,
 *  since secondaries keep serving). So the seam intentionally exposes no
 *  atomic multi-record / multi-provider commit — that is the reconciler's job,
 *  not the contract's. */
export interface AuthoritativeDnsProvider {
  /** Create or replace the A/AAAA RRset for `hostname`. */
  upsertAddressRecord(input: DnsAddressRecord): Promise<void>;
  /** Remove the address record(s) for `hostname`. Omitting `type` removes
   *  both A and AAAA — the suspend (park) and remove lifecycle path. */
  removeAddressRecord(input: {
    hostname: string;
    type?: DnsAddressType;
  }): Promise<void>;
  /** List published address records under a zone suffix — the drift /
   *  reconcile read, and the rebuild-from-truth diff. This is how the
   *  reconciler detects divergence; there is no per-row SOA serial (the zone
   *  serial is global, not per-record). */
  listAddressRecords(input: { suffix: string }): Promise<DnsAddressRecord[]>;
}

/** DNS-publication lifecycle state for a handle. Owned by the control plane
 *  (the canonical store), driven by subscription transitions. NOT entitlement
 *  truth — that stays in the auth-worker / Paddle gate (D-168). */
export type HostnameProviderState =
  /** Publishing normally. May briefly hold no IP — a freshly-activated handle
   *  is `active` while it waits for the poller's first update. */
  | 'active'
  /** Operator/abuse hold: records pulled like `suspended`, but NO grace timer
   *  and no auto-removal — stays until explicitly re-enabled or removed. */
  | 'disabled'
  /** Sub lapsed: records pulled (parked), row + reservation retained until
   *  `grace_until` so a re-subscribe inside grace restores instantly. */
  | 'suspended'
  /** Terminal: records removed and the row is DELETED from the canonical
   *  store (the handle reservation is released — not kept as a tombstone). */
  | 'removed';

/** Canonical hostname row — the source of truth for what belongs in the
 *  zone. Lives in Cloudflare D1 at the edge; store-behind-an-interface
 *  (`D1 | VPS-SQLite`, same shape). The PowerDNS zone is derived from this;
 *  drift is detected by diffing `listAddressRecords` against these rows. */
export interface HostnameRow {
  publisher_id: string;
  /** Primary key — the reserved handle (e.g. `alice`). GLOBAL (shared with
   *  the marketplace publisher namespace), so the zone below is an attribute
   *  of the handle, not part of the key. */
  handle: string;
  /** D-176 — the DDNS zone this handle resolves under (a `DdnsZone.label`,
   *  e.g. `net`). Optional today: with one enabled zone every handle is
   *  implicitly on `defaultDdnsZone()`, so resolution falls back to it when
   *  absent. The field exists so enabling a SECOND zone is a config + store-
   *  column change, not a contract reshape — the seam, not the persistence. */
  zone?: string;
  /** `<handle><zone.suffix>` (e.g. `alice.recued.net`) — unique (1:1 with
   *  `handle`, since the handle is global). */
  hostname: string;
  target_ip_v4: string | null;
  target_ip_v6: string | null;
  ttl: number;
  provider_state: HostnameProviderState;
  /** R27 delta-B — the USER's own choice to pause publication of this handle,
   *  ORTHOGONAL to `provider_state` (the billing/abuse axis). The record
   *  publishes iff `provider_state === 'active' && !user_paused`, so the billing
   *  lifecycle (suspend → grace → sweep) keeps running underneath a pause and a
   *  subscription renewal can NEVER re-open it — only an explicit user resume
   *  clears it. A separate flag, deliberately NOT a 5th `provider_state` value:
   *  conflating the two would lose the ability to reclaim a paused non-payer's
   *  handle. STORE-MANAGED: populated on read (`false` when absent); a desired
   *  write must PRESERVE the prior value (a poller push must never un-pause). */
  user_paused?: boolean;
  /** Last successful publish (ms epoch). */
  last_published_at: number | null;
  /** When `provider_state` last changed (ms epoch). */
  state_changed_at: number | null;
  /** For the `suspended` → `removed` grace sweep (ms epoch). Set whenever
   *  `provider_state` is `suspended`. */
  grace_until: number | null;
  updated_at: number;
  /** D-176 Phase 8 — optimistic-concurrency version (monotonic). STORE-MANAGED:
   *  populated on read; on a `casUpsert` write the store IGNORES this field and
   *  sets the new version to `expectedVersion + 1`, committing only if the
   *  stored row is still at `expectedVersion`. Closes the concurrent-overwrite
   *  window on the desired write (a poller push racing another push or a
   *  lifecycle transition). Optional on a constructed row (the store defaults it
   *  to 0); a persisted row always carries it. */
  version?: number;
}
