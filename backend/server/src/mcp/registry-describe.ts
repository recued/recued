/** D-136 §A.13.1 P7.D + §A.13.5 P7.E + §A.14.4 P7.F —
 *  `housekeeping.registry.describe` handler.
 *
 *  MCP introspection tool. Agents call once at session-start to learn
 *  what topics the warehouse exposes + how fresh the data is. Without
 *  this, agents fly blind against a schema they can't probe.
 *
 *  P7.D scope:
 *    - Walk every topic in `ENRICHMENT_REGISTRY` and emit one
 *      `RegistryDescribeTopicEntry` per topic.
 *    - Per-entry coverage stats are computed at rpc-call time (no
 *      caching) — `row_count` from `EnrichmentStore.countForTopic`,
 *      `latest_event_at` from `getLatestEventAtForTopic`,
 *      `producer_last_run_at` + failure-rate from the housekeeping
 *      state row keyed off the producer's task id.
 *    - `total_rows_visible` is the sum of `EnrichmentStore.count()`
 *      minus rows authored by `system.user_correction.*` (P7.A pinned
 *      author prefix) — substrate-private rows always invisible to MCP.
 *
 *  P7.E scope (§A.13.5):
 *    - Topics declared `mcp_exposed: 'private'` are filtered out of the
 *      response array entirely. Agents never see them — they don't even
 *      know the topic exists. The substrate-private pinned-row filter on
 *      `total_rows_visible` is unchanged; this layers on top.
 *    - Entries that DO surface carry `mcp_exposed: 'public'` for
 *      contract completeness.
 *
 *  P7.F scope (§A.14.4):
 *    - Each surviving entry carries a derived
 *      `coverage_quality: 'high' | 'medium' | 'low' | 'novel_query_likely_uncovered'`
 *      + a human-readable `coverage_quality_reasoning` string.
 *    - Derivation is OR-of-degraders against the spec table: any one
 *      'low' signal → 'low'; else any one 'medium' signal → 'medium';
 *      else 'high'. `'novel_query_likely_uncovered'` short-circuits when
 *      row_count is 0 (or housekeeping producer never ran with rows
 *      present — atypical state).
 *    - Threshold per topic via `resolveCoverageQualityThreshold`;
 *      cadence-based age check via `cadenceToMs(def.recompute_cadence)`.
 *
 *  Read-cost-zero invariant (§A.13.6): this handler never invokes
 *  `ctx.llm` or any LLM ingredient. The handler signature carries no
 *  LLM dep; the test ratchet at P7.D close enforces structurally. */

import {
  ENRICHMENT_REGISTRY,
  getEnrichmentDefinition,
  ENRICHMENT_PINNED_AUTHOR_PREFIX,
  isGrantedReadAdmissible,
  resolveCoverageQualityThreshold,
  cadenceToMs,
  type CoverageQuality,
  type EnrichmentTopic,
  type EnrichmentDefinition,
  type RegistryDescribeRpcOutput,
  type RegistryDescribeTopicEntry,
} from '@recued/contracts';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

/** D-187 slice-3 read gate — the VERB-OP that gates the `registryDescribe` native
 *  tool ("may this contract use registryDescribe at all"). Composed with each topic's
 *  read-grant via `isGrantedReadAdmissible`: a topic grant does NOT imply the verb.
 *  Reused from {@link ../../packages/contracts kernel-op-registry} as a string constant
 *  (the handler needs only the id, not the registry entry). */
const REGISTRY_DESCRIBE_VERB_OP = 'core.data.enrichment.describe';
import type Database from 'better-sqlite3';
import { prefixUpperBound } from '../storage/prefix-range.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { HousekeepingStateStore } from '../housekeeping/state-store.js';

/** Everything the handler reads from. All optional — missing stores
 *  degrade gracefully (coverage stats fall back to zero / null without
 *  error). Production wiring passes the full set; tests pass only what
 *  they exercise. */
