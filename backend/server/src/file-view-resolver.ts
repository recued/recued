/** D-192 Fork B — the unified `data.file.*` read resolver.
 *
 *  A file lands three ways, all converging on ONE `data.file` entity (design
 *  `docs/d-192-file-source-family.md` "three landing paths"):
 *    - reception / recipe-download / owner-upload → bytes in the CAS, a
 *      `data.file.received` COLLECTION record (`storage_ref:{kind:'cas'}`);
 *    - a vendor mirror (Dropbox / S3 / …) → META only, a `file_meta_ref`
 *      meta-store row (`storage_ref:{kind:'remote'}`), bytes NEVER fetched.
 *  Those two live in DIFFERENT stores (the collection registry vs the
 *  `FileMetaStore`). Fork B is one file entity kind, two storage postures: this
 *  resolver reads BOTH and projects each into one {@link DataFileView} so a
 *  single read surface (the mirror-search picker now; the timeline drill-down +
 *  MCP next) sees the whole file space. `storage_ref.kind` is the posture
 *  discriminator; the shared fields already align by design
 *  (`FileMetaProjection` ↔ `DataFileHotFields`).
 *
 *  The store-backed resolver mirrors the `data.contact` precedent (one core
 *  shared across surfaces), NOT a `CollectionRegistry` collection — a remote
 *  file has no bytes to serve, so it can never be a byte-reading `Collection`.
 *  Bytes stay CAS-only (North star): a remote view carries a `{provider,
 *  remote_id}` pointer, never a download.
 *
 *  Record-id scheme (the two postures share the `file:` entity space but stay
 *  distinguishable + reversible): a CAS record keeps its minted
 *  `file:<32hex>` id (`inboundFileRecordId`); a remote row gets a REVERSIBLE
 *  `file:remote:<b64url scope>:<b64url target_id>` id, so a by-id read
 *  (timeline / MCP) round-trips back to the `(scope, target_id)` meta-store key.
 *  base64url's alphabet carries no `:` / `/`, so the split is unambiguous, and
 *  `file:remote:` can never collide with the hex CAS pattern. */

import type { TimelineEntry } from '@recued/contracts';

import {
  isInboundFileRecordId,
  type DataFileRecord,
  type FileMediaClass,
  type FileOrigin,
  type FileScanStatus,
  type FileStorageRef,
} from './collections/file/inbound-file-collection.js';
import type { CollectionRegistry } from './collections/registry.js';
import type { FileMetaRow, FileMetaStore } from './storage/file-meta-store.js';
import {
  deriveFileSourceFreshness,
  type FileSourceFreshness,
  type FileSourceSyncStateStore,
} from './storage/file-source-sync-state.js';

/** The unified read row. `posture` = `storage_ref.kind`; remote-only fields
 *  (`path`/`mtime`/`owner`/`revision`) and cas-only fields (`content_hash`/
 *  `origin`/`scan_status`/`media_class`) are present per posture. `event_at`
 *  is the best available real-world time (remote: `mtime` → `snapshot_at`;
 *  cas: `received_at`) — the timeline `ts` + the picker's recency sort key. */
export interface DataFileView {
  record_id: string;
  posture: 'cas' | 'remote';
  storage_ref: FileStorageRef;
  filename: string;
  mime_type?: string;
  size?: number;
  // remote-only (no CAS analogue)
  path?: string;
  mtime?: number;
  owner?: string;
  revision?: string;
  provider?: string;
  // cas-only (no remote analogue)
  content_hash?: string;
  origin?: FileOrigin;
  scan_status?: FileScanStatus;
  media_class?: FileMediaClass;
  event_at?: number;
  /** D-192 Fork B hardening — remote-only: how current the Source's mirror is
   *  (from its sync-state row). Absent on a CAS row (bytes-in, not a sync
   *  mirror) and when the resolver has no sync-state store wired. */
  freshness?: FileSourceFreshness;
}

