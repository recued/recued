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
 *  word, short enough to keep "ai", "vm", "ok".
 *
 *  ⛔⛔ TWO IS NOT ENOUGH ON ITS OWN, AND THE COMMENT ABOVE MISSED IT BY ONE
 *  CHARACTER. It stops "a" and "I"; it does not stop "or" — and because matching
 *  is SUBSTRING, "or" reaches rep**or**t, rec**or**d, st**or**age, vend**or**,
 *  categ**or**y. Measured against the 2,285-recipe corpus: the single term "or"
 *  scores > 0 on **84%** of it, "for" on 43%. Whole real queries, scored as this
 *  rule actually scores them:
 *    'list buildings or properties'   → 2,041 entries (89%)
 *    'invoice lookup or digest'       → 1,973 entries (86%)
 *    'how does pack install work'     → 2,101 entries (92%)
 *  while their MEANINGFUL terms are precise — `buildings` hits 1, `properties`
 *  5, `invoice` 65. One connective buried every real match under ~1,900
 *  non-matches. Census over 1,281 captured `tools.search` results: p50 3,666
 *  chars but p90 **69,961** and max **554,231**, with 16.3% over 50k. */
const MIN_QUERY_TERM_LENGTH = 2;

export const tokenizeSearchQuery = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_QUERY_TERM_LENGTH);

/** A term matching MORE than this SHARE of the searched set does not
 *  DISCRIMINATE in it, so scoring on it says nothing — it just drags the whole
 *  corpus into the result.
 *
 *  🔑 THE SAME PRIMITIVE `chat-index-context.ts` USES, AND FOR THE SAME REASON:
 *  *"that is the job the word list used to do badly and this does per-owner"*.
 *  There, `enron` matches 45% of an Enron employee's mail (dropped) and 0.6% of
 *  a consultant's who has Enron as one client (kept) — same word, opposite and
 *  CORRECT verdicts, with no list to maintain.
 *
 *  ⛔ IT SUBSUMES BOTH HAND-MAINTAINED FIXES THIS REPLACES. Measured on the
 *  2,285-recipe corpus: `or` 84%, `pack` 86%, `for` 43%, `work` 31% — all
 *  dropped; `list` 14%, `records` 8%, `invoice` 3%, `install` 0.1% — all kept.
 *  `or` needed a stopword list before; `pack` needed a tag-namespace special
 *  case (it is 86% only because `pack:<slug>` is a NAMESPACE on 1,954 recipes,
 *  matched as a substring). Frequency catches both, adapts per install, and
 *  needs no English — which the stopword list could never be.
 *
 *  ⛔⛔ THE FLOOR IS ON THE MATCH COUNT, NOT ON THE SET SIZE, and getting that
 *  backwards is the trap. A floor on SET SIZE ("leave sets under 50 alone")
 *  makes the filter INERT exactly where a fresh install lives: simulated across
 *  sizes, a 20-recipe catalog returned 20 of 20 on a polluted query while a
 *  60-recipe one returned 1 of 60 — a cliff, not a ramp, and small pools got no
 *  protection at all. A floor on MATCH COUNT keeps small pools filtered while
 *  refusing to call a genuinely narrow term "common": `email` matching 2 of a
 *  5-entry catalog is 40% but is obviously discriminating, and share-only
 *  dropped it (caught by `lever-2-search-tool-catalog.test.ts`).
 *
 *  ⛔ AND A SURVIVING TERM MUST ACTUALLY MATCH SOMETHING. Otherwise a term
 *  matching NOTHING (df 0) passes the cap, outlives every real term, and the
 *  search returns ZERO — which is how a 2-entry catalog broke
 *  `tools-search-non-latin-query.test.ts`. Under `lean-core`, `tools.search` is
 *  the ONLY route to a recipe, so an empty result is not a degraded ranking, it
 *  is an unreachable capability. */
const NON_DISCRIMINATING_SHARE = 0.25;
/** A term matching this few entries is discriminating at ANY corpus size. */
const ALWAYS_DISCRIMINATING_MATCHES = 2;

/** ⛔⛔ THE FILTER ONLY RUNS WHEN THERE IS SOMETHING TO FIX, and this is the
 *  real small-pool safeguard — the two floors above are not enough on their own.
 *
 *  A SHARE IS A NOISY ESTIMATE AT SMALL N. A term matching 3 of 10 crosses 25%
 *  by accident of a tiny denominator; the same term matching 3 of 1,000 is
 *  obviously narrow. So on a small catalog a keyword that is central PRECISELY
 *  BECAUSE the owner installed a focused pack — "invoice" on an
 *  invoicing-only install — ranks as "too common" and is discarded, which is
 *  the opposite of what the owner meant.
 *
 *  🔑 The filter exists to stop a query dragging in 2,000 entries, not to
 *  improve one that already returns eight. If the unfiltered result is already
 *  a usable size, there is no blow-up to prevent and nothing is worth the risk
 *  of dropping a good term — so it is returned untouched. A 20-recipe catalog
 *  can never exceed this, and is therefore never filtered at all.
 *
 *  ⚠ Measured on 1,281 real `tools.search` results: p50 is 5 matches, p90 is
 *  82, max 675. This sits above the median by a wide margin and well under p90,
 *  so ordinary queries never reach the filter and the blow-ups always do. */
const FILTER_ONLY_ABOVE_MATCHES = 20;

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
  const all = tokenizeSearchQuery(query);
  if (all.length === 0 || limit <= 0) return [];
  const projected = items.map((item) => ({ item, fields: project(item) }));
  // Drop terms that match most of the set — see `NON_DISCRIMINATING_SHARE`.
  // ⛔ THE FALLBACK IS LOAD-BEARING: if EVERY term is non-discriminating the
  // query keeps them all rather than returning nothing. This is a precision
  // fix, and it may never turn a result set that existed into an empty one —
  // a bad ranking is recoverable, a missing answer is not.
  const scoreAll = (fields: SearchableFields) => scoreSearchable(fields, all);
  const unfiltered = projected.filter((c) => scoreAll(c.fields) > 0).length;
  const terms = unfiltered <= FILTER_ONLY_ABOVE_MATCHES
    ? all
    : (() => {
      const cap = Math.max(
        ALWAYS_DISCRIMINATING_MATCHES,
        projected.length * NON_DISCRIMINATING_SHARE,
      );
      const df = new Map<string, number>(
        all.map((term) => [
          term,
          projected.filter((c) => scoreSearchable(c.fields, [term]) > 0).length,
        ]),
      );
      const discriminating = all.filter((term) => (df.get(term) ?? 0) <= cap);
      // A survivor set that matches nothing is worse than no filtering at all.
      return discriminating.some((term) => (df.get(term) ?? 0) > 0)
        ? discriminating
        : all;
    })();
  return projected
    .map((c) => ({ ...c, score: scoreSearchable(c.fields, terms) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.fields.name.localeCompare(b.fields.name))
    .slice(0, limit)
    .map((c) => c.item);
};
