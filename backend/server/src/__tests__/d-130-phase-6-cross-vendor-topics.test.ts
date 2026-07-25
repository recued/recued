/** D-130 P6 — Cross-vendor enrichment topic widening + Salesforce-flavored
 *  lifecycle_stage_inferred_salesforce topic.
 *
 *  Covers:
 *    - Registry shape for the new `lifecycle_stage_inferred_salesforce` topic.
 *    - Cross-vendor `valid_scopes` widening on `attribution_signal`,
 *      `engagement_score_per_contact`, `deal_health_score`, `deal_velocity_signal`.
 *    - `attribution_signal` kernel producer walking both HubSpot deal and
 *      Salesforce opportunity scopes (per-vendor symmetric behaviour;
 *      `salesforce_user:<id>` owner literal short-circuits like
 *      `hubspot_owner_id:<id>`).
 *    - `engagement_score_per_contact` kernel producer walking both
 *      contact scopes; per-row `signal_breakdown` field flips per scope
 *      (`hubspot` for HubSpot rows, `salesforce` for Salesforce rows;
 *      non-owning vendor field omitted, not zeroed).
 *    - `lifecycle_stage_inferred_salesforce` kernel producer (AI
 *      ai-classify) — pure helpers + cycle path + AI input threading +
 *      out-of-set stage rejection + force-layer resolution per pool
 *      policy default.
 *    - `confidence_drift_signal` registry walks the new AI-surface topic.
 *
 *  Spec: `docs/d-130-spec.md` § Phase 6 + § A.6. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  LIFECYCLE_STAGES,
  SALESFORCE_LIFECYCLE_STAGES,
  buildConnectionVendorEntity,
  confidenceEmittingEnrichmentTopics,
  getEnrichmentDefinition,
  resolveEnrichmentPoolPolicyDefault,
  resolveEnrichmentTrustDefault,
  type AttributionSignalValue,
  type ConnectionVendorEntity,
  type EngagementScorePerContactValue,
  type EnrichmentMeta,
  type LifecycleStageInferredSalesforceValue,
} from '@recued/contracts';

import {
  ATTRIBUTION_SIGNAL_AUTHORED_BY,
  ATTRIBUTION_SIGNAL_SOURCE_SCOPES,
  ATTRIBUTION_SIGNAL_TOPIC,
  ENGAGEMENT_SCORE_AUTHORED_BY,
  ENGAGEMENT_SCORE_TOPIC,
  engagementScoreSourceScopes,
  LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY,
  LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
  LIFECYCLE_STAGE_SALESFORCE_TOPIC,
  buildSalesforceLifecyclePrompt,
  buildSalesforceLifecycleSignalTokens,
  composeEngagementValue,
  processOneLifecycleStageSalesforceContact,
  resolveAttributionOwnerMailbox,
  resolveSalesforceLifecycleStageLayer,
  runAttributionSignalCycle,
  runEngagementScoreCycle,
  runLifecycleStageInferredSalesforceCycle,
} from '../housekeeping/index.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let now = 1_730_000_000_000;
let llmCalls: Array<{ manifest: unknown; input: Record<string, unknown> }>;
let llmResponses: unknown[];

const ctx = (): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  llm: vi.fn(async (manifest, input) => {
    llmCalls.push({ manifest, input });
    if (llmResponses.length === 0) {
      throw new Error('no llm response queued');
    }
    return llmResponses.shift();
  }),
  // D-136 P3 — `lifecycle_stage_inferred_salesforce` retrofit calls
  // `ctx.llmWithMeta` (audit §20.2 fix — model_id capture). Wire the
  // mock to the same llmCalls/llmResponses queue.
  llmWithMeta: vi.fn(async (manifest, input) => {
    llmCalls.push({ manifest, input });
    if (llmResponses.length === 0) {
      throw new Error('no llm response queued');
    }
    return { result: llmResponses.shift(), model_id: 'openai:gpt-4o-mini' };
  }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-130-p6-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
  now = 1_730_000_000_000;
  llmCalls = [];
  llmResponses = [];
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const seedSalesforceOpportunityMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { snapshot_at?: number; snapshot_hash?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  // Seed via deal_health_score (cross-vendor topic on the Salesforce
  // opportunity scope at D-128 P4) so the producer's DISTINCT walk
  // picks up the target_id.
  store.upsert({
    topic: 'deal_health_score',
    scope: 'connection.api.salesforce.opportunity',
    target_id,
    value: {
      score: 50,
      confidence: 0.5,
      reasoning: 'seed',
      signals: [],
    },
    authored_by: 'system.housekeeping.deal_health_score',
    meta: fullMeta,
  });
};

const seedHubSpotDealMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { snapshot_at?: number; snapshot_hash?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  store.upsert({
    topic: 'deal_health_score',
    scope: 'connection.api.hubspot.deal',
    target_id,
    value: {
      score: 50,
      confidence: 0.5,
      reasoning: 'seed',
      signals: [],
    },
    authored_by: 'system.housekeeping.deal_health_score',
    meta: fullMeta,
  });
};

const seedSalesforceContactMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { email?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  store.upsert({
    topic: 'engagement_score_per_contact',
    scope: 'connection.api.salesforce.contact',
    target_id,
    value: {
      score: 0,
      last_meaningful_touch: 0,
      signal_breakdown: { local: 0, recency: 0 },
      trajectory: 'flat',
      cursor_at: 0,
    },
    authored_by: 'system.seed',
    meta: fullMeta,
  });
};

const seedHubSpotContactMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { email?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  store.upsert({
    topic: 'engagement_score_per_contact',
    scope: 'connection.api.hubspot.contact',
    target_id,
    value: {
      score: 0,
      last_meaningful_touch: 0,
      signal_breakdown: { hubspot: 0, local: 0, recency: 0 },
      trajectory: 'flat',
      cursor_at: 0,
    },
    authored_by: 'system.seed',
    meta: fullMeta,
  });
};

// ────────────────────────────────────────────────────────────────
// Registry shape
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — registry shape', () => {
  it('lifecycle_stage_inferred_salesforce is registered with the right shape', () => {
    const def = getEnrichmentDefinition('lifecycle_stage_inferred_salesforce');
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['connection.api.salesforce.contact']);
    expect(def.policy).toBe('dependent');
    expect(def.producer_kind).toBe('housekeeping');
    // D-136 P1: emits_confidence revoked — lifecycle_stage_inferred_salesforce
    // is time_bound (real-world stage moves), so PSI conflates real-world
    // drift with model drift.
    expect(def.emits_confidence).toBeUndefined();
    expect(def.default_trust_state).toBe('manual');
    expect(def.default_pool_policy).toBe('free_then_byok');
    expect(def.tags).toContain('platform:salesforce');
    expect(def.tags).toContain('department:sales');
  });

  it('SALESFORCE_LIFECYCLE_STAGES carries the Salesforce-flavored closed list', () => {
    expect(SALESFORCE_LIFECYCLE_STAGES).toEqual([
      'lead',
      'prospect',
      'customer',
      'prior_customer',
      'partner',
      'other',
    ]);
  });

  it('SALESFORCE_LIFECYCLE_STAGES diverges from HubSpot stages (parallel topic per spec § decision 11)', () => {
    // Salesforce-only members
    expect(SALESFORCE_LIFECYCLE_STAGES).toContain('prospect');
    expect(SALESFORCE_LIFECYCLE_STAGES).toContain('prior_customer');
    expect(SALESFORCE_LIFECYCLE_STAGES).toContain('partner');
    expect(SALESFORCE_LIFECYCLE_STAGES).toContain('other');
    // HubSpot-only members must NOT appear in the Salesforce list.
    expect(SALESFORCE_LIFECYCLE_STAGES as readonly string[]).not.toContain('subscriber');
    expect(SALESFORCE_LIFECYCLE_STAGES as readonly string[]).not.toContain('mql');
    expect(SALESFORCE_LIFECYCLE_STAGES as readonly string[]).not.toContain('sql');
    expect(SALESFORCE_LIFECYCLE_STAGES as readonly string[]).not.toContain('opportunity');
    expect(SALESFORCE_LIFECYCLE_STAGES as readonly string[]).not.toContain('evangelist');
    // Shared members allowed (`lead`, `customer`).
    expect(LIFECYCLE_STAGES as readonly string[]).toContain('lead');
    expect(LIFECYCLE_STAGES as readonly string[]).toContain('customer');
  });

  it('lifecycle_stage_inferred_salesforce value schema accepts a valid stage', () => {
    const def = getEnrichmentDefinition('lifecycle_stage_inferred_salesforce');
    const result = def.value_schema({
      stage: 'prospect',
      confidence: 0.7,
      reasoning: 'multi-week two-way',
      signals: ['salesforce_label:Prospect', 'mail_window:8'],
      computed_at: now,
    });
    expect(result.ok).toBe(true);
  });

  it('lifecycle_stage_inferred_salesforce rejects an out-of-set stage', () => {
    const def = getEnrichmentDefinition('lifecycle_stage_inferred_salesforce');
    const result = def.value_schema({
      stage: 'evangelist', // HubSpot-only stage; not in Salesforce list
      confidence: 0.8,
      reasoning: 'x',
      signals: [],
      computed_at: now,
    });
    expect(result.ok).toBe(false);
  });

  // D-136 P1 retired: confidence field stripped from
  // LifecycleStageInferredSalesforceValue + emits_confidence revoked, so
  // the value schema no longer validates the field at all.

  it('confidenceEmittingEnrichmentTopics excludes lifecycle topics post-D-136', () => {
    const topics = confidenceEmittingEnrichmentTopics();
    // D-136 P1: emits_confidence revoked on time_bound topics —
    // lifecycle stages move in real-world, so PSI conflates real drift
    // with model drift. Only stable_truth topics (purpose / summary /
    // action_items) remain in the confidence-emitting list.
    expect(topics).not.toContain('lifecycle_stage_inferred_salesforce');
    expect(topics).not.toContain('lifecycle_stage_inferred');
    expect(topics).not.toContain('deal_health_score');
  });

  it('resolveEnrichmentTrustDefault honours the registry-declared default for Salesforce lifecycle topic', () => {
    expect(resolveEnrichmentTrustDefault('lifecycle_stage_inferred_salesforce', true)).toBe('manual');
  });

  it('resolveEnrichmentPoolPolicyDefault honours the free_then_byok default for Salesforce lifecycle topic', () => {
    expect(resolveEnrichmentPoolPolicyDefault('lifecycle_stage_inferred_salesforce')).toBe('free_then_byok');
  });

  it('attribution_signal valid_scopes widened to include Salesforce opportunity (D-130 P6 widening)', () => {
    const def = getEnrichmentDefinition('attribution_signal');
    expect(def.valid_scopes).toContain('connection.api.hubspot.deal');
    expect(def.valid_scopes).toContain('connection.api.salesforce.opportunity');
  });

  it('engagement_score_per_contact valid_scopes mirrors the built-in crm_alias:contact set (HubSpot + Salesforce + Pipedrive)', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    expect(def.valid_scopes).toContain('connection.api.hubspot.contact');
    expect(def.valid_scopes).toContain('connection.api.salesforce.contact');
    // D-192 S3 — Pipedrive is the 3rd built-in crm_alias:'contact' vendor; the
    // registry-driven cycle walks it, so its scope joins the static mirror.
    expect(def.valid_scopes).toContain('connection.api.pipedrive.person');
  });

  it('deal_health_score valid_scopes is cross-vendor (D-128 P4 reservation, D-130 P6 confirms)', () => {
    const def = getEnrichmentDefinition('deal_health_score');
    expect(def.valid_scopes).toContain('connection.api.hubspot.deal');
    expect(def.valid_scopes).toContain('connection.api.salesforce.opportunity');
  });

  it('deal_velocity_signal valid_scopes is cross-vendor', () => {
    const def = getEnrichmentDefinition('deal_velocity_signal');
    expect(def.valid_scopes).toContain('connection.api.hubspot.deal');
    expect(def.valid_scopes).toContain('connection.api.salesforce.opportunity');
  });

  it('engagement_score_per_contact value schema accepts Salesforce-shaped signal_breakdown (no hubspot field)', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 60,
      last_meaningful_touch: now,
      signal_breakdown: { salesforce: 25, local: 25, recency: 10 },
      trajectory: 'rising',
      cursor_at: now,
    });
    expect(result.ok).toBe(true);
  });

  it('engagement_score_per_contact value schema accepts HubSpot-shaped signal_breakdown (back-compat)', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 60,
      last_meaningful_touch: now,
      signal_breakdown: { hubspot: 25, local: 25, recency: 10 },
      trajectory: 'rising',
      cursor_at: now,
    });
    expect(result.ok).toBe(true);
  });

  it('engagement_score_per_contact value schema rejects non-numeric vendor field', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 60,
      last_meaningful_touch: now,
      signal_breakdown: { hubspot: 'thirty' as unknown, local: 25, recency: 10 },
      trajectory: 'rising',
      cursor_at: now,
    });
    expect(result.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// attribution_signal — cross-vendor cycle
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — attribution_signal cross-vendor cycle', () => {
  it('exports both HubSpot and Salesforce source scopes in the closed list', () => {
    expect(ATTRIBUTION_SIGNAL_SOURCE_SCOPES).toEqual([
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ]);
  });

  it('produces a Salesforce attribution_signal row when Salesforce opportunity meta is seeded', () => {
    const created_at = now - 5 * 24 * 60 * 60 * 1000;
    seedSalesforceOpportunityMeta('salesforce_opportunity_006A0000005XYZ', {
      name: 'Acme — Big Deal',
      key_dates: { created_at },
      owner: 'rep@acme.com',
    });
    const out = runAttributionSignalCycle(ctx());
    expect(out.produced).toBe(1);

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: 'connection.api.salesforce.opportunity',
      target_id: 'salesforce_opportunity_006A0000005XYZ',
      authored_by: ATTRIBUTION_SIGNAL_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as AttributionSignalValue;
    expect(value.first_touch_source).toBe('unknown'); // no in-window mail/calendar seeded
    expect(value.first_touch_at).toBe(created_at);
  });

  it('produces TWO rows when both HubSpot and Salesforce opportunities are seeded — one per scope', () => {
    const created_at = now - 5 * 24 * 60 * 60 * 1000;
    seedHubSpotDealMeta('hubspot_deal_42', {
      name: 'HS deal',
      key_dates: { created_at },
      owner: 'alice@acme.com',
    });
    seedSalesforceOpportunityMeta('salesforce_opportunity_006A0000005ABC', {
      name: 'SFDC opportunity',
      key_dates: { created_at },
      owner: 'alice@acme.com',
    });
    const out = runAttributionSignalCycle(ctx());
    expect(out.produced).toBe(2);

    const hsRows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: 'connection.api.hubspot.deal',
      target_id: 'hubspot_deal_42',
    });
    const sfRows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: 'connection.api.salesforce.opportunity',
      target_id: 'salesforce_opportunity_006A0000005ABC',
    });
    expect(hsRows).toHaveLength(1);
    expect(sfRows).toHaveLength(1);
  });

  it('Salesforce salesforce_user:<id> owner literal short-circuits to null mailbox (mirrors HubSpot)', () => {
    expect(resolveAttributionOwnerMailbox('salesforce_user:0050000000ABCDE')).toBeNull();
    expect(resolveAttributionOwnerMailbox('hubspot_owner_id:12345')).toBeNull();
    expect(resolveAttributionOwnerMailbox('alice@acme.com')).toBe('alice@acme.com');
  });

  it('skips a Salesforce opportunity without key_dates.created_at (defensive)', () => {
    seedSalesforceOpportunityMeta('salesforce_opportunity_no_date', {
      name: 'No Date',
    });
    const out = runAttributionSignalCycle(ctx());
    expect(out.produced).toBe(0);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
  });

  it('passes Salesforce-specific meta through on the upsert', () => {
    const created_at = now - 24 * 60 * 60 * 1000;
    seedSalesforceOpportunityMeta('salesforce_opportunity_meta_check', {
      name: 'Meta Check',
      stage: 'Prospecting',
      key_dates: { created_at },
    });
    runAttributionSignalCycle(ctx());

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: 'connection.api.salesforce.opportunity',
      target_id: 'salesforce_opportunity_meta_check',
    });
    expect(rows[0]!.meta).toMatchObject({
      name: 'Meta Check',
      stage: 'Prospecting',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// engagement_score_per_contact — cross-vendor cycle
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — engagement_score_per_contact cross-vendor cycle', () => {
  it('derives (scope, vendor) pairs from every crm_alias:contact vendor in the built-in registry (D-192 S3)', () => {
    const pairs = engagementScoreSourceScopes();
    // HubSpot + Salesforce + Pipedrive all declare `crm_alias: 'contact'`.
    expect(pairs).toContainEqual({ scope: 'connection.api.hubspot.contact', vendor: 'hubspot' });
    expect(pairs).toContainEqual({ scope: 'connection.api.salesforce.contact', vendor: 'salesforce' });
    expect(pairs).toContainEqual({ scope: 'connection.api.pipedrive.person', vendor: 'pipedrive' });
    // The `vendor` carried on each pair is the row's `signal_breakdown` key —
    // it must be the scope's own vendor segment.
    for (const { scope, vendor } of pairs) {
      expect(scope.startsWith(`connection.api.${vendor}.`)).toBe(true);
    }
  });

  it('a pack-declared CRM contact vendor joins the walk when the live registry is passed; a non-contact entity does not (D-192 de-hardcode)', () => {
    const acmeContact = buildConnectionVendorEntity({
      vendor: 'acme',
      entity: 'contact',
      display_name: 'Acme Contact',
      crm_alias: 'contact',
      meta_fields: [],
    });
    const withContact: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, acmeContact];
    expect(engagementScoreSourceScopes(withContact)).toContainEqual({
      scope: 'connection.api.acme.contact',
      vendor: 'acme',
    });

    // A pack `crm_alias: 'deal'` entity is NOT a contact scope → excluded.
    const acmeDeal = buildConnectionVendorEntity({
      vendor: 'acme',
      entity: 'deal',
      display_name: 'Acme Deal',
      crm_alias: 'deal',
      meta_fields: [],
    });
    const withDeal: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, acmeDeal];
    expect(engagementScoreSourceScopes(withDeal).some((p) => p.vendor === 'acme')).toBe(false);
  });

  it('the cycle skips a pack CRM contact vendor whose scope the store cannot yet write — fail-safe, no throw, no pack row (D-192 S4c3b gate)', () => {
    const acmeContact = buildConnectionVendorEntity({
      vendor: 'acme',
      entity: 'contact',
      display_name: 'Acme Contact',
      crm_alias: 'contact',
      meta_fields: [],
    });
    const liveRegistry: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, acmeContact];
    // `acme` IS a registry-driven candidate contact scope...
    expect(engagementScoreSourceScopes(liveRegistry)).toContainEqual({
      scope: 'connection.api.acme.contact',
      vendor: 'acme',
    });
    // ...but the DEFAULT `store` here has no live registry, so
    // `store.isScopeSupported('engagement_score_per_contact', 'connection.api.acme.contact')`
    // is false (a pack scope is writable only when the store resolves the live
    // registry — S4b). S4c3b's walk-guard fails CLOSED: the cycle skips the
    // enumerated-but-not-writable scope rather than walk-then-reject. A built-in
    // HubSpot contact still scores normally in the same run.
    seedHubSpotContactMeta('hubspot_contact_alice', {
      email: 'alice@example.com',
      recent_activity_at: now,
    });
    const out = runEngagementScoreCycle({ ...ctx(), resolveVendorRegistry: () => liveRegistry });
    expect(out.produced).toBe(1); // hubspot only — acme skipped, not rejected
    expect(
      store.list({
        topic: ENGAGEMENT_SCORE_TOPIC,
        scope: 'connection.api.acme.contact',
        authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
      }),
    ).toHaveLength(0);
  });

  it('the cycle WALKS a pack CRM contact vendor once its scope is writable from the live registry (D-192 S4c3b relaxation)', () => {
    const acmeContact = buildConnectionVendorEntity({
      vendor: 'acme',
      entity: 'contact',
      display_name: 'Acme Contact',
      crm_alias: 'contact',
      meta_fields: [],
    });
    const liveRegistry: ConnectionVendorEntity[] = [...CONNECTION_VENDOR_ENTITIES, acmeContact];
    // A store that resolves the LIVE registry → the pack contact scope is writable
    // (S4b), so `isScopeSupported` returns true and the relaxed walk-guard walks it.
    // Shares the same `db`, so it reads/writes the same tables the module `store` does.
    const registryStore = createEnrichmentStore(db, { resolveVendorRegistry: () => liveRegistry });
    registryStore.upsert({
      topic: 'engagement_score_per_contact',
      scope: 'connection.api.acme.contact',
      target_id: 'acme_contact_9',
      value: {
        score: 0,
        last_meaningful_touch: 0,
        signal_breakdown: { local: 0, recency: 0 },
        trajectory: 'flat',
        cursor_at: 0,
      },
      authored_by: 'system.seed',
      meta: {
        snapshot_at: now,
        snapshot_hash: 'fnv1a:acme_contact_9',
        email: 'buyer@acme.example',
        recent_activity_at: now - 3 * 24 * 60 * 60 * 1000,
      } as EnrichmentMeta,
    });

    const out = runEngagementScoreCycle({
      ...ctx(),
      enrichmentStore: registryStore,
      resolveVendorRegistry: () => liveRegistry,
    });
    expect(out.produced).toBe(1); // the pack (acme) contact is now scored, not skipped
    const rows = registryStore.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.acme.contact',
      target_id: 'acme_contact_9',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as EngagementScorePerContactValue;
    // The pack vendor key routes onto the (open) signal_breakdown.
    expect(value.signal_breakdown.acme).toBeGreaterThan(0);
  });

  it('scores a Pipedrive contact end-to-end, routing the `pipedrive` vendor key onto signal_breakdown (D-192 S3 — 3rd built-in CRM vendor)', () => {
    // Pipedrive (`crm_alias:'contact'`, entity `person`) is now walked by the
    // registry-driven cycle + is in the topic's valid_scopes. Seed a contact row
    // under its own platform-reference scope.
    store.upsert({
      topic: 'engagement_score_per_contact',
      scope: 'connection.api.pipedrive.person',
      target_id: 'pipedrive_person_42',
      value: {
        score: 0,
        last_meaningful_touch: 0,
        signal_breakdown: { local: 0, recency: 0 },
        trajectory: 'flat',
        cursor_at: 0,
      },
      authored_by: 'system.seed',
      meta: {
        snapshot_at: now,
        snapshot_hash: 'fnv1a:pipedrive_person_42',
        email: 'lead@pipedrive.example',
        recent_activity_at: now - 7 * 24 * 60 * 60 * 1000,
      } as EnrichmentMeta,
    });

    const out = runEngagementScoreCycle(ctx());
    expect(out.produced).toBe(1);

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.pipedrive.person',
      target_id: 'pipedrive_person_42',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as EngagementScorePerContactValue;
    // The vendor component lands under `pipedrive` — the shape + vendor-key
    // routing are both open (D-192).
    expect(value.signal_breakdown.pipedrive).toBeGreaterThan(0);
    expect(value.signal_breakdown.hubspot).toBeUndefined();
    expect(value.signal_breakdown.salesforce).toBeUndefined();
    expect(value.signal_breakdown.local).toBeDefined();
    expect(value.signal_breakdown.recency).toBeDefined();
  });

  it('Salesforce contact row carries `salesforce` field on signal_breakdown (not `hubspot`)', () => {
    seedSalesforceContactMeta('salesforce_contact_003A0000005ABC', {
      email: 'prospect@acme.com',
      recent_activity_at: now - 7 * 24 * 60 * 60 * 1000,
    });
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.salesforce.contact',
      target_id: 'salesforce_contact_003A0000005ABC',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as EngagementScorePerContactValue;
    expect(value.signal_breakdown.salesforce).toBeDefined();
    expect(value.signal_breakdown.salesforce).toBeGreaterThan(0);
    // Non-owning vendor field omitted, not zeroed.
    expect(value.signal_breakdown.hubspot).toBeUndefined();
    expect(value.signal_breakdown.local).toBeDefined();
    expect(value.signal_breakdown.recency).toBeDefined();
  });

  it('HubSpot contact row continues to carry `hubspot` field (back-compat regression check)', () => {
    seedHubSpotContactMeta('hubspot_contact_alice', {
      email: 'alice@example.com',
      recent_activity_at: now - 7 * 24 * 60 * 60 * 1000,
    });
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.hubspot.contact',
      target_id: 'hubspot_contact_alice',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as EngagementScorePerContactValue;
    expect(value.signal_breakdown.hubspot).toBeDefined();
    expect(value.signal_breakdown.hubspot).toBeGreaterThan(0);
    expect(value.signal_breakdown.salesforce).toBeUndefined();
  });

  it('produces TWO rows when both HubSpot and Salesforce contacts are seeded — one per scope', () => {
    seedHubSpotContactMeta('hubspot_contact_alice', {
      email: 'alice@example.com',
      recent_activity_at: now,
    });
    seedSalesforceContactMeta('salesforce_contact_003A0000005ABC', {
      email: 'alice@example.com',
      recent_activity_at: now,
    });
    const out = runEngagementScoreCycle(ctx());
    expect(out.produced).toBe(2);

    const hsRows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.hubspot.contact',
      target_id: 'hubspot_contact_alice',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    const sfRows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: 'connection.api.salesforce.contact',
      target_id: 'salesforce_contact_003A0000005ABC',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(hsRows).toHaveLength(1);
    expect(sfRows).toHaveLength(1);
  });

  it('composeEngagementValue with vendor_key="salesforce" puts the vendor component under `salesforce`', () => {
    const value = composeEngagementValue(
      {
        mail_recent: 5, mail_baseline: 2,
        calendar_recent: 1, calendar_baseline: 0,
        last_local_touch: now - 86400_000,
      },
      now - 7 * 86400_000,
      now,
      'salesforce',
    );
    expect(value.signal_breakdown.salesforce).toBeGreaterThan(0);
    expect(value.signal_breakdown.hubspot).toBeUndefined();
    expect(value.score).toBe(
      value.signal_breakdown.salesforce! +
        value.signal_breakdown.local +
        value.signal_breakdown.recency,
    );
  });

  it('composeEngagementValue defaults to vendor_key="hubspot" for back-compat (D-129 signature)', () => {
    const value = composeEngagementValue(
      {
        mail_recent: 5, mail_baseline: 2,
        calendar_recent: 1, calendar_baseline: 0,
        last_local_touch: now - 86400_000,
      },
      now - 7 * 86400_000,
      now,
    );
    expect(value.signal_breakdown.hubspot).toBeGreaterThan(0);
    expect(value.signal_breakdown.salesforce).toBeUndefined();
  });

  it('composeEngagementValue routes an arbitrary (pack / pipedrive) vendor_key onto signal_breakdown (D-192 open key)', () => {
    const value = composeEngagementValue(
      {
        mail_recent: 3, mail_baseline: 1,
        calendar_recent: 0, calendar_baseline: 0,
        last_local_touch: now - 86400_000,
      },
      now - 7 * 86400_000,
      now,
      'pipedrive',
    );
    expect(value.signal_breakdown.pipedrive).toBeGreaterThan(0);
    expect(value.signal_breakdown.hubspot).toBeUndefined();
    expect(value.signal_breakdown.salesforce).toBeUndefined();
    // `score` is still the sum of the (now pack-keyed) vendor component + local + recency.
    expect(value.score).toBe(
      value.signal_breakdown.pipedrive! +
        value.signal_breakdown.local +
        value.signal_breakdown.recency,
    );
  });
});

// ────────────────────────────────────────────────────────────────
// lifecycle_stage_inferred_salesforce — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — lifecycle_stage_inferred_salesforce pure helpers', () => {
  it('buildSalesforceLifecyclePrompt renders Salesforce-flavored signals', () => {
    const prompt = buildSalesforceLifecyclePrompt({
      email: 'sue@example.com',
      salesforce_lifecycle_stage: 'Prospect',
      mail_count_window: 8,
      meeting_count_window: 2,
      mean_reply_latency_ms: 7_200_000,
      role_category: 'executive',
    });
    expect(prompt).toContain('sue@example.com');
    expect(prompt).toContain('Salesforce lifecycle');
    expect(prompt).toContain('Prospect');
    expect(prompt).toContain('8');
    expect(prompt).toContain('2');
    expect(prompt).toContain('executive');
    expect(prompt).toContain('2h');
  });

  it('buildSalesforceLifecyclePrompt handles missing signals gracefully', () => {
    const prompt = buildSalesforceLifecyclePrompt({
      email: 'unknown@example.com',
      salesforce_lifecycle_stage: null,
      mail_count_window: null,
      meeting_count_window: null,
      mean_reply_latency_ms: null,
      role_category: null,
    });
    expect(prompt).toContain('unknown@example.com');
    expect(prompt).toContain('<not set>');
  });

  it('buildSalesforceLifecycleSignalTokens stamps the salesforce_label prefix (not hubspot_label)', () => {
    const tokens = buildSalesforceLifecycleSignalTokens({
      email: 'sue@example.com',
      salesforce_lifecycle_stage: 'Customer',
      mail_count_window: 4,
      meeting_count_window: 1,
      mean_reply_latency_ms: null,
      role_category: 'executive',
    });
    expect(tokens).toContain('salesforce_label:Customer');
    expect(tokens).toContain('mail_window:4');
    expect(tokens).toContain('meetings_window:1');
    expect(tokens).toContain('role:executive');
    // Never the HubSpot prefix.
    expect(tokens.some((t) => t.startsWith('hubspot_label:'))).toBe(false);
  });

  it('buildSalesforceLifecycleSignalTokens reports no_observable_signal for empty bundle', () => {
    const tokens = buildSalesforceLifecycleSignalTokens({
      email: 'noone@example.com',
      salesforce_lifecycle_stage: null,
      mail_count_window: null,
      meeting_count_window: null,
      mean_reply_latency_ms: null,
      role_category: null,
    });
    expect(tokens).toEqual(['no_observable_signal']);
  });

  it('resolveSalesforceLifecycleStageLayer defaults to any when no trustStore', () => {
    expect(resolveSalesforceLifecycleStageLayer(ctx(), undefined)).toBe('any');
  });
});

// ────────────────────────────────────────────────────────────────
// lifecycle_stage_inferred_salesforce — full cycle (AI mocked)
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — lifecycle_stage_inferred_salesforce cycle', () => {
  it('classifies a Salesforce contact and writes a row at the Salesforce scope', async () => {
    seedSalesforceContactMeta('salesforce_contact_003A0000005ABC', {
      email: 'prospect@acme.com',
      lifecycle_stage: 'Prospect',
    });
    llmResponses.push({
      category: 'customer',
      confidence: 0.78,
      reasoning: 'Sustained weekly activity; lifecycle label appears stale.',
    });
    const out = await runLifecycleStageInferredSalesforceCycle(ctx());
    expect(out.produced).toBe(1);

    const rows = store.list({
      topic: LIFECYCLE_STAGE_SALESFORCE_TOPIC,
      scope: LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
      target_id: 'salesforce_contact_003A0000005ABC',
      authored_by: LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as LifecycleStageInferredSalesforceValue;
    expect(value.stage).toBe('customer');
    // D-136 P1: confidence stripped from LifecycleStageInferredSalesforceValue (time_bound topic)
    expect(value.signals).toContain('salesforce_label:Prospect');
  });

  it('throws when the LLM returns a HubSpot stage that is out-of-set for Salesforce', async () => {
    seedSalesforceContactMeta('salesforce_contact_bad', {
      email: 'bad@external.com',
    });
    llmResponses.push({
      category: 'evangelist', // HubSpot-only stage; not in Salesforce list
      confidence: 0.9,
      reasoning: 'fake',
    });
    await expect(runLifecycleStageInferredSalesforceCycle(ctx())).rejects.toThrow(
      /lifecycle_stage_inferred_salesforce_output_invalid/,
    );
  });

  it('threads the LLM input with the Salesforce closed-set categories and force_layer', async () => {
    seedSalesforceContactMeta('salesforce_contact_threading', {
      email: 'threading@external.com',
    });
    llmResponses.push({
      category: 'lead',
      confidence: 0.5,
      reasoning: 'thin signal',
    });
    await runLifecycleStageInferredSalesforceCycle(ctx());

    expect(llmCalls).toHaveLength(1);
    const input = llmCalls[0]!.input;
    expect(input['llm.categories']).toEqual([...SALESFORCE_LIFECYCLE_STAGES]);
    expect(input['llm.context']).toContain('OBSERVED behaviour');
    expect(input['llm.context']).toContain('prior_customer'); // Salesforce-specific guidance
    expect(input['llm.model_hint']).toBe('fast');
    expect(input['llm.force_layer']).toBe('any'); // no trustStore → default
  });

  it('processOneSalesforceContact returns reason no_meta when meta_json is null', async () => {
    const result = await processOneLifecycleStageSalesforceContact(
      ctx(),
      { target_id: 'salesforce_contact_x', meta_json: null },
      'any',
    );
    expect(result.produced).toBe(false);
    expect(result.reason).toBe('no_meta');
  });

  it('processOneSalesforceContact returns reason no_email when meta lacks email', async () => {
    const result = await processOneLifecycleStageSalesforceContact(
      ctx(),
      {
        target_id: 'salesforce_contact_x',
        meta_json: JSON.stringify({ snapshot_at: now, snapshot_hash: 'h' }),
      },
      'any',
    );
    expect(result.produced).toBe(false);
    expect(result.reason).toBe('no_email');
  });

  it('passes Salesforce contact meta through on the upsert', async () => {
    seedSalesforceContactMeta('salesforce_contact_meta', {
      email: 'meta@external.com',
      lifecycle_stage: 'Customer',
    });
    llmResponses.push({
      category: 'customer',
      confidence: 0.85,
      reasoning: 'aligned',
    });
    await runLifecycleStageInferredSalesforceCycle(ctx());

    const rows = store.list({
      topic: LIFECYCLE_STAGE_SALESFORCE_TOPIC,
      scope: LIFECYCLE_STAGE_SALESFORCE_SOURCE_SCOPE,
      target_id: 'salesforce_contact_meta',
      authored_by: LIFECYCLE_STAGE_SALESFORCE_AUTHORED_BY,
    });
    expect(rows[0]!.meta).toMatchObject({
      email: 'meta@external.com',
      lifecycle_stage: 'Customer',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Sanity — task registration carries the new task at boot
// ────────────────────────────────────────────────────────────────

describe('D-130 P6 — task registration', () => {
  it('STANDALONE_TASKS includes lifecycle_stage_inferred_salesforce', async () => {
    const { STANDALONE_TASKS } = await import('../housekeeping/registration.js');
    const ids = STANDALONE_TASKS.map((t) => t.meta.id);
    expect(ids).toContain('enrichment.lifecycle_stage_inferred_salesforce');
    // Both lifecycle producers coexist.
    expect(ids).toContain('enrichment.lifecycle_stage_inferred');
  });

  it('attribution_signal + engagement_score_per_contact stay single-task (cross-vendor cycle, not parallel tasks)', async () => {
    const { STANDALONE_TASKS } = await import('../housekeeping/registration.js');
    const attribution = STANDALONE_TASKS.filter((t) => t.topic === 'attribution_signal');
    const engagement = STANDALONE_TASKS.filter((t) => t.topic === 'engagement_score_per_contact');
    expect(attribution).toHaveLength(1);
    expect(engagement).toHaveLength(1);
  });
});
