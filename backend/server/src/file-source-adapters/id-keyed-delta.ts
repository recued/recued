/** D-192 file SOURCE family — the ID-keyed delta drain kernel (Kernel A).
 *
 *  The shared spine for every file vendor whose delete tombstone carries the
 *  remote id DIRECTLY (so the runner deletes the mirror key through `removed_keys`,
 *  no path reverse-lookup): OneDrive (MS Graph `/delta`), Google Drive
 *  (`changes.list`), and Box (`/events`) next. Before this module each such leaf
 *  hand-rolled a byte-identical last-occurrence-wins accumulator + drain loop +
 *  undrained-suppression shaping; the ONLY thing that actually differs per vendor
 *  is (1) how a raw page maps to `{items, nextRef, watermark}`, (2) how a single
 *  item classifies (file / tombstone / folder / unkeyable), and (3) the
 *  authenticated fetch. So the kernel owns the mechanism + every fail-closed
 *  invariant ONCE, and a vendor supplies only those three closures.
 *
 *  Fail-closed guarantees the kernel owns (write once, test once):
 *   - LAST-OCCURRENCE-WINS: the same id may repeat across a drain (`file` then
 *     `deleted`, or the reverse); the final state wins, so every page folds into a
 *     per-id map BEFORE the upsert/removal split — a file that ends `deleted` can
 *     never ride in both `rows` and `removed_keys`.
 *   - UNDRAINED SUPPRESSION: a drain that ends WITHOUT a terminal watermark (a
 *     malformed / proxy-corrupted final page) has NOT seen the whole change set, so
 *     its tombstones are untrustworthy — `shapeDeltaOutcome` suppresses
 *     `removed_keys` + forces a full re-list (`next_cursor: null`) rather than
 *     replay a cursor it could not advance. (The vendor's `parsePage` MUST throw on
 *     a MALFORMED page so a missing items array never masquerades as a complete
 *     empty walk; the kernel's job is the undrained case, a well-formed page that
 *     simply lacked the terminal watermark.)
 *
 *  Not covered here: full walks that use a DIFFERENT endpoint from the delta
 *  (Google's `files.list`, Box's folder items) — that is the sibling paged-list
 *  primitive, not an id-keyed delta. OneDrive's full walk IS a from-scratch
 *  `/delta`, so it rides this kernel via `shapeFullFromDeltaDrain`.
 *
 *  Spec: D-192; taxonomy §0. */

import type { ImportScope } from '@recued/contracts';

import type { FileSourceListOutcome } from '../file-source-sync.js';
import { ProviderPaginationGuard } from '../provider-pagination-guard.js';

// ────────────────────────────────────────────────────────────────
// The three per-vendor closures
// ────────────────────────────────────────────────────────────────

/** The classification of a single raw item — the ONLY per-item decision the fold
 *  needs, and where a vendor's tombstone shape / folder rule / id location / path
 *  derivation all live:
 *   - `file`     — an upsert, keyed by `id` (the row is the projected/enriched
 *                  record the runner will store under `remote_id`).
 *   - `deleted`  — an ID-keyed tombstone (the runner deletes the mirror key `id`).
 *   - `unkeyed`  — a file carrying NO usable id: un-dedupable + unmatchable, kept
 *                  as-is so the runner counts it UNKEYABLE (fail-closed), never
 *                  silently dropped.
 *   - `skip`     — not a file (folder / drive-only change / an id-less tombstone
 *                  the full walk backstops). */
export type ItemClass =
  | { kind: 'file'; id: string; row: Record<string, unknown> }
  | { kind: 'deleted'; id: string }
  | { kind: 'unkeyed'; row: Record<string, unknown> }
  | { kind: 'skip' };

export type Classify = (item: unknown) => ItemClass;

/** One parsed delta page. `nextRef` and `watermark` are OPAQUE to the kernel —
 *  `nextRef` is handed straight back to `fetchPage` (a full URL for OneDrive's
 *  `@odata.nextLink`, a token for Drive's `nextPageToken`), and `watermark` is the
 *  next-cycle cursor, present ONLY on the terminal page (a well-formed final page;
 *  its absence ⇒ undrained ⇒ fail-closed). */
export interface DeltaPage {
  items: unknown[];
  nextRef?: string;
  watermark?: string;
}

/** Parse + STRICTLY validate one raw page into a `DeltaPage`. MUST throw on a
 *  malformed shape (a missing/mistyped items array) — coercing it to `[]` would
 *  let a `{}` body or a proxy-corrupted 200 masquerade as a complete empty walk,
 *  which the delete diff would act on. The kernel relies on this throw. */
export type ParseDeltaPage = (raw: unknown) => DeltaPage;

/** The vendor's authenticated fetch of one page. `ref` is the start ref (the
 *  from-scratch URL or the stored cursor) or a prior page's `nextRef`. Throws the
 *  vendor's typed HTTP error so the caller can split a reset (→ full fallback)
 *  from a real failure (→ classify). */
export type FetchDeltaPage = (ref: string) => Promise<unknown>;

export interface IdKeyedDeltaDeps {
  fetchPage: FetchDeltaPage;
  parsePage: ParseDeltaPage;
  classify: Classify;
}

// ────────────────────────────────────────────────────────────────
// The drain (kernel-owned)
// ────────────────────────────────────────────────────────────────

/** The per-id last-seen state accumulated across a whole drain. */
interface Accumulator {
  byId: Map<string, { kind: 'file'; row: Record<string, unknown> } | { kind: 'deleted' }>;
  unkeyedFiles: Record<string, unknown>[];
}