export interface RegistryDescribeDeps {
  /** Required for `coverage.row_count` + `total_rows_visible` +
   *  `latest_event_at`. Without it, every row count surfaces as 0. */
  enrichmentStore?: EnrichmentStore;
  /** Optional — when wired, the handler reads the producer task's
   *  `last_run_at` + failure heuristic for each topic. Missing →
   *  `producer_last_run_at: null` + `producer_failure_rate_24h: 0`. */
  housekeepingStateStore?: HousekeepingStateStore;
  /** Optional — used for the privacy filter on `total_rows_visible`
   *  (count rows authored by `system.user_correction.*` and subtract).
   *  Without `db`, the handler skips the subtraction (over-reports
   *  by at most the count of pinned rows; never under-reports).  */
  db?: Database.Database;
  /** D-187 AMENDMENT — the calling door's bound contract's per-dispatch read-grant
   *  checker, resolved ONCE at the dispatch boundary. The agent catalog lists exactly
   *  the topics the contract is read-granted (`isTopicReadGranted` folds the former
   *  per-topic scope-fence AND the `mcp_exposed` visibility into one grant lookup);
   *  each entry's `mcp_exposed` field reflects that grant. Optional so unit tests pass
   *  minimal deps + the Settings-UI proxy passes the OWNER contract's checker; absent ⇒
   *  {@link AUTHOR_DEFAULT_READ_GRANT_CHECKER} (every topic at its registry author
   *  default). */
  readGrantChecker?: ReadGrantChecker;
  /** P7.G — when set, the handler skips the not-read-granted filter on the response
   *  array. The Settings UI capstone needs to see EVERY topic (granted + not) so the
   *  user can toggle the grant; production MCP-channel callers leave this absent (or
   *  pass `false`) so un-granted topics stay invisible to agents. The per-topic
   *  `mcp_exposed` field in each entry continues to reflect the effective grant
   *  regardless. */
  includePrivateTopics?: boolean;
  /** M-ENRICH (internal planning notes) — the set of enrichment topics
   *  that have a registered producer. Today this is every
   *  `listHousekeepingTasks()` entry carrying a `.topic`
   *  (`buildEnrichmentProducerTask` per-record producers + the Shape-B /
   *  connection-scope / drift standalone tasks); when a reactive-producer
   *  registry lands (the dead `producer_kind: 'reactive'` lane), union its
   *  topics in here too.
   *
   *  When provided, the agent-facing catalog drops any topic that has BOTH
   *  no registered producer AND zero rows — so an external agent is never
   *  told it can read/compute an enrichment that nothing produces and that
   *  holds no data (the M-ENRICH overclaim). A topic with a producer (even
   *  at zero rows — it surfaces as `novel_query_likely_uncovered` so the
   *  agent falls through to raw) OR with existing rows (readable even if
   *  its producer was retired) is always kept.
   *
   *  OPT-IN — absent (handler unit tests, the Settings-UI proxy) ⇒ no
   *  producer/data filter; every registry topic surfaces (pre-M-ENRICH
   *  behaviour). The MCP `recued_registryDescribe` wiring computes it from
   *  the live registry at call time; the Settings-UI proxy
   *  (`handleHousekeepingRegistryDescribe`) leaves it unset (and sets
   *  `includePrivateTopics`) so the human configuring the warehouse still
   *  sees every topic, dead or alive. */
  registeredProducerTopics?: ReadonlySet<EnrichmentTopic>;
}

/** M-ENRICH — collect the set of topics backed by a registered producer
 *  from a housekeeping task roster (`listHousekeepingTasks()`). Every
 *  enrichment task stamps `.topic` (per-record producers via
 *  `buildEnrichmentProducerTask`; Shape-B / connection-scope / drift
 *  standalone tasks set it directly); core maintenance tasks leave it
 *  undefined and are skipped. Structural param shape so the collector
 *  doesn't pull in the full `HousekeepingTaskInstance` type — the MCP
 *  wiring passes the live registry through here at catalog-build time. */
export const collectRegisteredProducerTopics = (
  tasks: ReadonlyArray<{ topic?: EnrichmentTopic }>,
): ReadonlySet<EnrichmentTopic> => {
  const set = new Set<EnrichmentTopic>();
  for (const task of tasks) {
    if (task.topic !== undefined) set.add(task.topic);
  }
  return set;
};

