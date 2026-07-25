/** D-192 — the paged-list drain primitive (the sibling of the ID-keyed delta
 *  kernel), tested in ISOLATION.
 *
 *  The primitive is the shared plain-pagination spine for every file vendor whose
 *  full (or path-keyed delta) walk is a fetch → parse → accumulate →
 *  follow-continuation loop: S3 `ListObjectsV2`, Google `files.list`, Dropbox
 *  `list_folder`(/continue), Box folder items. Its fail-closed invariants —
 *  malformed-pagination detection (absent OR empty `nextRef`), sticky out-of-band
 *  incompleteness, terminal-watermark capture, throw propagation — are exercised
 *  transitively through each leaf's suite, but they also live here, pinned against
 *  a TRIVIAL stub vendor, so the contract is protected independent of any one
 *  vendor. A leaf supplies only `parsePage` / `fetchPage`; everything asserted
 *  below is the primitive's. */

import { describe, expect, it } from 'vitest';

import {
  drainPagedList,
  type FetchPagedListPage,
  type PagedListDeps,
  type PagedListPage,
  type ParsePagedListPage,
} from '../file-source-adapters/paged-list.js';

// The stub raw page IS a PagedListPage (real vendors validate + throw in
// parsePage; the primitive's job is the drain, so the stub passes through).
const parsePage: ParsePagedListPage = (raw) => raw as PagedListPage;

/** Script a fetch by ref → page; records the ref sequence so a test can prove the
 *  drain followed exactly the refs it should (and never re-fetched via a sentinel). */
const scriptFetch = (
  pages: Record<string, PagedListPage>,
): { fetchPage: FetchPagedListPage; refs: string[] } => {
  const refs: string[] = [];
  const fetchPage: FetchPagedListPage = async (ref) => {
    refs.push(ref);
    const p = pages[ref];
    if (p === undefined) throw new Error(`no scripted page for ref '${ref}'`);
    return p;
  };
  return { fetchPage, refs };
};

const depsFor = (
  pages: Record<string, PagedListPage>,
): { deps: PagedListDeps; refs: string[] } => {
  const { fetchPage, refs } = scriptFetch(pages);
  return { deps: { fetchPage, parsePage }, refs };
};

