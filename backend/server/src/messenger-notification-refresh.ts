/** D-238 § 2a item 2 — the `kind: 'notification'` OAuth2 refresher.
 *
 *  Every chat transport declared before Teams is `auth: 'bot_token'` — a STATIC
 *  bearer that never expires — so the messenger send path never needed to renew
 *  a credential. Teams is `auth: 'oauth'`: a Graph delegated token that dies in
 *  about an hour. `MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth` is `[]` and a boot
 *  check refuses any vendor whose auth kind has no deliverable shape, precisely
 *  so nobody ships the half-wired version. This module is the missing half.
 *
 *  ⛔ **The failure this exists to prevent is silence, so it must never add any.**
 *  An `oauth2_refresh` notification row already probes GREEN (the prober reads
 *  `current_access_token` through `resolveBearerAccessToken`) and reports READY
 *  (readiness only checks the row exists). If the send then dropped, the owner
 *  would see a healthy channel delivering nothing. Hence the two hard rules
 *  below: this function NEVER throws and NEVER returns null — a caller's null
 *  branch IS the silent drop — and every failure goes to `onFailure`, which the
 *  composition root wires to something the owner can actually see.
 *
 *  Contrast the api-side refresher (`composition/bin/wire-vendor-substrate.ts`
 *  `refreshAuth`): that one is REACTIVE, fired by a vendor client on a 401, which
 *  works because an api call has a caller who sees the error. A notification
 *  fan-out swallows errors by contract, so there is no 401 to react to — this one
 *  is PROACTIVE, refreshing on a lead window before the token expires.
 *
 *  Spec: D-238 § 2a. */

import { OAUTH2_REFRESH_LEAD_MS, type ConnectionAuth } from '@recued/contracts';

/** The `oauth2_refresh` member, narrowed. */
export type OAuth2RefreshAuth = Extract<ConnectionAuth, { type: 'oauth2_refresh' }>;

/** Why a refresh did not produce a fresh credential. Each is a distinct owner
 *  story, so they are separate rather than one opaque string:
 *
 *   - `refresh_failed`  — the token endpoint refused or was unreachable. The
 *     stored refresh token may be revoked (re-consent) or this may be transient.
 *   - `persist_failed`  — the dance SUCCEEDED but the rotated credential could
 *     not be stored. ⛔ The most dangerous one: providers that ROTATE refresh
 *     tokens (Microsoft does) invalidate the old one on use, so the row on disk
 *     is now stale and the next process start cannot refresh at all. This is a
 *     re-consent event, and it must be loud. */
export type MessengerRefreshFailureReason = 'refresh_failed' | 'persist_failed';

export interface MessengerRefreshFailure {
  readonly vendor: string;
  readonly reason: MessengerRefreshFailureReason;
  readonly detail: string;
}

export interface MessengerNotificationRefreshDeps {
  /** The OAuth2 refresh dance. Injected so this unit-tests without network;
   *  the composition root passes the shared `refreshOAuth2WithMetadata`. */
  readonly refresh: (auth: OAuth2RefreshAuth) => Promise<ConnectionAuth>;
  /** Encode + persist the rotated credential on the `connection.notification`
   *  row. Awaited BEFORE the token is handed out — see `refreshIfNeeded`.
   *
   *  ⚠ Takes the VENDOR as well as the credential, and must: the row is keyed
   *  `('notification', vendor)` (D-163 I-4 — the row name IS the vendor), and a
   *  `ConnectionAuth` carries no identity of its own. An earlier signature
   *  omitted it and left the writer with nothing to address. */
  readonly persist: (vendor: string, auth: ConnectionAuth) => Promise<void>;
  readonly now: () => number;
  /** ⛔ Required in production wiring. A refresh failure that goes nowhere
   *  recreates the exact green-ready-and-mute channel this module exists to
   *  prevent — the send would fail on an expired token with nothing anywhere
   *  saying so. Optional only so unit tests can omit it. */
  readonly onFailure?: (failure: MessengerRefreshFailure) => void;
}

