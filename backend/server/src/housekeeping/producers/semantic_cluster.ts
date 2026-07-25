/** D-131 A.17 — `semantic_cluster` enrichment producer.
 *
 *  Fourth Shape B (derived-entity) housekeeping producer in Phase A;
 *  first `vector_index` sidecar consumer. `members_list` policy with
 *  `members_scope: 'mail'`: each cluster owns the list of mail
 *  target_ids that grouped together by embedding similarity. The
 *  cascade engine trims those ids on mail-source-delete via the
 *  `members_list` policy; when the list empties, the row is dropped
 *  automatically.
 *
 *  Standalone `HousekeepingTaskInstance` (matches `topicClusterTask` /
 *  `workingGroupTask` / `organizationTask` precedent — Shape B
 *  aggregates whole-corpus rather than per-record).
 *
 *  Reads pre-computed embeddings from A.3 (`embedding` topic, vector
 *  in `data_enrichment_vector_index` sidecar) — no AI call inside this
 *  producer. Pure cosine-similarity agglomerative clustering. The
 *  cluster centroid persists alongside each row as `sidecar_vector` so
 *  future similarity-search recipes can match query vectors against
 *  cluster centroids to find related groups of mail.
 *
 *  Different from A.14 `topic_cluster`:
 *
 *    - Clustering signal = embeddings (semantic), not subject tokens
 *      (lexical). Same-meaning mails with different vocabularies still
 *      cluster — that's the whole point.
 *    - No internal AI call. A.3 already produced the vectors.
 *    - `sidecar: 'vector_index'` carries the centroid for similarity
 *      queries (vs `sidecar: 'none'` on `topic_cluster`).
 *
 *  Algorithm:
 *
 *    1. **Embedding scan.** List every Shape A row where
 *       `topic = 'embedding'`, scope: 'mail', joined with the
 *       `data_enrichment_vector_index` sidecar for the float buffer.
 *       Capped at `MAX_EMBEDDINGS_SCANNED` per cycle.
 *
 *    2. **Group by model.** Embedding vectors from different models
 *       live in different vector spaces with different dimensions —
 *       cosine similarity across models is meaningless. Pick the model
 *       with the largest member set + cluster only that group. Minor-
 *       model rows are silently skipped this cycle.
 *
 *    3. **Agglomerative cluster.** Single-link greedy: each mail starts
 *       as its own cluster, find the highest-similarity pair above
 *       `COSINE_THRESHOLD = 0.80`, merge, recompute centroid, repeat
 *       until no pair meets threshold. Mirrors `topic_cluster`'s
 *       `clusterThreads` shape.
 *
 *    4. **Filter + cap.** Drop clusters with fewer than
 *       `MIN_MAILS_PER_CLUSTER = 3` members. Cap at `MAX_CLUSTERS = 15`
 *       (matches `topic_cluster` for the warehouse-explorer rendering
 *       budget) by member count desc + tiebreak on intra-similarity desc.
 *
 *    5. **Stable id.** `derived_entity_id =
 *       semantic_cluster_<sha1-prefix(sorted_member_ids)>`. Stable across
 *       runs for the same membership; new mail joins → new id → new row;
 *       old row swept by manual sweep step. The membership-derived id
 *       is the canonical Shape B `members_list` pattern (different from
 *       `topic_cluster`'s theme-token signature).
 *
 *    6. **Sweep stale.** Delete every existing row of the topic whose
 *       id wasn't refreshed this cycle.
 *
 *  Pre-launch zero-installs semantics: the producer is the single
 *  source of truth for `semantic_cluster` rows; eager sweep keeps stale
 *  clusters from accumulating. */

import { createHash } from 'node:crypto';

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type SemanticClusterValue,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Hard cap on embedding rows folded into one cycle. The agglomerative
 *  algorithm is O(n²); 1000 rows is ~500K pair comparisons. The cap
 *  keeps cycle latency bounded; A.3 marks rows stale on body change so
 *  the corpus tends to stay manageable on a per-pair basis. */
export const MAX_EMBEDDINGS_SCANNED = 1000;

