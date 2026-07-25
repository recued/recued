/** D-192 file SOURCE family (slice 4) — the declaration-driven file projector.
 *
 *  Pure function: one `FileVendorDeclaration` × one RAW vendor file row →
 *  the canonical `FileMetaProjection` the `file_meta_ref` meta-store stamps
 *  (via {@link buildFileMetaSnapshot}), or a row failure. The §0 generalizing
 *  half of the family — written ONCE against the declaration's `projection`
 *  field-map; a new vendor never edits this.
 *
 *  Three derivations, all closed + deterministic (no expressions, no AI):
 *
 *  - **dotted reads** — each declared field name is a dot-path into the raw
 *    row (`getByDotPath`), so S3's nested `Owner.DisplayName` resolves the
 *    same way a flat `name` does.
 *  - **type coercions** — the two non-string canonical fields are coerced
 *    from what a list API actually returns: `size` from a number or a digit
 *    string, `mtime` from an epoch (number / digit string) OR an ISO/RFC date
 *    string (`Date.parse`). A present-but-uncoercible value FAILS the row
 *    (loud beats silently dropping the field — the work-entity projector's
 *    `coerceDateMs` philosophy). These are UNIVERSAL across file vendors and
 *    declaration-driven, so they live here; vendor-STRUCTURAL quirks (the S3
 *    `Key` → leaf-name split) are the per-vendor adapter leaf's job (slice 5),
 *    which hands the projector a normalized raw record.
 *  - **provider = the vendor slug** — `provider` is not a field on the raw
 *    row; it IS the declaration's `vendor` (`dropbox` / `s3`). Half the
 *    `(provider, remote_id)` pointer.
 *
 *  `filename` + `remote_id` are the required canonical fields; an absent /
 *  uncoercible value on either leaves the projection invalid and
 *  `buildFileMetaSnapshot`'s `validateFileMetaProjection` (the single
 *  fail-closed gate) rejects it. This projector never fetches bytes;
 *  explicit reads use the separate lazy remote-byte resolver. Design:
 *  D-192; taxonomy §0 / §3b. */

import type { FileMetaProjection, FileVendorDeclaration } from '@recued/contracts';

import { getByDotPath } from './source-mirror/fetch.js';

export type ProjectFileVendorRowResult =
  | { ok: true; projection: FileMetaProjection }
  | { ok: false; reason: string };

const absent = (v: unknown): boolean => v === undefined || v === null || v === '';

/** Read a declared string field by dot-path. A number coerces to its string
 *  form (a numeric revision / id); anything else reads as absent. */
const readString = (raw: Record<string, unknown>, path: string | undefined): string | undefined => {
  if (path === undefined) return undefined;
  const v = getByDotPath(raw, path);
  if (absent(v)) return undefined;
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
};

/** Coerce a declared size field → a finite non-negative byte count. Present
 *  but non-numeric / negative FAILS the row. */
const readSize = (
  raw: Record<string, unknown>,
  path: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; reason: string } => {
  if (path === undefined) return { ok: true, value: undefined };
  const v = getByDotPath(raw, path);
  if (absent(v)) return { ok: true, value: undefined };
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, reason: `size: expected a non-negative number, got '${String(v)}'` };
  }
  return { ok: true, value: n };
};

/** Coerce a declared mtime field → epoch ms. A finite number / digit string
 *  is an epoch; any other string goes through `Date.parse` (ISO 8601 + RFC
 *  dates — the S3 `LastModified` / Dropbox `server_modified` shape). Present
 *  but unparseable FAILS the row. */
const readMtime = (
  raw: Record<string, unknown>,
  path: string | undefined,
): { ok: true; value: number | undefined } | { ok: false; reason: string } => {
  if (path === undefined) return { ok: true, value: undefined };
  const v = getByDotPath(raw, path);
  if (absent(v)) return { ok: true, value: undefined };
  let ms: number;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string') ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: `mtime: unparseable date '${String(v)}'` };
  }
  return { ok: true, value: ms };
};

/** Project one raw vendor file row into its canonical `FileMetaProjection`.
 *  Pure — no IO, no clock (the meta-store's `buildFileMetaSnapshot` stamps
 *  time + hash). `provider` is the declaration's `vendor`; every other field
 *  is a declared dot-path with the closed coercions above. */
export const projectFileVendorRow = (
  raw: Record<string, unknown>,
  declaration: FileVendorDeclaration,
): ProjectFileVendorRowResult => {
  const p = declaration.projection;

  const size = readSize(raw, p.size);
  if (!size.ok) return size;
  const mtime = readMtime(raw, p.mtime);
  if (!mtime.ok) return mtime;

  const filename = readString(raw, p.filename);
  const remote_id = readString(raw, p.remote_id);
  const path = readString(raw, p.path);
  const mime_type = readString(raw, p.mime_type);
  const owner = readString(raw, p.owner);
  const revision = readString(raw, p.revision);

  const projection: FileMetaProjection = {
    // Required fields — an absent value leaves an empty string here, which
    // `validateFileMetaProjection` rejects (fail-closed, loud).
    filename: filename ?? '',
    provider: declaration.vendor,
    remote_id: remote_id ?? '',
    ...(path !== undefined ? { path } : {}),
    ...(mime_type !== undefined ? { mime_type } : {}),
    ...(size.value !== undefined ? { size: size.value } : {}),
    ...(mtime.value !== undefined ? { mtime: mtime.value } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(revision !== undefined ? { revision } : {}),
  };
  return { ok: true, projection };
};