/** Count rows for a topic that an MCP agent could actually READ — i.e.
 *  excluding substrate-private pinned correction rows (`is_pinned = 1` OR
 *  `authored_by LIKE '${ENRICHMENT_PINNED_AUTHOR_PREFIX}%'`), exactly the
 *  set `mcp.enrichment.read` drops via `exclude_pinned: true`
 *  (enrichment-read.ts). A topic backed ONLY by pinned rows holds nothing
 *  the agent can reach, so the M-ENRICH "has data" test must not count
 *  them — otherwise a no-producer, pinned-only topic would survive in the
 *  agent catalog yet return nothing on read.
 *
 *  Needs `db` (the readable filter is SQL over `is_pinned` + `authored_by`).
 *  Without it, fall back to the raw store count — a best-effort over-count
 *  that fails OPEN (the topic is kept rather than wrongly pruned). */
const countAgentReadableRowsForTopic = (
  deps: RegistryDescribeDeps,
  topic: EnrichmentTopic,
): number => {
  if (deps.db) {
    const stmt = deps.db.prepare(
      `SELECT COUNT(*) AS n FROM data_enrichment
        WHERE topic = ? AND is_pinned = 0 AND authored_by NOT LIKE ?`,
    );
    const row = stmt.get(topic, `${ENRICHMENT_PINNED_AUTHOR_PREFIX}%`) as { n: number };
    return row.n;
  }
  return deps.enrichmentStore?.countForTopic(topic) ?? 0;
};

/** M-ENRICH — agent-catalog exclusion predicate. Returns true iff the
 *  topic should be dropped from the agent-facing catalog because it has
 *  no registered producer AND no agent-readable rows. Opt-in +
 *  Settings-UI-safe:
 *    - no `registeredProducerTopics` dep ⇒ never exclude (the filter is
 *      off entirely — handler unit tests, the Settings-UI proxy, and the
 *      serve-startup window before housekeeping registration completes,
 *      where the MCP wiring passes no set; see `mcp-server.ts`).
 *    - `includePrivateTopics` (the human "show me everything" surface) ⇒
 *      never exclude, even when the producer set is present.
 *    - a topic in the producer set ⇒ keep (live capability; zero rows
 *      surfaces as `novel_query_likely_uncovered`, not hidden).
 *    - otherwise keep iff it still holds agent-readable rows (readable
 *      data outlives a retired producer); exclude only when the warehouse
 *      is also empty for it. `db`/`enrichmentStore` absent ⇒ the count
 *      falls back / degrades to keeping the topic (fail open). */
const isUnproducedEmptyTopic = (
  deps: RegistryDescribeDeps,
  topic: EnrichmentTopic,
): boolean => {
  if (deps.registeredProducerTopics === undefined) return false;
  if (deps.includePrivateTopics) return false;
  if (deps.registeredProducerTopics.has(topic)) return false;
  return countAgentReadableRowsForTopic(deps, topic) === 0;
};

/** Heuristic AI-surface determination from registry shape. P7.D's
 *  bridge until the task-registry is consistently wired here.
 *
 *    - `producer_kind: 'reactive'` → AI-surface iff the registry
 *      declares `default_trust_state: 'manual'` (per
 *      `assertEnrichmentTrustDefaults` validator gate the manual state
 *      on reactive carries this signal); otherwise deterministic.
 *    - `producer_kind: 'housekeeping'` → AI-surface iff the registry
 *      declares `default_trust_state: 'manual'` (validator-required
 *      shape per §A.8 gate 3 + P3 retrofit). The deterministic
 *      housekeeping producers (e.g. `thread_signals`) declare
 *      `default_trust_state: 'auto'`.
 *
 *  When the registry omits `default_trust_state` outright, default
 *  follows producer_kind — reactive producers ship deterministic
 *  fallback; housekeeping producers fall back to AI-surface to mirror
 *  the conservative spec default. */
const isAiSurfaceTopic = (def: EnrichmentDefinition): boolean => {
  if (def.default_trust_state === 'manual') return true;
  if (def.default_trust_state === 'auto' || def.default_trust_state === 'off') return false;
  return def.producer_kind === 'housekeeping';
};

/** Compute the producer task id for a topic. Mirrors
 *  `buildEnrichmentProducerTask`'s naming convention
 *  (`enrichment.<topic>` for housekeeping, `enrichment.reactive.<topic>`
 *  for reactive). Returns `null` for topics the substrate doesn't
 *  schedule (none today; reserved for forward-compat). */