/** Cosine similarity floor for cluster merging. 0.80 picks "clearly
 *  related" — typical for mails that share a topic or thread context.
 *  Tightening to 0.85+ produces too many singletons; loosening below
 *  0.75 starts to merge unrelated content. The threshold tracks
 *  `topic_cluster`'s `JACCARD_THRESHOLD = 0.30` in spirit (tuned for
 *  the metric's typical "related-but-distinct" range). */
export const COSINE_THRESHOLD = 0.8;

/** Minimum mails per cluster before it emits. n=3 mirrors the broader
 *  Shape B convention — singletons are mail messages, pairs are
 *  potentially noise, three is the floor for "cluster." */
export const MIN_MAILS_PER_CLUSTER = 3;

/** Cap on emitted clusters per cycle. 15 matches `topic_cluster` for
 *  warehouse-explorer / detail-drawer rendering budget. */
export const MAX_CLUSTERS = 15;

/** Hash prefix length on the `derived_entity_id`. 12 hex chars matches
 *  `topic_cluster` / `working_group` / `organization` for symmetric-
 *  looking ids in the warehouse explorer. */
export const ID_HASH_PREFIX_LEN = 12;

/** Per-cycle token estimate for the Run-Now cost preview. Zero —
 *  embedding generation already happened in A.3 (which has its own
 *  cost preview); A.17 only does pure-math clustering on the persisted
 *  vectors. */
export const TOKEN_ESTIMATE_PER_CYCLE = 0;

/** Authored-by stamp for semantic_cluster rows. Keeps Memory feed
 *  attribution clean alongside the other Shape B housekeeping
 *  producers. */
export const SEMANTIC_CLUSTER_AUTHORED_BY = 'system.housekeeping.semantic_cluster';

/** Topic key for this producer's emitted rows. */
export const SEMANTIC_CLUSTER_TOPIC: EnrichmentTopic = 'semantic_cluster';

/** Source topic that this producer reads from. */
const EMBEDDING_TOPIC = 'embedding';

// ────────────────────────────────────────────────────────────────
// Pure helpers — math
// ────────────────────────────────────────────────────────────────

/** Cosine similarity between two equal-length vectors. Returns 0 when
 *  either vector has zero magnitude (degenerate / all-zeros case —
 *  shouldn't happen with real embeddings but defensive). Caller is
 *  responsible for ensuring matching dimensions; the producer's scan
 *  filters to a single model so this invariant holds. */
export const cosineSimilarity = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

/** Decode a `Float32Array` from the `data_enrichment_vector_index`
 *  Buffer column. The embedding producer wrote it via
 *  `Float32Array.from(...).buffer`, so reading back as Float32 is
 *  symmetric. Rejects buffers whose byteLength isn't a multiple of 4. */
export const decodeVector = (buf: Buffer): number[] | null => {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(f32);
};

/** Compute the element-wise mean (centroid) of a non-empty list of
 *  equal-length vectors. Returns null when the input is empty or
 *  vectors disagree on dimension. */
export const computeCentroid = (
  vectors: ReadonlyArray<ReadonlyArray<number>>,
): number[] | null => {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  if (dim === 0) return null;
  if (vectors.some((v) => v.length !== dim)) return null;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) {
      sum[i]! += v[i]!;
    }
  }
  for (let i = 0; i < dim; i += 1) {
    sum[i]! /= vectors.length;
  }
  return sum;
};

/** Encode a `number[]` centroid as the Float32 Buffer the vector_index
 *  sidecar consumes. Symmetric with `decodeVector` + the embedding
 *  producer's own `vectorToBuffer`. */
