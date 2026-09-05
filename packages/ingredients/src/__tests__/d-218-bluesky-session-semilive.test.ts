/** D-218 — the atproto session lifecycle against a REAL SOCKET and a PDS that REFUSES.
 *
 *  ⚠ **THE GAP HERE IS NARROWER THAN IT LOOKS, SO STATE IT EXACTLY.** Unlike
 *  D-217 — where the shipped declaration had never been executed at all — every
 *  property below is ALREADY asserted somewhere. `d-218-atproto-exchange` pins
 *  that `refreshSession` carries `Bearer <refreshJwt>`; `d-218-401-retry` pins
 *  that a 401 re-exchanges once. Neither is missing and neither is wrong.
 *
 *  ⛔⛔ **WHAT IS MISSING IS THE JOIN, AND THE COUNTERPARTY.** Both suites
 *  supply their own fake `fetch`, and the 401 suite's routes on
 *  `url.includes('com.atproto.server.')` — one branch answering BOTH session
 *  procedures, checking no token. So every existing assertion is observational
 *  ("this is what we sent"); none is transactional ("a server that requires the
 *  right thing accepted it"). A fake that answers 200 to `refreshSession`
 *  whichever JWT arrives cannot fail when the wrong one does, and the two
 *  suites stub the same boundary from opposite sides — the classic shape where
 *  everything is green and the join never ran.
 *
 *  🔑 **SO THE PDS HERE IS AN ENFORCER.** `createSession` refuses a request
 *  carrying auth; `createRecord` refuses anything but the CURRENT accessJwt;
 *  and `refreshSession` refuses the accessJwt — it accepts only the live
 *  refreshJwt, and burns it on use, because atproto's is single-use. Handing it
 *  the wrong token is a 401 rather than a shrug, which is what makes the run
 *  evidence instead of a recording.
 *
 *  ⚠ **SEMI-LIVE IS NOT LIVE.** Real HTTP against a server that behaves the way
 *  atproto's docs say a PDS does. It cannot prove Bluesky agrees, and it runs
 *  under vitest rather than the packaged binary, so it says nothing about what
 *  survives single-executable bundling. Authenticating against a real account
 *  remains the open item; no credentials exist in this repo.
 */

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createConnectionApiHandler, type ConnectionApiHandlerDeps } from '../connection-api.js';

const IDENTIFIER = 'alice.bsky.social';
const APP_PASSWORD = 'abcd-efgh-ijkl-mnop';

interface Seen { method: string; path: string; auth?: string }

let server: Server;
let baseUrl = '';
let seen: Seen[];
/** Refusals the PDS issued. Asserted EMPTY — the point of an enforcing
 *  counterparty is lost if nobody reads what it refused. */
let refusals: string[];
/** The live token pair. `refreshSession` BURNS the refresh it consumes, so a
 *  second use of the same one is a 401 exactly as atproto specifies. */
let accessJwt: string;
let refreshJwt: string;
let liveRefresh: string | undefined;
let minted: number;
/** Attempts against the op endpoint, so the retry is visible as a second one. */
let opAttempts: number;
/** When set, the op endpoint refuses EVERY bearer — the only way to reach the
 *  second 401, since a client that can log in will otherwise recover. */
let opAlways401: boolean;
/** Bodies the PDS received on createSession, to pin that the app password goes
 *  in the JSON body and only there. */
let createSessionBody = '';

