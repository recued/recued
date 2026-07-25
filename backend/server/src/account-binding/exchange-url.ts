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
 *    2. Otherwise the prod auth-Worker default — `auth.recued.com` — with
 *       the `recued2.com` staging variant, mirroring the dashboard's
 *       `resolveAuthWorkerUrl` (`apps/dashboard/src/dashboard.ts`). The
 *       auth Worker lives on the PUBLIC `recued.com` TLD (NOT the Pro-API
 *       `recued.cloud` family), so the staging mirror collapses onto
 *       `recued2.com`. A headless server has no `window.location.hostname`,
 *       so the environment signal is the configured cloud base URL
 *       (`cloud.base_url`): when its host is the `recued2.com` staging
 *       mirror, the auth Worker is `auth.recued2.com`; everything else
 *       (prod `api.recued.cloud`, test fixtures, an unparseable value) →
 *       prod `auth.recued.com`.
 *
 *  The resolver always returns a concrete URL — there is no "unconfigured"
 *  hole any more (the endpoint shipped in the D-175 P5 Worker half). A
 *  missing / unreachable Worker still degrades gracefully: the exchange
 *  client maps a network failure onto `exchange_unavailable` (see
 *  `exchange-client.ts`), so binding fails closed rather than throwing.
 */

/** Prod auth-Worker origin (public `recued.com` TLD). */
export const AUTH_WORKER_ORIGIN_PROD = 'https://auth.recued.com';
/** Staging auth-Worker origin (the `recued2.com` mirror). */
export const AUTH_WORKER_ORIGIN_STAGING = 'https://auth.recued2.com';
/** The Worker's binding-exchange route (D-175 P5 Worker half). */
export const ACCOUNT_BINDING_EXCHANGE_PATH = '/v1/account/binding/exchange';

/** True iff the configured cloud base URL points at the `recued2.com`
 *  staging mirror — mirrors the dashboard's `host.endsWith('.recued2.com')`
 *  check, applied to the cloud base URL's host (a headless server's
 *  environment signal). An absent / unparseable value is treated as prod
 *  (the safe default — never silently route a prod server at staging). */
const isRecued2CloudHost = (cloudBaseUrl: string | undefined): boolean => {
  if (!cloudBaseUrl) return false;
  let host: string;
  try {
    host = new URL(cloudBaseUrl).hostname;
  } catch {
    return false;
  }
  return host.endsWith('.recued2.com');
};

export interface ResolveAccountBindingExchangeUrlOptions {
  /** Explicit override — `RECUED_ACCOUNT_BINDING_EXCHANGE_URL`. Wins when
   *  set + non-empty (after trim). */
  override?: string;
  /** The server's configured cloud base URL (`cloud.base_url`). Its host
   *  selects prod vs. the `recued2.com` staging Worker. */
  cloudBaseUrl?: string;
}

/** Resolve the auth-Worker binding-exchange URL the server posts to. */
export const resolveAccountBindingExchangeUrl = (
  options: ResolveAccountBindingExchangeUrlOptions = {},
): string => {
  const override = options.override?.trim();
  if (override) return override;
  const origin = isRecued2CloudHost(options.cloudBaseUrl)
    ? AUTH_WORKER_ORIGIN_STAGING
    : AUTH_WORKER_ORIGIN_PROD;
  return `${origin}${ACCOUNT_BINDING_EXCHANGE_PATH}`;
};
