/** D-192 — the ID-keyed delta drain kernel (Kernel A), tested in ISOLATION.
 *
 *  The kernel is the shared spine for every ID-keyed delta file vendor (OneDrive,
 *  Google, Box next). Its fail-closed invariants — last-occurrence-wins,
 *  undrained-suppression, walk shaping — are exercised transitively through each
 *  leaf's suite, but they also live here, pinned against a TRIVIAL stub vendor, so
 *  the contract is protected independent of any one vendor and documents what a
 *  new vendor gets for free. A leaf supplies only `parsePage` / `classify` /
 *  `fetchPage`; everything asserted below is the kernel's, not a vendor's. */

import { describe, expect, it } from 'vitest';

import {
  drainIdKeyedDelta,
  shapeDeltaOutcome,
  shapeFullFromDeltaDrain,
  type Classify,
  type DeltaPage,
  type FetchDeltaPage,
  type IdKeyedDeltaDeps,
  type ParseDeltaPage,
} from '../file-source-adapters/id-keyed-delta.js';

// ── a trivial stub vendor ─────────────────────────────────────────
// An "item" carries its own classification; `classify` just reads it, so the
// tests drive the kernel's fold/drain/shape logic directly.
type StubItem =
  | { op: 'file'; id: string; name?: string }
  | { op: 'del'; id: string }
  | { op: 'del-noid' } // an id-less tombstone → skip (the full walk backstops it)
  | { op: 'unkeyed'; name: string } // a file with no usable id → kept, counted
  | { op: 'skip' };

const classify: Classify = (item) => {
  const i = item as StubItem;
  if (i.op === 'file') return { kind: 'file', id: i.id, row: { id: i.id, name: i.name ?? i.id } };
  if (i.op === 'del') return { kind: 'deleted', id: i.id };
  if (i.op === 'unkeyed') return { kind: 'unkeyed', row: { name: i.name } };
  return { kind: 'skip' }; // 'del-noid' + 'skip'
};

// The stub raw page IS a DeltaPage (real vendors validate + throw in parsePage;
// the kernel's job is the drain, so the stub passes through).
const parsePage: ParseDeltaPage = (raw) => raw as DeltaPage;

/** Script a fetch by ref → page; records the ref sequence. */
const scriptFetch = (pages: Record<string, DeltaPage>): { fetchPage: FetchDeltaPage; refs: string[] } => {
  const refs: string[] = [];
  const fetchPage: FetchDeltaPage = async (ref) => {
    refs.push(ref);
    const p = pages[ref];
    if (p === undefined) throw new Error(`no scripted page for ref '${ref}'`);
    return p;
  };
  return { fetchPage, refs };
};

const depsFor = (pages: Record<string, DeltaPage>): { deps: IdKeyedDeltaDeps; refs: string[] } => {
  const { fetchPage, refs } = scriptFetch(pages);
  return { deps: { fetchPage, parsePage, classify }, refs };
};

