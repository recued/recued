/** D-218 slice 0 — what `connection.api` does with an atproto row.
 *
 *  ⚠ **Updated by slice 1, deliberately.** Slice 0 shipped the type without an
 *  exchange, so a row that had never minted a session could only REFUSE, and
 *  that refusal is what these tests pinned. Slice 1 makes the absent-token case
 *  self-resolving — so the assertion inverts rather than disappearing: an
 *  unexchanged row now LOGS IN. What survives unchanged is the pair that was
 *  never about slicing: the accessJwt goes on the wire, and the app password
 *  never does.
 *
 *  🔑 One slice-0 assertion earned its keep on the way out: it drove a
 *  WHITESPACE-only token, and slice 1's freshness gate checked `!== ''` where
 *  `injectAuth` checks `.trim()`. That row would have failed every dispatch
 *  with no exchange ever attempted. The gate now trims.
 *
 *  Spec: D-218 § 7.5a, § 8.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createConnectionApiHandler } from '../connection-api.js';
import { IngredientError } from '../types.js';

const row: ConnectionRow = {
  pk: 'api:bluesky',
  kind: 'api',
  name: 'bluesky',
  display_name: 'Bluesky',
  config_json: '{"base_url":"https://bsky.social"}',
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const session = (over: Record<string, unknown> = {}): ConnectionAuth => ({
  type: 'atproto_session',
  identifier: 'alice.bsky.social',
  app_password: 'abcd-efgh-ijkl-mnop',
  ...over,
} as ConnectionAuth);

const run = async (
  auth: ConnectionAuth,
): Promise<{ headers: Record<string, string>; calls: number }> => {
  let calls = 0;
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    calls += 1;
    headers = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    return new Response('{}', {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  await createConnectionApiHandler({
    decodeAuth: async () => auth,
    persistAuth: async () => {},
    fetchImpl,
  })(row, { method: 'GET', path: '/xrpc/app.bsky.actor.getProfile' },
    { slug: 'bluesky.profile', output: {}, input: {} } as never);
  return { headers, calls };
};

describe('D-218 — an exchanged session is an ordinary bearer', () => {
  it('sends the accessJwt', async () => {
    const { headers } = await run(session({ current_access_token: 'jwt-live' }));
    expect(headers.authorization).toBe('Bearer jwt-live');
  });

  it('⛔ never sends the app password', async () => {
    // The stored credential is not the thing that goes on the wire. Sending it
    // would put a reusable account credential on every request.
    const { headers } = await run(session({ current_access_token: 'jwt-live' }));
    expect(JSON.stringify(headers)).not.toContain('abcd-efgh-ijkl-mnop');
  });
});

describe('D-218 — a row with no usable token EXCHANGES first (slice 1)', () => {
  it.each([
    ['absent', {}],
    ['empty', { current_access_token: '' }],
    // ⚠ The case that found the bug: `injectAuth` trims, so the gate must too,
    // or this row fails forever without ever attempting a login.
    ['whitespace', { current_access_token: '   ' }],
  ])('logs in when the accessJwt is %s', async (_label, over) => {
    const seen: string[] = [];
    const fetchImpl = (async (u: unknown) => {
      seen.push(String(u));
      return new Response(
        JSON.stringify({ accessJwt: 'jwt-new', refreshJwt: 'refresh-new' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await createConnectionApiHandler({
      decodeAuth: async () => session(over),
      persistAuth: async () => {},
      fetchImpl,
    })(row, { method: 'GET', path: '/xrpc/app.bsky.actor.getProfile' },
      { slug: 'bluesky.profile', output: {}, input: {} } as never);

    expect(seen[0]).toBe('https://bsky.social/xrpc/com.atproto.server.createSession');
    // …and the op itself then runs with the freshly minted token.
    expect(seen[1]).toContain('/xrpc/app.bsky.actor.getProfile');
  });
});
