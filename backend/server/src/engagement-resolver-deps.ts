/** D-139 P5 — production-side assembly of the `deps` bundle that
 *  `EngagementStore.resolveEngagementsForContact` consumes.
 *
 *  The resolver (`storage/engagement-store.ts`) is pure over its `deps`:
 *  it walks the contact survivor chain via `resolveContactRedirect`,
 *  expands the member set via `expandContactIdentity`, reads `now`, joins
 *  `data.mail` twins via the optional `resolveMailTwins`, and passes
 *  `coverage` through verbatim. This module wires those callbacks to the
 *  live stores so BOTH the WS-rpc surface (`data.contact.engagements.list`)
 *  and the MCP tool (`recued_contactEngagementsList`) share one bundle.
 *
 *  `resolveMailTwins` is the D-184 Decision 2 live exact-twin join — it is
 *  OMITTED when no `data.mail` collection is wired (CRM-only: rows keep
 *  their as-ingested `body_state`). Wiring it here is the production fix
 *  for the first deferred D-184 MED (the twin join previously ran only in
 *  tests). See internal design notes. */

import type Database from 'better-sqlite3';
import {
  CONNECTION_VENDOR_ENTITIES,
  engagementEntitiesForVendor,
  vendorHasEngagement,
  resolveContactIdentity,
  type ConnectionVendorEntity,
  type CoverageDegradedEntry,
  type CoverageMetadata,
  type CoverageStaleEntry,
  type EngagementsResolverArgs,
  type SourceDegradationReason,
} from '@recued/contracts';
import type { ContactStore } from './storage/contact-store.js';
import {
  resolveConnectionVendor,
  type ConnectionStoreSqlite,
} from './storage/connection-store.js';
import type {
  EngagementRateControlStore,
  RateControlState,
} from './storage/engagement-rate-control-store.js';
import {
  ENGAGEMENTS_TABLE,
  ENGAGEMENT_EDGES_TABLE,
  type ContactIdentityExpansion,
  type ContactRedirectLookup,
  type MailTwinResolver,
} from './storage/engagement-store.js';

// D-192 — the per-vendor engagement entity lists (was `VENDOR_ENGAGEMENT_ENTITIES`,
// a `Record<'hubspot'|'salesforce', string[]>` over the two deleted constants) now
// come from the vendor-entity registry's `engagement` facet via
// `engagementEntitiesForVendor(vendor, registry)` — so a pack-declared CRM's
// engagement scopes list in coverage with no code edit. Salesforce's `voice_call`
// vs `call_history` remains a capability-probed dual-schema pick; coverage lists the
// declared superset at the connection level (per-entity capability nuance is a
// noted follow-up, unchanged).

/** Map the rate-control budget tier (per-(connection, vendor)) onto a
 *  `coverage.sources_degraded` reason, or `null` when the connection is at
 *  full reach. `suspended` (daily budget spent — the reconciler yields
 *  WITHOUT pulling) is the strongest signal: `quota_suspended`. The two
 *  `degraded_*` tiers are cadence throttles from high usage — there is no
 *  "approaching_quota" reason in the closed list, so `rate_limit_active`
 *  (the throttle reason) is the closest honest mapping. */
const budgetDegradationReason = (
  state: RateControlState,
): SourceDegradationReason | null => {
  if (state === 'suspended') return 'quota_suspended';
  if (state === 'degraded_30m' || state === 'degraded_1h') {
    return 'rate_limit_active';
  }
  return null;
};

/** Dedup precedence when a single source scope qualifies on both the
 *  budget axis and the per-entity 429-backoff axis: `quota_suspended`
 *  (the whole connection is paused) outranks `rate_limit_active` (a
 *  transient throttle / backoff). */
const degradationPriority = (reason: SourceDegradationReason): number =>
  reason === 'quota_suspended' ? 2 : 1;

/** Staleness window for `coverage.sources_stale` (spec § A.9.3 — "last
 *  event older than threshold"). A contact-scoped source whose freshest
 *  engagement `event_at` is older than this is flagged stale, so an agent
 *  reading the coverage bundle can tell "actively engaged via this source"
 *  from "this channel has gone cold for this contact". 90 days = a quarter
 *  with no engagement of a given type — the common CRM-dormancy window.
 *  The single tunable knob for this feature; emitted verbatim on each entry
 *  as `staleness_threshold_ms` so consumers see the threshold that was applied. */
