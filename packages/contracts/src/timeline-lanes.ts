/** D-161 Part B (P3) — timeline / Memory actor lanes.
 *
 *  P1 stamped every warehouse / memory / link / enrichment row with an
 *  `origin_actor` write-actor facet (`origin-provenance.ts`); P2 let a
 *  producer *read* that stamp to gate its input (`input-provenance.ts`).
 *  P3 reads the same stamp on the *consumer* side: the aggregate "Recent
 *  activity" Memory feed + the per-entity `data.timeline()` feed.
 *
 *  This extends D-120's `run_mode` pollution axis with `origin_actor` as a
 *  SECOND axis (A.7): the aggregate feed foregrounds the gold-path actors
 *  (`user_self` + `system`) and treats `contracted_user` / `anonymous`
 *  activity as a *filterable lane* — reachable on request, never folded in
 *  as "the user did this," and never dropped from the warehouse (I-7:
 *  treatment, never exclusion; the abuse gate is upstream D-149).
 *
 *  **O-2 settled — a general `origin_actor` filter facet, not a fixed
 *  three-lane (`user` / `agents` / `reception`) enum.** Propagating the one
 *  D-153 actor model (I-6) means filtering on the `Actor` set directly; the
 *  "default foreground" is just this facet's default value, and the named
 *  lanes (agents = `contracted_user`, reception = `anonymous`) are a derived
 *  presentation a UI computes from `origin_actor` — not a second taxonomy
 *  layered over the actor enum.
 *
 *  This is a DISTINCT axis from P2's input-provenance trust
 *  (`DEFAULT_ORIGIN_ACCEPTANCE`): P2 asks "is this producer's INPUT safe?"
 *  (injection surface); P3 asks "which lane does this row read in?"
 *  (display foregrounding). The two default sets happen to coincide
 *  (`user_self` + `system`) but are independent — changing one must not move
 *  the other, so they are separate constants (the I-8 ethos: distinct axes,
 *  evaluated independently).
 *
 *  Spec: D-161 § N.8 / A.7 / I-7 / I-9 / O-2.
 */

import type { Actor } from './commits.js';
import { isActor } from './commits.js';

/** The default-foreground actor set for the aggregate "Recent activity"
 *  Memory feed — `user_self` + `system` only (A.7: `user_self`
 *  foregrounded, `system` folded in as correspondence). Outside-actor
 *  activity (`contracted_user` / `anonymous`) is NOT in the default lane —
 *  it is reachable via an explicit filter, never folded into "the user did
 *  this" (N.8). Frozen so the shared reference can't be mutated by a
 *  caller.
 *
 *  Note: this is the DISPLAY-foregrounding axis, deliberately a separate
 *  constant from P2's input-trust `DEFAULT_ORIGIN_ACCEPTANCE` even though
 *  the value coincides — the two axes are independent (I-8). */
export const TIMELINE_DEFAULT_ORIGIN_ACTORS: readonly Actor[] = Object.freeze([
  'user_self',
  'system',
]);

/** True iff a row whose write-actor is `origin_actor` passes a timeline /
 *  feed `filter`. Pure — callers pair it with each source's read-back
 *  `origin_actor` (memory derives it from `execution_source.actor`).
 *
 *  - `filter` `undefined` (or empty) → **no narrowing**: every row passes.
 *    The per-entity `data.timeline()` default; preserves full per-entity
 *    history + the I-9 gold-path-unchanged guarantee for callers that don't
 *    opt into a lane.
 *  - `origin_actor` `undefined` → treated as `'system'`. Matches the P1
 *    column default + P2's `readSourceOriginActor`: a row P1 didn't stamp
 *    (or a pruned memory entry whose `execution_source` is gone) is engine-
 *    internal `system` by construction, never an outside injection surface,
 *    so it reads in the gold-path lane. */
export const originActorPassesTimelineFilter = (
  origin_actor: Actor | undefined,
  filter: readonly Actor[] | undefined,
): boolean => {
  if (filter === undefined || filter.length === 0) return true;
  return filter.includes(origin_actor ?? 'system');
};

/** Coerce an untyped wire value (an rpc arg, a query param) into a clean
 *  `Actor[]` lane filter, or `undefined` when no narrowing is requested.
 *
 *  - non-array, or an array with no valid `Actor` member → `undefined`
 *    (treated as "no filter" by `originActorPassesTimelineFilter` and as
 *    "use the default foreground" by the aggregate-feed handler — a caller
 *    passing `[]` or junk never accidentally empties the feed).
 *  - an array → the de-duplicated subset of valid `Actor` members, in first-
 *    seen order. Unknown strings are dropped rather than throwing so a
 *    forward-compat client sending a not-yet-known actor degrades to a
 *    narrower-but-valid filter instead of a 400. */
export const sanitizeTimelineOriginFilter = (
  value: unknown,
): readonly Actor[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<Actor>();
  for (const item of value) {
    if (isActor(item)) seen.add(item);
  }
  return seen.size > 0 ? Object.freeze([...seen]) : undefined;
};