const readBody = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://pds');
      const path = url.pathname;
      const auth = req.headers.authorization ?? undefined;
      const body = await readBody(req);
      seen.push({ method: req.method ?? '?', path, auth });

      const json = (code: number, payload: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const refuse = (why: string, code = 401): void => {
        refusals.push(`${req.method} ${path} — ${why}`);
        json(code, { error: 'AuthenticationRequired', message: why });
      };

      // ── createSession: the app password, in the BODY, with no bearer ──────
      if (path === '/xrpc/com.atproto.server.createSession') {
        createSessionBody = body;
        if (auth !== undefined) return refuse('createSession must not carry Authorization');
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        if (parsed.identifier !== IDENTIFIER) return refuse('unknown identifier');
        if (parsed.password !== APP_PASSWORD) return refuse('bad app password');
        minted += 1;
        accessJwt = `access-${minted}`;
        refreshJwt = `refresh-${minted}`;
        liveRefresh = refreshJwt;
        return json(200, { accessJwt, refreshJwt, handle: IDENTIFIER, did: 'did:plc:alice' });
      }

      // ── refreshSession: the REFRESH jwt as a bearer, and it is single-use ──
      // ⛔ THE DISCRIMINATOR. Handing this the accessJwt is the mistake
      // `oauth2_refresh` would have made, and here it is a 401, not a shrug.
      if (path === '/xrpc/com.atproto.server.refreshSession') {
        if (auth === `Bearer ${accessJwt}`) {
          return refuse('refreshSession was given the ACCESS jwt, not the refresh jwt');
        }
        if (liveRefresh === undefined || auth !== `Bearer ${liveRefresh}`) {
          return refuse('refreshSession requires the live refresh jwt as a bearer');
        }
        if (body !== '') return refuse('refreshSession takes no body');
        liveRefresh = undefined; // burned
        minted += 1;
        accessJwt = `access-${minted}`;
        refreshJwt = `refresh-${minted}`;
        liveRefresh = refreshJwt;
        return json(200, { accessJwt, refreshJwt, handle: IDENTIFIER, did: 'did:plc:alice' });
      }

      // ── the op: only the CURRENT accessJwt is good enough ─────────────────
      if (path === '/xrpc/com.atproto.repo.createRecord') {
        opAttempts += 1;
        if (opAlways401) return refuse('op refuses every bearer (forced)');
        if (auth !== `Bearer ${accessJwt}`) {
          return refuse(`createRecord got a stale or wrong bearer (${auth ?? 'none'})`);
        }
        return json(200, { uri: 'at://did:plc:alice/app.bsky.feed.post/abc', cid: 'bafy' });
      }

      refuse('no such endpoint', 404);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  refusals = [];
  minted = 0;
  opAttempts = 0;
  opAlways401 = false;
  accessJwt = 'access-none';
  refreshJwt = 'refresh-none';
  liveRefresh = undefined;
  createSessionBody = '';
});

/** Put the PDS into the state a client MID-SESSION believes in: a live access
 *  token it does not hold, and a live refresh token it does. Without this the
 *  refresh leg is unreachable — a client with no refresh token logs in instead,
 *  which is correct behaviour and a different test. */
const seed = (access: string, refresh: string): void => {
  minted = 1;
  accessJwt = access;
  refreshJwt = refresh;
  liveRefresh = refresh;
};

const row = (): ConnectionRow => ({
  pk: 'api:bluesky',
  kind: 'api',
  name: 'bluesky',
  display_name: 'Bluesky',
  config_json: JSON.stringify({ base_url: baseUrl }),
  auth_ciphertext: 'opaque',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
});

const session = (over: Record<string, unknown> = {}): ConnectionAuth => ({
  type: 'atproto_session',
  identifier: IDENTIFIER,
  app_password: APP_PASSWORD,
  ...over,
} as ConnectionAuth);

/** ⛔ `fetchImpl` IS DELIBERATELY ABSENT — the omission is what makes it a real
 *  socket, and that is the whole reason this file exists beside the others. */
const drive = async (auth: ConnectionAuth): Promise<{
  out: unknown;
  persisted: ConnectionAuth[];
}> => {
  const persisted: ConnectionAuth[] = [];
  let live = auth;
  const deps = {
    decodeAuth: async () => live,
    persistAuth: async (_r: ConnectionRow, next: ConnectionAuth) => {
      persisted.push(next);
      live = next;
    },
  } as unknown as ConnectionApiHandlerDeps;

  const out = await createConnectionApiHandler(deps)(
    row(),
    {
      method: 'POST',
      path: '/xrpc/com.atproto.repo.createRecord',
      'body.repo': IDENTIFIER,
      'body.collection': 'app.bsky.feed.post',
    },
    { slug: 'bluesky.post.create', output: {}, input: {}, risk_tier: 'write' } as never,
    undefined,
  );
  return { out, persisted };
};

