/** Discover — pure list/search/filter/sort/paging model tests. */

import { describe, expect, it } from 'vitest';

import {
  byDateDesc,
  byNumberDesc,
  byStringAsc,
  EMPTY_QUERY,
  runDiscover,
  type DiscoverQuery,
  type DiscoverSpec,
} from '../discover/discover-model.js';

interface Row {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  kind: string;
  downloads: number;
  created: string;
}

const row = (over: Partial<Row>): Row => ({
  slug: 's',
  name: 'n',
  description: '',
  tags: [],
  kind: 'a',
  downloads: 0,
  created: '2026-01-01',
  ...over,
});

const spec: DiscoverSpec<Row> = {
  searchableText: (r) => `${r.name} ${r.description} ${r.tags.join(' ')}`,
  facets: [
    { key: 'kind', values: (r) => [r.kind] },
    { key: 'tag', values: (r) => r.tags },
  ],
  sorters: {
    downloads: byNumberDesc((r) => r.downloads, (r) => r.slug),
    name: byStringAsc((r) => r.name),
    newest: byDateDesc((r) => r.created, (r) => r.slug),
  },
};

const q = (over: Partial<DiscoverQuery>): DiscoverQuery => ({ ...EMPTY_QUERY, ...over });

const corpus: Row[] = [
  row({ slug: 'a', name: 'Deal Risk', tags: ['sales', 'crm'], kind: 'entity', downloads: 100, created: '2026-03-01' }),
  row({ slug: 'b', name: 'Email Digest', description: 'inbox sales', tags: ['mail'], kind: 'channel', downloads: 50, created: '2026-05-01' }),
  row({ slug: 'c', name: 'Invoice Sync', tags: ['crm', 'finance'], kind: 'entity', downloads: 200, created: '2026-01-15' }),
  row({ slug: 'd', name: 'Standup Notes', tags: ['mail'], kind: 'workflow', downloads: 10, created: '2026-06-01' }),
];

describe('search', () => {
  it('empty search matches all', () => {
    expect(runDiscover(corpus, spec, q({})).total).toBe(4);
  });
  it('is case-insensitive substring over name/description/tags', () => {
    expect(runDiscover(corpus, spec, q({ search: 'DEAL' })).matched.map((r) => r.slug)).toEqual(['a']);
    // "sales" appears as a tag on `a` and in the description of `b`.
    expect(runDiscover(corpus, spec, q({ search: 'sales' })).matched.map((r) => r.slug).sort()).toEqual(['a', 'b']);
  });
  it('AND-combines whitespace-separated terms', () => {
    expect(runDiscover(corpus, spec, q({ search: 'invoice crm' })).matched.map((r) => r.slug)).toEqual(['c']);
    expect(runDiscover(corpus, spec, q({ search: 'invoice mail' })).total).toBe(0);
  });
});

describe('filter', () => {
  it('OR within a facet', () => {
    const res = runDiscover(corpus, spec, q({ filters: { kind: ['entity', 'workflow'] } }));
    expect(res.matched.map((r) => r.slug).sort()).toEqual(['a', 'c', 'd']);
  });
  it('AND across facets', () => {
    const res = runDiscover(corpus, spec, q({ filters: { kind: ['entity'], tag: ['crm'] } }));
    expect(res.matched.map((r) => r.slug).sort()).toEqual(['a', 'c']);
  });
  it('combines with search', () => {
    const res = runDiscover(corpus, spec, q({ search: 'sales', filters: { kind: ['channel'] } }));
    expect(res.matched.map((r) => r.slug)).toEqual(['b']);
  });
  it('an empty selection array is a pass-through', () => {
    expect(runDiscover(corpus, spec, q({ filters: { kind: [] } })).total).toBe(4);
  });
});

