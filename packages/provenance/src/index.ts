/** @recued/provenance — D-120 provenance-link classification.
 *
 *  D-159 P1 relocated `link-classifier.ts` out of `@recued/engine`:
 *  the deterministic recipe-plan executor's keep-list (D-159 N.3)
 *  excludes provenance instrumentation. The engine still calls these
 *  pure, deterministic helpers as it runs each step — `@recued/engine`
 *  imports `@recued/provenance`, never the reverse.
 *
 *  Spec: D-159 § N.2 + O-2; D-120.
 */

// D-120 Phase 3 — engine-facing provenance link classification.
export {
  inferExternalCallHost,
  stepEmitsLinks,
  classifyKind,
  type StepTouchDescriptor,
} from './link-classifier.js';