const REMOTE_ID_PREFIX = 'file:remote:';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** STRICT base64url decode. Node's `Buffer.from(x, 'base64url')` is permissive
 *  — it silently ignores stray non-alphabet chars (`Zm9v!` → `foo`) and accepts
 *  padding — so a malformed id could otherwise decode to a real key. We reject
 *  anything outside the canonical unpadded alphabet, then re-encode + require
 *  exact equality (catches length / padding aliases). `null` = not canonical. */
const unb64urlStrict = (enc: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(enc)) return null;
  const decoded = Buffer.from(enc, 'base64url').toString('utf8');
  return Buffer.from(decoded, 'utf8').toString('base64url') === enc ? decoded : null;
};

/** Mint the reversible `data.file` record id for a remote meta row keyed by
 *  `(scope, target_id)`. */
export const remoteFileRecordId = (scope: string, target_id: string): string =>
  `${REMOTE_ID_PREFIX}${b64url(scope)}:${b64url(target_id)}`;

/** Parse a `file:remote:<enc scope>:<enc target>` id back to its meta-store
 *  key, or `null` when it is not a remote id (a CAS `file:<hex>` id, or junk).
 *  Fail-closed: a malformed encoding (wrong part count, empty decode) → null. */
export const parseRemoteFileRecordId = (
  record_id: string,
): { scope: string; target_id: string } | null => {
  if (!record_id.startsWith(REMOTE_ID_PREFIX)) return null;
  // base64url has no ':' — exactly two parts, both non-empty.
  const parts = record_id.slice(REMOTE_ID_PREFIX.length).split(':');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  const scope = unb64urlStrict(parts[0]);
  const target_id = unb64urlStrict(parts[1]);
  if (scope === null || target_id === null || scope.length === 0 || target_id.length === 0) {
    return null;
  }
  return { scope, target_id };
};