/** Does this credential need renewing before it is used?
 *
 *  🔑 **An absent `expires_at` does NOT mean "refresh".** Providers that rotate
 *  refresh tokens issue a new one on every exchange, so refreshing on every send
 *  would churn the credential continuously and widen the window in which a failed
 *  or raced exchange strands the row. With an unknown expiry the honest move is
 *  to USE the token we have and let a 401 be the signal — a wasted call at worst.
 *  A MISSING access token is different: there is nothing to try, so refresh.
 *
 *  Non-`oauth2_refresh` shapes never need refreshing: every other member either
 *  IS the credential (`bearer`) or is refused at enroll. */
export const messengerAuthNeedsRefresh = (
  auth: ConnectionAuth,
  now: number,
): boolean => {
  if (auth.type !== 'oauth2_refresh') return false;
  const token = auth.current_access_token;
  if (typeof token !== 'string' || token.trim().length === 0) return true;
  if (typeof auth.expires_at !== 'number' || !Number.isFinite(auth.expires_at)) {
    return false;
  }
  return auth.expires_at - now <= OAUTH2_REFRESH_LEAD_MS;
};

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export interface MessengerNotificationRefresher {
  /** Return a credential safe to send with. Always resolves; never null.
   *  Returns the input UNCHANGED when nothing needs doing or when renewal
   *  fails — a stale token produces an honest 401 upstream, which is strictly
   *  better than the caller's null branch, which is a silent drop. */
  readonly refreshIfNeeded: (
    vendor: string,
    auth: ConnectionAuth,
  ) => Promise<ConnectionAuth>;
}

/** Build the refresher.
 *
 *  ⛔ **Single-flight per vendor is a CORRECTNESS requirement, not a
 *  performance one.** A notification fan-out can issue several sends at once
 *  (an ask goes to every enabled channel; the turn and live-control paths read
 *  the same row). With refresh-token ROTATION, two concurrent exchanges each
 *  invalidate the other's token and the last write wins — leaving a row whose
 *  stored refresh token was already consumed, which cannot be recovered without
 *  re-consent. The in-flight map collapses concurrent callers onto one exchange.
 *  Keyed by vendor because that IS the `connection.notification` row name
 *  (D-163 I-4). */
export const createMessengerNotificationRefresher = (
  deps: MessengerNotificationRefreshDeps,
): MessengerNotificationRefresher => {
  const inflight = new Map<string, Promise<ConnectionAuth>>();

  const exchange = async (
    vendor: string,
    auth: OAuth2RefreshAuth,
  ): Promise<ConnectionAuth> => {
    let fresh: ConnectionAuth;
    try {
      fresh = await deps.refresh(auth);
    } catch (err) {
      deps.onFailure?.({
        vendor,
        reason: 'refresh_failed',
        detail: describeError(err),
      });
      // The credential we were given, unchanged. Expired-but-present beats
      // absent: the send attempts and fails visibly at the provider.
      return auth;
    }

    // ⛔ Persist BEFORE handing the token out. With rotation, a crash between
    // "used the new token" and "stored it" loses the new refresh token while
    // the provider has already invalidated the old one — a permanent
    // re-consent, from a window we control. Awaiting closes that window.
    try {
      await deps.persist(vendor, fresh);
    } catch (err) {
      deps.onFailure?.({
        vendor,
        reason: 'persist_failed',
        detail: describeError(err),
      });
      // Still return `fresh`: this send should succeed, and refusing it would
      // not un-rotate the credential. The row on disk is the casualty, and
      // `onFailure` is what makes that visible rather than mysterious.
      return fresh;
    }
    return fresh;
  };

  const refreshIfNeeded = async (
    vendor: string,
    auth: ConnectionAuth,
  ): Promise<ConnectionAuth> => {
    if (!messengerAuthNeedsRefresh(auth, deps.now())) return auth;

    const pending = inflight.get(vendor);
    if (pending !== undefined) return pending;

    const run = exchange(vendor, auth as OAuth2RefreshAuth).finally(() => {
      inflight.delete(vendor);
    });
    inflight.set(vendor, run);
    return run;
  };

  return { refreshIfNeeded };
};
