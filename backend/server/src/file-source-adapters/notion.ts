/** D-192 file SOURCE family — Notion.
 *
 *  Satisfies `FileSourceListFn` for the `notion` vendor. Notion has NO flat file
 *  list and NO file-level delta, so this is a BESPOKE recursive walk (Box-shaped,
 *  thinner metadata) over TWO prongs — Notion's two file homes:
 *
 *    PRONG 1 (block-attached files): `POST /v1/search` enumerates the pages
 *    SHARED WITH THE INTEGRATION, then each page's block tree is drained via
 *    `GET /v1/blocks/{id}/children` (paginated + recursed through `has_children`),
 *    collecting the file-carrying blocks (`file` / `image` / `pdf` / `video` /
 *    `audio`). `remote_id` = the (stable) block id.
 *
 *    PRONG 2 (data-source `files`-property files): `POST /v1/search` (filter
 *    `data_source`) enumerates every shared data source, `POST /v1/data_sources/
 *    {id}/query` drains its rows, and each row's `type:'files'` properties are
 *    read — files attached to a DB ROW live in `properties.<Name>.files[]`, NOT
 *    the block tree, so prong 1 misses them entirely. Property files carry NO
 *    per-entry id (position-only), so `remote_id` is a CONTENT-DERIVED stable key
 *    scoped by (rowId, propertyId) — see `fileRowFromProperty`. The two prongs'
 *    `remote_id` namespaces are disjoint (bare block UUID vs colon-joined key), so
 *    a DB row walked by BOTH prongs never double-collects a file.
 *
 *  FULL-only (`walk: 'full'`, `list.mode: 'full'`): the shared snapshot-hash skip
 *  keeps an unchanged re-walk cheap; there is no cursor.
 *
 *  Completeness is proven ONLY over the SHARED set — unshared pages/data sources
 *  are invisible to `search`, so a positive `complete` means "the whole SHARED
 *  tree drained to exhaustion", never a workspace-completeness claim. The proof
 *  spans BOTH prongs: a page block-walk OR a data-source query that fails
 *  mid-cycle (404 gone / 403 unreadable) is SKIPPED and sinks `complete`
 *  (fail-closed — the runner never absence-deletes an unwalked subtree); either
 *  `search` failing aborts the cycle. Bytes are NEVER fetched (the North star);
 *  the mirror stores metadata + the block id / property locator (Notion file URLs
 *  are ~1h-signed, so byte-fetch — a family-wide, reserved `storage_ref:'remote'`
 *  concern — must re-resolve, never trust a stored URL).
 *
 *  KNOWN LIMITS (declared, not bugs): sharing-bounded coverage; NO size / mime /
 *  content-revision (Notion file objects carry none — `mtime` is the block's /
 *  row's `last_edited_time`, the only change proxy); image/pdf/video/audio blocks
 *  carry no name → a URL-basename fallback; the same file on N pages/rows mirrors
 *  as N rows (location ≠ content identity). Page icon/cover files are a minor
 *  third surface still deferred (low value; the two prongs here cover both file
 *  HOMES). Auth: the stable internal-integration bearer (no rotation).
 *
 *  Design: `docs/d-192-file-source-family.md`; taxonomy §0 / §3b. */

import { createHash } from 'node:crypto';

import { parseImportScopeConfig, resolveBearerAccessToken, type ImportScope } from '@recued/contracts';

import type { FileSourceListFn, FileSourceListOutcome } from '../file-source-sync.js';
import type { FileConnectionCredential, FileSourceLeafDeps } from './index.js';

// Exported so the D-192 remote byte-fetch resolver re-resolves a block's fresh
// ~1h-signed url against the SAME base + pinned version (one source of truth).
export const NOTION_API = 'https://api.notion.com/v1';
// Notion requires a pinned API version header on every request (matches the
// `notion.json` app-pack's pinned version — one connection, both surfaces).
export const NOTION_VERSION = '2026-03-11';
const SEARCH_PAGE_SIZE = 100;
const CHILDREN_PAGE_SIZE = 100;

/** Block types that carry a file payload (`block[type] = { type:'file'|'external',
 *  file?:{url}, external?:{url}, name? }`). */
