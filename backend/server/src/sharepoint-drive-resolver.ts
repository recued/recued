/** D-192 CORE #5e — SharePoint site → document-library drive-id resolver.
 *
 *  SharePoint document libraries are Microsoft Graph drives, and the shared
 *  OneDrive `/delta` leaf walks one by `config.drive_id`
 *  (`/drives/{drive_id}/root/delta`). A `drive_id` is an opaque `b!…` string a
 *  user otherwise has to hand-copy out of Graph Explorer — real enrollment
 *  friction. This module turns a pasted SITE URL
 *  (`https://contoso.sharepoint.com/sites/TeamDocs`) into the site's DEFAULT
 *  document library drive id via one Graph call, so enrollment resolves it
 *  automatically (`connection-handler.ts` `handleConnectionEnroll`, gated on
 *  `vendor === 'sharepoint'` + a `site_url` + no explicit `drive_id`).
 *
 *  The Graph addressing: `GET /sites/{hostname}:/{server-relative-path}:/drive`
 *  returns the DEFAULT library's drive (`:/drive`, singular — no multi-library
 *  ambiguity to resolve; an advanced user who needs a NON-default library still
 *  pastes its `drive_id` directly). `fetchImpl` is injected so this unit-tests
 *  without the network. Failure modes are classified into user-facing reasons
 *  the enroll dialog surfaces (bad URL / missing `Sites.Read.All` / site not
 *  found / malformed response).
 *
 *  Spec: `docs/d-192-file-source-family.md`; enrollment sibling of `onedrive.ts`. */

import { MICROSOFT_GRAPH_API_BASE } from '@recued/contracts';

export type SharePointDriveResolution =
  | { ok: true; drive_id: string }
  | { ok: false; reason: string };

/** Parse a SharePoint site URL into the two Graph site-addressing pieces:
 *  `https://contoso.sharepoint.com/sites/TeamDocs` →
 *  `{ hostname: 'contoso.sharepoint.com', sitePath: 'sites/TeamDocs' }`. The
 *  `sitePath` is the URL path minus leading/trailing slashes — already
 *  percent-encoded by the `URL` parser, so it drops straight into the Graph
 *  addressing — or `''` for the tenant root site. Returns `{ error }` for a
 *  non-URL / non-https / host-less input (a clear enroll error, not a 4xx). */
export const parseSharePointSiteUrl = (
  raw: string,
): { hostname: string; sitePath: string } | { error: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `is not a valid URL ('${raw}')` };
  }
  if (url.protocol !== 'https:') {
    return { error: `must be an https URL ('${raw}')` };
  }
  if (url.hostname === '') {
    return { error: `has no host ('${raw}')` };
  }
  const sitePath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  return { hostname: url.hostname, sitePath };
};

/** The Graph URL for a site's DEFAULT document library drive. A path-less URL
 *  (the tenant root site) uses the plain `/sites/{hostname}/drive` form; a site
 *  with a server-relative path uses the colon-addressed
 *  `/sites/{hostname}:/{path}:/drive`. */
const driveEndpoint = (graphBase: string, hostname: string, sitePath: string): string => {
  const base = graphBase.replace(/\/+$/, '');
  return sitePath === ''
    ? `${base}/sites/${hostname}/drive`
    : `${base}/sites/${hostname}:/${sitePath}:/drive`;
};

/** Resolve the default document library's Graph drive id for a SharePoint site
 *  URL, using a caller-supplied access token (the enroll host refreshes the
 *  just-granted OAuth token to obtain one). One `GET …:/drive`; the `.id` is the
 *  drive id the leaf walks. Never throws — every failure (transport, HTTP,
 *  malformed) maps to a classified `{ ok: false, reason }` the dialog shows. */
export const resolveSharePointDriveId = async (opts: {
  siteUrl: string;
  token: string;
  graphBase?: string;
  fetchImpl: typeof fetch;
}): Promise<SharePointDriveResolution> => {
  const parsed = parseSharePointSiteUrl(opts.siteUrl);
  if ('error' in parsed) {
    return { ok: false, reason: `SharePoint site URL ${parsed.error}.` };
  }
  const endpoint = driveEndpoint(
    opts.graphBase ?? MICROSOFT_GRAPH_API_BASE,
    parsed.hostname,
    parsed.sitePath,
  );
  let res: Response;
  try {
    res = await opts.fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.token}` },
    });
  } catch (e) {
    return {
      ok: false,
      reason: `couldn't reach Microsoft Graph to resolve the SharePoint library (${e instanceof Error ? e.message : String(e)}).`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      reason:
        `Microsoft Graph denied access to the SharePoint site (HTTP ${res.status}) — grant the Entra app the 'Sites.Read.All' delegated Graph permission and re-authorize.`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      reason: `SharePoint site or its document library was not found (HTTP 404) — double-check the site URL '${opts.siteUrl}'.`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `Microsoft Graph returned HTTP ${res.status} resolving the SharePoint library.`,
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'Microsoft Graph returned a malformed drive response.' };
  }
  const id =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).id
      : undefined;
  if (typeof id !== 'string' || id === '') {
    return { ok: false, reason: "Microsoft Graph drive response carried no 'id'." };
  }
  return { ok: true, drive_id: id };
};
