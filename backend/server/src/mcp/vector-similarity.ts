/** D-136 §A.13.4 P7.D — `mcp.vector.similarity_search` handler.
 *
 *  Cohort-enforced cosine search over the
 *  `data_enrichment_vector_index` sidecar. Two topics declare the
 *  sidecar today: `embedding` (Shape A, mail-scoped) and
 *  `semantic_cluster` (Shape B, derived). Other topics with
 *  `sidecar !== 'vector_index'` reject at the rpc boundary.
 *
 *  Cohort enforcement (`model_id`): mandatory in spirit. Cross-model
 *  vectors aren't comparable. P7.D ships the parameter optional but
 *  the handler scans only rows whose `model_id` matches when set;
 *  when omitted the scan defaults to a single-cohort heuristic
 *  (picks the dominant cohort for the topic + scope) so agents that
 *  forget the parameter get correct (single-model) results in single-
 *  model deployments. The spec promises a future hardening pass
 *  tightens to mandatory-with-explicit-default once mixed-model
 *  warehouses become common.
 *
 *  Dimension safety: every result's value is checked against the
 *  query vector's length. Mismatches are silently dropped — the
 *  cohort filter should already prevent this, but rows with corrupt
 *  / cross-model vectors are filtered defensively rather than
 *  erroring the whole call.
 *
 *  Read-cost-zero invariant (§A.13.6): handler signature carries no
 *  LLM dep; the SQL scan + math is pure. Test ratchet at P7.D close
 *  enforces structurally. */

import {
  RpcError,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  VECTOR_SEARCH_DEFAULT_THRESHOLD,
  clampVectorSearchLimit,
  getEnrichmentDefinition,
  isEnrichmentTopic,
  isGrantedReadAdmissible,
  type EnrichmentTopic,
  type MCPEnrichmentReadResult,
  type VectorSimilaritySearchRpcInput,
  type VectorSimilaritySearchRpcOutput,
} from '@recued/contracts';
import type Database from 'better-sqlite3';
import type { EnrichmentRecord, EnrichmentStore } from '../storage/enrichment-store.js';
import { assembleBundle, _testing as readInternals } from './enrichment-read.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

/** D-187 slice-3 read gate — the VERB-OP that gates the `vectorSimilaritySearch`
 *  native tool ("may this contract use vector search at all"). Composed with the
 *  topic's read-grant via `isGrantedReadAdmissible`: a topic grant does NOT imply the
 *  verb. */
const VECTOR_SEARCH_VERB_OP = 'core.data.enrichment.vector-search';

/** Required deps. The store walks the join via `db` directly so the
 *  cohort + scope filters can compose into one prepared statement
 *  without re-doing them in JS. D-187 threads the bound door contract's
 *  per-dispatch read-grant checker (`readGrantChecker`) so the read reject keys on
 *  the contract's unified `enrichment.<topic>` grant (the former scope-fence +
 *  `mcp_exposed` visibility, folded). */
export interface VectorSimilarityDeps {
  enrichmentStore: EnrichmentStore;
  db: Database.Database;
  /** Per-server cap on `limit` from
   *  `housekeeping_config.vector_search_max_results`. Optional; falls
   *  back to the contract's `VECTOR_SEARCH_DEFAULT_LIMIT` when
   *  unwired. */
  vectorSearchMaxResults?: number;
  readGrantChecker?: ReadGrantChecker;
}

/** Pure cosine math. Inlined here so the MCP handler doesn't reach
 *  into `housekeeping/producers/semantic_cluster.ts` for utilities
 *  (cross-layer dep would couple the MCP surface to a producer).
 *  Returns 0 for degenerate (all-zeros) vectors. */
const cosineSimilarity = (
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

/** Decode the Float32-packed Buffer the vector-index sidecar stores.
 *  Producers write via `Float32Array.from(...).buffer`; this is the
 *  symmetric reader. Rejects buffers whose byte length isn't a
 *  multiple of 4 (corrupt / not-Float32). */
const decodeVector = (buf: Buffer): number[] | null => {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / 4,
  );
  return Array.from(f32);
};

/** Validate the input. Throws `RpcError(bad_request)` so the MCP
 *  transport layer surfaces a clear error. Mirrors the read handler's
 *  validation discipline. D-187 AMENDMENT — `checker` is the bound door contract's
 *  per-dispatch read-grant checker so the read reject keys on the contract's unified
 *  `enrichment.<topic>` grant (the former scope-fence + `mcp_exposed` visibility). */
