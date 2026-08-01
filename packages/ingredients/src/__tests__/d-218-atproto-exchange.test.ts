/** D-218 slice 1 — the session exchange.
 *
 *  🔑 **The one call in the codebase that puts a long-lived ACCOUNT credential
 *  on the wire.** Every property below is about where that credential can go
 *  and what can be learned from it going wrong, so they are asserted against
 *  the real handler and the real fetch boundary rather than the helpers.
 *
 *  Spec: D-218 § 7.5b, § 7.5c, § 7.5d, § 8.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createEnsureFreshAuth } from '../connection-api.js';
import { IngredientError } from '../types.js';

const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';

const row = (base = 'https://bsky.social'): ConnectionRow => ({
  pk: 'api:bluesky',
  kind: 'api',
  name: 'bluesky',
  display_name: 'Bluesky',
  config_json: JSON.stringify({ base_url: base }),
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

const session = (over: Record<string, unknown> = {}): ConnectionAuth => ({
  type: 'atproto_session',
  identifier: 'alice.bsky.social',
  app_password: APP_PASSWORD,
  ...over,
} as ConnectionAuth);

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

const gate = (
  respond: (url: string) => Response,
  opts: {
    persistAuth?: (r: ConnectionRow, a: ConnectionAuth) => Promise<void>;
    onPersistFailure?: (r: ConnectionRow, e: unknown) => void;
  } = {},
): { ensure: ReturnType<typeof createEnsureFreshAuth>; sent: Sent[]; persisted: ConnectionAuth[] } => {
  const sent: Sent[] = [];
  const persisted: ConnectionAuth[] = [];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    sent.push({ url: String(u), method: String(init?.method), headers, body: init?.body });
    return respond(String(u));
  }) as unknown as typeof fetch;
  const ensure = createEnsureFreshAuth({
    fetchImpl,
    persistAuth: opts.persistAuth ?? (async (_r, a) => { persisted.push(a); }),
    ...(opts.onPersistFailure ? { onPersistFailure: opts.onPersistFailure } : {}),
  });
  return { ensure, sent, persisted };
};

const ok = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

/** ⚠ A FACTORY, not a value. A `Response` body can be read once, so a shared
 *  instance makes the second call in a test fail with "Body has already been
 *  read" — which reads exactly like a protocol bug and is not one. */
const tokens = (): Response => ok({ accessJwt: 'jwt-access', refreshJwt: 'jwt-refresh' });

