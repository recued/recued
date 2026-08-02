/** D-192 file SOURCE family (slice 5) — the Dropbox adapter leaf.
 *
 *  Satisfies `FileSourceListFn` for the `dropbox` vendor: a recursive
 *  `files/list_folder` walk (paged via `files/list_folder/continue`) from the
 *  configured root, returning the raw file entries — never bytes.
 *
 *  Dropbox rides a `full_then_delta` cursor (`list.cursor_kind: 'cursor'`). The
 *  runner drives the hybrid model by what it passes as `request.cursor`:
 *   - `null` ⇒ a FULL walk: `list_folder` from the `import_scope` folder (or
 *     the account root when unscoped), following `has_more` to exhaustion. This
 *     is the delete authority (`walk: 'full'`, `complete: true` when the walk
 *     ran to `has_more: false`); its final page cursor rides back as
 *     `next_cursor` — the delta watermark for the next cycle.
 *   - a stored watermark ⇒ a DELTA walk: `list_folder/continue` from it,
 *     draining changed pages (`walk: 'delta'`). `.tag: 'file'` entries ride back
 *     in `rows` (upserts); `.tag: 'deleted'` tombstones ride back separately in
 *     `removed_paths` (their `path_display`) so the runner tombstones the removed
 *     mirror rows immediately (Option 3 — explicit delta deletes). A cursor RESET
 *     (Dropbox invalidated the watermark, HTTP 409 `reset`) falls back to a full
 *     walk transparently.
 *
 *  Scope (slice 6, Fork A): the user's optional `import_scope` glob's derived
 *  literal prefix is translated to the `list_folder` path ({@link dropboxFolderOf});
 *  the resolved scope rides back in the outcome for the runner's client-side
 *  glob filter. A Dropbox file id is OPAQUE (not a path), so the delete diff
 *  can't be prefix-scoped by key — the folder pushdown bounds the mirror for a
 *  stable scope (the runner documents the trade-off).
 *
 *  A file SOURCE lists FILES: `.tag: 'folder'` entries are skipped (they carry
 *  no size / mtime / rev). `.tag: 'deleted'` tombstones never enter `rows` (a
 *  tombstone is not a file to project), but on a delta `/continue` page they ARE
 *  how Dropbox reports removals — so the leaf surfaces each tombstone's
 *  `path_display` in `removed_paths` for the runner to reverse-look-up + tombstone
 *  (Option 3). A full walk (`include_deleted: false`) carries none, so it emits
 *  no `removed_paths` (it owns removals by ABSENCE instead). A file entry already
 *  exposes the canonical fields the declaration maps (`name` = the leaf filename,
 *  `path_display`, `id`, `size`, `server_modified`, `rev`), so no normalization
 *  is needed — the projector reads them directly.
 *
 *  Auth: an OAuth bearer token resolved from the connection's decrypted auth
 *  (`bearer` or the `current_access_token` of an `oauth2_refresh` row). v1 has
 *  no in-leaf refresh — an expired token surfaces as a `config` outcome the
 *  scheduler records + retries (a dedicated file sync-state store + refresh is
 *  a named follow-on). */

import { parseImportScopeConfig, resolveBearerAccessToken, type ImportScope } from '@recued/contracts';

import type {
  FileSourceListFn,
  FileSourceListOutcome,
} from '../file-source-sync.js';
import type {
  FileConnectionCredential,
  FileFetch,
  FileSourceLeafDeps,
} from './index.js';
import { fetchFileSourceApi } from './http-json.js';
import { drainPagedList, type PagedListDrain, type PagedListPage } from './paged-list.js';

const DROPBOX_API = 'https://api.dropboxapi.com';
/** Dropbox's `list_folder` page size ceiling. */
const DROPBOX_LIST_LIMIT = 2000;

/** Carries a Dropbox HTTP status so the classifier can split auth (401 → the
 *  token needs re-auth: `config`) from permission (403 → `policy`) from a
 *  transient failure (`error`). */
class DropboxError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'DropboxError';
  }
}

interface DropboxListPage {
  entries: unknown[];
  cursor?: string;
  has_more: boolean;
}

