/** D-322 §23 — an isolated, protected GET proves access before a named credential swap. */
import { RpcError, type ConnectionHealth, type ManagedOAuthAuth, type DirectOAuthAuth } from '@recued/contracts';
import { injectConnectionApiAuth } from '@recued/ingredients';
import type { ManagedOAuthService } from './managed-oauth-service.js';

const refused = (status: ConnectionHealth['status'], reason: string): RpcError => new RpcError(
  'credential_verification_failed',
  status === 'auth_failed'
    ? 'The selected account could not access this resource. Review its permissions or choose another account. Your saved authentication was kept.'
    : 'API access could not be verified. Use a read-only URL that requires sign-in, then try again. Your saved authentication was kept.',
  422, 'collection.connection.managedOAuth', {
    verification_status: status, reason, existing_credential_preserved: true,
  },
);

export const verifyManagedOAuthAccess = async (deps: {
  broker: ManagedOAuthService; fetchImpl: typeof fetch; now(): number;
}, auth: ManagedOAuthAuth, url: string): Promise<ConnectionHealth> => {
  try {
    await deps.broker.verifySwitchAccount(auth);
    const authenticated = await deps.broker.fetch(auth, url, {
      method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    await authenticated.body?.cancel().catch(() => {});
    if (!authenticated.ok) throw refused([401, 403].includes(authenticated.status) ? 'auth_failed' : 'unknown', `http_status_${authenticated.status}`);
    // An invalid Nango ID would only test the broker's lookup. Call the SAME
    // vendor resource without credentials to reject public endpoints instead.
    const anonymous = await deps.fetchImpl(url, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    await anonymous.body?.cancel().catch(() => {});
    if (![401, 403].includes(anonymous.status)) throw refused('unknown', 'credential_check_did_not_require_auth');
    return { status: 'ok', last_probed_at: deps.now() };
  } catch (error) {
    if (error instanceof RpcError && ['credential_verification_failed', 'conflict', 'broker_unavailable'].includes(error.code)) throw error;
    throw refused('unreachable', 'managed_oauth_access_check_unavailable');
  }
};

/** Native candidates are renewed server-side before reaching this protected read. */
export const verifyDirectOAuthAccess = async (deps: {
  fetchImpl: typeof fetch; now(): number;
}, auth: DirectOAuthAuth, url: string): Promise<ConnectionHealth> => {
  try {
    if (!auth.current_access_token || auth.expires_at !== undefined && auth.expires_at <= deps.now()) {
      throw refused('auth_failed', 'direct_oauth_access_token_unavailable');
    }
    const target = new URL(url); const headers = new Headers({ Accept: 'application/json' });
    injectConnectionApiAuth(auth, headers, target, { method: 'GET', nowMs: deps.now() });
    const authenticated = await deps.fetchImpl(target, { method: 'GET', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    await authenticated.body?.cancel().catch(() => {});
    if (!authenticated.ok || authenticated.redirected) throw refused([401, 403].includes(authenticated.status) ? 'auth_failed' : 'unknown', `http_status_${authenticated.status}`);
    const anonymous = await deps.fetchImpl(target, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    await anonymous.body?.cancel().catch(() => {});
    if (![401, 403].includes(anonymous.status)) throw refused('unknown', 'credential_check_did_not_require_auth');
    return { status: 'ok', last_probed_at: deps.now() };
  } catch (error) {
    if (error instanceof RpcError && ['credential_verification_failed', 'conflict'].includes(error.code)) throw error;
    throw refused('unreachable', 'direct_oauth_access_check_unavailable');
  }
};
