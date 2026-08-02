/** D-192 file SOURCE family — the OneDrive (Microsoft Graph) adapter leaf.
 *
 *  Satisfies `FileSourceListFn` for the `onedrive` vendor via MS Graph's
 *  `/delta` changes feed — the FIRST ID-keyed delta vendor (its delete
 *  tombstones carry the item `id` directly, so the runner deletes the mirror key
 *  through `removed_keys`, not the path reverse-lookup Dropbox needs).
 *
 *  Rides the shared ID-keyed delta kernel (`id-keyed-delta.ts`): the accumulator,
 *  the drain loop, and the fail-closed shaping (last-occurrence-wins,
 *  undrained-suppression) are the kernel's; this leaf supplies only the three
 *  things that can't generalize — how a `/delta` page parses (`parseGraphDeltaPage`),
 *  how a driveItem classifies (`oneDriveClassify`), and the authenticated GET.
 *
 *  OneDrive rides `full_then_delta` with `cursor_kind: 'delta_link'`. Both walks
 *  use the SAME `/delta` mechanism; only the START ref differs, so both are the
 *  same kernel drain:
 *   - `request.cursor === null` ⇒ a FULL walk: `/me/drive/root/delta` (or
 *     `/drives/{drive_id}/root/delta`) from scratch, following `@odata.nextLink`
 *     to the terminal `@odata.deltaLink`. A from-scratch delta returns the whole
 *     current present-set (and NO `deleted` tombstones — there is no prior
 *     baseline to have removed against), so this is the absence-delete authority
 *     (`shapeFullFromDeltaDrain` → `walk: 'full'`, `complete: true` once a
 *     `deltaLink` is reached). That `deltaLink` rides back as `next_cursor` — the
 *     watermark for next cycle.
 *   - a stored `deltaLink` ⇒ a DELTA walk: GET that URL directly, draining
 *     `@odata.nextLink` pages to the next `@odata.deltaLink`. Changed file items
 *     ride back in `rows` (upserts); items carrying a `deleted` facet ride back
 *     in `removed_keys` (their `id`) as EXPLICIT removals the runner tombstones
 *     THIS cycle (Option 3). A `resyncRequired` (HTTP 410) invalidated watermark
 *     falls back to a full walk transparently (the runner never sees it).
 *
 *  A file SOURCE lists FILES: an item is kept ONLY if it carries a `file` facet
 *  (`file.mimeType`); `folder` items (incl. the drive root), `package`/
 *  `remoteItem`/other facets, and `deleted` tombstones never enter `rows`. A
 *  Graph driveItem's `name` IS the leaf filename and `id` is the stable item id
 *  (the mirror key), so the projector reads those verbatim; the ONE
 *  normalization the leaf owns (§0's "what can't generalize") is the canonical
 *  `path` — Graph exposes only `parentReference.path`, the PARENT with a
 *  `/drive/root:` namespace prefix and URL-encoding, so the leaf strips the
 *  prefix, decodes it, and appends the leaf `name` onto a synthetic `path` field
 *  the declaration maps (mirrors S3's synthetic `name`).
 *
 *  Scope (Fork A): `supports_prefix: false` — `/delta` is a whole-drive feed
 *  with no server-side path filter, so the leaf pushes NOTHING down; it parses
 *  `import_scope` only to ride the resolved scope back for the runner's
 *  client-side glob filter (the runner walks the whole drive, then narrows).
 *
 *  Auth: an OAuth bearer resolved from the connection's decrypted auth
 *  (`bearer` or the `current_access_token` of an `oauth2_refresh` row; the
 *  file-source connection resolver refreshes it within the lead window BEFORE
 *  this leaf runs). A 401 surfaces as a `config` outcome the scheduler records +
 *  retries (a token expiring mid-drain — a rare very-long delta — is the same
 *  retryable `config`, replayed with a fresh token next cycle). */

