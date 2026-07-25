/** D-145 § A.7.10 (Amended 2026-05-26) — Content-addressed LLM result
 *  cache.
 *
 *  Substrate-only: stores pointers to enrichment rows whose `value`
 *  came from a specific LLM input. AI producers can opt into the cache
 *  via `compose_input` on `runAIProducer`; identical inputs across
 *  different source records (forwarded mail chains, automated email
 *  templates, repeated signature blocks) hit the cache and skip the
 *  LLM call entirely.
 *
 *  Design (driven by the spec's invariants):
 *
 *    - **`input_hash` is the sole key** (no `producer_version_hash`,
 *      no `source_path`). Version bumps change the prompt → change the
 *      input bytes → change the hash → yield a new cache entry
 *      naturally.
 *    - **Pointer-only** — the result already lives in some
 *      `data_enrichment` row at `result_path`; the cache just records
 *      the pointer. ~100 bytes/row vs ~1 KB+ with blobs. No second
 *      lifecycle to manage.
 *    - **No `model_id`** — the accepted result's model_id lives on the
 *      `data_enrichment` row; only redo paths care, and they bypass
 *      the cache.
 *    - **Per-pair only** (server-local, never syncs cloud).
 *
 *  Hard-ordered AFTER § A.7.9 (universal cleanup) — without that, the
 *  cache accumulates dangling refs without bound.
 *
 *  Spec: D-145 § A.7.10. */

import { createHash } from 'node:crypto';

import { canonicalJSONStringify } from '@recued/crypto';
import {
  ENRICHMENT_REGISTRY,
  type EnrichmentScope,
  type EnrichmentTopic,
} from '@recued/contracts';

import type Database from 'better-sqlite3';

import type { EnrichmentStore } from '../storage/enrichment-store.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface LlmResultCacheEntry {
  input_hash: string;
  result_hash: string;
  result_path: string;
  computed_at: number;
}

export interface LlmResultCacheRow extends LlmResultCacheEntry {
  hit_count: number;
}

/** D-145 PA11 — per-topic + roll-up cache stats. Drives the Settings →
 *  Housekeeping "LLM result cache" summary card. Topic strings derive
 *  from each row's `result_path` via `parseEnrichmentPath`; rows whose
 *  path no longer parses are bucketed under `_malformed` so the GC
 *  surface stays observable. */
export interface LlmResultCacheTopicStats {
  topic: string;
  entry_count: number;
  hit_count: number;
}

export interface LlmResultCacheStats {
  total_entries: number;
  total_hits: number;
  per_topic: ReadonlyArray<LlmResultCacheTopicStats>;
}

export interface LlmResultCacheStore {
  /** Returns the cache entry for `input_hash` or `null` when absent. */
  lookup(input_hash: string): LlmResultCacheEntry | null;
  /** First-writer-wins. Concurrent producers reaching the same input
   *  don't fight — the first insert lands, subsequent ones are
   *  silently ignored. */
  insertOrIgnore(entry: LlmResultCacheEntry): void;
  /** Bump `hit_count` on a successful cache hit. Best-effort: the
   *  store doesn't throw on a missing row (the entry might have been
   *  GC'd between lookup + increment). */
  incrementHitCount(input_hash: string): void;
  /** Drop a single entry. Returns true when a row was removed. */
  delete(input_hash: string): boolean;
  /** GC pass — delete cache rows whose `result_path` no longer
   *  resolves. Idempotent; safe to run repeatedly. The universal
   *  cleanup (§ A.7.9) handles most dangling-ref cases via lazy
   *  delete on read, but a periodic sweep catches the residue. */
  gcDanglingRefs(args: {
    resolvePathExists: (path: string) => boolean;
  }): { rows_deleted: number };
  /** Read the full row including `hit_count`. Telemetry / Settings
   *  surface only — the hot read path uses `lookup` (no hit_count). */
  getRow(input_hash: string): LlmResultCacheRow | null;
  /** D-145 PA11 — aggregate stats for the Settings → Housekeeping
   *  "LLM result cache" summary card. Per-topic buckets derive from
   *  each row's `result_path` via `parseEnrichmentPath`; the result
   *  array is sorted by `entry_count` desc so the card lists the
   *  highest-volume topics first. Rows with unparseable paths bucket
   *  under `_malformed` (surfaces residue the lazy-delete invariant +
   *  scheduled GC haven't reached yet). */
  stats(): LlmResultCacheStats;
  /** D-145 PA11 — drop every row. Drives the "Clear cache" button on
   *  the Settings card. Returns the count of rows removed so the
   *  caller can surface a confirm-success message + audit-log entry.
   *  Idempotent: safe to call against an empty cache. */
  clearAll(): { rows_deleted: number };
}

// ────────────────────────────────────────────────────────────────
// Path composition + parsing
// ────────────────────────────────────────────────────────────────