describe('D-218 — createSession: the app password, and where it may go', () => {
  it('⛔ POSTs to an endpoint DERIVED from base_url, never a configured one', async () => {
    // § 7.5b — the whole reason this type carries no endpoint field. The
    // password can only reach the host the connection already talks to.
    const { ensure, sent } = gate(() => tokens());
    await ensure(row(), session());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://bsky.social/xrpc/com.atproto.server.createSession');
    expect(sent[0]!.method).toBe('POST');
  });

  it('follows the connection to a self-hosted PDS', async () => {
    // The derivation is not a hardcode — a PDS the owner runs still works,
    // because they point the whole connection at it.
    const { ensure, sent } = gate(() => tokens());
    await ensure(row('https://pds.example.org'), session());
    expect(sent[0]!.url).toBe('https://pds.example.org/xrpc/com.atproto.server.createSession');
  });

  it('sends identifier + password as a JSON BODY — the shape `basic` could not express', async () => {
    const { ensure, sent } = gate(() => tokens());
    await ensure(row(), session());

    expect(sent[0]!.headers['content-type']).toContain('application/json');
    expect(JSON.parse(String(sent[0]!.body))).toEqual({
      identifier: 'alice.bsky.social',
      password: APP_PASSWORD,
    });
    // ⛔ Not an Authorization header — that is exactly the mismatch that made
    // `basic` the wrong type for this protocol.
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it('⛔ REFUSES a cross-origin redirect before the password leaves the box', async () => {
    // A 307/308 preserves method AND body, so an open redirect on a
    // compromised PDS would re-POST the app password to the redirect target.
    const { ensure, sent } = gate((url) =>
      url.includes('createSession')
        ? new Response(null, { status: 307, headers: { location: 'https://evil.example.com/x' } })
        : tokens());

    let err: IngredientError | undefined;
    try { await ensure(row(), session()); } catch (e) { err = e as IngredientError; }

    // ⚠ **Assert the CAUSE, not the code.** `TOKEN_REFRESH_FAILED` is what an
    // unfollowed 307 produces too, so a code-only assertion passes just as
    // happily with the origin pin deleted — a mutation sweep proved exactly
    // that. Only the pin produces this cause.
    expect(err?.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err?.details?.cause).toBe('cross_origin_redirect');
    // …and the redirect target was never contacted.
    expect(sent.every((s) => !s.url.includes('evil.example.com'))).toBe(true);
  });

  it('FOLLOWS a same-origin redirect — the half that proves the pin is a pin', async () => {
    // ⚠ **This is the assertion the cross-origin one cannot make.** Deleting
    // the pinned origin makes `next.origin !== undefined` always true, so every
    // redirect is refused and the cross-origin test still passes — a mutation
    // sweep showed both "remove the pin" mutants surviving against it. Only the
    // POSITIVE case distinguishes a pin from a blanket refusal, and a PDS that
    // 307s within its own origin is a real deployment.
    let hop = 0;
    const { ensure, sent } = gate((url) => {
      hop += 1;
      if (hop === 1 && url.includes('createSession')) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://bsky.social/xrpc/com.atproto.server.createSession/v2' },
        });
      }
      return tokens();
    });

    const next = await ensure(row(), session()) as Record<string, unknown>;

    expect(next.current_access_token).toBe('jwt-access');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.url).toBe('https://bsky.social/xrpc/com.atproto.server.createSession/v2');
  });

  it('⛔ never echoes the app password in an error', async () => {
    // A PDS that rejects a login commonly quotes what it was sent, and this
    // message is what surfaces to the owner and the audit.
    const { ensure } = gate(() => new Response(
      `bad credentials: ${APP_PASSWORD}`,
      { status: 401, statusText: 'Unauthorized' },
    ));
    let err: IngredientError | undefined;
    try { await ensure(row(), session()); } catch (e) { err = e as IngredientError; }

    expect(err?.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err!.message).not.toContain(APP_PASSWORD);
    expect(JSON.stringify(err!.details ?? {})).not.toContain(APP_PASSWORD);
  });

  it.each([
    ['no accessJwt at all', { refreshJwt: 'r' }],
    ['an empty accessJwt', { accessJwt: '', refreshJwt: 'r' }],
    ['a non-string accessJwt', { accessJwt: 42, refreshJwt: 'r' }],
  ])('⛔ refuses a 200 response with %s', async (_label, payload) => {
    // A 200 that carries no usable token would otherwise be folded onto the row
    // as a "successful" exchange, and every later dispatch would fail at
    // injectAuth with no clue where the bad state came from.
    const { ensure } = gate(() => ok(payload));
    let err: IngredientError | undefined;
    try { await ensure(row(), session()); } catch (e) { err = e as IngredientError; }

    expect(err?.code).toBe('TOKEN_REFRESH_FAILED');
    expect(err!.message).toContain('missing accessJwt');
  });

  it('keeps the app password on the row so a dead session can self-heal', async () => {
    // § 7.5c — and it is load-bearing for three separate failure modes.
    const { ensure, persisted } = gate(() => tokens());
    const next = await ensure(row(), session()) as Record<string, unknown>;

    expect(next.app_password).toBe(APP_PASSWORD);
    expect(next.identifier).toBe('alice.bsky.social');
    expect(persisted).toHaveLength(1);
  });
});

describe('D-218 — refreshSession: the header, and the single-use token', () => {
  it('🔑 sends the refresh token as a BEARER HEADER, not a body field', async () => {
    // Most of why `oauth2_refresh` could not express this type: its entire
    // shape is a form-encoded grant with the token in the payload.
    const { ensure, sent } = gate(() => tokens());
    await ensure(row(), session({ refresh_token: 'jwt-old-refresh' }));

    expect(sent[0]!.url).toBe('https://bsky.social/xrpc/com.atproto.server.refreshSession');
    expect(sent[0]!.headers.authorization).toBe('Bearer jwt-old-refresh');
    expect(String(sent[0]!.body ?? '')).not.toContain('jwt-old-refresh');
  });

  it('prefers refresh over login when a refresh token exists', async () => {
    const { ensure, sent } = gate(() => tokens());
    await ensure(row(), session({ refresh_token: 'jwt-old-refresh' }));
    expect(sent[0]!.url).toContain('refreshSession');
    expect(sent.some((s) => s.url.includes('createSession'))).toBe(false);
  });

  it('⛔ DROPS the stored refresh token when the response omits one', async () => {
    // ⚠ The opposite of `refreshOAuth2`, deliberately. There, keeping the old
    // token is right because rotation is optional and it still works. Here the
    // exchange ALREADY invalidated it, so keeping it would store a credential
    // guaranteed to fail. Absent means "log in again", which the retained app
    // password makes possible.
    const { ensure } = gate(() => ok({ accessJwt: 'jwt-access' }));
    const next = await ensure(row(), session({ refresh_token: 'jwt-old-refresh' })) as
      Record<string, unknown>;

    expect(next.current_access_token).toBe('jwt-access');
    expect(next.refresh_token).toBeUndefined();
    expect(next.app_password).toBe(APP_PASSWORD);
  });

  it('rotates to the NEW refresh token when one comes back', async () => {
    const { ensure } = gate(() => tokens());
    const next = await ensure(row(), session({ refresh_token: 'jwt-old-refresh' })) as
      Record<string, unknown>;
    expect(next.refresh_token).toBe('jwt-refresh');
  });
});

