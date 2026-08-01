/** D-218 slice 2 — the reactive 401 retry.
 *
 *  ⛔ **This is the only retry on the `connection.api` dispatch path, and the
 *  tests are mostly about what it REFUSES to retry.** The justification is a
 *  property of the status code, not a hope about the target: a 401 was rejected
 *  at auth, before the handler, so re-sending cannot double-apply a write.
 *  Nothing else on this path has that property, so every boundary below is the
 *  carve-out staying a carve-out.
 *
 *  Spec: D-218 § 7.5a.
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createConnectionApiHandler,
  type ConnectionApiHandlerDeps,
} from '../connection-api.js';
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
  current_access_token: 'jwt-stale',
  refresh_token: 'jwt-refresh',
  ...over,
} as ConnectionAuth);

interface Sent { url: string; method: string; auth: string | undefined }

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' },
  });

/** Drives the REAL handler. `opStatuses` is the sequence the op endpoint
 *  returns, one per attempt — so a test says "401 then 200" and the retry is
 *  observable as a second entry in `sent`. */
const mk = (opts: {
  auth?: ConnectionAuth;
  opStatuses?: number[];
  /** The accessJwt each session exchange hands back, in order. */
  minted?: string[];
  sessionStatus?: number;
  riskTier?: string;
} = {}) => {
  const sent: Sent[] = [];
  let op = 0;
  let mint = 0;
  const minted = opts.minted ?? ['jwt-fresh'];
  const statuses = opts.opStatuses ?? [401, 200];
  const fetchImpl = (async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    const headers = new Headers(init?.headers);
    sent.push({
      url, method: String(init?.method), auth: headers.get('authorization') ?? undefined,
    });
    if (url.includes('com.atproto.server.')) {
      if (opts.sessionStatus !== undefined && opts.sessionStatus !== 200) {
        return new Response('nope', { status: opts.sessionStatus });
      }
      const accessJwt = minted[Math.min(mint, minted.length - 1)]!;
      mint += 1;
      return json({ accessJwt, refreshJwt: 'jwt-refresh-2' });
    }
    const status = statuses[Math.min(op, statuses.length - 1)]!;
    op += 1;
    return json({ ok: status === 200 }, status);
  }) as unknown as typeof fetch;

  const deps: ConnectionApiHandlerDeps = {
    decodeAuth: async () => opts.auth ?? session(),
    persistAuth: async () => {},
    fetchImpl,
  };
  const run = (): Promise<unknown> => createConnectionApiHandler(deps)(
    row,
    { method: 'POST', path: '/xrpc/com.atproto.repo.createRecord', 'body.text': 'hi' },
    {
      slug: 'bluesky.post', output: {}, input: {},
      risk_tier: opts.riskTier ?? 'write',
    } as never,
  );
  return { run, sent, ops: (): Sent[] => sent.filter((s) => !s.url.includes('com.atproto.server.')) };
};

describe('D-218 — a 401 re-authenticates and retries ONCE', () => {
  it('exchanges, re-injects the fresh token, and re-sends', async () => {
    const { run, sent, ops } = mk();
    await run();

    // op(401) → refreshSession → op(200)
    expect(sent.map((s) => s.url.split('/').pop())).toEqual([
      'com.atproto.repo.createRecord',
      'com.atproto.server.refreshSession',
      'com.atproto.repo.createRecord',
    ]);
    expect(ops()[0]!.auth).toBe('Bearer jwt-stale');
    expect(ops()[1]!.auth).toBe('Bearer jwt-fresh');
  });

  it('⛔ retries a WRITE — which is the whole point of the ruling', async () => {
    // A 401 was refused at auth, before the handler, so re-sending cannot
    // double-apply. If this ever stops retrying writes the carve-out has been
    // quietly narrowed into uselessness: every op this type serves is a write.
    const { run, ops } = mk({ riskTier: 'write' });
    await run();
    expect(ops()).toHaveLength(2);
  });

  it('⛔ retries exactly ONCE — a second 401 is the answer', async () => {
    const { run, ops } = mk({ opStatuses: [401, 401], minted: ['a', 'b', 'c'] });
    await expect(run()).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    expect(ops()).toHaveLength(2);
  });
});