const validateInput = (
  input: VectorSimilaritySearchRpcInput,
  checker: ReadGrantChecker,
): void => {
  if (!Array.isArray(input.query_vector) || input.query_vector.length === 0) {
    throw new RpcError(
      'bad_request',
      'mcp.vector.similarity_search: query_vector must be a non-empty number array',
      400,
    );
  }
  for (let i = 0; i < input.query_vector.length; i += 1) {
    if (typeof input.query_vector[i] !== 'number'
        || !Number.isFinite(input.query_vector[i]!)) {
      throw new RpcError(
        'bad_request',
        `mcp.vector.similarity_search: query_vector[${i}] is not a finite number`,
        400,
      );
    }
  }
  if (typeof input.topic !== 'string' || input.topic.length === 0) {
    throw new RpcError(
      'bad_request',
      'mcp.vector.similarity_search: topic is required',
      400,
    );
  }
  if (!isEnrichmentTopic(input.topic)) {
    throw new RpcError(
      'bad_request',
      `mcp.vector.similarity_search: unknown topic '${input.topic}'`,
      400,
    );
  }
  // D-187 AMENDMENT — reject vector search on a topic the bound contract is not
  // read-granted (the unified `enrichment.<topic>` entry — the former scope-fence AND
  // `mcp_exposed` visibility, folded). Same rejection shape as `enrichment.read` — both
  // read surfaces honour the one grant identically. Settings → MCP grant toggles take
  // effect without restart.
  // D-187 slice 3 — the gate is `verb-op grant ∧ topic grant`: a contract not granted
  // the `core.data.enrichment.vector-search` verb-op is rejected even for a topic it
  // would otherwise be granted (a topic grant does not imply the verb).
  if (
    !isGrantedReadAdmissible(
      checker.isVerbOpGranted(VECTOR_SEARCH_VERB_OP),
      checker.isTopicReadGranted(input.topic as EnrichmentTopic),
    )
  ) {
    throw new RpcError(
      'bad_request',
      `mcp.vector.similarity_search: topic '${input.topic}' is not read-granted to this contract (read rejected)`,
      400,
    );
  }
  const def = getEnrichmentDefinition(input.topic);
  if (def.sidecar !== 'vector_index') {
    throw new RpcError(
      'bad_request',
      `mcp.vector.similarity_search: topic '${input.topic}' has no vector_index sidecar`,
      400,
    );
  }
  if (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit <= 0) {
    throw new RpcError(
      'bad_request',
      'mcp.vector.similarity_search: limit must be a positive finite number',
      400,
    );
  }
  if (input.similarity_threshold !== undefined) {
    const t = input.similarity_threshold;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < -1 || t > 1) {
      throw new RpcError(
        'bad_request',
        'mcp.vector.similarity_search: similarity_threshold must be in [-1, 1]',
        400,
      );
    }
  }
};

/** Row shape returned by the SQL join — the storage row plus the
 *  raw vector blob. */
interface ScannedRow {
  enrichment_id: string;
  vector: Buffer;
  // EnrichmentRecord-shaped fields needed for filtering + bundle
  // assembly. Pulled directly off the join so we don't round-trip
  // through `getById` for each candidate.
  topic: string;
  scope: string | null;
  target_id: string | null;
  authored_by: string;
  model_id: string | null;
}

/** SQL prepared lazily on first call, cached on the `Database` handle
 *  via a Map keyed on the (scope_filter ?? '__none__', model_id ??
 *  '__any__') tuple so common queries don't re-prepare per call.
 *
 *  The join filters substrate-private rows by excluding
 *  `authored_by LIKE 'system.user_correction%'` — pinned correction
 *  rows are invisible to MCP. */
const STMT_CACHE = new WeakMap<Database.Database, Map<string, Database.Statement>>();
const getScanStmt = (
  db: Database.Database,
  scopeFilter: string | undefined,
  modelId: string | undefined,
): Database.Statement => {
  let cache = STMT_CACHE.get(db);
  if (!cache) {
    cache = new Map();
    STMT_CACHE.set(db, cache);
  }
  const cacheKey = `${scopeFilter ?? '__none__'}::${modelId ?? '__any__'}`;
  let stmt = cache.get(cacheKey);
  if (stmt) return stmt;
  const where: string[] = ['e.topic = ?', `e.authored_by NOT LIKE ?`];
  if (scopeFilter !== undefined) where.push('e.scope = ?');
  if (modelId !== undefined) where.push('e.model_id = ?');
  const sql = `
    SELECT v.enrichment_id AS enrichment_id,
           v.vector       AS vector,
           e.topic        AS topic,
           e.scope        AS scope,
           e.target_id    AS target_id,
           e.authored_by  AS authored_by,
           e.model_id     AS model_id
      FROM data_enrichment_vector_index v
      JOIN data_enrichment e ON e._id = v.enrichment_id
     WHERE ${where.join(' AND ')}
  `;
  stmt = db.prepare(sql);
  cache.set(cacheKey, stmt);
  return stmt;
};

/** Pick the dominant model_id cohort when caller didn't pass one.
 *  Counts rows per `model_id` for the topic (+ optional scope_filter)
 *  and returns the most common. Used as a safety default so single-
 *  model deployments produce correct results even when agents forget
 *  to scope to a model.
 *
 *  Returns null when the topic has no rows (caller treats as
 *  empty-result) or when every row has NULL model_id (legacy path —
 *  scan everything; cross-model bleeding is the agent's problem). */