describe('D-218 slice 3 — a dead refresh token logs in again', () => {
  it('⛔ falls back to createSession when the server REJECTS the refresh', async () => {
    // § 7.5c earning its keep. A refresh token dies for ordinary reasons — it
    // aged out, the session was revoked, a previous rotation failed to persist.
    // Every one of those becomes one extra request instead of a dead connection.
    const { ensure, sent } = gate((url) =>
      url.includes('refreshSession')
        ? new Response('expired', { status: 400 })
        : tokens());

    const next = await ensure(row(), session({ refresh_token: 'jwt-dead' })) as
      Record<string, unknown>;

    expect(sent.map((s) => s.url.split('.').pop())).toEqual([
      'refreshSession', 'createSession',
    ]);
    expect(next.current_access_token).toBe('jwt-access');
  });

  it('⛔⛔ NEVER logs in after a cross-origin redirect refusal', async () => {
    // Our own guard just refused to hand this endpoint a REFRESH token.
    // Handing it the ACCOUNT CREDENTIAL instead is the worst possible response
    // to that signal, and it is exactly what a blanket "refresh failed → log
    // in" rule would do.
    const { ensure, sent } = gate((url) =>
      url.includes('refreshSession')
        ? new Response(null, { status: 307, headers: { location: 'https://evil.example.com/x' } })
        : tokens());

    await expect(ensure(row(), session({ refresh_token: 'jwt-r' }))).rejects.toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
    });
    expect(sent.some((s) => s.url.includes('createSession'))).toBe(false);
    expect(sent.every((s) => !s.url.includes('evil.example.com'))).toBe(true);
  });

  it('does NOT log in after a network failure — it would fail the same way', async () => {
    // The request never landed, so the token is not the problem. A login buys
    // nothing and transmits the app password for nothing.
    let calls = 0;
    const { ensure } = gate(() => { calls += 1; throw new Error('ECONNREFUSED'); });
    await expect(ensure(row(), session({ refresh_token: 'jwt-r' }))).rejects.toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
    });
    expect(calls).toBe(1);
  });

  it('does NOT log in when the refresh returned a malformed 200', async () => {
    // A response arrived and it was broken. A login would break the same way.
    const { ensure, sent } = gate((url) =>
      url.includes('refreshSession') ? ok({ nothing: true }) : tokens());
    await expect(ensure(row(), session({ refresh_token: 'jwt-r' }))).rejects.toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
    });
    expect(sent.some((s) => s.url.includes('createSession'))).toBe(false);
  });

  it('⛔ tries the login exactly ONCE — a failed login is the answer', async () => {
    const { ensure, sent } = gate(() => new Response('no', { status: 400 }));
    await expect(ensure(row(), session({ refresh_token: 'jwt-r' }))).rejects.toMatchObject({
      code: 'TOKEN_REFRESH_FAILED',
    });
    expect(sent).toHaveLength(2);
    // …and the error the caller sees is the LOGIN's, the more actionable of the
    // two: "your app password no longer works".
    expect(sent[1]!.url).toContain('createSession');
  });
});

