/** ⛔⛔ A REGISTERED ENTITY NAME MAY CONTAIN AN UNDERSCORE, AND THE CASCADE READ
 *  ITS SCOPE WITH `target_id.split('_')`.
 *
 *  `deriveScopeFromEdge` took `parts[0]` as the vendor and `parts[1]` as the
 *  entity. That is correct only while no registered name contains `_` — and the
 *  registry's own charset explicitly admits one:
 *  `IDENTIFIER_REGEX = /^[a-z][a-z0-9_]*$/` (`connection-vendors.ts:317`),
 *  applied to both `vendor` and `entity` at `connection-vendors.ts:386/389`.
 *
 *  So `entity: 'line_item'` — HubSpot has `line_items` — is a legal
 *  registration, and `hubspot_line_item_acme_12345` read as vendor `hubspot`,
 *  entity `line`: the scope `connection.api.hubspot.line`, which no registry
 *  entry defines. Worse than a miss, it is a MIS-ATTRIBUTION — the truncated
 *  name can land on a DIFFERENT REAL SCOPE, which is what this test drives.
 *
 *  🔑 LATENT, NOT DORMANT. Every name registered today happens to be one word,
 *  so nothing is broken right now. But the charset invites the day one is not,
 *  and `enrichment-registry.ts` opens the engagement plane to PACK-DECLARED CRM
 *  vendors — so the name is not ours to constrain. The fix matches the
 *  registered `<vendor>_<entity>_` prefix WHOLE, which is why an underscore
 *  inside either segment is simply part of the prefix.
 *
 *  ⚠ NOT FIXED BY SWITCHING TO `parsePlatformRecordTargetId`, though that is the
 *  canonical parser and gets this right. It also REQUIRES the D-190 connection
 *  segment, and ten-odd suites still build three-segment `hubspot_deal_47291`
 *  fixtures; whether those are stale shorthand or a form still produced
 *  somewhere is a separate question, and tightening the parser here would have
 *  decided it silently. Prefix matching fixes this bug and nothing else. */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  CONNECTION_VENDOR_ENTITIES,
  type ConnectionVendorEntity,
  type EnrichmentScope,
} from '@recued/contracts';

import { createEnrichmentStore } from '../storage/enrichment-store.js';
import {
  createEnrichmentCascade,
  type EngagementEdgeForCascade,
  type EngagementEdgeLookupForCascade,
} from '../storage/enrichment-cascade.js';

const FIXED_NOW = 1_714_867_200_000;

/** A row the cascade will mark stale if — and only if — it derives the scope
 *  `connection.api.hubspot.deal` for the edge it walks. */
const seedDealAggregate = (db: InstanceType<typeof Database>, target_id: string) => {
  const store = createEnrichmentStore(db);
  store.upsert({
    topic: 'engagement_velocity_signal',
    scope: 'connection.api.hubspot.deal' as EnrichmentScope,
    target_id,
    value: {
      trajectory: 'steady',
      weighted_recent: 2,
      weighted_baseline: 4,
      total_recent: 2,
      total_baseline: 4,
      cursor_at: FIXED_NOW - 86_400_000,
    },
    authored_by: 'system.test',
  });
  return store;
};

const runCascade = (
  store: ReturnType<typeof createEnrichmentStore>,
  edgeTargetId: string,
  registry: ReadonlyArray<ConnectionVendorEntity>,
) => {
  const edges: EngagementEdgeForCascade[] = [
    { edge_type: 'deal', target_kind: 'connection.api', target_id: edgeTargetId },
  ];
  const edgeLookup: EngagementEdgeLookupForCascade = { edges: () => edges };
  const cascade = createEnrichmentCascade(store, {
    engagementEdgeLookup: edgeLookup,
    now: () => FIXED_NOW,
    resolveVendorRegistry: () => registry,
  });
  return cascade.cascadeForEngagementEvent(
    'connection.api.hubspot.email' as EnrichmentScope,
    'hubspot_email_47291',
    'acme-hubspot',
  );
};

/** The built-ins with hubspot's `deal` REPLACED by `deal_extra`. The name is
 *  contrived; the shape is not — it is exactly `line_item` against a sibling
 *  `line`, and it makes the WRONG answer land on a real scope that has topics,
 *  so the two behaviours are distinguishable rather than both being "nothing
 *  happened". */
const REGISTRY_WITH_UNDERSCORE_ENTITY: ReadonlyArray<ConnectionVendorEntity> =
  CONNECTION_VENDOR_ENTITIES.map((e) =>
    e.vendor === 'hubspot' && e.entity === 'deal'
      ? { ...e, entity: 'deal_extra' }
      : e);

describe('an entity name with an underscore keeps its own scope', () => {
  it('CONTROL: the harness can mark a deal aggregate stale', () => {
    // ⛔ Without this the assertion below passes just as happily against a
    //   cascade that never fires for any input.
    const db = new Database(':memory:');
    const store = seedDealAggregate(db, 'hubspot_deal_acme_47291');
    const result = runCascade(store, 'hubspot_deal_acme_47291', CONNECTION_VENDOR_ENTITIES);
    expect(result.rows_marked_stale).toBe(1);
  });

  it('an underscore entity does NOT cascade into the truncated sibling scope', () => {
    const db = new Database(':memory:');
    // The row sits at `…hubspot.deal` — where `split('_')` would have sent the
    // edge, by reading `deal_extra` as `deal`.
    const store = seedDealAggregate(db, 'hubspot_deal_extra_acme_47291');
    const result = runCascade(
      store,
      'hubspot_deal_extra_acme_47291',
      REGISTRY_WITH_UNDERSCORE_ENTITY,
    );
    expect(
      result.rows_marked_stale,
      'the edge belongs to connection.api.hubspot.deal_extra; marking a '
        + 'connection.api.hubspot.deal row stale means the entity segment was truncated',
    ).toBe(0);
  });

  it('MUTATION: the shipped expression reads `deal_extra` as `deal`', () => {
    // ⚠ The assertion above is an absence, and an absence can pass for reasons
    //   that have nothing to do with the fix. This pins WHY it is absent.
    const id = 'hubspot_deal_extra_acme_47291';
    const parts = id.split('_');
    expect(`${parts[0]}/${parts[1]}`).toBe('hubspot/deal'); // the old reading
    const matched = REGISTRY_WITH_UNDERSCORE_ENTITY
      .filter((e) => id.startsWith(`${e.vendor}_${e.entity}_`));
    expect(matched).toHaveLength(1);
    expect(`${matched[0]!.vendor}/${matched[0]!.entity}`).toBe('hubspot/deal_extra');
  });

  it('two entries that could both claim an id resolve to neither', () => {
    // `hubspot_deal_extra_…` starts with BOTH `hubspot_deal_` and
    // `hubspot_deal_extra_`. Never a guess — the canonical parser takes the
    // same position on ambiguity, for the same reason.
    const ambiguous: ReadonlyArray<ConnectionVendorEntity> = [
      ...CONNECTION_VENDOR_ENTITIES,
      ...REGISTRY_WITH_UNDERSCORE_ENTITY.filter((e) => e.entity === 'deal_extra'),
    ];
    const db = new Database(':memory:');
    const store = seedDealAggregate(db, 'hubspot_deal_extra_acme_47291');
    const result = runCascade(store, 'hubspot_deal_extra_acme_47291', ambiguous);
    expect(result.rows_marked_stale).toBe(0);
  });
});
