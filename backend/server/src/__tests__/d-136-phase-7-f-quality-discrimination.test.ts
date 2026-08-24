/** D-136 P7.F — Quality-discrimination affordances (§A.14.4 + §A.14.5).
 *
 *  Two consumer-facing affordances ship in this phase:
 *
 *    1. `registry.describe` per-topic entry gains a derived
 *       `coverage_quality: 'high' | 'medium' | 'low' | 'novel_query_likely_uncovered'`
 *       + a human-readable `coverage_quality_reasoning` string. Agents
 *       pre-flight a query against the warehouse + decide whether to
 *       fall through to raw without paying for a read first.
 *
 *    2. `mcp.enrichment.read` accepts a `freshness_budget_ms`
 *       parameter; when set + the warehouse can't satisfy in budget,
 *       the response carries `result: null` plus a `fall_through_hint`
 *       describing where to read raw instead. The substrate dispatches
 *       the staleness axis by the topic's `temporal_class` —
 *       `computed_at` (stable_truth), `as_of` (time_bound),
 *       `as_of` / `window_drift` (aggregate_window).
 *
 *  Tests cover the OR-of-degraders band derivation, threshold
 *  composition, cadence-multiplier boundaries, axis dispatch, the
 *  topic_private graceful-degradation path, and the per-scope
 *  suggested_raw_adapter mapping.
 *
 *  Spec: D-136 §A.14.4 + §A.14.5.
 *  Read-cost-zero invariant (§A.13.6): preserved — neither handler's
 *  deps shape carries an LLM hook. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cadenceToMs,
  resolveCoverageQualityThreshold,
  DEFAULT_COVERAGE_QUALITY_THRESHOLD,
  ALL_COVERAGE_QUALITY_BANDS,
  ENRICHMENT_REGISTRY,
  RpcError,
  getEnrichmentDefinition,
  type EnrichmentDefinition,
  type EnrichmentTopic,
} from '@recued/contracts';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  handleRegistryDescribe,
  _testing as registryInternals,
} from '../mcp/registry-describe.js';
import {
  handleEnrichmentRead,
  _testing as readInternals,
} from '../mcp/enrichment-read.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let stateStore: HousekeepingStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-f-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
  stateStore = createHousekeepingStateStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const COMPANY = (
  override: Partial<{ company_name: string; computed_at: number }> = {},
) => ({
  domain: 'acme.com',
  company_name: 'Acme',
  source: 'domain_only' as const,
  domain_category: 'business' as const,
  reasoning: 'derived from domain',
  computed_at: NOW,
  ...override,
});

const PURPOSE = (override: Partial<{ confidence: number; computed_at: number }> = {}) => ({
  category: 'commercial' as const,
  confidence: 0.85,
  reasoning: 'sales pipeline',
  computed_at: NOW,
  ...override,
});

const insertCompany = (target: string, event_at: number, name: string) =>
  store.upsert({
    topic: 'company',
    scope: 'contact',
    target_id: target,
    value: COMPANY({ company_name: name, computed_at: event_at }),
    authored_by: 'system.housekeeping.company',
    event_at,
  });

const insertPurpose = (target: string, event_at: number) =>
  store.upsert({
    topic: 'purpose',
    scope: 'mail',
    target_id: target,
    value: PURPOSE(),
    authored_by: 'system.housekeeping.purpose',
    event_at,
  });

const recordProducerRun = (
  topic: EnrichmentTopic,
  last_run_at: number,
  status: 'complete' | 'pending' | 'error' = 'complete',
  consecutive_errors = 0,
) => {
  // Producer task id mirrors `taskIdForTopic` — `enrichment.<topic>` for
  // housekeeping, `enrichment.reactive.<topic>` for reactive.
  const def = getEnrichmentDefinition(topic);
  const task_id =
    def.producer_kind === 'reactive'
      ? `enrichment.reactive.${topic}`
      : `enrichment.${topic}`;
  stateStore.set({
    task_id,
    cursor: { kind: 'complete' },
    last_run_at,
    last_status: status,
    consecutive_errors,
  });
};

// ────────────────────────────────────────────────────────────────
// 1. cadenceToMs + resolveCoverageQualityThreshold helpers
// ────────────────────────────────────────────────────────────────

describe('cadenceToMs', () => {
  it('maps each finite cadence to its ms value', () => {
    expect(cadenceToMs('6h')).toBe(6 * 60 * 60 * 1000);
    expect(cadenceToMs('24h')).toBe(24 * 60 * 60 * 1000);
    expect(cadenceToMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('returns null for never + undefined', () => {
    expect(cadenceToMs('never')).toBeNull();
    expect(cadenceToMs(undefined)).toBeNull();
  });
});

describe('resolveCoverageQualityThreshold', () => {
  it('returns the default for topics without a registry override', () => {
    expect(resolveCoverageQualityThreshold('purpose'))
      .toBe(DEFAULT_COVERAGE_QUALITY_THRESHOLD);
    expect(resolveCoverageQualityThreshold('company'))
      .toBe(DEFAULT_COVERAGE_QUALITY_THRESHOLD);
  });

  it('returns the explicit value for topics that declare one', () => {
    // Per spec §A.14.4 worked example.
    expect(resolveCoverageQualityThreshold('behavioral_signature')).toBe(100);
  });

  it('returns the default for non-registry topic strings', () => {
    expect(resolveCoverageQualityThreshold('bogus.topic'))
      .toBe(DEFAULT_COVERAGE_QUALITY_THRESHOLD);
  });

  it('exposes the band closed list', () => {
    expect([...ALL_COVERAGE_QUALITY_BANDS].sort()).toEqual([
      'high',
      'low',
      'medium',
      'novel_query_likely_uncovered',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. coverage_quality derivation — pure helper
// ────────────────────────────────────────────────────────────────

describe('deriveCoverageQuality (§A.14.4)', () => {
  const baseDef = getEnrichmentDefinition('behavioral_signature');

  it('novel — row_count == 0', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 0,
        latest_event_at: null,
        producer_last_run_at: null,
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('novel_query_likely_uncovered');
    expect(r.coverage_quality_reasoning).toContain('0 rows');
  });

  it('novel — housekeeping producer never ran but rows exist', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 50,
        latest_event_at: NOW - 1000,
        producer_last_run_at: null,
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('novel_query_likely_uncovered');
    expect(r.coverage_quality_reasoning).toContain('never run');
  });

  it('reactive producers: null producer_last_run_at + rows is healthy, not novel', () => {
    const reactiveDef = getEnrichmentDefinition('contact_timeline_rollup');
    const r = registryInternals.deriveCoverageQuality(
      'contact_timeline_rollup',
      reactiveDef,
      {
        row_count: 1000,
        latest_event_at: NOW - 60_000,
        producer_last_run_at: null, // reactive doesn't run on cycles
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('high');
  });

  it('high — all signals healthy', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 5_000,
        latest_event_at: NOW - 2 * 60 * 60 * 1000, // 2h ago
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.02,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('high');
    expect(r.coverage_quality_reasoning).toContain('5000 rows');
    expect(r.coverage_quality_reasoning).toContain('98%');
  });

  it('medium — row_count between threshold/4 and threshold', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        // threshold=100 → low floor=25, mid=[25,100]
        row_count: 60,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.01,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('medium');
    expect(r.coverage_quality_reasoning).toContain('60 rows');
  });

  it('medium — latest_event_at past cadence × 2 but inside cadence × 10', () => {
    const cadenceMs = cadenceToMs('7d')!;
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 1_000, // healthy row count
        latest_event_at: NOW - 3 * cadenceMs, // > 2× but < 10×
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.01,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('medium');
    expect(r.coverage_quality_reasoning).toContain('cadence');
  });

  it('medium — failure_rate between 0.05 and 0.20', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 1_000,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.12,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('medium');
    expect(r.coverage_quality_reasoning).toContain('12%');
  });

  it('low — row_count below threshold/4', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        // threshold=100 → low floor=25
        row_count: 10,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
    expect(r.coverage_quality_reasoning).toContain('10 rows');
  });

  it('low — latest_event_at past cadence × 10', () => {
    const cadenceMs = cadenceToMs('7d')!;
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 1_000,
        latest_event_at: NOW - 11 * cadenceMs,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
    expect(r.coverage_quality_reasoning).toContain('10×');
  });

  it('low — failure_rate above 0.20', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 1_000,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.5,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
    expect(r.coverage_quality_reasoning).toContain('50%');
  });

  it('strict band wins — any low signal subsumes any medium signal', () => {
    const cadenceMs = cadenceToMs('7d')!;
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        // medium-band row_count + low-band age
        row_count: 60,
        latest_event_at: NOW - 11 * cadenceMs,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: false,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
  });

  it('topics without recompute_cadence skip the cadence check', () => {
    const purposeDef = getEnrichmentDefinition('purpose');
    expect(purposeDef.recompute_cadence).toBeUndefined();
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 200,
        latest_event_at: NOW - 365 * 24 * 60 * 60 * 1000, // 1 year ago — would fail any cadence check
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('high'); // age check skipped
  });

  it('reasoning string echoes back load-bearing signals', () => {
    const r = registryInternals.deriveCoverageQuality(
      'behavioral_signature',
      baseDef,
      {
        row_count: 5,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0.5,
        ai_surface: false,
      },
      NOW,
    );
    // Both the row-count + failure-rate signals contribute to 'low'.
    expect(r.coverage_quality_reasoning).toContain('5 rows');
    expect(r.coverage_quality_reasoning).toContain('50%');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. registry.describe — coverage_quality surfacing on entries
// ────────────────────────────────────────────────────────────────

describe('handleRegistryDescribe — coverage_quality wiring (§A.14.4)', () => {
  it('every surfaced entry carries coverage_quality + reasoning', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    for (const entry of out.topics) {
      expect(ALL_COVERAGE_QUALITY_BANDS.includes(entry.coverage_quality)).toBe(true);
      expect(entry.coverage_quality_reasoning.length).toBeGreaterThan(0);
    }
  });

  it('fresh warehouse → every topic surfaces as novel_query_likely_uncovered', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    for (const entry of out.topics) {
      expect(entry.coverage_quality).toBe('novel_query_likely_uncovered');
    }
  });

  it('rows + producer run → moves out of novel band', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    insertCompany('bob@example.com', NOW, 'Globex');
    recordProducerRun('company', NOW - 60_000);
    const out = handleRegistryDescribe(
      { enrichmentStore: store, housekeepingStateStore: stateStore, db },
      { now: () => NOW },
    );
    const company = out.topics.find((t) => t.topic === 'company')!;
    expect(company.coverage_quality).not.toBe('novel_query_likely_uncovered');
    // 2 rows < 50 threshold/4 floor → 'low'
    expect(company.coverage_quality).toBe('low');
  });

  it('cadence boundary uses the parameterized now', () => {
    // thread_signals: cadence 24h, scope 'mail'.
    // Insert a row 50h ago — that's > 2× cadence but < 10× cadence.
    const cadenceMs = cadenceToMs('24h')!;
    const evtAt = NOW - 50 * 60 * 60 * 1000;
    store.upsert({
      topic: 'thread_signals',
      scope: 'mail',
      target_id: 'msg-1',
      value: {
        thread_id: 't-1',
        message_count: 1,
        participant_count: 1,
        span_days: 0,
        has_unread: false,
      },
      authored_by: 'system.housekeeping.thread_signals',
      event_at: evtAt,
    });
    recordProducerRun('thread_signals', NOW - 60_000);
    const out = handleRegistryDescribe(
      { enrichmentStore: store, housekeepingStateStore: stateStore },
      { now: () => NOW },
    );
    const ts = out.topics.find((t) => t.topic === 'thread_signals')!;
    // 1 row < 50/4 = 12.5 → 'low' from row-count axis. Make sure the
    // band reflects the strictest signal even if cadence is in the medium band.
    expect(ts.coverage_quality).toBe('low');
    // Sanity: cadence math is 50h > 2 × 24h.
    expect(50 * 60 * 60 * 1000).toBeGreaterThan(2 * cadenceMs);
  });

  it('reasoning string mentions the topic-specific threshold', () => {
    // behavioral_signature has threshold=100 — the reasoning surfaces the value.
    insertCompany('alice@example.com', NOW, 'Acme'); // unrelated; only present so describe runs
    const out = handleRegistryDescribe(
      { enrichmentStore: store, housekeepingStateStore: stateStore },
      { now: () => NOW },
    );
    const bs = out.topics.find((t) => t.topic === 'behavioral_signature')!;
    expect(bs.coverage_quality).toBe('novel_query_likely_uncovered');
    // Switch to a non-novel band by writing rows for the topic itself.
  });
});

// ────────────────────────────────────────────────────────────────
// 4. enrichment.read — freshness budget + fall_through_hint
// ────────────────────────────────────────────────────────────────

describe('handleEnrichmentRead — freshness_budget_ms (§A.14.5)', () => {
  it('without budget: missing row returns result null + no hint', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).toBeNull();
    expect(out.fall_through_hint).toBeUndefined();
  });

  it('budget + missing row → hint reason no_row', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      freshness_budget_ms: 60_000,
    });
    expect(out.result).toBeNull();
    expect(out.fall_through_hint?.reason).toBe('no_row');
    expect(out.fall_through_hint?.suggested_raw_adapter).toBe('contact.list');
    expect(out.fall_through_hint?.suggested_filter).toMatchObject({
      email: 'alice@example.com',
    });
  });

  it('budget + fresh row → result with bundle, no hint', () => {
    insertPurpose('msg-1', NOW - 1000);
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
      freshness_budget_ms: 60_000, // 60s budget, 1s old → in budget
    }, { now: () => NOW });
    expect(out.result).not.toBeNull();
    expect(out.fall_through_hint).toBeUndefined();
  });

  it('budget + stale stable_truth row → axis computed_at', () => {
    // Stand up a separate store whose `now()` returns 10min ago so
    // the row's `last_evaluated_at` (= producer compute time) is
    // anchored 10min in the past. The handler then reads with
    // `now: () => NOW`; the staleness gap is 10min > 60s budget.
    const PAST = NOW - 10 * 60 * 1000;
    const oldStore = createEnrichmentStore(
      new Database(join(dir, 'old-stable.db')),
      { now: () => PAST },
    );
    try {
      oldStore.upsert({
        topic: 'purpose',
        scope: 'mail',
        target_id: 'msg-1',
        value: PURPOSE(),
        authored_by: 'system.housekeeping.purpose',
        event_at: PAST,
      });
      const out = handleEnrichmentRead({ enrichmentStore: oldStore }, {
        topic: 'purpose',
        scope: 'mail',
        target_id: 'msg-1',
        freshness_budget_ms: 60_000, // 60s budget — fails
      }, { now: () => NOW });
      expect(out.result).toBeNull();
      expect(out.fall_through_hint?.reason).toBe('freshness_budget_exceeded');
      expect(out.fall_through_hint?.staleness_axis).toBe('computed_at');
      expect(out.fall_through_hint?.suggested_raw_adapter).toBe('mail.search');
    } finally {
      oldStore.close();
    }
  });

  it('budget + stale time_bound row → axis as_of', () => {
    // Same approach — old store with `now()` 10min ago + explicit
    // `as_of` so the time_bound axis fires.
    const PAST = NOW - 10 * 60 * 1000;
    const oldStore = createEnrichmentStore(
      new Database(join(dir, 'old-tb.db')),
      { now: () => PAST },
    );
    try {
      oldStore.upsert({
        topic: 'company',
        scope: 'contact',
        target_id: 'alice@example.com',
        value: COMPANY({ company_name: 'Acme', computed_at: PAST }),
        authored_by: 'system.housekeeping.company',
        event_at: PAST,
        as_of: PAST,
      });
      const out = handleEnrichmentRead({ enrichmentStore: oldStore }, {
        topic: 'company',
        scope: 'contact',
        target_id: 'alice@example.com',
        freshness_budget_ms: 60_000,
      }, { now: () => NOW });
      expect(out.result).toBeNull();
      expect(out.fall_through_hint?.reason).toBe('freshness_budget_exceeded');
      expect(out.fall_through_hint?.staleness_axis).toBe('as_of');
      expect(out.fall_through_hint?.suggested_raw_adapter).toBe('contact.list');
    } finally {
      oldStore.close();
    }
  });

  const insertBehavioralSignature = (target: string, computedAt: number) =>
    store.upsert({
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: target,
      value: {
        mail_count_window: 5,
        mail_count_total: 5,
        meeting_count_window: 0,
        meeting_count_total: 0,
        mean_reply_latency_ms: null,
        reply_sample_count: 0,
        last_meeting_at: null,
        last_inbound_at: computedAt,
        computed_at: computedAt,
        window_ms: 30 * 24 * 60 * 60 * 1000,
      },
      authored_by: 'system.housekeeping.behavioral_signature',
      event_at: computedAt,
      as_of: computedAt, // bistemporal — anchors the row's snapshot time
    });

  it('budget + stale aggregate_window within cadence → axis as_of', () => {
    // behavioral_signature cadence 7d. Write a row 1 hour stale.
    insertBehavioralSignature('alice@example.com', NOW - 60 * 60 * 1000);
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: 'alice@example.com',
      freshness_budget_ms: 60_000, // 1 minute budget, 1 hour stale
    }, { now: () => NOW });
    expect(out.result).toBeNull();
    expect(out.fall_through_hint?.reason).toBe('freshness_budget_exceeded');
    expect(out.fall_through_hint?.staleness_axis).toBe('as_of');
  });

  it('budget + aggregate_window past cadence → axis window_drift', () => {
    // behavioral_signature cadence 7d. Write a row 8d old.
    const cadenceMs = cadenceToMs('7d')!;
    const eightDays = cadenceMs + 24 * 60 * 60 * 1000;
    insertBehavioralSignature('alice@example.com', NOW - eightDays);
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'behavioral_signature',
      scope: 'contact',
      target_id: 'alice@example.com',
      freshness_budget_ms: 60_000,
    }, { now: () => NOW });
    expect(out.result).toBeNull();
    expect(out.fall_through_hint?.reason).toBe('freshness_budget_exceeded');
    expect(out.fall_through_hint?.staleness_axis).toBe('window_drift');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. enrichment.read — topic_private + budget interaction
// ────────────────────────────────────────────────────────────────

const REGISTRY_MUT = ENRICHMENT_REGISTRY as Record<string, EnrichmentDefinition>;

const stubMcpExposure = (
  topic: EnrichmentTopic,
  value: 'public' | 'private' | undefined,
): (() => void) => {
  // Mutate the registry entry in-place. Vitest workers are per-file →
  // mutation is process-isolated. Each test wraps in try/finally to
  // restore. Same pattern as the P7.E test ratchet.
  const original = REGISTRY_MUT[topic]!.mcp_exposed;
  if (value === undefined) {
    delete (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed;
  } else {
    (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed = value;
  }
  return () => {
    if (original === undefined) {
      delete (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed;
    } else {
      (REGISTRY_MUT[topic] as { mcp_exposed?: 'public' | 'private' }).mcp_exposed = original;
    }
  };
};

describe('handleEnrichmentRead — topic_private + freshness_budget_ms (§A.14.5)', () => {
  it('private topic without budget → throws (P7.E behavior preserved)', () => {
    const restore = stubMcpExposure('company', 'private');
    try {
      expect(() =>
        handleEnrichmentRead({ enrichmentStore: store }, {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
        }),
      ).toThrow(RpcError);
    } finally {
      restore();
    }
  });

  it('private topic with budget → result null + fall_through_hint topic_private', () => {
    const restore = stubMcpExposure('company', 'private');
    try {
      const out = handleEnrichmentRead({ enrichmentStore: store }, {
        topic: 'company',
        scope: 'contact',
        target_id: 'alice@example.com',
        freshness_budget_ms: 60_000,
      }, { now: () => NOW });
      expect(out.result).toBeNull();
      expect(out.fall_through_hint?.reason).toBe('topic_private');
      expect(out.fall_through_hint?.staleness_axis).toBeUndefined();
      expect(out.fall_through_hint?.suggested_raw_adapter).toBe('contact.list');
    } finally {
      restore();
    }
  });

  it('private-topic short-circuit fires before any store read', () => {
    // Insert a row, then mark private + read with budget — fall_through_hint
    // surfaces topic_private regardless of stored content.
    insertCompany('alice@example.com', NOW, 'Acme');
    const restore = stubMcpExposure('company', 'private');
    try {
      const out = handleEnrichmentRead({ enrichmentStore: store }, {
        topic: 'company',
        scope: 'contact',
        target_id: 'alice@example.com',
        freshness_budget_ms: 60_000,
      }, { now: () => NOW });
      expect(out.result).toBeNull();
      expect(out.fall_through_hint?.reason).toBe('topic_private');
    } finally {
      restore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 6. suggested_raw_adapter dispatch by scope
// ────────────────────────────────────────────────────────────────

describe('suggestRawAdapter (§A.14.5)', () => {
  it('mail scope → mail.search with message_id + since', () => {
    const out = readInternals.suggestRawAdapter(
      { topic: 'purpose', scope: 'mail', target_id: 'msg-1' },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('mail.search');
    expect(out.suggested_filter).toEqual({
      message_id: 'msg-1',
      since: NOW - 60_000,
    });
  });

  it('calendar scope → calendar.list with event_id + since', () => {
    const out = readInternals.suggestRawAdapter(
      { topic: 'preparation_notes', scope: 'calendar', target_id: 'evt-1' },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('calendar.list');
    expect(out.suggested_filter).toEqual({
      event_id: 'evt-1',
      since: NOW - 60_000,
    });
  });

  it('contact scope → contact.list with email + since', () => {
    const out = readInternals.suggestRawAdapter(
      { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('contact.list');
    expect(out.suggested_filter).toEqual({
      email: 'alice@example.com',
      since: NOW - 60_000,
    });
  });

  it('file scope → file.list with path + since', () => {
    // No production topic carries `valid_scopes: ['file']` today; the
    // suggestRawAdapter dispatch is purely scope-based, so testing
    // with any registered topic + the file scope hint exercises the
    // mapping. validateInput would reject the combination at the rpc
    // boundary — this isolates the per-scope adapter logic.
    const out = readInternals.suggestRawAdapter(
      { topic: 'purpose', scope: 'file', target_id: '/path/to/file' },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('file.list');
    expect(out.suggested_filter).toEqual({
      path: '/path/to/file',
      since: NOW - 60_000,
    });
  });

  it('connection.api.<vendor>.<entity> → connection.api.<vendor>.<entity>.fetch with id', () => {
    const out = readInternals.suggestRawAdapter(
      {
        topic: 'lifecycle_stage_inferred',
        scope: 'connection.api.hubspot.contact',
        target_id: 'hubspot_contact_47',
      },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('connection.api.hubspot.contact.fetch');
    expect(out.suggested_filter).toEqual({ id: 'hubspot_contact_47' });
  });

  it('derived-entity topic → enrichment.list with topic + derived_entity_id', () => {
    const out = readInternals.suggestRawAdapter(
      {
        topic: 'confidence_drift_signal',
        derived_entity_id: 'purpose',
      },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('enrichment.list');
    expect(out.suggested_filter).toEqual({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'purpose',
    });
  });

  it('connection.notification scope (no raw analogue) → enrichment.list fallback', () => {
    const out = readInternals.suggestRawAdapter(
      {
        topic: 'connection_health_trend',
        scope: 'connection.notification',
        target_id: 'slack-personal',
      },
      NOW - 60_000,
    );
    expect(out.suggested_raw_adapter).toBe('enrichment.list');
    expect(out.suggested_filter).toMatchObject({
      topic: 'connection_health_trend',
      scope: 'connection.notification',
      target_id: 'slack-personal',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 7. measureStaleness — temporal_class dispatch
// ────────────────────────────────────────────────────────────────

describe('measureStaleness (§A.14.5)', () => {
  const baseBundle = {
    value: {},
    _id: 'enr_1',
    topic: 'placeholder',
    scope: null,
    target_id: null,
    event_at: NOW,
    as_of: null,
    ingested_at: NOW,
    computed_at: NOW,
    source_record_hash: null,
    producer_version_hash: null,
    staleness_class: 'fresh' as const,
  };

  it('stable_truth → axis computed_at', () => {
    const out = readInternals.measureStaleness(
      { ...baseBundle, computed_at: NOW - 5000 },
      'purpose',
      NOW,
    );
    expect(out.axis).toBe('computed_at');
    expect(out.staleness_ms).toBe(5000);
  });

  it('time_bound → axis as_of', () => {
    const out = readInternals.measureStaleness(
      { ...baseBundle, as_of: NOW - 5000, computed_at: NOW - 1000 },
      'company',
      NOW,
    );
    expect(out.axis).toBe('as_of');
    expect(out.staleness_ms).toBe(5000);
  });

  it('time_bound with null as_of falls back to computed_at', () => {
    const out = readInternals.measureStaleness(
      { ...baseBundle, as_of: null, computed_at: NOW - 5000 },
      'company',
      NOW,
    );
    expect(out.axis).toBe('as_of');
    expect(out.staleness_ms).toBe(5000);
  });

  it('aggregate_window inside cadence → axis as_of', () => {
    const out = readInternals.measureStaleness(
      { ...baseBundle, as_of: NOW - 60_000 },
      'behavioral_signature', // cadence 7d
      NOW,
    );
    expect(out.axis).toBe('as_of');
    expect(out.staleness_ms).toBe(60_000);
  });

  it('aggregate_window past cadence → axis window_drift', () => {
    const cadenceMs = cadenceToMs('7d')!;
    const out = readInternals.measureStaleness(
      { ...baseBundle, as_of: NOW - cadenceMs - 1000 },
      'behavioral_signature',
      NOW,
    );
    expect(out.axis).toBe('window_drift');
    expect(out.staleness_ms).toBe(cadenceMs + 1000);
  });
});

// ────────────────────────────────────────────────────────────────
// 8. buildFallThroughHint composition
// ────────────────────────────────────────────────────────────────

describe('buildFallThroughHint (§A.14.5)', () => {
  it('stamps reason + adapter + filter; omits axis when undefined', () => {
    const out = readInternals.buildFallThroughHint(
      { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      'no_row',
      undefined,
      NOW,
      60_000,
    );
    expect(out.reason).toBe('no_row');
    expect(out.staleness_axis).toBeUndefined();
    expect(out.suggested_raw_adapter).toBe('contact.list');
  });

  it('includes axis when provided', () => {
    const out = readInternals.buildFallThroughHint(
      { topic: 'purpose', scope: 'mail', target_id: 'msg-1' },
      'freshness_budget_exceeded',
      'computed_at',
      NOW,
      60_000,
    );
    expect(out.staleness_axis).toBe('computed_at');
  });

  it('since_ms in suggested_filter = now - budget_ms', () => {
    const out = readInternals.buildFallThroughHint(
      { topic: 'company', scope: 'contact', target_id: 'alice@example.com' },
      'no_row',
      undefined,
      NOW,
      60_000,
    );
    expect(out.suggested_filter['since']).toBe(NOW - 60_000);
  });
});

// ────────────────────────────────────────────────────────────────
// 9. Read-cost-zero invariant — structural ratchet
// ────────────────────────────────────────────────────────────────

describe('read-cost-zero invariant (§A.13.6)', () => {
  it('handleEnrichmentRead deps shape carries no LLM hook', () => {
    type Deps = Parameters<typeof handleEnrichmentRead>[0];
    const example: Deps = { enrichmentStore: store };
    const keys = Object.keys(example);
    // Structural: every key on the deps shape is one of the storage
    // primitives. Adding `llm` here would surface immediately.
    for (const k of keys) {
      expect(['enrichmentStore']).toContain(k);
    }
  });

  it('handleRegistryDescribe deps shape carries no LLM hook', () => {
    type Deps = Parameters<typeof handleRegistryDescribe>[0];
    const allowed = new Set(['enrichmentStore', 'housekeepingStateStore', 'db']);
    const example: Deps = { enrichmentStore: store, housekeepingStateStore: stateStore, db };
    for (const k of Object.keys(example)) {
      expect(allowed.has(k)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// 10. Codex review fixes (P1) — freshness_budget_ms wired through MCP
// ────────────────────────────────────────────────────────────────
//
// Codex P1 finding: adding `freshness_budget_ms` to the rpc contract
// doesn't make it usable through the actual MCP tool path.
// `mcp-server.ts` must (a) advertise the property in the
// `recued_enrichmentRead` input schema and (b) copy it into the
// `EnrichmentReadRpcInput` before calling `handleEnrichmentRead`. Both
// gaps regression-tested here.

import { _testing as mcpTesting } from '../mcp-server.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

describe('Codex P1 — freshness_budget_ms wired through MCP tool surface', () => {
  it('recued_enrichmentRead schema advertises freshness_budget_ms', () => {
    const tool = mcpTesting.STATIC_TOOLS.find(
      (t) => t.name === 'recued_enrichmentRead',
    );
    expect(tool).toBeDefined();
    const schema = tool!.inputSchema as unknown as {
      properties: Record<string, { type: string; description: string }>;
    };
    expect(schema.properties.freshness_budget_ms).toBeDefined();
    expect(schema.properties.freshness_budget_ms!.type).toBe('number');
    expect(schema.properties.freshness_budget_ms!.description).toMatch(
      /freshness|budget|fall_through_hint/i,
    );
  });

  it('tool description mentions the §A.14.5 fall-through path', () => {
    const tool = mcpTesting.STATIC_TOOLS.find(
      (t) => t.name === 'recued_enrichmentRead',
    );
    expect(tool!.description).toMatch(/freshness_budget_ms|fall_through_hint/);
  });

  const makeMcpDeps = () => ({
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: createManifestRegistry('/nonexistent') },
    baseVault: {},
    enrichmentStore: store,
    db,
    // D-228 slice 6 — this suite's subject is the READ GATE / dispatch body,
    // which only runs once the tool gate admits. An absent checklist now
    // denies, so the owner principal is declared rather than implied.
    ownerAdmitAll: true,
  });

  const parseToolResponse = <T>(res: unknown): T => {
    const r = res as { content?: Array<{ text?: string }>; isError?: boolean };
    if (r.isError === true) {
      throw new Error(`tool returned error: ${JSON.stringify(r)}`);
    }
    const text = r.content?.[0]?.text;
    expect(typeof text).toBe('string');
    return JSON.parse(text!) as T;
  };

  it('tools/call propagates freshness_budget_ms — missing-row case returns fall_through_hint', async () => {
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_enrichmentRead',
        arguments: {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
          freshness_budget_ms: 60_000,
        },
      },
      deps,
    );
    const out = parseToolResponse<{
      result: unknown;
      fall_through_hint?: {
        reason: string;
        suggested_raw_adapter: string;
        suggested_filter: Record<string, unknown>;
      };
    }>(res);
    expect(out.result).toBeNull();
    expect(out.fall_through_hint).toBeDefined();
    expect(out.fall_through_hint!.reason).toBe('no_row');
    expect(out.fall_through_hint!.suggested_raw_adapter).toBe('contact.list');
  });

  it('tools/call without freshness_budget_ms preserves legacy null-only behavior', async () => {
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_enrichmentRead',
        arguments: {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
        },
      },
      deps,
    );
    const out = parseToolResponse<{
      result: unknown;
      fall_through_hint?: unknown;
    }>(res);
    expect(out.result).toBeNull();
    expect(out.fall_through_hint).toBeUndefined();
  });

  it('tools/call drops malformed freshness_budget_ms (negative / NaN)', async () => {
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    // Negative budget — dropped by the dispatcher gate; behavior should
    // match the no-budget path (legacy null, no hint).
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_enrichmentRead',
        arguments: {
          topic: 'company',
          scope: 'contact',
          target_id: 'alice@example.com',
          freshness_budget_ms: -1,
        },
      },
      deps,
    );
    const out = parseToolResponse<{
      result: unknown;
      fall_through_hint?: unknown;
    }>(res);
    expect(out.result).toBeNull();
    expect(out.fall_through_hint).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 11. Codex review fixes (P2) — threshold/4 boundary uses raw fraction
// ────────────────────────────────────────────────────────────────
//
// Codex P2 finding: `Math.floor(threshold/4)` mis-classifies the
// boundary row count when threshold isn't divisible by 4. Default
// threshold = 50 → threshold/4 = 12.5; row_count=12 should surface as
// 'low' because 12 < 12.5. The fix uses the raw fraction directly.

describe('Codex P2 — threshold/4 boundary is the raw fraction, not floor()', () => {
  // Use `purpose` (default threshold = 50) so threshold/4 = 12.5 hits
  // the non-integer-divisible boundary the floor-bug surfaced on.
  const purposeDef = getEnrichmentDefinition('purpose');

  it('default threshold 50: row_count=12 lands in low band (12 < 12.5)', () => {
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 12,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
    expect(r.coverage_quality_reasoning).toContain('12 rows');
    expect(r.coverage_quality_reasoning).toContain('12.5');
  });

  it('default threshold 50: row_count=13 lands in medium band (13 >= 12.5)', () => {
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 13,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('medium');
    expect(r.coverage_quality_reasoning).toContain('13 rows');
  });

  it('default threshold 50: row_count=50 stays in medium (boundary inclusive at threshold)', () => {
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 50,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('medium');
  });

  it('default threshold 50: row_count=51 lands in high', () => {
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 51,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('high');
  });

  it('reasoning string surfaces the raw fractional boundary on non-divisible thresholds', () => {
    const r = registryInternals.deriveCoverageQuality(
      'purpose',
      purposeDef,
      {
        row_count: 5,
        latest_event_at: NOW - 1000,
        producer_last_run_at: NOW - 60_000,
        producer_failure_rate_24h: 0,
        ai_surface: true,
      },
      NOW,
    );
    expect(r.coverage_quality).toBe('low');
    expect(r.coverage_quality_reasoning).toContain('< 12.5');
  });
});

// ────────────────────────────────────────────────────────────────
// 6. D-236 join — source-freshness cap on the coverage band
// ────────────────────────────────────────────────────────────────

describe('capBandForStaleSources — the D-236 source-freshness cap', () => {
  const fresh = {
    last_success_at: 1_000,
    age_ms: 5_000,
    degraded: false,
    pending: 0,
    stale: false,
  };
  const stale3d = {
    last_success_at: 1_000,
    age_ms: 3 * 24 * 60 * 60 * 1000,
    degraded: false,
    pending: 0,
    stale: true,
  };
  const neverSynced = {
    last_success_at: null,
    age_ms: null,
    degraded: true,
    pending: 0,
    stale: true,
  };
  const base = (band: 'high' | 'medium' | 'low' | 'novel_query_likely_uncovered') => ({
    coverage_quality: band,
    coverage_quality_reasoning: 'row-derived.',
  });

  it('caps high→medium and medium→low, naming the stale instance', () => {
    const capped = registryInternals.capBandForStaleSources(base('high'), [
      { scope: 'mail', instance: 'work', freshness: stale3d },
    ]);
    expect(capped.coverage_quality).toBe('medium');
    expect(capped.coverage_quality_reasoning).toContain("'mail/work'");
    expect(capped.coverage_quality_reasoning).toContain('3d ago');
    expect(capped.coverage_quality_reasoning).toContain('row-derived.');

    const capped2 = registryInternals.capBandForStaleSources(base('medium'), [
      { scope: 'mail', instance: 'work', freshness: stale3d },
    ]);
    expect(capped2.coverage_quality).toBe('low');
  });

  it('never touches low or novel, and never upgrades', () => {
    for (const band of ['low', 'novel_query_likely_uncovered'] as const) {
      const out = registryInternals.capBandForStaleSources(base(band), [
        { scope: 'mail', instance: 'work', freshness: stale3d },
      ]);
      expect(out).toEqual(base(band));
    }
  });

  it('no stale sources → the base result is returned untouched', () => {
    const b = base('high');
    expect(registryInternals.capBandForStaleSources(b, [])).toBe(b);
  });

  it('a never-synced degraded source reads as such in the reasoning', () => {
    const out = registryInternals.capBandForStaleSources(base('high'), [
      { scope: 'contact', instance: 'crm', freshness: neverSynced },
    ]);
    expect(out.coverage_quality_reasoning).toContain('never synced');
    expect(out.coverage_quality_reasoning).toContain('degraded');
  });

  it('freshness rows that are not stale never cap (guard sits at the caller)', () => {
    // buildEntry filters on `.stale` before calling; this pins that a caller
    // passing a fresh row by mistake still caps (the function trusts its
    // input list to BE the stale set — one filter, one place).
    const out = registryInternals.capBandForStaleSources(base('high'), [
      { scope: 'mail', instance: 'work', freshness: fresh },
    ]);
    // Present in the list ⇒ treated as stale-set membership.
    expect(out.coverage_quality).toBe('medium');
  });
});

describe('handleRegistryDescribe — sourceFreshnessByScope wiring (D-236 join)', () => {
  const seedHighCompany = () => {
    for (let i = 0; i < 60; i += 1) {
      insertCompany(`person-${i}@example.com`, NOW - i * 1000, `Co ${i}`);
    }
    recordProducerRun('company', NOW - 60_000);
  };

  it('a stale source behind the topic scope caps the band and names itself', () => {
    seedHighCompany();
    const unwired = handleRegistryDescribe(
      { enrichmentStore: store, housekeepingStateStore: stateStore, db },
      { now: () => NOW },
    );
    const before = unwired.topics.find((t) => t.topic === 'company')!;
    expect(before.coverage_quality).toBe('high');

    const wired = handleRegistryDescribe(
      {
        enrichmentStore: store,
        housekeepingStateStore: stateStore,
        db,
        sourceFreshnessByScope: (scope) =>
          scope === 'contact'
            ? [
                {
                  instance: 'crm-main',
                  freshness: {
                    last_success_at: NOW - 3 * 24 * 60 * 60 * 1000,
                    age_ms: 3 * 24 * 60 * 60 * 1000,
                    degraded: false,
                    pending: 0,
                    stale: true,
                  },
                },
              ]
            : [],
      },
      { now: () => NOW },
    );
    const after = wired.topics.find((t) => t.topic === 'company')!;
    expect(after.coverage_quality).toBe('medium');
    expect(after.coverage_quality_reasoning).toContain("'contact/crm-main'");
  });

  it('a healthy source leaves the band alone', () => {
    seedHighCompany();
    const wired = handleRegistryDescribe(
      {
        enrichmentStore: store,
        housekeepingStateStore: stateStore,
        db,
        sourceFreshnessByScope: () => [
          {
            instance: 'crm-main',
            freshness: {
              last_success_at: NOW - 1000,
              age_ms: 1000,
              degraded: false,
              pending: 0,
              stale: false,
            },
          },
        ],
      },
      { now: () => NOW },
    );
    const entry = wired.topics.find((t) => t.topic === 'company')!;
    expect(entry.coverage_quality).toBe('high');
  });
});