export const ENGAGEMENT_SOURCE_STALENESS_MS = 90 * 24 * 60 * 60 * 1000;

export interface EngagementsResolverDepsInput {
  db: Database.Database;
  /** Contact identity surface — survivor-chain redirect + reverse
   *  member-set expansion. */
  contactStore: Pick<ContactStore, 'get' | 'addressSet'>;
  /** Connection enrollment surface — drives honest `sources_connected`
   *  coverage (a connected-but-silent CRM still lists its scopes). */
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>;
  /** Live `data.mail` ↔ CRM-email exact-twin join (D-184 Decision 2).
   *  Production wires `createMailUnionTwinResolver(db)` (cross-account).
   *  Omit to skip exact-twin resolution entirely (rows keep their
   *  as-ingested `body_state`); a wired resolver self-skips when no mail
   *  accounts exist, so omission is rarely needed in production. */
  resolveMailTwins?: MailTwinResolver;
  /** Rate-control substrate (the D-139 P2 health rpc reads the same
   *  store). Drives the `coverage.sources_degraded` third honesty tier —
   *  "connected but throttled/suspended" vs the plain connected/absent
   *  split `sources_connected` already carries. Optional: omit to keep
   *  the v1 behavior (`sources_degraded: []`). */
  rateControlStore?: Pick<
    EngagementRateControlStore,
    'readUsage' | 'readBackoff'
  >;
  /** D-192 — the live merged vendor-entity registry (built-ins + each installed
   *  pack's decomposed entities), read once per coverage build to enumerate a
   *  vendor's engagement source scopes + gate engagement vendors off the
   *  registry's `engagement` facet instead of the retired closed union. Omit to
   *  fall back to the shipped built-ins (`CONNECTION_VENDOR_ENTITIES`). */
  resolveVendorRegistry?: () => ReadonlyArray<ConnectionVendorEntity>;
  now: () => number;
}

/** The bundle `resolveEngagementsForContact` consumes. */
export interface ResolvedEngagementsDeps {
  resolveContactRedirect: ContactRedirectLookup;
  expandContactIdentity: ContactIdentityExpansion;
  now: () => number;
  coverage: CoverageMetadata;
  resolveMailTwins?: MailTwinResolver;
}

/** A per-call deps builder. Coverage depends on the query args (vendor /
 *  connection filters), so the bundle is rebuilt per resolver call; the
 *  identity + mail-twin callbacks are stable closures over the stores. */
export type EngagementsResolverDepsBuilder = (
  args: EngagementsResolverArgs,
) => ResolvedEngagementsDeps;

export const buildEngagementsResolverDeps = (
  input: EngagementsResolverDepsInput,
): EngagementsResolverDepsBuilder => {
  const resolveContactRedirect: ContactRedirectLookup = (email) => {
    const row = input.contactStore.get(email);
    if (row === null) return null;
    // Project the contact row into the resolver's redirect shape; a row
    // without `merged_into` is a live canonical (terminal) row.
    return row.merged_into !== undefined ? { merged_into: row.merged_into } : {};
  };
  // D-205 #3.5b — the COMPLETE address set, not the merge half.
  //
  // This read `listMergedSourceEmails`, which returns only the addresses MERGED
  // away into the survivor. But an address also joins a person by being ATTACHED
  // as an `email_alias` (an import supplying a second address — vendor records
  // are multi-valued upstream) or RETIRED into one (a promotion re-keying the
  // `email` PK). Neither is a tombstone, so neither was in the expansion — and a
  // contact's engagements were resolved over a fraction of their addresses, which
  // for this resolver means a page of their history with rows silently absent.
  //
  // `engagement-store` already says so on the type: "Prefer `contactAddressSet`,
  // which returns the COMPLETE set and cannot be misread this way." The caller
  // adds the survivor into a Set, so a set that already contains it is a no-op.
  const expandContactIdentity: ContactIdentityExpansion = (survivor) =>
    input.contactStore.addressSet(survivor);
  const resolveMailTwins = input.resolveMailTwins;

  return (args) => {
    const deps: ResolvedEngagementsDeps = {
      resolveContactRedirect,
      expandContactIdentity,
      now: input.now,
      coverage: buildEngagementCoverage(
        input,
        args,
        resolveContactRedirect,
        expandContactIdentity,
      ),
    };
    if (resolveMailTwins !== undefined) deps.resolveMailTwins = resolveMailTwins;
    return deps;
  };
};

