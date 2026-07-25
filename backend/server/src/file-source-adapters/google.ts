/** D-192 file SOURCE family — the Google Drive adapter leaf.
 *
 *  Satisfies `FileSourceListFn` for the `google` vendor via Drive's `changes`
 *  feed — the SECOND ID-keyed delta vendor (after OneDrive): a `changes` delete
 *  tombstone carries the `fileId` directly, so the runner deletes the mirror key
 *  through `removed_keys`, not the path reverse-lookup Dropbox needs.
 *
 *  The DELTA walk rides the shared ID-keyed delta kernel (`id-keyed-delta.ts`):
 *  the accumulator, the drain loop, and the fail-closed shaping
 *  (last-occurrence-wins, undrained-suppression) are the kernel's; this leaf
 *  supplies only `parseChangesPage`, `googleClassify`, and the authenticated GET.
 *  The FULL walk is NOT an id-keyed delta — it is a paged `files.list` (a
 *  different endpoint) + an up-front start-page token — so it stays local (the
 *  sibling paged-list pattern).
 *
 *  Google rides `full_then_delta` with `cursor_kind: 'page_token'`. Unlike
 *  OneDrive (whose full + delta walks share one `/delta` mechanism), Drive splits
 *  them across TWO endpoints (like Dropbox's `list_folder` vs `/continue`):
 *   - `request.cursor === null` ⇒ a FULL walk. First capture a fresh start-page
 *     token (`changes/startPageToken`) BEFORE listing — Google's rule, so a
 *     change landing DURING the walk is replayed next cycle, never lost — then
 *     drain `files.list` (`q` excludes folders + trashed) following
 *     `nextPageToken` to exhaustion. A from-scratch list is the present-set +
 *     absence-delete authority (`walk: 'full'`, `complete: true` once drained);
 *     the token captured up-front rides back as `next_cursor` — the watermark for
 *     next cycle.
 *   - a stored page token ⇒ a DELTA walk: `changes.list(pageToken)`, draining
 *     `nextPageToken` pages (the kernel drain) to the terminal page's
 *     `newStartPageToken` (the next watermark). Changed file items ride back in
 *     `rows` (upserts); items that are `removed` OR whose file is `trashed` ride
 *     back in `removed_keys` (their `fileId`) as EXPLICIT removals the runner
 *     tombstones THIS cycle (Option 3). An invalidated page token (HTTP 400 / 404
 *     / 410) falls back to a full walk transparently (the runner never sees it).
 *
 *  A file SOURCE lists FILES: `folder` items (`mimeType` =
 *  `application/vnd.google-apps.folder`) and trashed / removed items never enter
 *  `rows`. A Drive File's `name` IS the leaf filename and `id` the stable mirror
 *  key, so the projector reads them verbatim — and, UNLIKE every other vendor,
 *  there is NO path to synthesize: Drive exposes only `parents[]` (folder ids),
 *  so the declaration omits `path` and the leaf returns `scope: null` (no
 *  per-row glob filter possible → v1 mirrors the whole accessible Drive; Drive
 *  scopes by folder id, not a path glob — the D-194 capability-binding is the
 *  real scope fix).
 *
 *  Auth: an OAuth bearer resolved from the connection's decrypted auth (`bearer`
 *  or the `current_access_token` of an `oauth2_refresh` row; the file-source
 *  connection resolver refreshes it within the lead window BEFORE this leaf
 *  runs). A 401 surfaces as a `config` outcome the scheduler records + retries. */

import { resolveBearerAccessToken } from '@recued/contracts';

