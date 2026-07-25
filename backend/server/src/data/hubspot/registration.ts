/** D-129 Phase 2 — HubSpot reconciler registration manifest.
 *
 *  Single source of truth for which HubSpot reconcilers exist + how
 *  the boot wire (`bin.ts`) registers + per-connection task-binds them.
 *
 *  P2 ships one reconciler (`hubspot.deal`); P3 stacks contact, P4
 *  stacks company. The boot wire reads `buildHubSpotReconcilers(deps)`
 *  to construct one instance per process, then calls
 *  `registerVendorReconciler` per entry. The connection-upsert hook
 *  iterates the same list to register `buildVendorReconciliationTask`
 *  per `(reconciler, connection_name)` pair.
 *
 *  Spec: D-129 § A.5. */

import type { VendorReconciler } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  HubSpotDealReconciler,
  type HubSpotDealReconcilerDeps,
} from './deal-reconciler.js';
import {
  HubSpotContactReconciler,
  type HubSpotContactReconcilerDeps,
} from './contact-reconciler.js';
import {
  HubSpotCompanyReconciler,
  type HubSpotCompanyReconcilerDeps,
} from './company-reconciler.js';

/** Construction-time deps shared across every HubSpot reconciler.
 *  P2 shipped `deal`; P3 stacks `contact`; P4 closes the Sales Hub
 *  trio with `company`. Each entry passes the search-helper deps
 *  through plus an optional `now()` override; the boot wire shares
 *  the same `refreshHubSpotAuth` refresh hook across reconcilers. */
export interface BuildHubSpotReconcilersInput {
  deal: HubSpotDealReconcilerDeps;
  contact: HubSpotContactReconcilerDeps;
  company: HubSpotCompanyReconcilerDeps;
}

/** D-129 P2 + P3 + P4 — construct every HubSpot reconciler the
 *  server boots with. Insertion order is the registration order:
 *  `[deal, contact, company]`. The closed Sales Hub set; Marketing /
 *  Service Hub entities are post-launch. */
export const buildHubSpotReconcilers = (
  input: BuildHubSpotReconcilersInput,
): ReadonlyArray<VendorReconciler> => [
  new HubSpotDealReconciler(input.deal),
  new HubSpotContactReconciler(input.contact),
  new HubSpotCompanyReconciler(input.company),
];
