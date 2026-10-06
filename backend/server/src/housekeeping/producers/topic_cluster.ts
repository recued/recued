/** D-131 A.14 — `topic_cluster` enrichment producer.
 *
 *  First Shape B (derived-entity) housekeeping producer in Phase A.
 *  `members_list` policy with `members_scope: 'mail'`: each cluster
 *  owns a list of mail message ids; the cascade engine trims those
 *  ids on mail-delete via `members_list` policy and drops a row when
 *  its members list empties.
 *
 *  Built as a standalone `HousekeepingTaskInstance` rather than a
 *  `buildEnrichmentProducerTask` wrap because Shape B clusters across
 *  the whole mail corpus rather than per-record. Same precedent as
 *  `confidenceDriftSignalTask` — different iteration shape from the
 *  source-record walker pattern, so the harness's per-record cursor
 *  + skip-rule + stale-sweep loop don't apply.
 *
 *  Algorithm (full spec on the registry-side comment for `topic_cluster`):
 *
 *    1. **Mail scan.** Walk every `collection_mail_*` table for
 *       messages received within `MAIL_LOOKBACK_MS`, capped at
 *       `MAX_MESSAGES_SCANNED`. Newest first.
 *
 *    2. **Group by thread.** Each thread is one clustering atom —
 *       same thread always lands in the same cluster.
 *
 *    3. **Token bag per thread.** Normalise the most-recent subject
 *       (lowercase, strip `Re:` / `Fwd:` prefixes + punctuation, drop
 *       stopwords + 1-char tokens). Each thread carries a `tokens:
 *       Set<string>` bag.
 *
 *    4. **Agglomerative cluster.** Single-link merge by token-bag
 *       Jaccard similarity ≥ `JACCARD_THRESHOLD`. Discard clusters
 *       with fewer than `MIN_THREADS_PER_CLUSTER` threads (single-
 *       thread clusters are noise). Cap at `MAX_CLUSTERS`, keeping
 *       the largest by message count.
 *
 *    5. **AI labels.** One `ai-extract` call labels every cluster in
 *       a single batch — `{ cluster_index, topic_name, summary }` per
 *       cluster. Closed-shape validation drops fabricated indices.
 *
 *    6. **Stable id.** `derived_entity_id` =
 *       `topic_cluster_<sha1-prefix(sorted theme tokens)>`. Stable
 *       across runs while the theme persists; upserts refresh members
 *       in place. New theme → new id; old theme dropped → row swept.
 *
 *    7. **Sweep stale.** List every existing row of the topic; delete
 *       any not refreshed this cycle (theme no longer present in the
 *       corpus or member list dropped below threshold).
 *
 *  Pool-policy + trust-gate threading: this task is `is_ai_surface:
 *  true` so the scheduler skips it from idle cycles for users with
 *  `default_trust_state: 'manual'`. Run-Now bypasses the gate; the
 *  task itself reads trust state to compute the effective `ForceLayer`
 *  and threads it into the `ai-extract` input map. */

import { createHash } from 'node:crypto';

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  computeInputFingerprintHash,
  computeProducerVersionHash,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type IngredientManifest,
  type TopicCluster,
} from '@recued/contracts';
import type { ForceLayer } from '@recued/llm';

import type { HousekeepingContext } from '../registry.js';
import type { HousekeepingTaskInstance } from '../registry.js';
import { wrapHousekeepingCtxForFanIn } from '../enrichment-pii-egress.js';
import {
  isByokAllowedForBackground,
  type TrustStore,
} from '../trust-store.js';
import { listCollectionDataTables } from '../../collections/table.js';

/** D-136 P3 — producer-version hash. */
const baseProducerVersionHash = computeProducerVersionHash({
  producer_code_hash: 'topic_cluster:1',
  model_id: '',
  // v2: `ai-extract` began sending `llm.context` (LABELLING_CONTEXT) — v1 rows were
  // labelled without it.
  prompt_template_hash: 'topic_cluster_label_v2',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [{ slug: 'ai-extract', version: '1' }],
});

/** D-136 P3 — fold the cluster's contributing mail message ids into a
 *  `perspective_fan_in` fingerprint. The mail messages are upstream
 *  *records* (not enrichments), so the upstream's
 *  `producer_version_hash` slot is empty — the message id is the
 *  identity. A member-set change flips the hash and forces recompute
 *  on the next cycle. */