describe('drainPagedList', () => {
  it('a single terminal page (hasMore:false) ⇒ complete, entries collected', async () => {
    const { deps, refs } = depsFor({ START: { entries: ['a', 'b'], hasMore: false } });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.entries).toEqual(['a', 'b']);
    expect(drain.complete).toBe(true);
    expect(drain.watermark).toBeUndefined();
    expect(refs).toEqual(['START']);
  });

  it('follows nextRef to exhaustion, accumulating entries in walk order', async () => {
    const { deps, refs } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: 'P2' },
      P2: { entries: ['b', 'c'], hasMore: true, nextRef: 'P3' },
      P3: { entries: ['d'], hasMore: false },
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.entries).toEqual(['a', 'b', 'c', 'd']);
    expect(drain.complete).toBe(true);
    expect(refs).toEqual(['START', 'P2', 'P3']); // followed each nextRef, stopped at the terminal
  });

  it('an empty terminal page ⇒ complete, no entries (a legitimately empty walk)', async () => {
    const { deps } = depsFor({ START: { entries: [], hasMore: false } });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.entries).toEqual([]);
    expect(drain.complete).toBe(true);
  });

  it('threads startRef as the first fetch ref (a stored delta cursor, not the sentinel)', async () => {
    const { deps, refs } = depsFor({ CURSOR_X: { entries: [], hasMore: false } });
    await drainPagedList(deps, 'CURSOR_X');
    expect(refs).toEqual(['CURSOR_X']);
  });

  // ── the malformed-pagination guard (the load-bearing fail-closed invariant) ──

  it('MALFORMED: hasMore:true with NO nextRef ⇒ complete:false, stops (fail-closed)', async () => {
    const { deps, refs } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: 'P2' },
      P2: { entries: ['b'], hasMore: true /* no nextRef */ },
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.complete).toBe(false);
    expect(drain.entries).toEqual(['a', 'b']); // the entries we DID see are still returned
    expect(drain.watermark).toBeUndefined(); // never captured from a malformed page
    expect(refs).toEqual(['START', 'P2']); // stopped — did not spin
  });

  it('MALFORMED: hasMore:true with an EMPTY-string nextRef ⇒ complete:false, does NOT re-fetch via the sentinel', async () => {
    // An empty `nextRef` collides with the `''` from-scratch sentinel — following
    // it would silently re-fetch page one forever. The primitive rejects it as
    // malformed (a leaf's parsePage is contracted to normalize empty → undefined,
    // but the primitive enforces the guard so no adopter can trip the collision).
    const { deps, refs } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: '' },
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.complete).toBe(false);
    expect(drain.entries).toEqual(['a']);
    expect(drain.watermark).toBeUndefined();
    expect(refs).toEqual(['START']); // did NOT follow '' back into a page-one re-fetch
  });

  it('a malformed drain never captures a watermark (even if the malformed page carries one)', async () => {
    const { deps } = depsFor({
      START: { entries: ['a'], hasMore: true, watermark: 'WM_LEAK' /* no nextRef */ },
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.complete).toBe(false);
    expect(drain.watermark).toBeUndefined();
  });

  // ── sticky out-of-band incompleteness (Google `incompleteSearch`) ──

  it('STICKY incomplete: incomplete:true on a MID-walk page sinks complete even with a clean terminal', async () => {
    const { deps } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: 'P2', incomplete: true },
      P2: { entries: ['b'], hasMore: false }, // a clean terminal page
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.complete).toBe(false); // the mid-walk incomplete flag stuck
    expect(drain.entries).toEqual(['a', 'b']); // upserts we saw are still returned
  });

  it('incomplete:true on the terminal page also sinks complete', async () => {
    const { deps } = depsFor({ START: { entries: ['a'], hasMore: false, incomplete: true } });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.complete).toBe(false);
  });

  // ── terminal-watermark capture (Dropbox's cursor) ──

  it('captures the TERMINAL page watermark; intermediate watermarks are ignored', async () => {
    const { deps } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: 'P2', watermark: 'WM_INTERMEDIATE' },
      P2: { entries: ['b'], hasMore: false, watermark: 'WM_TERMINAL' },
    });
    const drain = await drainPagedList(deps, 'START');
    expect(drain.watermark).toBe('WM_TERMINAL');
    expect(drain.complete).toBe(true);
  });

  // ── throw propagation (a malformed page must NEVER be swallowed to []) ──

  it('PROPAGATES a parsePage throw (fail-closed: a malformed shape is never swallowed to [])', async () => {
    const fetchPage: FetchPagedListPage = async () => ({ garbage: true });
    const throwingParse: ParsePagedListPage = () => {
      throw new Error('malformed page');
    };
    await expect(drainPagedList({ fetchPage, parsePage: throwingParse }, 'START')).rejects.toThrow(
      'malformed page',
    );
  });

  it('PROPAGATES a fetchPage throw (an HTTP error surfaces to the caller, uncaught)', async () => {
    const fetchPage: FetchPagedListPage = async () => {
      throw new Error('HTTP 500');
    };
    await expect(drainPagedList({ fetchPage, parsePage }, 'START')).rejects.toThrow('HTTP 500');
  });

  it('a throw on a LATER page propagates (no partial "complete" from the pages already seen)', async () => {
    const { deps } = depsFor({
      START: { entries: ['a'], hasMore: true, nextRef: 'BOOM' },
      // 'BOOM' is not scripted → scriptFetch throws when the drain follows it
    });
    await expect(drainPagedList(deps, 'START')).rejects.toThrow(/no scripted page/);
  });
});