const pickDominantCohort = (
  db: Database.Database,
  topic: string,
  scopeFilter: string | undefined,
): string | null => {
  const where: string[] = ['topic = ?', 'model_id IS NOT NULL'];
  const args: unknown[] = [topic];
  if (scopeFilter !== undefined) {
    where.push('scope = ?');
    args.push(scopeFilter);
  }
  const sql = `
    SELECT model_id, COUNT(*) AS n
      FROM data_enrichment
     WHERE ${where.join(' AND ')}
     GROUP BY model_id
     ORDER BY n DESC
     LIMIT 1
  `;
  const row = db.prepare(sql).get(...args) as { model_id: string; n: number } | undefined;
  return row?.model_id ?? null;
};

/** P7.D entry point. Validates input, picks the cohort, runs the
 *  cosine scan + threshold filter, sorts DESC by similarity, slices
 *  to `limit`, attaches the bistemporal-metadata bundle.
 *
 *  Read-cost-zero: the entire path is SQL scan + JS math. */
export const handleVectorSimilaritySearch = (
  deps: VectorSimilarityDeps,
  input: VectorSimilaritySearchRpcInput,
): VectorSimilaritySearchRpcOutput => {
  validateInput(input, deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER);
  const limit = clampVectorSearchLimit(input.limit, deps.vectorSearchMaxResults);
  const threshold = input.similarity_threshold ?? VECTOR_SEARCH_DEFAULT_THRESHOLD;

  // Cohort resolution: caller-supplied wins; otherwise pick the
  // dominant model for the topic so single-model deployments don't
  // need to know to thread it.
  const cohortModelId = input.model_id
    ?? pickDominantCohort(deps.db, input.topic, input.scope_filter);

  const stmt = getScanStmt(
    deps.db,
    input.scope_filter,
    cohortModelId ?? undefined,
  );
  const stmtArgs: unknown[] = [input.topic, `${ENRICHMENT_PINNED_AUTHOR_PREFIX}%`];
  if (input.scope_filter !== undefined) stmtArgs.push(input.scope_filter);
  if (cohortModelId !== null && cohortModelId !== undefined) stmtArgs.push(cohortModelId);

  const rows = stmt.all(...stmtArgs) as ScannedRow[];
  const queryDim = input.query_vector.length;
  let candidatesExamined = 0;

  const scored: Array<{
    row: ScannedRow;
    similarity: number;
  }> = [];

  for (const row of rows) {
    const v = decodeVector(row.vector);
    if (v === null || v.length !== queryDim) {
      // Malformed vector or dimension mismatch — skip silently. The
      // cohort filter should normally prevent this, but defensive
      // dim-check guards against a writer that bypassed the cohort
      // (e.g. a future model upgrade that re-stamps model_id but
      // leaves stale vectors).
      continue;
    }
    candidatesExamined += 1;
    const similarity = cosineSimilarity(v, input.query_vector);
    if (similarity < threshold) continue;
    scored.push({ row, similarity });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, limit);

  // Drift severity is per-topic — every result shares the input
  // topic, so resolve once and reuse across all bundle assemblies.
  // Saves N store calls relative to per-row lookup.
  const driftSeverity = readInternals.lookupDriftSeverity(
    deps.enrichmentStore,
    input.topic as EnrichmentTopic,
  );

  // Hydrate each result through the full storage row so the bistemporal
  // bundle composes with confidence + drift severity + lifecycle hints.
  // Each row is `getById` — N round-trips for the result set is fine
  // (limit defaults to 50, capped at 1000).
  const results: VectorSimilaritySearchRpcOutput['results'] = top.flatMap(
    ({ row, similarity }) => {
      const fullRow: EnrichmentRecord | null = deps.enrichmentStore.getById(
        row.enrichment_id,
      );
      if (fullRow === null) return [];
      const metadata: MCPEnrichmentReadResult = assembleBundle(fullRow, driftSeverity);
      // For shape-A rows the target_id is the row's target. For shape-B
      // rows, the canonical id is `derived_entity_id` (which equals
      // `_id` for non-supersede topics; diverges under historical
      // supersede chains so the logical id surfaces, not the per-row
      // UUID).
      const target_id = fullRow.target_id ?? fullRow.derived_entity_id ?? fullRow._id;
      return [{
        enrichment_row_id: fullRow._id,
        target_id,
        similarity,
        metadata,
      }];
    },
  );

  return { results, candidates_examined: candidatesExamined };
};

/** Test-only export — surfaces internal helpers so unit tests can
 *  exercise the cohort heuristic + math without driving the full
 *  rpc. */
export const _testing = {
  cosineSimilarity,
  decodeVector,
  pickDominantCohort,
  /** Resolves the rpc-level topic check for vector-index sidecar. */
  isVectorIndexTopic: (topic: string): boolean => {
    if (!isEnrichmentTopic(topic)) return false;
    return getEnrichmentDefinition(topic as EnrichmentTopic).sidecar === 'vector_index';
  },
};
