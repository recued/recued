/** D-137 P3 — confidence-shape barrel.
 *
 *  Three modules:
 *
 *    - `classify.ts`           — § A.5 4-pattern distribution
 *      classifier + recency tiebreak (`classifyConfidenceShape`,
 *      `sortByScoreWithRecency`).
 *    - `recipe-fallback.ts`    — § A.5 Pattern 4 + § A.6 recipe
 *      fall-through resolver (`findRecipeFallback`).
 *    - `compound-ambiguity.ts` — § A.12 cascade analyzer
 *      (`detectCompoundAmbiguity` + `narrowByDomain`).
 *
 *  Every export is pure; no I/O, no clock, no shared state. Wiring
 *  into the chat orchestrator + chat-tool-handlers lives in
 *  `backend/server/src/`. */

export {
  classifyConfidenceShape,
  sortByScoreWithRecency,
  CONFIDENCE_DOMINANT_SCORE,
  CONFIDENCE_DOMINANT_MARGIN,
  CONFIDENCE_LOW_FLOOR,
  CONFIDENCE_TIEBREAK_EPSILON,
  type ConfidencePattern,
  type ConfidenceShape,
  type ConfidenceShapePattern1,
  type ConfidenceShapePattern2,
  type ConfidenceShapePattern3,
  type ConfidenceShapePattern4,
  type ConfidenceMeasures,
  type ClassifyConfidenceShapeOptions,
  type ScoredCandidate,
} from './classify.js';

export {
  findRecipeFallback,
  type RecipeFallbackSuggestion,
  type FindRecipeFallbackOptions,
} from './recipe-fallback.js';

export {
  detectCompoundAmbiguity,
  narrowByDomain,
  COMPOUND_AMBIGUITY_LAYERS,
  type CompoundAmbiguityLayer,
  type CompoundAmbiguityEntity,
  type CompoundAmbiguityPlan,
} from './compound-ambiguity.js';
