/** D-139 Phase 1b — Salesforce association rescan fetcher.
 *
 *  Per § A.6.3 — when CometD is unavailable for a parent SObject OR
 *  any of its relationship objects (per-relationship streamability is
 *  probed independently), the per-cycle association-rescan substrate
 *  re-fetches the relationship rows + diffs against persisted
 *  `engagement_edges`.
 *
 *  The generic `runAssociationRescan` lives at
 *  `data/hubspot/association-rescan.ts` (it's vendor-agnostic — the
 *  fetcher is pluggable). This module provides the Salesforce
 *  fetcher: SOQL query against the appropriate relationship object
 *  filtered by parent-id, projecting each junction row into the
 *  generic `EngagementEdgeProjection` shape.
 *
 *  Spec: D-139 § A.6.3, Pass-5 R5.10. */

import {
  SALESFORCE_API_VERSION,
  composePlatformRecordTargetId,
  type ConnectionRecord,
  type SalesforceEngagementEntityName,
} from '@recued/contracts';

import type {
  AssociationFetcher,
  AssociationFetcherInput,
  EngagementEdgeProjection,
} from '../hubspot/association-rescan.js';
import {
  searchSalesforceObjects,
  type RawSalesforceRecord,
  type SalesforceSearchDeps,
} from './_salesforce-search.js';
import {
  canonicalizeEmail,
  readSalesforceBoolean,
  readSalesforceId,
} from './engagement-shared.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface BuildSalesforceAssociationFetcherInput {
  search: SalesforceSearchDeps;
}

// ────────────────────────────────────────────────────────────────
// Fetcher
// ────────────────────────────────────────────────────────────────

/** Build a Salesforce association fetcher. The returned function
 *  matches the generic `AssociationFetcher` shape; the rescan
 *  substrate's `runAssociationRescan` calls it with each engagement
 *  target_id eligible for re-fetch. */
export const buildSalesforceAssociationFetcher = (
  input: BuildSalesforceAssociationFetcherInput,
): AssociationFetcher => {
  return async (
    args: AssociationFetcherInput,
  ): Promise<{
    edges: ReadonlyArray<EngagementEdgeProjection>;
    api_calls_consumed: number;
  }> => {
    const entity = args.entity as SalesforceEngagementEntityName;
    // Strip the vendor + entity prefix to recover the raw Id.
    // Format: `salesforce_<entity>_<rawId>` (e.g.
    // `salesforce_task_00T1234`).
    const prefix = `salesforce_${entity}_`;
    const rawId = args.target_id.startsWith(prefix)
      ? args.target_id.slice(prefix.length)
      : args.target_id;

    const edges: EngagementEdgeProjection[] = [];
    let api_calls_consumed = 0;

    // Fetch the relationship rows for the parent entity. Each parent
    // entity has exactly one relationship object (Task → TaskRelation,
    // Event → EventRelation, EmailMessage → EmailMessageRelation).
    // VoiceCall + CallHistory don't have junction objects — they
    // surface their associations through direct ContactId / AccountId
    // / OpportunityId fields on the parent SObject (handled by the
    // parent reconciler at row-write time, not the rescan path).
    if (entity === 'task' || entity === 'event' || entity === 'email_message') {
      const soql = buildRelationSoql(entity, rawId);
      let count = 0;
      for await (const raw of searchSalesforceObjects(
        args.connection,
        { soql },
        input.search,
      )) {
        const projection = projectRelationRow(entity, raw, args.connection.name);
        if (projection !== null) edges.push(projection);
        count += 1;
        // Approximate one API call per page; SOQL pages 200 records
        // by default, so for typical engagement fan-out we charge 1.
        if (count > 0 && count % 200 === 1) api_calls_consumed += 1;
      }
      if (count === 0) api_calls_consumed = 1;
    } else {
      // VoiceCall / CallHistory: no relationship object. The rescan
      // is a no-op for these entities — the substrate doesn't drift
      // because direct foreign-key fields update on the parent row
      // and the parent reconciler picks them up on its delta scan.
      api_calls_consumed = 0;
    }

    return { edges, api_calls_consumed };
  };
};

const buildRelationSoql = (
  entity: 'task' | 'event' | 'email_message',
  parentId: string,
): string => {
  const escaped = parentId.replace(/'/g, "\\'");
  switch (entity) {
    case 'task':
      return `SELECT Id, TaskId, RelationId, IsWhat, IsDeleted FROM TaskRelation WHERE TaskId = '${escaped}'`;
    case 'event':
      return `SELECT Id, EventId, RelationId, IsWhat, IsParent, IsInvitee, IsDeleted FROM EventRelation WHERE EventId = '${escaped}'`;
    case 'email_message':
      return `SELECT Id, EmailMessageId, RelationId, RelationType, RelationAddress, IsDeleted FROM EmailMessageRelation WHERE EmailMessageId = '${escaped}'`;
  }
  void SALESFORCE_API_VERSION;
};

const projectRelationRow = (
  parentEntity: 'task' | 'event' | 'email_message',
  raw: RawSalesforceRecord,
  connection_name: string,
): EngagementEdgeProjection | null => {
  const isDeleted = readSalesforceBoolean(raw.IsDeleted) === true;
  if (isDeleted) return null;
  // EmailMessageRelation: RelationAddress (email) is the contact
  // discriminator. Parent rows write through `data.contact` directly.
  if (parentEntity === 'email_message') {
    const relationAddress =
      typeof raw.RelationAddress === 'string' ? raw.RelationAddress : null;
    if (relationAddress === null) return null;
    const email = canonicalizeEmail(relationAddress);
    if (email === null) return null;
    return {
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: email,
    };
  }
  // TaskRelation / EventRelation: RelationId + IsWhat discriminator.
  const relationId = readSalesforceId(raw.RelationId);
  if (relationId === null) return null;
  const isWhat = readSalesforceBoolean(raw.IsWhat) === true;
  if (isWhat) {
    const isOpportunity = relationId.startsWith('006');
    return {
      edge_type: isOpportunity ? 'deal' : 'account',
      target_kind: 'connection.api',
      target_id: composePlatformRecordTargetId(
        'salesforce',
        isOpportunity ? 'opportunity' : 'account',
        connection_name,
        relationId,
      ),
    };
  }
  return {
    edge_type: 'contact',
    target_kind: 'connection.api',
    target_id: `salesforce_who_${relationId}`,
  };
};