const computeInputFingerprintHashLocal = (
  memberIdsSorted: ReadonlyArray<string>,
  as_of: number,
): string =>
  computeInputFingerprintHash({
    kind: 'perspective_fan_in',
    upstream: memberIdsSorted.map((id) => ({
      enrichment_row_id: id,
      producer_version_hash: '',
    })),
    as_of,
    effective_topic_config: '',
  });

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** How far back the scan reaches. 90d matches `related_threads` /
 *  `preparation_notes` look-back so calendar-driven recipes that
 *  read both surfaces see consistent corpus boundaries. */
export const MAIL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard cap on messages folded into one clustering pass. Keeps the
 *  AI prompt + the per-cycle SQL load bounded. The mail walker reads
 *  newest-first so a corpus larger than the cap loses the oldest
 *  messages — acceptable since older mail rarely defines a current
 *  topic theme. */
export const MAX_MESSAGES_SCANNED = 1500;

/** Minimum normalised-subject token-bag Jaccard similarity for two
 *  threads to merge. 0.30 picks up "weekly update Q4" and
 *  "Q4 weekly update sync" while keeping unrelated threads ("Lunch
 *  Friday" vs. "Sales pipeline") apart. Tuned empirically; future
 *  tweak lives in this constant. */
export const JACCARD_THRESHOLD = 0.3;

/** Skip clusters smaller than this. A single-thread "cluster" is a
 *  thread, not a topic — the marketplace pack reads thread-level
 *  data through other surfaces. */
export const MIN_THREADS_PER_CLUSTER = 2;

/** Cap on emitted clusters per cycle. Bounds the AI prompt size +
 *  keeps the Memory drawer scannable. Selection rule: largest by
 *  message count when more than `MAX_CLUSTERS` survive minimum-size
 *  filtering. */
export const MAX_CLUSTERS = 15;

/** Number of top tokens used to compose the theme signature behind
 *  the `derived_entity_id`. 3 tokens balances stability (small enough
 *  to survive minor token-bag drift) vs. discrimination (large
 *  enough that two genuinely different themes don't collide). */
export const THEME_TOKEN_COUNT = 3;

/** Hash prefix length on the `derived_entity_id`. 12 hex chars (48
 *  bits) is collision-resistant for the cluster-count budget while
 *  staying readable in the warehouse explorer. */
export const ID_HASH_PREFIX_LEN = 12;

/** Per-cycle token estimate for the Run-Now cost preview. ~1500
 *  input (one block per cluster of normalised subject sample) +
 *  ~500 output (topic_name + summary per cluster). Single batch
 *  call so the per-cycle spend is fixed regardless of corpus size
 *  (after the deterministic clustering bounds it to `MAX_CLUSTERS`). */
export const TOKEN_ESTIMATE_PER_CYCLE = 2000;

/** [0, 1] confidence on the row. Lower than per-record AI surfaces
 *  (`company` / `role` / `preparation_notes` at `0.85`) because the
 *  clustering is heuristic; AI only labels. D-133 PSI baselines on
 *  a different cohort — not symmetric with the per-record set. */
export const CONFIDENCE_TOPIC_CLUSTER = 0.75;

/** Authored-by stamp for topic_cluster rows. Distinct from per-
 *  record producers' stamps so the Memory feed renders cleanly. */
export const TOPIC_CLUSTER_AUTHORED_BY = 'system.housekeeping.topic_cluster';

/** Topic key for this producer's emitted rows. */
export const TOPIC_CLUSTER_TOPIC: EnrichmentTopic = 'topic_cluster';

/** Lowercase reply / forward prefixes stripped during subject
 *  normalisation. Covers the common locales seen in test mailboxes;
 *  unknown prefixes pass through and contribute their own tokens. */
const REPLY_PREFIX_RE = /^(?:re|fwd?|fw|aw|sv)\s*:\s*/i;

/** English stopwords removed from the token bag. Short list — the
 *  goal is to avoid letting "the" / "and" dominate Jaccard scores,
 *  not full NLP-grade filtering. */
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as',
  'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'it',
  'me', 'my', 'your', 'our', 'their', 'its', 'his', 'her',
  'will', 'would', 'should', 'could', 'can', 'may', 'might',
  'no', 'not', 'yes',
]);

// ────────────────────────────────────────────────────────────────
// AI manifest
// ────────────────────────────────────────────────────────────────

