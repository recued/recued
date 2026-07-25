/** D-192 file SOURCE family (slice 3) — the `FileVendorDeclaration` registry.
 *
 *  The canonical-vocabulary half of the kinds-taxonomy §0 governing rule
 *  (D-192): "for any multi-vendor family, split the
 *  design into (1) a canonical vocabulary + a declaration the shared logic is
 *  written against ONCE and (2) a thin per-vendor adapter for only what can't
 *  generalize — the API leaf, the auth flow, the byte-format." A new file
 *  vendor is one declaration entry here + its adapter leaf, NEVER a
 *  `switch (vendor)` in shared code.
 *
 *  Mirrors `MessengerVendorDeclaration` / `CONNECTION_VENDOR_ENTITIES`
 *  DATA-first: the declaration carries the per-vendor FACTS the shared
 *  reconciler + projector dispatch on — how the vendor's file object maps to
 *  the canonical `FileMetaProjection` (the `projection` field map), whether it
 *  lists fully every cycle or rides a delta cursor (`list`), whether it
 *  supports a server-side path/prefix scope (`scope`, the Fork A escape hatch),
 *  and the auth flow. The BEHAVIORAL leaf it names — the per-vendor list/meta
 *  API call — stays in the backend keyed by the `vendor` slug (contracts
 *  imports no runtime). The vendor slug IS the ref.
 *
 *  Scope note (what reads this): PURE + unwired at slice 3. The `file_meta_ref`
 *  reconcile runner (slice 4) consumes `list` + `projection`; the per-vendor
 *  adapter leaves (slice 5) consume `auth` + `projection` field names + the
 *  slug; the `import_scope` glob (slice 6) consumes `scope.supports_prefix`.
 *  Every facet is grounded in real per-vendor variance — Dropbox rides a
 *  `list_folder` cursor and exposes `rev`; S3 has no native delta (re-list) and
 *  no `ContentType` in `ListObjectsV2` (its `mime_type` is deliberately
 *  omitted) — never speculation. Source sync fetches metadata only; explicit
 *  reads use a separate lazy remote-byte resolver.
 *
 *  Spec: D-192; taxonomy §0 / §3b. */

// ────────────────────────────────────────────────────────────────
// Closed enums (the declaration's controlled vocabulary)
// ────────────────────────────────────────────────────────────────

/** The listing strategy.
 *   - `full`             — re-list the whole (scoped) tree every cycle; the
 *     meta-store's snapshot-hash skip makes unchanged rows cheap. For vendors
 *     with no native delta (S3 `ListObjectsV2`).
 *   - `full_then_delta`  — a first-boot full list, then ride an incremental
 *     delta cursor (Dropbox / Drive / OneDrive). */
export const FILE_LIST_MODES = ['full', 'full_then_delta'] as const;
export type FileListMode = (typeof FILE_LIST_MODES)[number];
export const FILE_LIST_MODE_SET: ReadonlySet<string> = new Set(FILE_LIST_MODES);

/** The incremental-delta cursor mechanism.
 *   - `none`            — no native delta (S3); paired with `mode: 'full'`.
 *   - `cursor`          — an opaque continue cursor (Dropbox `list_folder`/`continue`).
 *   - `delta_link`      — an MS Graph `@odata.deltaLink`.
 *   - `page_token`      — a Google Drive `changes` start-page-token.
 *   - `stream_position` — a Box `/2.0/events` stream position. */
export const FILE_CURSOR_KINDS = ['none', 'cursor', 'delta_link', 'page_token', 'stream_position'] as const;
export type FileCursorKind = (typeof FILE_CURSOR_KINDS)[number];
export const FILE_CURSOR_KIND_SET: ReadonlySet<string> = new Set(FILE_CURSOR_KINDS);

/** Credential auth kind. `oauth` (Dropbox / Drive / Box / OneDrive),
 *  `connection` (reuse the D-125 connection substrate), `access_key`
 *  (S3 access-key + secret). */
export const FILE_AUTH_KINDS = ['oauth', 'connection', 'access_key'] as const;
export type FileAuthKind = (typeof FILE_AUTH_KINDS)[number];
export const FILE_AUTH_KIND_SET: ReadonlySet<string> = new Set(FILE_AUTH_KINDS);