import type {
  FileSourceListFn,
  FileSourceListOutcome,
} from '../file-source-sync.js';
import {
  drainIdKeyedDelta,
  shapeDeltaOutcome,
  type Classify,
  type DeltaPage,
  type IdKeyedDeltaDeps,
} from './id-keyed-delta.js';
import type {
  FileConnectionCredential,
  FileFetch,
  FileSourceLeafDeps,
} from './index.js';
import { drainPagedList, type PagedListDrain, type PagedListPage } from './paged-list.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
/** A Drive File's `mimeType` for a folder — skipped (a file SOURCE lists files). */
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Drive page-size ceiling for `files.list` / `changes.list`. */
const DRIVE_PAGE_SIZE = 1000;
/** The File sub-selection shared by `files.list` and `changes.list` — the exact
 *  fields the declaration's projection reads (no bytes; metadata only). */
const DRIVE_FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,version,trashed,parents,owners(displayName)';

/** D-192 file-kind hardening — mirror files from ALL drives the user can reach
 *  (My Drive + SHARED drives), not just My Drive. `corpora:allDrives` is
 *  `files.list`-only; both list + changes additionally need
 *  `includeItemsFromAllDrives` + `supportsAllDrives`, and `getStartPageToken`
 *  needs `supportsAllDrives` so the delta watermark also spans shared drives.
 *  A user with no shared-drive access sees exactly their My Drive files — the
 *  params are inert, not an error. */
const ALL_DRIVES_PARAMS = {
  includeItemsFromAllDrives: 'true',
  supportsAllDrives: 'true',
} as const;

/** Carries a Drive HTTP status + parsed error message so the classifier can
 *  split auth (401 → `config`) from permission (403 → `policy`) from an
 *  invalidated page token (4xx client error on a delta → full fallback) from a
 *  transient failure (5xx → `error`). */
class GoogleError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

/** Build a `?k=v&…` query string with each value URL-encoded. */
const qs = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

/** Best-effort `error.message` from a Drive error body (for the thrown message
 *  — the classifier keys off STATUS, so this is diagnostic only). */
const googleErrorMessage = (text: string): string => {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    const m = body?.error?.message;
    return typeof m === 'string' ? m : text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
};

const googleGet = async (fetchImpl: FileFetch, url: string, token: string): Promise<unknown> => {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GoogleError(res.status, `drive GET failed: ${res.status} ${googleErrorMessage(text)}`);
  }
  return res.json();
};

interface DriveFilesPage {
  files: unknown[];
  /** `nextPageToken` — another `files.list` page THIS walk. */
  nextPageToken?: string;
  /** `incompleteSearch` — Drive could not fully execute the query, so some
   *  results are MISSING even though there is no `nextPageToken`. The one way
   *  `files.list` returns a partial set without a pagination token; must sink the
   *  walk's completeness proof (else absence-deletes false-fire). */
  incompleteSearch: boolean;
}

/** Parse + STRICTLY validate one `files.list` page. A well-formed response
 *  always carries a `files` array; coercing a missing/mistyped `files` to `[]`
 *  would let a `{}` body, a schema drift, or a proxy-corrupted 200 masquerade as
 *  a COMPLETE empty walk — which the delete diff would act on (false-deleting
 *  every mirrored file). Fail closed: a malformed shape throws → an `error`
 *  outcome the scheduler retries, never a silent complete walk. `incompleteSearch`
 *  is read as the walk's completeness signal (default false — a well-formed page
 *  omits it when the search WAS complete). */
const parseFilesPage = (res: unknown): DriveFilesPage => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new GoogleError(0, 'drive files.list response is not an object');
  }
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.files)) {
    throw new GoogleError(0, 'drive files.list response has no files array');
  }
  const next = obj.nextPageToken;
  const nextPageToken = typeof next === 'string' && next.length > 0 ? next : undefined;
  return {
    files: obj.files,
    incompleteSearch: obj.incompleteSearch === true,
    ...(nextPageToken !== undefined ? { nextPageToken } : {}),
  };
};

/** Map one `files.list` page into the shared paged-list page shape, reusing the
 *  strict `parseFilesPage` validator (it throws on a malformed shape — the
 *  fail-closed guard). `nextPageToken` is BOTH the more-results signal (`hasMore`)
 *  and the continuation (`nextRef`); Drive's `incompleteSearch` rides `incomplete`
 *  (the primitive sinks completeness STICKILY — any page suffices), matching the
 *  prior sticky `incomplete` flag over the walk. */
