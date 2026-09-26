/** The server half of the paged-list convention in `@recued/contracts`
 *  (`rpc/list-page.ts`): turn one freshly computed list into pages that each
 *  stay under a byte budget.
 *
 *  🔑 A CURSOR NAMES A POSITION IN ONE PARTICULAR LIST. It carries the offset
 *  and a fingerprint of the list's ORDER — every row's identity, in sequence.
 *  If an install lands between two pages the list shifts, and an offset into
 *  the new list would skip rows or repeat them. So a continuation whose
 *  fingerprint no longer matches is refused with `conflict`, and the client
 *  starts again (`collectListPages` does that on its own).
 *
 *  🔑 PAGE 1 IS ALWAYS COMPUTED FRESH; THE REST ARE READ FROM IT. The lists this
 *  serves are expensive to build (the tool catalog walks every installed pack's
 *  operations), and recomputing per page would multiply that by the page count.
 *  So the list page 1 built is held as a memo, and a continuation with the same
 *  fingerprint reads from it. A memo is never used to answer a FIRST page:
 *  installs have to show up on the next read, which is what a caller that just
 *  installed something is about to do.
 *
 *  ⚠ The memo holds ONE list per pager, the latest one, and is dropped once its
 *  last page is served. A read abandoned partway leaves it held until the next
 *  first page replaces it or it expires. If a continuation misses it (expired,
 *  replaced by a different list, or dropped when another client finished), the
 *  list is recomputed and the fingerprint decides. */

import { createHash } from 'node:crypto';
import {
  LIST_PAGE_DEFAULT_LIMIT,
  LIST_PAGE_MAX_LIMIT,
  RpcError,
  type ListPageRequest,
} from '@recued/contracts';

/** The most bytes one page's rows may serialize to, before the envelope. A
 *  page always holds at least one row, so a single row larger than this still
 *  ships, alone. 1 MiB is 1/16 of the socket's buffer cap, so even several
 *  paged reads in flight at once leave the queue far below it. */
const LIST_PAGE_BYTE_BUDGET = 1024 * 1024;

const MEMO_TTL_MS = 60_000;
const CURSOR_VERSION = 'p1';
const CURSOR_PATTERN = /^p1\.([0-9a-f]{16})\.([0-9]{1,9})$/;

/** Reads the paging part of a list rpc's arguments. `null` means the caller
 *  did not ask for pages and gets the whole list, exactly as before paging
 *  existed. Throws `bad_request` on a malformed `limit` or `cursor`.
 *
 *  ⚠ Anything that is not an object with `limit` or `cursor` reads as "not
 *  paged". These handlers ignored their arguments entirely until now, so
 *  refusing arguments they used to ignore would break a caller that has
 *  always worked. */
export const readListPageRequest = (method: string, args: unknown): ListPageRequest | null => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const { limit, cursor } = args as { limit?: unknown; cursor?: unknown };
  if (limit === undefined && cursor === undefined) return null;
  if (limit !== undefined
    && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    throw new RpcError('bad_request', `${method}: limit must be a whole number of at least 1`, 400);
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || !CURSOR_PATTERN.test(cursor))) {
    throw new RpcError('bad_request', `${method}: cursor is not one this server issued`, 400);
  }
  return {
    limit: Math.min(limit ?? LIST_PAGE_DEFAULT_LIMIT, LIST_PAGE_MAX_LIMIT),
    ...(cursor !== undefined ? { cursor } : {}),
  };
};

export interface ListPageAnswer<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

export interface ListPager<T> {
  page(request: ListPageRequest, compute: () => ReadonlyArray<T>): ListPageAnswer<T>;
}

export interface ListPagerOptions<T> {
  /** The rpc name, for error messages. */
  method: string;
  /** A row's identity. The fingerprint is these, in list order. */
  identity: (item: T) => string;
  byteBudget?: number;
  memoTtlMs?: number;
  now?: () => number;
}

const fingerprintOf = <T>(items: ReadonlyArray<T>, identity: (item: T) => string): string => {
  const hash = createHash('sha256');
  for (const item of items) {
    hash.update(identity(item));
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
};

export const createListPager = <T>(options: ListPagerOptions<T>): ListPager<T> => {
  const budget = options.byteBudget ?? LIST_PAGE_BYTE_BUDGET;
  const ttl = options.memoTtlMs ?? MEMO_TTL_MS;
  const now = options.now ?? Date.now;
  let memo: { fingerprint: string; items: ReadonlyArray<T>; touchedAt: number } | null = null;

  const fresh = (compute: () => ReadonlyArray<T>) => {
    const items = compute();
    return { items, fingerprint: fingerprintOf(items, options.identity) };
  };

  return {
    page(request, compute) {
      let items: ReadonlyArray<T>;
      let fingerprint: string;
      let offset = 0;
      if (request.cursor === undefined) {
        ({ items, fingerprint } = fresh(compute));
      } else {
        const match = CURSOR_PATTERN.exec(request.cursor);
        if (match === null) {
          throw new RpcError('bad_request', `${options.method}: cursor is not one this server issued`, 400);
        }
        const wanted = match[1]!;
        offset = Number(match[2]);
        if (memo !== null && memo.fingerprint === wanted && now() - memo.touchedAt <= ttl) {
          memo.touchedAt = now();
          ({ items, fingerprint } = memo);
        } else {
          ({ items, fingerprint } = fresh(compute));
          if (fingerprint !== wanted) {
            throw new RpcError(
              'conflict',
              `${options.method}: the list changed after its first page was read; read it again from the start`,
              409,
            );
          }
        }
        // Only an offset this pager issued is valid: past the first row and
        // before the end, since a read that reached the end got no cursor.
        if (offset < 1 || offset >= items.length) {
          throw new RpcError('bad_request', `${options.method}: cursor is not one this server issued`, 400);
        }
      }

      const limit = Math.min(request.limit ?? LIST_PAGE_DEFAULT_LIMIT, LIST_PAGE_MAX_LIMIT);
      const out: T[] = [];
      // Exactly what `JSON.stringify(out)` will measure: the brackets, each
      // row, and a comma before every row after the first.
      let bytes = 2;
      for (let i = offset; i < items.length && out.length < limit; i += 1) {
        const size = Buffer.byteLength(JSON.stringify(items[i]) ?? 'null', 'utf8')
          + (out.length > 0 ? 1 : 0);
        if (out.length > 0 && bytes + size > budget) break;
        out.push(items[i]!);
        bytes += size;
      }
      const end = offset + out.length;
      if (end >= items.length) {
        if (memo !== null && memo.fingerprint === fingerprint) memo = null;
        return { items: out, next_cursor: null, total: items.length };
      }
      memo = { fingerprint, items, touchedAt: now() };
      return { items: out, next_cursor: `${CURSOR_VERSION}.${fingerprint}.${end}`, total: items.length };
    },
  };
};
