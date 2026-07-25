/** D-192 file SOURCE family (slice 5) — the S3 adapter leaf.
 *
 *  Satisfies `FileSourceListFn` for the `s3` vendor: a `ListObjectsV2` walk to
 *  exhaustion (paged via `ContinuationToken`), returning per-object metadata —
 *  never bytes. S3 has no native delta, so the declaration lists FULL each
 *  cycle (`list.mode: 'full'`); the meta-store's snapshot-hash skip keeps an
 *  unchanged re-list cheap.
 *
 *  Reuses the D-172 S3 client (`collections/file/adapters/s3`) — its SigV4
 *  signing, endpoint/path-style URL building (AWS virtual-host + R2 / MinIO /
 *  B2 path-style), and typed error surface — via the additive
 *  `listObjectsV2Page` (full metadata + `fetch-owner=true` + continuation),
 *  distinct from the client's keys-only `listObjects` that feeds the
 *  inbound-file event stream.
 *
 *  Two boundary nuances the leaf owns (§0's "what can't generalize"):
 *   - **Key → leaf filename** — an S3 `Key` is the whole path
 *     (`Work/report.pdf`); the shared projector reads declared fields verbatim,
 *     so the leaf normalizes each raw row with a synthetic `name` = the leaf
 *     segment (`report.pdf`), which the declaration's `projection.filename`
 *     reads, while `path` + `remote_id` keep the full `Key`.
 *   - **folder markers** — a zero-byte object whose key ends in `/` is a
 *     console-created directory placeholder, not a file; it is skipped.
 *
 *  `complete: true` ONLY when the follower reached a non-truncated page
 *  (`IsTruncated: false`). A truncated page with no continuation token (a
 *  malformed response) leaves the walk unproven → `complete: false`, so the
 *  reconciler's D-190 delete diff fail-closes.
 *
 *  Credentials: the access-key/secret pair rides the AEAD-encrypted `basic`
 *  auth (access_key = username, secret_key = password — the connection
 *  substrate has no dedicated access-key auth type; `basic` is the encrypted
 *  carrier). `region` / `bucket` / `endpoint` / `use_path_style` /
 *  `import_scope` are non-secret `config`. `import_scope` (slice 6, Fork A) is
 *  the user's optional path glob; its derived literal prefix is pushed to
 *  `ListObjectsV2 Prefix` (an S3 `Key` is the path, so this bounds the walk
 *  exactly), and the resolved scope rides back in the outcome for the runner's
 *  client-side glob filter + prefix-scoped delete diff.
 *
 *  Known limitation (SHARED D-172 machinery, not this leaf's to change): the
 *  reused `buildUrl` serializes query params through `URLSearchParams`, whose
 *  form-encoding diverges from SigV4's RFC-3986 canonical query for a few
 *  legal-but-uncommon prefix characters (space, `!`, `'`, `(`, `)`), so an
 *  `import_scope` whose literal prefix contains them can `SignatureDoesNotMatch`.
 *  Opaque base64
 *  continuation tokens are SAFE (their alphabet round-trips identically). The
 *  pre-existing D-172 `listObjects(prefix)` shares the gap; a proper fix is one
 *  AWS-canonical URI encoder across both the wire URL + the signed canonical
 *  query, tracked as a follow-on. */

import { parseImportScopeConfig, type ImportScope } from '@recued/contracts';

import {
  createS3Client,
  S3Error,
  type S3ClientConfig,
  type S3Fetch,
  type S3ObjectMeta,
} from '../collections/file/adapters/s3/client.js';
import type {
  FileSourceListFn,
  FileSourceListOutcome,
} from '../file-source-sync.js';
import type {
  FileConnectionCredential,
  FileSourceLeafDeps,
} from './index.js';
import { drainPagedList, type PagedListDrain, type PagedListPage } from './paged-list.js';

/** The leaf segment of an S3 key — `Work/sub/report.pdf` → `report.pdf`,
 *  `report.pdf` → `report.pdf`. Folder-marker keys (trailing `/`) are filtered
 *  before this runs, so the result is always non-empty. */