const parseFilesPagedPage = (raw: unknown): PagedListPage => {
  const page = parseFilesPage(raw);
  return {
    entries: page.files,
    hasMore: page.nextPageToken !== undefined,
    ...(page.nextPageToken !== undefined ? { nextRef: page.nextPageToken } : {}),
    incomplete: page.incompleteSearch,
  };
};

/** Parse + STRICTLY validate one `changes.list` page into the kernel's
 *  `DeltaPage`. A well-formed response always carries a `changes` array; a
 *  missing/mistyped one throws (fail closed, same reasoning as `parseFilesPage`).
 *  `nextPageToken` → `nextRef` (more pages), `newStartPageToken` → `watermark`
 *  (terminal); a page has one or the other. */
const parseChangesPage = (res: unknown): DeltaPage => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new GoogleError(0, 'drive changes.list response is not an object');
  }
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.changes)) {
    throw new GoogleError(0, 'drive changes.list response has no changes array');
  }
  const nextRaw = obj.nextPageToken;
  const startRaw = obj.newStartPageToken;
  const nextRef = typeof nextRaw === 'string' && nextRaw.length > 0 ? nextRaw : undefined;
  const watermark = typeof startRaw === 'string' && startRaw.length > 0 ? startRaw : undefined;
  return {
    items: obj.changes,
    ...(nextRef !== undefined ? { nextRef } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
  };
};

/** Parse a `changes/startPageToken` body → the token, or undefined on a
 *  malformed 200. Undefined is non-fatal: the full walk's present-set + absence
 *  deletes are valid regardless, so the walk proceeds with `next_cursor: null`
 *  (the next cycle full-walks again). HTTP errors throw in `googleGet` upstream. */
const parseStartPageToken = (res: unknown): string | undefined => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) return undefined;
  const t = (res as Record<string, unknown>).startPageToken;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
};

/** Read a non-empty string field (else undefined). */
const readNonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Classify one `changes.list` entry — the Google per-item essence the kernel
 *  folds. A change is a removal when `removed: true` OR its file is `trashed:
 *  true` (guarded FIRST, so an item that is both a change and gone is a removal).
 *  A live file change with a non-folder `file` is an upsert; a drive-only change
 *  (no `file`) and folder items are not files.
 *
 *  KEYING INVARIANT (load-bearing): Drive guarantees `change.fileId ===
 *  change.file.id` — a change names the file it is about. The mirror stores each
 *  upsert under `projection.remote_id = 'id'` (= `file.id`), so keying BOTH
 *  removals and upserts on `fileId` (falling back to `file.id`) means a
 *  `removed_keys` value always equals the stored mirror key — the runner's direct
 *  ID-keyed delete lands on the right row. (An end-to-end runner test pins this;
 *  the `?? file.id` fallbacks are belt-and-suspenders for an id-less change.) */
const googleClassify: Classify = (item) => {
  if (item === null || typeof item !== 'object') return { kind: 'skip' };
  const change = item as Record<string, unknown>;
  const fileId = readNonEmptyString(change.fileId);
  const fileRaw = change.file;
  const file =
    fileRaw !== null && typeof fileRaw === 'object' && !Array.isArray(fileRaw)
      ? (fileRaw as Record<string, unknown>)
      : undefined;
  const removed = change.removed === true;
  const trashed = file !== undefined && file.trashed === true;
  if (removed || trashed) {
    // A removal — key on `fileId` (always present on a file change), falling back
    // to the file's own `id`. An id-less tombstone is unmatchable (the full walk
    // backstops it) → skip.
    const id = fileId ?? readNonEmptyString(file?.id);
    return id !== undefined ? { kind: 'deleted', id } : { kind: 'skip' };
  }
  if (file === undefined) return { kind: 'skip' }; // a drive-only change — no file to upsert
  if (file.mimeType === GOOGLE_FOLDER_MIME) return { kind: 'skip' }; // not a file — skip
  const id = fileId ?? readNonEmptyString(file.id);
  return id !== undefined ? { kind: 'file', id, row: file } : { kind: 'unkeyed', row: file };
};