// ────────────────────────────────────────────────────────────────
// The declaration shape
// ────────────────────────────────────────────────────────────────

/** The listing facet — how the reconciler enumerates the tree. A `full` mode
 *  MUST pair with `cursor_kind: 'none'`; a `full_then_delta` mode MUST name a
 *  real cursor kind (enforced by the validator). */
export interface FileList {
  mode: FileListMode;
  cursor_kind: FileCursorKind;
}

/** The vendor -> canonical `FileMetaProjection` field map (the §0 generalizing
 *  part). Each value is the vendor's own field name/path; the shared projector
 *  reads it to pull the canonical field. `filename` + `remote_id` are required
 *  (the two required canonical fields); the rest are optional per what the
 *  vendor's list response actually carries (S3 omits `mime_type` / `owner`
 *  varies; Dropbox omits `mime_type` / `owner`). */
export interface FileProjection {
  /** Vendor field for the canonical `filename`. Required. */
  filename: string;
  /** Vendor field for the canonical `remote_id` (the pointer half). Required. */
  remote_id: string;
  path?: string;
  mime_type?: string;
  size?: string;
  mtime?: string;
  owner?: string;
  revision?: string;
}

/** The scope facet — whether the vendor's list API supports a server-side
 *  path/prefix filter (S3 `Prefix`, Dropbox `list_folder(path)`). Drives
 *  whether the Fork A `import_scope` glob is pushed down to the API or applied
 *  client-side (slice 6). */
export interface FileScope {
  supports_prefix: boolean;
}

/** One file vendor declaration — the canonical vocabulary a new vendor joins
 *  the family through (§0). The `vendor` slug is the registry key AND the
 *  backend adapter-leaf key. */
export interface FileVendorDeclaration {
  /** Lowercase vendor slug — `/^[a-z][a-z0-9_]*$/`. */
  vendor: string;
  /** Human-readable label (settings UI + validator error messages). */
  display_name: string;
  /** The listing facet. */
  list: FileList;
  /** The vendor -> canonical field map. */
  projection: FileProjection;
  /** The server-side scope-capability facet. */
  scope: FileScope;
  /** Credential auth kind. */
  auth: FileAuthKind;
}

// ────────────────────────────────────────────────────────────────
// Validation (hoisted above the registry initializer)
// ────────────────────────────────────────────────────────────────

/** Same lowercase identifier rule the connection- + messenger-vendor
 *  registries use (one grammar across the codebase). */
const FILE_VENDOR_REGEX = /^[a-z][a-z0-9_]*$/;

/** The optional `FileProjection` field-name keys (validated as non-empty
 *  strings when present). `filename` + `remote_id` are checked separately as
 *  required. */
const FILE_PROJECTION_OPTIONAL_FIELDS = [
  'path',
  'mime_type',
  'size',
  'mtime',
  'owner',
  'revision',
] as const;

/** Strict per-entry shape validator — returns issue strings (empty when the
 *  entry is well-formed). `buildFileVendorDeclaration` throws on a non-empty
 *  result so a misconfigured entry surfaces at boot, not at the first sync.
 *  Mirrors `assertMessengerVendorDeclarationShape`. */