const taskIdForTopic = (topic: EnrichmentTopic, def: EnrichmentDefinition): string | null => {
  if (def.producer_kind === 'housekeeping') return `enrichment.${topic}`;
  if (def.producer_kind === 'reactive') return `enrichment.reactive.${topic}`;
  return null;
};

/** Failure-rate heuristic from the persisted state row.
 *
 *  Today the housekeeping substrate doesn't persist a per-cycle success
 *  history — only `last_status` + `consecutive_errors` on a single row.
 *  The 24h rolling rate the spec promises is approximated as:
 *    - `last_status === 'error'` → `1.0` (tail of failures)
 *    - `consecutive_errors > 0` → `min(1, consecutive_errors / 5)`
 *      (graduated badge, capped)
 *    - otherwise `0` (last run succeeded)
 *
 *  P6 already threads `failure_attempt_count` per row — a follow-up
 *  can replace this heuristic with a precise count of failed
 *  per-record attempts in the last 24h once the audit trail's run
 *  history matures. The rough heuristic surfaces the right
 *  qualitative signal today: `0` for healthy, `1` for failing, mid
 *  for degrading. */
const failureRateFromState = (
  state: { last_status: string; consecutive_errors: number } | null,
): number => {
  if (state === null) return 0;
  if (state.last_status === 'error') return 1;
  if (state.consecutive_errors > 0) return Math.min(1, state.consecutive_errors / 5);
  return 0;
};

/** Count rows whose `authored_by` matches the substrate-private
 *  pinned-author prefix. Used to subtract from `total_rows_visible` so
 *  pinned correction rows never count toward the agent-visible total.
 *  Returns 0 when `db` is absent. */
const countPinnedRows = (db: Database.Database | undefined): number => {
  if (!db) return 0;
  // ⛔ RANGE, NOT `LIKE ?` — see `storage/prefix-range.ts`. SQLite cannot apply
  // its LIKE-prefix optimisation when the pattern is a BOUND PARAMETER, so this
  // planned as `SCAN … USING COVERING INDEX` and walked the whole
  // `idx_enrichment_authored_by` index on every call. Measured at 200k
  // enrichment rows: 3.116ms -> 0.008ms (390x), returning the identical 400.
  // The gap grows with the table — one is O(total rows), the other O(matches).
  //
  // ⚠ The index was already there. Only the predicate shape was wrong, which is
  // why the count was always correct and nothing but a plan told the story.
  //
  // ⚠ `authored_by` is declared `TEXT NOT NULL` with no COLLATE, so it uses
  // BINARY — the collation `prefixUpperBound` documents as its requirement.
  const upper = prefixUpperBound(ENRICHMENT_PINNED_AUTHOR_PREFIX);
  if (upper === null) {
    // No upper bound exists (empty prefix / max code point). The helper returns
    // null rather than fabricating one, and a guessed bound is a silently
    // truncated count — so fall back to the slow-but-correct form instead.
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM data_enrichment WHERE authored_by LIKE ?`,
    ).get(`${ENRICHMENT_PINNED_AUTHOR_PREFIX}%`) as { n: number };
    return row.n;
  }
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n FROM data_enrichment
      WHERE authored_by >= ? AND authored_by < ?`,
  );
  const row = stmt.get(ENRICHMENT_PINNED_AUTHOR_PREFIX, upper) as { n: number };
  return row.n;
};

/** Resolve `producer_last_run_at` for a topic. P7.D wires through both
 *  the in-memory housekeeping registry (default singleton) and the
 *  persisted state store; reactive producers don't have state rows
 *  (they fire on events, not cycles) so the result is null for them
 *  even when the topic has rows in the warehouse. */
const lookupProducerState = (
  deps: RegistryDescribeDeps,
  topic: EnrichmentTopic,
  def: EnrichmentDefinition,
): {
  producer_last_run_at: number | null;
  producer_failure_rate_24h: number;
} => {
  if (!deps.housekeepingStateStore) {
    return { producer_last_run_at: null, producer_failure_rate_24h: 0 };
  }
  const taskId = taskIdForTopic(topic, def);
  if (taskId === null) return { producer_last_run_at: null, producer_failure_rate_24h: 0 };
  const state = deps.housekeepingStateStore.get(taskId);
  if (state === null) return { producer_last_run_at: null, producer_failure_rate_24h: 0 };
  return {
    producer_last_run_at: state.last_run_at ?? null,
    producer_failure_rate_24h: failureRateFromState(state),
  };
};

