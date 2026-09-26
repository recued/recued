/** The client half of the paged-list convention (`rpc/list-page.ts`).
 *
 *  🔑 The property under test is that `collectListPages` returns the WHOLE list
 *  or throws. Every case below is a way a read could come back short or doubled
 *  and still look finished: a server that did not page, a server swapped
 *  mid-read, a list that changed between pages, a count that does not add up,
 *  a server that never reaches the end. */

import { describe, expect, it } from 'vitest';

import {
  collectListPages,
  LIST_PAGE_DEFAULT_LIMIT,
  RpcError,
  type ListPage,
  type ListPageRequest,
} from '../rpc/index.js';

const rows = (n: number, prefix = 'r'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** A server that pages `list` by `size`. Cursors are `c<offset>`. Records every
 *  request it is sent. */
const pagedServer = (list: string[], size: number) => {
  const requests: ListPageRequest[] = [];
  const fetchPage = async (request: ListPageRequest): Promise<ListPage<string>> => {
    requests.push(request);
    const offset = request.cursor === undefined ? 0 : Number(request.cursor.slice(1));
    const end = Math.min(offset + size, list.length);
    return {
      items: list.slice(offset, end),
      next_cursor: end >= list.length ? null : `c${end}`,
      total: list.length,
    };
  };
  return { fetchPage, requests };
};

describe('collectListPages', () => {
  it('reads every page in order, asking with a limit and resuming from each cursor', async () => {
    const list = rows(7);
    const server = pagedServer(list, 3);
    await expect(collectListPages({ fetchPage: server.fetchPage, limit: 3 })).resolves.toEqual(list);
    expect(server.requests).toEqual([
      { limit: 3 },
      { cursor: 'c3', limit: 3 },
      { cursor: 'c6', limit: 3 },
    ]);
  });

  it('asks for LIST_PAGE_DEFAULT_LIMIT when the caller names none', async () => {
    const server = pagedServer(rows(2), 5);
    await collectListPages({ fetchPage: server.fetchPage });
    expect(server.requests).toEqual([{ limit: LIST_PAGE_DEFAULT_LIMIT }]);
  });

  it('takes an answer without next_cursor as the whole list — what an older server sends', async () => {
    // The older handler ignored its arguments: the `limit` went unread and the
    // whole list came back with no paging fields at all.
    const list = rows(5);
    const requests: ListPageRequest[] = [];
    const result = await collectListPages<string>({
      fetchPage: async (request) => {
        requests.push(request);
        return { items: list };
      },
    });
    expect(result).toEqual(list);
    expect(requests).toHaveLength(1);
  });

  it('⛔ a whole-list answer on a CONTINUATION replaces what was collected, never appends to it', async () => {
    // The server behind the connection changed mid-read (an older one answered
    // page 2). Appending would hand back page 1 followed by the whole list,
    // with page 1's rows twice.
    const whole = rows(6, 'w');
    let calls = 0;
    const result = await collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        return calls === 1
          ? { items: ['w0', 'w1'], next_cursor: 'c2', total: 6 }
          : { items: whole };
      },
    });
    expect(result).toEqual(whole);
  });

  it('restarts from the first page when a continuation is refused with conflict', async () => {
    const before = rows(4, 'old');
    const after = rows(5, 'new');
    let list = before;
    const requests: ListPageRequest[] = [];
    const result = await collectListPages<string>({
      limit: 2,
      fetchPage: async (request) => {
        requests.push(request);
        if (request.cursor !== undefined && list === before) {
          list = after; // an install landed between the pages
          throw new RpcError('conflict', 'the list changed', 409);
        }
        const offset = request.cursor === undefined ? 0 : Number(request.cursor.slice(1));
        const end = Math.min(offset + 2, list.length);
        return {
          items: list.slice(offset, end),
          next_cursor: end >= list.length ? null : `c${end}`,
          total: list.length,
        };
      },
    });
    // Only the new list — none of the old first page survives the restart.
    expect(result).toEqual(after);
    expect(requests[0]).toEqual({ limit: 2 });
    expect(requests[2]).toEqual({ limit: 2 });
  });

  it('restarts on a duck-typed { code: "conflict" } too — an RpcError from another module copy', async () => {
    let refused = false;
    const server = pagedServer(rows(4), 2);
    const result = await collectListPages<string>({
      fetchPage: async (request) => {
        if (request.cursor !== undefined && !refused) {
          refused = true;
          throw Object.assign(new Error('stale'), { code: 'conflict' });
        }
        return server.fetchPage(request);
      },
    });
    expect(result).toEqual(rows(4));
  });

  it('gives up after maxRestarts and rethrows the conflict', async () => {
    let calls = 0;
    const conflict = new RpcError('conflict', 'the list changed', 409);
    await expect(collectListPages<string>({
      maxRestarts: 1,
      fetchPage: async (request) => {
        calls += 1;
        if (request.cursor !== undefined) throw conflict;
        return { items: ['a'], next_cursor: 'c1', total: 2 };
      },
    })).rejects.toBe(conflict);
    // first page, refused continuation, first page again, refused again.
    expect(calls).toBe(4);
  });

  it('does not retry a conflict on the FIRST page — that is some other failure', async () => {
    let calls = 0;
    const conflict = new RpcError('conflict', 'busy', 409);
    await expect(collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        throw conflict;
      },
    })).rejects.toBe(conflict);
    expect(calls).toBe(1);
  });

  it('does not restart on any other error', async () => {
    let calls = 0;
    const failure = new RpcError('internal', 'boom', 500);
    await expect(collectListPages<string>({
      fetchPage: async (request) => {
        calls += 1;
        if (request.cursor !== undefined) throw failure;
        return { items: ['a'], next_cursor: 'c1', total: 2 };
      },
    })).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  it('⛔ throws when the pages do not add up to total, rather than returning a short list', async () => {
    let calls = 0;
    await expect(collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        return calls === 1
          ? { items: ['a', 'b'], next_cursor: 'c2', total: 5 }
          : { items: ['c'], next_cursor: null, total: 5 };
      },
    })).rejects.toThrow('3 of 5');
  });

  it('throws when total changes between pages of one read', async () => {
    let calls = 0;
    await expect(collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        return calls === 1
          ? { items: ['a'], next_cursor: 'c1', total: 2 }
          : { items: ['b'], next_cursor: null, total: 3 };
      },
    })).rejects.toThrow('changed size');
  });

  it('throws on a page that moves the read nowhere — no rows, yet more to come', async () => {
    await expect(collectListPages<string>({
      fetchPage: async (request) => (request.cursor === undefined
        ? { items: ['a'], next_cursor: 'c1', total: 3 }
        : { items: [], next_cursor: 'c2', total: 3 }),
    })).rejects.toThrow('same page');
  });

  it('throws on a cursor it has already followed, instead of looping forever', async () => {
    let calls = 0;
    await expect(collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        return { items: [`r${calls}`], next_cursor: 'c-stuck', total: 100 };
      },
    })).rejects.toThrow('same page');
    expect(calls).toBe(2);
  });

  it('accepts a paged answer that leaves total out', async () => {
    let calls = 0;
    const result = await collectListPages<string>({
      fetchPage: async () => {
        calls += 1;
        return calls === 1
          ? { items: ['a'], next_cursor: 'c1' }
          : { items: ['b'], next_cursor: null };
      },
    });
    expect(result).toEqual(['a', 'b']);
  });
});
