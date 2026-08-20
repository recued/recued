/** The apex the cloud services (auth Worker, dashboard, marketplace apex) live
 *  on, fixed at BUILD time.
 *
 *  ⛔ WHY THIS EXISTS. Three resolvers used to sniff `location.hostname` for a
 *  hardcoded mirror domain and swap in that mirror's siblings. It worked, and it
 *  put an internal environment name into source that every reader of the public
 *  repository sees and no self-hoster can ever use. The environment is a
 *  property of the DEPLOYMENT, not something to re-derive at runtime from the
 *  address bar — a mirror build passes `--cloud-apex`, and the default is the
 *  real product domain.
 *
 *  ⚠ It also deletes a special case rather than moving it. One mirror host lived
 *  on the product apex (`<mirror>-app.recued.com`), so pure host derivation was
 *  wrong for it and the old code carried an explicit exception. A build-time
 *  value has no such problem: the build that serves that host is the mirror
 *  build, so it already knows. */
declare const __RECUED_CLOUD_APEX__: string | undefined;

/** The product apex. The only domain this source names. */
export const CLOUD_APEX_DEFAULT = 'recued.com';

/** Resolved once — esbuild inlines the define, so this folds to a constant. */
export const CLOUD_APEX: string =
  (typeof __RECUED_CLOUD_APEX__ === 'string' && __RECUED_CLOUD_APEX__.trim())
  || CLOUD_APEX_DEFAULT;

/** `https://<service>.<apex>` — e.g. `cloudOrigin('auth')`. */
export const cloudOrigin = (service: string, apex: string = CLOUD_APEX): string =>
  `https://${service}.${apex}`;

/** `https://<apex>` — the marketplace/discover apex origin. */
export const cloudApexOrigin = (apex: string = CLOUD_APEX): string => `https://${apex}`;