/** Parse + STRICTLY validate one `list_folder` page. A well-formed response
 *  always carries an `entries` array + a `has_more` boolean; coercing a
 *  missing/mistyped field to `[]` / `false` would let a `{}` body, a schema
 *  drift, or a proxy-corrupted 200 masquerade as a COMPLETE empty walk — which
 *  the D-190 delete diff would act on (false-deleting every mirrored file).
 *  Fail closed: a malformed shape throws → an `error` outcome the scheduler
 *  retries, never a silent complete walk. */
const parseDropboxPage = (res: unknown): DropboxListPage => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new DropboxError(0, 'dropbox list_folder response is not an object');
  }
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.entries)) {
    throw new DropboxError(0, 'dropbox list_folder response has no entries array');
  }
  if (typeof obj.has_more !== 'boolean') {
    throw new DropboxError(0, 'dropbox list_folder response has no has_more boolean');
  }
  const cursor = typeof obj.cursor === 'string' && obj.cursor.length > 0 ? obj.cursor : undefined;
  return { entries: obj.entries, ...(cursor !== undefined ? { cursor } : {}), has_more: obj.has_more };
};

/** Map one `list_folder` / `list_folder/continue` page into the shared paged-list
 *  page shape, reusing the strict `parseDropboxPage` validator (it throws on a
 *  malformed shape — the fail-closed guard). Dropbox's `cursor` is BOTH the
 *  continuation (`nextRef`, used while `has_more`) AND the delta watermark
 *  (`watermark`, captured by the primitive from the TERMINAL page only — so a
 *  drained walk's `next_cursor` is the cursor AFTER the final page, never an
 *  intermediate one). A `has_more: true` page with no cursor is the primitive's
 *  malformed-pagination guard ⇒ `complete: false` + no watermark. */
const parseDropboxPagedPage = (raw: unknown): PagedListPage => {
  const page = parseDropboxPage(raw);
  return {
    entries: page.entries,
    hasMore: page.has_more,
    ...(page.cursor !== undefined ? { nextRef: page.cursor, watermark: page.cursor } : {}),
  };
};

const dropboxPost = async (
  fetchImpl: FileFetch,
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> => {
  const res = await fetchFileSourceApi(fetchImpl, url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DropboxError(res.status, `dropbox ${url} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
};

/** Translate an `import_scope`'s derived literal prefix into the `list_folder`
 *  path Dropbox wants — a `/`-anchored FOLDER (or `''` for the account/app
 *  root, NOT `'/'`). Dropbox's `list_folder` path must name a real folder, and
 *  the canonical prefix's trailing segment may be a partial name or a file
 *  (`Work/report.pdf`), so we take its PARENT directory — a safe
 *  over-approximation (the walk covers at least every in-scope path; the
 *  runner's client-side glob filter narrows the rest). `''` / a bare segment
 *  (`Work`) → root, so a precise folder walk wants a trailing `/` or `/**`
 *  (`Work/` / `Work/**`). Examples: `Work/2024/` → `/Work/2024`; `Work/a.pdf`
 *  → `/Work`; `Work` → `''`. */
const dropboxFolderOf = (prefix: string): string => {
  const i = prefix.lastIndexOf('/');
  return i < 0 ? '' : `/${prefix.slice(0, i)}`;
};

/** Push the file entries from one page into `rows` (folders + deleted skipped —
 *  a delta page's `deleted` tombstones are harvested separately by
 *  {@link collectDeletedPaths}). */
const collectFileEntries = (entries: unknown[], rows: Record<string, unknown>[]): void => {
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['.tag'] !== 'file') continue;
    rows.push(e);
  }
};

/** Harvest each `.tag: 'deleted'` tombstone's `path_display` from one delta page
 *  into `removedPaths` — the explicit removals the runner reverse-looks-up
 *  against the mirror's stored paths (Option 3). A Dropbox `deleted` entry
 *  carries `name` + `path_lower` + `path_display` but NO `id`, so the removal is
 *  keyed by PATH; `path_display` is exactly the field the mirror stores as the
 *  canonical `path`, so the runner matches it directly. An entry with no usable
 *  `path_display` is skipped (unmatchable — the periodic full walk backstops
 *  it). Only meaningful on a delta walk; a full walk (`include_deleted: false`)
 *  carries no tombstones. */
const collectDeletedPaths = (entries: unknown[], removedPaths: string[]): void => {
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e['.tag'] !== 'deleted') continue;
    const path = e.path_display;
    if (typeof path === 'string' && path.length > 0) removedPaths.push(path);
  }
};