const leafOfKey = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

/** Map a `listObjectsV2Page` result (already typed + parsed by the D-172 client —
 *  a malformed body throws upstream in the client, so there is no JSON-shape check
 *  to do here) into the shared paged-list page shape: `IsTruncated` ⇒ `hasMore`,
 *  `NextContinuationToken` ⇒ `nextRef`. A truncated page carrying no token
 *  (`hasMore` without `nextRef`) is the primitive's malformed-pagination guard ⇒
 *  `complete: false`, exactly the prior `complete: !truncated`. No watermark — S3
 *  has no native delta (`cursor_kind: 'none'`), so it re-lists in full each cycle.
 *
 *  Normalize an empty / absent token to `undefined` — the primitive's contract is
 *  that a real `nextRef` is always a NON-EMPTY string (an empty `nextRef` collides
 *  with the `''` from-scratch sentinel in the fetch closure below → a re-fetch of
 *  page one instead of the malformed-pagination guard tripping). The D-172 client
 *  already drops empty tokens, but enforce it HERE too — matching the
 *  Google/Dropbox/Box mappers — so the guard never rides on a distant module. */
const parseS3ListPage = (raw: unknown): PagedListPage => {
  const page = raw as {
    objects: S3ObjectMeta[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  };
  const nextRef =
    typeof page.nextContinuationToken === 'string' && page.nextContinuationToken.length > 0
      ? page.nextContinuationToken
      : undefined;
  return {
    entries: page.objects,
    hasMore: page.isTruncated,
    ...(nextRef !== undefined ? { nextRef } : {}),
  };
};

const readStringConfig = (
  config: Record<string, unknown>,
  field: string,
): string | undefined => {
  const v = config[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

export type S3ConfigResult =
  | { ok: true; clientConfig: S3ClientConfig; scope: ImportScope | null }
  | { ok: false; reason: string };

/** Build the S3 client config from a resolved connection credential, or a
 *  config-failure reason. Fail-closed: a missing secret / region / bucket — or
 *  a malformed `import_scope` — is a stable-until-enrollment `config` outcome
 *  (never a thrown cycle). Exported so the D-192 remote byte-fetch resolver
 *  reuses the SAME auth/endpoint resolution the list walk used (no drift). */
export const s3ConfigFromConnection = (cred: FileConnectionCredential): S3ConfigResult => {
  if (cred.auth.type !== 'basic') {
    return {
      ok: false,
      reason:
        `s3 connection auth must be 'basic' (access_key = username, secret_key = password), got '${cred.auth.type}'`,
    };
  }
  const access_key = cred.auth.username;
  const secret_key = cred.auth.password;
  if (access_key.length === 0 || secret_key.length === 0) {
    return { ok: false, reason: 's3 connection is missing access_key / secret_key' };
  }
  const region = readStringConfig(cred.config, 'region');
  const bucket = readStringConfig(cred.config, 'bucket');
  if (region === undefined) return { ok: false, reason: 's3 connection config.region is required' };
  if (bucket === undefined) return { ok: false, reason: 's3 connection config.bucket is required' };
  const endpoint = readStringConfig(cred.config, 'endpoint');
  const use_path_style =
    typeof cred.config.use_path_style === 'boolean' ? cred.config.use_path_style : undefined;
  // Fork A escape hatch — the user's optional `import_scope` glob. Its derived
  // literal prefix is pushed to `ListObjectsV2` as `Prefix` (a safe
  // under-approximation of the glob — the runner narrows the rest client-side);
  // a malformed value fails closed to a `config` outcome.
  const parsedScope = parseImportScopeConfig(cred.config.import_scope);
  if (!parsedScope.ok) return { ok: false, reason: parsedScope.reason };
  return {
    ok: true,
    clientConfig: {
      access_key,
      secret_key,
      region,
      bucket,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(use_path_style !== undefined ? { use_path_style } : {}),
    },
    scope: parsedScope.scope,
  };
};

/** S3 `<Code>` values that mean "the credential / target is wrong" (a stable
 *  config outcome) vs a transient error the scheduler retries. `AccessDenied`
 *  is a permission gate → `policy`. */
const S3_CONFIG_CODES: ReadonlySet<string> = new Set([
  'SignatureDoesNotMatch',
  'InvalidAccessKeyId',
  'NoSuchBucket',
  'AllAccessDisabled',
  'InvalidRequest',
]);

const classifyS3ListError = (err: unknown): FileSourceListOutcome => {
  if (err instanceof S3Error) {
    const kind: 'config' | 'policy' | 'error' =
      err.code === 'AccessDenied'
        ? 'policy'
        : S3_CONFIG_CODES.has(err.code)
          ? 'config'
          : 'error';
    return { ok: false, kind, reason: `s3 ListObjectsV2 failed: ${err.message}` };
  }
  return { ok: false, kind: 'error', reason: err instanceof Error ? err.message : String(err) };
};

/** Build the `s3` `FileSourceListFn` leaf. */
export const buildS3FileSourceLeaf = (deps: FileSourceLeafDeps): FileSourceListFn => {
  // Adapt the injected `FileFetch` to the S3 client's `S3Fetch` (a subset —
  // the list walk is GET-only, so `body` is never populated here).
  const s3Fetcher: S3Fetch = (url, init) =>
    deps.fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body as string | Uint8Array } : {}),
    });

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
        reason: `s3 credential resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (cred === null) {
      return { ok: false, kind: 'config', reason: `connection '${request.connection_name}' not found` };
    }
    const built = s3ConfigFromConnection(cred);
    if (!built.ok) return { ok: false, kind: 'config', reason: built.reason };

    const client = createS3Client({
      config: built.clientConfig,
      fetcher: s3Fetcher,
      ...(deps.now ? { now: deps.now } : {}),
    });

    // Push the scope's derived literal prefix as `ListObjectsV2 Prefix` (empty
    // prefix = root ⇒ no filter). An S3 `Key` IS the path, so this bounds the
    // walk to exactly the subtree the runner's delete diff scopes deletes to.
    const pushPrefix =
      built.scope && built.scope.prefix.length > 0 ? built.scope.prefix : undefined;

    // Drain `ListObjectsV2` to exhaustion via the shared paged-list primitive —
    // `ref === ''` is the first page (no continuation token); a non-empty `ref` is
    // a `nextContinuationToken`. The prefix rides EVERY call (empty prefix = root).
    let drain: PagedListDrain;
    try {
      drain = await drainPagedList(
        {
          fetchPage: (ref) =>
            client.listObjectsV2Page({
              ...(pushPrefix !== undefined ? { prefix: pushPrefix } : {}),
              ...(ref !== '' ? { continuationToken: ref } : {}),
            }),
          parsePage: parseS3ListPage,
        },
        '',
      );
    } catch (err) {
      return classifyS3ListError(err);
    }

    const rows: Record<string, unknown>[] = [];
    for (const obj of drain.entries as S3ObjectMeta[]) {
      // Skip S3 "folder marker" objects — a ZERO-byte key ending in '/' is a
      // console-created directory placeholder, not a file. A trailing-slash key
      // carrying real bytes is a (weird but legal) object: keep it present so a
      // complete walk never tombstones it — it fails projection on its empty leaf
      // name (a recorded degraded row, never a false delete).
      if (obj.Key.endsWith('/') && (obj.Size ?? 0) === 0) continue;
      rows.push({ ...obj, name: leafOfKey(obj.Key) });
    }

    // `drain.complete` iff the walk reached a non-truncated page. A truncated page
    // that carried no continuation token sinks it → `complete: false` (fail-closed:
    // the reconciler will not tombstone). `scope` (may be null) rides back so the
    // runner client-side filters the walked rows through the full glob + scopes its
    // delete diff to the prefix. Always `walk: 'full'` — S3 has no native delta
    // (`cursor_kind: 'none'`), so it re-lists the whole (scoped) tree every cycle
    // and stays the delete authority; `request.cursor` is never set for `full`.
    return { ok: true, walk: 'full', rows, complete: drain.complete, scope: built.scope };
  };
};