/** P7.F §A.14.4 — coverage-quality bands. The spec maps three signals
 *  (row_count, latest_event_at vs cadence, 24h failure rate) to a
 *  four-state band:
 *
 *    | band   | conditions (any signal in the band tier wins)            |
 *    |:-------|:----------------------------------------------------------|
 *    | high   | rows > threshold AND age ≤ cadence×2 AND fail < 0.05      |
 *    | medium | rows ∈ [threshold/4, threshold] OR age > cadence×2 OR     |
 *    |        | fail ∈ [0.05, 0.20]                                        |
 *    | low    | rows < threshold/4 OR age > cadence×10 OR fail > 0.20     |
 *    | novel  | row_count == 0 OR housekeeping producer never ran with    |
 *    |        | rows present (atypical — surface as novel)                |
 *
 *  Strict-band-first dispatch (`'low'` checked before `'medium'`)
 *  because "any low signal" subsumes "any medium signal" when the row
 *  is degraded across multiple axes. The reasoning string echoes back
 *  the load-bearing signals so an agent reading the response sees why
 *  the band was chosen — surface in agent-prompts + Settings UI. */
const FAILURE_RATE_LOW_THRESHOLD = 0.05;
const FAILURE_RATE_MEDIUM_THRESHOLD = 0.2;
const CADENCE_MEDIUM_MULTIPLIER = 2;
const CADENCE_LOW_MULTIPLIER = 10;

const formatRelativeAge = (ageMs: number): string => {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  const sec = ageMs / 1000;
  if (sec < 90) return `${Math.round(sec)}s ago`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 36) return `${Math.round(hr)}h ago`;
  const day = hr / 24;
  return `${Math.round(day)}d ago`;
};

const formatPct = (rate: number): string => {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
};

interface CoverageQualityResult {
  coverage_quality: CoverageQuality;
  coverage_quality_reasoning: string;
}

/** Pure derivation. `now` is parameterized so tests can pin the
 *  cadence-age boundary deterministically. Exposed via `_testing` so
 *  unit tests can pin the band rules without standing up the full
 *  rpc. */
