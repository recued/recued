/** D-192 remote byte-fetch (follow-on B) — the Box vendor resolver.
 *
 *  A Box mirror row's `remote_id` is the stable item id (the declaration maps
 *  `remote_id: 'id'`), so a byte read is one authenticated
 *  `GET /2.0/files/{id}/content`. Box answers that with a 302 to a short-lived
 *  `dl.boxcloud.com` download URL; the platform `fetch` follows it transparently
 *  (dropping the `Authorization` header on the cross-origin hop) → the bytes.
 *
 *  Box's file object carries no mime (the list projection omits it), so the mime
 *  comes purely from the download response `Content-Type`; the filename rides the
 *  mirror `meta`.
 *
 *  Design: D-192. */

import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

const BOX_API = 'https://api.box.com/2.0';

export interface BoxRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

/** Build the `box` `RemoteFileByteResolver`. */
export const buildBoxRemoteByteResolver = (
  deps: BoxRemoteByteResolverDeps,
): RemoteFileByteResolver => async (req) => {
  const token = bearerTokenOrThrow(req.cred, 'box');
  return fetchRemoteBytes({
    fetchImpl: deps.fetchImpl,
    url: `${BOX_API}/files/${encodeURIComponent(req.remote_id)}/content`,
    headers: { authorization: `Bearer ${token}` },
    maxBytes: req.maxBytes,
    vendorLabel: 'box',
    ref: req.remote_id,
  });
};