/** Inline `IngredientManifest` for `ai-extract`. Fifth caller of this
 *  exact shape (after `company` / `role` / `action_items` /
 *  `related_threads`); per the codebase's third-caller-extracts
 *  convention, this is overdue for a shared kernel-manifest helper.
 *  Intentionally deferred — the next AI-extract producer (or the
 *  next session that touches all five) is the right moment to lift
 *  the manifest into a shared `_kernel-manifests.ts`. Inlining keeps
 *  the A.14 diff focused on the new producer. */
const aiExtractManifest: IngredientManifest = {
  slug: 'ai-extract',
  name: 'AI Field Extractor',
  description:
    'Extracts a caller-specified set of fields from unstructured input into a flat object.',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: ['ai', 'extraction'],
  input: {
    'llm.data': null,
    'llm.fields': null,
    'llm.context': null,
    'llm.model_hint': null,
  },
  output: {
    extracted: 'dynamic_fields_per_llm_fields_input',
  },
};

/** Pinned context steering the model toward a topic-naming task.
 *  Closed-shape constraints + the echo-cluster_index-verbatim
 *  instruction so post-validation rejects fabricated indices. */
const LABELLING_CONTEXT =
  'Each block below is a CLUSTER of mail thread subjects sharing a ' +
  'theme. For each cluster, invent a SHORT topic name (2-5 words, ' +
  'Title Case) and a single-sentence summary describing what the ' +
  'cluster is about. Echo the cluster_index VERBATIM from the input ' +
  '— do not invent indices. Return as a `labels` array of objects ' +
  '`{cluster_index, topic_name, summary}`.';

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Normalise a mail subject for token-bag comparison. Strips
 *  `Re: ` / `Fwd: ` prefixes, lowercases, replaces non-alphanumeric
 *  characters with spaces (preserving digits — `Q4` carries real
 *  topic-distinguishing signal), and collapses whitespace. */
export const normaliseSubject = (subject: string): string => {
  let s = (subject ?? '').toString();
  // Repeatedly strip reply / forward prefixes so `Re: Re: Fwd:` reduces.
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(REPLY_PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
};

/** Tokenise a normalised subject into a set of meaningful tokens.
 *  Drops stopwords + 1-char tokens; cap at 12 tokens per subject so
 *  a long subject can't dominate the Jaccard score. */
export const tokeniseSubject = (subject: string): Set<string> => {
  const normalised = normaliseSubject(subject);
  if (normalised === '') return new Set();
  const tokens = normalised
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .slice(0, 12);
  return new Set(tokens);
};

/** Jaccard similarity over two token sets. Returns 0 when both empty
 *  (no shared signal — don't merge). */
export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
};

/** A thread emerging from the mail scan. Each thread is the smallest
 *  clustering unit. */
export interface ThreadAtom {
  thread_id: string;
  /** Distinct mail message ids belonging to this thread (within the
   *  scan window). Folded into the eventual cluster's `members[]`. */
  member_ids: string[];
  /** Most-recent subject in the thread — drives the token bag. */
  subject: string;
  /** Token bag for similarity comparison. */
  tokens: Set<string>;
  /** Most-recent received_at across the thread's messages. */
  last_received_at: number;
}

/** Mid-clustering working type. Becomes a `ProducedCluster` post-AI. */
interface ClusterAtom {
  threads: ThreadAtom[];
  /** Union of every thread's tokens — used as the cluster's working
   *  bag for further merges. */
  tokens: Set<string>;
}

/** A fully-clustered, AI-labelled cluster ready for upsert. */
export interface ProducedCluster {
  derived_entity_id: string;
  topic_name: string;
  summary: string;
  members: string[];
  thread_ids: string[];
  theme_tokens: string[];
  thread_count: number;
}

/** Agglomerative single-link clustering on threads by token-bag
 *  Jaccard. O(n²) in worst case; bounded by the
 *  `MAX_MESSAGES_SCANNED` corpus cap (≤ ~few hundred threads in
 *  practice). Discards clusters with < `MIN_THREADS_PER_CLUSTER`. */