const deriveCoverageQuality = (
  topic: EnrichmentTopic,
  def: EnrichmentDefinition,
  coverage: RegistryDescribeTopicEntry['coverage'],
  now: number,
): CoverageQualityResult => {
  const threshold = resolveCoverageQualityThreshold(topic);
  const cadenceMs = cadenceToMs(def.recompute_cadence);
  const ageMs =
    coverage.latest_event_at !== null ? now - coverage.latest_event_at : null;
  const ageStr =
    ageMs !== null ? formatRelativeAge(ageMs) : 'no rows';
  const failureStr = formatPct(coverage.producer_failure_rate_24h);

  // Novel — row_count is zero OR housekeeping producer's task never
  // executed yet despite rows existing (atypical, but should surface
  // honestly as "warehouse coverage isn't established"). Reactive
  // producers always have producer_last_run_at: null since they fire
  // on events, not cycles — they're filtered out of the
  // never-ran-but-has-rows path.
  if (coverage.row_count === 0) {
    return {
      coverage_quality: 'novel_query_likely_uncovered',
      coverage_quality_reasoning:
        `0 rows for topic '${topic}' — warehouse has no coverage; fall through to raw.`,
    };
  }
  if (
    def.producer_kind === 'housekeeping'
    && coverage.producer_last_run_at === null
    && coverage.row_count > 0
  ) {
    return {
      coverage_quality: 'novel_query_likely_uncovered',
      coverage_quality_reasoning:
        `${coverage.row_count} rows present but housekeeping producer for '${topic}' has never run — coverage uncertain.`,
    };
  }

  // Spec §A.14.4: `row_count < threshold/4` is the strict low-band
  // boundary, `row_count between threshold/4 and threshold` is mid.
  // Compare against the raw fraction — `Math.floor(threshold/4)` mis-
  // classifies the boundary when threshold isn't divisible by 4 (with
  // default threshold = 50, threshold/4 = 12.5; 12 rows is `< 12.5`
  // and must surface as 'low', not 'medium').
  const lowBoundary = threshold / 4;
  const rowCountIsLow = coverage.row_count < lowBoundary;
  const rowCountIsMid =
    coverage.row_count >= lowBoundary && coverage.row_count <= threshold;

  // Cadence checks only meaningful when the topic declares a cadence.
  // Topics without `recompute_cadence` (deterministic per-record + most
  // stable_truth topics) skip the age check; row_count + failure rate
  // alone discriminate.
  const ageBeyondMedium =
    cadenceMs !== null
    && ageMs !== null
    && ageMs > cadenceMs * CADENCE_MEDIUM_MULTIPLIER;
  const ageBeyondLow =
    cadenceMs !== null
    && ageMs !== null
    && ageMs > cadenceMs * CADENCE_LOW_MULTIPLIER;

  const failureIsHigh =
    coverage.producer_failure_rate_24h > FAILURE_RATE_MEDIUM_THRESHOLD;
  const failureIsMid =
    coverage.producer_failure_rate_24h >= FAILURE_RATE_LOW_THRESHOLD
    && coverage.producer_failure_rate_24h <= FAILURE_RATE_MEDIUM_THRESHOLD;

  // Strict band first: any low signal subsumes any medium signal.
  if (rowCountIsLow || ageBeyondLow || failureIsHigh) {
    const reasons: string[] = [];
    if (rowCountIsLow) {
      reasons.push(`${coverage.row_count} rows (< ${lowBoundary} = threshold/4)`);
    }
    if (ageBeyondLow) {
      reasons.push(`latest event ${ageStr} (> ${CADENCE_LOW_MULTIPLIER}× cadence ${def.recompute_cadence})`);
    }
    if (failureIsHigh) {
      reasons.push(`producer failure rate ${failureStr} (> ${formatPct(FAILURE_RATE_MEDIUM_THRESHOLD)})`);
    }
    return {
      coverage_quality: 'low',
      coverage_quality_reasoning: reasons.join('; '),
    };
  }

  if (rowCountIsMid || ageBeyondMedium || failureIsMid) {
    const reasons: string[] = [];
    if (rowCountIsMid) {
      reasons.push(`${coverage.row_count} rows (between threshold/4=${lowBoundary} and threshold=${threshold})`);
    }
    if (ageBeyondMedium) {
      reasons.push(`latest event ${ageStr} (> ${CADENCE_MEDIUM_MULTIPLIER}× cadence ${def.recompute_cadence})`);
    }
    if (failureIsMid) {
      reasons.push(`producer failure rate ${failureStr} (between ${formatPct(FAILURE_RATE_LOW_THRESHOLD)} and ${formatPct(FAILURE_RATE_MEDIUM_THRESHOLD)})`);
    }
    return {
      coverage_quality: 'medium',
      coverage_quality_reasoning: reasons.join('; '),
    };
  }

  // High — every signal in the healthy zone.
  const successPct = formatPct(1 - coverage.producer_failure_rate_24h);
  const ageClause =
    ageMs !== null ? `latest event ${ageStr}` : 'recent activity';
  return {
    coverage_quality: 'high',
    coverage_quality_reasoning:
      `${coverage.row_count} rows (> ${threshold}); ${ageClause}; producer success rate ${successPct} over 24h.`,
  };
};

