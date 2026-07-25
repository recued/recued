/** D-139 Phase 1a.1.1 — HubSpot engagement-association-change applier.
 *
 *  Builds an `AssociationChangeApplier` for the engagement webhook
 *  processors. When wired, `<prefix>.associationChange` webhook
 *  events route through this callback (instead of passing through
 *  unledgered as P1a.2 did). The applier:
 *
 *    1. Fetches the engagement's current CRM-side association set
 *       via `fetchHubSpotEngagementAssociations`.
 *    2. Diffs against the persisted `engagement_edges` rows for the
 *       in-scope edge_types (`'deal'`, `'account'`, optionally
 *       `'contact'`).
 *    3. Emits edge upserts (new associations) + tombstones
 *       (disappeared associations) atomically.
 *    4. Records API call usage in the rate-control store.
 *
 *  The associated webhook factory ledgers the event AFTER this
 *  callback returns successfully — per the carry-forward learning
 *  that the ledger is a "we processed this and the side-effects
 *  landed" marker, not a "we saw this" marker.
 *
 *  Behavioral parity with `runAssociationRescan` (§ A.6.3): same
 *  D-138 contact-redirect routing, same edge_type scoping, same
 *  rate-control accounting. The webhook path differs in that it
 *  fires per-engagement on demand (latency: ~1 sec from CRM-side
 *  change) rather than per-cycle batched.
 *
 *  Spec: D-139 § A.3.8, § A.4, § A.6.3. */

import {
  resolveContactIdentity,
  type EngagementEdge,
  type EngagementVendor,
} from '@recued/contracts';

import type {
  ContactRedirectLookup,
  EngagementStore,
  UpsertEdgeInput,
} from '../../storage/engagement-store.js';
import type { EngagementRateControlStore } from '../../storage/engagement-rate-control-store.js';

import type { AssociationChangeApplier } from './engagement-webhook-shared.js';
import {
  fetchHubSpotEngagementAssociations,
  hubSpotEngagementTargetIdFor,
  type EngagementCrmAssociations,
} from './engagement-shared.js';
import type { HubSpotSearchDeps } from './_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export interface BuildHubSpotEngagementAssociationChangeApplierInput {
  engagementStore: EngagementStore;
  rateControlStore: EngagementRateControlStore;
  search: HubSpotSearchDeps;
  /** D-138 contact-redirect lookup — required even when `'contact'`
   *  edges are out-of-scope so the diff stays D-138-aware for future
   *  widenings. The applier passes `() => null` through to the edge
   *  upsert when no merge state exists. */
  resolveContactRedirect: ContactRedirectLookup;
  /** Closed-list edge_types this applier writes. Defaults to the same
   *  CRM-side set as `runAssociationRescan` (`'deal'`, `'account'`).
   *  `'contact'` widening lands at a future sub-phase once the
   *  HubSpot raw-id → primary-email lookup is wired. */
  edge_types_in_scope?: ReadonlyArray<EngagementEdge['edge_type']>;
}

// ────────────────────────────────────────────────────────────────
// Default scope
// ────────────────────────────────────────────────────────────────

/** § A.4 — closed list of edge types the webhook applier diffs.
 *  Mirrors `DEFAULT_RESCAN_EDGE_TYPES` from `association-rescan.ts`
 *  but excludes `'contact'` at P1a.1.1 (HubSpot raw contact id →
 *  canonical email lookup not yet wired for non-email engagements;
 *  email + meeting reconcilers continue to derive contact edges from
 *  email headers / attendee emails). */
export const DEFAULT_APPLIER_EDGE_TYPES: ReadonlyArray<
  EngagementEdge['edge_type']
> = ['deal', 'account'];

// ────────────────────────────────────────────────────────────────
// Builder
// ────────────────────────────────────────────────────────────────

