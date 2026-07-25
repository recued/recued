/** Discover — the installed-roster version resolver.
 *
 *  Once Discover pages from the server (`/catalog/search`) it no longer holds
 *  the whole corpus, so it can no longer reduce over it to answer two questions
 *  that are facts about the WHOLE catalogue, not one page:
 *
 *    1. "N updates available" — for each INSTALLED id, is a newer version
 *       published? (`discover-panel` reads `read()` for the badge.)
 *    2. Which BUNDLED packs are absent from the marketplace catalogue, so the
 *       pack surface can still show them (`pack-discovery`'s pinned rows). A
 *       published id is present in the map; an unpublished one is absent.
 *
 *  Both are answered by ONE bounded lookup — the installed/bundled id set is
 *  small and known — memoised by id-set so a broadcast-driven refresh that
 *  re-lists the same roster doesn't re-hit the network, and `force`-refreshable
 *  on a return visit because a NEW version can be published under the same ids.
 *
 *  A FAILED lookup keeps the last-known map rather than emptying it: an empty
 *  map reads as "nothing to update" / "every bundled pack is published", both
 *  of which are silent wrong answers. The badge / pinned rows simply hold their
 *  last-known state until the next successful resolve.
 */

import { fetchCatalogVersions, type CatalogKind } from './catalog-client.js';

export type FetchVersionsResult =
  | { status: 'ok'; versions: Map<string, number> }
  | { status: 'error'; message: string };

export interface UpdateVersionResolver {
  /** The last successfully resolved id → published-version map, or `null`
   *  before the first success. Synchronous — the panel reads it while
   *  rendering. */
  read(): ReadonlyMap<string, number> | null;
  /** Resolve versions for `ids`. Skips the network when the id-set is unchanged
   *  and a map already exists, unless `force`. Resolves after `onChange` (if
   *  the map changed) so the caller can re-render off `read()`. */
  resolve(ids: readonly string[], opts?: { force?: boolean }): Promise<void>;
  dispose(): void;
}

const keyOf = (ids: readonly string[]): string =>
  [...new Set(ids)].sort().join(' ');

export interface MakeUpdateVersionResolverOptions {
  kind: CatalogKind;
  /** Fired after a resolve that CHANGED the map — the surface re-renders here
   *  (the badge re-reads, the pinned set recomputes). */
  onChange: () => void;
  origin?: string;
  /** Injected fetcher (tests) — id set → id→version. Defaults to the real
   *  `/catalog/versions` for this resolver's `kind`. */
  fetchVersions?: (ids: readonly string[]) => Promise<FetchVersionsResult>;
}

export const makeUpdateVersionResolver = (
  options: MakeUpdateVersionResolverOptions,
): UpdateVersionResolver => {
  const fetchVersions = options.fetchVersions
    ?? ((ids: readonly string[]) =>
      fetchCatalogVersions(
        options.kind,
        ids,
        options.origin !== undefined ? { origin: options.origin } : {},
      ));
  let map: ReadonlyMap<string, number> | null = null;
  let lastKey: string | null = null;
  // Monotonic guard so a slow resolve can't overwrite a newer one's result
  // (last request wins, not last completion) — same discipline as the panel's
  // load guard.
  let generation = 0;
  let disposed = false;

  const resolve = async (
    ids: readonly string[],
    opts: { force?: boolean } = {},
  ): Promise<void> => {
    if (disposed) return;
    const key = keyOf(ids);
    if (!opts.force && key === lastKey && map !== null) return;
    lastKey = key;
    const gen = ++generation;
    const res = await fetchVersions(ids);
    if (disposed || gen !== generation) return;
    if (res.status !== 'ok') {
      // Keep the last-known map, but let a future call retry (a failed key must
      // not memoise as "done").
      lastKey = null;
      return;
    }
    map = res.versions;
    options.onChange();
  };

  return {
    read: () => map,
    resolve,
    dispose: () => {
      disposed = true;
    },
  };
};