export function assertFileVendorDeclarationShape(entry: unknown): string[] {
  const issues: string[] = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['expected object'];
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.vendor !== 'string' || !FILE_VENDOR_REGEX.test(e.vendor)) {
    issues.push(`field 'vendor' must match ${FILE_VENDOR_REGEX.source}`);
  }
  if (typeof e.display_name !== 'string' || e.display_name.length === 0) {
    issues.push("field 'display_name' must be a non-empty string");
  }

  // list — mode + cursor_kind, with the full<->none / delta<->cursor invariant.
  if (e.list === null || typeof e.list !== 'object' || Array.isArray(e.list)) {
    issues.push("field 'list' must be an object");
  } else {
    const l = e.list as Record<string, unknown>;
    const modeOk = typeof l.mode === 'string' && FILE_LIST_MODE_SET.has(l.mode);
    const cursorOk = typeof l.cursor_kind === 'string' && FILE_CURSOR_KIND_SET.has(l.cursor_kind);
    if (!modeOk) issues.push(`list.mode must be one of ${FILE_LIST_MODES.join(' / ')}`);
    if (!cursorOk) issues.push(`list.cursor_kind must be one of ${FILE_CURSOR_KINDS.join(' / ')}`);
    if (modeOk && cursorOk) {
      if (l.mode === 'full' && l.cursor_kind !== 'none') {
        issues.push("list.cursor_kind must be 'none' when list.mode is 'full'");
      }
      if (l.mode === 'full_then_delta' && l.cursor_kind === 'none') {
        issues.push("list.cursor_kind must be a real cursor (not 'none') when list.mode is 'full_then_delta'");
      }
    }
  }

  // projection — required filename + remote_id; optional field names non-empty.
  if (e.projection === null || typeof e.projection !== 'object' || Array.isArray(e.projection)) {
    issues.push("field 'projection' must be an object");
  } else {
    const p = e.projection as Record<string, unknown>;
    if (typeof p.filename !== 'string' || p.filename.length === 0) {
      issues.push('projection.filename is required (non-empty vendor field name)');
    }
    if (typeof p.remote_id !== 'string' || p.remote_id.length === 0) {
      issues.push('projection.remote_id is required (non-empty vendor field name)');
    }
    for (const f of FILE_PROJECTION_OPTIONAL_FIELDS) {
      const v = p[f];
      if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
        issues.push(`projection.${f} must be a non-empty vendor field name when present`);
      }
    }
  }

  if (e.scope === null || typeof e.scope !== 'object' || Array.isArray(e.scope)) {
    issues.push("field 'scope' must be an object");
  } else {
    const s = e.scope as Record<string, unknown>;
    if (typeof s.supports_prefix !== 'boolean') {
      issues.push('scope.supports_prefix must be a boolean');
    }
  }

  if (typeof e.auth !== 'string' || !FILE_AUTH_KIND_SET.has(e.auth)) {
    issues.push(`field 'auth' must be one of ${FILE_AUTH_KINDS.join(' / ')}`);
  }

  return issues;
}

/** Throwing wrapper — entries run through `build*` so misconfiguration surfaces
 *  at module load. */
export function assertFileVendorDeclarationValid(entry: FileVendorDeclaration): void {
  const issues = assertFileVendorDeclarationShape(entry);
  if (issues.length > 0) {
    throw new Error(
      `invalid FileVendorDeclaration '${String(
        (entry as { vendor?: unknown }).vendor,
      )}': ${issues.join('; ')}`,
    );
  }
}

/** Build + validate one declaration. Keeps the registry literal honest (a typo
 *  in a mode / cursor / auth throws at load). Mirrors
 *  `buildMessengerVendorDeclaration`. */
export function buildFileVendorDeclaration(input: FileVendorDeclaration): FileVendorDeclaration {
  assertFileVendorDeclarationValid(input);
  return input;
}

/** Cross-entry registry validator — catches a duplicate `vendor` slug. Returns
 *  issue strings; empty when clean. Mirrors `assertMessengerVendorRegistry`. */
export function assertFileVendorRegistry(
  registry: ReadonlyArray<FileVendorDeclaration>,
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  registry.forEach((entry, idx) => {
    for (const i of assertFileVendorDeclarationShape(entry)) issues.push(`[${idx}] ${i}`);
    if (seen.has(entry.vendor)) {
      issues.push(`[${idx}] duplicate vendor '${entry.vendor}' — only one entry per vendor allowed`);
    } else {
      seen.add(entry.vendor);
    }
  });
  return issues;
}

// ────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────

/** D-192 — the file vendor registry. Dropbox (a document product) + S3 (an
 *  object store) were the two Fork C proof vendors (the §0 projection
 *  generalizes across both shapes); OneDrive (MS Graph `/delta`) is the third —
 *  the first ID-keyed delta vendor, whose tombstones carry the item `id`
 *  directly (the runner's `removed_keys` path, vs. Dropbox's path-keyed
 *  `removed_paths`). Google Drive (`changes.list` / `page_token`) is the fourth
 *  — the second ID-keyed delta vendor (a `changes` tombstone carries `fileId`),
 *  and the first with NO native path (omitted, not synthesized). Box
 *  (`/2.0/events` / `stream_position`) is the fifth — the third ID-keyed delta
 *  vendor (an `ITEM_TRASH` event carries the item id), whose full walk recurses
 *  the folder tree (no flat list) + synthesizes a path from `path_collection`.
 *  SharePoint (sixth) is a pure ALIAS of OneDrive — a document library is a
 *  Graph drive, so it rides OneDrive's `/delta` leaf verbatim (keyed by the
 *  `config.drive_id`); only enrollment differs (`Sites.Read.All`). Notion
 *  arrives as one more declaration entry + a fresh adapter leaf. */