/** Closed-list shape discriminator for an enrichment path. Shape A
 *  (per_record) keys on `(scope, target_id)`; shape B (derived_entity)
 *  keys on `derived_entity_id`. */
export type ParsedEnrichmentPath =
  | {
      kind: 'shape_a';
      topic: EnrichmentTopic;
      scope: EnrichmentScope;
      target_id: string;
    }
  | {
      kind: 'shape_b';
      topic: EnrichmentTopic;
      derived_entity_id: string;
    };

/** Compose the canonical cache pointer for an enrichment row. Shape A:
 *  `data.enrichment.<topic>.<scope>.<target_id>` — scope may itself
 *  contain dots (`connection.api.<vendor>.<entity>`), so the parser
 *  re-uses the registry to round-trip. Shape B:
 *  `data.enrichment.<topic>.<derived_entity_id>`. */
export const composeEnrichmentPath = (
  args:
    | { topic: EnrichmentTopic; scope: EnrichmentScope; target_id: string }
    | { topic: EnrichmentTopic; derived_entity_id: string },
): string => {
  if ('derived_entity_id' in args) {
    return `data.enrichment.${args.topic}.${args.derived_entity_id}`;
  }
  return `data.enrichment.${args.topic}.${args.scope}.${args.target_id}`;
};

/** Parse a path produced by `composeEnrichmentPath`. Returns `null` on
 *  malformed input — callers treat this as "cache entry corrupt / from
 *  another schema version" and lazy-delete. Splits scope vs target_id
 *  for Shape A by trying the topic's registered `valid_scopes` longest-
 *  first; that's the only robust split because (a) the platform-
 *  reference scopes carry multiple dots (`connection.api.<vendor>.
 *  <entity>`) and (b) target_ids routinely carry dots themselves
 *  (email addresses, file paths). */