/** Build one per-topic entry. */
const buildEntry = (
  deps: RegistryDescribeDeps,
  topic: EnrichmentTopic,
  now: number,
): RegistryDescribeTopicEntry => {
  const def = getEnrichmentDefinition(topic);
  const ai_surface = isAiSurfaceTopic(def);
  const row_count = deps.enrichmentStore?.countForTopic(topic) ?? 0;
  const latest_event_at = deps.enrichmentStore?.getLatestEventAtForTopic(topic) ?? null;
  const { producer_last_run_at, producer_failure_rate_24h } = lookupProducerState(
    deps,
    topic,
    def,
  );

  const coverage = {
    row_count,
    latest_event_at,
    producer_last_run_at,
    producer_failure_rate_24h,
    ai_surface,
  };
  // P7.F §A.14.4 — derive band + reasoning from the same coverage
  // record we surface; `now` is parameterized at the call site so the
  // boundary is testable.
  const { coverage_quality, coverage_quality_reasoning } = deriveCoverageQuality(
    topic,
    def,
    coverage,
    now,
  );

  const checker = deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  const entry: RegistryDescribeTopicEntry = {
    topic,
    temporal_class: def.temporal_class,
    identity_aggregation: def.identity_aggregation,
    lifecycle_policy: def.lifecycle_policy as RegistryDescribeTopicEntry['lifecycle_policy'],
    valid_scopes: def.valid_scopes ?? [],
    compression_class: def.compression_class,
    prompt_bias_hints: def.prompt_bias_hints ?? [],
    description: def.description,
    ai_surface,
    // D-187 AMENDMENT — `mcp_exposed` now carries the bound contract's effective
    // read-GRANT for this topic (`isTopicReadGranted` ? 'public' : 'private'), folding
    // the former scope-fence + visibility. On the MCP-channel path un-granted topics are
    // filtered out upstream (see `handleRegistryDescribe`); on the Settings-UI path
    // (`includePrivateTopics: true`) un-granted entries are surfaced as `'private'` so
    // the owner can toggle the grant.
    mcp_exposed: checker.isTopicReadGranted(topic) ? 'public' : 'private',
    coverage,
    coverage_quality,
    coverage_quality_reasoning,
  };
  if (def.aggregate_window_ms !== undefined) entry.aggregate_window_ms = def.aggregate_window_ms;
  if (def.aggregate_window_axis !== undefined) {
    entry.aggregate_window_axis = def.aggregate_window_axis;
  }
  return entry;
};

/** D-187 AMENDMENT — count rows attached to topics the bound contract is NOT
 *  read-granted (`!isTopicReadGranted` — folding the former `mcp_exposed: 'private'`
 *  AND out-of-door-scope subtractions into ONE walk, since both are now the single
 *  grant lookup). Subtracted from `total_rows_visible` so an agent's visible total
 *  matches what it can actually read — symmetric with the pinned-author subtraction.
 *
 *  Returns 0 when every topic is read-granted (the common case today; pre-launch packs
 *  ship without `'private'` annotations + no owner grant toggles yet) or when `db` is
 *  absent. Bounded by the registry walk, not row count: the cost is the count of
 *  un-granted topics × one indexed query. */