/** Push the non-folder, non-trashed file entries from one `files.list` page into
 *  `rows`. The `q` already excludes folders + trashed, but skip them defensively
 *  — a `q` typo must never leak them into the mirror. */
const collectFileEntries = (files: unknown[], rows: Record<string, unknown>[]): void => {
  for (const raw of files) {
    if (raw === null || typeof raw !== 'object') continue;
    const file = raw as Record<string, unknown>;
    if (file.mimeType === GOOGLE_FOLDER_MIME) continue;
    if (file.trashed === true) continue;
    rows.push(file);
  }
};

const classifyGoogleError = (err: unknown): FileSourceListOutcome => {
  if (err instanceof GoogleError) {
    const kind: 'config' | 'policy' | 'error' =
      err.status === 401 ? 'config' : err.status === 403 ? 'policy' : 'error';
    return { ok: false, kind, reason: err.message };
  }
  return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
};

/** Drive's page-token-RESET signal. A `changes.list` continue from an invalid /
 *  expired token returns one of a small set of CLIENT errors — 400 ("Invalid
 *  Value" / "invalid page token", the usual case), 404, or 410 Gone — and the
 *  message is not reliably distinctive, so the leaf keys off the STATUS. The
 *  correct recovery is a fresh from-scratch full walk, so it falls back
 *  transparently (the runner never sees the reset). A false-positive is SAFE (the
 *  full walk is self-correcting — it re-lists + re-mints a token); the failure to
 *  AVOID is a false-negative that replays a dead token forever, so we accept the
 *  broad 400 (on a delta the page token is the only caller-supplied input, so a
 *  400 there is a token problem by construction).
 *
 *  Deliberately NARROW to {400, 404, 410}: auth (401) / permission (403) are real
 *  credential/scope issues a full walk hits identically (classify cleanly), and
 *  the OTHER 4xx transients — 429 rate-limit, 408 timeout — must NOT escalate to
 *  a full walk (which only makes MORE calls under throttling); they retry the
 *  delta as `error` with the cursor held. A 5xx likewise retries as `error`. */
const isGooglePageTokenReset = (err: unknown): boolean =>
  err instanceof GoogleError &&
  (err.status === 400 || err.status === 404 || err.status === 410);

