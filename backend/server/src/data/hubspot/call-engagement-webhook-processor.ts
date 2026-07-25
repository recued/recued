/** D-139 Phase 1a.2 — HubSpot call-engagement webhook processor.
 *
 *  Thin wrapper around `buildEngagementWebhookProcessor`. Filters
 *  `call.*` subscription types; routes through the shared idempotency-
 *  ledger gate; resolves the call record via
 *  `/crm/v3/objects/calls/{id}` follow-up GET.
 *
 *  Spec: D-139 § A.3.8, § A.4, § A.6. */

import { HUBSPOT_CALL_PROPERTIES } from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type { WebhookProcessor } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  buildEngagementWebhookProcessor,
  type AssociationChangeApplier,
  type HubSpotEngagementConnectionLookup,
} from './engagement-webhook-shared.js';
import type { HubSpotSearchDeps } from './_hubspot-search.js';

export interface BuildHubSpotCallEngagementWebhookProcessorInput {
  search: HubSpotSearchDeps;
  lookupConnection: HubSpotEngagementConnectionLookup;
  engagementStore: EngagementStore;
  now?: () => number;
  applyAssociationChange?: AssociationChangeApplier;
}

export const buildHubSpotCallEngagementWebhookProcessor = (
  input: BuildHubSpotCallEngagementWebhookProcessorInput,
): WebhookProcessor =>
  buildEngagementWebhookProcessor({
    subscriptionPrefix: 'call',
    objectType: 'calls',
    targetIdPrefix: 'hubspot_call_',
    properties: HUBSPOT_CALL_PROPERTIES as unknown as ReadonlyArray<string>,
    search: input.search,
    lookupConnection: input.lookupConnection,
    engagementStore: input.engagementStore,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.applyAssociationChange !== undefined
      ? { applyAssociationChange: input.applyAssociationChange }
      : {}),
  });