export const FILE_VENDOR_DECLARATIONS: ReadonlyArray<FileVendorDeclaration> = [
  buildFileVendorDeclaration({
    vendor: 'dropbox',
    display_name: 'Dropbox',
    // `list_folder` + `/list_folder/continue` — a first list then an opaque
    // continue cursor for deltas.
    list: { mode: 'full_then_delta', cursor_kind: 'cursor' },
    projection: {
      filename: 'name',
      path: 'path_display',
      size: 'size',
      mtime: 'server_modified',
      revision: 'rev',
      remote_id: 'id',
      // Dropbox's basic file metadata carries no mime_type / owner.
    },
    scope: { supports_prefix: true }, // list_folder(path)
    auth: 'oauth',
  }),
  buildFileVendorDeclaration({
    vendor: 's3',
    display_name: 'Amazon S3',
    // `ListObjectsV2` is paged but has no native delta — re-list every cycle
    // (the snapshot-hash skip keeps unchanged objects cheap).
    list: { mode: 'full', cursor_kind: 'none' },
    projection: {
      // The adapter leaf (slice 5) derives the leaf filename into a synthetic
      // `name` field — S3 `Key` is the full path (`Work/report.pdf`), so
      // `filename` reads the leaf while `path` + `remote_id` keep the whole
      // key. Mirrors Dropbox, whose native `name` is already the leaf.
      filename: 'name',
      path: 'Key',
      size: 'Size',
      mtime: 'LastModified',
      revision: 'ETag',
      owner: 'Owner.DisplayName',
      remote_id: 'Key',
      // ListObjectsV2 carries no ContentType — mime_type needs a per-object
      // HEAD, so it is deliberately omitted from the list projection.
    },
    scope: { supports_prefix: true }, // ListObjectsV2 Prefix
    auth: 'access_key',
  }),
  buildFileVendorDeclaration({
    vendor: 'onedrive',
    display_name: 'OneDrive',
    // MS Graph `/delta` — a first from-scratch drain (the delete-authority full
    // walk), then ride the `@odata.deltaLink` watermark for incremental changes.
    list: { mode: 'full_then_delta', cursor_kind: 'delta_link' },
    projection: {
      // A Graph driveItem's `name` IS the leaf filename; its `id` is the stable
      // item id (the mirror key). The leaf synthesizes a canonical `path` on
      // each row — Graph's `parentReference.path` is only the PARENT and carries
      // a `/drive/root:` namespace prefix, so the leaf strips the prefix, decodes
      // it, and appends the leaf name (mirrors S3's synthetic `name`).
      filename: 'name',
      path: 'path',
      mime_type: 'file.mimeType',
      size: 'size',
      mtime: 'lastModifiedDateTime',
      revision: 'eTag',
      remote_id: 'id',
    },
    // `/delta` is a whole-drive changes feed with no server-side path prefix
    // (v1) — the runner client-side filters an `import_scope` glob; the leaf
    // returns the resolved scope but pushes nothing down.
    scope: { supports_prefix: false },
    auth: 'oauth',
  }),
  buildFileVendorDeclaration({
    vendor: 'google',
    display_name: 'Google Drive',
    // Google Drive `changes.list` — a first-boot full `files.list` walk (the
    // delete-authority present-set), then ride the `changes` start-page-token
    // watermark for incremental changes. The ID-keyed delta sibling of OneDrive:
    // a `changes` entry's delete tombstone carries the `fileId` DIRECTLY (the
    // runner's `removed_keys` path), so no path reverse-lookup like Dropbox.
    list: { mode: 'full_then_delta', cursor_kind: 'page_token' },
    projection: {
      // A Drive File resource's `name` IS the leaf filename; `id` is the stable
      // file id (the mirror key). `mimeType` is native; `size` is a byte string
      // (ABSENT for Google-native Docs/Sheets — optional, so omitted for those);
      // `version` is Drive's monotonic change counter (the revision half);
      // `owners[0].displayName` the owner.
      //
      // NO `path`: Drive exposes none — a File carries only `parents[]` (folder
      // ids), and a file may have MULTIPLE parents, so a canonical path is both
      // expensive (a per-file parent-name walk) and ambiguous. v1 OMITS it (like
      // S3 omits `mime_type`): deletes are ID-keyed so need no path, and Drive
      // scopes by folder id / `q`, not a path glob — the D-194 capability-binding
      // is the real scope fix. Consequence: no per-row `import_scope` glob filter
      // (the leaf returns `scope: null`), so v1 mirrors the whole accessible Drive.
      filename: 'name',
      mime_type: 'mimeType',
      size: 'size',
      mtime: 'modifiedTime',
      revision: 'version',
      owner: 'owners.0.displayName',
      remote_id: 'id',
    },
    // `changes.list` is an account-wide feed and `files.list` has no path-prefix
    // filter — with `path` omitted the runner can't client-side glob-filter
    // either, so the leaf pushes nothing down AND returns no scope (whole-Drive
    // mirror in v1; D-194 adds capability-scoped narrowing).
    scope: { supports_prefix: false },
    auth: 'oauth',
  }),
  buildFileVendorDeclaration({
    vendor: 'box',
    display_name: 'Box',
    // Box `/2.0/events` — a first-boot full `/2.0/folders/{id}/items` tree walk
    // (the delete-authority present-set), then ride the events `stream_position`
    // watermark. The THIRD ID-keyed delta vendor: an `ITEM_TRASH` event carries
    // the item `id` directly (the runner's `removed_keys` path).
    list: { mode: 'full_then_delta', cursor_kind: 'stream_position' },
    projection: {
      // A Box file object's `name` IS the leaf filename; `id` the stable item id.
      // Box carries NO mime type in the file object (like S3/Dropbox — omitted).
      // `size` is bytes; `modified_at` RFC3339; `etag` the change counter (the
      // revision half); `owned_by.name` the owner. The leaf synthesizes a
      // canonical `path` from the item's `path_collection` ancestors (Box DOES
      // expose ancestors, unlike Drive) — mapped as the synthetic `path` field
      // (mirrors OneDrive/S3).
      filename: 'name',
      path: 'path',
      size: 'size',
      mtime: 'modified_at',
      revision: 'etag',
      owner: 'owned_by.name',
      remote_id: 'id',
    },
    // The `/2.0/folders` walk + `/2.0/events` feed have no server-side PATH-prefix
    // filter (Box scopes by folder id, not a path glob) — so the leaf pushes
    // nothing down and the runner client-side globs the synthesized path; an
    // optional `config.folder_id` bounds the tree-walk ROOT (a separate knob,
    // like OneDrive's `drive_id`).
    scope: { supports_prefix: false },
    auth: 'oauth',
  }),
  buildFileVendorDeclaration({
    vendor: 'sharepoint',
    display_name: 'SharePoint',
    // A SharePoint document library IS a Microsoft Graph drive, so SharePoint
    // is a pure declaration ALIAS of OneDrive — identical `/delta` list mode,
    // `@odata.deltaLink` cursor, and Graph driveItem projection. The backend
    // keys the SAME OneDrive `/delta` adapter leaf on this slug; the connection
    // targets the library via `config.drive_id` (`/drives/{drive_id}/root/delta`).
    // The only real difference from OneDrive lives in enrollment (the
    // `Sites.Read.All` scope + a required `drive_id`), not here.
    list: { mode: 'full_then_delta', cursor_kind: 'delta_link' },
    projection: {
      filename: 'name',
      path: 'path',
      mime_type: 'file.mimeType',
      size: 'size',
      mtime: 'lastModifiedDateTime',
      revision: 'eTag',
      remote_id: 'id',
    },
    // `/delta` is a whole-drive changes feed with no server-side path prefix —
    // same as OneDrive; the runner client-side filters an `import_scope` glob.
    scope: { supports_prefix: false },
    auth: 'oauth',
  }),
  buildFileVendorDeclaration({
    vendor: 'notion',
    display_name: 'Notion',
    // Notion has NO flat file list and NO file-level delta: a bespoke recursive
    // walk over BOTH of Notion's file homes — (1) file-carrying blocks
    // (file/image/pdf/video/audio) in the pages SHARED WITH THE INTEGRATION
    // (POST /v1/search → recurse GET /v1/blocks/{id}/children), and (2) files
    // attached to a data-source ROW's `files` column (POST /v1/search filter
    // data_source → POST /v1/data_sources/{id}/query → row `properties`). Box-
    // shaped (no flat list), thinner metadata. Full-only (like S3): the snapshot-
    // hash skip keeps an unchanged re-walk cheap; `cursor_kind: 'none'`. The
    // completeness proof is "complete over the SHARED set" across both prongs
    // (unshared pages/data sources are invisible — the leaf never absence-deletes
    // without a positive exhaustion of the shared walk). Explicit byte reads
    // are separate from sync: block-backed files can be re-resolved lazily;
    // synthetic data-source-property rows that lack a stable object locator
    // fail closed as unresolvable.
    list: { mode: 'full', cursor_kind: 'none' },
    projection: {
      // The leaf SYNTHESIZES a flat row per file (the native shapes are deeply
      // nested + vary by type): `remote_id` = the block id for a block file
      // (stable; an in-place swap keeps the id + only bumps `mtime`), or a
      // content-derived (rowId,propId)-scoped key for a data-source property file
      // (which carries no per-entry id — see the leaf's `fileRowFromProperty`);
      // `filename` = the file's `name` (URL-basename fallback for nameless
      // image/pdf/video/audio blocks), `mtime` = the block's / row's
      // `last_edited_time` (the only change proxy Notion exposes), `path` = a
      // title breadcrumb. Notion file objects carry NO size / mime /
      // content-revision — omitted (the required pair is filename + remote_id).
      filename: 'filename',
      path: 'path',
      mtime: 'mtime',
      remote_id: 'remote_id',
    },
    // Notion's search + block-children lists have no server-side path prefix — the
    // runner client-side globs an optional `import_scope` over the synthesized path.
    scope: { supports_prefix: false },
    // Reuse the stable notion internal-integration bearer — Notion tokens don't
    // expire, so no oauth2_refresh (unlike Box/Dropbox). The leaf reads it via
    // `resolveBearerAccessToken`; nothing branches on this label at runtime.
    auth: 'connection',
  }),
];