const FILE_BLOCK_TYPES: ReadonlySet<string> = new Set(['file', 'image', 'pdf', 'video', 'audio']);

/** A `child_page` / `child_database` block IS a separate page/database — its `id`
 *  is that sub-page's id, and `POST /v1/search` already enumerates it as its own
 *  top-level result (integration access is inherited by descendants). Recursing
 *  into it here would double-collect its files (once under the parent's title,
 *  once under its own) → order-dependent `path` + hash churn + wasted calls. So the
 *  walk descends ONLY into structural blocks (toggles/columns/…), never into a
 *  nested page. */
const CHILD_PAGE_TYPES: ReadonlySet<string> = new Set(['child_page', 'child_database']);

// Defensive walk bounds — a pathological/looping response fails closed (incomplete)
// rather than spinning unbounded (mirrors Box's poll cap + seen-guard).
const MAX_PAGES = 50_000;
const MAX_BLOCK_DEPTH = 30;
// 429 `rate_limited` / 529 `service_overload` inline retry (honor `Retry-After`).
const MAX_RETRIES = 5;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

class NotionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NotionError';
  }
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const readStringConfig = (config: Record<string, unknown>, field: string): string | undefined => {
  const v = config[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** A parsed cursor-paginated Notion list page (`search` + `blocks/children` share
 *  the `{ results, has_more, next_cursor }` envelope). Throws on a malformed shape
 *  — fail-closed, so a bad page can never masquerade as an exhausted walk. */
interface NotionListPage {
  results: unknown[];
  next_cursor: string | undefined;
}
const parseListPage = (body: unknown, where: string): NotionListPage => {
  const obj = asRecord(body);
  if (obj === undefined || !Array.isArray(obj.results)) {
    throw new NotionError(0, `notion ${where}: response carries no results array`);
  }
  const hasMore = obj.has_more === true;
  const nc = obj.next_cursor;
  // has_more:true with no cursor is a malformed page — refuse to loop / to
  // falsely certify exhaustion.
  if (hasMore && !(typeof nc === 'string' && nc.length > 0)) {
    throw new NotionError(0, `notion ${where}: has_more with no next_cursor`);
  }
  return { results: obj.results, next_cursor: hasMore ? (nc as string) : undefined };
};

/** The file basename from a (possibly signed-S3) URL — the last path segment,
 *  percent-decoded, query stripped. `undefined` when the URL is absent/unparseable. */
const basenameFromUrl = (url: unknown): string | undefined => {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const path = new URL(url).pathname;
    const seg = path.split('/').filter((s) => s.length > 0).pop();
    if (seg === undefined) return undefined;
    const name = decodeURIComponent(seg);
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
};

/** Concatenate a Notion rich-text array's `plain_text` fragments, trimmed.
 *  `''` when the value isn't an array (a missing/malformed title). */
const concatRichText = (arr: unknown): string =>
  Array.isArray(arr)
    ? arr
        .map((frag) => (typeof asRecord(frag)?.plain_text === 'string' ? (asRecord(frag)!.plain_text as string) : ''))
        .join('')
        .trim()
    : '';

/** The title of a Notion page object — the value of its single `type:'title'`
 *  property, concatenating the rich-text array's `plain_text`. `'Untitled'` when
 *  absent/empty (the file leaf synthesizes the row in CODE, so — unlike the
 *  static-path work-entity projection — it CAN resolve a title-by-type property). */
const pageTitleOf = (page: Record<string, unknown>): string => {
  const props = asRecord(page.properties);
  if (props !== undefined) {
    for (const value of Object.values(props)) {
      const prop = asRecord(value);
      if (prop?.type !== 'title') continue;
      const text = concatRichText(prop.title);
      if (text.length > 0) return text;
    }
  }
  return 'Untitled';
};

/** The title of a Notion data-source object — its top-level `title` rich-text
 *  array (a data source, unlike a page, carries the title at the object root, not
 *  in a property). `'Untitled'` when absent/empty. */
const dataSourceTitleOf = (ds: Record<string, unknown>): string => {
  const text = concatRichText(ds.title);
  return text.length > 0 ? text : 'Untitled';
};

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The stable OBJECT PATH of a (possibly signed-S3) Notion file URL — the
 *  pathname before `?`. Notion-hosted `file` URLs are ~1h-signed: the S3 object
 *  key (the UUID + filename in the path) is STABLE across re-fetches, only the
 *  `X-Amz-*` signature query rotates — so this, NOT the whole URL, is the stable
 *  identity to hash. `undefined` when the URL is absent/unparseable. */
const objectPathOf = (url: unknown): string | undefined => {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
};

/** Sanitize a path segment (page title / filename) for the synthesized `/`-anchored
 *  path — collapse slashes/whitespace so the breadcrumb stays one level per page. */
const segment = (s: string): string => s.replace(/[/\s]+/g, ' ').trim() || 'untitled';

/** Synthesize the flat file row the shared projector reads (declaration:
 *  filename ← 'filename', remote_id ← 'remote_id', mtime ← 'mtime', path ← 'path')
 *  for a file-carrying block whose `type` + non-empty `id` the CALLER has already
 *  validated (`walkBlocks` fails the walk closed on an id-less file block rather
 *  than dropping it silently). `filename` is NEVER empty (name → URL-basename →
 *  `{type}-{id}` fallback), so a file block never yields an unprojectable row. */
const fileRowFromBlock = (
  block: Record<string, unknown>,
  type: string,
  id: string,
  pageTitle: string,
): Record<string, unknown> => {
  const payload = asRecord(block[type]); // block.file / block.image / …
  const url = payload?.file !== undefined
    ? asRecord(payload.file)?.url
    : asRecord(payload?.external)?.url;
  const name = typeof payload?.name === 'string' && payload.name.length > 0 ? payload.name : undefined;
  const filename = name ?? basenameFromUrl(url) ?? `${type}-${id.slice(0, 8)}`;
  const mtime = typeof block.last_edited_time === 'string' ? block.last_edited_time : undefined;
  return {
    remote_id: id,
    filename,
    path: `${segment(pageTitle)}/${segment(filename)}`,
    ...(mtime !== undefined ? { mtime } : {}),
  };
};

/** Synthesize the flat file row (same declaration as a block file) for ONE entry
 *  in a data-source row's `type:'files'` property.
 *
 *  ⚠ Property files carry NO stable per-entry id — Notion identifies them by array
 *  POSITION, and overwrites the whole array on any edit, so an index-based key
 *  churns (add/remove/reorder → re-key → false delete-then-recreate). The
 *  `remote_id` is instead a CONTENT-DERIVED stable key, by entry `type`:
 *    - `file_upload` → the upload object's `id` (a real, stable object id — best);
 *    - `external`    → sha256 of the permanent external URL;
 *    - `file`        → sha256 of the Notion-hosted URL's OBJECT PATH (stable; the
 *      ~1h signature query rotates, the S3 key does not — hashing the whole URL
 *      would thrash every hour).
 *  Scoped by `(rowId, propId)` so the SAME physical file attached in two
 *  rows/columns mirrors as two distinct locations (matching the block prong's
 *  "location ≠ content identity"), and so a reorder within one property is a
 *  no-op. An entry we can't stably key (unknown type / missing url|id) returns
 *  `null` → the caller fails the walk CLOSED (never emits a churning key, and
 *  never silently drops a file the runner might then absence-delete).
 *
 *  KNOWN LIMIT: the key is `type`-scoped, so IF Notion ever re-serialized the same
 *  physical file under a different `type` across cycles (e.g. a freshly-attached
 *  `file_upload` later read back as a Notion-hosted `file`), that one file re-keys
 *  once — a single delete-then-recreate of its metadata row, self-healing on the
 *  next cycle (not perpetual thrash, and never data loss — the file stays
 *  mirrored). Unifying the two id spaces isn't possible without fetching the
 *  bytes, so this transient is accepted rather than papered over. */
const fileRowFromProperty = (
  entry: Record<string, unknown> | undefined,
  rowId: string,
  propId: string,
  propName: string,
  rowTitle: string,
  dsTitle: string,
  mtime: string | undefined,
): Record<string, unknown> | null => {
  if (entry === undefined) return null;
  const type = typeof entry.type === 'string' ? entry.type : undefined;
  let discriminator: string | undefined;
  let url: string | undefined; // for the filename basename fallback (never for keying)
  if (type === 'file_upload') {
    const upId = asRecord(entry.file_upload)?.id;
    if (typeof upId === 'string' && upId.length > 0) discriminator = `upload:${upId}`;
  } else if (type === 'external') {
    const u = asRecord(entry.external)?.url;
    if (typeof u === 'string' && u.length > 0) {
      url = u;
      discriminator = `ext:${sha256Hex(u)}`;
    }
  } else if (type === 'file') {
    const u = asRecord(entry.file)?.url;
    if (typeof u === 'string' && u.length > 0) {
      url = u;
      const objPath = objectPathOf(u);
      if (objPath !== undefined) discriminator = `file:${sha256Hex(objPath)}`;
    }
  }
  if (discriminator === undefined) return null; // unkeyable → fail closed
  const remote_id = `${rowId}:${propId}:${discriminator}`;
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined;
  const filename = name ?? basenameFromUrl(url) ?? `file-${sha256Hex(remote_id).slice(0, 8)}`;
  return {
    remote_id,
    filename,
    path: `${segment(dsTitle)}/${segment(rowTitle)}/${segment(propName)}/${segment(filename)}`,
    ...(mtime !== undefined ? { mtime } : {}),
  };
};

/** Build the `notion` `FileSourceListFn` leaf. `opts.sleep` is a test seam for the
 *  429/529 backoff (production waits real time; tests pass an instant stub). */
export const buildNotionFileSourceLeaf = (
  deps: FileSourceLeafDeps,
  opts?: { sleep?: (ms: number) => Promise<void> },
): FileSourceListFn => {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** One Notion API call with the pinned version + bearer, retrying inline on
   *  429/529 (honoring `Retry-After`, bounded); throws `NotionError(status)` on any
   *  other non-2xx or on exhausted retries — fail-closed. */
  const request = async (
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> => {
    const url = `${NOTION_API}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt += 1) {
      const res = await deps.fetchImpl(url, init);
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = Math.min(
          Number.isFinite(ra) && ra > 0 ? ra * 1_000 : DEFAULT_RETRY_MS * (attempt + 1),
          MAX_RETRY_MS,
        );
        await sleep(waitMs);
        continue;
      }
      throw new NotionError(res.status, `notion ${method} ${path} → HTTP ${res.status}`);
    }
  };

  /** Drain one cursor-paginated list to exhaustion (`search` or `blocks/children`),
   *  collecting every `results` row. `budget` bounds total pages fleet-wide. */
  const drainList = async (
    token: string,
    buildCall: (cursor: string | undefined) => { path: string; body?: unknown; method: 'GET' | 'POST' },
    where: string,
    budget: { pages: number },
  ): Promise<unknown[]> => {
    const out: unknown[] = [];
    let cursor: string | undefined;
    do {
      if (budget.pages >= MAX_PAGES) {
        throw new NotionError(0, `notion ${where}: exceeded ${MAX_PAGES}-page walk budget`);
      }
      budget.pages += 1;
      const call = buildCall(cursor);
      const page = parseListPage(await request(call.method, call.path, token, call.body), where);
      out.push(...page.results);
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    return out;
  };

  /** A FULL walk over BOTH file homes: (1) enumerate shared pages + recurse each
   *  page's block tree collecting file blocks, then (2) enumerate shared data
   *  sources + query each one's rows collecting their `files`-property files. The
   *  combined present-set is the absence-delete authority. A per-page block-walk OR
   *  per-data-source query failure (404/403) is SKIPPED + sinks `complete`
   *  (fail-closed); either search-level failure aborts the cycle (classified
   *  below). */
  const fullWalk = async (token: string, scope: ImportScope | null): Promise<FileSourceListOutcome> => {
    const rows: Record<string, unknown>[] = [];
    let incomplete = false;
    const budget = { pages: 0 };
    let pages: unknown[];
    try {
      // Enumerate every page shared with the integration (paginated to has_more:false).
      pages = await drainList(
        token,
        (cursor) => ({
          method: 'POST',
          path: '/search',
          body: {
            filter: { value: 'page', property: 'object' },
            page_size: SEARCH_PAGE_SIZE,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          },
        }),
        'search',
        budget,
      );
    } catch (err) {
      // Can't even enumerate the shared page set — abort the cycle (retry).
      return classifyError(err);
    }

    // Recurse each page's block tree. A `seen` guard + depth cap defend against a
    // pathological cyclic/deep response.
    const walkBlocks = async (parentId: string, pageTitle: string, depth: number, seen: Set<string>): Promise<void> => {
      if (depth > MAX_BLOCK_DEPTH || seen.has(parentId)) {
        incomplete = true; // an over-deep / repeated subtree is unproven — fail closed
        return;
      }
      seen.add(parentId);
      const children = await drainList(
        token,
        (cursor) => ({
          method: 'GET',
          path: `/blocks/${encodeURIComponent(parentId)}/children?page_size=${CHILDREN_PAGE_SIZE}`
            + (cursor !== undefined ? `&start_cursor=${encodeURIComponent(cursor)}` : ''),
        }),
        'blocks.children',
        budget,
      );
      for (const child of children) {
        const block = asRecord(child);
        if (block === undefined) { incomplete = true; continue; } // undescendable — fail closed
        const type = typeof block.type === 'string' ? block.type : undefined;
        const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined;
        if (type !== undefined && FILE_BLOCK_TYPES.has(type)) {
          // A file block with no usable id is UNKEYABLE — fail closed (dropping it
          // silently would let the runner absence-delete a still-live mirror row).
          if (id === undefined) { incomplete = true; continue; }
          rows.push(fileRowFromBlock(block, type, id, pageTitle));
        }
        // Recurse into STRUCTURAL children only — never a `child_page` /
        // `child_database` (a separate page `/search` already enumerates). An
        // id-less descendable block is undescendable → fail closed.
        if (block.has_children === true && !(type !== undefined && CHILD_PAGE_TYPES.has(type))) {
          if (id === undefined) { incomplete = true; continue; }
          await walkBlocks(id, pageTitle, depth + 1, seen);
        }
      }
    };

    for (const p of pages) {
      const page = asRecord(p);
      const pageId = page?.id;
      if (page === undefined || typeof pageId !== 'string') { incomplete = true; continue; }
      try {
        await walkBlocks(pageId, pageTitleOf(page), 0, new Set<string>());
      } catch (err) {
        // A page gone (404) / unreadable (403) mid-walk is skipped; that page's
        // subtree is unproven, so the walk is no longer delete-authoritative.
        if (err instanceof NotionError && (err.status === 404 || err.status === 403)) {
          incomplete = true;
          continue;
        }
        return classifyError(err); // a hard error (auth / rate-limit exhaustion / server) aborts
      }
    }

    // ── PRONG 2: data-source `files`-property files ────────────────────────────
    // Notion's OTHER file home: files attached to a data-source ROW (a `files`
    // column) live in the row's `properties`, NOT its block tree, so the walk
    // above misses them. Enumerate every shared data source (search filter
    // `data_source`), query each one's rows, and collect their files-property
    // entries into the SAME `rows` + `incomplete` — the completeness proof (the
    // runner's absence-delete authority) now spans BOTH prongs. The shared
    // `budget` bounds total pages fleet-wide across both.
    let dataSources: unknown[];
    try {
      dataSources = await drainList(
        token,
        (cursor) => ({
          method: 'POST',
          path: '/search',
          body: {
            filter: { value: 'data_source', property: 'object' },
            page_size: SEARCH_PAGE_SIZE,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          },
        }),
        'search.data_source',
        budget,
      );
    } catch (err) {
      // Can't enumerate the shared data-source set — abort the cycle (retry).
      return classifyError(err);
    }

    for (const d of dataSources) {
      const ds = asRecord(d);
      const dsId = ds?.id;
      if (ds === undefined || typeof dsId !== 'string' || dsId.length === 0) { incomplete = true; continue; }
      const dsTitle = dataSourceTitleOf(ds);
      let dsRows: unknown[];
      try {
        dsRows = await drainList(
          token,
          (cursor) => ({
            method: 'POST',
            path: `/data_sources/${encodeURIComponent(dsId)}/query`,
            body: {
              page_size: SEARCH_PAGE_SIZE,
              ...(cursor !== undefined ? { start_cursor: cursor } : {}),
            },
          }),
          'data_source.query',
          budget,
        );
      } catch (err) {
        // A data source gone (404) / unreadable (403) mid-cycle is skipped + sinks
        // `complete` (fail-closed); a hard error (auth / rate-limit exhaustion /
        // server) aborts — mirrors the per-page block-walk posture above.
        if (err instanceof NotionError && (err.status === 404 || err.status === 403)) {
          incomplete = true;
          continue;
        }
        return classifyError(err);
      }
      for (const r of dsRows) {
        const row = asRecord(r);
        const rowId = row?.id;
        // An id-less row is unkeyable → fail closed (never absence-delete its files).
        if (row === undefined || typeof rowId !== 'string' || rowId.length === 0) { incomplete = true; continue; }
        const rowTitle = pageTitleOf(row);
        const rowMtime = typeof row.last_edited_time === 'string' ? row.last_edited_time : undefined;
        const props = asRecord(row.properties);
        // A well-formed query row ALWAYS carries a `properties` object; a missing /
        // malformed one is an unexpected shape whose file columns we can't inspect
        // → fail closed (never certify a delete over a row we couldn't read).
        if (props === undefined) { incomplete = true; continue; }
        for (const [propName, propVal] of Object.entries(props)) {
          const prop = asRecord(propVal);
          if (prop?.type !== 'files') continue; // not a files column — correctly ignored
          // A files column whose `files` isn't an array is MALFORMED → fail closed
          // (a silent skip could let the runner absence-delete its live files —
          // matching prong 1's fail-closed posture on undescendable data).
          if (!Array.isArray(prop.files)) { incomplete = true; continue; }
          // Key on the STABLE property id (survives a column rename); the human name
          // rides the path only. Fall back to the name if Notion omits the id.
          const propId = typeof prop.id === 'string' && prop.id.length > 0 ? prop.id : propName;
          for (const entry of prop.files) {
            const fileRow = fileRowFromProperty(asRecord(entry), rowId, propId, propName, rowTitle, dsTitle, rowMtime);
            if (fileRow === null) { incomplete = true; continue; } // unkeyable file → fail closed
            rows.push(fileRow);
          }
        }
      }
    }

    return {
      ok: true,
      walk: 'full',
      rows,
      // `complete` only when EVERY shared page's block tree AND every shared data
      // source's rows drained — a skip in EITHER prong sinks it so the runner's
      // absence-delete diff never tombstones an unwalked file.
      complete: !incomplete,
      // Full-only — no delta cursor to persist (the next cycle full-walks).
      next_cursor: null,
      scope,
    };
  };

  const classifyError = (err: unknown): FileSourceListOutcome => {
    if (err instanceof NotionError) {
      // 401 = bad/revoked token (config); everything else = a retryable error.
      if (err.status === 401) return { ok: false, kind: 'config', reason: err.message };
      return { ok: false, kind: 'error', reason: err.message };
    }
    return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  };

  return async (request_) => {
    let cred: FileConnectionCredential | null;
    try {
      cred = await deps.resolveConnection(request_.connection_name);
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        reason: `notion credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (cred === null) {
      return { ok: false, kind: 'config', reason: `connection '${request_.connection_name}' not found` };
    }
    const token = resolveBearerAccessToken(cred.auth);
    if (token === undefined) {
      return {
        ok: false,
        kind: 'config',
        reason: `notion connection '${request_.connection_name}' has no usable access token`,
      };
    }
    // Fork A escape hatch — the optional `import_scope` glob (client-side, since
    // Notion has no server-side path filter). The leaf synthesizes a page-title
    // breadcrumb path, so the runner CAN glob-filter it; the scope rides back in
    // the outcome. A malformed value fails closed to a `config` outcome.
    const parsedScope = parseImportScopeConfig(cred.config.import_scope);
    if (!parsedScope.ok) {
      return { ok: false, kind: 'config', reason: parsedScope.reason };
    }
    // Notion is FULL-only — no native delta feed, so the runner's `cursor` (null or
    // a stale watermark) is ignored and every cycle re-walks the shared tree.
    return fullWalk(token, parsedScope.scope);
  };
};
