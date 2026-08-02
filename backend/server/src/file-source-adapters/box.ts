/** D-192 file SOURCE family — the Box adapter leaf.
 *
 *  Satisfies `FileSourceListFn` for the `box` vendor — the THIRD ID-keyed delta
 *  vendor (after OneDrive + Google): a Box `/2.0/events` `ITEM_TRASH` carries the
 *  item `id` directly, so the runner deletes the mirror key through `removed_keys`.
 *
 *  Box splits full vs delta across TWO mechanisms, and the FULL walk is the
 *  meaty un-generalizable part — Box has NO flat "list all files" endpoint:
 *   - `request.cursor === null` ⇒ a FULL walk. First capture the current events
 *     `stream_position` (`?stream_position=now`) BEFORE listing — so a change
 *     landing DURING the walk replays next cycle, never lost — then RECURSE the
 *     folder tree from the root (or `config.folder_id`) via
 *     `/2.0/folders/{id}/items` (marker-paginated), collecting file entries and
 *     descending into folders. The recursion is the present-set + absence-delete
 *     authority (`walk: 'full'`, `complete: true` once the whole tree drained
 *     without error); the up-front stream position rides back as `next_cursor`.
 *   - a stored stream position ⇒ a DELTA walk on the shared ID-keyed kernel
 *     (`id-keyed-delta.ts`): drain `/2.0/events` from the stored position (poll
 *     until an empty chunk = caught up), classifying each event's `source` —
 *     `ITEM_TRASH` / trashed status → `removed_keys`, other item events → upserts.
 *     An invalidated position (HTTP 400 / 404) falls back to a full walk.
 *
 *  A file SOURCE lists FILES: folder + `web_link` entries never enter `rows`
 *  (folders drive the recursion; their removals reconcile at the periodic full
 *  re-baseline — the hybrid delete model). A Box item's `name` IS the leaf
 *  filename and `id` the stable mirror key; Box exposes `path_collection` (the
 *  ancestor folders), so the leaf synthesizes a canonical `/`-anchored `path` the
 *  declaration maps (unlike Drive, which has none).
 *
 *  Scope: `config.folder_id` bounds the full-walk ROOT to a subtree, and the
 *  delta enforces the same bound (an event whose file is not under `folder_id` is
 *  skipped); the optional `import_scope` path glob narrows further CLIENT-SIDE
 *  (Box has no server-side path filter — `supports_prefix: false`).
 *
 *  ⚠ Box's user events feed is looser than Drive's `changes` (a too-old position
 *  can gap, retention is bounded) — so the delta is best-effort and the periodic
 *  full re-walk (the delete authority) is what makes the mirror eventually
 *  correct. Auth: an OAuth bearer resolved from the connection's decrypted auth
 *  (`oauth2_refresh` `current_access_token`, refreshed within the lead window
 *  BEFORE this leaf runs; Box rotates the refresh token single-use). */

import { parseImportScopeConfig, resolveBearerAccessToken, type ImportScope } from '@recued/contracts';

import type {
  FileSourceListFn,
  FileSourceListOutcome,
} from '../file-source-sync.js';
import { readProviderStringContinuation } from '../provider-pagination-guard.js';
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
import { fetchFileSourceApi } from './http-json.js';
import { drainPagedList, type PagedListPage } from './paged-list.js';

const BOX_API = 'https://api.box.com/2.0';
/** Box's root folder ("All Files") id — the default full-walk root, and the
 *  `path_collection` entry the path synthesizer skips. */
const BOX_ROOT_FOLDER_ID = '0';
/** The item field selection for the folder walk (the exact fields the projection
 *  + the path synthesis read; no bytes — metadata only). The events feed carries
 *  its own default source representation (no `fields` param), which includes the
 *  same core fields. */
const BOX_ITEM_FIELDS =
  'id,name,type,size,modified_at,etag,sha1,path_collection,owned_by,item_status';