export const parseEnrichmentPath = (path: string): ParsedEnrichmentPath | null => {
  if (!path.startsWith('data.enrichment.')) return null;
  const rest = path.slice('data.enrichment.'.length);
  // Topic names are dot-free (registry-enforced), so the first dot
  // marks the topic boundary unambiguously.
  const firstDot = rest.indexOf('.');
  if (firstDot < 0) return null;
  const topic = rest.slice(0, firstDot) as EnrichmentTopic;
  const def = (ENRICHMENT_REGISTRY as Record<
    string,
    {
      shape: 'per_record' | 'derived_entity';
      valid_scopes?: readonly string[];
    }
  >)[topic];
  if (!def) return null;
  const tail = rest.slice(firstDot + 1);
  if (def.shape === 'derived_entity') {
    if (tail.length === 0) return null;
    return { kind: 'shape_b', topic, derived_entity_id: tail };
  }
  // Shape A — pick the longest valid_scope that prefixes `tail.` so a
  // four-segment platform-reference scope is preferred over the
  // single-segment scopes when both match.
  const scopes = (def.valid_scopes ?? []) as readonly string[];
  const orderedScopes = [...scopes].sort((a, b) => b.length - a.length);
  for (const scope of orderedScopes) {
    const prefix = `${scope}.`;
    if (!tail.startsWith(prefix)) continue;
    const target_id = tail.slice(prefix.length);
    if (target_id.length === 0) return null;
    return { kind: 'shape_a', topic, scope: scope as EnrichmentScope, target_id };
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// Hashing
// ────────────────────────────────────────────────────────────────

/** Hash the bytes a producer would send to the LLM. The producer's
 *  `compose_input` returns whatever object it actually passes to
 *  `ctx.llmWithMeta`; the cache hashes its canonical-JSON form so
 *  byte-stable across runs of the same TypeScript representation.
 *  Producers MUST keep the composition target-agnostic (system prompt
 *  + content bytes, no per-target metadata) — that's the producer-
 *  side discipline the spec calls out. */
export const hashLlmInput = (input: unknown): string => {
  return createHash('sha256').update(canonicalJSONStringify(input)).digest('hex');
};

/** Hash the persisted enrichment value for the cache's drift check.
 *  Same canonical JSON discipline as `hashLlmInput` so both sides of
 *  the (input → result) map use the same encoding. */
export const hashEnrichmentResult = (result: unknown): string => {
  return createHash('sha256').update(canonicalJSONStringify(result)).digest('hex');
};

/** Resolve an enrichment path to its current `value`. Returns `null`
 *  when the path is malformed, the topic is unknown, or no row exists
 *  at the path (the typical post-§ A.7.9 dangling-ref case). */
export const readEnrichmentValueFromPath = (
  enrichmentStore: EnrichmentStore,
  path: string,
): unknown | null => {
  const parsed = parseEnrichmentPath(path);
  if (!parsed) return null;
  if (parsed.kind === 'shape_b') {
    const row = enrichmentStore.getDerived(parsed.topic, parsed.derived_entity_id);
    return row?.value ?? null;
  }
  // Shape A — the cache doesn't carry authored_by, so look up any
  // matching row at (topic, scope, target_id). The hash check on the
  // returned value is the load-bearing identity guard.
  const rows = enrichmentStore.list({
    topic: parsed.topic,
    scope: parsed.scope,
    target_id: parsed.target_id,
    fresh_only: true,
  });
  if (rows.length === 0) return null;
  return rows[0]!.value;
};

// ────────────────────────────────────────────────────────────────
// Store factory
// ────────────────────────────────────────────────────────────────

interface PersistedCacheRow {
  input_hash: string;
  result_hash: string;
  result_path: string;
  computed_at: number;
  hit_count: number;
}

export const createLlmResultCacheStore = (
  db: Database.Database,
): LlmResultCacheStore => {
  const selectStmt = db.prepare(
    `SELECT input_hash, result_hash, result_path, computed_at, hit_count
       FROM llm_result_cache WHERE input_hash = ?`,
  );
  const insertOrIgnoreStmt = db.prepare(
    `INSERT OR IGNORE INTO llm_result_cache
       (input_hash, result_hash, result_path, computed_at, hit_count)
     VALUES (?, ?, ?, ?, 0)`,
  );
  const incrementStmt = db.prepare(
    `UPDATE llm_result_cache
       SET hit_count = hit_count + 1
     WHERE input_hash = ?`,
  );
  const deleteStmt = db.prepare(
    `DELETE FROM llm_result_cache WHERE input_hash = ?`,
  );
  const listPathsStmt = db.prepare(
    `SELECT input_hash, result_path FROM llm_result_cache`,
  );
  const statsStmt = db.prepare(
    `SELECT result_path, hit_count FROM llm_result_cache`,
  );
  const clearAllStmt = db.prepare(`DELETE FROM llm_result_cache`);

  return {
    lookup(input_hash) {
      const row = selectStmt.get(input_hash) as PersistedCacheRow | undefined;
      if (!row) return null;
      return {
        input_hash: row.input_hash,
        result_hash: row.result_hash,
        result_path: row.result_path,
        computed_at: row.computed_at,
      };
    },

    getRow(input_hash) {
      const row = selectStmt.get(input_hash) as PersistedCacheRow | undefined;
      if (!row) return null;
      return {
        input_hash: row.input_hash,
        result_hash: row.result_hash,
        result_path: row.result_path,
        computed_at: row.computed_at,
        hit_count: row.hit_count,
      };
    },

    insertOrIgnore(entry) {
      insertOrIgnoreStmt.run(
        entry.input_hash,
        entry.result_hash,
        entry.result_path,
        entry.computed_at,
      );
    },

    incrementHitCount(input_hash) {
      incrementStmt.run(input_hash);
    },

    delete(input_hash) {
      const info = deleteStmt.run(input_hash);
      return info.changes > 0;
    },

    gcDanglingRefs({ resolvePathExists }) {
      const rows = listPathsStmt.all() as Array<{ input_hash: string; result_path: string }>;
      let rows_deleted = 0;
      for (const row of rows) {
        if (!resolvePathExists(row.result_path)) {
          const info = deleteStmt.run(row.input_hash);
          if (info.changes > 0) rows_deleted += 1;
        }
      }
      return { rows_deleted };
    },

    stats() {
      const rows = statsStmt.all() as Array<{ result_path: string; hit_count: number }>;
      const buckets = new Map<string, { entry_count: number; hit_count: number }>();
      let total_hits = 0;
      for (const row of rows) {
        const parsed = parseEnrichmentPath(row.result_path);
        const topic = parsed?.topic ?? '_malformed';
        const bucket = buckets.get(topic) ?? { entry_count: 0, hit_count: 0 };
        bucket.entry_count += 1;
        bucket.hit_count += row.hit_count;
        buckets.set(topic, bucket);
        total_hits += row.hit_count;
      }
      const per_topic: LlmResultCacheTopicStats[] = [];
      for (const [topic, agg] of buckets) {
        per_topic.push({ topic, entry_count: agg.entry_count, hit_count: agg.hit_count });
      }
      // Highest-volume topics first; ties break on hit_count desc then
      // topic asc so the order is deterministic across snapshots.
      per_topic.sort((a, b) => {
        if (a.entry_count !== b.entry_count) return b.entry_count - a.entry_count;
        if (a.hit_count !== b.hit_count) return b.hit_count - a.hit_count;
        return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;
      });
      return { total_entries: rows.length, total_hits, per_topic };
    },

    clearAll() {
      const info = clearAllStmt.run();
      return { rows_deleted: info.changes };
    },
  };
};
