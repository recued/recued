/** D-192 file SOURCE family (slice 5) — the per-vendor adapter leaves.
 *
 *  The thin per-vendor half of the kinds-taxonomy §0 rule: the shared
 *  `file_meta_ref` reconcile spine (`file-source-sync.ts`) + the shared
 *  declaration-driven projector (`file-source-projector.ts`) are written ONCE;
 *  each vendor adds only what can't generalize — the list/meta API call, its
 *  auth flow, its pagination. That per-vendor call is exactly the injected
 *  `FileSourceListFn` port slice 4 defined; this module implements it for the
 *  Dropbox (a document product, path-keyed delta tombstones), S3 (an object
 *  store, no native delta), OneDrive (MS Graph `/delta`, the first ID-keyed
 *  delta vendor — tombstones ride `removed_keys`), Google Drive
 *  (`changes.list` / `page_token`, the second ID-keyed delta vendor — split
 *  full/`files.list` + delta/`changes.list` endpoints, no native path), and Box
 *  (`/2.0/events` / `stream_position`, the third ID-keyed delta vendor — a
 *  bespoke folder-tree full walk since Box has no flat list). SharePoint is not
 *  a separate leaf — a document library is a Graph drive, so it reuses the
 *  OneDrive `/delta` leaf keyed by `config.drive_id` (only the vendor label
 *  differs).
 *
 *  A leaf's contract (per `FileSourceListFn`): resolve the connection's
 *  decrypted credentials, walk the vendor's list API to exhaustion (metadata
 *  only — sync never fetches bodies), and return the raw vendor rows
 *  + a POSITIVE `complete` proof (true ONLY when the whole scoped tree was
 *  provably walked). The reconciler keys / projects / hash-skips / upserts, and
 *  gates absence-based deletes on that `complete` proof — so a leaf that cannot
 *  prove exhaustion MUST return `complete: false` (fail-closed).
 *
 *  Credentials arrive through an injected `FileConnectionResolver` — the wire
 *  binds it to the connection store + the AEAD key provider (the leaves never
 *  touch storage or crypto directly, staying pure of the boot graph + trivially
 *  testable). `fetchImpl` + `now` are test seams.
 *
 *  Design: D-192; taxonomy §0 / §3b. */

import type { ConnectionAuth } from '@recued/contracts';

import type {
  FileSourceAdapterResolver,
  FileSourceListFn,
} from '../file-source-sync.js';
import { buildBoxFileSourceLeaf } from './box.js';
import { buildDropboxFileSourceLeaf } from './dropbox.js';
import { buildGoogleFileSourceLeaf } from './google.js';
import { buildNotionFileSourceLeaf } from './notion.js';
import { buildOneDriveFileSourceLeaf } from './onedrive.js';
import { buildS3FileSourceLeaf } from './s3.js';

/** The decrypted, config-parsed connection material a leaf reads to
 *  authenticate + locate the vendor endpoint. `auth` is the AEAD-decrypted
 *  `ConnectionAuth` (a bearer token for Dropbox, the access-key/secret pair
 *  carried as `basic` for S3); `config` is the non-secret JSON (region /
 *  bucket / endpoint / use_path_style + the shared `import_scope` glob — the
 *  Fork A escape hatch each leaf resolves). */
export interface FileConnectionCredential {
  auth: ConnectionAuth;
  config: Record<string, unknown>;
}

/** Resolve one connection's decrypted credentials by name, or `null` when the
 *  connection is gone (a race with a delete). The wire binds this to
 *  `connectionStore.get('api', name)` + `decodeAuthFromStorage`. */
export type FileConnectionResolver = (
  connection_name: string,
) => Promise<FileConnectionCredential | null>;

/** The minimal HTTP response the leaves consume. A structural SUBSET of the
 *  platform `Response`, so the real `globalThis.fetch` satisfies `FileFetch`
 *  and a test stub stays tiny. */
export interface FileFetchResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The readable body stream, when the impl exposes one (the platform `fetch`
   *  Response does). D-192 remote byte-fetch reads it chunk-by-chunk with a hard
   *  size cap so a chunked / Content-Length-less download can't buffer an
   *  unbounded body into memory. Absent (a buffering stub) → the reader falls back
   *  to `arrayBuffer()`, still guarded by the post-read length check. */
  body?: ReadableStream<Uint8Array> | null;
}

/** The injected fetch the leaves call — the platform `fetch` in production, a
 *  stub in tests. Its shape is a superset of the S3 client's `S3Fetch`, so the
 *  S3 leaf can delegate to it. */
export type FileFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array },
) => Promise<FileFetchResponse>;

/** The leaf's fully-resolved deps (`fetchImpl` defaulted by the factory). */
export interface FileSourceLeafDeps {
  resolveConnection: FileConnectionResolver;
  fetchImpl: FileFetch;
  /** S3 SigV4 clock — test seam; production omits it (client defaults to now). */
  now?: () => Date;
}

/** The public deps the wire passes — `fetchImpl` + `now` optional (defaulted). */
export interface FileSourceAdapterDeps {
  resolveConnection: FileConnectionResolver;
  fetchImpl?: FileFetch;
  now?: () => Date;
}

/** The production `FileFetch` (platform `fetch`). Exported so the D-192 remote
 *  byte-fetch resolvers use the SAME fetch the list adapters default to. */
export const defaultFileFetch: FileFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body as BodyInit } : {}),
  });

/** Build the per-vendor `FileSourceListFn` resolver the D-192 file-source
 *  reconcile wire consumes (`wireFileSourceSync({ resolveAdapter })`). Keyed by
 *  the `FileVendorDeclaration.vendor` slug; a vendor with no leaf here resolves
 *  to `undefined` → that Source gets no sync task (the slice-4 wire contract). */
export const buildFileSourceAdapterResolver = (
  deps: FileSourceAdapterDeps,
): FileSourceAdapterResolver => {
  const leafDeps: FileSourceLeafDeps = {
    resolveConnection: deps.resolveConnection,
    fetchImpl: deps.fetchImpl ?? defaultFileFetch,
    ...(deps.now ? { now: deps.now } : {}),
  };
  const leaves: Record<string, FileSourceListFn> = {
    dropbox: buildDropboxFileSourceLeaf(leafDeps),
    s3: buildS3FileSourceLeaf(leafDeps),
    onedrive: buildOneDriveFileSourceLeaf(leafDeps),
    google: buildGoogleFileSourceLeaf(leafDeps),
    box: buildBoxFileSourceLeaf(leafDeps),
    // SharePoint document libraries are Graph drives — same `/delta` leaf as
    // OneDrive, targeted by `config.drive_id`. Only the vendor label differs.
    sharepoint: buildOneDriveFileSourceLeaf(leafDeps, { vendorLabel: 'sharepoint' }),
    // Notion — a bespoke full-only search → block-tree walk (no flat list, no
    // delta), the first bearer-connection file vendor.
    notion: buildNotionFileSourceLeaf(leafDeps),
  };
  return (vendor) => leaves[vendor];
};

export { buildBoxFileSourceLeaf } from './box.js';
export { buildDropboxFileSourceLeaf } from './dropbox.js';
export { buildGoogleFileSourceLeaf } from './google.js';
export { buildNotionFileSourceLeaf } from './notion.js';
export { buildOneDriveFileSourceLeaf } from './onedrive.js';
export { buildS3FileSourceLeaf } from './s3.js';