describe('drainIdKeyedDelta', () => {
  it('folds one page into upsert rows + ID-keyed removals; captures the terminal watermark', async () => {
    const { deps } = depsFor({
      START: { items: [{ op: 'file', id: 'a' }, { op: 'del', id: 'b' }, { op: 'skip' }], watermark: 'WM' },
    });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.rows.map((r) => r.id)).toEqual(['a']);
    expect(drain.removedKeys).toEqual(['b']);
    expect(drain.watermark).toBe('WM');
    expect(drain.drained).toBe(true);
  });

  it('follows nextRef to exhaustion, accumulating across pages, terminal watermark wins', async () => {
    const { deps, refs } = depsFor({
      START: { items: [{ op: 'file', id: 'a' }], nextRef: 'P2' },
      P2: { items: [{ op: 'file', id: 'b' }, { op: 'del', id: 'c' }], watermark: 'WM2' },
    });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(drain.removedKeys).toEqual(['c']);
    expect(drain.watermark).toBe('WM2');
    expect(refs).toEqual(['START', 'P2']); // followed nextRef, stopped at the terminal page
  });

  it('last-occurrence-wins: file then del (same page) → removed, not upserted', async () => {
    const { deps } = depsFor({ START: { items: [{ op: 'file', id: 'x' }, { op: 'del', id: 'x' }], watermark: 'W' } });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.rows.map((r) => r.id)).toEqual([]);
    expect(drain.removedKeys).toEqual(['x']);
  });

  it('last-occurrence-wins: del then file (same page) → upserted, not removed', async () => {
    const { deps } = depsFor({ START: { items: [{ op: 'del', id: 'y' }, { op: 'file', id: 'y' }], watermark: 'W' } });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.rows.map((r) => r.id)).toEqual(['y']);
    expect(drain.removedKeys).toEqual([]);
  });

  it('last-occurrence-wins holds ACROSS pages (file p1, del p2 → removed)', async () => {
    const { deps } = depsFor({
      START: { items: [{ op: 'file', id: 'z' }], nextRef: 'P2' },
      P2: { items: [{ op: 'del', id: 'z' }], watermark: 'W' },
    });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.rows.map((r) => r.id)).toEqual([]);
    expect(drain.removedKeys).toEqual(['z']);
  });

  it('keeps an unkeyed file (in rows, first) and skips an id-less tombstone', async () => {
    const { deps } = depsFor({
      START: { items: [{ op: 'unkeyed', name: 'orphan' }, { op: 'file', id: 'a' }, { op: 'del-noid' }], watermark: 'W' },
    });
    const drain = await drainIdKeyedDelta(deps, 'START');
    // unkeyed files lead (insertion order), then the byId map in order.
    expect(drain.rows).toEqual([{ name: 'orphan' }, { id: 'a', name: 'a' }]);
    expect(drain.removedKeys).toEqual([]); // the id-less tombstone contributed nothing
  });

  it('undrained: a terminal page with NO watermark ⇒ drained:false (fail-closed)', async () => {
    const { deps } = depsFor({ START: { items: [{ op: 'file', id: 'a' }, { op: 'del', id: 'b' }] /* no watermark */ } });
    const drain = await drainIdKeyedDelta(deps, 'START');
    expect(drain.drained).toBe(false);
    expect(drain.watermark).toBeUndefined();
    // rows/removedKeys are still computed — the shaper decides what to trust.
    expect(drain.rows.map((r) => r.id)).toEqual(['a']);
    expect(drain.removedKeys).toEqual(['b']);
  });
});

describe('shapeDeltaOutcome', () => {
  it('a DRAINED delta surfaces removed_keys + advances the cursor', () => {
    const out = shapeDeltaOutcome(
      { rows: [{ id: 'a' }], removedKeys: ['b'], watermark: 'WM', drained: true },
      null,
    );
    expect(out).toMatchObject({ ok: true, walk: 'delta', complete: false, removed_keys: ['b'], next_cursor: 'WM' });
    if (out.ok) expect(out.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('an UNDRAINED delta SUPPRESSES removed_keys + forces a full re-list (next_cursor null)', () => {
    const out = shapeDeltaOutcome(
      { rows: [{ id: 'a' }], removedKeys: ['b'], watermark: undefined, drained: false },
      null,
    );
    // The upsert we DID see still lands; the untrustworthy tombstone is dropped.
    expect(out).toMatchObject({ ok: true, walk: 'delta', removed_keys: [], next_cursor: null });
    if (out.ok) expect(out.rows.map((r) => r.id)).toEqual(['a']);
  });

  it('threads the scope through unchanged', () => {
    const scope = { glob: 'Team/**', prefix: 'Team/' };
    const out = shapeDeltaOutcome({ rows: [], removedKeys: [], watermark: 'W', drained: true }, scope);
    if (out.ok) expect(out.scope).toEqual(scope);
  });
});

describe('shapeFullFromDeltaDrain', () => {
  it('a DRAINED from-scratch drain ⇒ walk:full, complete:true, watermark as cursor, NO removed_keys', () => {
    const out = shapeFullFromDeltaDrain(
      { rows: [{ id: 'a' }, { id: 'b' }], removedKeys: ['ignored'], watermark: 'WM', drained: true },
      null,
    );
    expect(out).toMatchObject({ ok: true, walk: 'full', complete: true, next_cursor: 'WM' });
    // A full walk owns removals by ABSENCE — the drain's removedKeys are NOT surfaced.
    if (out.ok) expect(out.removed_keys).toBeUndefined();
    if (out.ok) expect(out.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('an UNDRAINED from-scratch drain ⇒ complete:false, next_cursor null (fail-closed)', () => {
    const out = shapeFullFromDeltaDrain(
      { rows: [{ id: 'a' }], removedKeys: [], watermark: undefined, drained: false },
      null,
    );
    expect(out).toMatchObject({ ok: true, walk: 'full', complete: false, next_cursor: null });
  });
});
