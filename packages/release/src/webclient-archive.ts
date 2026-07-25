/** D-178 + D-152 § A.16 — the signed webclient bundle archive.
 *
 *  The `:managed` self-updating server + the binary channel must keep the
 *  embedded webclient (served at `/webclient/*` from `RECUED_WEBCLIENT_DIR`)
 *  version-matched to the server as it self-updates in place — a webclient
 *  baked into the frozen launcher would go stale after the first update
 *  (Dockerfile.managed rationale). So the webclient travels WITH the signed
 *  release artifact: one arch-neutral archive per channel, keyed `webclient`
 *  in the manifest's `artifacts`, minisign-signed exactly like a binary.
 *
 *  FORMAT — a single self-contained JSON document (NOT a tarball). No tar/zip
 *  dependency exists in the tree, and this module is imported by the frozen
 *  launcher's closure + the server updater, both of which must stay
 *  dependency-free (I-9). Each file is carried inline (base64) with its own
 *  sha256; the whole document is what the detached `.minisig` signs. So the
 *  archive has TWO integrity layers: the outer minisign (authority) + the
 *  per-file sha256 (fail-fast + catches a decode discrepancy). After extraction
 *  the D-152 loader (`webclient-bundle-loader.ts`) re-verifies the directory
 *  against its own `webclient-bundle-manifest.json` — a third, independent gate.
 *
 *  Deterministic: files sorted by path, stable key order, so re-packing the
 *  same inputs yields byte-identical output (the bytes the signature covers).
 *
 *  Pure + dependency-free: pack takes `{ path, bytes }[]` (the caller reads the
 *  build dir), unpack returns `{ path, bytes }[]` (the caller writes the volume
 *  dir). Fail-closed: every malformed input yields `{ ok: false, reason }`.
 */

import { createHash } from 'node:crypto';

/** Archive document schema. A consumer refuses a schema above its known max
 *  (forward-compat, mirrors the manifest's `schema_version`). */
export const WEBCLIENT_ARCHIVE_SCHEMA = 1;

/** A file inside the bundle: a relative POSIX path + its raw bytes. */
export interface WebclientArchiveFile {
  path: string;
  bytes: Uint8Array;
}

interface WebclientArchiveEntry {
  path: string;
  sha256: string;
  base64: string;
}

interface WebclientArchiveDoc {
  schema: number;
  version: string;
  files: WebclientArchiveEntry[];
}

/** Canonical archive file name — the manifest `BinaryArtifact.url` ends in this
 *  and the signature's trusted comment binds it (a valid sig can't be swapped
 *  onto a different artifact). */
export const webclientArchiveFileName = (version: string): string =>
  `webclient-${version}.bundle.json`;

/** Trusted-comment binding for the webclient archive — pins file name + version
 *  (§ Signing), the webclient counterpart of `artifactTrustedComment`. */
export const webclientArtifactTrustedComment = (fileName: string, version: string): string =>
  `recued webclient ${fileName} v${version}`;

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A safe relative bundle path: non-empty, forward-slash, no absolute root, no
 *  backslash, and no `.`/`..`/empty segment (traversal). The extractor ALSO
 *  joins-and-contains-checks at write time, and the boot loader re-checks with
 *  `WEBCLIENT_BUNDLE_PATH_REGEX` — this is the first of those gates. */
export const isSafeWebclientPath = (p: string): boolean =>
  typeof p === 'string' &&
  p.length > 0 &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');

/** Pack a set of bundle files into the signable archive text. Deterministic:
 *  sorted by path, stable key order, trailing newline (the exact bytes the
 *  detached `.minisig` covers). Throws on an unsafe path or a duplicate — a
 *  malformed archive must never be produced + signed. */
export const packWebclientArchive = (input: {
  version: string;
  files: ReadonlyArray<WebclientArchiveFile>;
}): string => {
  if (typeof input.version !== 'string' || input.version.length === 0) {
    throw new Error('packWebclientArchive: version must be a non-empty string');
  }
  if (input.files.length === 0) {
    throw new Error('packWebclientArchive: at least one file is required');
  }
  const seen = new Set<string>();
  const entries: WebclientArchiveEntry[] = [];
  for (const f of input.files) {
    if (!isSafeWebclientPath(f.path)) {
      throw new Error(`packWebclientArchive: unsafe path "${f.path}"`);
    }
    if (seen.has(f.path)) throw new Error(`packWebclientArchive: duplicate path "${f.path}"`);
    seen.add(f.path);
    entries.push({
      path: f.path,
      sha256: sha256Hex(f.bytes),
      base64: Buffer.from(f.bytes).toString('base64'),
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const doc: WebclientArchiveDoc = {
    schema: WEBCLIENT_ARCHIVE_SCHEMA,
    version: input.version,
    files: entries,
  };
  return `${JSON.stringify(doc)}\n`;
};

export type UnpackWebclientArchiveResult =
  | { ok: true; version: string; files: WebclientArchiveFile[] }
  | { ok: false; reason: string };

/** Parse + fully verify a webclient archive (the caller has ALREADY verified the
 *  outer minisign over these bytes — this is the second, per-file gate). Every
 *  malformed / unsafe / sha-mismatched input returns `{ ok: false, reason }`;
 *  never throws, never returns a partially-decoded set. */
export const unpackWebclientArchive = (text: string): UnpackWebclientArchiveResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not_object' };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== WEBCLIENT_ARCHIVE_SCHEMA) return { ok: false, reason: 'unsupported_schema' };
  if (typeof doc.version !== 'string' || doc.version.length === 0) {
    return { ok: false, reason: 'missing_version' };
  }
  if (!Array.isArray(doc.files)) return { ok: false, reason: 'missing_files' };
  if (doc.files.length === 0) return { ok: false, reason: 'empty' };

  const files: WebclientArchiveFile[] = [];
  const seen = new Set<string>();
  for (const e of doc.files) {
    if (typeof e !== 'object' || e === null) return { ok: false, reason: 'malformed_entry' };
    const entry = e as Record<string, unknown>;
    const { path, sha256, base64 } = entry;
    if (typeof path !== 'string' || !isSafeWebclientPath(path)) {
      return { ok: false, reason: `unsafe_path:${typeof path === 'string' ? path : '<non-string>'}` };
    }
    if (seen.has(path)) return { ok: false, reason: `duplicate_path:${path}` };
    seen.add(path);
    if (typeof sha256 !== 'string' || typeof base64 !== 'string') {
      return { ok: false, reason: `malformed_entry:${path}` };
    }
    const bytes = Buffer.from(base64, 'base64');
    // The sha256 IS the integrity gate here: a base64 with dropped junk decodes
    // to different bytes → mismatch → reject (so a lax base64 decode is safe).
    if (sha256Hex(bytes) !== sha256) return { ok: false, reason: `sha256_mismatch:${path}` };
    files.push({ path, bytes });
  }
  return { ok: true, version: doc.version, files };
};
