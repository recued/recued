/** D-192 remote byte-fetch (follow-on B) — the per-vendor resolver registry.
 *
 *  Assembles the `provider → RemoteFileByteResolver` map the read orchestrator
 *  dispatches on (keyed on `FileMetaProjection.provider` = the vendor slug). S3
 *  was the reference resolver; the rest fan out here — Dropbox / Google Drive /
 *  OneDrive / Box are small bearer/Graph downloads over the shared `http-bytes`
 *  spine, SharePoint reuses the OneDrive Graph resolver (a document library IS a
 *  Graph drive), and Notion re-resolves a fresh signed url per read (prong-1
 *  block files only; prong-2 property files stay `remote_unresolvable`).
 *  Design: `docs/d-192-remote-byte-fetch-design.md`. */

import type { RemoteFileByteResolverRegistry } from '../remote-file-byte-resolver.js';
import { defaultFileFetch, type FileFetch } from '../../../file-source-adapters/index.js';
import { buildBoxRemoteByteResolver } from './box.js';
import { buildDropboxRemoteByteResolver } from './dropbox.js';
import { buildGoogleRemoteByteResolver } from './google.js';
import { buildNotionRemoteByteResolver } from './notion.js';
import { buildOneDriveRemoteByteResolver } from './onedrive.js';
import { buildS3RemoteByteResolver } from './s3.js';

export interface RemoteFileByteResolverBuildDeps {
  /** The injected fetch (defaults to the shared `defaultFileFetch` — the same
   *  one the list adapters use). */
  fetchImpl?: FileFetch;
}

/** Build the provider → byte-resolver registry wired at boot. */
export const buildRemoteFileByteResolvers = (
  deps: RemoteFileByteResolverBuildDeps = {},
): RemoteFileByteResolverRegistry => {
  const fetchImpl = deps.fetchImpl ?? defaultFileFetch;
  // SharePoint and OneDrive share the Graph resolver verbatim (a SharePoint
  // library is a Graph drive, targeted by `config.drive_id`); the label only
  // flavors error messages.
  const onedrive = buildOneDriveRemoteByteResolver({ fetchImpl });
  return {
    s3: buildS3RemoteByteResolver({ fetchImpl }),
    dropbox: buildDropboxRemoteByteResolver({ fetchImpl }),
    google: buildGoogleRemoteByteResolver({ fetchImpl }),
    onedrive,
    sharepoint: buildOneDriveRemoteByteResolver({ fetchImpl }, { vendorLabel: 'sharepoint' }),
    box: buildBoxRemoteByteResolver({ fetchImpl }),
    notion: buildNotionRemoteByteResolver({ fetchImpl }),
  };
};