const countUngrantedTopicRows = (
  db: Database.Database | undefined,
  checker: ReadGrantChecker,
): number => {
  if (!db) return 0;
  const ungranted: string[] = [];
  for (const topicKey of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    // Per-TOPIC entry term only — the VERB-OP half is handled by the handler's
    // `verbOpGranted ? … : 0` short-circuit (a denied verb-op zeroes the whole total,
    // independent of `db`). This is only ever called on the granted branch, so the
    // topic grant alone decides what an agent can read.
    if (!checker.isTopicReadGranted(topicKey)) {
      ungranted.push(topicKey);
    }
  }
  if (ungranted.length === 0) return 0;
  const placeholders = ungranted.map(() => '?').join(', ');
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n FROM data_enrichment WHERE topic IN (${placeholders})`,
  );
  const row = stmt.get(...ungranted) as { n: number };
  return row.n;
};

/** Optional `now` injection — tests pin the cadence-age boundary by
 *  passing an explicit value; production calls fall back to
 *  `Date.now()`. Lives on `deps` so the public handler signature stays
 *  one parameter. */
export type RegistryDescribeNowFn = () => number;

/** P7.D + P7.E + P7.F entry point. Iterates the static registry,
 *  filters topics declared `mcp_exposed: 'private'`, computes coverage
 *  + the derived `coverage_quality` band per surviving topic, returns
 *  the structured response.
 *
 *  Touch the housekeeping task registry (singleton) only as a fallback
 *  hint when callers don't pass an explicit state-store dep — keeping
 *  the handler decoupled from the registry singleton makes the
 *  read-cost-zero test ratchet trivial: pass minimal deps and assert
 *  no LLM was reached, regardless of what the singleton holds. */
export const handleRegistryDescribe = (
  deps: RegistryDescribeDeps,
  options?: { now?: RegistryDescribeNowFn },
): RegistryDescribeRpcOutput => {
  const now = options?.now ? options.now() : Date.now();
  const checker = deps.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  // D-187 slice 3 — the read gate's VERB-OP term: "may this contract use registryDescribe
  // at all". Composed with each topic's entry grant below via `isGrantedReadAdmissible`.
  // Resolved once (constant per call). On the AI-facing path a denied verb-op empties the
  // catalog; the Settings-UI bypass (`includePrivateTopics: true`) is exempt — it is the
  // human configuring their own warehouse (outside the grant axis), never verb-op-gated.
  const verbOpGranted = checker.isVerbOpGranted(REGISTRY_DESCRIBE_VERB_OP);
  const topics: RegistryDescribeTopicEntry[] = [];
  for (const topicKey of Object.keys(ENRICHMENT_REGISTRY) as EnrichmentTopic[]) {
    // D-187 AMENDMENT — drop topics the bound contract is NOT read-granted from the
    // response array entirely. Agents never see them or know the topic exists. The read
    // gate = `verb-op grant ∧ topic grant` (`isGrantedReadAdmissible`): a denied verb-op
    // drops EVERY topic; a topic grant does not imply the verb. The checker's
    // `isTopicReadGranted` folds the former per-topic `mcp_exposed` visibility filter AND
    // the door-scope fence into ONE grant lookup. The Settings-UI bypass
    // (`includePrivateTopics: true`) surfaces every topic so the owner can toggle the
    // grant (the per-entry `mcp_exposed` field still reflects the effective topic grant).
    if (
      !deps.includePrivateTopics &&
      !isGrantedReadAdmissible(verbOpGranted, checker.isTopicReadGranted(topicKey))
    ) {
      continue;
    }
    // M-ENRICH (internal planning notes) — drop topics with no registered
    // producer AND no rows from the agent catalog so the AI never plans
    // against an enrichment that nothing produces + that holds nothing to
    // read. Opt-in via `registeredProducerTopics`; the Settings-UI path
    // leaves it unset (+ sets `includePrivateTopics`) so the human still
    // sees every topic. Checked after the private filter so the two layer
    // additively.
    if (isUnproducedEmptyTopic(deps, topicKey)) continue;
    topics.push(buildEntry(deps, topicKey, now));
  }
  // Stable ordering — alphabetical by topic. Keeps response diff-friendly
  // for cache / snapshot consumers; agents don't depend on a particular
  // order but predictability is cheap.
  topics.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));

  const totalRows = deps.enrichmentStore?.count() ?? 0;
  const pinnedRows = countPinnedRows(deps.db);
  // D-187 AMENDMENT — subtract rows attached to topics the bound contract is NOT
  // read-granted so `total_rows_visible` matches what the agent CAN reach via reads
  // (the former private-topic + out-of-scope subtractions, unified into one grant
  // walk). Symmetric with the pinned-row subtraction; both layer additively. The
  // Settings-UI bypass leaves the count unchanged: the field describes what an agent
  // would see, regardless of who's asking.
  // D-187 slice 3 — a denied verb-op makes the whole tool unusable, so the visible total
  // is 0 REGARDLESS of `db` (the count subtraction below is `db`-dependent and would
  // otherwise leak a nonzero total to a denied caller when `enrichmentStore` is wired but
  // `db` is not — codex MEDIUM). On the granted branch the per-topic subtraction applies.
  const total_rows_visible = verbOpGranted
    ? Math.max(0, totalRows - pinnedRows - countUngrantedTopicRows(deps.db, checker))
    : 0;

  return { topics, total_rows_visible };
};

/** Test-only export — exposes internal helpers so unit tests can pin
 *  per-topic AI-surface inference + the failure-rate heuristic +
 *  task-id naming convention + the P7.F coverage_quality derivation
 *  without reaching through the rpc surface. */
export const _testing = {
  isAiSurfaceTopic,
  failureRateFromState,
  taskIdForTopic,
  countPinnedRows,
  countUngrantedTopicRows,
  countAgentReadableRowsForTopic,
  isUnproducedEmptyTopic,
  deriveCoverageQuality,
  formatRelativeAge,
  formatPct,
  FAILURE_RATE_LOW_THRESHOLD,
  FAILURE_RATE_MEDIUM_THRESHOLD,
  CADENCE_MEDIUM_MULTIPLIER,
  CADENCE_LOW_MULTIPLIER,
};