export const buildHubSpotEngagementAssociationChangeApplier = (
  input: BuildHubSpotEngagementAssociationChangeApplierInput,
): AssociationChangeApplier => {
  const inScope = input.edge_types_in_scope ?? DEFAULT_APPLIER_EDGE_TYPES;
  const inScopeSet: ReadonlySet<EngagementEdge['edge_type']> = new Set(inScope);
  const includeContacts = inScopeSet.has('contact');

  return async ({
    connection,
    connection_id,
    entity,
    target_id,
    raw_id,
    now,
  }) => {
    // Pre-flight: respect rate-control state. When the budget is
    // suspended the applier short-circuits as RETRYABLE (Codex P1 #1
    // fold-back) — caller (the webhook factory) does NOT ledger the
    // event so HubSpot redelivers + a future reconciler cycle / next
    // webhook attempt picks the change up.
    const usage = input.rateControlStore.readUsage({
      connection_id,
      vendor: 'hubspot',
      now,
    });
    if (usage.rate_control_state === 'suspended') {
      return {
        edges_created: 0,
        edges_tombstoned: 0,
        api_calls_consumed: 0,
        source_record_missing: false,
        retryable_failure: true,
      };
    }
    const backoff = input.rateControlStore.readBackoff({
      connection_id,
      vendor: 'hubspot',
      entity,
    });
    if (backoff.consecutive_429s > 0 && backoff.next_attempt_at > now) {
      return {
        edges_created: 0,
        edges_tombstoned: 0,
        api_calls_consumed: 0,
        source_record_missing: false,
        retryable_failure: true,
      };
    }

    let fetched;
    try {
      fetched = await fetchHubSpotEngagementAssociations({
        connection,
        entity,
        raw_id,
        search: input.search,
        include_contacts: includeContacts,
      });
    } catch (err) {
      // Codex P2 #2 fold-back — catch HubSpot 429 + record per-tuple
      // backoff so the per-cycle rescan + future webhook deliveries
      // observe the deferral. Distinguish 429 from auth-expired /
      // search-error by error code; only 429 is retryable here.
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: unknown }).code === 'HUBSPOT_RATE_LIMITED'
      ) {
        input.rateControlStore.recordTooManyRequests({
          connection_id,
          vendor: 'hubspot',
          entity,
          now,
        });
        return {
          edges_created: 0,
          edges_tombstoned: 0,
          api_calls_consumed: 0,
          source_record_missing: false,
          retryable_failure: true,
        };
      }
      // Other errors (auth expired, search error, network) — caller
      // catches the throw + leaves ledger empty so HubSpot retries.
      throw err;
    }
    input.rateControlStore.recordUsage({
      connection_id,
      vendor: 'hubspot',
      n: fetched.api_calls_consumed,
      now,
    });
    // Codex P2 #2 fold-back — record success on the per-tuple backoff
    // tracker so consecutive_429s resets after a successful page.
    input.rateControlStore.recordSuccess({
      connection_id,
      vendor: 'hubspot',
      entity,
    });
    if (fetched.source_record_missing) {
      return {
        edges_created: 0,
        edges_tombstoned: 0,
        api_calls_consumed: fetched.api_calls_consumed,
        source_record_missing: true,
        retryable_failure: false,
      };
    }

    const diff = applyAssociationDiff({
      store: input.engagementStore,
      connection_id,
      engagement_target_id: target_id,
      vendor: 'hubspot',
      associations: fetched.associations,
      now,
      resolveContactRedirect: input.resolveContactRedirect,
      inScopeSet,
    });

    return {
      edges_created: diff.edges_created,
      edges_tombstoned: diff.edges_tombstoned,
      api_calls_consumed: fetched.api_calls_consumed,
      source_record_missing: false,
      retryable_failure: false,
    };
  };
};

// ────────────────────────────────────────────────────────────────
// Diff helper — parallel to association-rescan's diffEdges
// ────────────────────────────────────────────────────────────────

interface ApplyAssociationDiffInput {
  store: EngagementStore;
  connection_id: string;
  engagement_target_id: string;
  vendor: EngagementVendor;
  associations: EngagementCrmAssociations;
  now: number;
  resolveContactRedirect: ContactRedirectLookup;
  inScopeSet: ReadonlySet<EngagementEdge['edge_type']>;
}

interface ApplyAssociationDiffResult {
  edges_created: number;
  edges_tombstoned: number;
}

/** Compute the edge diff between the persisted set and the fetched
 *  CRM-side associations; emit upserts + tombstones for the
 *  in-scope edge types. Mirrors `association-rescan.ts`'s `diffEdges`
 *  with the same D-138 contact-redirect routing + edge-type scoping
 *  rules so webhook + rescan paths produce identical state. */
