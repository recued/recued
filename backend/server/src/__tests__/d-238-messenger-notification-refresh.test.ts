/** D-238 § 2a item 2 — the `kind: 'notification'` OAuth2 refresher.
 *
 *  The module exists so a chat transport whose credential EXPIRES can deliver at
 *  all. Every vendor before Teams is a static `bot_token`; Teams is a Graph
 *  delegated token that dies in about an hour.
 *
 *  ⛔ The tests below are weighted toward the FAILURE paths rather than the happy
 *  one, because the whole reason `MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth` is
 *  `[]` is that an oauth notification row already probes green and reports ready.
 *  A refresher that threw, or returned null, or failed quietly would rebuild the
 *  exact green-ready-and-mute channel the empty list was protecting against — so
 *  "never throws", "never returns null", and "every failure reaches onFailure"
 *  are the load-bearing assertions here, not the renewal itself. */

import { describe, expect, it } from 'vitest';

import { OAUTH2_REFRESH_LEAD_MS, type ConnectionAuth } from '@recued/contracts';

import {
  createMessengerNotificationRefresher,
  messengerAuthNeedsRefresh,
  type MessengerRefreshFailure,
  type OAuth2RefreshAuth,
} from '../messenger-notification-refresh.js';

const NOW = 1_700_000_000_000;

const oauthAuth = (over: Partial<OAuth2RefreshAuth> = {}): OAuth2RefreshAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'rt-original',
  client_id: 'cid',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  current_access_token: 'at-original',
  expires_at: NOW + 3_600_000,
  ...over,
});

const freshAuth: ConnectionAuth = {
  type: 'oauth2_refresh',
  refresh_token: 'rt-rotated',
  client_id: 'cid',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  current_access_token: 'at-rotated',
  expires_at: NOW + 3_600_000,
};

describe('messengerAuthNeedsRefresh', () => {
  it('never refreshes a non-oauth2_refresh shape — a bot token cannot expire', () => {
    const bearer: ConnectionAuth = { type: 'bearer', token: 'xoxb-static' };
    expect(messengerAuthNeedsRefresh(bearer, NOW)).toBe(false);
  });

  it('leaves a token alone while it is comfortably in date', () => {
    expect(messengerAuthNeedsRefresh(oauthAuth(), NOW)).toBe(false);
  });

  it('refreshes once inside the lead window', () => {
    const auth = oauthAuth({ expires_at: NOW + OAUTH2_REFRESH_LEAD_MS - 1 });
    expect(messengerAuthNeedsRefresh(auth, NOW)).toBe(true);
  });

  it('refreshes an already-expired token', () => {
    expect(messengerAuthNeedsRefresh(oauthAuth({ expires_at: NOW - 1 }), NOW)).toBe(true);
  });

  it('refreshes when there is no access token to try', () => {
    expect(messengerAuthNeedsRefresh(oauthAuth({ current_access_token: undefined }), NOW))
      .toBe(true);
    expect(messengerAuthNeedsRefresh(oauthAuth({ current_access_token: '   ' }), NOW))
      .toBe(true);
  });

  /** 🔑 The anti-churn rule, and it is deliberate rather than an omission.
   *  Refresh-token ROTATION means every exchange invalidates the previous token,
   *  so "refresh whenever the expiry is unknown" would rotate the credential on
   *  every single send and widen the window where a failed exchange strands the
   *  row. With a token in hand and no stated expiry, using it and letting a 401
   *  be the signal costs one wasted call; churning costs the connection. */
  it('does NOT refresh on an unknown expiry when a token is present', () => {
    const auth = oauthAuth({ expires_at: undefined });
    expect(messengerAuthNeedsRefresh(auth, NOW)).toBe(false);
  });
});

