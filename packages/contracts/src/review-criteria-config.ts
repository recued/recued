/** Review criteria — declared on a recipe's `metadata`, owned by this module.
 *
 * 🔑🔑 A FEATURE-OWNED METADATA KEY, NOT A FIRST-CLASS SCHEMA CONCERN. § 9 answer 3 of
 * D-250 puts criteria ON THE RECIPE, and the reason is
 * versioning: they travel with the pinned version, so a criteria change IS a version change
 * — already visible per board row through `definition_version` — and reviews stay comparable
 * to the version they were made against. Putting them on the board would lose that.
 *
 * ⛔ BUT THAT DOES NOT JUSTIFY ALTERING THE RECIPE SCHEMA FOR EVERY PUBLISHER. Registry
 * boards are one feature; there are 2,311 recipes that will never declare a criterion. So
 * this follows the precedent `paid_document_direct_checkout` already set: the feature owns
 * its module, its shape and its validation, and `RecipeMetadata` carries ONE optional field.
 * ⚠ The validator has no "reject unknown keys" rule, so an absent declaration costs nothing
 * and no existing recipe needed to change.
 *
 * ⚠ THE BOUND IS A MIRROR, NOT THE AUTHORITY. A reviewer may return at most
 * `MAX_VERDICTS_PER_REVIEW` (40) verdicts, enforced cloud-side where the review is written;
 * declaring more criteria than can be voted on would produce a form that cannot be
 * submitted, so the same number is repeated here. If one moves, move both.
 */

/** The key this declaration occupies on `metadata`. */
export const REVIEW_CRITERIA_METADATA_KEY = 'review_criteria' as const;

/** Matches 039's `criterion_key` column check — the database is the real bound. */
export const REVIEW_CRITERION_KEY_MAX = 120;
export const REVIEW_CRITERIA_MAX = 40;

export interface ReviewCriterion {
  /** Stable across versions; this is what a verdict is recorded against.
   *  ⛔ RENAMING A KEY ORPHANS EVERY VERDICT THAT USED IT — old reviews keep the old key and
   *  no longer line up with the new one on the agreement axis. Change the LABEL freely; a
   *  key change is a new criterion. */
  key: string;
  /** What a reviewer reads. Keys make bad questions. */
  label: string;
  /** Optional expansion for a criterion whose label cannot carry it alone. */
  description?: string;
}

export interface ReviewCriteriaDeclaration {
  criteria: readonly ReviewCriterion[];
}

const isCriterion = (v: unknown): v is ReviewCriterion => {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.key !== 'string' || c.key.length === 0 || c.key.length > REVIEW_CRITERION_KEY_MAX) return false;
  if (typeof c.label !== 'string' || c.label.length === 0 || c.label.length > 200) return false;
  if (c.description !== undefined && (typeof c.description !== 'string' || c.description.length > 500)) return false;
  return true;
};

/** Read a declaration off a recipe's metadata.
 *
 * ⛔ RETURNS NULL RATHER THAN THROWING OR PARTIALLY ACCEPTING. This is read on a public,
 * CDN-cached page from a manifest a third party authored: a malformed declaration must
 * degrade to "this recipe declares none" — which the UI already handles — rather than take
 * the page down or render half a form whose verdicts cannot be submitted.
 *
 * ⛔ A DUPLICATE KEY REJECTS THE WHOLE DECLARATION. 039's primary key is
 * `(review_id, criterion_key)`, so two criteria sharing a key produce a form whose second
 * verdict silently replaces the first — the reviewer would believe they answered both.
 */
export const readReviewCriteria = (metadata: unknown): ReviewCriteriaDeclaration | null => {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const raw = (metadata as Record<string, unknown>)[REVIEW_CRITERIA_METADATA_KEY];
  if (raw === undefined || raw === null) return null;

  // Accept the declaration either as a bare array or wrapped — a bare list is the obvious
  // thing to write by hand, and refusing it would be pedantry with no safety behind it.
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).criteria)
        ? (raw as { criteria: unknown[] }).criteria
        : null);
  if (list === null || list.length === 0 || list.length > REVIEW_CRITERIA_MAX) return null;
  if (!list.every(isCriterion)) return null;

  const keys = new Set((list as ReviewCriterion[]).map((c) => c.key));
  if (keys.size !== list.length) return null;

  return { criteria: list as ReviewCriterion[] };
};
