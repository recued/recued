/** D-139 Phase 1a.2 — HubSpot task-engagement webhook processor.
 *
 *  Thin wrapper around `buildEngagementWebhookProcessor`. Filters
 *  `task.*` subscription types; routes through the shared idempotency-
 *  ledger gate; resolves the task record via
 *  `/crm/v3/objects/tasks/{id}` follow-up GET.
 *
 *  Spec: D-139 § A.3.8, § A.4, § A.6. */

import { HUBSPOT_TASK_PROPERTIES } from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type { WebhookProcessor } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  buildEngagementWebhookProcessor,
  type AssociationChangeApplier,
  type HubSpotEngagementConnectionLookup,
} from './engagement-webhook-shared.js';
import type { HubSpotSearchDeps } from './_hubspot-search.js';

export interface BuildHubSpotTaskEngagementWebhookProcessorInput {
  search: HubSpotSearchDeps;
  lookupConnection: HubSpotEngagementConnectionLookup;
  engagementStore: EngagementStore;
  now?: () => number;
  applyAssociationChange?: AssociationChangeApplier;
}

export const buildHubSpotTaskEngagementWebhookProcessor = (
  input: BuildHubSpotTaskEngagementWebhookProcessorInput,
): WebhookProcessor =>
  buildEngagementWebhookProcessor({
    subscriptionPrefix: 'task',
    objectType: 'tasks',
    targetIdPrefix: 'hubspot_task_',
    properties: HUBSPOT_TASK_PROPERTIES as unknown as ReadonlyArray<string>,
    search: input.search,
    lookupConnection: input.lookupConnection,
    engagementStore: input.engagementStore,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.applyAssociationChange !== undefined
      ? { applyAssociationChange: input.applyAssociationChange }
      : {}),
  });