export const encodeCentroid = (vec: ReadonlyArray<number>): Buffer => {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

// ────────────────────────────────────────────────────────────────
// Pure helpers — clustering
// ────────────────────────────────────────────────────────────────

/** One mail-with-vector boiled down to the fields the producer
 *  consumes. */
export interface ScannedEmbedding {
  enrichment_id: string;
  mail_id: string;
  vector: number[];
  ingested_at: number;
}

/** A candidate cluster prior to emit — collects mails sharing
 *  embedding-similarity above threshold; min-members + cap filters
 *  apply downstream. */
export interface CandidateCluster {
  members: ScannedEmbedding[];
  centroid: number[];
}

/** Agglomerative single-link clustering on cosine-similarity centroids.
 *  Mirrors `topic_cluster.ts:clusterThreads` shape. Each item starts as
 *  its own cluster; greedy-merge the highest-similarity pair above
 *  threshold; recompute centroid; repeat until no pair meets threshold.
 *
 *  Complexity: O(n²) per pass; up to n-1 passes worst case. For n =
 *  1000 (the cap), that's ~5×10⁸ comparisons in the worst case. In
 *  practice clusters merge fast and the loop exits early. The
 *  per-pass O(n²) is dominated by the cosine call which is itself
 *  O(d) where d is vector dimension — typical embeddings are 768-1536
 *  so each comparison is a few microseconds. */
export const clusterByCosineSimilarity = (
  items: ReadonlyArray<ScannedEmbedding>,
  threshold: number = COSINE_THRESHOLD,
  minMembers: number = MIN_MAILS_PER_CLUSTER,
): CandidateCluster[] => {
  const clusters: CandidateCluster[] = items.map((item) => ({
    members: [item],
    centroid: [...item.vector],
  }));

  let merged = true;
  while (merged) {
    merged = false;
    let bestI = -1;
    let bestJ = -1;
    let bestScore = threshold;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = cosineSimilarity(clusters[i]!.centroid, clusters[j]!.centroid);
        if (score >= bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI !== -1 && bestJ !== -1) {
      const a = clusters[bestI]!;
      const b = clusters[bestJ]!;
      const merged_members = [...a.members, ...b.members];
      const new_centroid = computeCentroid(merged_members.map((m) => m.vector))!;
      clusters.splice(bestJ, 1);
      clusters.splice(bestI, 1, {
        members: merged_members,
        centroid: new_centroid,
      });
      merged = true;
    }
  }

  return clusters.filter((c) => c.members.length >= minMembers);
};

/** Compute the average pairwise cosine similarity within a cluster.
 *  O(n²) in cluster size — for capped n≤1000 within a single cluster
 *  this is up to 500K comparisons; bounded by the per-cycle cap
 *  upstream. Returns 1.0 for singleton clusters (vacuously identical)
 *  and 0 for empty clusters. */
export const avgIntraSimilarity = (
  vectors: ReadonlyArray<ReadonlyArray<number>>,
): number => {
  if (vectors.length === 0) return 0;
  if (vectors.length === 1) return 1;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      sum += cosineSimilarity(vectors[i]!, vectors[j]!);
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
};

/** Cap clusters at MAX_CLUSTERS by member count desc with intra-
 *  similarity desc tiebreak (tighter clusters win on tie). Stable sort
 *  semantics rely on JS Array.sort. */
export const capClusters = (
  clusters: ReadonlyArray<CandidateCluster>,
  cap: number = MAX_CLUSTERS,
): CandidateCluster[] => {
  const ranked = clusters.slice().sort((a, b) => {
    if (b.members.length !== a.members.length) {
      return b.members.length - a.members.length;
    }
    const simA = avgIntraSimilarity(a.members.map((m) => m.vector));
    const simB = avgIntraSimilarity(b.members.map((m) => m.vector));
    return simB - simA;
  });
  return ranked.slice(0, cap);
};

/** Compose the stable `derived_entity_id` for a cluster. Hashes the
 *  sorted member-id list — same membership across runs hashes to the
 *  same id, so re-runs upsert in place rather than churning ids. */
export const deriveDerivedEntityId = (member_ids: ReadonlyArray<string>): string => {
  const sorted = [...member_ids].sort().join(',');
  const digest = createHash('sha1').update(sorted).digest('hex');
  return `semantic_cluster_${digest.slice(0, ID_HASH_PREFIX_LEN)}`;
};

// ────────────────────────────────────────────────────────────────
// Embedding scan
// ────────────────────────────────────────────────────────────────

/** Read every embedding row joined with its vector_index sidecar.
 *  Returns at most `limit` rows, ordered by `ingested_at` desc. Drops
 *  rows whose vector buffer is malformed (non-Float32 byteLength) or
 *  whose `value.model` is missing — both should be impossible per
 *  A.3's validation, but defensive against schema drift. */
export const scanEmbeddings = (
  ctx: HousekeepingContext,
  limit: number = MAX_EMBEDDINGS_SCANNED,
): Array<ScannedEmbedding & { model: string }> => {
  // Tolerate missing tables — fresh-pair / first-boot before any
  // embedding has been computed yet. The producer returns zero
  // candidates; sweep drops any rows from prior runs.
  const tableExists = ctx.db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name IN ('data_enrichment', 'data_enrichment_vector_index')`,
    )
    .all() as Array<{ name: string }>;
  if (tableExists.length < 2) return [];

  const rows = ctx.db
    .prepare(
      `SELECT e._id AS enrichment_id,
              e.target_id AS mail_id,
              e.value AS value_json,
              e.ingested_at AS ingested_at,
              v.vector AS vector_buf
         FROM data_enrichment e
         JOIN data_enrichment_vector_index v ON v.enrichment_id = e._id
         WHERE e.topic = ?
           AND e.staleness_class = 'fresh'
         ORDER BY e.ingested_at DESC
         LIMIT ?`,
    )
    .all(EMBEDDING_TOPIC, limit) as Array<{
      enrichment_id: string;
      mail_id: string;
      value_json: string;
      ingested_at: number;
      vector_buf: Buffer;
    }>;

  const out: Array<ScannedEmbedding & { model: string }> = [];
  for (const row of rows) {
    let model: string;
    try {
      const parsed = JSON.parse(row.value_json) as { model?: unknown };
      if (typeof parsed.model !== 'string' || parsed.model.length === 0) continue;
      model = parsed.model;
    } catch {
      continue;
    }
    const vector = decodeVector(row.vector_buf);
    if (vector === null || vector.length === 0) continue;
    out.push({
      enrichment_id: row.enrichment_id,
      mail_id: row.mail_id,
      vector,
      ingested_at: row.ingested_at,
      model,
    });
  }
  return out;
};

/** Group scanned embeddings by their model id; returns the model with
 *  the largest membership + the items in that group. Minor-model rows
 *  are dropped this cycle (the next cycle re-evaluates which is
 *  largest). Returns null when no group has at least
 *  `MIN_MAILS_PER_CLUSTER` items — clustering anything smaller can't
 *  produce an emit-eligible cluster. */
export const pickDominantModelGroup = (
  items: ReadonlyArray<ScannedEmbedding & { model: string }>,
  minItems: number = MIN_MAILS_PER_CLUSTER,
): { model: string; items: ScannedEmbedding[] } | null => {
  if (items.length === 0) return null;
  const groups = new Map<string, ScannedEmbedding[]>();
  for (const item of items) {
    const group = groups.get(item.model);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.model, [item]);
    }
  }
  let bestModel: string | null = null;
  let bestSize = 0;
  for (const [model, group] of groups) {
    if (group.length > bestSize) {
      bestModel = model;
      bestSize = group.length;
    }
  }
  if (bestModel === null || bestSize < minItems) return null;
  return { model: bestModel, items: groups.get(bestModel)! };
};

// ────────────────────────────────────────────────────────────────
// Assemble + sweep
// ────────────────────────────────────────────────────────────────

/** Build a `SemanticClusterValue` + the stable `derived_entity_id` +
 *  the centroid as a Float32 Buffer ready for `sidecar_vector` upsert.
 *  Members deduplicated + sorted for deterministic JSON output. */
export const assembleCluster = (
  cluster: CandidateCluster,
  model: string,
  now: number,
): { value: SemanticClusterValue; derived_entity_id: string; sidecar_vector: Buffer } => {
  const memberIds = Array.from(new Set(cluster.members.map((m) => m.mail_id))).sort();
  const lastIngested = cluster.members.reduce(
    (max, m) => (m.ingested_at > max ? m.ingested_at : max),
    0,
  );
  const intraSim = avgIntraSimilarity(cluster.members.map((m) => m.vector));
  const centroidBuf = encodeCentroid(cluster.centroid);
  const value: SemanticClusterValue = {
    members: memberIds,
    member_count: memberIds.length,
    model,
    avg_intra_similarity: intraSim,
    last_ingested_at: lastIngested,
    computed_at: now,
  };
  return {
    value,
    derived_entity_id: deriveDerivedEntityId(memberIds),
    sidecar_vector: centroidBuf,
  };
};

/** Sweep stale rows: list every existing semantic_cluster row,
 *  deleteById any whose id wasn't refreshed this cycle. FK CASCADE on
 *  `data_enrichment_vector_index` handles the centroid sidecar
 *  automatically. Pre-launch zero-installs semantics — eager pruning
 *  keeps the warehouse explorer free of decayed clusters. */
export const sweepStaleClusters = (
  ctx: HousekeepingContext,
  freshIds: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: SEMANTIC_CLUSTER_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (freshIds.has(row._id)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

// ────────────────────────────────────────────────────────────────
// Step
// ────────────────────────────────────────────────────────────────

/** One-shot scan-and-emit cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced }` for caller-side
 *  assertions on cycle output. */
export const runSemanticClusterCycle = (
  ctx: HousekeepingContext,
): { produced: number } => {
  const now = ctx.now();
  const scanned = scanEmbeddings(ctx);
  if (scanned.length === 0) {
    sweepStaleClusters(ctx, new Set());
    return { produced: 0 };
  }

  const dominant = pickDominantModelGroup(scanned);
  if (dominant === null) {
    sweepStaleClusters(ctx, new Set());
    return { produced: 0 };
  }

  const candidates = clusterByCosineSimilarity(dominant.items);
  const clusters = capClusters(candidates);
  if (clusters.length === 0) {
    sweepStaleClusters(ctx, new Set());
    return { produced: 0 };
  }

  const freshIds = new Set<string>();
  let produced = 0;
  for (const cluster of clusters) {
    const { value, derived_entity_id, sidecar_vector } = assembleCluster(
      cluster,
      dominant.model,
      now,
    );
    // D-136 P7.D Codex review fix — stamp `model_id` so the
    // `data_enrichment.model_id` column reflects the cohort the
    // centroid belongs to. Mirrors the `embedding` producer; without
    // this, the cluster sidecar's vectors are unfilterable by cohort
    // through the standard `mcp.vector.similarity_search` SQL path
    // (which gates on the column, not the value field). The value
    // already carries `model` for backwards-compat readers.
    ctx.enrichmentStore.upsert({
      topic: SEMANTIC_CLUSTER_TOPIC,
      derived_entity_id,
      value,
      authored_by: SEMANTIC_CLUSTER_AUTHORED_BY,
      model_id: dominant.model,
      sidecar_vector,
      event_at: now,
    });
    freshIds.add(derived_entity_id);
    produced += 1;
  }

  sweepStaleClusters(ctx, freshIds);
  return { produced };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const semanticClusterTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.semantic_cluster',
    description:
      'Cluster mail by embedding similarity; one row per semantic cluster with centroid vector.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.semantic_cluster,
      isAiSurface: false,
    }),
  },
  topic: SEMANTIC_CLUSTER_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runSemanticClusterCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Always 0 —
 *  the embedding generation already happened in A.3 (which carries
 *  its own per-record cost preview). A.17 only does pure-math
 *  clustering on the persisted vectors. */
export const semanticClusterTokenEstimate = (): number => TOKEN_ESTIMATE_PER_CYCLE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. The producer reads from the enrichment store
 *  (`data.enrichment.embedding`) — not directly from the source mail
 *  collection — so the declaration reflects that indirection. */
export const semanticClusterScopeReadDeclaration = [
  {
    collection: 'data.enrichment.embedding',
    sample_field_paths: ['model', 'dimensions'],
  },
] as const;