export const clusterThreads = (
  threads: ReadonlyArray<ThreadAtom>,
  threshold: number = JACCARD_THRESHOLD,
  minThreads: number = MIN_THREADS_PER_CLUSTER,
): ClusterAtom[] => {
  const clusters: ClusterAtom[] = threads.map((t) => ({
    threads: [t],
    tokens: new Set(t.tokens),
  }));

  // Greedy merge — for each cluster, find the highest-similarity
  // neighbour above threshold and merge. Repeat until no more merges.
  let merged = true;
  while (merged) {
    merged = false;
    let bestI = -1;
    let bestJ = -1;
    let bestScore = threshold;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = jaccard(clusters[i]!.tokens, clusters[j]!.tokens);
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
      const merged_threads = [...a.threads, ...b.threads];
      const merged_tokens = new Set<string>([...a.tokens, ...b.tokens]);
      clusters.splice(bestJ, 1);
      clusters.splice(bestI, 1, {
        threads: merged_threads,
        tokens: merged_tokens,
      });
      merged = true;
    }
  }

  return clusters.filter((c) => c.threads.length >= minThreads);
};

/** Pick the top-N most-frequent tokens across a cluster's threads.
 *  Used for both the theme signature (drives `derived_entity_id`)
 *  and for the AI prompt's per-cluster summary input. Sort by
 *  (frequency desc, token asc) for determinism across runs with
 *  identical corpus. */
export const pickThemeTokens = (
  cluster: ClusterAtom,
  n: number = THEME_TOKEN_COUNT,
): string[] => {
  const counts = new Map<string, number>();
  for (const thread of cluster.threads) {
    for (const t of thread.tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, n)
    .map(([token]) => token);
};

/** Compose the stable `derived_entity_id` for a cluster. Hashes the
 *  sorted theme tokens — same theme across runs hashes to the same
 *  id, so re-runs upsert in place rather than churning ids. */
export const deriveDerivedEntityId = (themeTokens: ReadonlyArray<string>): string => {
  const signature = [...themeTokens].sort().join('|');
  const digest = createHash('sha1').update(signature).digest('hex');
  return `topic_cluster_${digest.slice(0, ID_HASH_PREFIX_LEN)}`;
};

/** Compose the AI labelling prompt corpus. One block per cluster
 *  with its top tokens + sample subjects. Cluster index is the
 *  position in the `clusters` array — the AI must echo it verbatim. */
export const composeLabellingCorpus = (
  clusters: ReadonlyArray<ClusterAtom>,
): string => {
  const blocks = clusters.map((c, idx) => {
    const tokens = pickThemeTokens(c, 5);
    const subjectSamples = c.threads
      .slice(0, 5)
      .map((t) => t.subject)
      .filter((s) => s !== '');
    return (
      `Cluster #${idx}\n` +
      `Top tokens: ${tokens.join(', ')}\n` +
      `Thread count: ${c.threads.length}\n` +
      `Sample subjects:\n` +
      subjectSamples.map((s) => `  - ${s}`).join('\n')
    );
  });
  return blocks.join('\n--- next cluster ---\n');
};

interface AiLabel {
  cluster_index: number;
  topic_name: string;
  summary: string;
}

/** A cluster index as a model hands it back. The corpus heads each block
 *  `Cluster #0` and the context asks for the index echoed VERBATIM, so `"#0"` is as
 *  faithful an answer as `0`. ⛔ Only `0` used to pass: the first time the context
 *  reached a real model (qwen3.7-plus, 2026-10-06) every label came back `"#0"` and
 *  the whole batch failed `topic_cluster_output_invalid`. */
const clusterIndexOf = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*#?\s*(\d+)\s*$/.exec(v);
  return m ? Number(m[1]) : null;
};

/** The model's labels with numeric indices, or null when the shape is not one. */
const parseAiLabels = (v: unknown): AiLabel[] | null => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const labels = (v as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) return null;
  const out: AiLabel[] = [];
  for (const label of labels) {
    if (label === null || typeof label !== 'object' || Array.isArray(label)) return null;
    const o = label as Record<string, unknown>;
    const clusterIndex = clusterIndexOf(o.cluster_index);
    if (clusterIndex === null) return null;
    if (typeof o.topic_name !== 'string' || o.topic_name === '') return null;
    if (typeof o.summary !== 'string') return null;
    out.push({ cluster_index: clusterIndex, topic_name: o.topic_name, summary: o.summary });
  }
  return out;
};

/** Trim the AI's `topic_name` to a marketplace-friendly length. */
export const trimTopicName = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 40 ? collapsed.slice(0, 40).trim() : collapsed;
};