const classifyDropboxError = (err: unknown): FileSourceListOutcome => {
  if (err instanceof DropboxError) {
    const kind: 'config' | 'policy' | 'error' =
      err.status === 401 ? 'config' : err.status === 403 ? 'policy' : 'error';
    return { ok: false, kind, reason: err.message };
  }
  return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
};

/** Dropbox's cursor-RESET signal — `list_folder/continue` returns HTTP 409 with
 *  a `reset` error tag when the watermark is invalidated (too old, namespace
 *  remount, server rebuild). The correct recovery is a fresh full `list_folder`,
 *  so the leaf falls back transparently (the runner never sees the reset). */
const isDropboxReset = (err: unknown): boolean =>
  err instanceof DropboxError && err.status === 409 && err.message.includes('reset');

/** Build the `dropbox` `FileSourceListFn` leaf. */
export const buildDropboxFileSourceLeaf = (deps: FileSourceLeafDeps): FileSourceListFn => {
  // A FULL recursive walk from `rootPath` to exhaustion — the present-set
  // (delete authority). The final page's cursor rides back as `next_cursor`, the
  // delta watermark for the next cycle. Catches its own HTTP errors → outcome.
  const fullWalk = async (
    token: string,
    rootPath: string,
    scope: ImportScope | null,
  ): Promise<FileSourceListOutcome> => {
    const rows: Record<string, unknown>[] = [];
    let drain: PagedListDrain;
    try {
      // Drain the recursive `list_folder` to exhaustion via the shared paged-list
      // primitive — `ref === ''` is the first page (`list_folder` from `rootPath`);
      // a non-empty `ref` is a `list_folder/continue` cursor. The primitive follows
      // `has_more` + the cursor + captures the TERMINAL cursor as the watermark.
      drain = await drainPagedList(
        {
          fetchPage: (ref) =>
            ref === ''
              ? dropboxPost(deps.fetchImpl, `${DROPBOX_API}/2/files/list_folder`, token, {
                  path: rootPath,
                  recursive: true,
                  limit: DROPBOX_LIST_LIMIT,
                  include_deleted: false,
                  include_media_info: false,
                  include_non_downloadable_files: true,
                })
              : dropboxPost(deps.fetchImpl, `${DROPBOX_API}/2/files/list_folder/continue`, token, {
                  cursor: ref,
                }),
          parsePage: parseDropboxPagedPage,
        },
        '',
      );
    } catch (err) {
      return classifyDropboxError(err);
    }
    collectFileEntries(drain.entries, rows);
    // A walk that ran to `has_more: false` covered the whole scoped tree
    // (`has_more: true` with no cursor — a malformed response — fails `complete`).
    // The TERMINAL cursor is the delta watermark; absent (malformed / never
    // captured) → null, so the next cycle full-walks again. (This now matches the
    // delta walk's terminal-only watermark exactly — the primitive never persists
    // an intermediate cursor.)
    return {
      ok: true,
      walk: 'full',
      rows,
      complete: drain.complete,
      next_cursor: drain.watermark ?? null,
      scope,
    };
  };

  // A DELTA walk — replay `list_folder/continue` from the stored watermark,
  // draining changed pages to exhaustion. `.tag: 'file'` entries ride back in
  // `rows` (upserts); `.tag: 'deleted'` tombstones are harvested into
  // `removedPaths` (their `path_display`) as EXPLICIT removals — the runner
  // reverse-looks each up against the mirror's stored paths + tombstones it this
  // cycle (Option 3), so a delta no longer waits for the periodic full walk to
  // reconcile a removal. Throws HTTP errors so the caller can split a cursor
  // reset (→ full fallback) from a real failure (→ classify).
  const deltaWalk = async (
    token: string,
    cursor: string,
    scope: ImportScope | null,
  ): Promise<FileSourceListOutcome> => {
    const rows: Record<string, unknown>[] = [];
    const removedPaths: string[] = [];
    // Drain `list_folder/continue` from the stored cursor via the shared paged-list
    // primitive — same page shape as the full walk. Throws a malformed-page /
    // HTTP error so the caller can split a reset (→ full fallback) from a real
    // failure. The primitive captures the TERMINAL page's cursor as the watermark
    // (never an intermediate one — riding an earlier cursor would re-fetch
    // already-processed pages forever without ever advancing).
    const drain = await drainPagedList(
      {
        fetchPage: (ref) =>
          dropboxPost(deps.fetchImpl, `${DROPBOX_API}/2/files/list_folder/continue`, token, {
            cursor: ref,
          }),
        parsePage: parseDropboxPagedPage,
      },
      cursor,
    );
    collectFileEntries(drain.entries, rows);
    collectDeletedPaths(drain.entries, removedPaths);
    // Did the delta DRAIN (reach `has_more: false`)? `drain.complete` is false when
    // a page claimed `has_more: true` but carried NO cursor to continue — a
    // malformed / proxy-corrupted page, the SAME failure `fullWalk` fails
    // `complete` on. An undrained delta has NOT seen the full change set, so its
    // `removed_paths` are UNTRUSTWORTHY: a move's new-path page may be exactly
    // the unreached one, and tombstoning the old path would false-delete the
    // moved file (its id never entered the runner's `polledKeys`). So SUPPRESS
    // the explicit deletes on an undrained delta (the upserts we DID see are
    // safe — additive/idempotent — and stay), and force a FULL re-list next
    // cycle (`next_cursor: null`, the delete authority) rather than replay a
    // cursor we couldn't advance. A drained delta emits its tombstones as
    // trustworthy removals; its final cursor (absent ⇒ null → full-walk next)
    // rides back. `complete: false` — a delta is never delete-authoritative BY
    // ABSENCE (the runner gates absence-tombstones on `walk === 'full'`); its
    // explicit `removed_paths` are honored independently of `complete`.
    const drained = drain.complete;
    return {
      ok: true,
      walk: 'delta',
      rows,
      removed_paths: drained ? removedPaths : [],
      next_cursor: drained ? (drain.watermark ?? null) : null,
      scope,
      complete: false,
    };
  };

  return async (request) => {
    // Credential resolution can throw (a locked vault / bad AEAD key) — a
    // transient `error` the scheduler retries, never a thrown cycle (the task
    // is contractually no-throw).
    let cred: FileConnectionCredential | null;
    try {
      cred = await deps.resolveConnection(request.connection_name);
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        reason: `dropbox credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (cred === null) {
      return { ok: false, kind: 'config', reason: `connection '${request.connection_name}' not found` };
    }
    const token = resolveBearerAccessToken(cred.auth);
    if (token === undefined) {
      return {
        ok: false,
        kind: 'config',
        reason: `dropbox connection '${request.connection_name}' has no usable access token`,
      };
    }
    // Fork A escape hatch — the user's optional `import_scope` glob. Its derived
    // literal prefix names the folder the FULL walk scopes to; a malformed value
    // fails closed to a `config` outcome. `scope` rides back in every outcome so
    // the runner client-side filters through the full glob (Dropbox `id`s are
    // opaque, so the walk-scoping is the delete bound — see the runner). NOTE: a
    // delta continue inherits the folder/recursive scope baked into the cursor
    // at mint time, so an `import_scope` EDIT only takes full effect at the next
    // full re-baseline (bounded staleness — the accepted hybrid delete-lag).
    const parsedScope = parseImportScopeConfig(cred.config.import_scope);
    if (!parsedScope.ok) {
      return { ok: false, kind: 'config', reason: parsedScope.reason };
    }
    const scope: ImportScope | null = parsedScope.scope;
    const rootPath = dropboxFolderOf(scope?.prefix ?? '');

    // The runner passes `null` to force a FULL walk (first boot / periodic
    // delete re-baseline), or the stored watermark for a cheap DELTA walk.
    if (request.cursor === null || request.cursor === undefined) {
      return fullWalk(token, rootPath, scope);
    }
    try {
      return await deltaWalk(token, request.cursor, scope);
    } catch (err) {
      // A cursor reset recovers by a fresh full walk THIS cycle (the leaf
      // returns `walk: 'full'`); any other error is classified + retried.
      if (isDropboxReset(err)) return fullWalk(token, rootPath, scope);
      return classifyDropboxError(err);
    }
  };
};
