/** D-192 file SOURCE family — the paged-list drain primitive (the sibling of the
 *  ID-keyed delta kernel, `id-keyed-delta.ts`).
 *
 *  Where the ID-keyed kernel folds every page into a last-occurrence-wins byId
 *  accumulator + splits removals (for vendors whose tombstones carry the remote
 *  id), THIS primitive is the plain paginated walk: fetch a page, accumulate its
 *  raw entries verbatim, follow the continuation ref to exhaustion. The leaf
 *  classifies / projects the accumulated entries AFTER the drain — a full walk's
 *  file rows (S3, Google `files.list`, Dropbox `list_folder`, Box folder items),
 *  or a path-keyed delta's file rows + `deleted` tombstones (Dropbox
 *  `list_folder/continue`). It owns NO per-item decision, so it takes no
 *  `classify` closure — only `fetchPage` + `parsePage`.
 *
 *  Before this module each such leaf hand-rolled a byte-identical
 *  fetch → parse → accumulate → follow-continuation loop with the SAME two
 *  fail-closed guards; the primitive owns the mechanism + both guards ONCE, and a
 *  vendor supplies only how a raw page maps to `{ entries, hasMore, nextRef }`
 *  (+ optional `incomplete` / `watermark`) and the authenticated fetch.
 *
 *  Fail-closed guarantees the primitive owns (write once, test once) — a leaf's
 *  `complete` is the runner's D-190 absence-delete gate, so a walk that cannot
 *  prove exhaustion MUST report `complete: false`:
 *   - MALFORMED PAGINATION: a page that reports MORE results (`hasMore: true`) yet
 *     carries no USABLE `nextRef` to fetch them — absent, OR the empty string that
 *     collides with the `''` start sentinel (a proxy-corrupted / truncated
 *     response) — has NOT seen the whole set → the drain stops + sinks `complete`,
 *     never replays a ref it doesn't have (and never re-fetches page one via the
 *     sentinel). `hasMore` is kept SEPARATE from `nextRef` precisely so this case
 *     is detectable (an absent `nextRef` alone can't tell a legitimate end from a
 *     broken page).
 *   - OUT-OF-BAND INCOMPLETENESS: a source may signal a partial result even when
 *     pagination looks fine (Google Drive's `incompleteSearch` — the query could
 *     not fully execute). `incomplete: true` on ANY page sinks `complete`
 *     STICKILY, independent of the terminal page.
 *
 *  Like the ID-keyed kernel, the drain PROPAGATES `fetchPage` / `parsePage`
 *  throws (HTTP errors, malformed shapes) to the caller — it never catches, and
 *  never swallows a malformed page to `[]` (that would masquerade as a complete
 *  empty walk + false-delete every mirrored file). Each leaf's `parsePage` MUST
 *  throw on a malformed shape (a missing / mistyped items array); the primitive's
 *  job is the SEMANTIC incompleteness above (a well-formed page that could not
 *  prove exhaustion). Same contract as `drainIdKeyedDelta`.
 *
 *  Spec: D-192; taxonomy §0. */

// ────────────────────────────────────────────────────────────────
// The two per-vendor closures + the parsed-page shape
// ────────────────────────────────────────────────────────────────

/** One parsed page of a paged list — the ONLY per-vendor mapping the drain needs. */
export interface PagedListPage {
  /** This page's raw items, accumulated verbatim (the leaf classifies / projects
   *  them after the drain — the primitive owns no per-item decision). */
  entries: unknown[];
  /** Does the source report MORE results beyond this page? (S3 `IsTruncated`,
   *  Dropbox `has_more`, Box `next_marker` present, Google `nextPageToken`
   *  present.) Kept SEPARATE from {@link nextRef} so the drain can catch a page
   *  that claims more yet gives no continuation — the malformed-pagination guard. */
  hasMore: boolean;
  /** The opaque ref to fetch the next page — handed straight back to `fetchPage`
   *  (a continuation token / cursor / marker). Present + NON-EMPTY iff the source
   *  gave a continuation; `hasMore: true` with an absent OR empty-string `nextRef`
   *  is the malformed case (⇒ the drain fails closed). An empty string is rejected
   *  because it collides with the `''` from-scratch start sentinel. */
  nextRef?: string;
  /** An OUT-OF-BAND completeness sink, orthogonal to pagination — Google Drive's
   *  `incompleteSearch` (the query could not fully execute even though the page
   *  paginated cleanly). STICKY: any page setting it sinks the whole drain's
   *  `complete`. Default (absent) ⇒ this page did not signal incompleteness. */
  incomplete?: boolean;
  /** An opaque continuation token to persist as the NEXT cycle's cursor (Dropbox's
   *  `list_folder` cursor, which doubles as the delta watermark). Captured from the
   *  legitimate TERMINAL page only — never from an intermediate or malformed page.
   *  Most vendors omit it: S3 re-lists in full (cursor null), Google / Box mint the
   *  next-cycle watermark OFF-band (a start-page token / stream position captured
   *  before the walk), so their paged drain carries none. OPAQUE to the drain. */
  watermark?: string;
}

/** Parse + STRICTLY validate one raw page into a {@link PagedListPage}. MUST throw
 *  on a malformed shape (a missing / mistyped items array) — coercing it to an
 *  empty page would let a `{}` body or a proxy-corrupted 200 masquerade as a
 *  complete empty walk, which the delete diff would act on. The drain relies on
 *  this throw (it owns only the SEMANTIC incompleteness — see the module header). */
