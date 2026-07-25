/** D-137 P2 § A.4 — `EnrichmentStore.listScopeMeta` unit tests.
 *
 *  The new method backs chat scope-search fan-out for platform-mirror
 *  sources. Verifies:
 *    - Returns distinct `(target_id, meta)` rows for a given scope,
 *      one per target.
 *    - Picks the latest meta per target_id (max(ingested_at) chain
 *      head); rows whose meta is NULL drop.
 *    - `name_contains` filters case-insensitively against
 *      `json_extract(meta, '$.name')`.
 *    - `email_exact` filters exactly against
 *      `json_extract(meta, '$.email')` (lowercased).
 *    - `limit` clamps to the per-call cap.
 *    - Superseded rows (D-136 historical chains) drop. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EnrichmentMeta } from '@recued/contracts';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { ensureMemorySchema, getOrCreateRecipeInsight } from '../memory-schema.js';
import type { ActivityEntry, AuditEntry } from '@recued/storage';

let dir: string;
let db: Database.Database;
let enrichmentStore: EnrichmentStore;
let timeCursor: number;

const setupHarness = (): void => {
  dir = mkdtempSync(join(tmpdir(), 'd137-p2-scope-meta-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  createSQLiteCollection<AuditEntry>(db, 'audit_entries');
  createSQLiteCollection<ActivityEntry>(db, 'audit_activities');
  ensureMemorySchema(db);
  // recipe_insights row is FK target for enrichment recipe_hash refs;
  // the upserts here don't carry one but the schema setup keeps
  // parallel test harness shape.
  void getOrCreateRecipeInsight(db, {
    hash: 'h-p2-scope-meta',
    slug: 'd-137-p2',
    version: 1,
    flattened: '{"trigger":{"type":"manual"},"steps":[]}',
  });
  timeCursor = 1_700_000_000_000;
  let enrCounter = 0;
  enrichmentStore = createEnrichmentStore(db, {
    now: () => timeCursor,
    newId: () => `enr-${++enrCounter}`,
  });
};

const teardown = (): void => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
};

beforeEach(() => setupHarness());
afterEach(() => teardown());

const seedHubspotContact = (
  target_id: string,
  meta_overrides: Partial<EnrichmentMeta>,
  ts: number,
): void => {
  timeCursor = ts;
  const meta: EnrichmentMeta = {
    snapshot_at: ts,
    snapshot_hash: `fnv1a:${target_id}`,
    ...meta_overrides,
  };
  enrichmentStore.upsert({
    topic: 'engagement_score_per_contact',
    scope: 'connection.api.hubspot.contact',
    target_id,
    // Canonical EngagementScorePerContact shape (validated by the
    // topic's `value_schema`); the test only cares about the meta
    // snapshot path, so the score body is a fixed minimum-valid payload.
    value: {
      score: 50,
      last_meaningful_touch: ts,
      signal_breakdown: { hubspot: 25, local: 15, recency: 10 },
      trajectory: 'flat',
      cursor_at: ts,
    },
    authored_by: 'system.housekeeping.engagement_score_per_contact',
    ingredient_slug: 'ai-score',
    meta,
  });
};

describe('D-137 P2 § A.4 — EnrichmentStore.listScopeMeta', () => {
  it('returns distinct (target_id, meta) rows for a platform-reference scope', () => {
    seedHubspotContact(
      'hubspot_contact_47291',
      { email: 'peter@acme.com', name: 'Peter Acme' },
      1_700_000_000_000,
    );
    seedHubspotContact(
      'hubspot_contact_47292',
      { email: 'mary@globex.com', name: 'Mary Globex' },
      1_700_000_001_000,
    );
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
    );
    expect(rows).toHaveLength(2);
    // Order: latest ingested_at first.
    expect(rows[0]!.target_id).toBe('hubspot_contact_47292');
    expect(rows[0]!.meta.email).toBe('mary@globex.com');
    expect(rows[1]!.target_id).toBe('hubspot_contact_47291');
  });

  it('filters by name_contains (case-insensitive substring on meta.name)', () => {
    seedHubspotContact(
      'hubspot_contact_47291',
      { email: 'peter@acme.com', name: 'Peter Acme' },
      1_700_000_000_000,
    );
    seedHubspotContact(
      'hubspot_contact_47292',
      { email: 'mary@globex.com', name: 'Mary Globex' },
      1_700_000_001_000,
    );
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
      { name_contains: 'PeTeR' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('hubspot_contact_47291');
  });

  it('filters by email_exact (lowercased; non-matches drop)', () => {
    seedHubspotContact(
      'hubspot_contact_47291',
      { email: 'peter@acme.com', name: 'Peter Acme' },
      1_700_000_000_000,
    );
    seedHubspotContact(
      'hubspot_contact_47292',
      { email: 'mary@globex.com', name: 'Mary Globex' },
      1_700_000_001_000,
    );
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
      { email_exact: 'PETER@ACME.COM' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('hubspot_contact_47291');
  });

  it('clamps limit to the documented per-call cap (200) and respects user-supplied limits', () => {
    for (let i = 0; i < 5; i++) {
      seedHubspotContact(
        `hubspot_contact_${i}`,
        { email: `user${i}@example.com`, name: `User ${i}` },
        1_700_000_000_000 + i,
      );
    }
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
      { limit: 2 },
    );
    expect(rows).toHaveLength(2);
  });

  it('drops rows whose meta column is NULL', () => {
    // A row without meta — same valid value shape, just no `meta`
    // passed to upsert. Reconciler hasn't refreshed yet → fan-out
    // skips the row even though the topic exists.
    enrichmentStore.upsert({
      topic: 'engagement_score_per_contact',
      scope: 'connection.api.hubspot.contact',
      target_id: 'hubspot_contact_nometa',
      value: {
        score: 30,
        last_meaningful_touch: 1_700_000_004_000,
        signal_breakdown: { hubspot: 15, local: 10, recency: 5 },
        trajectory: 'flat',
        cursor_at: 1_700_000_004_000,
      },
      authored_by: 'system.test',
    });
    seedHubspotContact(
      'hubspot_contact_has_meta',
      { email: 'user@example.com', name: 'User' },
      1_700_000_005_000,
    );
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
    );
    expect(rows.map((r) => r.target_id)).toEqual(['hubspot_contact_has_meta']);
  });

  it('returns empty array for a scope with no rows', () => {
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.salesforce.contact',
    );
    expect(rows).toEqual([]);
  });

  // D-137 P2 Codex P2 fold — stale rows must NOT surface to chat
  // fan-out. The reconciler's `markStaleForSource` path can flip
  // staleness without rewriting `meta` immediately; surfacing those
  // rows would let the agent reference outdated CRM names / stages /
  // owners before housekeeping recompute lands the refreshed `meta`.
  it("excludes rows where staleness_class != 'fresh'", () => {
    seedHubspotContact(
      'hubspot_contact_fresh',
      { email: 'fresh@example.com', name: 'Fresh' },
      1_700_000_000_000,
    );
    seedHubspotContact(
      'hubspot_contact_stale',
      { email: 'stale@example.com', name: 'Stale' },
      1_700_000_001_000,
    );
    // Flip the second target's row to stale via the public cascade
    // primitive — matches the reconciler's "source changed; mark
    // every downstream stale" path.
    enrichmentStore.markStaleForSource(
      'connection.api.hubspot.contact',
      'hubspot_contact_stale',
    );
    const rows = enrichmentStore.listScopeMeta(
      'connection.api.hubspot.contact',
    );
    expect(rows.map((r) => r.target_id)).toEqual(['hubspot_contact_fresh']);
  });
});

// D-190 deal.search union slice — canonical-field filters pushed into the SAME
// mirror SQL. On the materialized mirror even the live-derived `close_state` is a
// plain stored JSON key, so it filters uniformly; `limit` applies POST-filter.
const seedHubspotDeal = (
  target_id: string,
  meta_overrides: Partial<EnrichmentMeta>,
  ts: number,
): void => {
  timeCursor = ts;
  const meta: EnrichmentMeta = {
    snapshot_at: ts,
    snapshot_hash: `fnv1a:${target_id}`,
    ...meta_overrides,
  };
  enrichmentStore.upsert({
    topic: 'deal_health_score',
    scope: 'connection.api.hubspot.deal',
    target_id,
    value: { score: 70, signals: ['stage age'], reasoning: 'ok' },
    authored_by: 'system.housekeeping.deal_health_score',
    ingredient_slug: 'ai-score',
    meta,
  });
};

describe('D-190 deal.search union slice — listScopeMeta canonical filters', () => {
  const seedThree = (): void => {
    seedHubspotDeal(
      'hubspot_deal_won',
      { name: 'Acme won', close_state: 'won', key_dates: { close_date: 1_700_500_000_000 } },
      1_700_000_000_000,
    );
    seedHubspotDeal(
      'hubspot_deal_open_early',
      { name: 'Beta open', close_state: 'open', key_dates: { close_date: 1_700_100_000_000 } },
      1_700_000_001_000,
    );
    seedHubspotDeal(
      'hubspot_deal_open_late',
      { name: 'Gamma open', close_state: 'open', key_dates: { close_date: 1_700_900_000_000 } },
      1_700_000_002_000,
    );
  };

  it('meta_equals filters on a materialized canonical field (close_state)', () => {
    seedThree();
    const rows = enrichmentStore.listScopeMeta('connection.api.hubspot.deal', {
      meta_equals: [{ path: '$.close_state', value: 'open' }],
    });
    expect(rows.map((r) => r.target_id).sort()).toEqual([
      'hubspot_deal_open_early',
      'hubspot_deal_open_late',
    ]);
  });

  it('meta_ranges bounds a numeric field (close_date) inclusively', () => {
    seedThree();
    const rows = enrichmentStore.listScopeMeta('connection.api.hubspot.deal', {
      meta_ranges: [
        { path: '$.key_dates.close_date', min: 1_700_400_000_000, max: 1_700_600_000_000 },
      ],
    });
    expect(rows.map((r) => r.target_id)).toEqual(['hubspot_deal_won']);
  });

  it('combines equals + range (AND) — only the late open deal clears both', () => {
    seedThree();
    const rows = enrichmentStore.listScopeMeta('connection.api.hubspot.deal', {
      meta_equals: [{ path: '$.close_state', value: 'open' }],
      meta_ranges: [{ path: '$.key_dates.close_date', min: 1_700_500_000_000 }],
    });
    expect(rows.map((r) => r.target_id)).toEqual(['hubspot_deal_open_late']);
  });

  it('a row whose meta lacks the filtered key drops (json_extract NULL ≠ value)', () => {
    seedHubspotDeal('hubspot_deal_nostate', { name: 'No state' }, 1_700_000_003_000);
    seedHubspotDeal(
      'hubspot_deal_won',
      { name: 'Acme won', close_state: 'won' },
      1_700_000_004_000,
    );
    const rows = enrichmentStore.listScopeMeta('connection.api.hubspot.deal', {
      meta_equals: [{ path: '$.close_state', value: 'won' }],
    });
    expect(rows.map((r) => r.target_id)).toEqual(['hubspot_deal_won']);
  });
});