const BOX_FOLDER_PAGE_LIMIT = 1000;
const BOX_EVENTS_LIMIT = 500;
/** Defensive ceiling on `/2.0/events` polls per delta drain. Box terminates on
 *  an EMPTY chunk (no guaranteed terminal token like the other vendors' cursors),
 *  so a stuck stream position that never advances could otherwise spin unbounded.
 *  Far above any real cycle (× the 500-event limit = 500k events); exceeding it
 *  fails the cycle CLOSED (`error` → retry with the cursor held; the periodic full
 *  walk re-baselines). */
const BOX_MAX_EVENT_POLLS = 1000;
/** The Box event that trashes an item (a removal). */
const BOX_TRASH_EVENT = 'ITEM_TRASH';

/** Carries a Box HTTP status so the classifier can split auth (401 → `config`)
 *  from permission (403 → `policy`) from an invalidated stream position (400/404
 *  on a delta → full fallback) from a transient failure (5xx → `error`). */
class BoxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BoxError';
  }
}

/** Build a `?k=v&…` query string with each value URL-encoded. */
const qs = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

/** Best-effort error message from a Box error body (diagnostic only — the
 *  classifier keys off STATUS). Box errors carry `{ message, code, ... }`. */
const boxErrorMessage = (text: string): string => {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body?.message === 'string' ? body.message : text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
};

const boxGet = async (fetchImpl: FileFetch, url: string, token: string): Promise<unknown> => {
  const res = await fetchFileSourceApi(fetchImpl, url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new BoxError(res.status, `box GET failed: ${res.status} ${boxErrorMessage(text)}`);
  }
  return res.json();
};

/** Fetch the raw response TEXT (not JSON). The events endpoint MUST use this,
 *  never `boxGet` — Box's `next_stream_position` is a JSON number ~1.15e18, past
 *  2^53, so `res.json()` (JSON.parse) would SILENTLY TRUNCATE it to the nearest
 *  double BEFORE any of our code sees it, corrupting every delta cursor (→ a 400
 *  reset-loop, or events skipped between the true and rounded position = missed
 *  deletes up to the full-walk cadence). We parse the entries from the text but
 *  read the position out as a digit STRING (`extractStreamPosition`). */
const boxGetText = async (fetchImpl: FileFetch, url: string, token: string): Promise<string> => {
  const res = await fetchFileSourceApi(fetchImpl, url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  }, { responseMode: 'text' });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new BoxError(res.status, `box GET failed: ${res.status} ${boxErrorMessage(text)}`);
  }
  return text;
};

/** Read `next_stream_position` out of a raw events body as a full-precision
 *  digit STRING (Box returns it as an unquoted number > 2^53, so it must never
 *  round-trip through `JSON.parse`). The key is top-level + appears once in the
 *  Box events shape. Returns undefined when absent / non-integer. */
const extractStreamPosition = (text: string): string | undefined => {
  const m = /"next_stream_position"\s*:\s*"?(\d+)"?/.exec(text);
  return m !== null ? m[1] : undefined;
};

/** A non-empty string, or a number coerced to its string form (Box ids are
 *  strings, but coerce defensively so the accumulator key === the mirror's
 *  string `remote_id`). */
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : undefined;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** True when a Box item's `item_status` marks it gone (a trashed / deleted item
 *  that slipped into a listing or an event source). */
const isRemovedStatus = (item: Record<string, unknown>): boolean =>
  item.item_status === 'trashed' || item.item_status === 'deleted';

/** True when `item` lives under the folder `folderId` — its `path_collection`
 *  ancestors include that id. Used to enforce a `config.folder_id` bound on the
 *  account-wide events feed. A missing `path_collection` can't be confirmed
 *  in-scope, so it reads false (conservative — a bounded mirror never ingests an
 *  unconfirmed file). */
