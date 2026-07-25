/** D-139 Phase 1a.2 — HubSpot meeting-engagement webhook processor.
 *
 *  Thin wrapper around `buildEngagementWebhookProcessor`. Filters
 *  `meeting.*` subscription types; routes through the shared
 *  idempotency-ledger gate; resolves the meeting record via
 *  `/crm/v3/objects/meetings/{id}` follow-up GET.
 *
 *  Spec: `docs/d-139-spec.md` § A.3.8, § A.4, § A.6. */

import { HUBSPOT_MEETING_PROPERTIES } from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type { WebhookProcessor } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  buildEngagementWebhookProcessor,
  type AssociationChangeApplier,
  type HubSpotEngagementConnectionLookup,
} from './engagement-webhook-shared.js';
import type { HubSpotSearchDeps } from './_hubspot-search.js';

export interface BuildHubSpotMeetingEngagementWebhookProcessorInput {
  search: HubSpotSearchDeps;
  lookupConnection: HubSpotEngagementConnectionLookup;
  engagementStore: EngagementStore;
  now?: () => number;
  applyAssociationChange?: AssociationChangeApplier;
}

export const buildHubSpotMeetingEngagementWebhookProcessor = (
  input: BuildHubSpotMeetingEngagementWebhookProcessorInput,
): WebhookProcessor =>
  buildEngagementWebhookProcessor({
    subscriptionPrefix: 'meeting',
    objectType: 'meetings',
    targetIdPrefix: 'hubspot_meeting_',
    properties: HUBSPOT_MEETING_PROPERTIES as unknown as ReadonlyArray<string>,
    search: input.search,
    lookupConnection: input.lookupConnection,
    engagementStore: input.engagementStore,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.applyAssociationChange !== undefined
      ? { applyAssociationChange: input.applyAssociationChange }
      : {}),
  });
