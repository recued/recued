/** D-136 P6 — Tombstone-with-id semantics tests.
 *
 *  Audit §10.2 spec for tombstone-with-id default:
 *    - NULL the value column (no longer surfaces formerly-cached payload)
 *    - Preserve _id + event_at (D-120 link graph + timeline lookups)
 *    - Set tombstoned_at + tombstone_reason + staleness_class = 'expired'
 *    - Drop sidecars synchronously (vector + FTS searches don't surface tombstoned content)
 *    - Skip pinned rows (manual user corrections are protected)
 *
 *  Plus the cascade widening: cascadeForConnectionDelete with `vendor`
 *  tombstones every chain-head row scoped to
 *  `connection.api.<vendor>.<entity>` for any registered entity. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnrichmentCascade } from '../storage/enrichment-cascade.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p6-tombstone-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// 1. tombstoneRowIds — NULL value + preserve _id + event_at
// ────────────────────────────────────────────────────────────────

const PURPOSE = (
  override: Record<string, unknown> = {},
): { purpose: string; confidence: number } => ({
  purpose: 'inquiry',
  confidence: 0.7,
  ...override,
});

const DEAL = (
  override: Record<string, unknown> = {},
): { score: number; signals: string[]; reasoning: string } => ({
  score: 72,
  signals: ['email engagement'],
  reasoning: 'Steady touch + meeting next week',
  ...override,
});

describe('tombstoneRowIds — audit §10.2 tombstone-with-id', () => {
  it('NULLs the value column while preserving _id + event_at', () => {
    const written = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: PURPOSE(),
      event_at: NOW - 60_000,
    });
    expect(written.value).toEqual(PURPOSE());
    expect(written.event_at).toBe(NOW - 60_000);
    expect(written.tombstoned_at).toBeNull();

    const tombstoned = store.tombstoneRowIds([written._id], 'cascade_delete');
    expect(tombstoned).toBe(1);

    const after = store.list({ topic: 'purpose', fresh_only: false })[0]!;
    expect(after._id).toBe(written._id);              // preserved
    expect(after.event_at).toBe(NOW - 60_000);        // preserved
    expect(after.value).toBeNull();                   // NULLed
    expect(after.staleness_class).toBe('expired');
    expect(after.tombstoned_at).toBe(NOW);
    expect(after.tombstone_reason).toBe('cascade_delete');
    expect(after.lifecycle_action_pending).toBeNull();
  });

  it('skips pinned rows', () => {
    const pinned = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_pinned',
      authored_by: 'system.user_correction.test_user',
      value: PURPOSE(),
      mode: 'pinned',
    } as never);
    const tombstoned = store.tombstoneRowIds([pinned._id], 'cascade_delete');
    expect(tombstoned).toBe(0);

    const after = store.list({ topic: 'purpose', fresh_only: false })[0]!;
    expect(after.value).toEqual(PURPOSE());
    expect(after.tombstoned_at).toBeNull();
    expect(after.is_pinned).toBe(true);
  });

  it('idempotent — re-tombstoning is a no-op', () => {
    const written = store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'mail_1',
      authored_by: 'system.housekeeping.purpose',
      value: PURPOSE(),
    });
    expect(store.tombstoneRowIds([written._id], 'cascade_delete')).toBe(1);
    expect(store.tombstoneRowIds([written._id], 'cascade_delete')).toBe(0);
  });

  it('tombstones multiple ids in one call', () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = store.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: `mail_${i}`,
        authored_by: 'system.housekeeping.purpose',
        value: PURPOSE({ confidence: 0.5 }),
      });
      ids.push(r._id);
    }
    expect(store.tombstoneRowIds(ids, 'source_revoked')).toBe(3);
    const rows = store.list({ topic: 'purpose', fresh_only: false });
    for (const row of rows) {
      expect(row.value).toBeNull();
      expect(row.tombstone_reason).toBe('source_revoked');
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 2. cascadeForConnectionDelete — vendor-entity scope cleanup
// ────────────────────────────────────────────────────────────────

describe('cascadeForConnectionDelete — vendor-entity cleanup', () => {
  const seedVendorRow = (
    scope: string,
    target_id: string,
    value: { score: number; signals: string[]; reasoning: string } = DEAL(),
  ): string => {
    const r = store.upsert({
      topic: 'deal_health_score',
      scope: scope as never,
      target_id,
      authored_by: 'system.housekeeping.deal_health_score',
      value,
    });
    return r._id;
  };

  it('tombstones every chain-head row for the vendor across all known entity scopes', () => {
    // `deal_health_score` only declares `connection.api.{hubspot.deal,
    // salesforce.opportunity}` as valid scopes, but the cascade walks
    // `CONNECTION_VENDOR_ENTITIES` independent of which topics happen
    // to land rows there — a real HubSpot delete would tombstone any
    // surviving rows under `hubspot.contact` / `hubspot.company` too.
    // Seeding two hubspot deal rows + one salesforce opportunity row
    // is enough to demonstrate the per-vendor narrowing.
    const deal1 = seedVendorRow('connection.api.hubspot.deal', 'hubspot_deal_my_hubspot_1', DEAL());
    const deal2 = seedVendorRow(
      'connection.api.hubspot.deal',
      'hubspot_deal_my_hubspot_2',
      DEAL({ score: 30 }),
    );

    const cascade = createEnrichmentCascade(store);
    const result = cascade.cascadeForConnectionDelete('api', 'my_hubspot', 'hubspot');
    expect(result.rows_tombstoned).toBe(2);

    const all = store.list({ topic: 'deal_health_score', fresh_only: false });
    for (const id of [deal1, deal2]) {
      const row = all.find((r) => r._id === id)!;
      expect(row.value).toBeNull();
      expect(row.tombstoned_at).toBe(NOW);
      expect(row.tombstone_reason).toBe('cascade_delete');
      expect(row.staleness_class).toBe('expired');
    }
  });

  it('leaves OTHER vendor scopes alone when tombstoning hubspot', () => {
    const hubspotId = seedVendorRow('connection.api.hubspot.deal', 'hubspot_deal_my_hubspot_1', DEAL());
    const salesforceId = seedVendorRow(
      'connection.api.salesforce.opportunity',
      'salesforce_opportunity_1',
      DEAL(),
    );

    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForConnectionDelete('api', 'my_hubspot', 'hubspot');

    const all = store.list({ topic: 'deal_health_score', fresh_only: false });
    const hubspotRow = all.find((r) => r._id === hubspotId)!;
    const salesforceRow = all.find((r) => r._id === salesforceId)!;
    expect(hubspotRow.value).toBeNull();
    expect(salesforceRow.value).toEqual(DEAL());
  });

  it('skips vendor cleanup when vendor argument is omitted', () => {
    const dealId = seedVendorRow('connection.api.hubspot.deal', 'hubspot_deal_my_hubspot_1', DEAL());
    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForConnectionDelete('api', 'my_hubspot');

    const row = store
      .list({ topic: 'deal_health_score', fresh_only: false })
      .find((r) => r._id === dealId)!;
    expect(row.value).toEqual(DEAL());
    expect(row.tombstoned_at).toBeNull();
  });

  it('skips vendor cleanup for non-api kinds', () => {
    const dealId = seedVendorRow('connection.api.hubspot.deal', 'hubspot_deal_my_hubspot_1', DEAL());
    const cascade = createEnrichmentCascade(store);
    // mcp/notification kinds should not trigger vendor cleanup.
    cascade.cascadeForConnectionDelete('mcp', 'my_mcp', 'hubspot');

    const row = store
      .list({ topic: 'deal_health_score', fresh_only: false })
      .find((r) => r._id === dealId)!;
    expect(row.value).toEqual(DEAL());
  });

  it('preserves _id + event_at on vendor-cleanup tombstones (D-120 link graph)', () => {
    const dealId = seedVendorRow('connection.api.hubspot.deal', 'hubspot_deal_my_hubspot_1', DEAL());
    const beforeRow = store
      .list({ topic: 'deal_health_score', fresh_only: false })
      .find((r) => r._id === dealId)!;
    const eventAtBefore = beforeRow.event_at;

    const cascade = createEnrichmentCascade(store);
    cascade.cascadeForConnectionDelete('api', 'my_hubspot', 'hubspot');

    const after = store
      .list({ topic: 'deal_health_score', fresh_only: false })
      .find((r) => r._id === dealId)!;
    expect(after._id).toBe(dealId);
    expect(after.event_at).toBe(eventAtBefore);
    expect(after.value).toBeNull();
  });
});