/** Resolve effective `ForceLayer` for the AI call from the trust
 *  store + global BYOK master. Mirrors the logic in
 *  `enrichment-producer.ts:resolveEffectiveLayer` — duplicated until
 *  a second standalone Shape B AI task lands and triggers extraction
 *  per the codebase's third-caller convention. */
export const resolveTopicClusterLayer = (
  ctx: HousekeepingContext,
  trustStore: TrustStore | undefined,
): ForceLayer => {
  if (!trustStore) return 'any';
  const trust = trustStore.read(TOPIC_CLUSTER_TOPIC, true);
  const byokAllowed = isByokAllowedForBackground(ctx.db);
  if (!byokAllowed) return 'free';
  if (trust.pool_policy === 'free_only') return 'free';
  if (trust.pool_policy === 'byok_only') return 'byok';
  return 'any';
};

// ────────────────────────────────────────────────────────────────
// Mail scan
// ────────────────────────────────────────────────────────────────

interface MailScanRow {
  record_id: string;
  thread_id: string;
  subject: string;
  received_at: number;
  /** D-167 — the parsed `hot_fields` envelope, retained as the structured
   *  source record for the fan-in PII alias seed (the `from` / `to` / … the
   *  seam reads against the scope's privacy tags). Optional only because the
   *  `groupByThread` consumer is also fed hand-built rows in tests; the live
   *  `scanRecentMail` always populates it. */
  record_data?: Record<string, unknown>;
}

/** Walk every `collection_mail_*` table for messages received within
 *  the look-back window. Returns rows newest-first across all tables,
 *  capped at `MAX_MESSAGES_SCANNED`. */
export const scanRecentMail = (
  ctx: HousekeepingContext,
  now: number,
  limit: number = MAX_MESSAGES_SCANNED,
): MailScanRow[] => {
  const earliest = now - MAIL_LOOKBACK_MS;
  const tables = listCollectionDataTables(ctx.db, 'mail');

  const all: MailScanRow[] = [];
  for (const table of tables) {
    const rows = ctx.db
      .prepare(
        `SELECT record_id, received_at, hot_fields FROM "${table}"
          WHERE received_at >= ?
          ORDER BY received_at DESC
          LIMIT ?`,
      )
      .all(earliest, limit) as Array<{
        record_id: string;
        received_at: number;
        hot_fields: string;
      }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      const threadId =
        typeof parsed.thread_id === 'string' && parsed.thread_id !== ''
          ? parsed.thread_id
          : null;
      if (threadId === null) continue;
      const subject =
        typeof parsed.subject === 'string' ? parsed.subject : '';
      all.push({
        record_id: row.record_id,
        thread_id: threadId,
        subject,
        received_at: row.received_at,
        // D-167 — retain the parsed envelope so the fan-in alias seed can read
        // this record's tagged structured fields (`from` / `to` / …).
        record_data: parsed,
      });
    }
  }

  all.sort((a, b) => b.received_at - a.received_at);
  return all.slice(0, limit);
};

/** Group scanned mail rows by `thread_id` into clustering atoms. The
 *  thread's most-recent subject drives the token bag (older subjects
 *  are usually `Re: <same>` and contribute redundant tokens). */
export const groupByThread = (rows: ReadonlyArray<MailScanRow>): ThreadAtom[] => {
  const threads = new Map<string, ThreadAtom>();
  for (const row of rows) {
    const existing = threads.get(row.thread_id);
    if (existing) {
      existing.member_ids.push(row.record_id);
      if (row.received_at > existing.last_received_at) {
        existing.last_received_at = row.received_at;
        existing.subject = row.subject;
        existing.tokens = tokeniseSubject(row.subject);
      }
    } else {
      threads.set(row.thread_id, {
        thread_id: row.thread_id,
        member_ids: [row.record_id],
        subject: row.subject,
        tokens: tokeniseSubject(row.subject),
        last_received_at: row.received_at,
      });
    }
  }
  return Array.from(threads.values());
};

/** Cap surviving clusters at `MAX_CLUSTERS`, keeping the largest by
 *  total message count. Ties broken by total thread count. */