const projectCas = (rec: DataFileRecord): DataFileView => {
  const h = rec.hot_fields;
  // A real CAS record always carries a hydrated storage_ref + filename; default
  // defensively so a partial / minimal record still surfaces to the picker
  // rather than crashing the whole search. `path` has no CAS analogue in
  // `DataFileHotFields` but is surfaced when present (forward-compat + the
  // picker's path sublabel).
  const storage_ref: FileStorageRef = rec.storage_ref ?? { kind: 'cas', blob_hash: '' };
  const path = typeof h.path === 'string' && h.path.length > 0 ? h.path : undefined;
  return {
    record_id: rec.record_id,
    posture: storage_ref.kind === 'remote' ? 'remote' : 'cas',
    storage_ref,
    filename: typeof h.filename === 'string' ? h.filename : '',
    ...(typeof h.mime_type === 'string' ? { mime_type: h.mime_type } : {}),
    ...(typeof h.size === 'number' ? { size: h.size } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(typeof h.content_hash === 'string' ? { content_hash: h.content_hash } : {}),
    ...(h.origin !== undefined ? { origin: h.origin } : {}),
    ...(h.scan_status !== undefined ? { scan_status: h.scan_status } : {}),
    ...(h.media_class !== undefined ? { media_class: h.media_class } : {}),
    ...(typeof rec.received_at === 'number' ? { event_at: rec.received_at } : {}),
  };
};

const projectRemote = (row: FileMetaRow, freshness?: FileSourceFreshness): DataFileView => {
  const m = row.meta;
  return {
    record_id: remoteFileRecordId(row.scope, row.target_id),
    posture: 'remote',
    storage_ref: { kind: 'remote', provider: m.provider, remote_id: m.remote_id },
    filename: m.filename,
    ...(m.mime_type !== undefined ? { mime_type: m.mime_type } : {}),
    ...(m.size !== undefined ? { size: m.size } : {}),
    ...(m.path !== undefined ? { path: m.path } : {}),
    ...(m.mtime !== undefined ? { mtime: m.mtime } : {}),
    ...(m.owner !== undefined ? { owner: m.owner } : {}),
    ...(m.revision !== undefined ? { revision: m.revision } : {}),
    provider: m.provider,
    event_at: m.mtime ?? m.snapshot_at,
    ...(freshness !== undefined ? { freshness } : {}),
  };
};

/** The window the resolver scans across the CAS collection before filtering by
 *  needle in memory (the collection has no filename FTS) — mirrors the
 *  mirror-search `MIRROR_FILE_SCAN_CAP`. Remote rows filter in SQL, so they
 *  need no scan window. */
export const FILE_VIEW_CAS_SCAN_CAP = 500;

export interface FileViewResolverDeps {
  /** The remote meta-store. Absent on a dbless / not-yet-created boot → the
   *  resolver surfaces CAS rows only. */
  fileMetaStore?: FileMetaStore;
  /** Fetch one CAS `data.file.received` record by id, or null. */
  casGet: (record_id: string) => DataFileRecord | null;
  /** The most-recent CAS `data.file.received` records (up to the scan window),
   *  which the resolver filters by needle. The wire aggregates the file-platform
   *  collection(s) from the registry. */
  casList: (scan_limit: number) => DataFileRecord[];
  /** D-192 Fork B hardening — the per-Source sync-state store. When wired, a
   *  remote view carries a `freshness` verdict (looked up by `row.scope` = the
   *  Source id). Absent → remote views omit freshness (back-compat). */
  syncState?: FileSourceSyncStateStore;
  /** Clock for the freshness staleness comparison. Defaults to `Date.now`. */
  now?: () => number;
}

export interface FileViewResolver {
  /** Hydrate ONE unified view by record id — a `file:remote:*` id resolves
   *  from the meta-store, a `file:<hex>` id from the CAS collection. `null`
   *  when the id is neither shape or the row is gone. */
  getFileView(record_id: string): DataFileView | null;
  /** Merge the CAS + remote file space into one needle-matched, recency-sorted
   *  list (the mirror-search picker feed). A blank needle → `[]`. */
  searchFileViews(needle: string, limit: number): DataFileView[];
}

export const createFileViewResolver = (deps: FileViewResolverDeps): FileViewResolver => {
  const now = deps.now ?? ((): number => Date.now());
  // Project a remote row WITH its Source freshness when the sync-state store is
  // wired (looked up by `row.scope` = the Source id, the sync-state key).
  const projectRemoteFresh = (row: FileMetaRow): DataFileView =>
    projectRemote(
      row,
      deps.syncState ? deriveFileSourceFreshness(deps.syncState.get(row.scope), now()) : undefined,
    );

  return {
  getFileView(record_id) {
    const remote = parseRemoteFileRecordId(record_id);
    if (remote) {
      const row = deps.fileMetaStore?.get(remote.scope, remote.target_id) ?? null;
      return row ? projectRemoteFresh(row) : null;
    }
    if (isInboundFileRecordId(record_id)) {
      const rec = deps.casGet(record_id);
      return rec ? projectCas(rec) : null;
    }
    return null;
  },

  searchFileViews(needle, limit) {
    const trimmed = needle.trim();
    if (trimmed.length === 0) return [];
    const cap = Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1);
    const needleLower = trimmed.toLowerCase();
    const seen = new Set<string>();
    const merged: DataFileView[] = [];
    const add = (v: DataFileView): void => {
      if (!seen.has(v.record_id)) {
        seen.add(v.record_id);
        merged.push(v);
      }
    };
    // CAS — scan the recent window, match the needle against filename (+ path
    // if a future CAS row carries one). The prior mirror-search matched only
    // `path`, which CAS rows lack, so local files were invisible; matching
    // filename fixes that.
    for (const rec of deps.casList(FILE_VIEW_CAS_SCAN_CAP)) {
      const h = rec.hot_fields;
      const path = typeof h.path === 'string' ? h.path : '';
      if (`${h.filename ?? ''}\n${path}`.toLowerCase().includes(needleLower)) add(projectCas(rec));
    }
    // Remote — the meta-store's cross-scope filename/path SQL search.
    if (deps.fileMetaStore) {
      for (const row of deps.fileMetaStore.searchAll(trimmed, cap)) add(projectRemoteFresh(row));
    }
    // Fair merge: recency-sorted (both postures carry `event_at`), then capped.
    merged.sort((a, b) => (b.event_at ?? 0) - (a.event_at ?? 0));
    return merged.slice(0, cap);
  },
  };
};

