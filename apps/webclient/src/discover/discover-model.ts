/** Discover — pure list / search / filter / sort / paging model.
 *
 *  The engine behind both Discovery surfaces (`#packs` + `#recipes`). Given the
 *  full downloaded catalog corpus (hundreds of rows) it computes one page of
 *  results entirely client-side — no per-keystroke round-trip. Kept generic over
 *  the row type + free of DOM so it's exhaustively unit-testable; each surface
 *  supplies a `DiscoverSpec<Row>` describing how to read searchable text, facet
 *  values, and sort orders off its own row shape.
 *
 *  Filter semantics: OR within a facet (any selected value matches), AND across
 *  facets (every active facet must match) — the standard faceted-browse model.
 *  Facet counts are computed drop-one-out (a facet's own selection is ignored
 *  when counting its alternatives) so selecting a value never zeroes its
 *  siblings, avoiding filter dead-ends.
 */

export interface DiscoverQuery {
  /** Free text; whitespace-split into AND'd case-insensitive substring terms. */
  search: string;
  /** facetKey → selected values. OR within the array, AND across keys. */
  filters: Record<string, readonly string[]>;
  /** Key into `spec.sorters`. Unknown / empty → the spec's first sorter. */
  sort: string;
  /** 1-based; clamped into range by the engine. */
  page: number;
  /** Page size (≥ 1). */
  perPage: number;
}

export const EMPTY_QUERY: DiscoverQuery = {
  search: '',
  filters: {},
  sort: '',
  page: 1,
  perPage: 24,
};

export interface FacetDef<Row> {
  key: string;
  /** The facet values this row carries (multi-valued rows — e.g. tags — are
   *  fine). Return `[]` for a row that has none of this facet. */
  values: (row: Row) => readonly string[];
}

export interface DiscoverSpec<Row> {
  /** Concatenated searchable text for a row (name + description + tags + …). */
  searchableText: (row: Row) => string;
  facets: readonly FacetDef<Row>[];
  /** Named comparators. Object insertion order matters — the first entry is the
   *  default when `query.sort` is empty/unknown. */
  sorters: Readonly<Record<string, (a: Row, b: Row) => number>>;
}

export interface FacetValueCount {
  value: string;
  count: number;
}

export interface DiscoverResult<Row> {
  /** The rows on the current (clamped) page, sorted. */
  pageRows: Row[];
  /** Every row matching search + filters, sorted (pre-paging). */
  matched: Row[];
  /** `matched.length`. */
  total: number;
  /** Total number of pages (≥ 1 even when empty). */
  totalPages: number;
  /** The clamped 1-based page actually shown. */
  page: number;
  /** Per-facet available values + drop-one-out counts, sorted by count desc
   *  then value asc — ready to render as filter chips. */
  facets: Record<string, FacetValueCount[]>;
}

const searchTerms = (search: string): string[] =>
  search
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

const matchesSearch = <Row>(row: Row, spec: DiscoverSpec<Row>, terms: string[]): boolean => {
  if (terms.length === 0) return true;
  const hay = spec.searchableText(row).toLowerCase();
  return terms.every((t) => hay.includes(t));
};

/** Does the row satisfy the active selections for one facet? (OR within.) An
 *  empty / absent selection for a facet is a pass-through. */
const matchesFacet = <Row>(
  row: Row,
  facet: FacetDef<Row>,
  selected: readonly string[] | undefined,
): boolean => {
  if (selected === undefined || selected.length === 0) return true;
  const have = facet.values(row);
  return have.some((v) => selected.includes(v));
};

/** Row passes when it matches every facet EXCEPT the one named in `except`
 *  (used for drop-one-out facet counting). `except === null` applies all. */
const matchesFacets = <Row>(
  row: Row,
  spec: DiscoverSpec<Row>,
  filters: DiscoverQuery['filters'],
  except: string | null,
): boolean =>
  spec.facets.every((f) =>
    f.key === except ? true : matchesFacet(row, f, filters[f.key]),
  );

const resolveSorter = <Row>(
  spec: DiscoverSpec<Row>,
  sort: string,
): ((a: Row, b: Row) => number) => {
  const keys = Object.keys(spec.sorters);
  if (keys.length === 0) return () => 0;
  const chosen = spec.sorters[sort] ?? spec.sorters[keys[0]];
  return chosen;
};

/** Run one Discover query over the corpus. Pure — same inputs, same output. */
export const runDiscover = <Row>(
  rows: readonly Row[],
  spec: DiscoverSpec<Row>,
  query: DiscoverQuery,
): DiscoverResult<Row> => {
  const terms = searchTerms(query.search);
  const searchMatched = rows.filter((r) => matchesSearch(r, spec, terms));

  // Facet counts: over search + all OTHER active facets (drop-one-out), so a
  // facet always shows the reach of each of its own alternatives.
  const facets: Record<string, FacetValueCount[]> = {};
  for (const facet of spec.facets) {
    const pool = searchMatched.filter((r) => matchesFacets(r, spec, query.filters, facet.key));
    const counts = new Map<string, number>();
    for (const r of pool) {
      // Count MATCHING ROWS, not value occurrences — dedupe per row so a dirty
      // row (e.g. tags:['sales','sales']) bumps the chip by 1, matching how
      // `matchesFacet`'s `.some` actually filters.
      for (const v of new Set(facet.values(r))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    facets[facet.key] = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value));
  }

  // Full match set = search + every active facet.
  const matched = searchMatched
    .filter((r) => matchesFacets(r, spec, query.filters, null))
    .slice()
    .sort(resolveSorter(spec, query.sort));

  const perPage = Math.max(1, Math.floor(query.perPage) || 1);
  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.floor(query.page) || 1), totalPages);
  const start = (page - 1) * perPage;
  const pageRows = matched.slice(start, start + perPage);

  return { pageRows, matched, total, totalPages, page, facets };
};

// ────────────────────────────────────────────────────────────────
// Common comparators — small builders the specs compose.
// ────────────────────────────────────────────────────────────────

/** Numeric field, descending, with a string tiebreak for stability. */
export const byNumberDesc = <Row>(
  num: (r: Row) => number,
  tiebreak: (r: Row) => string,
): ((a: Row, b: Row) => number) => (a, b) =>
  (num(b) - num(a)) || tiebreak(a).localeCompare(tiebreak(b));

/** String field, ascending (locale-aware). */
export const byStringAsc = <Row>(
  key: (r: Row) => string,
): ((a: Row, b: Row) => number) => (a, b) => key(a).localeCompare(key(b));

/** ISO-date-ish string field, descending (newest first), string tiebreak. */
export const byDateDesc = <Row>(
  date: (r: Row) => string,
  tiebreak: (r: Row) => string,
): ((a: Row, b: Row) => number) => (a, b) =>
  date(b).localeCompare(date(a)) || tiebreak(a).localeCompare(tiebreak(b));