const isUnderFolder = (item: Record<string, unknown>, folderId: string): boolean => {
  const pc = asRecord(item.path_collection);
  const entries = pc !== undefined && Array.isArray(pc.entries) ? pc.entries : undefined;
  if (entries === undefined) return false;
  for (const e of entries) {
    const rec = asRecord(e);
    if (rec !== undefined && idOf(rec.id) === folderId) return true;
  }
  return false;
};

/** Synthesize the canonical `/`-anchored path for a Box item from its
 *  `path_collection` ancestors + its leaf `name`. The root folder ("All Files",
 *  id `0`) is skipped. Examples: a root-level `report.pdf` → `/report.pdf`; a
 *  file in `/A/B` → `/A/B/report.pdf`. Returns undefined — the path stays
 *  UNRESOLVED — when the item lacks a usable `name` or `path_collection` (the
 *  projector then omits `path`, and the runner keeps the row present-but-
 *  unlocatable rather than misfile it — the OneDrive posture). */
const boxPathOf = (item: Record<string, unknown>): string | undefined => {
  const name = idOf(item.name);
  if (name === undefined) return undefined;
  const pc = asRecord(item.path_collection);
  const entries = pc !== undefined && Array.isArray(pc.entries) ? pc.entries : undefined;
  if (entries === undefined) return undefined;
  const ancestors: string[] = [];
  for (const e of entries) {
    const rec = asRecord(e);
    if (rec === undefined) continue;
    if (idOf(rec.id) === BOX_ROOT_FOLDER_ID) continue; // skip the "All Files" root
    const nm = idOf(rec.name);
    if (nm !== undefined) ancestors.push(nm);
  }
  return `/${[...ancestors, name].join('/')}`;
};

// ────────────────────────────────────────────────────────────────
// DELTA — the ID-keyed events drain (rides Kernel A)
// ────────────────────────────────────────────────────────────────

/** Classify one Box event for the ID-keyed kernel. The event wraps a `source`
 *  item; only FILE sources matter (folder / web_link / non-item events → skip —
 *  folder removals reconcile at the periodic full re-baseline). An `ITEM_TRASH`
 *  event OR a trashed/deleted `item_status` is a removal (keyed by the file id);
 *  any other item event is an upsert (with a synthetic `path`). Under a
 *  `folderId` bound, an upsert whose file is not in that subtree is skipped so
 *  the account-wide feed stays consistent with the folder-rooted full walk;
 *  removals ride through (a delete for an unmirrored id is a harmless no-op). */
const makeBoxClassify = (folderId: string): Classify => (event) => {
  const ev = asRecord(event);
  if (ev === undefined) return { kind: 'skip' };
  const src = asRecord(ev.source);
  if (src === undefined || src.type !== 'file') return { kind: 'skip' };
  const id = idOf(src.id);
  if (ev.event_type === BOX_TRASH_EVENT || isRemovedStatus(src)) {
    return id !== undefined ? { kind: 'deleted', id } : { kind: 'skip' };
  }
  if (folderId !== BOX_ROOT_FOLDER_ID && !isUnderFolder(src, folderId)) return { kind: 'skip' };
  const path = boxPathOf(src);
  const row = path !== undefined ? { ...src, path } : { ...src };
  return id !== undefined ? { kind: 'file', id, row } : { kind: 'unkeyed', row };
};

/** Parse + STRICTLY validate one `/2.0/events` page (raw TEXT — see `boxGetText`)
 *  into the kernel's `DeltaPage`. The entries come from `JSON.parse` (their ids
 *  are strings — no precision issue); the `next_stream_position` is read out of
 *  the raw text as a digit string (`extractStreamPosition`, past-2^53 safe). A
 *  well-formed response carries an `entries` array + a `next_stream_position`
 *  (Box's resume point, ALWAYS present); a malformed shape throws (fail-closed —
 *  never a silent complete-empty walk). The drain polls until an EMPTY chunk
 *  (caught up): a non-empty page rides `nextRef` (poll again from this position),
 *  an empty page sets `watermark` (the terminal caught-up position). */
