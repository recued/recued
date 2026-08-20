/** D-175 P5 — resolve the server → auth-Worker binding-exchange URL.
 *
 *  The binding loop's last hop is the paired server POSTing the relayed
 *  token to the auth Worker's `POST /v1/account/binding/exchange`
 *  endpoint. This module decides WHICH Worker URL that is so a fresh
 *  self-hosted server binds out-of-the-box with no manual env config.
 *
 *  Resolution order:
 *    1. An explicit `RECUED_ACCOUNT_BINDING_EXCHANGE_URL` override always
 *       wins (staging / dev / a private Worker mirror). Trimmed; an empty
 *       / whitespace value is ignored (falls through to the default).
 *    2. Otherwise `https://auth.<apex>`, where the apex is
 *       `RECUED_CLOUD_APEX` if set and `recued.com` otherwise. The auth
 *       Worker lives on the PUBLIC `recued.com` TLD, NOT the Pro-API
 *       `recued.cloud` family, so the two cannot be derived from each other
 *       — which is exactly why the apex is configured rather than computed
 *       from `cloud.base_url`.
 *
 *       ⛔ This used to sniff `cloud.base_url`'s host for a hardcoded mirror
 *       domain. Configuration replaced the sniff so no internal environment
 *       name ships in source that every self-hoster reads and no self-hoster
 *       can use.
 *
 *  The resolver always returns a concrete URL — there is no "unconfigured"
 *  hole any more (the endpoint shipped in the D-175 P5 Worker half). A
 *  missing / unreachable Worker still degrades gracefully: the exchange
 *  client maps a network failure onto `exchange_unavailable` (see
 *  `exchange-client.ts`), so binding fails closed rather than throwing.
 */

/** The apex the cloud services live on. `recued.com` is the real, public
 *  product domain and the only one this source names.
 *
 *  ⛔ A MIRROR APEX IS CONFIGURATION, NOT A CONSTANT. This used to carry a
 *  second hardcoded origin for the operator's own staging mirror, plus a
 *  host-suffix sniff to choose between them. That put an internal environment
 *  name in source shipped to every self-hoster, for a branch none of them can
 *  ever take. `RECUED_CLOUD_APEX` replaces the sniff: an operator running a
 *  mirror sets it, everyone else gets prod.
 *
 *  ⚠ Forgetting it on a mirror deployment fails LOUD, not silent: the prod
 *  auth Worker's `AUTH_ALLOWED_ORIGINS` does not include any mirror origin, so
 *  a mirror pointed at prod is rejected rather than quietly mixing
 *  environments. That is why detection can be dropped safely. */
export const CLOUD_APEX_DEFAULT = 'recued.com';

/** Prod auth-Worker origin (public `recued.com` TLD). */
export const AUTH_WORKER_ORIGIN_PROD = `https://auth.${CLOUD_APEX_DEFAULT}`;

/** The configured apex, trimmed; falls back to prod. */
export const resolveCloudApex = (
  env: Record<string, string | undefined> = process.env,
): string => env.RECUED_CLOUD_APEX?.trim() || CLOUD_APEX_DEFAULT;
/** The Worker's binding-exchange route (D-175 P5 Worker half). */
export const ACCOUNT_BINDING_EXCHANGE_PATH = '/v1/account/binding/exchange';

export interface ResolveAccountBindingExchangeUrlOptions {
  /** Explicit override — `RECUED_ACCOUNT_BINDING_EXCHANGE_URL`. Wins when
   *  set + non-empty (after trim). */
  override?: string;
  /** ⚠ RETAINED FOR CALLERS, NO LONGER READ. The environment used to be
   *  sniffed from this URL's host; it is now `RECUED_CLOUD_APEX`. Kept on the
   *  options type so existing call sites compile unchanged. */
  cloudBaseUrl?: string;
  /** Apex override for tests; production reads `RECUED_CLOUD_APEX`. */
  cloudApex?: string;
}

/** Resolve the auth-Worker binding-exchange URL the server posts to. */
export const resolveAccountBindingExchangeUrl = (
  options: ResolveAccountBindingExchangeUrlOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  const apex = options.cloudApex?.trim() || resolveCloudApex();
  return `https://auth.${apex}${ACCOUNT_BINDING_EXCHANGE_PATH}`;
};