export const capClusters = (
  clusters: ReadonlyArray<ClusterAtom>,
  cap: number = MAX_CLUSTERS,
): ClusterAtom[] => {
  if (clusters.length <= cap) return [...clusters];
  return [...clusters]
    .sort((a, b) => {
      const aMsgs = a.threads.reduce((s, t) => s + t.member_ids.length, 0);
      const bMsgs = b.threads.reduce((s, t) => s + t.member_ids.length, 0);
      if (bMsgs !== aMsgs) return bMsgs - aMsgs;
      return b.threads.length - a.threads.length;
    })
    .slice(0, cap);
};

// ────────────────────────────────────────────────────────────────
// Cluster assembly + persistence
// ────────────────────────────────────────────────────────────────

/** Build a `TopicCluster` value + derived id from a labelled cluster.
 *  Members + thread_ids deduplicated; theme tokens preserved verbatim
 *  for surface-rendering. */
export const assembleCluster = (
  cluster: ClusterAtom,
  label: AiLabel,
  themeTokens: ReadonlyArray<string>,
  now: number,
): { value: TopicCluster; derived_entity_id: string } => {
  const memberSet = new Set<string>();
  const threadIdSet = new Set<string>();
  for (const thread of cluster.threads) {
    threadIdSet.add(thread.thread_id);
    for (const id of thread.member_ids) memberSet.add(id);
  }
  const members = Array.from(memberSet).sort();
  const thread_ids = Array.from(threadIdSet).sort();
  const value: TopicCluster = {
    topic_name: trimTopicName(label.topic_name),
    summary: label.summary,
    members,
    thread_ids,
    theme_tokens: [...themeTokens],
    thread_count: cluster.threads.length,
    ai_invoked: true,
    computed_at: now,
    window_ms: MAIL_LOOKBACK_MS,
  };
  return {
    value,
    derived_entity_id: deriveDerivedEntityId(themeTokens),
  };
};

/** Sweep stale rows: list every existing topic_cluster row, deleteById
 *  any whose id wasn't refreshed this cycle. Pre-launch zero-installs
 *  semantics — the producer is the single source of truth, so orphan
 *  rows whose theme is no longer in the corpus get pruned eagerly. */
