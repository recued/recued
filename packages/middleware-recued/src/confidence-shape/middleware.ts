/** D-160 P2 — the `confidence-shape` stream-middleware adapter (§ P2).
 *
 *  Registers the D-137 P3 § A.5 confidence-shape classifier as a D-160
 *  stream middleware. Lifecycle footprint: `update` (`after-turn`) — the
 *  classifier processes the turn's candidate distribution and resolves
 *  one of the four discrete confidence patterns the disambiguation UX
 *  keys off. The adapter runs `classifyConfidenceShape` (pure, no AI
 *  call) over the scored candidates and writes the resolved shape back
 *  to `ctx.state`.
 *
 *  Scaffold scope (D-160 P2): the scored-candidate list rides
 *  `ctx.state` (`CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY`) — a future
 *  producer / the deferred D-137-chat refactor (D-160 O-5) populates it
 *  from the scope-search fan-out. Absent one, the classifier runs over
 *  the empty list and resolves Pattern 4 (empty / refuse-cleanly) — a
 *  real, valid result, not a no-op.
 *
 *  Spec: D-160 § P2.
 */

import type { Middleware, TurnResult } from '@recued/middleware';

import { classifyConfidenceShape, type ScoredCandidate } from './classify.js';

/** `ctx.state` key — the `ScoredCandidate[]` the turn produced. */
export const CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY = 'confidence-shape:candidates';
/** `ctx.state` key — where the adapter writes the resolved
 *  `ConfidenceShape`. */
export const CONFIDENCE_SHAPE_RESULT_STATE_KEY = 'confidence-shape:result';

/** Read the scored-candidate list off `ctx.state`. A non-array value
 *  (or an absent key) yields the empty list — the classifier still runs
 *  and resolves Pattern 4. */
const readCandidates = (
  state: TurnResult['state'],
): readonly ScoredCandidate<unknown>[] => {
  const raw = state.get(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY);
  return Array.isArray(raw) ? (raw as readonly ScoredCandidate<unknown>[]) : [];
};

/** The `confidence-shape` middleware — registers enabled (D-160 P2). */
export const confidenceShapeMiddleware: Middleware = {
  id: 'confidence-shape',
  update(ctx: TurnResult): void {
    const shape = classifyConfidenceShape(readCandidates(ctx.state));
    ctx.state.set(CONFIDENCE_SHAPE_RESULT_STATE_KEY, shape);
  },
};
