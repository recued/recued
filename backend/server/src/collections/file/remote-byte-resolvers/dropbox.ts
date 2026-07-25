/** D-192 remote byte-fetch (follow-on B) — the Dropbox vendor resolver.
 *
 *  A Dropbox mirror row's `remote_id` is the opaque file id (`id:abc123…`, the
 *  declaration maps `remote_id: 'id'`), so a byte read is one call to the content
 *  endpoint: `POST https://content.dropboxapi.com/2/files/download` with the file
 *  locator in the `Dropbox-API-Arg` header (Dropbox's content APIs pass their
 *  argument as a header, not a body — and the request MUST carry no
 *  `Content-Type`). The `id:…` locator is ASCII, so the JSON arg is header-safe
 *  without the `\uXXXX` escaping a Unicode path would need.
 *
 *  Dropbox's basic file metadata carries no mime (the list projection omits it),
 *  and the download responds `application/octet-stream`, so the resolver returns
 *  no mime → the orchestrator defaults it; the filename rides the mirror `meta`.
 *
 *  Design: D-192. */

import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

const DROPBOX_CONTENT_API = 'https://content.dropboxapi.com';

export interface DropboxRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

/** Build the `dropbox` `RemoteFileByteResolver`. */
export const buildDropboxRemoteByteResolver = (
  deps: DropboxRemoteByteResolverDeps,
): RemoteFileByteResolver => async (req) => {
  const token = bearerTokenOrThrow(req.cred, 'dropbox');
  return fetchRemoteBytes({
    fetchImpl: deps.fetchImpl,
    url: `${DROPBOX_CONTENT_API}/2/files/download`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      // The argument rides the header; the locator is the opaque `id:…` remote_id.
      'Dropbox-API-Arg': JSON.stringify({ path: req.remote_id }),
    },
    maxBytes: req.maxBytes,
    vendorLabel: 'dropbox',
    ref: req.remote_id,
  });
};
