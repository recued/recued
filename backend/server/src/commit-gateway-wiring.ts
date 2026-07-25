/** D-145 engine-wiring slice 3b.3 — server-side commit Gateway wiring.
 *
 *  Slice 3b.2 authored the D-153 commit Gateway (`@recued/gateway`)
 *  inert. This module is the server-side glue slice 3b.3 needs to wire
 *  it into the live engine — three pieces, all consumed by
 *  `execute-handler.ts`:
 *
 *   - `buildCommitRunIdentity` — assembles the per-run `CommitRunIdentity`
 *     the Gateway stamps on every commit a recipe run dispatches.
 *   - `cacheAwareGatewayInner` — adapts the server's L1-cached ingredient
 *     executor into the Gateway's `GatewayInner`, reporting an L1 cache
 *     hit back through the per-call `GatewayCallProbe`.
 *   - `observeCacheStatus` — the `withIngredientCache` `onStatus` hook
 *     that detects the hit; wired into the L1 cache via
 *     `createBoundExecutor`.
 *
 *  ## How `cached` is reported
 *
 *  The Gateway flags a commit `cached: true` when the output came from
 *  cache instead of the boundary (D-153 § Execution-request anchor:
 *  "cache is a side effect, never a row" — the commit is written either
 *  way). The L1 ingredient cache (`withIngredientCache`, composed
 *  *inside* `createBoundExecutor`) knows when it served a hit, but it
 *  reports that through a per-wrapper `onStatus` callback, not per call.
 *  The engine's prefetch phase dispatches ingredient calls
 *  *concurrently*, so a shared "last call was a hit" flag would race.
 *
 *  `AsyncLocalStorage` bridges the two: each Gateway dispatch runs its
 *  wrapped executor inside `cacheProbeStore.run(probe, …)`. The L1
 *  cache's `onStatus` fires within that async context (ALS propagates
 *  across `await`), so `observeCacheStatus` reads exactly the probe
 *  belonging to the call that hit — concurrency-safe by construction,
 *  no per-call wiring threaded through the cache layer.
 *
 *  ## Cache scope — L1 only
 *
 *  The Gateway wraps `ctx.ingredientExecutor`, so it sits *outside* the
 *  L1 ingredient cache (composed inside `createBoundExecutor`) — an L1
 *  hit still reaches the Gateway and still produces a commit, flagged
 *  `cached`. It sits *inside* the engine's L2 step cache
 *  (`executeRecipe`'s `stepCache`), which short-circuits before
 *  `ctx.ingredientExecutor` is ever called — so an L2 step-cache hit
 *  produces no commit at all. That gap is bounded + non-critical: the
 *  L2 step cache only memoises read-only (`data` / `ai`) ingredient
 *  outputs — every `action` ingredient bypasses both cache tiers, so no
 *  side-effecting commit is ever lost; only some `query` read-replays
 *  go unlogged. Surfacing L2 replays as `cached` commits needs an
 *  engine seam and is a follow-on, not slice 3b.3.
 *
 *  Spec: D-153 § Gateway / § Execution-request anchor.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContractSnapshot, ExecutionSource } from '@recued/contracts';
import type { CommitRunIdentity, GatewayCallProbe, GatewayInner } from '@recued/gateway';
import type { IngredientCacheOptions, IngredientExecutor } from '@recued/ingredients';

/** Per-call cache-hit probe store. Each Gateway dispatch runs its
 *  wrapped executor inside `cacheProbeStore.run(probe, …)` so the L1
 *  cache's `onStatus` callback can find that call's `GatewayCallProbe`.
 *  `AsyncLocalStorage` — not a module-level "current probe" — because
 *  the engine's prefetch phase dispatches ingredient calls
 *  concurrently; each call needs its own isolated probe, and ALS scopes
 *  correctly across every `await` inside the call. */
const cacheProbeStore = new AsyncLocalStorage<GatewayCallProbe>();

/** `withIngredientCache.onStatus` observer — wired into the server's L1
 *  ingredient cache via `createBoundExecutor`. On a cache hit
 *  (`'hit'` = fresh, `'hit_stale'` = served stale under `freshness:
 *  'any'`) it marks the active per-call `GatewayCallProbe` so the
 *  Gateway records `cached: true` on the commit.
 *
 *  `'miss'` (the call crossed the boundary) and `'skipped'` (the cache
 *  was bypassed — `action` ingredient, non-read tier, or `freshness:
 *  'fresh'`) are no-ops. Fires outside any Gateway dispatch (no run
 *  identity → no Gateway wrap → no `cacheProbeStore.run` scope) resolve
 *  to no active probe and no-op safely. */
export const observeCacheStatus: NonNullable<IngredientCacheOptions['onStatus']> = (
  status,
) => {
  if (status !== 'hit' && status !== 'hit_stale') return;
  const probe = cacheProbeStore.getStore();
  if (probe !== undefined) probe.cached = true;
};

/** Adapt a plain `IngredientExecutor` into the Gateway's `GatewayInner`
 *  — the cache-aware variant slice 3b.3 wires (vs. `@recued/gateway`'s
 *  `liftExecutor`, which never reports `cached`). Each call runs inside
 *  an `AsyncLocalStorage` scope holding the Gateway's per-call probe,
 *  so the L1 cache's `observeCacheStatus` hit signal lands on the right
 *  probe even under the engine's concurrent prefetch dispatch.
 *
 *  `probe` is the Gateway's trailing per-call argument; the leading
 *  five parameters are the plain `IngredientExecutor` signature,
 *  forwarded unchanged. */
export const cacheAwareGatewayInner = (
  executor: IngredientExecutor,
): GatewayInner =>
  (slug, input, stepOutput, stepOptions, stepMeta, probe) =>
    cacheProbeStore.run(probe, () =>
      executor(slug, input, stepOutput, stepOptions, stepMeta));

/** Assemble the per-run `CommitRunIdentity` the Gateway stamps onto
 *  every commit a recipe run dispatches. The session IDs
 *  (`channel_session_id` / `correlation_id`) are the engine-derived
 *  values `handleExecute` already stamps on the recipe-run audit row,
 *  passed straight through so a run's commits and its audit row agree.
 *
 *  `request_id` is the run's audit `run_id` — the execution-request
 *  anchor FK (D-153 § Execution-request anchor). `dispatch_depth`
 *  defaults to `0` — a top-level run — and is threaded through from the
 *  caller's `ExecuteRequest.dispatch_depth` when the run is a
 *  re-entrant hop (D-160 P3 / I-7 — a `messenger` post that re-enters
 *  as a trigger). `cognition_session_id` is omitted — cognition ships
 *  pluggable + default-disabled, so a recipe run opens no cognition
 *  window. */
export const buildCommitRunIdentity = (args: {
  request_id: string;
  source: ExecutionSource;
  channel_session_id: string;
  correlation_id: string;
  contract_snapshot?: ContractSnapshot;
  dispatch_depth?: number;
  /** R2 step 6 — present only on a saga compensation run
   *  (`internal.predecessor_commit_id`); the Gateway copies it onto
   *  every commit the run writes, linking the row being undone. */
  predecessor_commit_id?: string;
}): CommitRunIdentity => ({
  request_id: args.request_id,
  source: args.source,
  channel_session_id: args.channel_session_id,
  correlation_id: args.correlation_id,
  ...(args.contract_snapshot !== undefined
    ? { contract_snapshot: args.contract_snapshot }
    : {}),
  dispatch_depth: args.dispatch_depth ?? 0,
  ...(args.predecessor_commit_id !== undefined
    ? { predecessor_commit_id: args.predecessor_commit_id }
    : {}),
});