const applyAssociationDiff = (
  input: ApplyAssociationDiffInput,
): ApplyAssociationDiffResult => {
  let edges_created = 0;
  let edges_tombstoned = 0;

  // Build the incoming set, scoped to in-scope types only. Contact
  // ids resolve through D-138 redirect BEFORE diffing so persisted
  // survivor edges match.
  const incomingKeys = new Set<string>();
  const incomingEdges: ReadonlyArray<{
    edge_type: EngagementEdge['edge_type'];
    target_kind: EngagementEdge['target_kind'];
    target_id: string;
    raw_target_id: string;
  }> = buildIncomingProjections(input.associations, input.inScopeSet, input.connection_id);

  const existing = input.store.listEdges({
    connection_id: input.connection_id,
    engagement_target_id: input.engagement_target_id,
  });
  const existingScoped = existing.filter((e) =>
    input.inScopeSet.has(e.edge_type),
  );
  const existingKeys = new Set(
    existingScoped.map((e) => `${e.edge_type}|${e.target_id}`),
  );

  for (const e of incomingEdges) {
    let resolvedTargetId = e.target_id;
    if (e.edge_type === 'contact') {
      const { canonical_email } = resolveContactIdentity(
        e.target_id,
        input.resolveContactRedirect,
      );
      resolvedTargetId = canonical_email;
    }
    const key = `${e.edge_type}|${resolvedTargetId}`;
    incomingKeys.add(key);
    if (existingKeys.has(key)) continue;
    const upsert: UpsertEdgeInput = {
      connection_id: input.connection_id,
      engagement_target_id: input.engagement_target_id,
      edge_type: e.edge_type,
      target_kind: e.target_kind,
      target_id: e.raw_target_id,
      vendor: input.vendor,
      created_at: input.now,
      ...(e.edge_type === 'contact'
        ? { resolveContactRedirect: input.resolveContactRedirect }
        : {}),
    };
    input.store.upsertEdge(upsert);
    edges_created += 1;
  }

  for (const e of existingScoped) {
    const key = `${e.edge_type}|${e.target_id}`;
    if (incomingKeys.has(key)) continue;
    const removed = input.store.tombstoneEdge({
      connection_id: input.connection_id,
      engagement_target_id: input.engagement_target_id,
      edge_type: e.edge_type,
      target_id: e.target_id,
      deleted_at: input.now,
    });
    if (removed) edges_tombstoned += 1;
  }

  return { edges_created, edges_tombstoned };
};

/** Project the CRM-side association set into edge-shaped projections
 *  with the substrate's `<vendor>_<entity>_<id>` target_id wrapping. */
const buildIncomingProjections = (
  associations: EngagementCrmAssociations,
  inScope: ReadonlySet<EngagementEdge['edge_type']>,
  connection_name: string,
): ReadonlyArray<{
  edge_type: EngagementEdge['edge_type'];
  target_kind: EngagementEdge['target_kind'];
  target_id: string;
  raw_target_id: string;
}> => {
  const out: Array<{
    edge_type: EngagementEdge['edge_type'];
    target_kind: EngagementEdge['target_kind'];
    target_id: string;
    raw_target_id: string;
  }> = [];
  if (inScope.has('deal')) {
    for (const dealId of associations.deals) {
      const wrapped = hubSpotEngagementTargetIdFor('hubspot', 'deal', connection_name, dealId);
      out.push({
        edge_type: 'deal',
        target_kind: 'connection.api',
        target_id: wrapped,
        raw_target_id: wrapped,
      });
    }
  }
  if (inScope.has('account')) {
    for (const companyId of associations.companies) {
      const wrapped = hubSpotEngagementTargetIdFor(
        'hubspot',
        'company',
        connection_name,
        companyId,
      );
      out.push({
        edge_type: 'account',
        target_kind: 'connection.api',
        target_id: wrapped,
        raw_target_id: wrapped,
      });
    }
  }
  if (inScope.has('contact') && associations.contacts !== undefined) {
    // Contact widening at P1a.1.1 is OUT OF SCOPE — see
    // `note-engagement-reconciler.ts` for the rationale (canonical
    // email lookup not yet wired for raw HubSpot contact ids). When
    // the lookup lands at a future phase, projection here will route
    // through the contact-store's `target_id → primary_email` map +
    // emit `target_kind: 'data.contact'` edges keyed on email.
  }
  return out;
};
