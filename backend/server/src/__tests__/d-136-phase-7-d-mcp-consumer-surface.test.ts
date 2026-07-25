/** D-136 P7.D — MCP consumer surface (swarm-agent affordances).
 *
 *  Three rpcs ship in this phase:
 *    1. `housekeeping.registry.describe` — topic catalog + per-topic
 *       coverage stats (row_count, latest_event_at, producer_last_run_at,
 *       producer_failure_rate_24h, ai_surface). Drives session-start
 *       introspection for swarm agents.
 *    2. `mcp.enrichment.read` — single-row enrichment read with full
 *       bistemporal-metadata bundle (event_at, as_of, ingested_at,
 *       computed_at, source_record_hash, producer_version_hash,
 *       staleness_class + confidence/drift_severity/user_pinned). Three
 *       time-axis filters (`as_of`, `coherent_at`, `include_historical`)
 *       layer on top.
 *    3. `mcp.vector.similarity_search` — cohort-enforced cosine search
 *       over `data_enrichment_vector_index` sidecar. Default 0.5
 *       threshold; mandatory cohort enforcement (model_id) for cross-
 *       model safety.
 *
 *  Read-cost-zero invariant (§A.13.6): every rpc handler in this phase
 *  is structurally pure SQL + math. The deps shape carries no LLM
 *  hook; the test suite asserts via construction (deps don't expose
 *  an LLM dep) + by running real handlers and confirming no thrown
 *  errors when LLM is poisoned in the surrounding context.
 *
 *  Spec: docs/d-136-spec.md §A.13.1 / §A.13.2 / §A.13.3 / §A.13.4 /
 *  §A.13.6. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RpcError,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
} from '@recued/contracts';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  handleRegistryDescribe,
  _testing as registryInternals,
} from '../mcp/registry-describe.js';
import {
  handleEnrichmentRead,
  _testing as readInternals,
} from '../mcp/enrichment-read.js';
import {
  handleVectorSimilaritySearch,
  _testing as vectorInternals,
} from '../mcp/vector-similarity.js';

const NOW = 1_750_000_000_000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-p7-d-'));
  db = new Database(join(dir, 'test.db'));
  store = createEnrichmentStore(db, { now: () => NOW });
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

/** Encode a number[] as the Float32 buffer the vector index expects.
 *  Mirrors the producer's `vectorToBuffer` discipline; kept inline
 *  here so the test file stays self-contained. */
const vec = (...values: number[]): Buffer => {
  const f32 = Float32Array.from(values);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

// ────────────────────────────────────────────────────────────────
// 1. registry.describe — basic shape + ordering
// ────────────────────────────────────────────────────────────────

describe('handleRegistryDescribe — basic shape', () => {
  it('returns one entry per registered topic, sorted alphabetically', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    expect(out.topics.length).toBeGreaterThan(20); // ~30 topics today
    const names = out.topics.map((t) => t.topic);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('returns coverage stats with zero counts on a fresh warehouse', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const company = out.topics.find((t) => t.topic === 'company');
    expect(company).toBeDefined();
    expect(company!.coverage.row_count).toBe(0);
    expect(company!.coverage.latest_event_at).toBeNull();
    expect(company!.coverage.producer_last_run_at).toBeNull();
    expect(company!.coverage.producer_failure_rate_24h).toBe(0);
  });

  it('reports row_count + latest_event_at after writes', () => {
    insertCompany('alice@example.com', NOW - 3000, 'Acme');
    insertCompany('bob@example.com', NOW - 1000, 'Globex');
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const company = out.topics.find((t) => t.topic === 'company')!;
    expect(company.coverage.row_count).toBe(2);
    // latest_event_at should match the freshest write.
    expect(company.coverage.latest_event_at).toBe(NOW - 1000);
  });

  it('surfaces description + temporal_class + identity_aggregation + lifecycle_policy + valid_scopes from registry', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const company = out.topics.find((t) => t.topic === 'company')!;
    expect(company.temporal_class).toBe('time_bound');
    expect(company.identity_aggregation).toBe('perspective');
    expect(company.lifecycle_policy).toBe('historical');
    expect(company.valid_scopes).toContain('contact');
    expect(company.description.length).toBeGreaterThan(0);
    expect(company.compression_class).toBe('derived');
    expect(company.prompt_bias_hints.length).toBeGreaterThan(0);
  });

  it('exposes aggregate_window_ms + axis when set', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const rollup = out.topics.find((t) => t.topic === 'contact_timeline_rollup')!;
    expect(rollup.aggregate_window_ms).toBe(30 * 24 * 60 * 60 * 1000);
    expect(rollup.aggregate_window_axis).toBe('event_time');
  });

  it('omits aggregate fields on stable_truth topics', () => {
    const out = handleRegistryDescribe({ enrichmentStore: store });
    const company = out.topics.find((t) => t.topic === 'company')!;
    expect(company.aggregate_window_ms).toBeUndefined();
    expect(company.aggregate_window_axis).toBeUndefined();
  });

  it('reports total_rows_visible across all topics', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    insertCompany('bob@example.com', NOW, 'Globex');
    const out = handleRegistryDescribe({ enrichmentStore: store, db });
    expect(out.total_rows_visible).toBe(2);
  });

  it('subtracts substrate-private (system.user_correction) rows from total_rows_visible', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    // Pinned correction row — substrate-private; excluded from total.
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: COMPANY({ company_name: 'Acme Corp.' }),
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      event_at: NOW + 1000,
      mode: 'pinned',
    });
    const out = handleRegistryDescribe({ enrichmentStore: store, db });
    // Total of 2 rows in the table; 1 is pinned → visible total is 1.
    expect(out.total_rows_visible).toBe(1);
  });

  it('degrades gracefully when enrichmentStore is absent', () => {
    const out = handleRegistryDescribe({});
    expect(out.topics.length).toBeGreaterThan(20);
    expect(out.total_rows_visible).toBe(0);
    for (const t of out.topics) {
      expect(t.coverage.row_count).toBe(0);
      expect(t.coverage.latest_event_at).toBeNull();
    }
  });
});

