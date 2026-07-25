/** D-137 P2 § A.4 — Server-side read consolidation: fan-out runner.
 *
 *  Sequential default. Each `ScopeSearchSource` declares its closed
 *  source id (`'local'` / `'hubspot'` / `'salesforce'`); the runner
 *  invokes them in registration order, catches per-source throws into
 *  `partial_failures`, and emits one `ScopeSearchCandidate` per record
 *  with provenance tagged. Source-level enable gates (per-pair prefs
 *  from § A.4 settings UI) check up-front so a disabled source is
 *  skipped without surfacing a partial-failure entry — disabling is
 *  Mary's explicit opt-out, not a degradation event.
 *
 *  Pure: no I/O, no time, no shared state. The per-source `query`
 *  closure performs whatever read it needs (warehouse table / store /
 *  remote API); the runner is just the orchestration shell.
 *
 *  Sequential vs parallel decision: P2 ships sequential per the
 *  D-137 spec ("default sequential for cost discipline" — sources
 *  that hit warehouse tables are cheap, but the registry surface is
 *  shared with platform-reference sources that may incur rate-limit
 *  pressure when they widen post-D-128). Parallel becomes a per-tool
 *  opt-in flag in a later phase if cost-of-latency justifies; sticking
 *  to sequential at P2 keeps the partial-failure ordering deterministic
 *  for tests and the agent's "what came back from where" copy. */

import type {
  ScopeSearchCandidate,
  ScopeSearchPartialFailure,
  ScopeSearchResult,
  ScopeSearchSourceId,
} from '@recued/contracts';

/** D-137 P2 § A.4 — one fan-out source contract. `id` is the closed
 *  `ScopeSearchSourceId` (substrate-level); `isEnabled` is the per-pair
 *  prefs gate (omitted → always on, which is the `'local'` default);
 *  `query` is the async closure that fetches records for the given
 *  args. The runner doesn't know `Args` or `T`'s shape — both are
 *  per-tool concerns (`contact.search` uses `ContactRecord`,
 *  `deal.search` uses a CRM-deal record shape; future tools widen
 *  similarly).
 *
 *  Per-source ranking: a source may attach an optional `score` to each
 *  returned record (0–1 relevance / similarity). P2 leaves scoring
 *  opaque — sources return `{ record, score? }`. P3's confidence-shape
 *  dispatch (§ A.5) consumes `score`. */
export interface ScopeSearchSource<Args, T> {
  id: ScopeSearchSourceId;
  /** Optional gate. Returns false → source skipped without
   *  contributing a partial-failure entry. Use for per-pair prefs
   *  toggles (`chat.scope_sources.<tool>.<source>`) + connection-
   *  presence checks (HubSpot connection absent → skip). */
  isEnabled?: () => boolean;
  /** Per-source query closure. Returns the records this source
   *  contributed; `score` per record is optional (default unscored).
   *  Throws are caught by the runner — surface real query failures
   *  (network timeout, db error, malformed response) as exceptions
   *  with descriptive messages; the runner pipes `err.message` into
   *  `ScopeSearchPartialFailure.reason`. */
  query: (args: Args) => Promise<ReadonlyArray<{ record: T; score?: number }>>;
}

/** D-137 P2 § A.4 — sequential fan-out runner. Walks `sources` in
 *  registration order; each source's results join the candidate list
 *  with `source: src.id` provenance. Caught throws populate
 *  `partial_failures`; the all-green path omits both `partial` and
 *  `partial_failures` so the result envelope stays minimal.
 *
 *  Closed-list source-id assertion: each `src.id` is typed
 *  `ScopeSearchSourceId` at construction; the runner doesn't
 *  re-validate. New ids = widen `ScopeSearchSourceId` in contracts
 *  (substrate change), not silently pass through.
 *
 *  Per-source isEnabled is called once per fan-out invocation —
 *  callers that want to evaluate the gate lazily can fold the lookup
 *  into `query` itself, but the more common pattern is a synchronous
 *  prefs read at construction. */
export const runScopeSearchFanout = async <Args, T>(
  args: Args,
  sources: ReadonlyArray<ScopeSearchSource<Args, T>>,
): Promise<ScopeSearchResult<T>> => {
  const candidates: ScopeSearchCandidate<T>[] = [];
  const partial_failures: ScopeSearchPartialFailure[] = [];

  for (const src of sources) {
    if (src.isEnabled && !src.isEnabled()) continue;
    try {
      const records = await src.query(args);
      for (const r of records) {
        const candidate: ScopeSearchCandidate<T> = {
          source: src.id,
          record: r.record,
        };
        if (typeof r.score === 'number' && Number.isFinite(r.score)) {
          candidate.score = r.score;
        }
        candidates.push(candidate);
      }
    } catch (err) {
      partial_failures.push({
        source: src.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (partial_failures.length > 0) {
    return { candidates, partial: true, partial_failures };
  }
  return { candidates };
};