const parseEventsPage = (rawText: unknown): DeltaPage => {
  if (typeof rawText !== 'string') throw new BoxError(0, 'box events response is not text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new BoxError(0, 'box events response is not valid JSON');
  }
  const obj = asRecord(parsed);
  if (obj === undefined) throw new BoxError(0, 'box events response is not an object');
  if (!Array.isArray(obj.entries)) throw new BoxError(0, 'box events response has no entries array');
  const pos = extractStreamPosition(rawText);
  if (pos === undefined) throw new BoxError(0, 'box events response has no next_stream_position');
  return obj.entries.length === 0
    ? { items: obj.entries, watermark: pos }
    : { items: obj.entries, nextRef: pos };
};

// ────────────────────────────────────────────────────────────────
// FULL — the bespoke folder-tree recursion (Box has no flat list)
// ────────────────────────────────────────────────────────────────

interface FolderItemsPage {
  entries: unknown[];
  /** Box marker-pagination `next_marker` — present iff another page follows. */
  nextMarker: string | undefined;
}

/** Parse + STRICTLY validate one `/2.0/folders/{id}/items` page. A well-formed
 *  response carries an `entries` array; a missing one throws (fail-closed).
 *  Marker pagination: `next_marker` (non-empty string) ⇒ another page, absent ⇒
 *  this folder is drained. */
const parseFolderItemsPage = (res: unknown): FolderItemsPage => {
  const obj = asRecord(res);
  if (obj === undefined) throw new BoxError(0, 'box folder items response is not an object');
  if (!Array.isArray(obj.entries)) throw new BoxError(0, 'box folder items response has no entries array');
  return {
    entries: obj.entries,
    nextMarker: readProviderStringContinuation(
      obj.next_marker,
      'Box folder items',
    ),
  };
};

/** Map one `/2.0/folders/{id}/items` page into the shared paged-list page shape,
 *  reusing the strict `parseFolderItemsPage` validator (it throws on a malformed
 *  shape). Box's `next_marker` is BOTH the more-results signal (`hasMore`) and the
 *  continuation (`nextRef`) — one value, so the primitive's malformed-pagination
 *  case (`hasMore` without `nextRef`) can never arise here and `drain.complete` is
 *  always true. A folder's completeness comes purely from the entry classification
 *  in the DFS (an id-less / unknown-type child sinks `incomplete`), NOT this
 *  pagination — so the caller ignores `drain.complete`. */
const parseFolderItemsPagedPage = (raw: unknown): PagedListPage => {
  const page = parseFolderItemsPage(raw);
  return {
    entries: page.entries,
    hasMore: page.nextMarker !== undefined,
    ...(page.nextMarker !== undefined ? { nextRef: page.nextMarker } : {}),
  };
};

const classifyBoxError = (err: unknown): FileSourceListOutcome => {
  if (err instanceof BoxError) {
    const kind: 'config' | 'policy' | 'error' =
      err.status === 401 ? 'config' : err.status === 403 ? 'policy' : 'error';
    return { ok: false, kind, reason: err.message };
  }
  return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
};

/** Box's stream-position-RESET signal — an invalid / garbage stream position on
 *  the delta returns a 400 ("Invalid Value") or 404. Recover by a fresh full
 *  walk (which re-mints the position). A false-positive is SAFE (the full walk is
 *  self-correcting); auth (401) / permission (403) classify cleanly, and a
 *  transient 5xx retries as `error` (not a reset). */
const isBoxReset = (err: unknown): boolean =>
  err instanceof BoxError && (err.status === 400 || err.status === 404);

/** Whether a mid-walk folder error is a benign SKIP (a folder deleted mid-walk,
 *  or one the token can't read) vs a hard failure that must abort the cycle. A
 *  403/404 is skipped (that subtree stays as-is, and the walk reports
 *  `complete: false` so no absence-deletes run — fail-closed); anything else
 *  (401 auth, 5xx transient) aborts + retries. */
