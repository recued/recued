/** D-161 Part B (P2) — the input-provenance trust axis.
 *
 *  P1 stamped every warehouse / memory / link / enrichment row with an
 *  `origin_actor` write-actor facet (`origin-provenance.ts`). P2 lets a
 *  producer *read* that stamp to decide whether a source row is safe to
 *  process — the **producer provenance-filter**.
 *
 *  This is the *injection-surface* axis (A.6 / I-8): "is this producer's
 *  INPUT safe?" It is **distinct from D-132's `enrichment_trust`** ("should
 *  this producer run at all?" — cost / consent / pool policy). The two
 *  gates are evaluated independently; neither subsumes the other. D-132
 *  gates per-topic at the scheduler / reactive dispatch; this gate is
 *  per-row inside the producer harness.
 *
 *  A producer declares the `origin_actor` classes it accepts via
 *  `EnrichmentDefinition.origin_acceptance`. A producer over a row outside
 *  its accepted classes **skips that row** — the row stays in the warehouse
 *  and other producers are unaffected (I-7: treatment, never exclusion; the
 *  abuse gate is upstream D-149). An **undeclared** producer falls back to
 *  the conservative `user_self` + `system`-only default — an undeclared
 *  producer is never auto-exposed to `anonymous` / `contracted_user` input
 *  (N.9 MUST / TR-7: a settled security property, not an open question).
 *
 *  Composes with D-139's content-`authorship` acceptance (A.5): D-139's
 *  `authorship_acceptance` gates the *external author* of `system`-ingested
 *  content (mail); this gates the *write-actor* of the row (Reception forms,
 *  MCP writes). Both are "input-provenance" but read different facets;
 *  producers that care about both declare both.
 *
 *  Spec: D-161 § N.8 / A.5 / A.6 / A.7 / I-7 / I-8 / O-4.
 */

import type { Actor } from './commits.js';
import { isActor } from './commits.js';

/** The conservative acceptance set for a producer that ships **no**
 *  `origin_acceptance` declaration — `user_self` + `system` only. An
 *  undeclared producer is never auto-exposed to `anonymous` /
 *  `contracted_user` input (N.9 MUST / TR-7). Frozen so the shared
 *  reference can't be mutated by a caller. */
export const DEFAULT_ORIGIN_ACCEPTANCE: readonly Actor[] = Object.freeze([
  'user_self',
  'system',
]);

/** Resolve a producer's effective accepted-origin set: the declared list
 *  when present, else the conservative default (N.9 MUST). Returns a
 *  read-only array; callers must not mutate. */
export const resolveOriginAcceptance = (
  declared: readonly Actor[] | undefined,
): readonly Actor[] => declared ?? DEFAULT_ORIGIN_ACCEPTANCE;

/** True iff a producer with the given `declared` acceptance set accepts a
 *  source row whose write-actor is `origin_actor`. Pure — the harness
 *  pairs it with `readSourceOriginActor` to gate each row (I-7). The
 *  declaration shape is a closed class list mirroring D-139's
 *  `authorship_acceptance` (O-4 settled). */
export const isOriginActorAccepted = (
  origin_actor: Actor,
  declared: readonly Actor[] | undefined,
): boolean => resolveOriginAcceptance(declared).includes(origin_actor);

/** Read the write-actor off a producer's source-row `data` payload,
 *  defaulting to `'system'` when the row carries no `origin_actor` facet.
 *
 *  Warehouse rows (`CollectionRecord` / `ContactRecord`) surface
 *  `origin_actor` from their P1 read-back; work-entity rows (note / task /
 *  project) that P1 did not stamp carry none — those are internal,
 *  user/system-authored entities and never an outside injection surface,
 *  so the `'system'` default is both correct (mirrors the column default +
 *  `SYSTEM_ORIGIN`) and accepted by the conservative default set. */
export const readSourceOriginActor = (data: unknown): Actor => {
  if (data !== null && typeof data === 'object') {
    const candidate = (data as { origin_actor?: unknown }).origin_actor;
    if (isActor(candidate)) return candidate;
  }
  return 'system';
};