describe('createMessengerNotificationRefresher', () => {
  const build = (over: {
    refresh?: (a: OAuth2RefreshAuth) => Promise<ConnectionAuth>;
    persist?: (v: string, a: ConnectionAuth) => Promise<void>;
  } = {}) => {
    const calls = { refresh: 0, persist: 0 };
    const persisted: ConnectionAuth[] = [];
    const failures: MessengerRefreshFailure[] = [];
    const refresher = createMessengerNotificationRefresher({
      refresh: async (a) => {
        calls.refresh += 1;
        return over.refresh ? over.refresh(a) : freshAuth;
      },
      persist: async (v, a) => {
        calls.persist += 1;
        if (over.persist) return over.persist(v, a);
        persisted.push(a);
      },
      now: () => NOW,
      onFailure: (f) => failures.push(f),
    });
    return { refresher, calls, persisted, failures };
  };

  it('passes a healthy credential straight through without an exchange', async () => {
    const { refresher, calls } = build();
    const auth = oauthAuth();
    await expect(refresher.refreshIfNeeded('teams', auth)).resolves.toBe(auth);
    expect(calls.refresh).toBe(0);
  });

  it('renews an expiring credential and persists the rotation', async () => {
    const { refresher, calls, persisted } = build();
    const got = await refresher.refreshIfNeeded('teams', oauthAuth({ expires_at: NOW - 1 }));
    expect(got).toBe(freshAuth);
    expect(calls.refresh).toBe(1);
    expect(persisted).toEqual([freshAuth]);
  });

  /** ⛔ The window this closes is small and permanent. With rotation the provider
   *  invalidates the OLD refresh token the moment the exchange succeeds, so a
   *  crash between "sent with the new token" and "stored it" leaves the row
   *  holding a token that can never refresh again — re-consent, caused by an
   *  ordering we control. Persist must complete BEFORE the caller can use it. */
  it('persists BEFORE handing the credential out', async () => {
    const order: string[] = [];
    const refresher = createMessengerNotificationRefresher({
      refresh: async () => {
        order.push('refresh');
        return freshAuth;
      },
      persist: async () => {
        order.push('persist');
      },
      now: () => NOW,
    });
    await refresher.refreshIfNeeded('teams', oauthAuth({ expires_at: NOW - 1 }));
    order.push('returned');
    expect(order).toEqual(['refresh', 'persist', 'returned']);
  });

  it('returns the ORIGINAL credential and reports when the exchange fails', async () => {
    const { refresher, failures } = build({
      refresh: () => Promise.reject(new Error('invalid_grant')),
    });
    const auth = oauthAuth({ expires_at: NOW - 1 });
    const got = await refresher.refreshIfNeeded('teams', auth);
    // Never null, never a throw: a stale token 401s visibly at the provider,
    // whereas the caller's null branch is the silent drop.
    expect(got).toBe(auth);
    expect(failures).toEqual([
      { vendor: 'teams', reason: 'refresh_failed', detail: 'invalid_grant' },
    ]);
  });

  it('reports a persist failure loudly but still lets THIS send succeed', async () => {
    const { refresher, failures } = build({
      persist: () => Promise.reject(new Error('disk full')),
    });
    const got = await refresher.refreshIfNeeded('teams', oauthAuth({ expires_at: NOW - 1 }));
    expect(got).toBe(freshAuth);
    expect(failures).toEqual([
      { vendor: 'teams', reason: 'persist_failed', detail: 'disk full' },
    ]);
  });

  /** ⛔ CORRECTNESS, not performance. A fan-out issues several sends at once and
   *  they read the same row; two concurrent exchanges each invalidate the
   *  other's refresh token and the last write wins, leaving a stored token the
   *  provider already consumed.
   *
   *  ⚠ The assertion is on the EXCHANGE COUNT, not on the returned value —
   *  both callers get an equal credential whether or not single-flight works, so
   *  asserting equality would pass against a broken implementation. */
  it('collapses concurrent callers onto ONE exchange', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const refresher = createMessengerNotificationRefresher({
      refresh: async () => {
        started += 1;
        await gate;
        return freshAuth;
      },
      persist: async () => {},
      now: () => NOW,
    });

    const expiring = oauthAuth({ expires_at: NOW - 1 });
    const a = refresher.refreshIfNeeded('teams', expiring);
    const b = refresher.refreshIfNeeded('teams', expiring);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(started).toBe(1);
    expect(ra).toBe(freshAuth);
    expect(rb).toBe(freshAuth);
  });

  it('does not collapse DIFFERENT vendors onto one exchange', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const refresher = createMessengerNotificationRefresher({
      refresh: async () => {
        started += 1;
        await gate;
        return freshAuth;
      },
      persist: async () => {},
      now: () => NOW,
    });
    const expiring = oauthAuth({ expires_at: NOW - 1 });
    const a = refresher.refreshIfNeeded('teams', expiring);
    const b = refresher.refreshIfNeeded('slack', expiring);
    release();
    await Promise.all([a, b]);
    expect(started).toBe(2);
  });

  it('releases the in-flight slot so a later expiry refreshes again', async () => {
    const { refresher, calls } = build();
    const expiring = oauthAuth({ expires_at: NOW - 1 });
    await refresher.refreshIfNeeded('teams', expiring);
    await refresher.refreshIfNeeded('teams', expiring);
    expect(calls.refresh).toBe(2);
  });

  it('releases the in-flight slot after a FAILED exchange too', async () => {
    const { refresher, calls, failures } = build({
      refresh: () => Promise.reject(new Error('boom')),
    });
    const expiring = oauthAuth({ expires_at: NOW - 1 });
    await refresher.refreshIfNeeded('teams', expiring);
    await refresher.refreshIfNeeded('teams', expiring);
    expect(calls.refresh).toBe(2);
    expect(failures).toHaveLength(2);
  });
});
