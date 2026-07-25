/** D-164 P4h-1 — audit-grow promotion counter.
 *
 *  Tracks how many times a "similar" prompt has executed against the
 *  gate without short-circuiting. When the count crosses
 *  `DEFAULT_PROMOTION_THRESHOLD` (configurable per tracker), the
 *  caller surfaces a Kitchen-UI suggestion: "save this as a template
 *  so future iterations short-circuit?" The promotion decision is
 *  always **user-confirmed** (design O-6); the tracker only signals
 *  candidacy.
 *
 *  Similarity is opaque to the tracker — callers compose a string
 *  key via `composePromotionKey` (or supply their own) and the
 *  tracker buckets counts by that key. The canonical key mirrors
 *  the library's match key (sorted slot grammar + locale) so a
 *  prompt that would benefit from a template has its repeats
 *  grouped under the same key as the library would later match on.
 *
 *  Caller contracts:
 *
 *  - **Reset on acknowledgement.** `shouldSuggest` is level-
 *    triggered: once `count(key) >= threshold` it returns `true`
 *    every call until `reset(key)`. Callers MUST call `reset` after
 *    surfacing the suggestion to avoid nagging on every subsequent
 *    prompt. Both terminal paths (promotion landed / user dismissed)
 *    converge on `reset`; the next `threshold` records re-fire the
 *    suggestion.
 *
 *  - **Per-pair instances.** Audit-grow templates are per-user (per-
 *    pair) by design (D-164 § 1 templates/audit-grow). Callers MUST
 *    instantiate one `PromotionTracker` per pair (per chat session
 *    or per server-side identity) so counts don't aggregate across
 *    users. A single server-wide tracker would silently surface
 *    suggestions based on combined activity — wrong by design.
 *
 *  - **Bounded growth.** The tracker is an in-memory `Map<string,
 *    number>` with no LRU cap. The slot-grammar + locale key space
 *    is small (locale × multiset of 4 NER slot kinds), so per-pair
 *    growth is bounded in practice. Persistent storage + eviction
 *    arrive with the warehouse-backed store (later P4h sub-slice);
 *    operators worried about per-process growth can recreate the
 *    tracker on a periodic boundary today.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/audit-grow / O-6 (user-promoted only, default N=3). */

import type { SlotName } from '../../types.js';

/** Default N-repeat threshold (design O-6). User-configurable per
 *  tracker via `createPromotionTracker({threshold})`. Three is a
 *  conservative default — high enough that one-off prompts don't
 *  trip the suggestion, low enough that genuinely repeated workflows
 *  surface quickly. */
export const DEFAULT_PROMOTION_THRESHOLD = 3;

/** Inputs to the canonical key composer. Mirrors the library's
 *  match key inputs (slot grammar + locale). Verb-bearing prompts
 *  are not part of this slice's key — the library doesn't yet match
 *  on verb (P4f scope), so a verb-tagged key would bucket counts
 *  against a shape the library could never resolve. Verb support
 *  re-lands here when the library's match adds a verb dimension. */
export interface PromotionKeyInput {
  readonly slot_grammar: ReadonlyArray<SlotName>;
  readonly locale: string;
}

/** Compose the canonical promotion key for a prompt shape. Uses
 *  `JSON.stringify` over a tuple so any caller-supplied content
 *  (currently just `locale`) is escape-safe by construction — a
 *  locale containing the legacy `|` separator can't collide with a
 *  different (locale, grammar) bucket. Sorted slot grammar preserves
 *  duplicates so the multiset semantics carry through (matches the
 *  library's match rule + the bundle hash's grammar handling). */
export const composePromotionKey = (input: PromotionKeyInput): string => {
  const sortedGrammar = [...input.slot_grammar].sort();
  return JSON.stringify([input.locale, sortedGrammar]);
};

/** Public tracker contract. All methods are synchronous + pure
 *  with respect to the tracker's own state — no I/O. */
export interface PromotionTracker {
  /** Increment the count for `key`. Returns the new count. */
  record(key: string): number;
  /** Read the current count for `key` (0 if never recorded). */
  count(key: string): number;
  /** True iff `count(key) >= threshold`. Level-triggered — see the
   *  "Reset on acknowledgement" caller contract in the module
   *  header. */
  shouldSuggest(key: string): boolean;
  /** Zero the count for `key`. Idempotent; safe to call for an
   *  unrecorded key. */
  reset(key: string): void;
}

export interface CreatePromotionTrackerOptions {
  /** N-repeat threshold the suggestion fires at. Defaults to
   *  `DEFAULT_PROMOTION_THRESHOLD = 3`. Must be a positive integer
   *  (>= 1) — values <= 0 would suggest on every record and are
   *  rejected at construction. */
  readonly threshold?: number;
}

/** Build an in-memory promotion tracker. Pure factory; the returned
 *  object owns its own state via a closure-private `Map`. */
export const createPromotionTracker = (
  options: CreatePromotionTrackerOptions = {},
): PromotionTracker => {
  const hasThreshold = Object.prototype.hasOwnProperty.call(options, 'threshold');
  const threshold = hasThreshold
    ? options.threshold
    : DEFAULT_PROMOTION_THRESHOLD;

  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError(
      `createPromotionTracker: threshold must be a positive integer, got ${JSON.stringify(threshold)}`,
    );
  }

  const counts = new Map<string, number>();

  return {
    record(key: string): number {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    count(key: string): number {
      return counts.get(key) ?? 0;
    },
    shouldSuggest(key: string): boolean {
      return (counts.get(key) ?? 0) >= threshold;
    },
    reset(key: string): void {
      counts.delete(key);
    },
  };
};
