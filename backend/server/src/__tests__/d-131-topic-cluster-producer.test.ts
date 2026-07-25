/** D-131 A.14 — `topic_cluster` producer tests.
 *
 *  Drives the standalone `topicClusterTask` against a real in-memory
 *  `data_enrichment` table + `collection_mail_*` fixtures. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface / token estimate)
 *   - Pure helpers (subject normalisation, tokenisation, Jaccard,
 *     thread grouping, agglomerative clustering, theme tokens, stable
 *     derived_entity_id)
 *   - Mail scan + multi-table aggregation
 *   - AI corpus composition + closed-shape AI output validation +
 *     fabricated-cluster-index sanitisation
 *   - Stable derived_entity_id across runs (same theme → same id)
 *   - Pool-policy → ForceLayer threading on the AI input
 *   - Sweep stale rows on cluster id churn
 *   - MAX_CLUSTERS cap
 *   - Null-return cases (no mail / no clusters / AI returned no
 *     usable labels)
 *   - AI misconfiguration (no ctx.llm)
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type IngredientManifest,
  type TopicCluster,
} from '@recued/contracts';

import {
  TOPIC_CLUSTER_AUTHORED_BY,
  TOPIC_CLUSTER_TOPIC,
  TOPIC_CLUSTER_JACCARD_THRESHOLD,
  TOPIC_CLUSTER_MAIL_LOOKBACK_MS,
  TOPIC_CLUSTER_MAX_CLUSTERS,
  TOPIC_CLUSTER_MIN_THREADS_PER_CLUSTER,
  TOPIC_CLUSTER_TOKEN_ESTIMATE,
  assembleTopicCluster,
  capClusters,
  clusterThreads,
  composeTopicClusterCorpus,
  deriveTopicClusterId,
  groupMailByThread,
  jaccard,
  normaliseSubject,
  pickThemeTokens,
  resolveTopicClusterLayer,
  runTopicClusterCycle,
  scanRecentMailForTopicCluster,
  sweepStaleTopicClusters,
  tokeniseSubject,
  topicClusterScopeReadDeclaration,
  topicClusterTask,
  topicClusterTokenEstimate,
  trimTopicName,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createTrustStore,
  type TrustStore,
} from '../housekeeping/trust-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import type { HousekeepingContext, HousekeepingLlmExecute } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

const MAIL_TABLE_A = 'collection_mail_a';
const MAIL_TABLE_B = 'collection_mail_b';

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let trustStore: TrustStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-topic-cluster-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [MAIL_TABLE_A, MAIL_TABLE_B]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
        record_id   TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hot_fields  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        source_id   TEXT NOT NULL,
        body_inline TEXT,
        blob_hash   TEXT
      );
    `);
  }
  store = createEnrichmentStore(db);
  ensureHousekeepingSchema(db);
  trustStore = createTrustStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedMail {
  table?: string;
  record_id: string;
  thread_id: string;
  subject: string;
  received_at?: number;
}

const insertMail = (m: InsertedMail): void => {
  const table = m.table ?? MAIL_TABLE_A;
  const hot = {
    subject: m.subject,
    thread_id: m.thread_id,
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    cc: [],
  };
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.record_id,
    m.received_at ?? NOW,
    m.received_at ?? NOW,
    JSON.stringify(hot),
    100,
    m.record_id,
    null,
    null,
  );
};

const buildLlm = (
  result: unknown | (() => unknown) | (() => Promise<unknown>),
): {
  fn: HousekeepingLlmExecute;
  capturedManifest: () => IngredientManifest | null;
  capturedInput: () => Record<string, unknown> | null;
  callCount: () => number;
} => {
  let manifest: IngredientManifest | null = null;
  let input: Record<string, unknown> | null = null;
  let calls = 0;
  const fn: HousekeepingLlmExecute = vi.fn(
    async (m: IngredientManifest, i: Record<string, unknown>) => {
      manifest = m;
      input = i;
      calls += 1;
      if (typeof result === 'function') return (result as () => unknown)();
      return result;
    },
  );
  return {
    fn,
    capturedManifest: () => manifest,
    capturedInput: () => input,
    callCount: () => calls,
  };
};

const buildCtx = (
  options: {
    llm?: HousekeepingLlmExecute;
    now?: number;
    trustStore?: TrustStore;
  } = {},
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => options.now ?? NOW,
  emitAuditRow: () => undefined,
  ...(options.llm ? { llm: options.llm } : {}),
  // D-136 P3 — topicClusterProducer reads `ctx.llmWithMeta`. Wrap so the
  // existing `llm` mock + response queue keeps working.
  ...(options.llm
    ? {
        llmWithMeta: (async (manifest: unknown, input: unknown) => ({
          result: await (options.llm as unknown as (
            m: unknown,
            i: unknown,
          ) => Promise<unknown>)(manifest, input),
          model_id: 'openai:gpt-4o-mini',
        })) as unknown as HousekeepingContext['llmWithMeta'],
      }
    : {}),
  ...(options.trustStore ? { trustStore: options.trustStore } : {}),
});

// Build a labels payload for N clusters; used in happy-path tests.
const okLabelsForCount = (count: number) => ({
  labels: Array.from({ length: count }, (_, i) => ({
    cluster_index: i,
    topic_name: `Topic ${i}`,
    summary: `Summary for cluster ${i}.`,
  })),
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('topicClusterTask surface contract', () => {
  it('targets the topic_cluster registry topic', () => {
    expect(topicClusterTask.topic).toBe('topic_cluster');
  });

  it('declares is_ai_surface=true', () => {
    expect(topicClusterTask.is_ai_surface).toBe(true);
  });

  it('declares meta.kind=enrichment', () => {
    expect(topicClusterTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.topic_cluster', () => {
    expect(topicClusterTask.meta.id).toBe('enrichment.topic_cluster');
  });

  it('declares meta.interruptible=true', () => {
    expect(topicClusterTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(topicClusterTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a positive per-cycle token estimate', () => {
    expect(topicClusterTokenEstimate()).toBeGreaterThan(0);
    expect(topicClusterTokenEstimate()).toBe(TOPIC_CLUSTER_TOKEN_ESTIMATE);
  });

  it('declares non-empty scope_read_declaration over data.mail', () => {
    expect(topicClusterScopeReadDeclaration.length).toBeGreaterThan(0);
    const mail = topicClusterScopeReadDeclaration.find(
      (e) => e.collection === 'data.mail',
    );
    expect(mail).toBeDefined();
    expect((mail!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
  });
});

describe('topic_cluster registry entry', () => {
  it('is shape: derived_entity', () => {
    expect(ENRICHMENT_REGISTRY.topic_cluster.shape).toBe('derived_entity');
  });

  it('uses members_list policy with members_scope=mail', () => {
    const def = ENRICHMENT_REGISTRY.topic_cluster as {
      policy: string;
      members_field?: string;
      members_scope?: string;
    };
    expect(def.policy).toBe('members_list');
    expect(def.members_field).toBe('members');
    expect(def.members_scope).toBe('mail');
  });

  it('topic_cluster is time_bound — not PSI-eligible (D-136 P1 revoked emits_confidence); AI-surface defaults symmetric with company/role', () => {
    const def = ENRICHMENT_REGISTRY.topic_cluster as {
      emits_confidence?: boolean;
      default_trust_state?: string;
      default_pool_policy?: string;
    };
    expect(def.emits_confidence).toBeUndefined();
    expect(def.default_trust_state).toBe('manual');
    expect(def.default_pool_policy).toBe('free_only');
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.topic_cluster.producer_kind).toBe('housekeeping');
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — subject normalisation / tokenisation
// ────────────────────────────────────────────────────────────────

describe('normaliseSubject', () => {
  it('strips Re: prefix once', () => {
    expect(normaliseSubject('Re: Q4 planning')).toBe('q4 planning');
  });

  it('strips repeated Re: / Fwd: prefixes', () => {
    expect(normaliseSubject('Re: Re: Fwd: Re: Quarterly review')).toBe(
      'quarterly review',
    );
  });

  it('handles Fwd: variants (fw / aw / sv)', () => {
    expect(normaliseSubject('Fw: project alpha')).toBe('project alpha');
    expect(normaliseSubject('AW: Status update')).toBe('status update');
    expect(normaliseSubject('SV: Roadmap')).toBe('roadmap');
  });

  it('lowercases', () => {
    expect(normaliseSubject('Q4 PLANNING')).toBe('q4 planning');
  });

  it('strips punctuation, preserves digits, collapses whitespace', () => {
    expect(normaliseSubject('Q4 - Planning, draft #2')).toBe('q4 planning draft 2');
  });

  it('returns empty string for empty / whitespace input', () => {
    expect(normaliseSubject('')).toBe('');
    expect(normaliseSubject('   ')).toBe('');
  });
});

describe('tokeniseSubject', () => {
  it('drops stopwords + 1-char tokens', () => {
    const tokens = tokeniseSubject('the and project alpha is a top one');
    expect(tokens.has('project')).toBe(true);
    expect(tokens.has('alpha')).toBe(true);
    expect(tokens.has('top')).toBe(true);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('and')).toBe(false);
    expect(tokens.has('is')).toBe(false);
    expect(tokens.has('a')).toBe(false);
  });

  it('returns an empty set for empty subject', () => {
    expect(tokeniseSubject('').size).toBe(0);
  });

  it('caps the token bag at 12 tokens', () => {
    const long = Array.from({ length: 30 }, (_, i) => `wordABC${i}`).join(' ');
    expect(tokeniseSubject(long).size).toBe(12);
  });

  it('tokens are normalised (lowercase / no punctuation)', () => {
    const tokens = tokeniseSubject('Project Alpha — review');
    expect(tokens.has('project')).toBe(true);
    expect(tokens.has('alpha')).toBe(true);
    expect(tokens.has('review')).toBe(true);
  });
});

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('computes intersection / union correctly', () => {
    // intersection = 1 (b); union = 3 (a, b, c)
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — clustering
// ────────────────────────────────────────────────────────────────

const buildThread = (
  thread_id: string,
  subject: string,
  member_ids: string[] = [thread_id + '-msg'],
): import('../housekeeping/index.js').TopicClusterThreadAtom => ({
  thread_id,
  subject,
  tokens: tokeniseSubject(subject),
  member_ids,
  last_received_at: NOW,
});

describe('clusterThreads', () => {
  it('merges threads with high token-bag Jaccard', () => {
    const threads = [
      buildThread('t1', 'Q4 sales pipeline review'),
      buildThread('t2', 'Q4 sales pipeline followup'),
      buildThread('t3', 'sales pipeline Q4 ramp'),
    ];
    const out = clusterThreads(threads);
    expect(out).toHaveLength(1);
    expect(out[0]!.threads).toHaveLength(3);
  });

  it('keeps unrelated threads in separate clusters', () => {
    const threads = [
      buildThread('t1', 'Q4 sales pipeline review'),
      buildThread('t2', 'Q4 sales pipeline followup'),
      buildThread('t3', 'Lunch Friday'),
      buildThread('t4', 'Lunch this week'),
    ];
    const out = clusterThreads(threads);
    expect(out).toHaveLength(2);
  });

  it('discards single-thread clusters by default', () => {
    const threads = [
      buildThread('t1', 'Lunch Friday'),
      buildThread('t2', 'Q4 sales pipeline review'),
      buildThread('t3', 'Q4 sales pipeline followup'),
    ];
    const out = clusterThreads(threads);
    expect(out).toHaveLength(1);
    expect(out[0]!.threads.map((t) => t.thread_id).sort()).toEqual(['t2', 't3']);
  });

  it('threshold parameter overrides default', () => {
    const threads = [
      buildThread('t1', 'project alpha'),
      buildThread('t2', 'project beta'), // shares "project" only
    ];
    // With a high threshold, no merge.
    const strict = clusterThreads(threads, 0.9);
    expect(strict).toHaveLength(0);
    // With a permissive threshold, they merge.
    const lax = clusterThreads(threads, 0.1);
    expect(lax).toHaveLength(1);
  });

  it('handles empty thread input', () => {
    expect(clusterThreads([])).toEqual([]);
  });

  it('JACCARD_THRESHOLD is the documented default', () => {
    expect(TOPIC_CLUSTER_JACCARD_THRESHOLD).toBeGreaterThan(0);
    expect(TOPIC_CLUSTER_JACCARD_THRESHOLD).toBeLessThan(1);
  });
});

describe('pickThemeTokens', () => {
  it('returns top-frequency tokens across cluster threads', () => {
    const threads = [
      buildThread('t1', 'Q4 sales pipeline'),
      buildThread('t2', 'Q4 sales pipeline review'),
      buildThread('t3', 'Q4 sales report'),
    ];
    // After tokenisation, "sales" appears in all 3, "q" not (1-char dropped),
    // "pipeline" in 2; default n=3 returns top 3 by frequency.
    const cluster = { threads, tokens: new Set<string>() };
    const top = pickThemeTokens(cluster);
    expect(top.length).toBeLessThanOrEqual(3);
    expect(top).toContain('sales');
  });

  it('respects the n parameter', () => {
    const threads = [
      buildThread('t1', 'Q4 sales pipeline review report'),
      buildThread('t2', 'Q4 sales pipeline review report'),
    ];
    const cluster = { threads, tokens: new Set<string>() };
    expect(pickThemeTokens(cluster, 2)).toHaveLength(2);
    expect(pickThemeTokens(cluster, 5).length).toBeLessThanOrEqual(5);
  });

  it('returns empty for an empty cluster', () => {
    expect(pickThemeTokens({ threads: [], tokens: new Set() })).toEqual([]);
  });

  it('produces deterministic output on identical input', () => {
    const threads = [
      buildThread('t1', 'project alpha review'),
      buildThread('t2', 'project beta review'),
    ];
    const a = pickThemeTokens({ threads, tokens: new Set() });
    const b = pickThemeTokens({ threads, tokens: new Set() });
    expect(a).toEqual(b);
  });
});

describe('deriveTopicClusterId', () => {
  it('produces a topic_cluster_<hash> id', () => {
    const id = deriveTopicClusterId(['sales', 'pipeline', 'q']);
    expect(id).toMatch(/^topic_cluster_[a-f0-9]+$/);
  });

  it('is stable for the same theme tokens regardless of order', () => {
    const a = deriveTopicClusterId(['sales', 'pipeline', 'review']);
    const b = deriveTopicClusterId(['review', 'pipeline', 'sales']);
    expect(a).toBe(b);
  });

  it('differs across distinct themes', () => {
    const a = deriveTopicClusterId(['sales', 'pipeline']);
    const b = deriveTopicClusterId(['lunch', 'friday']);
    expect(a).not.toBe(b);
  });
});

describe('capClusters', () => {
  const buildCluster = (size: number, msgs_per_thread: number = 1) => ({
    threads: Array.from({ length: size }, (_, i) =>
      buildThread(
        `t${i}-${size}`,
        'subject',
        Array.from({ length: msgs_per_thread }, (_, j) => `m${size}-${i}-${j}`),
      ),
    ),
    tokens: new Set<string>(),
  });

  it('returns input unchanged when count <= cap', () => {
    const clusters = [buildCluster(2), buildCluster(3)];
    expect(capClusters(clusters, 5)).toHaveLength(2);
  });

  it('keeps the largest by total message count when over cap', () => {
    const clusters = [
      buildCluster(2, 1), // 2 messages
      buildCluster(3, 4), // 12 messages
      buildCluster(2, 5), // 10 messages
    ];
    const out = capClusters(clusters, 2);
    expect(out).toHaveLength(2);
    // The 12 + 10 should win over the 2.
    const sizes = out.map((c) =>
      c.threads.reduce((s, t) => s + t.member_ids.length, 0),
    );
    expect(sizes).toEqual([12, 10]);
  });
});

// ────────────────────────────────────────────────────────────────
// Mail scan + grouping
// ────────────────────────────────────────────────────────────────

describe('scanRecentMailForTopicCluster', () => {
  it('returns rows newest-first with thread_id + subject', () => {
    insertMail({
      record_id: 'm1',
      thread_id: 't1',
      subject: 'old',
      received_at: NOW - ONE_DAY,
    });
    insertMail({
      record_id: 'm2',
      thread_id: 't1',
      subject: 'newer',
      received_at: NOW - ONE_HOUR,
    });
    const ctx = buildCtx();
    const rows = scanRecentMailForTopicCluster(ctx, NOW);
    expect(rows.map((r) => r.record_id)).toEqual(['m2', 'm1']);
  });

  it('walks every collection_mail_* table', () => {
    insertMail({
      table: MAIL_TABLE_A,
      record_id: 'a1',
      thread_id: 'tA',
      subject: 'x',
    });
    insertMail({
      table: MAIL_TABLE_B,
      record_id: 'b1',
      thread_id: 'tB',
      subject: 'y',
    });
    const ctx = buildCtx();
    const rows = scanRecentMailForTopicCluster(ctx, NOW);
    expect(rows.map((r) => r.record_id).sort()).toEqual(['a1', 'b1']);
  });

  it('drops rows older than the look-back window', () => {
    insertMail({
      record_id: 'too-old',
      thread_id: 't1',
      subject: 'x',
      received_at: NOW - TOPIC_CLUSTER_MAIL_LOOKBACK_MS - ONE_DAY,
    });
    insertMail({
      record_id: 'in-window',
      thread_id: 't1',
      subject: 'x',
    });
    const ctx = buildCtx();
    const rows = scanRecentMailForTopicCluster(ctx, NOW);
    expect(rows.map((r) => r.record_id)).toEqual(['in-window']);
  });

  it('drops rows whose hot_fields lack thread_id', () => {
    db.prepare(
      `INSERT INTO ${MAIL_TABLE_A} (
         record_id, received_at, modified_at, hot_fields,
         size_bytes, source_id, body_inline, blob_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('no-thread', NOW, NOW, JSON.stringify({ subject: 'x' }), 100, 'no-thread', null, null);
    insertMail({ record_id: 'with-thread', thread_id: 't1', subject: 'x' });
    const rows = scanRecentMailForTopicCluster(buildCtx(), NOW);
    expect(rows.map((r) => r.record_id)).toEqual(['with-thread']);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i += 1) {
      insertMail({
        record_id: `m${i}`,
        thread_id: `t${i}`,
        subject: 'x',
        received_at: NOW - i * ONE_HOUR,
      });
    }
    const rows = scanRecentMailForTopicCluster(buildCtx(), NOW, 3);
    expect(rows).toHaveLength(3);
  });
});

describe('groupMailByThread', () => {
  it('one thread per thread_id; member_ids collected', () => {
    const rows = [
      { record_id: 'm1', thread_id: 't1', subject: 'old', received_at: NOW - ONE_DAY },
      { record_id: 'm2', thread_id: 't1', subject: 'newer', received_at: NOW - ONE_HOUR },
      { record_id: 'm3', thread_id: 't2', subject: 'other', received_at: NOW },
    ];
    const threads = groupMailByThread(rows);
    expect(threads).toHaveLength(2);
    const t1 = threads.find((t) => t.thread_id === 't1')!;
    expect(t1.member_ids.sort()).toEqual(['m1', 'm2']);
    expect(t1.subject).toBe('newer'); // Most-recent wins.
    expect(t1.last_received_at).toBe(NOW - ONE_HOUR);
  });
});

// ────────────────────────────────────────────────────────────────
// Corpus composition + AI label validation
// ────────────────────────────────────────────────────────────────

describe('composeTopicClusterCorpus', () => {
  it('emits a block per cluster with index + sample subjects', () => {
    const clusters = [
      {
        threads: [
          buildThread('t1', 'Q4 sales pipeline review'),
          buildThread('t2', 'Q4 sales pipeline followup'),
        ],
        tokens: new Set<string>(['sales', 'pipeline']),
      },
      {
        threads: [
          buildThread('t3', 'Lunch Friday'),
          buildThread('t4', 'Lunch this week'),
        ],
        tokens: new Set<string>(['lunch', 'friday']),
      },
    ];
    const corpus = composeTopicClusterCorpus(clusters);
    expect(corpus).toContain('Cluster #0');
    expect(corpus).toContain('Cluster #1');
    expect(corpus).toContain('Q4 sales pipeline review');
    expect(corpus).toContain('Lunch Friday');
    expect(corpus).toContain('Top tokens:');
    expect(corpus).toContain('--- next cluster ---');
  });

  it('caps sample subjects per cluster', () => {
    const threads = Array.from({ length: 20 }, (_, i) =>
      buildThread(`t${i}`, `subject ${i}`),
    );
    const corpus = composeTopicClusterCorpus([{ threads, tokens: new Set() }]);
    // 5 sample subjects max per cluster.
    expect(corpus.match(/subject \d+/g)?.length).toBeLessThanOrEqual(5);
  });
});

describe('trimTopicName', () => {
  it('collapses internal whitespace + trims', () => {
    expect(trimTopicName('  Q4   Sales  ')).toBe('Q4 Sales');
  });

  it('caps at 40 chars', () => {
    const long = 'A'.repeat(60);
    expect(trimTopicName(long)).toHaveLength(40);
  });

  it('preserves names under the cap', () => {
    expect(trimTopicName('Quarterly Sales Review')).toBe('Quarterly Sales Review');
  });
});

// ────────────────────────────────────────────────────────────────
// assembleCluster — building the value
// ────────────────────────────────────────────────────────────────

describe('assembleTopicCluster', () => {
  it('builds a TopicCluster value with deduped + sorted members', () => {
    const cluster = {
      threads: [
        buildThread('t1', 'sales pipeline', ['m1', 'm2']),
        buildThread('t2', 'sales pipeline review', ['m3', 'm2']), // m2 repeated
      ],
      tokens: new Set<string>(),
    };
    const themeTokens = ['pipeline', 'sales'];
    const { value, derived_entity_id } = assembleTopicCluster(
      cluster,
      { cluster_index: 0, topic_name: 'Sales Pipeline', summary: 'Sales pipe review.' },
      themeTokens,
      NOW,
    );
    expect(value.members).toEqual(['m1', 'm2', 'm3']); // sorted, deduped
    expect(value.thread_ids).toEqual(['t1', 't2']);
    expect(value.thread_count).toBe(2);
    expect(value.theme_tokens).toEqual(['pipeline', 'sales']);
    expect(value.topic_name).toBe('Sales Pipeline');
    expect(value.summary).toBe('Sales pipe review.');
    // D-136 P1: confidence stripped from TopicCluster (time_bound topic)
    expect(value.computed_at).toBe(NOW);
    expect(value.ai_invoked).toBe(true);
    expect(derived_entity_id).toMatch(/^topic_cluster_[a-f0-9]+$/);
  });
});

// ────────────────────────────────────────────────────────────────
// Pool-policy → ForceLayer threading
// ────────────────────────────────────────────────────────────────

// Seed the housekeeping_config singleton with allow_byok_background = 1
// so the per-topic pool policy is the load-bearing decision in
// `resolveTopicClusterLayer`. Default global state is BYOK-off, which
// would short-circuit every layer to 'free' regardless of policy.
const enableGlobalByok = (): void => {
  db.prepare(
    `INSERT INTO housekeeping_config (
       id, preset, cycle_budget_ms, cycle_interval_minutes,
       updated_at, allow_byok_background, pause_background_ai_until
     ) VALUES ('singleton', 'balanced', 60000, 60, ?, 1, NULL)
     ON CONFLICT(id) DO UPDATE SET allow_byok_background = 1`,
  ).run(NOW);
};

describe('resolveTopicClusterLayer', () => {
  it('returns "any" when no trustStore is wired', () => {
    expect(resolveTopicClusterLayer(buildCtx(), undefined)).toBe('any');
  });

  it('returns "free" when topic policy is free_only (and global BYOK on)', () => {
    enableGlobalByok();
    trustStore.write('topic_cluster', { pool_policy: 'free_only' }, NOW);
    expect(resolveTopicClusterLayer(buildCtx(), trustStore)).toBe('free');
  });

  it('returns "byok" when topic policy is byok_only (and global BYOK on)', () => {
    enableGlobalByok();
    trustStore.write('topic_cluster', { pool_policy: 'byok_only' }, NOW);
    expect(resolveTopicClusterLayer(buildCtx(), trustStore)).toBe('byok');
  });

  it('returns "any" when topic policy is free_then_byok (and global BYOK on)', () => {
    enableGlobalByok();
    trustStore.write('topic_cluster', { pool_policy: 'free_then_byok' }, NOW);
    expect(resolveTopicClusterLayer(buildCtx(), trustStore)).toBe('any');
  });

  it('collapses to "free" when global allow_byok_background is off', () => {
    // Default state — no singleton row present means BYOK off.
    trustStore.write('topic_cluster', { pool_policy: 'byok_only' }, NOW);
    expect(resolveTopicClusterLayer(buildCtx(), trustStore)).toBe('free');
  });
});

// ────────────────────────────────────────────────────────────────
// runTopicClusterCycle — end-to-end orchestration
// ────────────────────────────────────────────────────────────────

const seedThreeClusterCorpus = (): void => {
  // Cluster 1: sales pipeline (3 threads)
  insertMail({ record_id: 'm-sales-1a', thread_id: 'sales-1', subject: 'Q4 sales pipeline review' });
  insertMail({ record_id: 'm-sales-1b', thread_id: 'sales-1', subject: 'Re: Q4 sales pipeline review' });
  insertMail({ record_id: 'm-sales-2', thread_id: 'sales-2', subject: 'Q4 sales pipeline followup' });
  insertMail({ record_id: 'm-sales-3', thread_id: 'sales-3', subject: 'sales pipeline Q4 ramp' });
  // Cluster 2: lunch (2 threads, 2 messages each)
  insertMail({ record_id: 'm-lunch-1a', thread_id: 'lunch-1', subject: 'Lunch Friday' });
  insertMail({ record_id: 'm-lunch-1b', thread_id: 'lunch-1', subject: 'Re: Lunch Friday' });
  insertMail({ record_id: 'm-lunch-2', thread_id: 'lunch-2', subject: 'Lunch this week' });
  // Singleton (gets dropped — no cluster)
  insertMail({ record_id: 'm-orphan', thread_id: 'orphan-1', subject: 'orphan one-off' });
};

describe('runTopicClusterCycle', () => {
  it('throws when ctx.llm is missing', async () => {
    seedThreeClusterCorpus();
    await expect(runTopicClusterCycle(buildCtx())).rejects.toThrow(
      /topic_cluster_producer_misconfigured/,
    );
  });

  it('produces zero rows on empty mail corpus', async () => {
    const llm = buildLlm({ labels: [] });
    const out = await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    expect(out.produced).toBe(0);
    expect(llm.callCount()).toBe(0); // No clusters → no AI call.
  });

  it('produces zero rows when no clusters survive (all singletons)', async () => {
    insertMail({ record_id: 'm1', thread_id: 't1', subject: 'apple banana' });
    insertMail({ record_id: 'm2', thread_id: 't2', subject: 'cherry date' });
    const llm = buildLlm({ labels: [] });
    const out = await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    expect(out.produced).toBe(0);
    expect(llm.callCount()).toBe(0);
  });

  it('happy path — clusters mail + writes one row per labelled cluster', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm(okLabelsForCount(2));
    const out = await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    expect(out.produced).toBe(2);
    const rows = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const v = row.value as TopicCluster;
      expect(v.members.length).toBeGreaterThan(0);
      expect(v.thread_ids.length).toBeGreaterThanOrEqual(
        TOPIC_CLUSTER_MIN_THREADS_PER_CLUSTER,
      );
      // D-136 P1: confidence stripped from TopicCluster (time_bound topic)
      expect(row.scope).toBeNull();
      expect(row.target_id).toBeNull();
      expect(row.authored_by).toBe(TOPIC_CLUSTER_AUTHORED_BY);
    }
  });

  it('drops fabricated cluster_index from AI output', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm({
      labels: [
        { cluster_index: 0, topic_name: 'Real', summary: 'Real cluster.' },
        { cluster_index: 99, topic_name: 'Fake', summary: 'Out of range.' },
        { cluster_index: -1, topic_name: 'Negative', summary: 'Out of range.' },
      ],
    });
    const out = await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    expect(out.produced).toBe(1); // Only cluster 0 had a valid label.
    const rows = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.value as TopicCluster).topic_name).toBe('Real');
  });

  it('throws when AI returns malformed shape', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm({ wrong: 'shape' });
    await expect(runTopicClusterCycle(buildCtx({ llm: llm.fn }))).rejects.toThrow(
      /topic_cluster_output_invalid/,
    );
  });

  it('threads llm.force_layer from trust store onto the AI input', async () => {
    seedThreeClusterCorpus();
    trustStore.write('topic_cluster', { pool_policy: 'free_only' }, NOW);
    const llm = buildLlm(okLabelsForCount(2));
    await runTopicClusterCycle(buildCtx({ llm: llm.fn, trustStore }));
    const input = llm.capturedInput();
    expect(input).not.toBeNull();
    expect(input!['llm.force_layer']).toBe('free');
  });

  it('uses ai-extract manifest with llm.fields=labels', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm(okLabelsForCount(2));
    await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    const manifest = llm.capturedManifest();
    expect(manifest!.slug).toBe('ai-extract');
    expect(manifest!.kind).toBe('ai');
    const input = llm.capturedInput();
    expect(input!['llm.fields']).toEqual(['labels']);
    expect(typeof input!['llm.context']).toBe('string');
    expect(typeof input!['llm.data']).toBe('string');
  });

  it('produces stable derived_entity_id across runs with the same theme', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm(okLabelsForCount(2));
    await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    const firstIds = store
      .list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();
    await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    const secondIds = store
      .list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();
    expect(firstIds).toEqual(secondIds);
    // Still exactly two clusters total — upserts replaced rows in place.
    expect(secondIds).toHaveLength(2);
  });

  it('cap is enforced on emitted clusters', async () => {
    // Build many distinct clusters by injecting per-thread distinct
    // theme tokens. Each cluster has 2 threads with the same theme.
    for (let i = 0; i < TOPIC_CLUSTER_MAX_CLUSTERS + 5; i += 1) {
      const theme = `themea${i} themeb${i} themec${i}`;
      insertMail({
        record_id: `m-${i}-a`,
        thread_id: `cluster-${i}-thread-1`,
        subject: theme,
      });
      insertMail({
        record_id: `m-${i}-b`,
        thread_id: `cluster-${i}-thread-2`,
        subject: theme + ' followup',
      });
    }
    const llm = buildLlm(okLabelsForCount(TOPIC_CLUSTER_MAX_CLUSTERS));
    const out = await runTopicClusterCycle(buildCtx({ llm: llm.fn }));
    expect(out.produced).toBeLessThanOrEqual(TOPIC_CLUSTER_MAX_CLUSTERS);
  });

  it('topicClusterTask.step returns complete + zero-cost cursor', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm(okLabelsForCount(2));
    const result = await topicClusterTask.step(
      buildCtx({ llm: llm.fn }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema', async () => {
    seedThreeClusterCorpus();
    const llm = buildLlm(okLabelsForCount(2));
    // The store calls value_schema validate at upsert; if it rejected
    // our shape the run would throw EnrichmentValueInvalidError.
    await expect(
      runTopicClusterCycle(buildCtx({ llm: llm.fn })),
    ).resolves.toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep stale rows
// ────────────────────────────────────────────────────────────────

describe('sweepStaleTopicClusters', () => {
  it('deletes rows whose id is not in the fresh set', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'topic_cluster_alive',
      value: {
        topic_name: 'Alive',
        summary: 'Still here.',
        members: ['m1'],
        thread_ids: ['t1'],
        theme_tokens: ['alive'],
        thread_count: 1,
        ai_invoked: true,
        confidence: 0.75,
        computed_at: NOW,
        window_ms: 90 * 24 * 60 * 60 * 1000,
      },
      authored_by: TOPIC_CLUSTER_AUTHORED_BY,
    });
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'topic_cluster_orphan',
      value: {
        topic_name: 'Orphan',
        summary: 'No longer in corpus.',
        members: ['m2'],
        thread_ids: ['t2'],
        theme_tokens: ['orphan'],
        thread_count: 1,
        ai_invoked: true,
        confidence: 0.75,
        computed_at: NOW,
        window_ms: 90 * 24 * 60 * 60 * 1000,
      },
      authored_by: TOPIC_CLUSTER_AUTHORED_BY,
    });

    const result = sweepStaleTopicClusters(buildCtx(), new Set(['topic_cluster_alive']));
    expect(result.deleted).toBe(1);
    const remaining = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!._id).toBe('topic_cluster_alive');
  });

  it('deletes every row when fresh set is empty', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'topic_cluster_x',
      value: {
        topic_name: 'X',
        summary: 'x.',
        members: ['m1'],
        thread_ids: ['t1'],
        theme_tokens: ['x'],
        thread_count: 1,
        ai_invoked: true,
        confidence: 0.75,
        computed_at: NOW,
        window_ms: 90 * 24 * 60 * 60 * 1000,
      },
      authored_by: TOPIC_CLUSTER_AUTHORED_BY,
    });
    const result = sweepStaleTopicClusters(buildCtx(), new Set());
    expect(result.deleted).toBe(1);
  });

  it('no-op when fresh set covers every row', () => {
    store.upsert({
      topic: 'topic_cluster',
      derived_entity_id: 'topic_cluster_kept',
      value: {
        topic_name: 'K',
        summary: 'k.',
        members: ['m1'],
        thread_ids: ['t1'],
        theme_tokens: ['k'],
        thread_count: 1,
        ai_invoked: true,
        confidence: 0.75,
        computed_at: NOW,
        window_ms: 90 * 24 * 60 * 60 * 1000,
      },
      authored_by: TOPIC_CLUSTER_AUTHORED_BY,
    });
    const result = sweepStaleTopicClusters(
      buildCtx(),
      new Set(['topic_cluster_kept']),
    );
    expect(result.deleted).toBe(0);
    expect(store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false })).toHaveLength(1);
  });

  it('cycle 2 sweeps a cluster that vanished from the corpus', async () => {
    // Cycle 1: two clusters present
    seedThreeClusterCorpus();
    const llm1 = buildLlm(okLabelsForCount(2));
    await runTopicClusterCycle(buildCtx({ llm: llm1.fn }));
    expect(store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false })).toHaveLength(2);

    // Wipe lunch cluster mail; rerun → only sales survives
    db.prepare(`DELETE FROM ${MAIL_TABLE_A} WHERE record_id LIKE 'm-lunch-%'`).run();
    const llm2 = buildLlm(okLabelsForCount(1));
    await runTopicClusterCycle(buildCtx({ llm: llm2.fn }));
    const rows = store.list({ topic: TOPIC_CLUSTER_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema
// ────────────────────────────────────────────────────────────────

describe('topic_cluster value_schema', () => {
  const validate = ENRICHMENT_REGISTRY.topic_cluster.value_schema;

  const goodValue: TopicCluster = {
    topic_name: 'Sales Pipeline',
    summary: 'Quarterly sales pipeline reviews.',
    members: ['m1', 'm2'],
    thread_ids: ['t1'],
    theme_tokens: ['sales', 'pipeline'],
    thread_count: 2,
    ai_invoked: true,
    // D-136 P1: confidence stripped from TopicCluster (time_bound topic)
    computed_at: NOW,
    window_ms: 90 * 24 * 60 * 60 * 1000,
  };

  it('accepts a well-formed value', () => {
    const result = validate(goodValue);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object value', () => {
    const result = validate('not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects missing topic_name', () => {
    const { topic_name: _topic_name, ...rest } = goodValue;
    void _topic_name;
    const result = validate(rest);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toContain(
      "field 'topic_name' must be a non-empty string",
    );
  });

  it('rejects empty members array', () => {
    const result = validate({ ...goodValue, members: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects non-string member entries', () => {
    const result = validate({ ...goodValue, members: ['m1', 42] });
    expect(result.ok).toBe(false);
  });

  it('rejects non-boolean ai_invoked', () => {
    const result = validate({ ...goodValue, ai_invoked: 'true' });
    expect(result.ok).toBe(false);
  });

  // D-136 P1 retired: confidence field stripped from TopicCluster
  // (time_bound topic) + emits_confidence revoked, so the value schema
  // no longer validates the field at all.
});
