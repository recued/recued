/** D-192 remote byte-fetch (follow-on B) — the OneDrive / SharePoint (Microsoft
 *  Graph) vendor resolver.
 *
 *  A Graph driveItem mirror row's `remote_id` is the stable item id (the
 *  declaration maps `remote_id: 'id'`), so a byte read is one authenticated
 *  `GET {drive}/items/{id}/content`. Graph answers that with a 302 to a
 *  short-lived pre-authenticated download URL; the platform `fetch` follows it
 *  transparently (and drops the `Authorization` header on the cross-origin hop,
 *  so the bearer never reaches the CDN) → the bytes.
 *
 *  Serves BOTH the `onedrive` vendor (default drive, `/me/drive`) and the
 *  `sharepoint` vendor (a document library IS a Graph drive) — identical logic;
 *  the only difference is the drive target, read from `config.drive_id` (a
 *  SharePoint library / another user's drive). Absent ⇒ the signed-in user's
 *  default drive. This mirrors the list leaf, which keys the same OneDrive `/delta`
 *  adapter on both slugs.
 *
 *  Design: `docs/d-192-remote-byte-fetch-design.md`. */

import type { RemoteFileByteResolver } from '../remote-file-byte-resolver.js';
import type { FileFetch } from '../../../file-source-adapters/index.js';
import { bearerTokenOrThrow, fetchRemoteBytes } from './http-bytes.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

export interface OneDriveRemoteByteResolverDeps {
  fetchImpl: FileFetch;
}

const readStringConfig = (config: Record<string, unknown>, field: string): string | undefined => {
  const v = config[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** Build the Graph `RemoteFileByteResolver` — serves `onedrive` + `sharepoint`.
 *  `opts.vendorLabel` only flavors the error `reason` strings so a SharePoint
 *  read's failures don't read "onedrive"; the download is identical. */
export const buildOneDriveRemoteByteResolver = (
  deps: OneDriveRemoteByteResolverDeps,
  opts: { vendorLabel?: string } = {},
): RemoteFileByteResolver => {
  const vendorLabel = opts.vendorLabel ?? 'onedrive';
  return async (req) => {
    const token = bearerTokenOrThrow(req.cred, vendorLabel);
    // `config.drive_id` targets a non-default drive (a SharePoint document
    // library / another user's drive); absent ⇒ the signed-in user's `/me/drive`.
    const driveId = readStringConfig(req.cred.config, 'drive_id');
    const item = `items/${encodeURIComponent(req.remote_id)}/content`;
    const url =
      driveId !== undefined
        ? `${GRAPH_API}/drives/${encodeURIComponent(driveId)}/${item}`
        : `${GRAPH_API}/me/drive/${item}`;
    return fetchRemoteBytes({
      fetchImpl: deps.fetchImpl,
      url,
      headers: { authorization: `Bearer ${token}` },
      maxBytes: req.maxBytes,
      vendorLabel,
      ref: req.remote_id,
    });
  };
};