export const sweepStaleClusters = (
  ctx: HousekeepingContext,
  freshIds: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: TOPIC_CLUSTER_TOPIC,
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

/** One-shot cluster-and-label cycle. Exported for direct test access
 *  without the task wrapper. Returns `{ produced }` for caller-side
 *  assertions on cycle output.
 *
 *  D-136 P3 — switches `ctx.llm` → `ctx.llmWithMeta` so the resolved
 *  provider model id flows to `model_id` on every cluster row.
 *  `event_at` per cluster anchors on the most-recent member-message
 *  clock (audit §20.2 fix); `input_fingerprint_hash` composes via
 *  `perspective_fan_in` over the cluster's member message ids so a
 *  member-set change forces recompute on the next cycle. */
export const runTopicClusterCycle = async (
  ctx: HousekeepingContext,
): Promise<{ produced: number }> => {
  if (!ctx.llmWithMeta) {
    throw new Error(
      'topic_cluster_producer_misconfigured: ctx.llmWithMeta is required for AI labelling',
    );
  }
  // Captured post-guard (narrowed non-undefined) to backstop the D-167 fan-in
  // alias wrap below: the wrapped ctx preserves `llmWithMeta` iff the base ctx
  // had it, but TS doesn't carry that narrowing onto the new object, so the
  // `??` fallback keeps the call type-safe.
  const baseLlmWithMeta = ctx.llmWithMeta;
  const now = ctx.now();

  const rows = scanRecentMail(ctx, now);
  if (rows.length === 0) {
    sweepStaleClusters(ctx, new Set());
    return { produced: 0 };
  }

  const threads = groupByThread(rows);
  const rawClusters = clusterThreads(threads);
  if (rawClusters.length === 0) {
    sweepStaleClusters(ctx, new Set());
    return { produced: 0 };
  }
  const clusters = capClusters(rawClusters);

  const corpus = composeLabellingCorpus(clusters);
  const layer = resolveTopicClusterLayer(ctx, ctx.trustStore);

  // D-167 — non-chat AI-egress PII aliasing for a FAN-IN producer. The corpus
  // blob folds subjects across the surviving clusters' mail records, so the PII
  // in it lives across N rows, not in one structured record — the per-record
  // seam can't seed it. Seed one alias ledger from those records'
  // `MetaField.privacy`-tagged structured fields (`from` / `to` / …); the wrap
  // then content-scans the corpus on egress and restores the model output
  // before validation/upsert — so the cloud / free-pool model sees aliases
  // while the persisted cluster labels carry real values.
  //
  // Scope the seed to records the model ACTUALLY sees — the contributing rows of
  // the capped `clusters`, NOT every scanned row. A row dropped as single-thread
  // noise (`clusterThreads`) or over the `MAX_CLUSTERS` cap never reaches the
  // corpus, so its alias must not enter the restore ledger: otherwise a model
  // that emits an alias-shaped literal could restore an unrelated, dropped
  // person's real PII into a cluster label. The ledger dedupes by value, so a
  // sender repeated across a cluster's threads collapses to one alias. A no-op
  // (returns the raw ctx) until a privacy-tagged mail schema is installed —
  // byte-identical to pre-D-167.
  const recordDataById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.record_data !== undefined) recordDataById.set(row.record_id, row.record_data);
  }
  const seedRecords: Record<string, unknown>[] = [];
  for (const cluster of clusters) {
    for (const thread of cluster.threads) {
      for (const id of thread.member_ids) {
        const rd = recordDataById.get(id);
        if (rd !== undefined) seedRecords.push(rd);
      }
    }
  }
  const llmCtx = wrapHousekeepingCtxForFanIn(ctx, 'mail', seedRecords);

  const { result, model_id } = await (llmCtx.llmWithMeta ?? baseLlmWithMeta)(
    aiExtractManifest,
    {
      'llm.data': corpus,
      'llm.fields': ['labels'],
      'llm.context': LABELLING_CONTEXT,
      'llm.model_hint': 'fast',
      'llm.force_layer': layer,
    },
  );

  const labels = parseAiLabels(result);
  if (labels === null) {
    throw new Error(
      'topic_cluster_output_invalid: ai-extract returned non-conformant shape',
    );
  }

  const labelsByIndex = new Map<number, AiLabel>();
  for (const label of labels) {
    if (label.cluster_index < 0 || label.cluster_index >= clusters.length) continue;
    if (!labelsByIndex.has(label.cluster_index)) {
      labelsByIndex.set(label.cluster_index, label);
    }
  }

  const freshIds = new Set<string>();
  let produced = 0;
  for (let i = 0; i < clusters.length; i += 1) {
    const label = labelsByIndex.get(i);
    if (!label) continue;
    const cluster = clusters[i]!;
    const themeTokens = pickThemeTokens(cluster);
    const { value, derived_entity_id } = assembleCluster(
      cluster,
      label,
      themeTokens,
      now,
    );

    // D-136 P3 — bistemporal stamping. `event_at` anchors on the
    // freshest member message in the cluster (real-world clock, not
    // producer compute time). `input_fingerprint_hash` composes via
    // `perspective_fan_in` over the cluster's contributing message
    // ids — a member-set change flips the hash and forces recompute.
    let lastReceivedAt = 0;
    for (const thread of cluster.threads) {
      if (thread.last_received_at > lastReceivedAt) {
        lastReceivedAt = thread.last_received_at;
      }
    }
    const memberIdsSorted = [...value.members].sort();
    const inputFingerprintHash = computeInputFingerprintHashLocal(
      memberIdsSorted,
      now,
    );

    ctx.enrichmentStore.upsert({
      topic: TOPIC_CLUSTER_TOPIC,
      derived_entity_id,
      value,
      authored_by: TOPIC_CLUSTER_AUTHORED_BY,
      event_at: lastReceivedAt > 0 ? lastReceivedAt : now,
      ingredient_slug: 'ai-extract',
      model_id,
      producer_version_hash: baseProducerVersionHash,
      input_fingerprint_hash: inputFingerprintHash,
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

export const topicClusterTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.topic_cluster',
    description:
      'Cluster recent mail by topic theme and AI-label each cluster — one row per topic.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.topic_cluster,
      isAiSurface: true,
    }),
  },
  topic: TOPIC_CLUSTER_TOPIC,
  is_ai_surface: true,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    await runTopicClusterCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. */
export const topicClusterTokenEstimate = (): number => TOKEN_ESTIMATE_PER_CYCLE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. Mirrors the shape the harness validates for Shape A
 *  producers. */
export const topicClusterScopeReadDeclaration = [
  {
    collection: 'data.mail',
    sample_field_paths: ['subject', 'thread_id', 'received_at', 'record_id'],
  },
] as const;