export type ParsePagedListPage = (raw: unknown) => PagedListPage;

/** The vendor's authenticated fetch of one page. `ref` is the start ref (a stored
 *  cursor, or the empty-string sentinel for a token-less first page — see
 *  {@link drainPagedList}) or a prior page's `nextRef`. Throws the vendor's typed
 *  HTTP error so the caller can split a reset (→ full fallback) from a real
 *  failure (→ classify). */
export type FetchPagedListPage = (ref: string) => Promise<unknown>;

export interface PagedListDeps {
  fetchPage: FetchPagedListPage;
  parsePage: ParsePagedListPage;
}

// ────────────────────────────────────────────────────────────────
// The drain (primitive-owned)
// ────────────────────────────────────────────────────────────────

export interface PagedListDrain {
  /** Every page's entries, in walk order (the leaf classifies / projects them). */
  entries: unknown[];
  /** True iff the walk reached a LEGITIMATE terminal page (`hasMore: false`) with
   *  no page reporting `incomplete` and no malformed (`hasMore` without `nextRef`)
   *  page — the POSITIVE exhaustion proof the runner's absence-delete diff gates
   *  on. `false` fails that diff closed. */
  complete: boolean;
  /** The legitimate terminal page's {@link PagedListPage.watermark}, or undefined
   *  when that page carried none OR the drain ended malformed (never captured from
   *  a malformed / intermediate page). */
  watermark: string | undefined;
}

/** Drain a paged list from `startRef`, following each page's `nextRef` to
 *  exhaustion + accumulating every page's `entries`.
 *
 *  `startRef` is the vendor's from-scratch start ref: a stored cursor (a
 *  path-keyed delta continue), or the empty-string sentinel `''` for a first page
 *  that takes NO continuation token (an S3 `ListObjectsV2` without a token, a Box
 *  `/folders/{id}/items` without a marker, a Dropbox `list_folder` from a path) —
 *  which the leaf's `fetchPage` maps to a token-less call. A real `nextRef` is
 *  always a non-empty string (a leaf's `parsePage` normalizes an empty token to
 *  `undefined`), so `''` is an unambiguous "start" sentinel.
 *
 *  Completeness is the drain's core fail-closed job (see the module header):
 *   - `hasMore: false` is a LEGITIMATE terminal (the source says no more) → the
 *     drain stays `complete` (unless an earlier page sank it), and captures the
 *     terminal page's `watermark`;
 *   - `hasMore: true` with NO `nextRef` claims more yet can't continue — a
 *     malformed / corrupted page → `complete: false`, stop, no watermark;
 *   - `incomplete: true` on any page sinks `complete` STICKILY (Google's
 *     `incompleteSearch`), even mid-walk.
 *
 *  PROPAGATES `fetchPage` / `parsePage` throws to the caller — never catches,
 *  never swallows a malformed page to `[]`. Same contract as `drainIdKeyedDelta`. */
/** Fail-safe against a NON-TERMINATING cursor — see `drainIdKeyedDelta`'s
 *  `MAX_ID_KEYED_DELTA_PAGES`. (The `hasMore` guard below already stops on a page
 *  that claims more with no usable `nextRef`; this bounds the OTHER shape — a
 *  vendor / proxy that keeps returning a fresh-but-non-advancing `nextRef`.) */
const MAX_PAGED_LIST_PAGES = 100_000;

export const drainPagedList = async (
  deps: PagedListDeps,
  startRef: string,
): Promise<PagedListDrain> => {
  const entries: unknown[] = [];
  let ref = startRef;
  let complete = true;
  let watermark: string | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= MAX_PAGED_LIST_PAGES) {
      throw new Error(
        `paged-list drain exceeded ${MAX_PAGED_LIST_PAGES} pages — non-terminating cursor?`,
      );
    }
    pages += 1;
    const page = deps.parsePage(await deps.fetchPage(ref));
    for (const entry of page.entries) entries.push(entry);
    // Sticky out-of-band incompleteness (Google `incompleteSearch`) — any page.
    if (page.incomplete === true) complete = false;
    if (page.hasMore) {
      // Claims more but gives no USABLE continuation — malformed. An empty-string
      // `nextRef` is rejected alongside an absent one: it is indistinguishable from
      // the `''` from-scratch sentinel a token-less first page uses, so following
      // it would silently re-fetch page one forever (masking incompleteness). A
      // leaf's `parsePage` is contracted to normalize an empty token to `undefined`,
      // but the primitive enforces it HERE so no adopter — present or future — can
      // trip the sentinel collision.
      if (page.nextRef === undefined || page.nextRef === '') {
        // Fail closed: the walk did NOT see the whole set, so it is not
        // delete-authoritative. Do NOT capture a watermark from a malformed page
        // (leave it undefined ⇒ the leaf forces a full re-list next cycle rather
        // than persist a stale ref).
        complete = false;
        break;
      }
      ref = page.nextRef;
      continue;
    }
    // A legitimate terminal — the source reports no more results. Its watermark
    // (if any) is the next cycle's cursor.
    watermark = page.watermark;
    break;
  }
  return { entries, complete, watermark };
};
