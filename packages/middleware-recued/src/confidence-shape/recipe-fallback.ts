/** D-137 P3 § A.5 Pattern 4 + § A.6 — Recipe fall-through resolver.
 *
 *  When a scope-search returns no results (Pattern 4), the agent has
 *  two clean exits per § A.5:
 *
 *    1. **Refuse cleanly** — "I don't see any X in your data. Did you
 *       mean someone else, or check elsewhere?"
 *    2. **Fall through to recipe execution** — if any installed
 *       recipe matches the intent, invoke it; the recipe pulls from
 *       a different surface (web search, draft generation, …) that
 *       the scope-search couldn't reach.
 *
 *  The decision between (1) and (2) is **deterministic per topic
 *  match against the installed Tier 2 catalog**:
 *
 *    - For each Tier 2 entry in the post-filter catalog, count how
 *      many `topic_tags` overlap with the request's intent
 *      `topic_tags` set.
 *    - The entry with the highest overlap wins.
 *    - Tied entries: prefer recently-installed (recipe install order
 *      is preserved in the registry; tied entries surface in
 *      registration order so the most-recently-installed sorts last
 *      — we pick the first for a deterministic registration-order
 *      tie-break).
 *    - Ties with overlap-zero collapse to "no fallback" (the agent
 *      refuses cleanly per option 1).
 *
 *  The substrate emits a **suggestion**, not an auto-invocation:
 *  the agent loop sees the suggested recipe in the result envelope and
 *  decides whether to call `recipe.run` (write-recipes still route
 *  through plan-approval per § A.11 — auto-invocation would bypass
 *  the gate). Mary's per-kind catalog scope (§ A.1.1) already gated
 *  the Tier 2 candidate list upstream; the fallback resolver inherits
 *  that filter for free.
 *
 *  Pure: no I/O, no clock, no shared state. Same `(catalog, intent_
 *  tags)` → same suggestion. */

import type { ToolEntry } from '@recued/contracts';

/** § A.5 Pattern 4 + § A.6 — recipe-fallback suggestion shape. The
 *  agent loop reads this off the scope-search result envelope and
 *  decides next-action (call `recipe.run` OR refuse cleanly). */
export interface RecipeFallbackSuggestion {
  /** `<publisher>/<slug>` identifier of the Tier 2 entry. */
  recipe_name: string;
  /** LLM-readable description (verbatim from the catalog entry).
   *  The agent loop surfaces this when proposing the fallback to Mary. */
  description: string;
  /** Number of intent `topic_tags` the recipe matched on. Surfaces
   *  in audit + telemetry; never user-facing. */
  topic_match_count: number;
  /** The matched topic tags themselves (intersection of intent ∩
   *  recipe). Audit-side; surfaces in transparency drawer's "why
   *  this recipe was suggested" copy. */
  matched_topics: ReadonlyArray<string>;
}

export interface FindRecipeFallbackOptions {
  /** Closed-list source of intent tags for the request. The resolver
   *  matches each Tier 2 entry's `topic_tags` against this set. */
  intent_tags: ReadonlySet<string>;
  /** Optional minimum overlap count. Default `1` — any single
   *  matching tag suffices. Production callers pass higher floors
   *  when the catalog grows and noise overwhelms signal. Tests pin
   *  for deterministic asserts. */
  min_overlap?: number;
}

/** § A.5 Pattern 4 + § A.6 — main resolver. Walks the Tier 2 entries
 *  in registration order; returns the highest-overlap suggestion, or
 *  `null` when no Tier 2 entry meets the `min_overlap` floor.
 *
 *  Tie-break: first entry by registration order wins — a
 *  deterministic registration-order rule. The resolver
 *  ignores Tier 1 + Tier 3 entries — Tier 1 is what produced the
 *  empty scope-search result (re-invoking won't help); Tier 3 is
 *  passthrough to external MCP and isn't an "installed recipe" in
 *  the spec's framing.
 *
 *  Pattern 4 acceptance test ("Empty-result-with-recipe-fallback")
 *  exercises this with `intent_tags = { 'digest', 'weekly' }` against
 *  a catalog containing `recued-core/weekly-digest`. */
export const findRecipeFallback = (
  catalog: ReadonlyArray<ToolEntry>,
  options: FindRecipeFallbackOptions,
): RecipeFallbackSuggestion | null => {
  const minOverlap = options.min_overlap ?? 1;
  if (minOverlap < 1) return null;
  if (options.intent_tags.size === 0) return null;

  let best: RecipeFallbackSuggestion | null = null;
  for (const entry of catalog) {
    if (entry.tier !== 2) continue;
    const matched: string[] = [];
    for (const tag of entry.topic_tags) {
      if (options.intent_tags.has(tag)) matched.push(tag);
    }
    if (matched.length < minOverlap) continue;
    if (best === null || matched.length > best.topic_match_count) {
      best = {
        recipe_name: entry.name,
        description: entry.description,
        topic_match_count: matched.length,
        matched_topics: matched,
      };
    }
  }
  return best;
};
