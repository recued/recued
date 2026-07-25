/** D-145 PB6 — composer ordering rules over `ExtractionEvent`.
 *
 *  Per § B.7.8. Three rules:
 *
 *    1. Resolutions before extractions that reference them.
 *    2. Extractions before derived effects.
 *    3. Stable order for same-class events (preserve AI-returned
 *       order so user-facing reading is coherent).
 *
 *  PB6 implements stable-priority sort — primary sort key is the
 *  per-class priority via `EXTRACTION_EVENT_CLASS_PRIORITY` (lower
 *  renders first); ties resolve to original AI-returned index.
 *
 *  Pure function — no side effects, deterministic over the same
 *  input. Consumers (PB6 composer, PB7 transparency-stream renderer,
 *  PB13 dry-run preview) thread the ordered events to downstream
 *  pipelines.
 *
 *  Spec: § B.7.8. */

import {
  EXTRACTION_EVENT_CLASS_PRIORITY,
  classForExtractionEventKind,
  type ExtractionEvent,
} from '@recued/contracts';

/** Stable composer-ordering sort. Primary key = class priority
 *  (resolutions=0, extractions=1, derived_effect=2 per § B.7.8 rule 1
 *  + rule 2). Ties resolve to original-input order (rule 3).
 *
 *  Pure function: returns a new array; never mutates the input. The
 *  caller may pass through `dispatched` (PB6.dispatch) or raw events
 *  — the sort is shape-agnostic via the supplied `kindOf` accessor. */
export const orderEvents = <T>(
  items: ReadonlyArray<T>,
  kindOf: (item: T) => ExtractionEvent['kind'],
): ReadonlyArray<T> => {
  // Decorate with stable index so tie-breakers preserve input order.
  const decorated = items.map((item, index) => ({
    item,
    index,
    priority: EXTRACTION_EVENT_CLASS_PRIORITY[
      classForExtractionEventKind(kindOf(item))
    ],
  }));
  decorated.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.index - b.index;
  });
  return decorated.map((d) => d.item);
};

/** Convenience overload over raw `ExtractionEvent[]` — no kindOf
 *  accessor required. */
export const orderExtractionEvents = (
  events: ReadonlyArray<ExtractionEvent>,
): ReadonlyArray<ExtractionEvent> =>
  orderEvents(events, (event) => event.kind);