const tokenOf = (a: ConnectionAuth): string | undefined =>
  (a as unknown as { current_access_token?: string }).current_access_token;
const refreshOf = (a: ConnectionAuth): string | undefined =>
  (a as unknown as { refresh_token?: string }).refresh_token;

describe('D-218 — the atproto session lifecycle, over a real socket, against a PDS that refuses', () => {
  it('logs in with the app password and posts, all on one real connection', async () => {
    const { out, persisted } = await drive(session());

    expect(refusals, 'the PDS refused something the client sent').toEqual([]);
    expect(seen.map((s) => s.path)).toEqual([
      '/xrpc/com.atproto.server.createSession',
      '/xrpc/com.atproto.repo.createRecord',
    ]);

    // The app password went in the BODY and never in a header — the shape
    // `basic` could not express.
    expect(JSON.parse(createSessionBody)).toMatchObject({
      identifier: IDENTIFIER, password: APP_PASSWORD,
    });
    expect(seen[0]!.auth, 'createSession must carry no bearer').toBeUndefined();
    expect(seen[1]!.auth).toBe('Bearer access-1');

    expect(persisted.map(tokenOf)).toEqual(['access-1']);
    expect((out as { result: { uri: string } }).result.uri).toContain('app.bsky.feed.post');
  });

  it('🔑 a mid-life 401 refreshes with the REFRESH jwt — and the PDS is what enforces which', async () => {
    // The PDS holds a live pair; the client holds the refresh but a DEAD access
    // token. That is the expiry case, reached without a clock.
    seed('access-server-side', 'refresh-seeded');
    const { out, persisted } = await drive(session({
      current_access_token: 'access-expired',
      refresh_token: 'refresh-seeded',
    }));

    expect(seen.map((s) => s.path)).toEqual([
      '/xrpc/com.atproto.repo.createRecord',        // 401 — the token is dead
      '/xrpc/com.atproto.server.refreshSession',    // exchange
      '/xrpc/com.atproto.repo.createRecord',        // retry, once
    ]);

    // ⛔ THE ASSERTION THE FAKES CANNOT MAKE: the refresh leg presented the
    // REFRESH jwt. A fake answering 200 either way is blind here; this PDS
    // 401s the accessJwt by name.
    expect(seen[1]!.auth).toBe('Bearer refresh-seeded');
    expect(refusals.filter((r) => r.includes('refreshSession'))).toEqual([]);

    // Only the dead token was refused; the exchange and retry were accepted.
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('createRecord got a stale or wrong bearer');

    // The retry carried the NEW access token, and the new pair was persisted —
    // atproto burns the refresh it consumed, so losing this is losing the
    // session.
    expect(seen[2]!.auth).toBe('Bearer access-2');
    expect(persisted.map(tokenOf)).toEqual(['access-2']);
    expect(persisted.map(refreshOf)).toEqual(['refresh-2']);
    expect(opAttempts).toBe(2);
    expect((out as { result: { uri: string } }).result.uri).toContain('app.bsky.feed.post');
  });

  it('⛔ the retry is ONCE — a second 401 is the answer, not a ladder', async () => {
    // The op refuses every bearer, so a client that keeps re-exchanging would
    // loop forever. The exchange itself still succeeds, which is what makes
    // this a test of the RETRY bound rather than of a broken login.
    seed('access-server-side', 'refresh-seeded');
    opAlways401 = true;

    await expect(drive(session({
      current_access_token: 'access-expired',
      refresh_token: 'refresh-seeded',
    }))).rejects.toThrow();

    expect(opAttempts, 'the op must be attempted exactly twice — no ladder').toBe(2);
    expect(seen.filter((s) => s.path.endsWith('refreshSession'))).toHaveLength(1);
  });
});
