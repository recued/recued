/** D-139 Phase 1a.2 — HubSpot note-engagement webhook processor.
 *
 *  Thin wrapper around `buildEngagementWebhookProcessor`. Filters
 *  `note.*` subscription types; routes through the shared
 *  idempotency-ledger gate; resolves the note record via
 *  `/crm/v3/objects/notes/{id}` follow-up GET.
 *
 *  Spec: `docs/d-139-spec.md` § A.3.8, § A.4, § A.6. */

import { HUBSPOT_NOTE_PROPERTIES } from '@recued/contracts';

import type { EngagementStore } from '../../storage/engagement-store.js';
import type { WebhookProcessor } from '../../housekeeping/reconciliation/vendor-reconciler.js';

import {
  buildEngagementWebhookProcessor,
  type AssociationChangeApplier,
  type HubSpotEngagementConnectionLookup,
} from './engagement-webhook-shared.js';
import type { HubSpotSearchDeps } from './_hubspot-search.js';

export interface BuildHubSpotNoteEngagementWebhookProcessorInput {
  search: HubSpotSearchDeps;
  lookupConnection: HubSpotEngagementConnectionLookup;
  engagementStore: EngagementStore;
  now?: () => number;
  applyAssociationChange?: AssociationChangeApplier;
}

export const buildHubSpotNoteEngagementWebhookProcessor = (
  input: BuildHubSpotNoteEngagementWebhookProcessorInput,
): WebhookProcessor =>
  buildEngagementWebhookProcessor({
    subscriptionPrefix: 'note',
    objectType: 'notes',
    targetIdPrefix: 'hubspot_note_',
    properties: HUBSPOT_NOTE_PROPERTIES as unknown as ReadonlyArray<string>,
    search: input.search,
    lookupConnection: input.lookupConnection,
    engagementStore: input.engagementStore,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.applyAssociationChange !== undefined
      ? { applyAssociationChange: input.applyAssociationChange }
      : {}),
  });
