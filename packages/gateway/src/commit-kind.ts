/** D-145 engine-wiring slice 3b.2 — commit-kind derivation.
 *
 *  `deriveCommitKind` projects an ingredient's `IngredientCategory`
 *  onto the observable `CommitKind` the Gateway stamps on every commit
 *  (D-153 § Commit substrate). The discriminator lets
 *  audit consumers split the action / query streams without
 *  re-deriving from the ingredient slug.
 *
 *  Mapping:
 *    - `action` ingredient → `'action'` — an outbound side-effect.
 *    - `data`   ingredient → `'query'`  — an inbound read.
 *    - `ai`     ingredient → `'query'`  — an inference call: it crosses
 *      the boundary to ask a question and reads an answer back; no
 *      external state mutates, so it belongs in the query stream, not
 *      the action stream (`ai` ingredients are `risk_tier: 'read'` by
 *      construction — see `KIND_ALLOWED_TIERS.ai`).
 *    - unknown / unresolved category → `'action'` — conservative: an
 *      uncategorised call surfaces in the did-something stream rather
 *      than hiding in the read stream. The commit `kind` is
 *      observability metadata, not a security gate.
 *
 *  `'cognition_output'` is deliberately unreachable here: that kind is
 *  emitted only when a pluggable cognition component produces a
 *  composition / plan artifact — never when the recipe engine invokes
 *  a plain ingredient. The cognition dispatch path stamps it directly.
 *
 *  Spec: D-153 § Commit substrate (atomic).
 */

import type { CommitKind, IngredientCategory } from '@recued/contracts';

/** Derive the observable `CommitKind` from an ingredient's category.
 *  Total over `IngredientCategory`; `undefined` (unknown / unresolved
 *  slug) falls back to `'action'`. */
export const deriveCommitKind = (
  category: IngredientCategory | undefined,
): CommitKind => {
  switch (category) {
    case 'action':
      return 'action';
    case 'data':
      return 'query';
    case 'ai':
      return 'query';
    default:
      return 'action';
  }
};