/** Compose an honest `CoverageMetadata` for a resolver query.
 *
 *  - `sources_connected` — the load-bearing signal — lists the engagement
 *    source scopes of every active `kind:'api'` engagement-vendor
 *    connection (honoring the `args.vendor` filter), so an agent can
 *    distinguish "no engagement" (connected, zero rows) from "couldn't
 *    read the CRM" (source absent).
 *  - `row_counts` + `last_source_event_at` — contact-scoped aggregate over
 *    the SAME member-set edge join the resolver uses; keeps freshness +
 *    per-source counts honest rather than zeroed.
 *  - `sources_unavailable` — `[]` at v1.
 *  - `sources_stale` — a connected source WITH rows whose freshest
 *    contact-scoped engagement `event_at` is older than
 *    `ENGAGEMENT_SOURCE_STALENESS_MS` (§ A.9.3 "last event older than
 *    threshold"). Zero-row sources are not stale (they read as connected via
 *    `sources_connected`); a source whose rows are all upcoming/incomplete
 *    (NULL `event_at`) is unjudgeable, not stale.
 *  - `sources_degraded` — the third honesty tier: a connected source that
 *    is currently throttled or suspended (vs absent, vs at full reach). Fed
 *    from the rate-control store (the same substrate behind the D-139 P2
 *    health rpc) per connected `(connection, vendor[, entity])`. Empty when
 *    no `rateControlStore` is wired (preserves v1 behavior). */