/** Build a resolver whose CAS reads come from the collection registry's
 *  `file`-platform collection(s) — the shared construction for every surface
 *  (the mirror-search picker + the timeline loader). `casGet` tries each file
 *  collection; `casList` aggregates the recent window across them. */
export const createFileViewResolverFromRegistry = (
  registry: CollectionRegistry,
  fileMetaStore?: FileMetaStore,
  syncState?: FileSourceSyncStateStore,
  now?: () => number,
): FileViewResolver => {
  const fileCollections = (): ReturnType<CollectionRegistry['list']> =>
    registry.list().filter((c) => c.platform === 'file');
  return createFileViewResolver({
    ...(fileMetaStore ? { fileMetaStore } : {}),
    ...(syncState ? { syncState } : {}),
    ...(now ? { now } : {}),
    casGet: (record_id) => {
      for (const c of fileCollections()) {
        const rec = c.get(record_id) as DataFileRecord | null;
        if (rec) return rec;
      }
      return null;
    },
    casList: (scan_limit) =>
      fileCollections().flatMap(
        (c) => c.list({ platform: 'file', slug: c.slug, limit: scan_limit }) as DataFileRecord[],
      ),
  });
};

/** Project a unified {@link DataFileView} into the `file`-source
 *  `TimelineEntry`. The payload follows the D-120 raw-record shape
 *  (`{ record_id, hot_fields, size_bytes }`) PLUS `storage_ref` — the posture
 *  discriminator + the remote `{provider, remote_id}` pointer a consumer needs
 *  to open the vendor's own link (bytes are never fetched). `kind` names the
 *  posture; `ts` is the view's `event_at` (vendor mtime / CAS received_at). */
const fileViewToTimelineEntry = (view: DataFileView): TimelineEntry => {
  const hot_fields: Record<string, unknown> = { filename: view.filename, posture: view.posture };
  const carry = (
    k: 'mime_type' | 'size' | 'path' | 'mtime' | 'owner' | 'revision' | 'provider' | 'content_hash' | 'origin' | 'scan_status' | 'media_class',
  ): void => {
    if (view[k] !== undefined) hot_fields[k] = view[k];
  };
  for (const k of ['mime_type', 'size', 'path', 'mtime', 'owner', 'revision', 'provider', 'content_hash', 'origin', 'scan_status', 'media_class'] as const) {
    carry(k);
  }
  return {
    ts: view.event_at ?? 0,
    source: 'file',
    kind: view.posture === 'remote' ? 'mirrored' : 'received',
    payload: {
      record_id: view.record_id,
      storage_ref: view.storage_ref,
      hot_fields,
      size_bytes: view.size ?? 0,
    },
  };
};

/** A `LoadCollectionRecord` (the `data.timeline` raw-record loader) for the
 *  `file` collection — hydrates ONE unified view (CAS or remote) as a
 *  `file`-source timeline entry. Returns `null` for any other collection (mail
 *  / calendar stay unwired, exactly as before) or a gone / non-file id. This is
 *  the D-192 Fork B surface that makes a mirrored remote file's metadata show
 *  in the webclient drill-down + (later) MCP `data.timeline`. */
export const buildLoadFileCollectionRecord =
  (resolver: FileViewResolver) =>
  async (collection: string, id: string): Promise<TimelineEntry | null> => {
    if (collection !== 'file') return null;
    const view = resolver.getFileView(id);
    return view ? fileViewToTimelineEntry(view) : null;
  };