describe('D-218 slice 3 — a swallowed write is AUDIBLE', () => {
  it('reports a persist failure without failing the call', async () => {
    // § 7.5d — non-fatal, because the token was already rotated one step
    // earlier and failing would destroy a successful call. But not silent: the
    // durable row now holds a dead token and the next call pays for it.
    const seen: Array<{ name: string; message: string }> = [];
    const { ensure } = gate(() => tokens(), {
      persistAuth: async () => { throw new Error('disk full'); },
      onPersistFailure: (r, e) => {
        seen.push({ name: r.name, message: (e as Error).message });
      },
    });

    const next = await ensure(row(), session({ refresh_token: 'jwt-r' })) as
      Record<string, unknown>;

    expect(next.current_access_token).toBe('jwt-access');
    expect(seen).toEqual([{ name: 'bluesky', message: 'disk full' }]);
  });

  it('⛔ the row a real boot would emit carries NO credential', async () => {
    // ⚠ The sink runs at the moment a credential write failed, so it is holding
    // the auth object when it fires. The wired implementation logs the auth
    // KIND and the error text — never the app password or either token — and
    // this pins the shape the boot site is allowed to see.
    const seen: Array<{ row: ConnectionRow; error: unknown }> = [];
    const { ensure } = gate(() => tokens(), {
      persistAuth: async () => { throw new Error('SQLITE_FULL: database or disk is full'); },
      onPersistFailure: (r, e) => { seen.push({ row: r, error: e }); },
    });
    await ensure(row(), session({ refresh_token: 'jwt-r' }));

    expect(seen).toHaveLength(1);
    // What the boot site actually serializes: name, kind, message.
    const serialized = JSON.stringify({
      kind: seen[0]!.row.kind,
      error: (seen[0]!.error as Error).message,
      target: seen[0]!.row.name,
    });
    expect(serialized).not.toContain(APP_PASSWORD);
    expect(serialized).not.toContain('jwt-r');
    expect(serialized).not.toContain('jwt-access');
    expect(serialized).toContain('SQLITE_FULL');
  });

  it('stays quiet when the write succeeds', async () => {
    const seen: unknown[] = [];
    const { ensure } = gate(() => tokens(), { onPersistFailure: () => seen.push(1) });
    await ensure(row(), session({ refresh_token: 'jwt-r' }));
    expect(seen).toEqual([]);
  });

  it('a throwing sink never breaks the dispatch', async () => {
    // An advisory signal that can fail the call would be worse than the problem
    // it reports.
    const { ensure } = gate(() => tokens(), {
      persistAuth: async () => { throw new Error('disk full'); },
      onPersistFailure: () => { throw new Error('audit sink down'); },
    });
    const next = await ensure(row(), session({ refresh_token: 'jwt-r' })) as
      Record<string, unknown>;
    expect(next.current_access_token).toBe('jwt-access');
  });
});

describe('D-218 — the gate: one exchange, no clock', () => {
  it('⛔ collapses N concurrent dispatches into ONE exchange', async () => {
    // atproto\'s own docs say clients "may need locking primitives" — because a
    // second concurrent refresh sends a token the first one already killed.
    const { ensure, sent } = gate(() => tokens());
    const auth = session({ refresh_token: 'jwt-old-refresh' });
    await Promise.all([
      ensure(row(), auth), ensure(row(), auth), ensure(row(), auth),
    ]);
    expect(sent).toHaveLength(1);
  });

  it('⛔ does NOT exchange on a clock — a present token is treated as fresh', async () => {
    // § 7.5a — the protocol supplies no expiry and calls its tokens opaque, so
    // there is no honest number to schedule against. An expired token earns a
    // 401 and slice 2 reacts to it.
    const { ensure, sent } = gate(() => tokens());
    const next = await ensure(row(), session({ current_access_token: 'jwt-live' }));

    expect(sent).toHaveLength(0);
    expect((next as Record<string, unknown>).current_access_token).toBe('jwt-live');
  });

  it('leaves every other auth type completely alone', async () => {
    const { ensure, sent } = gate(() => tokens());
    const bearer: ConnectionAuth = { type: 'bearer', token: 't' };
    expect(await ensure(row(), bearer)).toBe(bearer);
    expect(sent).toHaveLength(0);
  });

  it('a persist failure does NOT fail the call — the token is already rotated', async () => {
    // § 7.5d — the invalidation happened inside the exchange, one step before
    // the write. Failing here would destroy a successful call and recover
    // nothing.
    const { ensure } = gate(() => tokens(), {
      persistAuth: async () => { throw new Error('disk full'); },
    });
    const next = await ensure(row(), session({ refresh_token: 'jwt-old-refresh' })) as
      Record<string, unknown>;
    expect(next.current_access_token).toBe('jwt-access');
  });
});
