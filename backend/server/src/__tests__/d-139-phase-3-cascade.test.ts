/** D-139 Phase 3 — engagement-event cascade tests.
 *
 *  Covers:
 *    - `cascadeForEngagementEvent` walks engagement_edges via the
 *      supplied lookup → fans out to aggregate-policy topics whose
 *      `aggregates_from` references the engagement's per-type source
 *      scope → marks per-deal rows stale + enqueues recompute.
 *    - Edge-type discrimination:
 *        deal/account → connection.api.<vendor>.<entity> tuple
 *        contact → 'contact' tuple (canonical email)
 *        owner / mail_twin / calendar_twin → skipped at v1
 *    - `engagementStore.onEngagementChange` callback fires after
 *      ingest commits + does NOT fire on stale-modstamp drops.
 *    - Connection-isolated cascade — two HubSpot portals invalidate
 *      independently.
 *    - Authorship/lifecycle reclassification cascade — re-ingesting
 *      an existing engagement with a fresh modstamp + flipped
 *      authorship triggers cascade (the cascade path is the same as
 *      a vanilla ingest; the substrate doesn't carve out a separate
 *      "reclassification" code path).
 *
 *  Spec: D-139 § A.10 + § P3 acceptance. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  type Authorship,
  type DedupeConfidence,
  type Direction,
  type EngagementLifecycleState,
  type EngagementVendor,
  type EnrichmentScope,
} from '@recued/contracts';

import {
  createEnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createEnrichmentCascade,
  type EngagementEdgeForCascade,
  type EngagementEdgeLookupForCascade,
} from '../storage/enrichment-cascade.js';
import {
  createEngagementStore,
} from '../storage/engagement-store.js';

const FIXED_NOW = 1_714_867_200_000;

const buildEngagementRow = (overrides: Partial<{
  connection_id: string;
  target_id: string;
  vendor: EngagementVendor;
  entity: string;
  authorship: Authorship;
  direction: Direction;
  lifecycle_state: EngagementLifecycleState;
  vendor_modstamp: string;
}> = {}) => ({
  connection_id: overrides.connection_id ?? 'acme-hubspot',
  target_id: overrides.target_id ?? 'hubspot_email_47291',
  vendor: overrides.vendor ?? 'hubspot' as EngagementVendor,
  entity: overrides.entity ?? 'email',
  meta: {},
  mirror_blob_hash: null,
  authorship: overrides.authorship ?? 'user' as Authorship,
  direction: overrides.direction ?? 'outbound' as Direction,
  dedupe_confidence: 'none' as DedupeConfidence,
  lifecycle_state: overrides.lifecycle_state ?? 'point_in_time' as EngagementLifecycleState,
  event_at: FIXED_NOW - 1 * 86_400_000,
  vendor_created_at: FIXED_NOW - 1 * 86_400_000,
  vendor_modified_at: FIXED_NOW - 1 * 86_400_000,
  vendor_modstamp: overrides.vendor_modstamp ?? '1714780800000',
  ingested_at: FIXED_NOW - 1 * 86_400_000,
  body_state: 'none' as const,
});

describe('D-139 P3 — cascadeForEngagementEvent', () => {
  it('walks edges → invalidates aggregate-policy topics whose aggregates_from references the engagement scope', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);

    // Seed an aggregate row for engagement_velocity_signal at the
    // hubspot deal scope (target_id = full deal target_id).
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
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

    // Edge lookup returns a single deal edge for the engagement.
    const edges: EngagementEdgeForCascade[] = [
      {
        edge_type: 'deal',
        target_kind: 'connection.api',
        target_id: 'hubspot_deal_47291',
      },
    ];
    const edgeLookup: EngagementEdgeLookupForCascade = {
      edges: () => edges,
    };

    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: edgeLookup,
      now: () => FIXED_NOW,
    });

    const result = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );

    expect(result.rows_marked_stale).toBe(1);
    expect(result.rows_lifecycle_action_enqueued).toBe(1);

    // Verify the row is now stale.
    const row = enrichmentStore.list({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      fresh_only: false,
    });
    expect(row.length).toBe(1);
    expect(row[0]!.staleness_class).not.toBe('fresh');
  });

  it('contact edge → cascades to perspective/aggregate topics with valid_scopes contact (smoke)', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    // No aggregate topic in the registry currently has valid_scopes='contact' AND
    // aggregates_from including connection.api.hubspot.email; this test asserts
    // the cascade doesn't crash on contact edges + the notifier still fires.
    let notifierFired = 0;
    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          {
            edge_type: 'contact',
            target_kind: 'data.contact',
            target_id: 'bob@acme.com',
          },
        ],
      },
      notifier: (hint) => {
        if (hint.reason === 'engagement_event') notifierFired += 1;
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    expect(r.rows_marked_stale).toBe(0);
    expect(notifierFired).toBe(1);
  });

  it('owner / mail_twin / calendar_twin edges → skipped per § A.10 derivation rules', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);

    // Seed a deal row for engagement_velocity_signal — should NOT be
    // touched by an engagement event whose only edges are owner /
    // mail_twin (no edge derives a deal scope).
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      value: {
        trajectory: 'steady',
        weighted_recent: 0, weighted_baseline: 0,
        total_recent: 0, total_baseline: 0,
        cursor_at: FIXED_NOW - 86_400_000,
      },
      authored_by: 'system.test',
    });

    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'owner', target_kind: 'user', target_id: 'hubspot_owner_id:777' },
          { edge_type: 'mail_twin', target_kind: 'data.mail', target_id: 'mail_id_1' },
          { edge_type: 'calendar_twin', target_kind: 'data.calendar', target_id: 'cal_id_1' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    expect(r.rows_marked_stale).toBe(0);
  });

  it('no edge lookup wired → primitive is no-op', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    const cascade = createEnrichmentCascade(enrichmentStore, {
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    expect(r.rows_marked_stale).toBe(0);
    expect(r.rows_lifecycle_action_enqueued).toBe(0);
  });

  it('cascades for all four deal-level aggregate topics in one call (engagement_velocity_signal + inbound_outbound_ratio + last_meaningful_touch + engagement_silence_duration)', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);

    // Seed all four aggregate rows at the same deal target.
    const seedTopics = [
      ['engagement_silence_duration', { days: 0, last_inbound_event_at: 0, cursor_at: 0 }],
      ['engagement_velocity_signal', { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 }],
      ['inbound_outbound_ratio', { inbound_count: 0, outbound_count: 0, ratio: 0, bucket: 'mutual', cursor_at: 0 }],
      ['last_meaningful_touch', { last_touch_at: 0, vendor: null, entity: null, authorship: null, direction: null, cursor_at: 0 }],
    ] as const;
    for (const [topic, value] of seedTopics) {
      enrichmentStore.upsert({
        topic,
        scope: 'connection.api.hubspot.deal' as EnrichmentScope,
        target_id: 'hubspot_deal_47291',
        value,
        authored_by: 'system.test',
      });
    }

    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_47291' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    // engagement_silence_duration's aggregates_from is JUST
    // connection.api.hubspot.email (canary singular source); the
    // other three list all 9 per-type scopes including hubspot.email.
    // All four should fire on the email-scope cascade.
    expect(r.rows_marked_stale).toBe(4);
    expect(r.rows_lifecycle_action_enqueued).toBe(4);
  });

  it('Salesforce engagement scope — only topics including salesforce scope fire', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.salesforce.opportunity' as EnrichmentScope,
      target_id: 'salesforce_opportunity_006A0',
      value: {
        trajectory: 'steady',
        weighted_recent: 0, weighted_baseline: 0,
        total_recent: 0, total_baseline: 0,
        cursor_at: 0,
      },
      authored_by: 'system.test',
    });
    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'salesforce_opportunity_006A0' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.salesforce.email_message' as EnrichmentScope,
      'salesforce_email_message_001',
      'acme-salesforce',
    );
    expect(r.rows_marked_stale).toBe(1);
  });

  it('engagement_silence_duration fires on Salesforce engagement events post-Codex-P2-#1 widening', () => {
    // Pre-Codex-P2-#1-fold the canary's aggregates_from was just
    // ['connection.api.hubspot.email']; P3 widened it to cover all 10
    // per-type engagement scopes (HubSpot 5 + Salesforce 5). A
    // Salesforce email_message event now correctly invalidates the
    // silence duration on a Salesforce opportunity.
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    enrichmentStore.upsert({
      topic: 'engagement_silence_duration',
      scope: 'connection.api.salesforce.opportunity' as EnrichmentScope,
      target_id: 'salesforce_opportunity_006A0',
      value: { days: 0, last_inbound_event_at: 0, cursor_at: 0 },
      authored_by: 'system.test',
    });
    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'salesforce_opportunity_006A0' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.salesforce.email_message' as EnrichmentScope,
      'salesforce_email_message_001',
      'acme-salesforce',
    );
    expect(r.rows_marked_stale).toBe(1);
  });
});

describe('D-139 P3 — Codex P1 #1 fold: edge-only writes fire cascade', () => {
  it('upsertEdge on an existing engagement fires the callback with kind=edge_change', () => {
    const db = new Database(':memory:');
    const events: Array<{ kind: string; vendor: string; entity: string }> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push({ kind: e.kind, vendor: e.vendor, entity: e.entity }),
    });
    // Seed an engagement row so upsertEdge has somewhere to attach.
    store.upsert({ row: buildEngagementRow() });
    expect(events).toEqual([{ kind: 'updated', vendor: 'hubspot', entity: 'email' }]);
    // Now do an edge-only write — should fire kind: 'edge_change'.
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_47291',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    expect(events).toEqual([
      { kind: 'updated', vendor: 'hubspot', entity: 'email' },
      { kind: 'edge_change', vendor: 'hubspot', entity: 'email' },
    ]);
  });

  it('tombstoneEdge fires callback with kind=edge_change + removed_edge_targets carrying the dropped target', () => {
    const db = new Database(':memory:');
    const events: Array<{ kind: string; removed_edge_targets?: ReadonlyArray<{ target_id: string; edge_type: string }> }> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push({
        kind: e.kind,
        removed_edge_targets: e.removed_edge_targets?.map((t) => ({ target_id: t.target_id, edge_type: t.edge_type })),
      }),
    });
    store.upsert({ row: buildEngagementRow() });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_47291',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    // 2 events so far: row upsert + edge upsert.
    expect(events.length).toBe(2);
    // Now tombstone the edge — third callback fires with the removed target.
    const tombstoned = store.tombstoneEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_id: 'hubspot_deal_47291',
      deleted_at: FIXED_NOW + 1000,
    });
    expect(tombstoned).toBe(true);
    expect(events.length).toBe(3);
    const lastEvent = events[2]!;
    expect(lastEvent.kind).toBe('edge_change');
    expect(lastEvent.removed_edge_targets).toEqual([
      { target_id: 'hubspot_deal_47291', edge_type: 'deal' },
    ]);
  });

  it('idempotent tombstoneEdge (already tombstoned) does NOT fire the callback', () => {
    const db = new Database(':memory:');
    const events: Array<unknown> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push(e),
    });
    store.upsert({ row: buildEngagementRow() });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_kind: 'connection.api',
      target_id: 'hubspot_deal_47291',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    store.tombstoneEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_id: 'hubspot_deal_47291',
      deleted_at: FIXED_NOW + 1000,
    });
    expect(events.length).toBe(3);
    // Second tombstone is a no-op — no callback.
    store.tombstoneEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_email_47291',
      edge_type: 'deal',
      target_id: 'hubspot_deal_47291',
      deleted_at: FIXED_NOW + 2000,
    });
    expect(events.length).toBe(3);
  });
});

describe('D-139 P3 — Codex P1 #2 fold: removed-edge-targets in cascade', () => {
  it('cascade walks both live edges + extra_edge_targets (just-tombstoned in same tx)', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);

    // Seed velocity rows for TWO deals — one is the SURVIVING deal
    // (still in live edges) and the other is the DROPPED deal (just
    // tombstoned in the ingest tx). Both rows must invalidate.
    for (const dealId of ['hubspot_deal_NEW', 'hubspot_deal_OLD']) {
      enrichmentStore.upsert({
        topic: 'engagement_velocity_signal',
        scope: 'connection.api.hubspot.deal' as EnrichmentScope,
        target_id: dealId,
        value: { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 },
        authored_by: 'system.test',
      });
    }

    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        // Live edges include only the surviving deal.
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_NEW' },
        ],
      },
      now: () => FIXED_NOW,
    });

    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
      {
        // Just-tombstoned: the OLD deal that the engagement was disassociated from.
        extra_edge_targets: [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_OLD' },
        ],
      },
    );
    // BOTH the surviving + dropped deal rows should be marked stale.
    expect(r.rows_marked_stale).toBe(2);
  });

  it('dedupes when the same target appears in both live edges and extra_edge_targets', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      value: { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 },
      authored_by: 'system.test',
    });
    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_47291' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
      {
        extra_edge_targets: [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_47291' },
        ],
      },
    );
    // Single row marked stale (deduped).
    expect(r.rows_marked_stale).toBe(1);
  });
});

describe('D-139 P3 — engagementStore onEngagementChange callback', () => {
  it('fires on upsert with kind=updated', () => {
    const db = new Database(':memory:');
    const events: Array<{ vendor: string; entity: string; kind: string }> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => {
        events.push({ vendor: e.vendor, entity: e.entity, kind: e.kind });
      },
    });
    store.upsert({ row: buildEngagementRow() });
    expect(events).toEqual([{ vendor: 'hubspot', entity: 'email', kind: 'updated' }]);
  });

  it('does NOT fire on stale-modstamp drop (Pass-4 R4.7 / § A.3.8)', () => {
    const db = new Database(':memory:');
    const events: Array<unknown> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push(e),
    });
    // Initial write at modstamp 1714780800000.
    store.upsert({ row: buildEngagementRow({ vendor_modstamp: '1714780800000' }) });
    expect(events.length).toBe(1);
    // Stale arrival at older modstamp — substrate drops; callback shouldn't fire.
    store.upsert({ row: buildEngagementRow({ vendor_modstamp: '1700000000000' }) });
    expect(events.length).toBe(1); // unchanged
    // Fresh arrival at newer modstamp — fires again.
    store.upsert({ row: buildEngagementRow({ vendor_modstamp: '1715000000000' }) });
    expect(events.length).toBe(2);
  });

  it('fires on tombstone with kind=deleted', () => {
    const db = new Database(':memory:');
    const events: Array<{ kind: string }> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push({ kind: e.kind }),
    });
    store.upsert({ row: buildEngagementRow() });
    expect(events).toEqual([{ kind: 'updated' }]);
    store.tombstone({
      connection_id: 'acme-hubspot',
      target_id: 'hubspot_email_47291',
      deleted_at: FIXED_NOW,
      actor: 'test',
      vendor_event_id: 'evt-1',
    });
    expect(events).toEqual([
      { kind: 'updated' },
      { kind: 'deleted' },
    ]);
  });

  it('does NOT fire on already-tombstoned row (idempotent tombstone path)', () => {
    const db = new Database(':memory:');
    const events: Array<unknown> = [];
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push(e),
    });
    store.upsert({ row: buildEngagementRow() });
    store.tombstone({
      connection_id: 'acme-hubspot',
      target_id: 'hubspot_email_47291',
      deleted_at: FIXED_NOW,
      actor: 'test',
      vendor_event_id: 'evt-1',
    });
    expect(events.length).toBe(2); // upsert + tombstone
    // Second tombstone is a no-op.
    store.tombstone({
      connection_id: 'acme-hubspot',
      target_id: 'hubspot_email_47291',
      deleted_at: FIXED_NOW + 1,
      actor: 'test',
      vendor_event_id: 'evt-1',
    });
    expect(events.length).toBe(2);
  });

  it('callback exception swallowed — engagement write still commits', () => {
    const db = new Database(':memory:');
    const store = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: () => {
        throw new Error('cascade fault');
      },
    });
    // Must not throw.
    const row = store.upsert({ row: buildEngagementRow() });
    expect(row.target_id).toBe('hubspot_email_47291');
    // Subsequent reads still see the persisted row.
    const fetched = store.get('acme-hubspot', 'hubspot_email_47291');
    expect(fetched).not.toBeNull();
  });
});

describe('D-139 P3 — connection-isolated cascade', () => {
  it('two HubSpot portals — cascade fires only for the affected portal', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);

    // Seed velocity rows for TWO different hubspot deals on TWO portals.
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      value: { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 },
      authored_by: 'system.test',
    });
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_99999',
      value: { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 },
      authored_by: 'system.test',
    });

    // Edge lookup is keyed on (connection_id, engagement_target_id) —
    // the production callback filters by connection_id, so an event
    // for portal A only sees portal A's edges.
    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: (connection_id, engagement_target_id) => {
          if (connection_id === 'acme-hubspot' && engagement_target_id === 'hubspot_email_47291') {
            return [{ edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_47291' }];
          }
          if (connection_id === 'personal-hubspot' && engagement_target_id === 'hubspot_email_99999') {
            return [{ edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_99999' }];
          }
          return [];
        },
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    expect(r.rows_marked_stale).toBe(1);

    // Verify portal A's row is stale; portal B's row is still fresh.
    const portalA = enrichmentStore.list({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      fresh_only: false,
    });
    const portalB = enrichmentStore.list({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_99999',
      fresh_only: false,
    });
    expect(portalA[0]?.staleness_class).not.toBe('fresh');
    expect(portalB[0]?.staleness_class).toBe('fresh');
  });
});

describe('D-139 P3 — authorship/lifecycle reclassification cascade', () => {
  it('re-ingesting an existing engagement with a flipped authorship + fresh modstamp triggers cascade', () => {
    const db = new Database(':memory:');
    const enrichmentStore = createEnrichmentStore(db);
    const events: Array<unknown> = [];
    const engagementStore = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push(e),
    });

    // Initial ingest with authorship='crm_automation' (workflow auto-logged).
    engagementStore.upsert({
      row: buildEngagementRow({
        authorship: 'crm_automation',
        vendor_modstamp: '1714780800000',
      }),
    });
    expect(events.length).toBe(1);

    // Sales rep edits the row (manual notes added) — authorship reclassifies
    // 'crm_automation' → 'crm_user' + modstamp bumps. Per § A.10
    // "Authorship-classification rewrites trigger cascade."
    engagementStore.upsert({
      row: buildEngagementRow({
        authorship: 'crm_user',
        vendor_modstamp: '1714867200000',
      }),
    });
    expect(events.length).toBe(2);

    // Wire the cascade to verify it would fire downstream on the
    // event payload from the second upsert. (Production wiring runs
    // this synchronously from bin.ts — here we drive it directly to
    // assert the cascade-engine receives a viable event.)
    enrichmentStore.upsert({
      topic: 'engagement_velocity_signal',
      scope: 'connection.api.hubspot.deal' as EnrichmentScope,
      target_id: 'hubspot_deal_47291',
      value: { trajectory: 'steady', weighted_recent: 0, weighted_baseline: 0, total_recent: 0, total_baseline: 0, cursor_at: 0 },
      authored_by: 'system.test',
    });

    const cascade = createEnrichmentCascade(enrichmentStore, {
      engagementEdgeLookup: {
        edges: () => [
          { edge_type: 'deal', target_kind: 'connection.api', target_id: 'hubspot_deal_47291' },
        ],
      },
      now: () => FIXED_NOW,
    });
    const r = cascade.cascadeForEngagementEvent(
      'connection.api.hubspot.email' as EnrichmentScope,
      'hubspot_email_47291',
      'acme-hubspot',
    );
    expect(r.rows_marked_stale).toBe(1);
  });

  it('lifecycle transition (pending task → completed task) triggers cascade after ingest', () => {
    const db = new Database(':memory:');
    const events: Array<{ kind: string; entity: string }> = [];
    const engagementStore = createEngagementStore(db, {
      now: () => FIXED_NOW,
      onEngagementChange: (e) => events.push({ kind: e.kind, entity: e.entity }),
    });

    // Initial ingest of a pending task.
    engagementStore.upsert({
      row: buildEngagementRow({
        target_id: 'hubspot_task_301',
        entity: 'task',
        lifecycle_state: 'pending',
        vendor_modstamp: '1714780800000',
      }),
    });
    // Task completes — lifecycle flips pending → completed; modstamp bumps.
    engagementStore.upsert({
      row: buildEngagementRow({
        target_id: 'hubspot_task_301',
        entity: 'task',
        lifecycle_state: 'completed',
        vendor_modstamp: '1714867200000',
      }),
    });
    expect(events).toEqual([
      { kind: 'updated', entity: 'task' },
      { kind: 'updated', entity: 'task' },
    ]);
  });
});
