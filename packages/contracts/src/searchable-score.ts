/** ONE MATCHING RULE FOR CAPABILITY SEARCH, two projections onto it.
 *
 *  ⛔⛔ WHY IT IS EXTRACTED RATHER THAN COPIED. The model reaches installed
 *  recipes through `tools.search` and the owner reaches them through the Data →
 *  Find surface. If those two disagree about what matches "invoice", the owner
 *  sees one set and the AI acts on another — a bug that is invisible from either
 *  side and maddening from the outside ("it found it when I asked the assistant
 *  but not when I searched"). A second scorer with the SAME WEIGHTS is not a
 *  shared rule; it is two rules that happen to agree until someone edits one.
 *
 *  ⚠ THE VISIBILITY SETS LEGITIMATELY DIFFER and this does not unify them.
 *  `tools.search` filters by kind-gating and per-op grants because it may be
 *  serving a CONTRACTED caller; the owner's own surface sees what the owner
 *  installed. Same ranking, different corpus — that distinction is deliberate,
 *  and folding it in here would put an authority decision inside a scorer. */

/** Two, so a stray "a"/"I" cannot pull in every record; long enough to be a
 *  word, short enough to keep "ai", "vm", "ok". */
const MIN_QUERY_TERM_LENGTH = 2;

export const tokenizeSearchQuery = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_QUERY_TERM_LENGTH);

/** What any searchable capability projects onto. */
export interface SearchableFields {
  name: string;
  description?: string;
  tags?: readonly string[];
}

/** ⚠ THE WEIGHTS ARE THE RULE — 3 / 2 / 1 for name / tag / description.
 *  A name hit is what the owner typed the thing's name for; a tag is curated
 *  and deliberate; a description mentions a word in passing. Substring rather
 *  than whole-word on purpose: "invoic" should reach "invoicing", and the
 *  precision cost is bounded because a capability catalog is tens-to-hundreds of
 *  entries, not a corpus. */
export const scoreSearchable = (
  fields: SearchableFields,
  terms: ReadonlyArray<string>,
): number => {
  const name = fields.name.toLowerCase();
  const description = (fields.description ?? '').toLowerCase();
  const tags = (fields.tags ?? []).map((tag) => tag.toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    if (tags.some((tag) => tag.includes(term))) score += 2;
    if (description.includes(term)) score += 1;
  }
  return score;
};

/** Rank any searchable set, highest first, name-ascending as the tiebreak so
 *  the order is stable across calls (an unstable order in a list the owner is
 *  reading looks like the results changing under them). */
export const rankSearchable = <T>(
  items: ReadonlyArray<T>,
  project: (item: T) => SearchableFields,
  query: string,
  limit: number,
): T[] => {
  const terms = tokenizeSearchQuery(query);
  if (terms.length === 0 || limit <= 0) return [];
  return items
    .map((item) => ({ item, fields: project(item) }))
    .map((c) => ({ ...c, score: scoreSearchable(c.fields, terms) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.fields.name.localeCompare(b.fields.name))
    .slice(0, limit)
    .map((c) => c.item);
};