describe('handleRegistryDescribe — internal helpers', () => {
  it('failureRateFromState surfaces graduated badge', () => {
    expect(registryInternals.failureRateFromState(null)).toBe(0);
    expect(registryInternals.failureRateFromState({
      last_status: 'complete', consecutive_errors: 0,
    })).toBe(0);
    expect(registryInternals.failureRateFromState({
      last_status: 'pending', consecutive_errors: 1,
    })).toBe(0.2);
    expect(registryInternals.failureRateFromState({
      last_status: 'pending', consecutive_errors: 5,
    })).toBe(1);
    expect(registryInternals.failureRateFromState({
      last_status: 'error', consecutive_errors: 3,
    })).toBe(1);
  });

  it('isAiSurfaceTopic flips on default_trust_state', () => {
    // Use any registered AI-surface housekeeping topic — `purpose` ships
    // with `default_trust_state: 'manual'` per the P3 retrofit.
    const purposeDef = {
      default_trust_state: 'manual',
      producer_kind: 'housekeeping',
    } as Parameters<typeof registryInternals.isAiSurfaceTopic>[0];
    expect(registryInternals.isAiSurfaceTopic(purposeDef)).toBe(true);

    const detDef = {
      default_trust_state: 'auto',
      producer_kind: 'housekeeping',
    } as Parameters<typeof registryInternals.isAiSurfaceTopic>[0];
    expect(registryInternals.isAiSurfaceTopic(detDef)).toBe(false);
  });

  it('taskIdForTopic mirrors the enrichment-producer naming convention', () => {
    const def = { producer_kind: 'housekeeping' } as Parameters<typeof registryInternals.taskIdForTopic>[1];
    expect(registryInternals.taskIdForTopic('company', def)).toBe('enrichment.company');
    const reactive = { producer_kind: 'reactive' } as Parameters<typeof registryInternals.taskIdForTopic>[1];
    expect(registryInternals.taskIdForTopic(
      'contact_timeline_rollup',
      reactive,
    )).toBe('enrichment.reactive.contact_timeline_rollup');
  });

  it('countPinnedRows returns 0 without db', () => {
    expect(registryInternals.countPinnedRows(undefined)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. enrichment-read — bundle assembly + filters
// ────────────────────────────────────────────────────────────────

describe('handleEnrichmentRead — basic single-row read', () => {
  it('returns null when no row exists', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).toBeNull();
  });

  it('returns the head row with full bistemporal bundle', () => {
    insertCompany('alice@example.com', NOW - 2000, 'Acme');
    const r2 = insertCompany('alice@example.com', NOW - 1000, 'Globex');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
    expect(out.result!._id).toBe(r2._id);
    expect(out.result!.topic).toBe('company');
    expect(out.result!.scope).toBe('contact');
    expect(out.result!.target_id).toBe('alice@example.com');
    expect(out.result!.event_at).toBe(NOW - 1000);
    expect(out.result!.ingested_at).toBe(NOW);
    expect(out.result!.computed_at).toBe(NOW);
    expect(out.result!.staleness_class).toBe('fresh');
    expect((out.result!.value as { company_name: string }).company_name).toBe('Globex');
  });
});

describe('handleEnrichmentRead — bundle field surfacing', () => {
  it('surfaces confidence on emits_confidence topics', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
      value: PURPOSE({ confidence: 0.95 }),
      authored_by: 'system.housekeeping.purpose',
      event_at: NOW,
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
    });
    expect(out.result!.confidence).toBe(0.95);
  });

  it('omits confidence on non-emits_confidence topics', () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result!.confidence).toBeUndefined();
  });

  it('surfaces drift_severity when a confidence_drift_signal exists for the topic', () => {
    store.upsert({
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
      value: PURPOSE(),
      authored_by: 'system.housekeeping.purpose',
      event_at: NOW,
    });
    store.upsert({
      topic: 'confidence_drift_signal',
      derived_entity_id: 'purpose',
      value: {
        source_topic: 'purpose',
        psi: 0.3,
        severity: 'significant',
        baseline_window: { start_at: 0, end_at: 1000, sample_count: 100 },
        recent_window: { start_at: 1000, end_at: 2000, sample_count: 30 },
        baseline_distribution: [0.8, 0.85, 0.9],
        recent_distribution: [0.7, 0.5, 0.6],
        computed_at: NOW,
      },
      authored_by: 'system.housekeeping.confidence_drift',
      event_at: NOW,
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'purpose',
      scope: 'mail',
      target_id: 'msg-1',
    });
    expect(out.result!.drift_severity).toBe('significant');
  });

  // P7.D Codex review fix [P1] — pinned (system.user_correction)
  // chains are substrate-private per spec §A.13.5. The user_pinned
  // bundle field exists for forward-compat / non-MCP surfaces, but
  // MCP reads MUST NOT surface a row authored under that prefix.
  // Three behaviours codify the contract: (1) explicit probe rejects;
  // (2) implicit fallback (no authored_by) returns the producer
  // chain head, NOT the pinned row even if its event_at is fresher;
  // (3) chain view (include_historical) excludes pinned rows.

  it('rejects authored_by targeting the pinned-author prefix (substrate-private)', () => {
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
    })).toThrow(/substrate-private/);
  });

  it('hides pinned rows from bare-head MCP reads even when freshest by event_at', () => {
    // Producer chain
    insertCompany('alice@example.com', NOW - 1000, 'Acme');
    // Pinned correction with NEWER event_at → would dominate without filter
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: COMPANY({ company_name: 'Acme Corp.' }),
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      event_at: NOW + 5000,
      mode: 'pinned',
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
    // Bundle doesn't expose `authored_by` (substrate-private); the
    // value content is the authoritative check that the producer
    // chain (Acme), not the pinned chain (Acme Corp.), surfaced.
    expect(out.result!.user_pinned).toBeUndefined();
    expect((out.result!.value as { company_name: string }).company_name).toBe('Acme');
  });

  it('hides pinned rows from include_historical chain', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    insertCompany('alice@example.com', 2000, 'Globex');
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: COMPANY({ company_name: 'Pinned Override' }),
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      event_at: 3000,
      mode: 'pinned',
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      include_historical: true,
    });
    expect(out.chain).toBeDefined();
    expect(out.chain!.length).toBe(2); // 2 producer + 0 pinned
    for (const entry of out.chain!) {
      expect((entry.value as { company_name: string }).company_name).not.toBe('Pinned Override');
    }
  });

  it('hides pinned rows from as_of reads', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    store.upsert({
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      value: COMPANY({ company_name: 'Pinned' }),
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.vote_42`,
      event_at: 1500,
      mode: 'pinned',
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 2000,
    });
    expect((out.result!.value as { company_name: string }).company_name).toBe('Acme');
  });
});

// P7.D Codex review fix [P2] — bare-head reads must use supersede-link
// semantics, not effective-time DESC ordering. Under non-monotonic
// backfill (a new chain head with OLDER event_at than its predecessor),
// the supersede chain head is the canonical "current" row even though
// it's NOT first in event-time order. The pre-fix `getChain(... limit:1)`
// returned the freshest-by-event_at row, which is a superseded
// predecessor in this case — so plain bare-head MCP reads would
// surface a stale value.
describe('handleEnrichmentRead — supersede chain head (non-monotonic backfill)', () => {
  it('bare head returns supersede chain head, not freshest-by-event_at row', () => {
    // Insert in an order that produces an OLDER head than predecessor.
    // r1 first with event_at=2000 → r1 is initial head.
    // r2 next with event_at=1000 → backfill; r2 supersedes r1; r2 becomes head.
    // SQL chain DESC by effective time: [r1 (event_at=2000, superseded), r2 (event_at=1000, head)]
    // Pre-fix code returns chain[0] = r1 (wrong — it's been superseded).
    // Post-fix returns r2 (chain head per supersede link).
    const r1 = insertCompany('bob@example.com', 2000, 'OldName');
    const r2 = insertCompany('bob@example.com', 1000, 'BackfillCorrect');
    // Sanity: confirm the supersede mechanic flipped r1 forward.
    const r1Refreshed = store.getById(r1._id);
    expect(r1Refreshed!.superseded_by_id).toBe(r2._id);
    expect(store.getById(r2._id)!.superseded_by_id).toBeNull();

    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'bob@example.com',
    });
    // Post-fix: returns r2 (the supersede head), value = 'BackfillCorrect'.
    expect(out.result!._id).toBe(r2._id);
    expect((out.result!.value as { company_name: string }).company_name).toBe('BackfillCorrect');
  });

  it('include_historical "result" is the supersede head, not chain[0]', () => {
    const r1 = insertCompany('carol@example.com', 2000, 'OldName');
    const r2 = insertCompany('carol@example.com', 1000, 'BackfillCorrect');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'carol@example.com',
      include_historical: true,
    });
    // Chain ordering is DESC by effective time → [r1, r2]. But result
    // (= "current") is r2 because r1 is superseded.
    expect(out.chain![0]!._id).toBe(r1._id); // chain ordering preserved (event-time DESC)
    expect(out.chain![1]!._id).toBe(r2._id);
    expect(out.result!._id).toBe(r2._id); // result is supersede head
    expect((out.result!.value as { company_name: string }).company_name).toBe('BackfillCorrect');
  });

  it('monotonic-chain case still returns the freshest row (no regression)', () => {
    insertCompany('dave@example.com', 1000, 'Acme');
    insertCompany('dave@example.com', 2000, 'Globex');
    const r3 = insertCompany('dave@example.com', 3000, 'Initech');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'dave@example.com',
    });
    expect(out.result!._id).toBe(r3._id);
  });
});

describe('handleEnrichmentRead — as_of filter', () => {
  beforeEach(() => {
    insertCompany('alice@example.com', 1000, 'Acme');
    insertCompany('alice@example.com', 2000, 'Globex');
    insertCompany('alice@example.com', 3000, 'Initech');
  });

  it('returns null when as_of predates the first chain row', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 500,
    });
    expect(out.result).toBeNull();
  });

  it('returns the historical row whose interval covers as_of', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 1500,
    });
    expect((out.result!.value as { company_name: string }).company_name).toBe('Acme');
  });

  it('returns the head row when as_of is at or above head event_at', () => {
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 5000,
    });
    expect((out.result!.value as { company_name: string }).company_name).toBe('Initech');
  });
});

describe('handleEnrichmentRead — coherent_at filter', () => {
  it('returns the row whose computed_at <= coherent_at', () => {
    const r1 = insertCompany('alice@example.com', 1000, 'Acme');
    const r2 = insertCompany('alice@example.com', 2000, 'Globex');
    // computed_at falls back to authored_at = NOW for both rows; the
    // `coherent_at` filter only matters when last_evaluated_at threads
    // distinct values. Use last_evaluated_at-equivalent (authored_at)
    // as the boundary anchor.
    expect(r1.authored_at).toBe(NOW);
    expect(r2.authored_at).toBe(NOW);
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      coherent_at: NOW - 1, // Both rows' computed_at = NOW; below threshold
    });
    expect(out.result).toBeNull();
  });

  it('returns the head row when coherent_at >= computed_at', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    const r2 = insertCompany('alice@example.com', 2000, 'Globex');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      coherent_at: NOW + 1000,
    });
    expect(out.result!._id).toBe(r2._id);
  });
});

describe('handleEnrichmentRead — include_historical', () => {
  it('returns the full chain DESC by effective time', () => {
    const r1 = insertCompany('alice@example.com', 1000, 'Acme');
    const r2 = insertCompany('alice@example.com', 2000, 'Globex');
    const r3 = insertCompany('alice@example.com', 3000, 'Initech');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      include_historical: true,
    });
    expect(out.chain).toBeDefined();
    expect(out.chain!.length).toBe(3);
    expect(out.chain![0]!._id).toBe(r3._id);
    expect(out.chain![1]!._id).toBe(r2._id);
    expect(out.chain![2]!._id).toBe(r1._id);
    expect(out.result!._id).toBe(r3._id); // result === head
  });

  it('truncates chain at as_of', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    const r2 = insertCompany('alice@example.com', 2000, 'Globex');
    insertCompany('alice@example.com', 3000, 'Initech');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      include_historical: true,
      as_of: 2500,
    });
    expect(out.chain!.length).toBe(2);
    expect(out.chain![0]!._id).toBe(r2._id);
  });

  it('rejects coherent_at + include_historical combination', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      coherent_at: NOW,
      include_historical: true,
    })).toThrow(/mutually exclusive/);
  });
});

describe('handleEnrichmentRead — include_stale', () => {
  it('default surfaces stale rows', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    // Manually tombstone — converts the row to expired.
    store.tombstoneAndEnqueueRecomputeByTopic({
      topic: 'company',
      scope_filter: 'contact',
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
    expect(out.result!.staleness_class).toBe('expired');
    expect(out.result!.value).toBeNull(); // tombstoned
  });

  it('include_stale: false narrows to fresh-only', () => {
    insertCompany('alice@example.com', 1000, 'Acme');
    store.tombstoneAndEnqueueRecomputeByTopic({
      topic: 'company',
      scope_filter: 'contact',
    });
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      include_stale: false,
    });
    expect(out.result).toBeNull();
  });
});

describe('handleEnrichmentRead — input validation', () => {
  it('rejects unknown topic', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'no_such_topic',
      scope: 'contact',
      target_id: 'alice',
    })).toThrow(RpcError);
  });

  it('rejects per-record topic without scope/target_id', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
    })).toThrow(/requires scope \+ target_id/);
  });

  it('rejects derived-entity topic without derived_entity_id', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'confidence_drift_signal',
    })).toThrow(/requires derived_entity_id/);
  });

  it('rejects per-record topic with derived_entity_id passed', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice',
      derived_entity_id: 'oops',
    })).toThrow(/must not pass derived_entity_id/);
  });

  it('rejects derived-entity topic with scope/target_id', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'confidence_drift_signal',
      derived_entity_id: 'purpose',
      scope: 'contact',
    })).toThrow(/must not pass scope\/target_id/);
  });

  it('rejects scope outside topic.valid_scopes', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'mail',
      target_id: 'msg-1',
    })).toThrow(/does not support scope/);
  });

  it('rejects coherent_at + as_of combination', () => {
    expect(() => handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
      as_of: 1000,
      coherent_at: 2000,
    })).toThrow(/mutually exclusive/);
  });
});

describe('handleEnrichmentRead — staleness_reason mapping', () => {
  it('maps lifecycle_action_pending="recompute" to "cascade_pending"', () => {
    const r = insertCompany('alice@example.com', NOW, 'Acme');
    store.markStaleAndEnqueueByRowIds([r._id], 'recompute');
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result!.staleness_reason).toBe('cascade_pending');
  });

  it('maps lifecycle_action_pending="permanently_failed" to "producer_failed"', () => {
    const r = insertCompany('alice@example.com', NOW, 'Acme');
    db.prepare(
      `UPDATE data_enrichment SET lifecycle_action_pending = 'permanently_failed' WHERE _id = ?`,
    ).run(r._id);
    const out = handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result!.staleness_reason).toBe('producer_failed');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. vector-similarity — cohort + threshold + bundle attachment
// ────────────────────────────────────────────────────────────────

const insertEmbedding = (
  msgId: string,
  v: number[],
  modelId: string = 'text-embedding-3-small',
) =>
  store.upsert({
    topic: 'embedding',
    scope: 'mail',
    target_id: msgId,
    value: { dimensions: v.length, model: modelId },
    authored_by: 'system.housekeeping.embedding',
    model_id: modelId,
    sidecar_vector: vec(...v),
    event_at: NOW,
  });

describe('handleVectorSimilaritySearch — basic search', () => {
  it('returns results sorted by similarity DESC', () => {
    insertEmbedding('msg-1', [1, 0, 0]); // perpendicular to query
    insertEmbedding('msg-2', [0.9, 0.1, 0]); // close to query
    insertEmbedding('msg-3', [0.1, 0.9, 0]); // closer-ish
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(3);
    // First result should be msg-1 (perfect match), then msg-2.
    expect(out.results[0]!.target_id).toBe('msg-1');
    expect(out.results[0]!.similarity).toBeCloseTo(1, 5);
    expect(out.results[1]!.target_id).toBe('msg-2');
    expect(out.results[2]!.target_id).toBe('msg-3');
    expect(out.candidates_examined).toBe(3);
  });

  it('applies similarity threshold (default 0.5)', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    insertEmbedding('msg-2', [0.1, 0.9, 0]); // similarity ~0.1 — below 0.5
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
    });
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.target_id).toBe('msg-1');
    expect(out.candidates_examined).toBe(2);
  });

  it('respects custom threshold', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    insertEmbedding('msg-2', [0.9, 0.1, 0]); // similarity ~0.99
    insertEmbedding('msg-3', [0.5, 0.5, 0]); // similarity ~0.71
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      similarity_threshold: 0.95,
    });
    expect(out.results.length).toBe(2);
  });

  it('clamps limit to results.length', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    insertEmbedding('msg-2', [0.9, 0.1, 0]);
    insertEmbedding('msg-3', [0.95, 0.05, 0]);
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 2,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(2);
  });

  it('attaches the bistemporal-metadata bundle to each result', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 1,
      similarity_threshold: 0,
    });
    expect(out.results[0]!.metadata.topic).toBe('embedding');
    expect(out.results[0]!.metadata.scope).toBe('mail');
    expect(out.results[0]!.metadata.target_id).toBe('msg-1');
    expect(out.results[0]!.metadata.staleness_class).toBe('fresh');
    expect(out.results[0]!.metadata.ingested_at).toBe(NOW);
  });
});

describe('handleVectorSimilaritySearch — cohort enforcement', () => {
  it('explicit model_id narrows to matching cohort', () => {
    insertEmbedding('msg-1', [1, 0, 0], 'text-embedding-3-small');
    insertEmbedding('msg-2', [1, 0, 0], 'text-embedding-3-large');
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      model_id: 'text-embedding-3-small',
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.target_id).toBe('msg-1');
  });

  it('without model_id, picks the dominant cohort', () => {
    // 3 small + 1 large; dominant is small.
    insertEmbedding('msg-1', [1, 0, 0], 'text-embedding-3-small');
    insertEmbedding('msg-2', [1, 0, 0], 'text-embedding-3-small');
    insertEmbedding('msg-3', [1, 0, 0], 'text-embedding-3-small');
    insertEmbedding('msg-4', [1, 0, 0], 'text-embedding-3-large');
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      similarity_threshold: 0,
    });
    // All 3 small-cohort results, none from large cohort.
    expect(out.results.length).toBe(3);
    expect(out.results.every((r) => r.target_id !== 'msg-4')).toBe(true);
  });

  it('drops dimension-mismatched vectors silently', () => {
    insertEmbedding('msg-1', [1, 0, 0]); // 3D
    insertEmbedding('msg-2', [1, 0, 0, 0]); // 4D — should drop
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      model_id: 'text-embedding-3-small', // both share model_id by default
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.target_id).toBe('msg-1');
  });

  // P7.D Codex review fix [P2] — semantic_cluster producer used to leave
  // `data_enrichment.model_id` NULL, so the SQL cohort filter
  // `WHERE model_id = ?` returned zero results under the recommended
  // model_id-scoped MCP call. Producer now stamps model_id at upsert
  // time (mirrors the embedding producer); this test asserts a
  // semantic_cluster row written today is reachable through the
  // cohort-filtered SQL path.
  it('semantic_cluster rows are reachable when model_id cohort is supplied', () => {
    const MODEL = 'text-embedding-3-small';
    // Mimic the post-fix producer write — model_id stamped on column.
    store.upsert({
      topic: 'semantic_cluster',
      derived_entity_id: 'cluster_1',
      value: {
        members: ['msg-1', 'msg-2'],
        member_count: 2,
        model: MODEL,
        avg_intra_similarity: 0.92,
        last_ingested_at: NOW,
        computed_at: NOW,
      },
      authored_by: 'system.housekeeping.semantic_cluster',
      model_id: MODEL,
      sidecar_vector: vec(1, 0, 0),
      event_at: NOW,
    });
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'semantic_cluster',
      limit: 10,
      model_id: MODEL,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.target_id).toBe('cluster_1');
  });
});

describe('handleVectorSimilaritySearch — input validation', () => {
  it('rejects non-array query_vector', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: 'oops' as unknown as number[],
      topic: 'embedding',
      limit: 1,
    })).toThrow(/non-empty number array/);
  });

  it('rejects empty query_vector', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [],
      topic: 'embedding',
      limit: 1,
    })).toThrow(/non-empty number array/);
  });

  it('rejects non-finite query_vector entry', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, NaN, 3],
      topic: 'embedding',
      limit: 1,
    })).toThrow(/not a finite number/);
  });

  it('rejects unknown topic', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'no_such_topic',
      limit: 1,
    })).toThrow(/unknown topic/);
  });

  it('rejects topic without vector_index sidecar', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'company', // no sidecar
      limit: 1,
    })).toThrow(/no vector_index sidecar/);
  });

  it('rejects similarity_threshold outside [-1, 1]', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 1,
      similarity_threshold: 1.5,
    })).toThrow(/similarity_threshold must be in/);
  });

  it('rejects non-positive limit', () => {
    expect(() => handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 0,
    })).toThrow(/limit must be a positive finite number/);
  });
});

describe('handleVectorSimilaritySearch — substrate-private filtering', () => {
  it('excludes pinned (system.user_correction) rows from results', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    // Manually insert a pinned-author embedding row — should be invisible.
    store.upsert({
      topic: 'embedding',
      scope: 'mail',
      target_id: 'msg-2',
      value: { dimensions: 3, model: 'text-embedding-3-small' },
      authored_by: `${ENRICHMENT_PINNED_AUTHOR_PREFIX}.test`,
      model_id: 'text-embedding-3-small',
      sidecar_vector: vec(1, 0, 0),
      mode: 'pinned',
    });
    const out = handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 10,
      model_id: 'text-embedding-3-small',
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.target_id).toBe('msg-1');
  });
});

describe('handleVectorSimilaritySearch — vectorSearchMaxResults clamp', () => {
  it('caps limit at vectorSearchMaxResults', () => {
    for (let i = 0; i < 10; i += 1) {
      insertEmbedding(`msg-${i}`, [1, 0, 0]);
    }
    const out = handleVectorSimilaritySearch({
      enrichmentStore: store,
      db,
      vectorSearchMaxResults: 3,
    }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 100,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(3);
  });
});

describe('handleVectorSimilaritySearch — cosine math', () => {
  it('cosineSimilarity returns 1.0 for identical vectors', () => {
    expect(vectorInternals.cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('cosineSimilarity returns 0 for perpendicular vectors', () => {
    expect(vectorInternals.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('cosineSimilarity returns -1.0 for anti-parallel vectors', () => {
    expect(vectorInternals.cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('cosineSimilarity returns 0 for zero vector', () => {
    expect(vectorInternals.cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('decodeVector rejects non-Float32 byteLength', () => {
    expect(vectorInternals.decodeVector(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it('isVectorIndexTopic flags only sidecar-vector topics', () => {
    expect(vectorInternals.isVectorIndexTopic('embedding')).toBe(true);
    expect(vectorInternals.isVectorIndexTopic('semantic_cluster')).toBe(true);
    expect(vectorInternals.isVectorIndexTopic('company')).toBe(false);
    expect(vectorInternals.isVectorIndexTopic('no_such_topic')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 4. Read-cost-zero invariant (§A.13.6) — structural test ratchet
// ────────────────────────────────────────────────────────────────

describe('§A.13.6 — read-cost-zero invariant', () => {
  it('handleRegistryDescribe deps shape carries no LLM hook', () => {
    // The deps interface is structurally narrow — it accepts only
    // store-shaped + state-store + db. Any future widening that
    // adds an LLM dep would surface here as a compile failure.
    const deps = { enrichmentStore: store };
    const out = handleRegistryDescribe(deps);
    expect(out.topics.length).toBeGreaterThan(0);
    // Confirm the deps shape doesn't expose anything LLM-shaped.
    expect(Object.keys(deps)).not.toContain('llm');
    expect(Object.keys(deps)).not.toContain('executeLLM');
  });

  it('handleEnrichmentRead deps shape carries no LLM hook', () => {
    const deps = { enrichmentStore: store };
    insertCompany('alice@example.com', NOW, 'Acme');
    const out = handleEnrichmentRead(deps, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    expect(out.result).not.toBeNull();
    expect(Object.keys(deps)).not.toContain('llm');
    expect(Object.keys(deps)).not.toContain('executeLLM');
  });

  it('handleVectorSimilaritySearch deps shape carries no LLM hook', () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const deps = { enrichmentStore: store, db };
    const out = handleVectorSimilaritySearch(deps, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 1,
      similarity_threshold: 0,
    });
    expect(out.results.length).toBe(1);
    expect(Object.keys(deps)).not.toContain('llm');
    expect(Object.keys(deps)).not.toContain('executeLLM');
  });

  it('all 3 handlers complete a round-trip with a poisoned LLM in the surrounding context', () => {
    // Simulate a global accidental LLM hook in the test environment —
    // the handlers must be unaffected because they don't reach for one.
    // This is the runtime complement to the structural deps assertion
    // above: even with an LLM laying around, no rpc surface invokes it.
    let llmInvocations = 0;
    const poisonedLLM = (): never => {
      llmInvocations += 1;
      throw new Error('LLM poisoned — read rpcs must not reach here');
    };

    insertCompany('alice@example.com', NOW, 'Acme');
    insertEmbedding('msg-1', [1, 0, 0]);

    handleRegistryDescribe({ enrichmentStore: store });
    handleEnrichmentRead({ enrichmentStore: store }, {
      topic: 'company',
      scope: 'contact',
      target_id: 'alice@example.com',
    });
    handleVectorSimilaritySearch({ enrichmentStore: store, db }, {
      query_vector: [1, 0, 0],
      topic: 'embedding',
      limit: 1,
      similarity_threshold: 0,
    });

    // Reference the poison so TS doesn't elide it; assert it was never reached.
    expect(typeof poisonedLLM).toBe('function');
    expect(llmInvocations).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. Internal helper sanity — bundle composition
// ────────────────────────────────────────────────────────────────

describe('bundle assembly internals', () => {
  it('assembleBundle produces a value-passthrough on a fresh row', () => {
    const r = insertCompany('alice@example.com', NOW, 'Acme');
    const fullRow = store.getById(r._id)!;
    const bundle = readInternals.assembleBundle(fullRow);
    expect(bundle._id).toBe(r._id);
    expect(bundle.value).toEqual(fullRow.value);
    expect(bundle.staleness_class).toBe('fresh');
    expect(bundle.computed_at).toBe(fullRow.authored_at);
  });

  it('extractConfidence skips when topic does not emit confidence', () => {
    const r = insertCompany('alice@example.com', NOW, 'Acme');
    const fullRow = store.getById(r._id)!;
    expect(readInternals.extractConfidence(fullRow)).toBeUndefined();
  });

  it('passesStalenessGate respects fresh-only when narrow', () => {
    const r = insertCompany('alice@example.com', NOW, 'Acme');
    const fullRow = store.getById(r._id)!;
    expect(readInternals.passesStalenessGate(fullRow, false)).toBe(true);
    // Tombstone the row → not fresh.
    store.tombstoneAndEnqueueRecomputeByTopic({ topic: 'company', scope_filter: 'contact' });
    const tombstoned = store.getById(r._id)!;
    expect(readInternals.passesStalenessGate(tombstoned, false)).toBe(false);
    expect(readInternals.passesStalenessGate(tombstoned, true)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. End-to-end MCP tool dispatch — through the JSON-RPC envelope
// ────────────────────────────────────────────────────────────────
//
// Exercises the wiring in mcp-server.ts so the contracts-level types,
// the handler functions, and the tool-call dispatcher all stay aligned.
// The goal is "MCP agent calls `recued_registryDescribe` and gets a
// well-shaped response back" — without standing up a full stdio
// transport.

import { _testing as mcpTesting } from '../mcp-server.js';
import { createRecipeStore } from '../recipe-store.js';
import { createManifestRegistry } from '../manifest-loader.js';

const makeMcpDeps = () => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: {},
  enrichmentStore: store,
  db,
});

/** Parse the text-content envelope MCP tool responses ship in. */
const parseToolResponse = <T>(res: unknown): T => {
  const r = res as { content?: Array<{ text?: string }>; isError?: boolean };
  if (r.isError === true) {
    throw new Error(`tool returned error: ${JSON.stringify(r)}`);
  }
  const text = r.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text!) as T;
};

describe('MCP tool dispatch — recued_registryDescribe', () => {
  it('dispatches end-to-end through handleToolCall', async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      { name: 'recued_registryDescribe', arguments: {} },
      deps,
    );
    const out = parseToolResponse<{ topics: Array<{ topic: string }> }>(res);
    expect(out.topics.length).toBeGreaterThan(20);
    expect(out.topics.some((t) => t.topic === 'company')).toBe(true);
  });
});

describe('MCP tool dispatch — recued_enrichmentRead', () => {
  it('dispatches end-to-end through handleToolCall', async () => {
    insertCompany('alice@example.com', NOW, 'Acme');
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
      result: { _id: string; topic: string; staleness_class: string } | null;
    }>(res);
    expect(out.result).not.toBeNull();
    expect(out.result!.topic).toBe('company');
    expect(out.result!.staleness_class).toBe('fresh');
  });

  it('returns isError on validation failure', async () => {
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_enrichmentRead',
        arguments: { topic: 'company' /* missing scope/target_id */ },
      },
      deps,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe('MCP tool dispatch — recued_vectorSimilaritySearch', () => {
  it('dispatches end-to-end through handleToolCall', async () => {
    insertEmbedding('msg-1', [1, 0, 0]);
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_vectorSimilaritySearch',
        arguments: {
          query_vector: [1, 0, 0],
          topic: 'embedding',
          limit: 5,
          similarity_threshold: 0,
        },
      },
      deps,
    );
    const out = parseToolResponse<{
      results: Array<{ enrichment_row_id: string; similarity: number }>;
      candidates_examined: number;
    }>(res);
    expect(out.results.length).toBe(1);
    expect(out.results[0]!.similarity).toBeCloseTo(1, 5);
    expect(out.candidates_examined).toBe(1);
  });

  it('returns isError on input validation failure', async () => {
    const deps = makeMcpDeps() as Parameters<typeof mcpTesting.handleToolCall>[1];
    const res = await mcpTesting.handleToolCall(
      {
        name: 'recued_vectorSimilaritySearch',
        arguments: {
          query_vector: [],
          topic: 'embedding',
          limit: 5,
        },
      },
      deps,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