import { parseImportScopeConfig, resolveBearerAccessToken, type ImportScope } from '@recued/contracts';

import type {
  FileSourceListFn,
  FileSourceListOutcome,
} from '../file-source-sync.js';
import {
  drainIdKeyedDelta,
  shapeDeltaOutcome,
  shapeFullFromDeltaDrain,
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
import {
  assertProviderPageUrl,
  readProviderStringContinuation,
} from '../provider-pagination-guard.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';
/** The `/drive/root:` (or `/drives/{id}/root:`) namespace marker Graph prefixes
 *  onto every `parentReference.path`; everything after it is the real path. */
const GRAPH_ROOT_MARKER = 'root:';

/** Carries a Graph HTTP status + parsed error code so the classifier can split
 *  auth (401 → `config`) from permission (403 → `policy`) from a resync-required
 *  watermark (410 / `resyncRequired` → full fallback) from a transient failure. */
class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Parse + STRICTLY validate one `/delta` page into the kernel's `DeltaPage`. A
 *  well-formed response always carries a `value` array; coercing a
 *  missing/mistyped `value` to `[]` would let a `{}` body, a schema drift, or a
 *  proxy-corrupted 200 masquerade as a COMPLETE empty walk — which the delete diff
 *  would act on (false-deleting every mirrored file). Fail closed: a malformed
 *  shape throws → an `error` outcome the scheduler retries, never a silent
 *  complete walk. `@odata.nextLink` → `nextRef` (a full URL the kernel GETs
 *  directly); `@odata.deltaLink` → `watermark` (both optional; a page has at most
 *  one). */
const parseGraphDeltaPage = (res: unknown): DeltaPage => {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new GraphError(0, undefined, 'graph /delta response is not an object');
  }
  const obj = res as Record<string, unknown>;
  if (!Array.isArray(obj.value)) {
    throw new GraphError(0, undefined, 'graph /delta response has no value array');
  }
  const nextRef = readProviderStringContinuation(
    obj['@odata.nextLink'],
    'OneDrive',
  );
  const watermark = readProviderStringContinuation(
    obj['@odata.deltaLink'],
    'OneDrive watermark',
  );
  return {
    items: obj.value,
    ...(nextRef !== undefined ? { nextRef } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
  };
};

const parseTrustedGraphDeltaPage = (res: unknown): DeltaPage => {
  const page = parseGraphDeltaPage(res);
  if (page.nextRef !== undefined) {
    assertProviderPageUrl(page.nextRef, GRAPH_API, 'OneDrive');
  }
  if (page.watermark !== undefined) {
    assertProviderPageUrl(page.watermark, GRAPH_API, 'OneDrive');
  }
  return page;
};

/** Pull `error.code` from a Graph error body (best-effort) so `resyncRequired`
 *  can be detected even on a non-410 status. */
const graphErrorCode = (text: string): string | undefined => {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

const graphGet = async (fetchImpl: FileFetch, url: string, token: string): Promise<unknown> => {
  const safeUrl = assertProviderPageUrl(url, GRAPH_API, 'OneDrive');
  const res = await fetchFileSourceApi(fetchImpl, safeUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GraphError(res.status, graphErrorCode(text), `graph GET failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
};

/** Decode a Graph URL-encoded path segment (`parentReference.path` percent-
 *  encodes spaces + specials); a malformed sequence falls back to the raw string
 *  (never throws — a leaf is contractually no-throw once past the fetch). */
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Synthesize the canonical `/`-anchored path for a driveItem from its
 *  `parentReference.path` (the PARENT, `/drive/root:/A/B` or `/drives/{id}/root:`
 *  at the drive root) + its leaf `name`. Strips the namespace prefix up to and
 *  including `root:`, decodes it, and appends `/name`. Examples: root file
 *  `report.pdf` (parent `/drive/root:`) → `/report.pdf`; `/drive/root:/Docs/Work`
 *  parent → `/Docs/Work/report.pdf`.
 *
 *  Returns undefined — the path stays UNRESOLVED — when the item lacks a usable
 *  `name` OR its `parentReference.path` is absent/non-string. A Graph `/delta`
 *  item MAY omit `parentReference.path` (shared items, certain delta states), and
 *  fabricating `/name` there would misfile a NESTED file as root-level: under an
 *  `import_scope` that false-drops it, and on a full walk (the delete authority)
 *  it would then be absent from `polledKeys` while its prior in-scope mirror row
 *  is still a delete candidate → a FALSE DELETE. Undefined is honest: the
 *  projector omits `path`, and the runner treats a path-unreadable row as
 *  PRESENT-but-unlocatable (kept in `polledKeys`, never tombstoned). A
 *  genuinely-root item still resolves — it DOES carry `parentReference.path =
 *  '/drive/root:'` (a present string → `/name`). */
const graphPathOf = (item: Record<string, unknown>): string | undefined => {
  const name = item.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const parent = item.parentReference;
  const parentPath =
    parent !== null && typeof parent === 'object'
      ? (parent as Record<string, unknown>).path
      : undefined;
  if (typeof parentPath !== 'string') return undefined;
  const i = parentPath.indexOf(GRAPH_ROOT_MARKER);
  const rel = i >= 0 ? parentPath.slice(i + GRAPH_ROOT_MARKER.length) : parentPath;
  return `${safeDecode(rel)}/${name}`;
};

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Classify one Graph driveItem — the OneDrive per-item essence the kernel folds.
 *  A `deleted` facet (`{ state: 'deleted' }`) is an ID-keyed removal, guarded
 *  FIRST so an item carrying both facets is a removal; a `file` facet is an upsert
 *  (with a synthetic canonical `path`); folders / the root / packages / other
 *  facets are not files. An id-less tombstone is unmatchable (`skip` — the full
 *  walk backstops it); an id-less file is `unkeyed` (kept as-is, counted). */
const oneDriveClassify: Classify = (item) => {
  if (item === null || typeof item !== 'object') return { kind: 'skip' };
  const it = item as Record<string, unknown>;
  const id = nonEmptyString(it.id);
  if (it.deleted !== undefined && it.deleted !== null) {
    return id !== undefined ? { kind: 'deleted', id } : { kind: 'skip' };
  }
  if (it.file === undefined || it.file === null) return { kind: 'skip' };
  const path = graphPathOf(it);
  const row = path !== undefined ? { ...it, path } : { ...it };
  return id !== undefined ? { kind: 'file', id, row } : { kind: 'unkeyed', row };
};

const classifyGraphError = (err: unknown): FileSourceListOutcome => {
  if (err instanceof GraphError) {
    const kind: 'config' | 'policy' | 'error' =
      err.status === 401 ? 'config' : err.status === 403 ? 'policy' : 'error';
    return { ok: false, kind, reason: err.message };
  }
  return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
};

/** Graph's watermark-RESET signal — a `/delta` continue from a too-old / invalid
 *  `deltaLink` returns HTTP 410 Gone whose body carries a `resync*` error code
 *  (`resyncRequired` / `resyncChangesApplyDifferences` /
 *  `resyncChangesUploadDifferences`). The correct recovery is a fresh
 *  from-scratch `/delta`, so the leaf falls back to a full walk transparently
 *  (the runner never sees the reset). Primary signal is the 410 STATUS; the code
 *  match (any `resync*`) is a defensive secondary in case a proxy rewrites the
 *  status. */
const isGraphResync = (err: unknown): boolean =>
  err instanceof GraphError &&
  (err.status === 410 || (err.code !== undefined && err.code.toLowerCase().includes('resync')));

const readStringConfig = (config: Record<string, unknown>, field: string): string | undefined => {
  const v = config[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** Build the Microsoft Graph `/delta` `FileSourceListFn` leaf. Serves BOTH the
 *  `onedrive` vendor (default) and the `sharepoint` vendor — a SharePoint
 *  document library is a Graph drive, so it rides this leaf verbatim, targeted
 *  by `config.drive_id` (`/drives/{drive_id}/root/delta`). `opts.vendorLabel`
 *  only flavors the credential/token error `reason` strings so a SharePoint
 *  connection's outcomes don't read "onedrive"; the walk is identical. */
export const buildOneDriveFileSourceLeaf = (
  deps: FileSourceLeafDeps,
  opts: { vendorLabel?: string } = {},
): FileSourceListFn => {
  const vendorLabel = opts.vendorLabel ?? 'onedrive';
  const rootDeltaUrl = (driveId: string | undefined): string =>
    driveId !== undefined
      ? `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/root/delta`
      : `${GRAPH_API}/me/drive/root/delta`;

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
        reason: `${vendorLabel} credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
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
        reason: `${vendorLabel} connection '${request.connection_name}' has no usable access token`,
      };
    }
    // Fork A escape hatch — the user's optional `import_scope` glob. `/delta` has
    // no server-side path filter, so NOTHING is pushed down; `scope` rides back
    // in every outcome so the runner client-side filters each walked path through
    // the full glob (and, on a full walk, scopes the delete diff to the prefix).
    // A malformed value fails closed to a `config` outcome. NOTE: like the
    // Dropbox delta, an `import_scope` edit only takes full effect at the next
    // full re-baseline (the delta feed is whole-drive; the runner's client-side
    // filter narrows continuously, but the delete-scoping re-derives on the full
    // walk) — the accepted hybrid delete-lag.
    const parsedScope = parseImportScopeConfig(cred.config.import_scope);
    if (!parsedScope.ok) {
      return { ok: false, kind: 'config', reason: parsedScope.reason };
    }
    const scope: ImportScope | null = parsedScope.scope;
    // Optional `config.drive_id` targets a non-default drive (a SharePoint
    // document library / another user's drive); absent ⇒ the signed-in user's
    // default drive (`/me/drive`). Only affects the FULL walk's start URL — a
    // delta walk GETs the stored deltaLink, which already encodes the drive.
    const driveId = readStringConfig(cred.config, 'drive_id');

    // Both walks are the SAME kernel drain; only the start ref differs (a
    // from-scratch root URL for full, the stored deltaLink for delta). `fetchPage`
    // GETs the ref directly — every OneDrive ref (root URL / `@odata.nextLink` /
    // stored deltaLink) is already a full URL.
    const kdeps: IdKeyedDeltaDeps = {
      fetchPage: (ref) => graphGet(deps.fetchImpl, ref, token),
      parsePage: parseTrustedGraphDeltaPage,
      classify: oneDriveClassify,
    };

    // A FULL walk — a from-scratch `/delta` drain, the present-set + delete
    // authority (`shapeFullFromDeltaDrain` omits `removed_keys`). Catches its own
    // HTTP errors → outcome.
    const runFull = async (): Promise<FileSourceListOutcome> => {
      try {
        return shapeFullFromDeltaDrain(await drainIdKeyedDelta(kdeps, rootDeltaUrl(driveId)), scope);
      } catch (err) {
        return classifyGraphError(err);
      }
    };

    // The runner passes `null` to force a FULL walk (first boot / periodic delete
    // re-baseline), or the stored deltaLink watermark for a cheap DELTA walk.
    if (request.cursor === null || request.cursor === undefined) {
      return runFull();
    }
    try {
      return shapeDeltaOutcome(await drainIdKeyedDelta(kdeps, request.cursor), scope);
    } catch (err) {
      // A resync (410 / resyncRequired) recovers by a fresh from-scratch full
      // walk THIS cycle (the leaf returns `walk: 'full'`); any other error is
      // classified + retried.
      if (isGraphResync(err)) return runFull();
      return classifyGraphError(err);
    }
  };
};
