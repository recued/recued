/** D-238 § 2a — the JOIN between the notification refresher and the one
 *  credential read every outbound messenger path goes through.
 *
 *  ⛔ The refresher's own unit suite
 *  (`d-238-messenger-notification-refresh.test.ts`) and this repo's existing
 *  channel tests can BOTH be green while the seam between them never runs —
 *  the refresher stubbed on one side, the resolver stubbed on the other, and
 *  nothing asserting that `createRemoteCredentialResolver` actually consults it.
 *  This file exists to make that join a real line of execution.
 *
 *  🔑 **The assertion that matters is ORDERING, not renewal.**
 *  `resolveMessengerSendToken` is a pure narrowing over whatever shape it is
 *  handed — an EXPIRED `current_access_token` resolves exactly as happily as a
 *  live one. So a resolver that refreshed *after* reading the token would look
 *  correct in every unit test and quietly send the stale value forever. The test
 *  below proves the resolver emits the REFRESHER'S output, not the row's.
 *
 *  ⚠ Why the ordering fixtures use `bearer` rather than `oauth2_refresh`: they
 *  are isolating the SEAM ORDER from the ENROLLMENT POLICY, which are separate
 *  questions that used to have the same answer. (They were written while
 *  `MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth` was still `[]`, when an
 *  oauth fixture would have resolved to null for a reason having nothing to do
 *  with ordering.) Keeping them on `bearer` is deliberate even now that oauth is
 *  wired: it means a future change to the oauth policy cannot silently turn the
 *  ordering assertions vacuous. The last two cases pin the policy itself. */

import { describe, expect, it } from 'vitest';

import { MESSENGER_AUTH_KIND_CONNECTION_TYPES, type ConnectionAuth } from '@recued/contracts';

import { createRemoteCredentialResolver } from '../composition/bin/wire-remote-channel.js';
import type { MessengerNotificationRefresher } from '../messenger-notification-refresh.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

/** No key manager is wired in these tests, so `encodeAuthForStorage` /
 *  `decodeAuthFromStorage` fall to their base64-JSON branch. */
const plaintextBlob = (auth: ConnectionAuth): string =>
  Buffer.from(JSON.stringify(auth), 'utf8').toString('base64');

const storeWith = (auth: ConnectionAuth, config: object): ConnectionStoreSqlite =>
  ({
    get: (kind: string, name: string) =>
      kind === 'notification' && name === 'teams'
        ? {
            pk: `${kind}:${name}`,
            kind,
            name,
            subtype: 'teams',
            display_name: 'Teams',
            config_json: JSON.stringify(config),
            auth_ciphertext: plaintextBlob(auth),
          }
        : null,
  }) as unknown as ConnectionStoreSqlite;

const recipientFromChatId = (config: Record<string, unknown> | null): string | null =>
  config !== null && typeof config.chat_id === 'string' ? config.chat_id : null;

describe('createRemoteCredentialResolver × the notification refresher', () => {
  it('passes the DECODED row auth to the refresher, keyed by vendor', async () => {
    const seen: Array<{ vendor: string; auth: ConnectionAuth }> = [];
    const refreshAuth: MessengerNotificationRefresher = {
      refreshIfNeeded: async (vendor, auth) => {
        seen.push({ vendor, auth });
        return auth;
      },
    };
    const resolve = createRemoteCredentialResolver({
      connectionStore: storeWith({ type: 'bearer', token: 'tok' }, { chat_id: 'c1' }),
      vendor: 'teams',
      resolveRecipient: recipientFromChatId,
      refreshAuth,
    });

    await resolve();

    expect(seen).toEqual([
      { vendor: 'teams', auth: { type: 'bearer', token: 'tok' } },
    ]);
  });

  /** ⛔ THE JOIN. A resolver that read the send token off the row and refreshed
   *  afterwards would pass every other test in both suites and ship a channel
   *  that authenticates with an expired credential forever. */
  it('sends with the REFRESHED credential, not the one stored on the row', async () => {
    const refreshAuth: MessengerNotificationRefresher = {
      refreshIfNeeded: async () => ({ type: 'bearer', token: 'fresh' }),
    };
    const resolve = createRemoteCredentialResolver({
      connectionStore: storeWith({ type: 'bearer', token: 'stale' }, { chat_id: 'c1' }),
      vendor: 'teams',
      resolveRecipient: recipientFromChatId,
      refreshAuth,
    });

    await expect(resolve()).resolves.toEqual({ token: 'fresh', recipient: 'c1' });
  });

  it('is a pass-through when no refresher is wired — every vendor shipping today', async () => {
    const resolve = createRemoteCredentialResolver({
      connectionStore: storeWith({ type: 'bearer', token: 'xoxb-static' }, { chat_id: 'c1' }),
      vendor: 'teams',
      resolveRecipient: recipientFromChatId,
    });
    await expect(resolve()).resolves.toEqual({ token: 'xoxb-static', recipient: 'c1' });
  });

  it('never consults the refresher when there is no row to refresh', async () => {
    let called = 0;
    const refreshAuth: MessengerNotificationRefresher = {
      refreshIfNeeded: async (_v, a) => {
        called += 1;
        return a;
      },
    };
    const resolve = createRemoteCredentialResolver({
      connectionStore: { get: () => null } as unknown as ConnectionStoreSqlite,
      vendor: 'teams',
      resolveRecipient: recipientFromChatId,
      refreshAuth,
    });
    await expect(resolve()).resolves.toBeNull();
    expect(called).toBe(0);
  });

  /** The OTHER half of § 2a, now landed. This test previously asserted the
   *  opposite — that an `oauth2_refresh` row resolved to null because
   *  `MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth` was `[]` — and its comment
   *  named itself as the assertion that should go red when the map flipped.
   *  It did, on the first run after the flip. Kept (inverted) rather than
   *  deleted, because the shape it pins is the whole point of D-238 § 2a: an
   *  expiring credential is now a first-class messenger credential. */
  it('resolves an oauth2_refresh row — the enroll gate has moved', async () => {
    const oauth: ConnectionAuth = {
      type: 'oauth2_refresh',
      refresh_token: 'rt',
      client_id: 'cid',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      current_access_token: 'at-live-and-valid',
      expires_at: Date.now() + 3_600_000,
    };
    const resolve = createRemoteCredentialResolver({
      connectionStore: storeWith(oauth, { chat_id: 'c1' }),
      vendor: 'teams',
      resolveRecipient: recipientFromChatId,
      refreshAuth: { refreshIfNeeded: async (_v, a) => a },
    });
    await expect(resolve()).resolves.toEqual({
      token: 'at-live-and-valid',
      recipient: 'c1',
    });
  });

  /** ⛔ The regression that would undo D-238 § 2a without failing anything else.
   *  `oauth` must map to the REFRESHABLE shape and nothing else — a `bearer`
   *  entry would let someone enroll a snapshot of a one-hour Graph token, which
   *  probes green and dies at the top of the hour. Asserted here, at the send
   *  seam, as well as on the map itself, because this is the layer where the
   *  damage would actually show up. */
  it('a static bearer is NOT what an oauth vendor may enroll', () => {
    expect(MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth).not.toContain('bearer');
    expect(MESSENGER_AUTH_KIND_CONNECTION_TYPES.oauth).toContain('oauth2_refresh');
  });
});
