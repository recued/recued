/** The server half of the paged-list convention (`list-pager.ts`).
 *
 *  🔑 Three properties, each of which a green-looking read could violate
 *  silently:
 *    1. The pages reassemble to exactly the list, in order. Nothing is skipped
 *       or repeated at a page boundary.
 *    2. No page exceeds the byte budget, the reason paging exists. The one
 *       exception is a single row that is larger than the budget, which ships
 *       alone.
 *    3. A cursor into a list that has since changed is refused, not answered
 *       from the new list at an offset that no longer means the same row. */

import { describe, expect, it } from 'vitest';
import { LIST_PAGE_DEFAULT_LIMIT, LIST_PAGE_MAX_LIMIT, RpcError } from '@recued/contracts';

import {
  createListPager,
  readListPageRequest,
  type ListPager,
} from '../list-pager.js';

interface Row { id: string; body: string }

const rowsOf = (n: number, bodyBytes = 10, prefix = 'r'): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, body: 'x'.repeat(bodyBytes) }));

const pagerFor = (options: { byteBudget?: number; memoTtlMs?: number; now?: () => number } = {}) =>
  createListPager<Row>({ method: 'test.list', identity: (row) => row.id, ...options });

/** Reads to the end, the way `collectListPages` does, returning every page. */
const readAll = (pager: ListPager<Row>, compute: () => Row[], limit: number) => {
  const pages = [];
  let page = pager.page({ limit }, compute);
  pages.push(page);
  while (page.next_cursor !== null) {
    page = pager.page({ limit, cursor: page.next_cursor }, compute);
    pages.push(page);
  }
  return pages;
};

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RpcError ? err.code : 'not-an-RpcError';
  }
};

describe('readListPageRequest', () => {
  it('reads "not paged" from anything without limit or cursor, as these handlers always did', () => {
    for (const args of [undefined, null, {}, [], 'x', 3, { other: 1 }]) {
      expect(readListPageRequest('test.list', args)).toBeNull();
    }
  });

  it('clamps limit to LIST_PAGE_MAX_LIMIT and defaults it when only a cursor is sent', () => {
    expect(readListPageRequest('test.list', { limit: 5 })).toEqual({ limit: 5 });
    expect(readListPageRequest('test.list', { limit: LIST_PAGE_MAX_LIMIT + 1 }))
      .toEqual({ limit: LIST_PAGE_MAX_LIMIT });
    expect(readListPageRequest('test.list', { cursor: 'p1.0123456789abcdef.4' }))
      .toEqual({ limit: LIST_PAGE_DEFAULT_LIMIT, cursor: 'p1.0123456789abcdef.4' });
  });

  it('refuses a malformed limit or a cursor it could not have issued', () => {
    for (const args of [
      { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '5' }, { limit: Number.NaN },
      { cursor: '' }, { cursor: 'garbage' }, { cursor: 7 }, { cursor: 'p1.XYZ.4' },
      { cursor: 'p2.0123456789abcdef.4' },
    ]) {
      expect(codeOf(() => readListPageRequest('test.list', args))).toBe('bad_request');
    }
  });
});