const isSkippableFolderError = (err: unknown): boolean =>
  err instanceof BoxError && (err.status === 403 || err.status === 404);

const readStringConfig = (config: Record<string, unknown>, field: string): string | undefined => {
  const v = config[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** Build the `box` `FileSourceListFn` leaf. */
export const buildBoxFileSourceLeaf = (deps: FileSourceLeafDeps): FileSourceListFn => {
  const eventsUrl = (streamPosition: string): string =>
    `${BOX_API}/events?${qs({
      stream_type: 'changes',
      stream_position: streamPosition,
      limit: String(BOX_EVENTS_LIMIT),
    })}`;
  const folderItemsUrl = (folderId: string, marker: string | undefined): string =>
    `${BOX_API}/folders/${encodeURIComponent(folderId)}/items?${qs({
      fields: BOX_ITEM_FIELDS,
      usemarker: 'true',
      limit: String(BOX_FOLDER_PAGE_LIMIT),
      ...(marker !== undefined ? { marker } : {}),
    })}`;

  /** The `?stream_position=now` probe → the current position as a full-precision
   *  digit string (past-2^53 safe — read from raw text, NOT JSON), or undefined on
   *  a malformed 200 (non-fatal: the walk proceeds with `next_cursor: null` → the
   *  next cycle full-walks again). HTTP errors throw upstream in `boxGetText`. */
  const streamPositionNow = async (token: string): Promise<string | undefined> =>
    extractStreamPosition(await boxGetText(deps.fetchImpl, eventsUrl('now'), token));

  // A FULL walk — the up-front events position, then a folder-tree recursion from
  // `folderId`. The present-set + absence-delete authority (`shapeFull` omits
  // removed_keys). A DFS over `/2.0/folders/{id}/items` (marker-paginated per
  // folder), collecting file entries + descending into folders; a `seen` set
  // guards against a pathological repeated-folder response. A benign per-folder
  // 403/404 is skipped + marks the walk INCOMPLETE (no absence-deletes run —
  // fail-closed); any other error aborts the cycle (retry).
  const fullWalk = async (
    token: string,
    folderId: string,
    scope: ImportScope | null,
  ): Promise<FileSourceListOutcome> => {
    const rows: Record<string, unknown>[] = [];
    let streamPosition: string | undefined;
    let incomplete = false;
    try {
      streamPosition = await streamPositionNow(token);
      const stack: string[] = [folderId];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const fid = stack.pop() as string;
        if (seen.has(fid)) continue;
        seen.add(fid);
        try {
          // Drain this folder's items to exhaustion via the shared paged-list
          // primitive — `ref === ''` is the first page (no marker); a non-empty
          // `ref` is a `next_marker`. Then classify each entry (files → rows,
          // subfolders → the DFS stack); `drain.complete` is always true for Box's
          // marker pagination (see `parseFolderItemsPagedPage`), so completeness
          // rides entirely on the entry classification below.
          const drain = await drainPagedList(
            {
              fetchPage: (ref) =>
                boxGet(deps.fetchImpl, folderItemsUrl(fid, ref === '' ? undefined : ref), token),
              parsePage: parseFolderItemsPagedPage,
            },
            '',
          );
          for (const entry of drain.entries) {
            const rec = asRecord(entry);
            // A non-object entry where a folder item should be (a malformed
            // `entries: [null]` / bare string) is UNDESCENDABLE — sink completeness,
            // matching every other undescendable case below (id-less folder,
            // unknown type). Fail-closed: a `complete: true` here would let the
            // runner absence-delete every file under a subtree we could not walk.
            if (rec === undefined) { incomplete = true; continue; }
            if (rec.type === 'file') {
              if (isRemovedStatus(rec)) continue; // a trashed item in a listing — skip (defensive)
              const path = boxPathOf(rec);
              rows.push(path !== undefined ? { ...rec, path } : { ...rec });
              continue;
            }
            if (rec.type === 'folder') {
              const sub = idOf(rec.id);
              if (sub !== undefined) stack.push(sub);
              // An id-less folder can't be descended — the walk is no longer
              // delete-authoritative over its subtree (fail closed).
              else incomplete = true;
              continue;
            }
            if (rec.type === 'web_link') continue; // definitively not a folder
            // A missing / unrecognized `type` could be an undescendable folder —
            // fail closed (sink completeness so absence-deletes never tombstone
            // an unwalked subtree).
            incomplete = true;
          }
        } catch (err) {
          // A folder gone mid-walk (404) or unreadable (403) is skipped, and the
          // walk is no longer delete-authoritative (that subtree is unproven).
          if (isSkippableFolderError(err)) {
            incomplete = true;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      return classifyBoxError(err);
    }
    return {
      ok: true,
      walk: 'full',
      rows,
      // `complete` only when EVERY folder drained — a skipped subtree sinks it so
      // the runner's absence-delete diff never tombstones an unwalked file.
      complete: !incomplete,
      next_cursor: streamPosition ?? null,
      scope,
    };
  };

  return async (request) => {
    // Credential resolution can throw (a locked vault / bad AEAD key) — a
    // transient `error` the scheduler retries, never a thrown cycle.
    let cred: FileConnectionCredential | null;
    try {
      cred = await deps.resolveConnection(request.connection_name);
    } catch (err) {
      return {
        ok: false,
        kind: 'error',
        reason: `box credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
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
        reason: `box connection '${request.connection_name}' has no usable access token`,
      };
    }
    // Fork A escape hatch — the optional `import_scope` glob (client-side, since
    // Box has no server-side path filter). Box HAS a synthesized path, so unlike
    // Drive the runner CAN glob-filter; the scope rides back in every outcome. A
    // malformed value fails closed to a `config` outcome.
    const parsedScope = parseImportScopeConfig(cred.config.import_scope);
    if (!parsedScope.ok) {
      return { ok: false, kind: 'config', reason: parsedScope.reason };
    }
    const scope: ImportScope | null = parsedScope.scope;
    // Optional `config.folder_id` bounds the full-walk ROOT + the delta's
    // in-scope filter; absent ⇒ the whole account from the root folder.
    const folderId = readStringConfig(cred.config, 'folder_id') ?? BOX_ROOT_FOLDER_ID;

    // The runner passes `null` to force a FULL walk (first boot / periodic delete
    // re-baseline), or the stored stream position for a cheap DELTA walk.
    if (request.cursor === null || request.cursor === undefined) {
      return fullWalk(token, folderId, scope);
    }
    // The DELTA rides the shared ID-keyed kernel — drain `/2.0/events` from the
    // stored position (poll until an empty chunk), folding `ITEM_TRASH` / trashed
    // sources into `removed_keys` (Option 3) with the undrained-suppression
    // invariant. `fetchPage` builds the events URL from the stream-position `ref`
    // and reads RAW TEXT (`boxGetText` — the position is a past-2^53 number that
    // must not round-trip through JSON), under a defensive poll cap.
    let eventPolls = 0;
    const kdeps: IdKeyedDeltaDeps = {
      fetchPage: (ref) => {
        if (eventPolls >= BOX_MAX_EVENT_POLLS) {
          throw new BoxError(0, `box events drain exceeded ${BOX_MAX_EVENT_POLLS} polls (stuck stream position?)`);
        }
        eventPolls += 1;
        return boxGetText(deps.fetchImpl, eventsUrl(ref), token);
      },
      parsePage: parseEventsPage,
      classify: makeBoxClassify(folderId),
    };
    try {
      return shapeDeltaOutcome(await drainIdKeyedDelta(kdeps, request.cursor), scope);
    } catch (err) {
      // An invalidated stream position (400/404) recovers by a fresh full walk
      // THIS cycle; any other error is classified + retried.
      if (isBoxReset(err)) return fullWalk(token, folderId, scope);
      return classifyBoxError(err);
    }
  };
};
