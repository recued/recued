/** D-192 remote byte-fetch (follow-on B) — the Google Drive vendor resolver.
 *
 *  A Drive mirror row's `remote_id` is the stable file id (the declaration maps
 *  `remote_id: 'id'`), so a byte read is one authenticated
 *  `GET drive/v3/files/{id}?alt=media`. `supportsAllDrives=true` matches the list
 *  walk (which mirrors shared-drive files too), so a shared-drive file downloads.
 *
 *  ONE per-vendor gap the resolver owns: a Google-NATIVE doc (Docs / Sheets /
 *  Slides, `mimeType` = `application/vnd.google-apps.*`) has no binary content —
 *  `alt=media` 403s `fileNotDownloadable`; the bytes only exist via `files/{id}/
 *  export` into a chosen format. That format choice + the export call are out of
 *  v1 scope, so a native doc is `remote_unresolvable` (honest + permanent — a
 *  per-row gap, exactly like Notion's prong-2 property files), detected off the
 *  mirror's `meta.mime_type` BEFORE the fetch. Binary files (PDF / image / …)
 *  download normally.
 *
 *  Design: D-192. */

import { RpcError } from '@recued/contracts';

import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
/** The `mimeType` prefix of every Google-native (export-only) doc. */
const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.';

export interface GoogleRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

/** Build the `google` `RemoteFileByteResolver`. */
export const buildGoogleRemoteByteResolver = (
  deps: GoogleRemoteByteResolverDeps,
): RemoteFileByteResolver => async (req) => {
  // A native Google doc has no `alt=media` bytes — permanently unresolvable in v1
  // (export-into-format is out of scope). Guard off the mirror mime BEFORE the
  // fetch so the failure is the accurate `remote_unresolvable`, not a bare 403.
  if (req.meta.mime_type?.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
    throw new RpcError(
      'remote_unresolvable',
      `google native doc '${req.remote_id}' (${req.meta.mime_type}) has no direct byte download (export-only)`,
      422,
    );
  }
  const token = bearerTokenOrThrow(req.cred, 'google');
  return fetchRemoteBytes({
    fetchImpl: deps.fetchImpl,
    url: `${DRIVE_API}/files/${encodeURIComponent(req.remote_id)}?alt=media&supportsAllDrives=true`,
    headers: { authorization: `Bearer ${token}` },
    maxBytes: req.maxBytes,
    vendorLabel: 'google',
    ref: req.remote_id,
  });
};