describe('createListPager', () => {
  it('reassembles the exact list, in order, across many limit and budget combinations', () => {
    const list = rowsOf(53, 40);
    for (const limit of [1, 2, 7, 52, 53, 54, 500]) {
      for (const byteBudget of [60, 200, 1_000, 1_000_000]) {
        const pages = readAll(pagerFor({ byteBudget }), () => list, limit);
        expect(pages.flatMap((p) => p.items)).toEqual(list);
        expect(pages.every((p) => p.total === list.length)).toBe(true);
        expect(pages.every((p) => p.items.length > 0 && p.items.length <= limit)).toBe(true);
      }
    }
  });

  it('⛔ keeps every page under the byte budget — the frame bound is the point', () => {
    const list = rowsOf(200, 300);
    const byteBudget = 4_096;
    const pages = readAll(pagerFor({ byteBudget }), () => list, LIST_PAGE_MAX_LIMIT);
    expect(pages.length).toBeGreaterThan(10);
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page.items), 'utf8')).toBeLessThanOrEqual(byteBudget);
    }
  });

  it('ships a single row larger than the budget alone, so the read always moves forward', () => {
    const list = [...rowsOf(2, 10), { id: 'big', body: 'y'.repeat(5_000) }, ...rowsOf(2, 10, 's')];
    const pages = readAll(pagerFor({ byteBudget: 1_000 }), () => list, 100);
    expect(pages.flatMap((p) => p.items)).toEqual(list);
    expect(pages.find((p) => p.items.some((row) => row.id === 'big'))?.items).toHaveLength(1);
  });

  it('answers a list that fits in one page with next_cursor null', () => {
    const list = rowsOf(3);
    expect(pagerFor().page({ limit: 10 }, () => list)).toEqual({
      items: list, next_cursor: null, total: 3,
    });
    expect(pagerFor().page({ limit: 10 }, () => [])).toEqual({
      items: [], next_cursor: null, total: 0,
    });
  });

  it('builds the list ONCE per read: later pages come from what page 1 computed', () => {
    const list = rowsOf(10);
    let computed = 0;
    const pages = readAll(pagerFor(), () => {
      computed += 1;
      return list;
    }, 3);
    expect(pages).toHaveLength(4);
    expect(computed).toBe(1);
  });

  it('⛔ never answers a FIRST page from the memo — an install must show on the next read', () => {
    const pager = pagerFor();
    let list = rowsOf(6);
    const first = pager.page({ limit: 2 }, () => list); // leaves a memo behind
    expect(first.next_cursor).not.toBeNull();
    list = rowsOf(7); // an install lands
    expect(pager.page({ limit: 10 }, () => list).total).toBe(7);
  });

  it('serves a continuation from the snapshot page 1 read, even after the live list moved', () => {
    const pager = pagerFor();
    const before = rowsOf(6);
    let live = before;
    const first = pager.page({ limit: 3 }, () => live);
    live = rowsOf(9, 10, 'n');
    const second = pager.page({ limit: 3, cursor: first.next_cursor! }, () => live);
    expect([...first.items, ...second.items]).toEqual(before);
    expect(second.next_cursor).toBeNull();
  });

  it('⛔ refuses with conflict when the memo is gone and the list changed underneath the cursor', () => {
    let t = 0;
    const pager = pagerFor({ memoTtlMs: 1_000, now: () => t });
    let live = rowsOf(6);
    const first = pager.page({ limit: 3 }, () => live);
    t = 5_000; // memo expired
    live = [{ id: 'inserted', body: 'z' }, ...live]; // every later row shifted by one
    expect(codeOf(() => pager.page({ limit: 3, cursor: first.next_cursor! }, () => live)))
      .toBe('conflict');
  });

  it('recomputes and carries on when the memo is gone but the list did not change', () => {
    let t = 0;
    const pager = pagerFor({ memoTtlMs: 1_000, now: () => t });
    const list = rowsOf(6);
    let computed = 0;
    const compute = () => {
      computed += 1;
      return list;
    };
    const first = pager.page({ limit: 3 }, compute);
    t = 5_000;
    const second = pager.page({ limit: 3, cursor: first.next_cursor! }, compute);
    expect([...first.items, ...second.items]).toEqual(list);
    expect(computed).toBe(2);
  });

  it('drops the memo once the last page is served', () => {
    const pager = pagerFor();
    const list = rowsOf(6);
    let computed = 0;
    const compute = () => {
      computed += 1;
      return list;
    };
    const first = pager.page({ limit: 3 }, compute);
    pager.page({ limit: 3, cursor: first.next_cursor! }, compute); // the last page
    expect(computed).toBe(1);
    // Replaying the continuation now has nothing to read from, so it builds
    // the list again (and, as nothing changed, still answers).
    pager.page({ limit: 3, cursor: first.next_cursor! }, compute);
    expect(computed).toBe(2);
  });

  it('refuses a cursor naming a different list with conflict', () => {
    const pager = pagerFor();
    const first = pagerFor().page({ limit: 2 }, () => rowsOf(6, 10, 'a'));
    expect(codeOf(() => pager.page({ limit: 2, cursor: first.next_cursor! }, () => rowsOf(6, 10, 'b'))))
      .toBe('conflict');
  });

  it('refuses an offset it could not have issued', () => {
    const pager = pagerFor();
    const list = rowsOf(6);
    const first = pager.page({ limit: 2 }, () => list);
    const [, fingerprint] = first.next_cursor!.split('.');
    for (const offset of [0, 6, 7, 999]) {
      expect(codeOf(() => pager.page({ limit: 2, cursor: `p1.${fingerprint}.${offset}` }, () => list)))
        .toBe('bad_request');
    }
  });
});