describe('D-218 — what it refuses to retry', () => {
  it('⛔ does NOT retry a 403 — authenticated but forbidden', async () => {
    // ⚠ `classifyHttpError` buckets 401 and 403 into one `OAUTH_EXPIRED` throw,
    // so a retry keyed on the ERROR CODE would fire here. Refreshing changes
    // nothing for a 403 and re-sending is pure amplification.
    const { run, sent, ops } = mk({ opStatuses: [403, 200] });
    await expect(run()).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    expect(ops()).toHaveLength(1);
    expect(sent.some((s) => s.url.includes('com.atproto.server.'))).toBe(false);
  });

  it.each([[500], [502], [429], [404]])('does NOT retry a %i', async (status) => {
    // Only 401 carries the clean-rejection property. A 5xx especially may have
    // committed before the ack was lost — that is what ACTION_DELIVERY_UNCERTAIN
    // is for, and retrying it would be the double-apply this codebase refuses.
    const { run, ops } = mk({ opStatuses: [status, 200] });
    await expect(run()).rejects.toBeInstanceOf(IngredientError);
    expect(ops()).toHaveLength(1);
  });

  it('⛔ does NOT retry for a non-exchangeable auth type', async () => {
    // A bearer row has nothing to exchange; retrying would re-send the same
    // token and burn a request to learn what the first one already said.
    const { run, sent } = mk({
      auth: { type: 'bearer', token: 'static' },
      opStatuses: [401, 200],
    });
    await expect(run()).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    expect(sent).toHaveLength(1);
  });

  it('⛔⛔ does NOT retry an oauth2_refresh row — the carve-out is SCOPED', async () => {
    // ⚠ **The bearer test above cannot prove this.** A bearer row has nothing
    // to exchange, so the retry guard looks redundant against it — a mutation
    // deleting the auth-type check SURVIVED until this test existed. An
    // `oauth2_refresh` row is the one that WOULD retry if the guard went: clear
    // its cached token and the shared gate happily mints a new one.
    //
    // ⛔ It must not. § 7.5a's carve-out rests on a 401 being a clean
    // rejection, but the RULING is scoped to this auth type; OAuth2 has a
    // working expiry gate, and widening a shipped dispatch path to retry writes
    // is a decision, not a side effect.
    const sent: string[] = [];
    const fetchImpl = (async (u: unknown) => {
      const url = String(u);
      sent.push(url);
      if (url.includes('/token')) {
        return json({ access_token: 'oauth-fresh', expires_in: 3600 });
      }
      return json({ ok: false }, 401);
    }) as unknown as typeof fetch;

    const oauth: ConnectionAuth = {
      type: 'oauth2_refresh',
      refresh_token: 'r',
      client_id: 'c',
      token_endpoint: 'https://bsky.social/token',
      current_access_token: 'oauth-stale',
      expires_at: Date.now() + 3_600_000,
    };

    await expect(createConnectionApiHandler({
      decodeAuth: async () => oauth,
      persistAuth: async () => {},
      fetchImpl,
    })(row, { method: 'POST', path: '/xrpc/x', 'body.a': '1' },
      { slug: 'x', output: {}, input: {}, risk_tier: 'write' } as never),
    ).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });

    // ONE op call, and no token exchange provoked by the 401.
    expect(sent).toEqual(['https://bsky.social/xrpc/x']);
  });

  it('⛔ does NOT retry when the exchange returns the SAME token', async () => {
    // The second call would be byte-identical to the one that just failed.
    const { run, ops, sent } = mk({ minted: ['jwt-stale'] });
    await expect(run()).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
    expect(ops()).toHaveLength(1);
    // …but the exchange itself was attempted — that is how we learned.
    expect(sent.some((s) => s.url.includes('refreshSession'))).toBe(true);
  });
});

describe('D-218 — when re-authentication itself fails', () => {
  it('surfaces the EXCHANGE failure, not the original 401', async () => {
    // "Your app password no longer works" is actionable; a bare 401 on the op
    // is not. The exchange error is the more specific claim, so it wins.
    const { run } = mk({ sessionStatus: 400 });
    await expect(run()).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });

  it('never puts the app password in that error', async () => {
    const { run } = mk({ sessionStatus: 401 });
    let err: IngredientError | undefined;
    try { await run(); } catch (e) { err = e as IngredientError; }
    expect(err!.message).not.toContain('abcd-efgh-ijkl-mnop');
  });
});
