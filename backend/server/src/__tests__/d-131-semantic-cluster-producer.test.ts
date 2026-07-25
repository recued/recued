/** D-131 A.17 — `semantic_cluster` producer tests.
 *
 *  Drives the standalone `semanticClusterTask` against a real in-memory
 *  `data_enrichment` + `data_enrichment_vector_index` fixture seeded
 *  with embedding rows. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Pure math (cosine similarity / centroid / vector encode/decode)
 *   - Clustering (agglomerative on cosine threshold)
 *   - Embedding scan + dominant model selection
 *   - Whole-cycle orchestration — happy path, threshold, cap, sweep
 *   - Stable derived_entity_id across runs (same membership)
 *   - Centroid persists to vector_index sidecar
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type SemanticClusterValue,
} from '@recued/contracts';

import {
  SEMANTIC_CLUSTER_AUTHORED_BY,
  SEMANTIC_CLUSTER_TOPIC,
  SEMANTIC_CLUSTER_COSINE_THRESHOLD,
  SEMANTIC_CLUSTER_MAX_CLUSTERS,
  SEMANTIC_CLUSTER_MIN_MAILS_PER_CLUSTER,
  SEMANTIC_CLUSTER_TOKEN_ESTIMATE,
  assembleSemanticCluster,
  avgIntraSimilarity,
  capSemanticClusters,
  clusterByCosineSimilarity,
  computeSemanticClusterCentroid,
  cosineSimilarity,
  decodeSemanticClusterVector,
  deriveSemanticClusterId,
  encodeSemanticClusterCentroid,
  pickDominantModelGroupForSemanticCluster,
  runSemanticClusterCycle,
  scanEmbeddingsForSemanticCluster,
  semanticClusterScopeReadDeclaration,
  semanticClusterTask,
  semanticClusterTokenEstimate,
  sweepStaleSemanticClusters,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-semantic-cluster-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const buildCtx = (now: number = NOW): HousekeepingContext => ({
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
});

const insertEmbedding = (input: {
  mail_id: string;
  vector: ReadonlyArray<number>;
  model?: string;
  ingested_at?: number;
}): string => {
  const buf = encodeSemanticClusterCentroid(input.vector);
  const row = store.upsert({
    topic: 'embedding',
    scope: 'mail',
    target_id: input.mail_id,
    value: {
      dimensions: input.vector.length,
      model: input.model ?? 'text-embedding-3-small',
    },
    authored_by: 'system.embedder',
    sidecar_vector: buf,
    event_at: input.ingested_at ?? NOW,
  });
  return row._id;
};

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('semanticClusterTask surface contract', () => {
  it('targets the semantic_cluster registry topic', () => {
    expect(semanticClusterTask.topic).toBe('semantic_cluster');
  });

  it('declares is_ai_surface=false (clustering is pure math; embeddings already paid)', () => {
    expect(semanticClusterTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(semanticClusterTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.semantic_cluster', () => {
    expect(semanticClusterTask.meta.id).toBe('enrichment.semantic_cluster');
  });

  it('declares meta.interruptible=true', () => {
    expect(semanticClusterTask.meta.interruptible).toBe(true);
  });

  it('exposes a zero-token cycle estimate', () => {
    expect(semanticClusterTokenEstimate()).toBe(0);
    expect(semanticClusterTokenEstimate()).toBe(SEMANTIC_CLUSTER_TOKEN_ESTIMATE);
  });

  it('declares scope_read_declaration over data.enrichment.embedding', () => {
    expect(semanticClusterScopeReadDeclaration.length).toBeGreaterThan(0);
    const ent = semanticClusterScopeReadDeclaration.find(
      (e) => e.collection === 'data.enrichment.embedding',
    );
    expect(ent).toBeDefined();
    expect((ent!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
  });
});

describe('semantic_cluster registry entry', () => {
  it('is shape: derived_entity', () => {
    expect(ENRICHMENT_REGISTRY.semantic_cluster.shape).toBe('derived_entity');
  });

  it('uses members_list policy with members_scope=mail', () => {
    const def = ENRICHMENT_REGISTRY.semantic_cluster as {
      policy: string;
      members_field?: string;
      members_scope?: string;
    };
    expect(def.policy).toBe('members_list');
    expect(def.members_field).toBe('members');
    expect(def.members_scope).toBe('mail');
  });

  it('uses sidecar=vector_index', () => {
    expect(ENRICHMENT_REGISTRY.semantic_cluster.sidecar).toBe('vector_index');
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.semantic_cluster.producer_kind).toBe('housekeeping');
  });

  it('does NOT declare emits_confidence', () => {
    const def = ENRICHMENT_REGISTRY.semantic_cluster as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('does NOT declare default_trust_state (resolver returns "auto" for non-AI)', () => {
    const def = ENRICHMENT_REGISTRY.semantic_cluster as { default_trust_state?: string };
    expect(def.default_trust_state).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure math — cosine similarity
// ────────────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });

  it('returns -1.0 for opposite-direction vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0, 6);
  });

  it('returns 0 when either vector is all zeros (degenerate)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([1, 1, 1], [0, 0, 0])).toBe(0);
  });

  it('is direction-only — invariant to magnitude', () => {
    const a = cosineSimilarity([1, 1, 1], [2, 2, 2]);
    expect(a).toBeCloseTo(1.0, 6);
  });

  it('similar but not identical vectors land between 0 and 1', () => {
    const v = cosineSimilarity([1, 1, 0], [1, 0.9, 0.1]);
    expect(v).toBeGreaterThan(0.9);
    expect(v).toBeLessThan(1.0);
  });
});

// ────────────────────────────────────────────────────────────────
// Pure math — centroid
// ────────────────────────────────────────────────────────────────

describe('computeSemanticClusterCentroid', () => {
  it('returns null on empty input', () => {
    expect(computeSemanticClusterCentroid([])).toBeNull();
  });

  it('returns null when vectors disagree on dimension', () => {
    expect(
      computeSemanticClusterCentroid([
        [1, 2, 3],
        [4, 5],
      ]),
    ).toBeNull();
  });

  it('returns the input itself for a single vector', () => {
    expect(computeSemanticClusterCentroid([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it('computes element-wise mean across multiple vectors', () => {
    const c = computeSemanticClusterCentroid([
      [1, 2, 3],
      [3, 4, 5],
      [5, 6, 7],
    ]);
    expect(c).toEqual([3, 4, 5]);
  });

  it('handles zero-dimension input (defensive)', () => {
    expect(computeSemanticClusterCentroid([[]])).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure math — encode/decode buffer round-trip
// ────────────────────────────────────────────────────────────────

describe('vector encode/decode round-trip', () => {
  it('encodes a number[] and decodes back to the same values', () => {
    const original = [0.1, -0.2, 0.3, 0.4];
    const buf = encodeSemanticClusterCentroid(original);
    const decoded = decodeSemanticClusterVector(buf);
    expect(decoded).not.toBeNull();
    for (let i = 0; i < original.length; i += 1) {
      expect(decoded![i]).toBeCloseTo(original[i]!, 5);
    }
  });

  it('decodeVector returns null on empty buffer', () => {
    expect(decodeSemanticClusterVector(Buffer.alloc(0))).toBeNull();
  });

  it('decodeVector returns null on non-multiple-of-4 byte length', () => {
    expect(decodeSemanticClusterVector(Buffer.alloc(7))).toBeNull();
  });

  it('decodeVector handles a 2-element vector', () => {
    const buf = encodeSemanticClusterCentroid([1, 2]);
    expect(buf.byteLength).toBe(8);
    expect(decodeSemanticClusterVector(buf)).toEqual([1, 2]);
  });
});

// ────────────────────────────────────────────────────────────────
// avgIntraSimilarity
// ────────────────────────────────────────────────────────────────

describe('avgIntraSimilarity', () => {
  it('returns 0 on empty input', () => {
    expect(avgIntraSimilarity([])).toBe(0);
  });

  it('returns 1.0 on a single-vector cluster (vacuously identical)', () => {
    expect(avgIntraSimilarity([[1, 2, 3]])).toBe(1);
  });

  it('returns 1.0 for identical vectors', () => {
    expect(
      avgIntraSimilarity([
        [1, 0],
        [1, 0],
        [1, 0],
      ]),
    ).toBeCloseTo(1.0, 6);
  });

  it('returns lower values for less similar vectors', () => {
    const sim = avgIntraSimilarity([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(sim).toBeCloseTo(0, 6);
  });
});

// ────────────────────────────────────────────────────────────────
// deriveSemanticClusterId
// ────────────────────────────────────────────────────────────────

describe('deriveSemanticClusterId', () => {
  it('produces a semantic_cluster_<hash> id', () => {
    expect(deriveSemanticClusterId(['a', 'b', 'c'])).toMatch(
      /^semantic_cluster_[a-f0-9]+$/,
    );
  });

  it('is order-invariant (sorts internally)', () => {
    expect(deriveSemanticClusterId(['c', 'a', 'b'])).toBe(
      deriveSemanticClusterId(['a', 'b', 'c']),
    );
  });

  it('is stable for the same membership across calls', () => {
    expect(deriveSemanticClusterId(['m1', 'm2', 'm3'])).toBe(
      deriveSemanticClusterId(['m1', 'm2', 'm3']),
    );
  });

  it('differs for different memberships', () => {
    expect(deriveSemanticClusterId(['a', 'b'])).not.toBe(
      deriveSemanticClusterId(['a', 'c']),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Clustering — agglomerative on cosine threshold
// ────────────────────────────────────────────────────────────────

const buildItem = (
  mail_id: string,
  vector: ReadonlyArray<number>,
  ingested_at: number = NOW,
) => ({
  enrichment_id: `enrich:${mail_id}`,
  mail_id,
  vector: [...vector],
  ingested_at,
});

describe('clusterByCosineSimilarity', () => {
  it('returns empty array on empty input', () => {
    expect(clusterByCosineSimilarity([])).toEqual([]);
  });

  it('keeps each item separate when no pair meets threshold (defaults filter to ≥3)', () => {
    const items = [
      buildItem('a', [1, 0, 0]),
      buildItem('b', [0, 1, 0]),
      buildItem('c', [0, 0, 1]),
    ];
    const clusters = clusterByCosineSimilarity(items);
    expect(clusters).toEqual([]);
  });

  it('merges identical-direction vectors into one cluster', () => {
    const items = [
      buildItem('a', [1, 0, 0]),
      buildItem('b', [2, 0, 0]),
      buildItem('c', [3, 0, 0]),
    ];
    const clusters = clusterByCosineSimilarity(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((m) => m.mail_id).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('separates orthogonal groups', () => {
    const items = [
      buildItem('a1', [1, 0]),
      buildItem('a2', [1, 0]),
      buildItem('a3', [1, 0]),
      buildItem('b1', [0, 1]),
      buildItem('b2', [0, 1]),
      buildItem('b3', [0, 1]),
    ];
    const clusters = clusterByCosineSimilarity(items);
    expect(clusters).toHaveLength(2);
  });

  it('respects custom threshold', () => {
    const items = [
      // Two items with cosine ≈ 0.85 — merge under 0.80, not under 0.90
      buildItem('a', [1, 0]),
      buildItem('b', [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)]),
      buildItem('c', [1, 0]),
    ];
    const tightThreshold = clusterByCosineSimilarity(items, 0.95);
    // At 0.95 only the two identical-direction vectors merge → 1 cluster of 2
    // (below MIN_MAILS_PER_CLUSTER=3) → empty.
    expect(tightThreshold).toEqual([]);

    const looseThreshold = clusterByCosineSimilarity(items, 0.7);
    // At 0.7 all three merge.
    expect(looseThreshold).toHaveLength(1);
  });

  it('respects custom minMembers floor', () => {
    const items = [buildItem('a', [1, 0]), buildItem('b', [1, 0])];
    const clusters = clusterByCosineSimilarity(items, 0.7, 2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toHaveLength(2);
  });

  it('default threshold + min match exported constants', () => {
    expect(SEMANTIC_CLUSTER_COSINE_THRESHOLD).toBe(0.8);
    expect(SEMANTIC_CLUSTER_MIN_MAILS_PER_CLUSTER).toBe(3);
    expect(SEMANTIC_CLUSTER_MAX_CLUSTERS).toBe(15);
  });
});

// ────────────────────────────────────────────────────────────────
// capSemanticClusters
// ────────────────────────────────────────────────────────────────

describe('capSemanticClusters', () => {
  const buildCluster = (count: number, vec: ReadonlyArray<number> = [1, 0, 0]) => ({
    members: Array.from({ length: count }, (_, i) =>
      buildItem(`m${count}-${i}`, vec),
    ),
    centroid: [...vec],
  });

  it('keeps all clusters when below cap', () => {
    const out = capSemanticClusters([buildCluster(3), buildCluster(4)], 5);
    expect(out).toHaveLength(2);
  });

  it('caps at cap, keeping largest by member count', () => {
    const clusters = [
      buildCluster(3),
      buildCluster(7),
      buildCluster(5),
      buildCluster(4),
    ];
    const out = capSemanticClusters(clusters, 2);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.members.length).sort((a, b) => b - a)).toEqual([
      7,
      5,
    ]);
  });

  it('is no-op on empty input', () => {
    expect(capSemanticClusters([])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// pickDominantModelGroup
// ────────────────────────────────────────────────────────────────

describe('pickDominantModelGroupForSemanticCluster', () => {
  it('returns null on empty input', () => {
    expect(pickDominantModelGroupForSemanticCluster([])).toBeNull();
  });

  it('returns null when no group meets minItems floor', () => {
    const items = [
      { ...buildItem('a', [1, 0]), model: 'modelX' },
      { ...buildItem('b', [1, 0]), model: 'modelY' },
    ];
    expect(pickDominantModelGroupForSemanticCluster(items, 3)).toBeNull();
  });

  it('returns the largest group when multiple models present', () => {
    const items = [
      { ...buildItem('a1', [1, 0]), model: 'modelA' },
      { ...buildItem('a2', [1, 0]), model: 'modelA' },
      { ...buildItem('a3', [1, 0]), model: 'modelA' },
      { ...buildItem('b1', [0, 1]), model: 'modelB' },
      { ...buildItem('b2', [0, 1]), model: 'modelB' },
    ];
    const result = pickDominantModelGroupForSemanticCluster(items, 2);
    expect(result).not.toBeNull();
    expect(result!.model).toBe('modelA');
    expect(result!.items).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────
// assembleSemanticCluster
// ────────────────────────────────────────────────────────────────

describe('assembleSemanticCluster', () => {
  it('produces a SemanticClusterValue with sorted members + centroid sidecar', () => {
    const candidate = {
      members: [
        buildItem('m3', [1, 0, 0], NOW - ONE_HOUR),
        buildItem('m1', [1, 0, 0], NOW),
        buildItem('m2', [1, 0, 0], NOW - 30 * 60 * 1000),
      ],
      centroid: [1, 0, 0],
    };
    const { value, derived_entity_id, sidecar_vector } = assembleSemanticCluster(
      candidate,
      'modelA',
      NOW,
    );
    expect(value.members).toEqual(['m1', 'm2', 'm3']);
    expect(value.member_count).toBe(3);
    expect(value.model).toBe('modelA');
    expect(value.last_ingested_at).toBe(NOW);
    expect(value.computed_at).toBe(NOW);
    expect(value.avg_intra_similarity).toBeCloseTo(1.0, 6);
    expect(derived_entity_id).toMatch(/^semantic_cluster_[a-f0-9]+$/);
    expect(sidecar_vector.byteLength).toBe(12); // 3 floats × 4 bytes
  });
});

// ────────────────────────────────────────────────────────────────
// Embedding scan
// ────────────────────────────────────────────────────────────────

describe('scanEmbeddingsForSemanticCluster', () => {
  it('returns empty array when tables are missing', () => {
    // close + reopen with fresh db without enrichment-store init
    store.close();
    db.close();
    db = new Database(join(dir, 'empty.db'));
    expect(scanEmbeddingsForSemanticCluster(buildCtx())).toEqual([]);
  });

  it('returns empty array when no embedding rows exist', () => {
    expect(scanEmbeddingsForSemanticCluster(buildCtx())).toEqual([]);
  });

  it('returns rows with scope=mail / topic=embedding joined with vector buffer', () => {
    insertEmbedding({ mail_id: 'mail-1', vector: [1, 0] });
    insertEmbedding({ mail_id: 'mail-2', vector: [0, 1] });
    const out = scanEmbeddingsForSemanticCluster(buildCtx());
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.mail_id).sort()).toEqual(['mail-1', 'mail-2']);
    expect(out[0]!.vector.length).toBe(2);
    expect(out[0]!.model).toBe('text-embedding-3-small');
  });

  it('drops rows whose value is missing the model field', () => {
    // Manually insert a malformed row (skipping store.upsert validation
    // to simulate schema drift).
    const id = insertEmbedding({ mail_id: 'good', vector: [1, 0] });
    db.prepare(
      `UPDATE data_enrichment SET value = '{"dimensions":2}' WHERE _id = ?`,
    ).run(id);
    const out = scanEmbeddingsForSemanticCluster(buildCtx());
    expect(out).toEqual([]);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i += 1) {
      insertEmbedding({
        mail_id: `m${i}`,
        vector: [1, 0],
        ingested_at: NOW - i * ONE_HOUR,
      });
    }
    const out = scanEmbeddingsForSemanticCluster(buildCtx(), 3);
    expect(out).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────
// runSemanticClusterCycle — end-to-end orchestration
// ────────────────────────────────────────────────────────────────

const seedSemanticCorpus = (): void => {
  // Cluster A: 4 mails with very similar vectors
  insertEmbedding({ mail_id: 'a1', vector: [1, 0.05, 0] });
  insertEmbedding({ mail_id: 'a2', vector: [1, 0, 0.05] });
  insertEmbedding({ mail_id: 'a3', vector: [0.99, 0.05, 0.02] });
  insertEmbedding({ mail_id: 'a4', vector: [1, 0.02, 0.03] });
  // Cluster B: 3 mails along a different axis
  insertEmbedding({ mail_id: 'b1', vector: [0, 1, 0.02] });
  insertEmbedding({ mail_id: 'b2', vector: [0.05, 1, 0] });
  insertEmbedding({ mail_id: 'b3', vector: [0, 0.99, 0.05] });
  // Singleton (gets dropped by min-members filter): orthogonal direction
  insertEmbedding({ mail_id: 'c1', vector: [0, 0, 1] });
};

describe('runSemanticClusterCycle', () => {
  it('produces zero rows on empty corpus', () => {
    const out = runSemanticClusterCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('produces zero rows when no group meets minimum size', () => {
    insertEmbedding({ mail_id: 'a1', vector: [1, 0] });
    insertEmbedding({ mail_id: 'a2', vector: [1, 0] });
    const out = runSemanticClusterCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('happy path — emits one row per dense cluster', () => {
    seedSemanticCorpus();
    const out = runSemanticClusterCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope).toBeNull();
      expect(row.target_id).toBeNull();
      expect(row.authored_by).toBe(SEMANTIC_CLUSTER_AUTHORED_BY);
      const v = row.value as SemanticClusterValue;
      expect(v.member_count).toBeGreaterThanOrEqual(SEMANTIC_CLUSTER_MIN_MAILS_PER_CLUSTER);
      expect(v.members.length).toBe(v.member_count);
      expect(v.model).toBe('text-embedding-3-small');
      expect(v.avg_intra_similarity).toBeGreaterThanOrEqual(SEMANTIC_CLUSTER_COSINE_THRESHOLD);
    }
  });

  it('drops singletons before emit', () => {
    seedSemanticCorpus();
    runSemanticClusterCycle(buildCtx());
    const rows = store.list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false });
    const allMembers = rows.flatMap((r) => (r.value as SemanticClusterValue).members);
    expect(allMembers).not.toContain('c1');
  });

  it('persists centroid to data_enrichment_vector_index sidecar', () => {
    seedSemanticCorpus();
    runSemanticClusterCycle(buildCtx());
    const rows = store.list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false });
    for (const row of rows) {
      const sidecar = db
        .prepare('SELECT vector FROM data_enrichment_vector_index WHERE enrichment_id = ?')
        .get(row._id) as { vector: Buffer } | undefined;
      expect(sidecar).toBeDefined();
      expect(sidecar!.vector.byteLength).toBeGreaterThan(0);
      expect(sidecar!.vector.byteLength % 4).toBe(0);
    }
  });

  it('produces stable derived_entity_id across runs with the same corpus', () => {
    seedSemanticCorpus();
    runSemanticClusterCycle(buildCtx());
    const firstIds = store
      .list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    runSemanticClusterCycle(buildCtx());
    const secondIds = store
      .list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    expect(firstIds).toEqual(secondIds);
    expect(secondIds).toHaveLength(2);
  });

  it('skips minor-model rows in favour of dominant model', () => {
    // 3 vectors for modelA — all tightly clustered
    insertEmbedding({ mail_id: 'a1', vector: [1, 0], model: 'modelA' });
    insertEmbedding({ mail_id: 'a2', vector: [1, 0], model: 'modelA' });
    insertEmbedding({ mail_id: 'a3', vector: [1, 0], model: 'modelA' });
    // 2 vectors for modelB — clustered but below dominant
    insertEmbedding({ mail_id: 'b1', vector: [0, 1], model: 'modelB' });
    insertEmbedding({ mail_id: 'b2', vector: [0, 1], model: 'modelB' });

    runSemanticClusterCycle(buildCtx());
    const rows = store.list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.value as SemanticClusterValue).model).toBe('modelA');
  });

  it('semanticClusterTask.step returns complete cursor', async () => {
    seedSemanticCorpus();
    const result = await semanticClusterTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema', () => {
    seedSemanticCorpus();
    expect(() => runSemanticClusterCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep stale rows
// ────────────────────────────────────────────────────────────────

describe('sweepStaleSemanticClusters', () => {
  const insertCluster = (id: string): void => {
    store.upsert({
      topic: 'semantic_cluster',
      derived_entity_id: id,
      value: {
        members: ['m1', 'm2', 'm3'],
        member_count: 3,
        model: 'text-embedding-3-small',
        avg_intra_similarity: 0.95,
        last_ingested_at: NOW,
        computed_at: NOW,
      },
      authored_by: SEMANTIC_CLUSTER_AUTHORED_BY,
      sidecar_vector: encodeSemanticClusterCentroid([1, 0, 0]),
    });
  };

  it('deletes rows whose id is not in the fresh set', () => {
    insertCluster('semantic_cluster_kept');
    insertCluster('semantic_cluster_orphan');
    const result = sweepStaleSemanticClusters(
      buildCtx(),
      new Set(['semantic_cluster_kept']),
    );
    expect(result.deleted).toBe(1);
    const remaining = store.list({
      topic: SEMANTIC_CLUSTER_TOPIC,
      fresh_only: false,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!._id).toBe('semantic_cluster_kept');
  });

  it('FK CASCADE drops sidecar centroid on delete', () => {
    insertCluster('semantic_cluster_with_sidecar');
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM data_enrichment_vector_index')
      .get() as { n: number };
    expect(before.n).toBe(1);
    sweepStaleSemanticClusters(buildCtx(), new Set());
    const after = db
      .prepare('SELECT COUNT(*) AS n FROM data_enrichment_vector_index')
      .get() as { n: number };
    expect(after.n).toBe(0);
  });

  it('cycle 2 sweeps a cluster whose membership shifted entirely', () => {
    seedSemanticCorpus();
    runSemanticClusterCycle(buildCtx());
    expect(
      store.list({ topic: SEMANTIC_CLUSTER_TOPIC, fresh_only: false }),
    ).toHaveLength(2);

    // Delete every embedding whose mail_id starts with 'b' (cluster B)
    db.prepare(
      `DELETE FROM data_enrichment WHERE topic = 'embedding' AND target_id LIKE 'b%'`,
    ).run();
    runSemanticClusterCycle(buildCtx());
    const rows = store.list({
      topic: SEMANTIC_CLUSTER_TOPIC,
      fresh_only: false,
    });
    expect(rows).toHaveLength(1);
    const surviving = rows[0]!.value as SemanticClusterValue;
    expect(surviving.members.some((m) => m.startsWith('a'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema
// ────────────────────────────────────────────────────────────────

describe('semantic_cluster value_schema', () => {
  const validate = ENRICHMENT_REGISTRY.semantic_cluster.value_schema;

  const goodValue: SemanticClusterValue = {
    members: ['m1', 'm2', 'm3'],
    member_count: 3,
    model: 'text-embedding-3-small',
    avg_intra_similarity: 0.92,
    last_ingested_at: NOW,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    expect(validate(goodValue).ok).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(validate('not an object').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
    expect(validate([]).ok).toBe(false);
  });

  it('rejects empty members array', () => {
    expect(validate({ ...goodValue, members: [] }).ok).toBe(false);
  });

  it('rejects non-string member entries', () => {
    expect(validate({ ...goodValue, members: ['m1', 42] }).ok).toBe(false);
  });

  it('rejects non-finite member_count', () => {
    expect(validate({ ...goodValue, member_count: NaN }).ok).toBe(false);
  });

  it('rejects empty model string', () => {
    expect(validate({ ...goodValue, model: '' }).ok).toBe(false);
  });

  it('rejects non-string model', () => {
    expect(validate({ ...goodValue, model: 42 }).ok).toBe(false);
  });

  it('rejects non-finite avg_intra_similarity', () => {
    expect(validate({ ...goodValue, avg_intra_similarity: NaN }).ok).toBe(false);
  });

  it('rejects missing computed_at', () => {
    const { computed_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });

  it('rejects missing last_ingested_at', () => {
    const { last_ingested_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });
});