// ────────────────────────────────────────────────────────────────
// Accessors (defaulted-registry param — a live/merged registry can be passed)
// ────────────────────────────────────────────────────────────────

/** Look up one vendor's declaration. Returns `null` for an undeclared vendor. */
export const getFileVendorDeclaration = (
  vendor: string,
  registry: ReadonlyArray<FileVendorDeclaration> = FILE_VENDOR_DECLARATIONS,
): FileVendorDeclaration | null => {
  for (const entry of registry) {
    if (entry.vendor === vendor) return entry;
  }
  return null;
};

/** List every declared vendor slug (insertion order, deduped). */
export const listFileVendors = (
  registry: ReadonlyArray<FileVendorDeclaration> = FILE_VENDOR_DECLARATIONS,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of registry) {
    if (seen.has(entry.vendor)) continue;
    seen.add(entry.vendor);
    out.push(entry.vendor);
  }
  return out;
};

/** Predicate — true when `vendor` has a declaration. */
export const isDeclaredFileVendor = (
  vendor: unknown,
  registry: ReadonlyArray<FileVendorDeclaration> = FILE_VENDOR_DECLARATIONS,
): vendor is string =>
  typeof vendor === 'string' && getFileVendorDeclaration(vendor, registry) !== null;

// Boot-time registry self-validation (mirrors `messenger-vendors.ts`). Each
// entry is already validated in isolation by `buildFileVendorDeclaration`; this
// catches the CROSS-ENTRY invariant a per-entry check cannot — a duplicate
// `vendor` slug — so a bad future edit fails at module load, not silently.
const _bootIssues = assertFileVendorRegistry(FILE_VENDOR_DECLARATIONS);
if (_bootIssues.length > 0) {
  throw new Error(`FILE_VENDOR_DECLARATIONS boot validation failed: ${_bootIssues.join('; ')}`);
}
