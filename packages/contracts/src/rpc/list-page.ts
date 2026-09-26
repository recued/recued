/** Paged list rpcs — the wire convention and the client half of it.
 *
 *  ⛔ WHY THESE LISTS PAGE. `chat.inbound_token.tool_catalog` and `recipe.list`
 *  answer with one row per installed thing, so their frame grows with every
 *  install and nothing bounds it. The socket is capped
 *  (`WS_JSON_MAX_BUFFERED_BYTES`, 16 MiB of buffered output), and what hits the
 *  cap is the QUEUE rather than any one frame: a 12.73 MB catalog was dropped
 *  because it landed on a 10.26 MB `recipe.list` still draining beneath it.
 *  Neither was over the cap alone. A page has a size bound, so the queue under
 *  it does too. See internal design notes.
 *
 *  🔑 PAGING IS OPT-IN, AND AN OLDER PEER ON EITHER END STAYS CORRECT.
 *  - A request carrying `limit` or `cursor` asks for pages. A request with
 *    neither gets the whole list exactly as before, so an older webclient keeps
 *    working against a newer server.
 *  - A paged answer ALWAYS carries `next_cursor` (`null` on the last page) and
 *    `total`. An answer without `next_cursor` is a whole list. That is what an
 *    older server sends, since its handler ignores the arguments, and
 *    {@link collectListPages} takes it as complete.
 *
 *  ⚠ This is not the "field an old server ignores" trap. That trap is an
 *  ignored field that changes what the call DOES, like a provider selector that
 *  an older server skips and runs the default instead. Here an ignored `limit`
 *  still gives a correct and complete answer, and the client can see it was
 *  ignored because `next_cursor` is missing. It never has to assume paging
 *  happened.
 *
 *  The cursor is opaque. A server may refuse one with `conflict` when the list
 *  changed underneath it (an install landed between two pages), and the client
 *  starts again from the first page rather than stitching two different lists
 *  together. */

import { RpcError } from './types.js';

/** What a client sends to ask for one page. */
export interface ListPageRequest {
  /** The previous page's `next_cursor`, verbatim. Omit it for the first page. */
  cursor?: string;
  /** The most rows this page may hold. The server may clamp it, and it also
   *  keeps each page under a byte budget, so a page can be shorter than this
   *  and still not be the last one. Only `next_cursor: null` means the end. */
  limit?: number;
}

/** The fields a paged answer adds beside its rows. Both are absent on a
 *  whole-list answer and both are present on every page. */
export interface ListPageFields {
  /** Pass this back to get the next page. `null` on the last page. ABSENT
   *  means the answer was not paged: it is the whole list. */
  next_cursor?: string | null;
  /** How many rows the whole list holds. Every page of one read carries the
   *  same number, and the pages together must add up to it. */
  total?: number;
}

/** The page size clients ask for. Servers clamp to
 *  {@link LIST_PAGE_MAX_LIMIT}, and the byte budget usually ends a page
 *  first. */
export const LIST_PAGE_DEFAULT_LIMIT = 2000;

/** The most rows a server puts on one page, whatever `limit` asks for. */
export const LIST_PAGE_MAX_LIMIT = 5000;

/** One fetched page, taken off whatever key that rpc keeps its rows under. */
export interface ListPage<T> {
  items: ReadonlyArray<T>;
  next_cursor?: string | null;
  total?: number;
}

export interface CollectListPagesOptions<T> {
  /** Calls the rpc with this request and returns its rows and paging fields. */
  fetchPage: (request: ListPageRequest) => Promise<ListPage<T>>;
  /** Defaults to {@link LIST_PAGE_DEFAULT_LIMIT}. */
  limit?: number;
  /** How many times a `conflict` may restart the read from the first page.
   *  Defaults to 2. */
  maxRestarts?: number;
}

const errorCode = (err: unknown): string | null => {
  if (err instanceof RpcError) return err.code;
  // Duck-typed: an RpcError that crossed a module boundary, or a transport's
  // hand-shaped `{ code }`.
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
};

/** Reads a paged list to the end and returns every row, in order.
 *
 *  ⛔ IT NEVER RETURNS PART OF A LIST. A missing page, a page repeated, or a
 *  count that does not add up throws instead. A surface that shows a
 *  shortened list as if it were the whole one fails silently, and a silent
 *  failure is what this convention exists to remove. */
export const collectListPages = async <T>(
  options: CollectListPagesOptions<T>,
): Promise<T[]> => {
  const limit = options.limit ?? LIST_PAGE_DEFAULT_LIMIT;
  const maxRestarts = options.maxRestarts ?? 2;
  let restarts = 0;
  let rows: T[] = [];
  let request: ListPageRequest = { limit };
  let total: number | undefined;
  const seen = new Set<string>();
  for (;;) {
    let page: ListPage<T>;
    try {
      page = await options.fetchPage(request);
    } catch (err) {
      // Only a continuation can go stale. A first page that says `conflict`
      // is some other failure, and restarting would just repeat it.
      if (
        request.cursor !== undefined
        && errorCode(err) === 'conflict'
        && restarts < maxRestarts
      ) {
        restarts += 1;
        rows = [];
        total = undefined;
        seen.clear();
        request = { limit };
        continue;
      }
      throw err;
    }
    if (page.next_cursor === undefined) {
      // A whole list, from a server that did not page. It replaces anything
      // collected so far: if the server behind the connection changed
      // mid-read, these rows and the earlier ones come from different lists.
      return [...page.items];
    }
    if (page.total !== undefined) {
      if (total !== undefined && page.total !== total) {
        throw new Error('The list changed size partway through loading. Try again.');
      }
      total = page.total;
    }
    rows.push(...page.items);
    if (page.next_cursor === null) {
      if (total !== undefined && rows.length !== total) {
        throw new Error(
          `The server sent ${rows.length} of ${total} items, so the list is incomplete. Try again.`,
        );
      }
      return rows;
    }
    // Guards against a server that never finishes: every page must move the
    // read forward, both in rows and in where it resumes.
    if (page.items.length === 0 || seen.has(page.next_cursor)) {
      throw new Error('The server kept sending the same page, so the list could not finish loading.');
    }
    seen.add(page.next_cursor);
    request = { cursor: page.next_cursor, limit };
  }
};