export const buildEngagementCoverage = (
  input: Pick<
    EngagementsResolverDepsInput,
    'db' | 'connectionStore' | 'rateControlStore' | 'resolveVendorRegistry' | 'now'
  >,
  args: EngagementsResolverArgs,
  resolveContactRedirect: ContactRedirectLookup,
  expandContactIdentity: ContactIdentityExpansion,
): CoverageMetadata => {
  // Single clock read — the budget-tier `since` (bucket_started_at) and the
  // per-entity backoff `next_attempt_at > now` comparison share it.
  const now = input.now();
  // D-192 — live merged registry (built-ins + installed packs), read once. Gates
  // engagement vendors + enumerates their engagement source scopes off the
  // `engagement` facet; falls back to the shipped built-ins when unwired.
  const registry = input.resolveVendorRegistry?.() ?? CONNECTION_VENDOR_ENTITIES;
  const connected = new Set<string>();
  // Dedup per source scope — a scope can qualify on the budget axis AND the
  // per-entity 429-backoff axis; `degradationPriority` keeps the stronger.
  const degraded = new Map<string, CoverageDegradedEntry>();
  const addDegraded = (entry: CoverageDegradedEntry): void => {
    const existing = degraded.get(entry.source);
    if (
      existing === undefined ||
      degradationPriority(entry.reason) > degradationPriority(existing.reason)
    ) {
      degraded.set(entry.source, entry);
    }
  };
  for (const row of input.connectionStore.list({ kind: 'api' })) {
    const vendor = resolveConnectionVendor(row);
    if (vendor === undefined || !vendorHasEngagement(vendor, registry)) continue;
    if (args.vendor !== undefined && vendor !== args.vendor) continue;
    // Codex MED fold — a connection-scoped query must not report a
    // same-vendor SIBLING connection's scopes as connected. The row query
    // (below) filters `connection_id = ?`; mirror that here. The engagement
    // row's `connection_id` is the connection's `name` (set at reconciler
    // boot, hubspot/boot.ts:176 `row.name`).
    if (args.connection_id !== undefined && row.name !== args.connection_id) {
      continue;
    }
    const entities = engagementEntitiesForVendor(vendor, registry);
    for (const entity of entities) {
      connected.add(`connection.api.${vendor}.${entity}`);
    }

    // Third honesty tier — read the rate-control substrate keyed on the
    // BARE connection name (`row.name`). That is the key the reconciler
    // writes with (`vendor-reconciler.ts:372` `gate.acquire({ connection_id:
    // connection_name })`) and the canonical engagement `connection_id`
    // throughout this function — NOT the composite `row.pk`. (The P2 health
    // rpc reads `row.pk` instead; see the handover note flagging that
    // mismatch — copying its key here would read a separate, always-`normal`
    // seeded row and never surface real throttling.)
    if (input.rateControlStore !== undefined) {
      // Budget axis — per (connection, vendor); the same tier applies to
      // every entity scope of the connection.
      const usage = input.rateControlStore.readUsage({
        connection_id: row.name,
        vendor,
        now,
      });
      const budgetReason = budgetDegradationReason(usage.rate_control_state);
      if (budgetReason !== null) {
        const detail =
          budgetReason === 'rate_limit_active'
            ? `budget ${Math.round(usage.budget_utilization_pct * 100)}% (${usage.rate_control_state})`
            : undefined;
        for (const entity of entities) {
          addDegraded({
            source: `connection.api.${vendor}.${entity}`,
            reason: budgetReason,
            since: usage.bucket_started_at,
            ...(detail !== undefined ? { detail } : {}),
          });
        }
      }
      // Backoff axis — per (connection, vendor, entity) 429 state. Finer-
      // grained than the budget tier: an active backoff (`next_attempt_at`
      // in the future) throttles only that entity's scope.
      for (const entity of entities) {
        const backoff = input.rateControlStore.readBackoff({
          connection_id: row.name,
          vendor,
          entity,
        });
        if (backoff.next_attempt_at > now) {
          addDegraded({
            source: `connection.api.${vendor}.${entity}`,
            reason: 'rate_limit_active',
            since: backoff.last_429_at ?? now,
            detail: `429 backoff until ${backoff.next_attempt_at}`,
          });
        }
      }
    }
  }
  const sources_connected = Array.from(connected).sort();
  const sources_degraded = Array.from(degraded.values()).sort((a, b) =>
    a.source.localeCompare(b.source),
  );

  const row_counts: Record<string, number> = {};
  const sources_stale: CoverageStaleEntry[] = [];
  let last_source_event_at = 0;

  let survivor: string;
  try {
    survivor = resolveContactIdentity(
      args.email,
      resolveContactRedirect,
    ).canonical_email;
  } catch {
    // Invalid redirect chain — the resolver itself throws on the same walk
    // and surfaces the error; coverage degrades to enrollment-only.
    return {
      sources_connected,
      sources_unavailable: [],
      sources_stale,
      sources_degraded,
      row_counts,
      last_source_event_at,
    };
  }

  const members = new Set<string>(expandContactIdentity(survivor));
  members.add(survivor);
  if (members.size > 0) {
    const memberPlaceholders = Array.from(members)
      .map(() => '?')
      .join(', ');
    const conditions: string[] = [
      'deleted_at IS NULL',
      `EXISTS (SELECT 1 FROM ${ENGAGEMENT_EDGES_TABLE} e WHERE e.connection_id = ${ENGAGEMENTS_TABLE}.connection_id AND e.engagement_target_id = ${ENGAGEMENTS_TABLE}.target_id AND e.edge_type = 'contact' AND e.deleted_at IS NULL AND e.target_id IN (${memberPlaceholders}))`,
    ];
    const params: unknown[] = [...members];
    if (args.vendor !== undefined) {
      conditions.push('vendor = ?');
      params.push(args.vendor);
    }
    if (args.connection_id !== undefined) {
      conditions.push('connection_id = ?');
      params.push(args.connection_id);
    }
    const sql = `SELECT vendor, entity, COUNT(*) AS n, MAX(event_at) AS max_event
       FROM ${ENGAGEMENTS_TABLE}
       WHERE ${conditions.join(' AND ')}
       GROUP BY vendor, entity`;
    const aggRows = input.db.prepare(sql).all(...params) as Array<{
      vendor: string;
      entity: string;
      n: number;
      max_event: number | null;
    }>;
    for (const r of aggRows) {
      const source = `connection.api.${r.vendor}.${r.entity}`;
      row_counts[source] = r.n;
      if (r.max_event !== null) {
        if (r.max_event > last_source_event_at) {
          last_source_event_at = r.max_event;
        }
        // A source with rows whose freshest event_at is older than the
        // window is stale (§ A.9.3). max_event is NULL only when EVERY row
        // for the source is upcoming/incomplete (SF Event/Task carry NULL
        // event_at until they happen) — that's "not yet", not "old" — so
        // the outer null-guard correctly leaves those sources unflagged.
        if (r.max_event < now - ENGAGEMENT_SOURCE_STALENESS_MS) {
          sources_stale.push({
            source,
            last_event_at: r.max_event,
            staleness_threshold_ms: ENGAGEMENT_SOURCE_STALENESS_MS,
          });
        }
      }
    }
  }
  sources_stale.sort((a, b) => a.source.localeCompare(b.source));

  return {
    sources_connected,
    sources_unavailable: [],
    sources_stale,
    sources_degraded,
    row_counts,
    last_source_event_at,
  };
};
