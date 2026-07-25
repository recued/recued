/** D-129 P6 — HubSpot-flavored housekeeping topics.
 *
 *  Covers the three new producer modules:
 *    - `attribution_signal` (deterministic SQL, deal scope)
 *    - `engagement_score_per_contact` (deterministic SQL, contact scope)
 *    - `lifecycle_stage_inferred` (AI ai-classify, contact scope)
 *
 *  Plus the registry shape itself — every new entry's value-schema
 *  validator + default trust / pool defaults + cascade policy. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTRIBUTION_SOURCES,
  ENRICHMENT_REGISTRY,
  LIFECYCLE_STAGES,
  confidenceEmittingEnrichmentTopics,
  getEnrichmentDefinition,
  resolveEnrichmentPoolPolicyDefault,
  resolveEnrichmentTrustDefault,
  type AttributionSignalValue,
  type EngagementScorePerContactValue,
  type EnrichmentMeta,
  type LifecycleStageInferredValue,
} from '@recued/contracts';

import {
  ATTRIBUTION_SIGNAL_AUTHORED_BY,
  ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
  ATTRIBUTION_SIGNAL_TOPIC,
  ATTRIBUTION_WINDOW_MS,
  ENGAGEMENT_SCORE_AUTHORED_BY,
  ENGAGEMENT_SCORE_SOURCE_SCOPE,
  ENGAGEMENT_SCORE_TOPIC,
  LIFECYCLE_STAGE_AUTHORED_BY,
  LIFECYCLE_STAGE_SOURCE_SCOPE,
  LIFECYCLE_STAGE_TOPIC,
  buildAttributionSignalTokens,
  buildLifecyclePrompt,
  buildLifecycleSignalTokens,
  composeEngagementValue,
  decideAttribution,
  decideEngagementTrajectory,
  engagementDecayScore,
  engagementVolumeScore,
  processOneLifecycleStageContact,
  resolveAttributionOwnerMailbox,
  resolveLifecycleStageLayer,
  runAttributionSignalCycle,
  runEngagementScoreCycle,
  runLifecycleStageInferredCycle,
  tallyAttributionWindowActivity,
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
  // D-136 P3 — `lifecycle_stage_inferred` retrofit calls
  // `ctx.llmWithMeta` (audit §20.2 fix — model_id capture). Wire the
  // mock to the same llmCalls/llmResponses queue so existing test
  // expectations (call count, input shape) keep working.
  llmWithMeta: vi.fn(async (manifest, input) => {
    llmCalls.push({ manifest, input });
    if (llmResponses.length === 0) {
      throw new Error('no llm response queued');
    }
    return { result: llmResponses.shift(), model_id: 'openai:gpt-4o-mini' };
  }),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-129-p6-'));
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

const seedDealMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { snapshot_at?: number; snapshot_hash?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  // Seed via deal_health_score (a registered topic on the deal scope) —
  // matches the d-128-p5 timeline test fixture pattern. The producer's
  // walk reads from `data_enrichment WHERE scope = ?`, so any topic
  // backed by the same scope materialises a row the producer can pick
  // up. After the run, the producer writes its OWN topic on top.
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

const seedContactMeta = (
  target_id: string,
  meta: Partial<EnrichmentMeta> & { email?: string },
): void => {
  const fullMeta: EnrichmentMeta = {
    snapshot_at: meta.snapshot_at ?? now,
    snapshot_hash: meta.snapshot_hash ?? `fnv1a:${target_id}`,
    ...meta,
  };
  // Seed via deal_velocity_signal — wait, that's deal scope. Use a
  // different placeholder: the cross-vendor `engagement_score_per_contact`
  // topic itself can seed since the producer overwrites its own row.
  // Cleaner: write a seed row with the (now-old) shape but the producer
  // re-emits with the spec shape. Simpler still — use a synthetic
  // marker topic. Sticking with the SAME topic is fine because the
  // producer is the upserter; tests verify the OUTPUT shape.
  //
  // NOTE: Using `engagement_score_per_contact` as the seed because the
  // producer overwrites the row anyway — matches the same pattern used
  // by D-133's drift signal (which seeds + overwrites its own topic).
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

const seedMailRow = (
  table_suffix: string,
  received_at: number,
  hot_fields: Record<string, unknown>,
): void => {
  const table = `collection_mail_${table_suffix}`;
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    record_id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    hot_fields TEXT NOT NULL,
    body_inline TEXT,
    blob_hash TEXT
  )`);
  db.prepare(
    `INSERT INTO "${table}" (record_id, received_at, hot_fields)
       VALUES (?, ?, ?)`,
  ).run(`m-${received_at}-${Math.random().toString(36).slice(2, 6)}`, received_at, JSON.stringify(hot_fields));
};

const seedCalendarRow = (
  table_suffix: string,
  start_at: number,
  hot_fields: Record<string, unknown>,
): void => {
  const table = `collection_calendar_${table_suffix}`;
  db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (
    record_id TEXT PRIMARY KEY,
    start_at INTEGER NOT NULL,
    hot_fields TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT INTO "${table}" (record_id, start_at, hot_fields)
       VALUES (?, ?, ?)`,
  ).run(`c-${start_at}-${Math.random().toString(36).slice(2, 6)}`, start_at, JSON.stringify(hot_fields));
};

const seedBehavioralSignature = (
  email: string,
  values: { mail_count_window?: number; meeting_count_window?: number; mean_reply_latency_ms?: number | null },
): void => {
  store.upsert({
    topic: 'behavioral_signature',
    scope: 'contact',
    target_id: email,
    value: {
      mail_count_window: values.mail_count_window ?? 0,
      mail_count_total: values.mail_count_window ?? 0,
      meeting_count_window: values.meeting_count_window ?? 0,
      meeting_count_total: values.meeting_count_window ?? 0,
      mean_reply_latency_ms: values.mean_reply_latency_ms ?? null,
      reply_sample_count: 0,
      last_meeting_at: null,
      last_inbound_at: null,
      computed_at: now,
      window_ms: 30 * 24 * 60 * 60 * 1000,
    },
    authored_by: 'system.housekeeping.behavioral_signature',
  });
};

const seedRoleEnrichment = (email: string, category: string): void => {
  store.upsert({
    topic: 'role',
    scope: 'contact',
    target_id: email,
    value: {
      title: 'CEO',
      category,
      confidence: 0.85,
      reasoning: 'seed',
      computed_at: now,
    },
    authored_by: 'system.housekeeping.role',
  });
};

// ────────────────────────────────────────────────────────────────
// Registry shape
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — registry shape', () => {
  it('lifecycle_stage_inferred is registered with the right shape', () => {
    const def = getEnrichmentDefinition('lifecycle_stage_inferred');
    expect(def.shape).toBe('per_record');
    expect(def.valid_scopes).toEqual(['connection.api.hubspot.contact']);
    expect(def.policy).toBe('dependent');
    expect(def.producer_kind).toBe('housekeeping');
    // D-136 P1: emits_confidence revoked — lifecycle_stage_inferred is
    // time_bound (real-world stage moves), so PSI conflates real-world
    // drift with model drift.
    expect(def.emits_confidence).toBeUndefined();
    expect(def.default_trust_state).toBe('manual');
    expect(def.default_pool_policy).toBe('free_then_byok');
    expect(def.tags).toContain('platform:hubspot');
  });

  it('attribution_signal is registered with the right shape (cross-vendor at D-130)', () => {
    const def = getEnrichmentDefinition('attribution_signal');
    expect(def.shape).toBe('per_record');
    // D-130 P6 widened from HubSpot-only to cross-vendor.
    expect(def.valid_scopes).toEqual([
      'connection.api.hubspot.deal',
      'connection.api.salesforce.opportunity',
    ]);
    expect(def.policy).toBe('dependent');
    expect(def.producer_kind).toBe('housekeeping');
    expect(def.emits_confidence).toBeUndefined();
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
    // Cross-vendor topics drop the per-vendor tag — no `platform:hubspot`.
    expect(def.tags).not.toContain('platform:hubspot');
    expect(def.tags).toContain('department:sales');
  });

  it('engagement_score_per_contact carries the spec-§A.6 value shape', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 70,
      last_meaningful_touch: now,
      signal_breakdown: { hubspot: 30, local: 25, recency: 15 },
      trajectory: 'rising',
      cursor_at: now,
    });
    expect(result.ok).toBe(true);
    expect(def.default_trust_state).toBe('auto');
    expect(def.default_pool_policy).toBe('free_only');
  });

  it('engagement_score_per_contact rejects a missing signal_breakdown', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 70,
      last_meaningful_touch: now,
      trajectory: 'rising',
      cursor_at: now,
    });
    expect(result.ok).toBe(false);
  });

  it('engagement_score_per_contact rejects an unknown trajectory', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: 70,
      last_meaningful_touch: now,
      signal_breakdown: { hubspot: 30, local: 25, recency: 15 },
      trajectory: 'oscillating',
      cursor_at: now,
    });
    expect(result.ok).toBe(false);
  });

  it('lifecycle_stage_inferred rejects an out-of-set stage', () => {
    const def = getEnrichmentDefinition('lifecycle_stage_inferred');
    const result = def.value_schema({
      stage: 'champion',
      confidence: 0.8,
      reasoning: 'x',
      signals: [],
      computed_at: now,
    });
    expect(result.ok).toBe(false);
  });

  it('attribution_signal rejects an out-of-set source', () => {
    const def = getEnrichmentDefinition('attribution_signal');
    const result = def.value_schema({
      first_touch_source: 'word_of_mouth',
      first_touch_at: now,
      first_touch_channel: 'unknown',
      signals: [],
      computed_at: now,
    });
    expect(result.ok).toBe(false);
  });

  // D-136 P1 retired: confidence field stripped from
  // LifecycleStageInferredValue + emits_confidence revoked, so the
  // value schema no longer validates the field at all.

  it('confidenceEmittingEnrichmentTopics excludes lifecycle_stage_inferred (D-136 P1)', () => {
    const topics = confidenceEmittingEnrichmentTopics();
    // D-136 P1: emits_confidence revoked on time_bound topics.
    expect(topics).not.toContain('lifecycle_stage_inferred');
    expect(topics).not.toContain('attribution_signal');
    expect(topics).not.toContain('engagement_score_per_contact');
  });

  it('resolveEnrichmentTrustDefault honours the registry-declared defaults', () => {
    expect(resolveEnrichmentTrustDefault('lifecycle_stage_inferred', true)).toBe('manual');
    expect(resolveEnrichmentTrustDefault('attribution_signal', false)).toBe('auto');
    expect(resolveEnrichmentTrustDefault('engagement_score_per_contact', false)).toBe('auto');
  });

  it('resolveEnrichmentPoolPolicyDefault honours the registry-declared defaults', () => {
    expect(resolveEnrichmentPoolPolicyDefault('lifecycle_stage_inferred')).toBe('free_then_byok');
    expect(resolveEnrichmentPoolPolicyDefault('attribution_signal')).toBe('free_only');
    expect(resolveEnrichmentPoolPolicyDefault('engagement_score_per_contact')).toBe('free_only');
  });

  it('LIFECYCLE_STAGES + ATTRIBUTION_SOURCES match registered closed lists', () => {
    expect(LIFECYCLE_STAGES).toEqual([
      'subscriber', 'lead', 'mql', 'sql', 'opportunity', 'customer', 'evangelist',
    ]);
    expect(ATTRIBUTION_SOURCES).toEqual([
      'cold_outbound', 'inbound_inquiry', 'referral', 'event', 'unknown',
    ]);
  });

  it('lifecycle_stage_inferred remains HubSpot-only (parallel topic per vendor at D-130)', () => {
    // D-130 P6 ships `lifecycle_stage_inferred_salesforce` as a parallel
    // topic — closed-list value.stage enums diverge between vendors so
    // widening scope would break either side. The HubSpot-flavored
    // topic keeps its `platform:hubspot` tag; cross-vendor topics
    // (`attribution_signal`, `engagement_score_per_contact`) shed it.
    expect(ENRICHMENT_REGISTRY.lifecycle_stage_inferred.tags).toContain('platform:hubspot');
    expect(ENRICHMENT_REGISTRY.attribution_signal.tags).not.toContain('platform:hubspot');
    expect(ENRICHMENT_REGISTRY.engagement_score_per_contact.tags).not.toContain('platform:hubspot');
  });
});

// ────────────────────────────────────────────────────────────────
// attribution_signal — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — attribution_signal pure helpers', () => {
  it('decideAttribution prefers inbound mail', () => {
    const out = decideAttribution({
      inbound_count: 2, outbound_count: 5, meeting_count: 1, earliest_at: 100,
    });
    expect(out.first_touch_source).toBe('inbound_inquiry');
    expect(out.first_touch_channel).toBe('email');
  });

  it('decideAttribution falls to event when only meetings', () => {
    const out = decideAttribution({
      inbound_count: 0, outbound_count: 0, meeting_count: 3, earliest_at: 100,
    });
    expect(out.first_touch_source).toBe('event');
    expect(out.first_touch_channel).toBe('meeting');
  });

  it('decideAttribution returns cold_outbound when only outbound mail', () => {
    const out = decideAttribution({
      inbound_count: 0, outbound_count: 4, meeting_count: 0, earliest_at: 100,
    });
    expect(out.first_touch_source).toBe('cold_outbound');
    expect(out.first_touch_channel).toBe('email');
  });

  it('decideAttribution returns unknown for empty tally', () => {
    const out = decideAttribution({
      inbound_count: 0, outbound_count: 0, meeting_count: 0, earliest_at: null,
    });
    expect(out.first_touch_source).toBe('unknown');
    expect(out.first_touch_channel).toBe('unknown');
  });

  it('buildAttributionSignalTokens reports counts in priority order', () => {
    const tokens = buildAttributionSignalTokens({
      inbound_count: 3, outbound_count: 2, meeting_count: 1, earliest_at: 100,
    });
    expect(tokens[0]).toBe('inbound_count_window:3');
    expect(tokens).toContain('meeting_count_window:1');
    expect(tokens).toContain('outbound_count_window:2');
  });

  it('buildAttributionSignalTokens reports no_window_activity when empty', () => {
    const tokens = buildAttributionSignalTokens({
      inbound_count: 0, outbound_count: 0, meeting_count: 0, earliest_at: null,
    });
    expect(tokens).toEqual(['no_window_activity']);
  });

  it('resolveAttributionOwnerMailbox returns null for unresolved hubspot ids', () => {
    expect(resolveAttributionOwnerMailbox('hubspot_owner_id:12345')).toBeNull();
  });

  it('resolveAttributionOwnerMailbox returns canonical email for resolved owners', () => {
    expect(resolveAttributionOwnerMailbox('Alice@Example.COM')).toBe('alice@example.com');
  });

  it('tallyWindowActivity counts inbound/outbound based on owner mailbox match', () => {
    const tally = tallyAttributionWindowActivity(
      [
        { received_at: 100, from_email: 'alice@acme.com' },
        { received_at: 200, from_email: 'prospect@external.com' },
        { received_at: 300, from_email: 'alice@acme.com' },
      ],
      [{ start_at: 250 }],
      'alice@acme.com',
    );
    expect(tally.outbound_count).toBe(2);
    expect(tally.inbound_count).toBe(1);
    expect(tally.meeting_count).toBe(1);
    expect(tally.earliest_at).toBe(100);
  });

  it('tallyWindowActivity treats every mail as inbound when owner mailbox is null', () => {
    const tally = tallyAttributionWindowActivity(
      [
        { received_at: 100, from_email: 'alice@acme.com' },
        { received_at: 200, from_email: 'bob@acme.com' },
      ],
      [],
      null,
    );
    expect(tally.inbound_count).toBe(2);
    expect(tally.outbound_count).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// attribution_signal — full cycle
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — attribution_signal cycle', () => {
  it('produces an inbound_inquiry row from a mail-rich window', () => {
    const created_at = now - 5 * 24 * 60 * 60 * 1000;
    seedDealMeta('hubspot_deal_42', {
      name: 'Big Deal',
      key_dates: { created_at },
      owner: 'alice@acme.com',
    });
    // Inbound mail before deal creation
    seedMailRow('work', created_at - 2 * 24 * 60 * 60 * 1000, {
      from: 'prospect@external.com', to: 'alice@acme.com',
    });
    const out = runAttributionSignalCycle(ctx());
    expect(out.produced).toBe(1);

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
      target_id: 'hubspot_deal_42',
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as AttributionSignalValue;
    expect(value.first_touch_source).toBe('inbound_inquiry');
    expect(value.first_touch_channel).toBe('email');
    expect(value.first_touch_at).toBe(created_at - 2 * 24 * 60 * 60 * 1000);
    expect(rows[0]!.authored_by).toBe(ATTRIBUTION_SIGNAL_AUTHORED_BY);
  });

  it('falls back to created_at when no in-window activity exists', () => {
    const created_at = now - 5 * 24 * 60 * 60 * 1000;
    seedDealMeta('hubspot_deal_lonely', {
      key_dates: { created_at },
    });
    runAttributionSignalCycle(ctx());

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
      target_id: 'hubspot_deal_lonely',
    });
    const value = rows[0]!.value as AttributionSignalValue;
    expect(value.first_touch_source).toBe('unknown');
    expect(value.first_touch_at).toBe(created_at);
    expect(value.signals).toEqual(['no_window_activity']);
  });

  it('skips deals without key_dates.created_at', () => {
    seedDealMeta('hubspot_deal_no_create', { name: 'No Date' });
    const out = runAttributionSignalCycle(ctx());
    expect(out.produced).toBe(0);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
  });

  it('passes meta through on the upsert', () => {
    const created_at = now - 24 * 60 * 60 * 1000;
    seedDealMeta('hubspot_deal_meta_check', {
      name: 'Meta Check',
      stage: 'closedwon',
      key_dates: { created_at },
    });
    runAttributionSignalCycle(ctx());

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
      target_id: 'hubspot_deal_meta_check',
    });
    expect(rows[0]!.meta).toMatchObject({
      name: 'Meta Check',
      stage: 'closedwon',
    });
  });

  it('respects the look-back window — activity outside is ignored', () => {
    const created_at = now - 365 * 24 * 60 * 60 * 1000; // a year ago
    seedDealMeta('hubspot_deal_old', { key_dates: { created_at } });
    // Mail one year before deal creation (well outside window).
    seedMailRow('work', created_at - 2 * ATTRIBUTION_WINDOW_MS, {
      from: 'prospect@external.com',
    });
    runAttributionSignalCycle(ctx());

    const rows = store.list({
      topic: ATTRIBUTION_SIGNAL_TOPIC,
      scope: ATTRIBUTION_SIGNAL_SOURCE_SCOPE,
      target_id: 'hubspot_deal_old',
    });
    const value = rows[0]!.value as AttributionSignalValue;
    expect(value.first_touch_source).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────
// engagement_score_per_contact — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — engagement_score pure helpers', () => {
  it('decayScore returns 0 for null timestamp', () => {
    expect(engagementDecayScore(null, now, 30 * 86400_000, 40)).toBe(0);
  });

  it('decayScore halves at the half-life', () => {
    const half_life = 30 * 86400_000;
    expect(engagementDecayScore(now - half_life, now, half_life, 40)).toBeCloseTo(20, 5);
  });

  it('decayScore matches cap at zero elapsed', () => {
    expect(engagementDecayScore(now, now, 30 * 86400_000, 40)).toBe(40);
  });

  it('volumeScore saturates at the cap', () => {
    expect(engagementVolumeScore(100, 20, 40)).toBe(40);
    expect(engagementVolumeScore(10, 20, 40)).toBe(20);
    expect(engagementVolumeScore(0, 20, 40)).toBe(0);
  });

  it('decideEngagementTrajectory returns flat for thin samples', () => {
    expect(decideEngagementTrajectory(0, 1)).toBe('flat');
  });

  it('decideEngagementTrajectory returns rising at 1.5x baseline rate', () => {
    // baseline 60d total = 4 events → 30d-equivalent = 2; recent 30d = 3
    // ratio = 3 / 2 = 1.5 → rising
    expect(decideEngagementTrajectory(3, 4)).toBe('rising');
  });

  it('decideEngagementTrajectory returns falling at 0.5x baseline rate', () => {
    // baseline 60d = 8 events → 30d-equiv = 4; recent 30d = 2 → ratio 0.5 → falling
    expect(decideEngagementTrajectory(2, 8)).toBe('falling');
  });

  it('decideEngagementTrajectory returns rising on first activity (no baseline)', () => {
    expect(decideEngagementTrajectory(3, 0)).toBe('rising');
  });

  it('composeEngagementValue decomposes score into the three components', () => {
    const v = composeEngagementValue(
      {
        mail_recent: 10, mail_baseline: 5,
        calendar_recent: 4, calendar_baseline: 2,
        last_local_touch: now - 86400_000, // 1d ago
      },
      now - 7 * 86400_000, // hubspot 1 week ago
      now,
    );
    // composeEngagementValue defaults to vendor_key='hubspot' for back-compat
    // with the D-129 single-vendor signature; D-130 widened the
    // signal_breakdown to optional vendor fields, so non-null assertions
    // here track the runtime guarantee from the default-vendor path.
    expect(v.signal_breakdown.hubspot).toBeGreaterThan(0);
    expect(v.signal_breakdown.local).toBeGreaterThan(0);
    expect(v.signal_breakdown.recency).toBeGreaterThan(0);
    expect(v.score).toBe(
      v.signal_breakdown.hubspot! + v.signal_breakdown.local + v.signal_breakdown.recency,
    );
    expect(v.score).toBeLessThanOrEqual(100);
  });

  it('composeEngagementValue clamps score to [0, 100]', () => {
    const v = composeEngagementValue(
      {
        mail_recent: 1000, mail_baseline: 1000,
        calendar_recent: 100, calendar_baseline: 100,
        last_local_touch: now,
      },
      now,
      now,
    );
    expect(v.score).toBeLessThanOrEqual(100);
    expect(v.score).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────
// engagement_score_per_contact — full cycle
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — engagement_score cycle', () => {
  it('joins HubSpot meta with local mail/calendar via canonical email', () => {
    seedContactMeta('hubspot_contact_alice', {
      email: 'alice@external.com',
      recent_activity_at: now - 5 * 86400_000,
    });
    // Recent activity (last 30d): 5 mail + 2 meetings
    for (let i = 0; i < 5; i += 1) {
      seedMailRow('work', now - (i + 1) * 86400_000, {
        from: 'alice@external.com', subject: `note ${i}`,
      });
    }
    for (let i = 0; i < 2; i += 1) {
      seedCalendarRow('work', now - (i + 2) * 86400_000, {
        attendees: ['alice@external.com', 'me@acme.com'],
      });
    }
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: ENGAGEMENT_SCORE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_alice',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as EngagementScorePerContactValue;
    expect(value.signal_breakdown.local).toBeGreaterThan(0);
    expect(value.signal_breakdown.hubspot).toBeGreaterThan(0);
    expect(value.signal_breakdown.recency).toBeGreaterThan(0);
    expect(value.score).toBeGreaterThan(0);
    expect(value.last_meaningful_touch).toBeGreaterThan(0);
  });

  it('marks contacts with no local activity as low-local', () => {
    seedContactMeta('hubspot_contact_bob', {
      email: 'bob@external.com',
      recent_activity_at: now - 60 * 86400_000, // 60d ago
    });
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: ENGAGEMENT_SCORE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_bob',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    const value = rows[0]!.value as EngagementScorePerContactValue;
    expect(value.signal_breakdown.local).toBe(0);
  });

  it('falling trajectory when recent activity drops vs baseline', () => {
    seedContactMeta('hubspot_contact_drop', {
      email: 'drop@external.com',
      recent_activity_at: now,
    });
    // Recent 30d: 1 mail. Baseline 30-90d: 8 mails.
    seedMailRow('work', now - 5 * 86400_000, { from: 'drop@external.com' });
    for (let i = 0; i < 8; i += 1) {
      seedMailRow('work', now - (40 + i) * 86400_000, { from: 'drop@external.com' });
    }
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: ENGAGEMENT_SCORE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_drop',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    const value = rows[0]!.value as EngagementScorePerContactValue;
    expect(value.trajectory).toBe('falling');
  });

  it('skips contacts whose meta lacks email', () => {
    seedContactMeta('hubspot_contact_no_email', {});
    const out = runEngagementScoreCycle(ctx());
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: ENGAGEMENT_SCORE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_no_email',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(0);
  });

  it('passes meta through on the upsert', () => {
    seedContactMeta('hubspot_contact_meta', {
      email: 'meta@external.com',
      lifecycle_stage: 'lead',
    });
    runEngagementScoreCycle(ctx());

    const rows = store.list({
      topic: ENGAGEMENT_SCORE_TOPIC,
      scope: ENGAGEMENT_SCORE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_meta',
      authored_by: ENGAGEMENT_SCORE_AUTHORED_BY,
    });
    expect(rows[0]!.meta).toMatchObject({ email: 'meta@external.com', lifecycle_stage: 'lead' });
  });
});

// ────────────────────────────────────────────────────────────────
// lifecycle_stage_inferred — pure helpers
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — lifecycle_stage_inferred pure helpers', () => {
  it('buildLifecyclePrompt includes every available signal', () => {
    const prompt = buildLifecyclePrompt({
      email: 'sue@example.com',
      hubspot_lifecycle_stage: 'lead',
      mail_count_window: 12,
      meeting_count_window: 3,
      mean_reply_latency_ms: 7_200_000,
      role_category: 'executive',
    });
    expect(prompt).toContain('sue@example.com');
    expect(prompt).toContain('HubSpot lifecyclestage');
    expect(prompt).toContain('12');
    expect(prompt).toContain('3');
    expect(prompt).toContain('executive');
    expect(prompt).toContain('2h'); // 7.2M ms = 2h
  });

  it('buildLifecyclePrompt handles missing signals gracefully', () => {
    const prompt = buildLifecyclePrompt({
      email: 'unknown@example.com',
      hubspot_lifecycle_stage: null,
      mail_count_window: null,
      meeting_count_window: null,
      mean_reply_latency_ms: null,
      role_category: null,
    });
    expect(prompt).toContain('unknown@example.com');
    expect(prompt).toContain('<not set>');
  });

  it('buildLifecycleSignalTokens reflects available inputs', () => {
    const tokens = buildLifecycleSignalTokens({
      email: 'sue@example.com',
      hubspot_lifecycle_stage: 'lead',
      mail_count_window: 12,
      meeting_count_window: 3,
      mean_reply_latency_ms: 7_200_000,
      role_category: 'executive',
    });
    expect(tokens).toContain('hubspot_label:lead');
    expect(tokens).toContain('mail_window:12');
    expect(tokens).toContain('meetings_window:3');
    expect(tokens).toContain('role:executive');
  });

  it('buildLifecycleSignalTokens reports no_observable_signal for empty bundle', () => {
    const tokens = buildLifecycleSignalTokens({
      email: 'noone@example.com',
      hubspot_lifecycle_stage: null,
      mail_count_window: null,
      meeting_count_window: null,
      mean_reply_latency_ms: null,
      role_category: null,
    });
    expect(tokens).toEqual(['no_observable_signal']);
  });

  it('resolveLifecycleStageLayer defaults to any when no trustStore', () => {
    expect(resolveLifecycleStageLayer(ctx(), undefined)).toBe('any');
  });
});

// ────────────────────────────────────────────────────────────────
// lifecycle_stage_inferred — full cycle (AI mocked)
// ────────────────────────────────────────────────────────────────

describe('D-129 P6 — lifecycle_stage_inferred cycle', () => {
  it('classifies a contact and writes a row', async () => {
    seedContactMeta('hubspot_contact_alice', {
      email: 'alice@external.com',
      lifecycle_stage: 'lead',
    });
    seedBehavioralSignature('alice@external.com', {
      mail_count_window: 12, meeting_count_window: 3,
    });
    seedRoleEnrichment('alice@external.com', 'executive');

    llmResponses.push({
      category: 'opportunity',
      confidence: 0.82,
      reasoning: 'High two-way activity; HubSpot lead label is stale.',
    });
    const out = await runLifecycleStageInferredCycle(ctx());
    expect(out.produced).toBe(1);

    const rows = store.list({
      topic: LIFECYCLE_STAGE_TOPIC,
      scope: LIFECYCLE_STAGE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_alice',
      authored_by: LIFECYCLE_STAGE_AUTHORED_BY,
    });
    expect(rows).toHaveLength(1);
    const value = rows[0]!.value as LifecycleStageInferredValue;
    expect(value.stage).toBe('opportunity');
    // D-136 P1: confidence stripped from LifecycleStageInferredValue (time_bound topic)
    expect(value.signals).toContain('hubspot_label:lead');
    expect(value.signals).toContain('mail_window:12');
  });

  it('throws when the LLM returns an out-of-set stage', async () => {
    seedContactMeta('hubspot_contact_bad', { email: 'bad@external.com' });
    llmResponses.push({
      category: 'champion',
      confidence: 0.9,
      reasoning: 'fake',
    });
    await expect(runLifecycleStageInferredCycle(ctx())).rejects.toThrow(/output_invalid/);
  });

  it('threads the LLM input with categories and force_layer', async () => {
    seedContactMeta('hubspot_contact_threading', { email: 'threading@external.com' });
    llmResponses.push({
      category: 'lead',
      confidence: 0.5,
      reasoning: 'thin signal',
    });
    await runLifecycleStageInferredCycle(ctx());

    expect(llmCalls).toHaveLength(1);
    const input = llmCalls[0]!.input;
    expect(input['llm.categories']).toEqual([...LIFECYCLE_STAGES]);
    expect(input['llm.context']).toContain('OBSERVED behaviour');
    expect(input['llm.model_hint']).toBe('fast');
    expect(input['llm.force_layer']).toBe('any');
  });

  it('processOneContact returns reason no_meta when meta_json is null', async () => {
    const result = await processOneLifecycleStageContact(
      ctx(),
      { target_id: 'hubspot_contact_x', meta_json: null },
      'any',
    );
    expect(result.produced).toBe(false);
    expect(result.reason).toBe('no_meta');
  });

  it('processOneContact returns reason no_email when meta lacks email', async () => {
    const result = await processOneLifecycleStageContact(
      ctx(),
      {
        target_id: 'hubspot_contact_x',
        meta_json: JSON.stringify({ snapshot_at: now, snapshot_hash: 'h' }),
      },
      'any',
    );
    expect(result.produced).toBe(false);
    expect(result.reason).toBe('no_email');
  });

  it('writes ingredient_slug = ai-classify on the row', async () => {
    seedContactMeta('hubspot_contact_model', { email: 'model@external.com' });
    llmResponses.push({ category: 'lead', confidence: 0.6, reasoning: 'r' });
    await runLifecycleStageInferredCycle(ctx());

    const rows = store.list({
      topic: LIFECYCLE_STAGE_TOPIC,
      scope: LIFECYCLE_STAGE_SOURCE_SCOPE,
      target_id: 'hubspot_contact_model',
      authored_by: LIFECYCLE_STAGE_AUTHORED_BY,
    });
    expect(rows[0]!.ingredient_slug).toBe('ai-classify');
  });
});