/** Fold one page's items into the accumulator (a `Map.set` overwrite = last-wins). */
const foldPage = (items: unknown[], classify: Classify, acc: Accumulator): void => {
  for (const item of items) {
    const c = classify(item);
    if (c.kind === 'file') acc.byId.set(c.id, { kind: 'file', row: c.row });
    else if (c.kind === 'deleted') acc.byId.set(c.id, { kind: 'deleted' });
    else if (c.kind === 'unkeyed') acc.unkeyedFiles.push(c.row);
    // 'skip' contributes nothing.
  }
};

/** Split the folded accumulator into upsert rows + ID-keyed removals — each id
 *  contributes to exactly ONE (its last-seen state). Insertion order (first
 *  occurrence) is preserved: unkeyed files first, then the `byId` map in order. */
const splitAccumulator = (
  acc: Accumulator,
): { rows: Record<string, unknown>[]; removedKeys: string[] } => {
  const rows: Record<string, unknown>[] = [...acc.unkeyedFiles];
  const removedKeys: string[] = [];
  for (const [id, state] of acc.byId) {
    if (state.kind === 'file') rows.push(state.row);
    else removedKeys.push(id);
  }
  return { rows, removedKeys };
};

export interface DeltaDrain {
  rows: Record<string, unknown>[];
  removedKeys: string[];
  /** The terminal watermark, or undefined when the drain ended without one (a
   *  malformed final page) — the undrained case. */
  watermark: string | undefined;
  /** True iff the drain reached a terminal watermark (walked the whole feed). */
  drained: boolean;
}

/** Drain an ID-keyed delta from `startRef` to its terminal watermark, following
 *  `nextRef` pages. Folds every page into the last-wins accumulator BEFORE
 *  splitting into upserts + removals. Propagates `fetchPage`/`parsePage` throws
 *  (HTTP errors, malformed pages) to the caller. */
/** Fail-safe against a NON-TERMINATING cursor (a vendor / proxy that returns a
 *  `nextRef` that never advances or self-references). Set FAR above any real
 *  drive (100k pages × ~100–1000 items/page = 10M–100M items), so it only fires
 *  on a stuck stream, never on a legitimately large walk — mirrors Notion's
 *  `MAX_PAGES` and Box's `BOX_MAX_EVENT_POLLS`, which the shared kernels lacked. */
const MAX_ID_KEYED_DELTA_PAGES = 100_000;

export const drainIdKeyedDelta = async (
  deps: IdKeyedDeltaDeps,
  startRef: string,
): Promise<DeltaDrain> => {
  const acc: Accumulator = { byId: new Map(), unkeyedFiles: [] };
  let ref = startRef;
  let watermark: string | undefined;
  let pages = 0;
  const pagination = new ProviderPaginationGuard('id-keyed delta', {
    maxPages: MAX_ID_KEYED_DELTA_PAGES,
  });
  for (;;) {
    if (pages >= MAX_ID_KEYED_DELTA_PAGES) {
      throw new Error(
        `id-keyed delta drain exceeded ${MAX_ID_KEYED_DELTA_PAGES} pages — non-terminating cursor?`,
      );
    }
    pages += 1;
    const page = deps.parsePage(await deps.fetchPage(pagination.claim(ref)));
    foldPage(page.items, deps.classify, acc);
    if (page.nextRef !== undefined) {
      ref = page.nextRef;
      continue;
    }
    watermark = page.watermark;
    break;
  }
  const { rows, removedKeys } = splitAccumulator(acc);
  return { rows, removedKeys, watermark, drained: watermark !== undefined };
};

// ────────────────────────────────────────────────────────────────
// The shapers (kernel-owned — the fail-closed invariants, written once)
// ────────────────────────────────────────────────────────────────

/** Shape a delta drain into a `walk: 'delta'` outcome. An UNDRAINED drain
 *  (terminal page carried no watermark) has untrustworthy tombstones: SUPPRESS
 *  `removed_keys` + force a full re-list (`next_cursor: null`) rather than replay a
 *  cursor we couldn't advance. `complete: false` — a delta is never
 *  delete-authoritative by ABSENCE; its explicit `removed_keys` are honored
 *  independently of `complete`. */
export const shapeDeltaOutcome = (
  drain: DeltaDrain,
  scope: ImportScope | null,
): FileSourceListOutcome => ({
  ok: true,
  walk: 'delta',
  rows: drain.rows,
  removed_keys: drain.drained ? drain.removedKeys : [],
  next_cursor: drain.drained ? (drain.watermark ?? null) : null,
  scope,
  complete: false,
});

/** Shape a FROM-SCRATCH delta drain into a `walk: 'full'` outcome — for a vendor
 *  (OneDrive) whose full walk IS the delta mechanism run from scratch, so the
 *  drain's present-set is the delete authority. OMITS `removed_keys` (a full walk
 *  owns removals by ABSENCE); `complete` iff the drain reached its terminal
 *  watermark (the whole feed was walked); that watermark rides back as
 *  `next_cursor` (absent ⇒ null → full re-list next cycle). */
export const shapeFullFromDeltaDrain = (
  drain: DeltaDrain,
  scope: ImportScope | null,
): FileSourceListOutcome => ({
  ok: true,
  walk: 'full',
  rows: drain.rows,
  complete: drain.drained,
  next_cursor: drain.watermark ?? null,
  scope,
});