describe('facet counts (drop-one-out)', () => {
  it('counts each value over search + OTHER active facets, ignoring the facet\'s own selection', () => {
    // Select kind=entity. The `kind` facet's OWN counts should ignore that
    // selection (so `channel`/`workflow` still show their reach), while the
    // `tag` facet's counts reflect the kind=entity narrowing.
    const res = runDiscover(corpus, spec, q({ filters: { kind: ['entity'] } }));
    const kind = Object.fromEntries(res.facets.kind.map((f) => [f.value, f.count]));
    expect(kind).toEqual({ entity: 2, channel: 1, workflow: 1 });
    const tag = Object.fromEntries(res.facets.tag.map((f) => [f.value, f.count]));
    // Only entity rows (a: sales,crm | c: crm,finance) contribute.
    expect(tag).toEqual({ crm: 2, sales: 1, finance: 1 });
  });
  it('sorts facet values by count desc then value asc', () => {
    const res = runDiscover(corpus, spec, q({}));
    expect(res.facets.tag.map((f) => f.value)).toEqual(['crm', 'mail', 'finance', 'sales']);
  });
  it('counts a duplicate facet value on one row ONCE (per-row dedup)', () => {
    const dirty = [row({ slug: 'z', tags: ['sales', 'sales', 'sales'] })];
    const res = runDiscover(dirty, spec, q({}));
    const sales = res.facets.tag.find((f) => f.value === 'sales');
    expect(sales?.count).toBe(1); // one MATCHING ROW, not 3 occurrences
  });
});

describe('sort', () => {
  it('defaults to the first sorter (downloads desc) when sort is empty/unknown', () => {
    expect(runDiscover(corpus, spec, q({})).pageRows.map((r) => r.slug)).toEqual(['c', 'a', 'b', 'd']);
    expect(runDiscover(corpus, spec, q({ sort: 'nope' })).pageRows.map((r) => r.slug)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('name asc', () => {
    expect(runDiscover(corpus, spec, q({ sort: 'name' })).pageRows.map((r) => r.name)).toEqual([
      'Deal Risk', 'Email Digest', 'Invoice Sync', 'Standup Notes',
    ]);
  });
  it('newest first', () => {
    expect(runDiscover(corpus, spec, q({ sort: 'newest' })).pageRows.map((r) => r.slug)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('paging', () => {
  it('slices to perPage and reports totalPages', () => {
    const res = runDiscover(corpus, spec, q({ perPage: 2, page: 1 }));
    expect(res.pageRows.map((r) => r.slug)).toEqual(['c', 'a']);
    expect(res.totalPages).toBe(2);
    expect(res.total).toBe(4);
  });
  it('clamps an over-range page down to the last page', () => {
    const res = runDiscover(corpus, spec, q({ perPage: 2, page: 99 }));
    expect(res.page).toBe(2);
    expect(res.pageRows.map((r) => r.slug)).toEqual(['b', 'd']);
  });
  it('clamps page up to 1 and floors a bad perPage to 1', () => {
    const res = runDiscover(corpus, spec, q({ page: 0, perPage: 0 }));
    expect(res.page).toBe(1);
    expect(res.pageRows).toHaveLength(1);
    expect(res.totalPages).toBe(4);
  });
  it('empty corpus yields one empty page', () => {
    const res = runDiscover([], spec, q({}));
    expect(res.total).toBe(0);
    expect(res.totalPages).toBe(1);
    expect(res.pageRows).toEqual([]);
  });
});

describe('comparators', () => {
  it('byNumberDesc breaks ties by the string key', () => {
    const cmp = byNumberDesc<Row>((r) => r.downloads, (r) => r.slug);
    const rows = [row({ slug: 'z', downloads: 5 }), row({ slug: 'a', downloads: 5 })].sort(cmp);
    expect(rows.map((r) => r.slug)).toEqual(['a', 'z']);
  });
  it('byDateDesc newest first', () => {
    const cmp = byDateDesc<Row>((r) => r.created, (r) => r.slug);
    const rows = [row({ slug: 'old', created: '2020-01-01' }), row({ slug: 'new', created: '2026-01-01' })].sort(cmp);
    expect(rows.map((r) => r.slug)).toEqual(['new', 'old']);
  });
});