/** Build the `google` `FileSourceListFn` leaf. */
export const buildGoogleFileSourceLeaf = (deps: FileSourceLeafDeps): FileSourceListFn => {
  const startPageTokenUrl = `${DRIVE_API}/changes/startPageToken?${qs({
    supportsAllDrives: 'true',
  })}`;
  const filesListUrl = (pageToken?: string): string =>
    `${DRIVE_API}/files?${qs({
      q: `trashed = false and mimeType != '${GOOGLE_FOLDER_MIME}'`,
      fields: `nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`,
      pageSize: String(DRIVE_PAGE_SIZE),
      spaces: 'drive',
      corpora: 'allDrives',
      ...ALL_DRIVES_PARAMS,
      ...(pageToken !== undefined ? { pageToken } : {}),
    })}`;
  const changesListUrl = (pageToken: string): string =>
    `${DRIVE_API}/changes?${qs({
      pageToken,
      fields: `nextPageToken,newStartPageToken,changes(removed,fileId,file(${DRIVE_FILE_FIELDS}))`,
      pageSize: String(DRIVE_PAGE_SIZE),
      spaces: 'drive',
      includeRemoved: 'true',
      ...ALL_DRIVES_PARAMS,
    })}`;

  // A FULL walk — capture a fresh start-page token BEFORE listing (Google's rule
  // so a change during the walk is replayed next cycle, never lost), then drain
  // `files.list` to exhaustion. The present-set + absence-delete authority. This
  // is NOT an id-keyed delta (a different endpoint), so it stays local — the
  // sibling paged-list pattern. Catches its own HTTP errors → outcome.
  //
  // NOTE on the delete model: a full walk that lists a NEAR-EMPTY set (e.g. a
  // token whose Drive scope was downgraded to `drive.file`, which returns only
  // app-created files as a well-formed 200) would drive the absence-delete diff
  // to wipe the whole mirror. The enrollment guarantees `drive.readonly` (full
  // read) precisely so the present-set is complete; a scope downgrade is an
  // enrollment concern (D-194), inherent to the full-walk delete model (S3 /
  // OneDrive share it).
  const fullWalk = async (token: string): Promise<FileSourceListOutcome> => {
    let startToken: string | undefined;
    const rows: Record<string, unknown>[] = [];
    let drain: PagedListDrain;
    try {
      // Up-front watermark — the token that will drive the NEXT cycle's delta.
      startToken = parseStartPageToken(await googleGet(deps.fetchImpl, startPageTokenUrl, token));
      // Drain `files.list` to exhaustion via the shared paged-list primitive —
      // `ref === ''` is the first page (no page token); a non-empty `ref` is a
      // `nextPageToken`. The primitive follows the token + folds `incompleteSearch`
      // into `complete` (sticky), or throws on a malformed page.
      drain = await drainPagedList(
        {
          fetchPage: (ref) =>
            googleGet(deps.fetchImpl, filesListUrl(ref === '' ? undefined : ref), token),
          parsePage: parseFilesPagedPage,
        },
        '',
      );
    } catch (err) {
      return classifyGoogleError(err);
    }
    collectFileEntries(drain.entries, rows);
    // `drain.complete` is TRUE only when no page reported `incompleteSearch` —
    // Drive's signal that it could NOT fully execute the query (a partial set with
    // no pagination token); a `complete: false` full walk still upserts what it saw
    // but suppresses the runner's absence-deletes (fail-closed). The up-front token
    // stays the watermark (it is valid — the delta can still progress from it;
    // absent ⇒ null → full re-list next cycle).
    return {
      ok: true,
      walk: 'full',
      rows,
      complete: drain.complete,
      next_cursor: startToken ?? null,
      scope: null,
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
        reason: `google credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
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
        reason: `google connection '${request.connection_name}' has no usable access token`,
      };
    }
    // NOTE: `import_scope` is NOT honored for Drive in v1 — with no native path
    // there is no per-row glob to filter against, and Drive scopes by folder id
    // (not a path glob), so the leaf returns `scope: null` and mirrors the whole
    // accessible Drive. The D-194 capability-binding adds folder-scoped narrowing.

    // The runner passes `null` to force a FULL walk (first boot / periodic delete
    // re-baseline), or the stored page token for a cheap DELTA walk.
    if (request.cursor === null || request.cursor === undefined) {
      return fullWalk(token);
    }
    // The DELTA walk rides the shared ID-keyed kernel: drain `changes.list` from
    // the stored page token, folding `removed`/`trashed` items into `removed_keys`
    // (Option 3) and honoring the undrained-suppression invariant. `fetchPage`
    // builds the `changes.list` URL from the page-token `ref` (the stored token,
    // then each `nextPageToken`).
    const kdeps: IdKeyedDeltaDeps = {
      fetchPage: (ref) => googleGet(deps.fetchImpl, changesListUrl(ref), token),
      parsePage: parseChangesPage,
      classify: googleClassify,
    };
    try {
      return shapeDeltaOutcome(await drainIdKeyedDelta(kdeps, request.cursor), null);
    } catch (err) {
      // An invalidated page token (400/404/410 on the delta) recovers by a fresh
      // from-scratch full walk THIS cycle (the leaf returns `walk: 'full'`); any
      // other error is classified + retried.
      if (isGooglePageTokenReset(err)) return fullWalk(token);
      return classifyGoogleError(err);
    }
  };
};
