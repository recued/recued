/** The per-connection API base URL, read from a `kind: 'api'` connection row's
 *  stored `config_json.base_url`. This is the tenant-specific endpoint a
 *  multi-tenant vendor is enrolled against (e.g. `https://acme.zendesk.com`,
 *  a self-hosted `https://gitlab.example.com`), as opposed to the pack's
 *  documented placeholder default (`api.default_base_url`, e.g.
 *  `https://example.zendesk.com`).
 *
 *  It feeds the gateway's `connectionBaseUrlResolver`, which the pagination
 *  origin-pin (`safeSameOriginPathFromLink`) uses to accept a vendor's absolute
 *  `links.next` / `Link:` continuation as same-origin. Handed `undefined`, the
 *  pin falls back to the placeholder default and rejects every real tenant's
 *  next-page URL as cross-origin — truncating the walk at page 1. So every code
 *  path that dispatches a paginating connection-api op (recipe execution, raw-op
 *  dispatch, AND background Source-mirror sync) must resolve it.
 *
 *  Extracted to its own module so the Source-sync composers can resolve it
 *  without a runtime import of the large `execute-handler` graph. Pure. */
export const connectionBaseUrlFromConfig = (
  configJson: string | undefined,
): string | undefined => {
  if (configJson === undefined) return undefined;
  try {
    const config = JSON.parse(configJson) as Record<string, unknown> | null;
    const base = config?.base_url;
    return typeof base === 'string' && base.trim().length > 0 ? base : undefined;
  } catch {
    return undefined;
  }
};
