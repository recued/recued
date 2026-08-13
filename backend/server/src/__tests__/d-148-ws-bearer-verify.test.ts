/** D-148 § A.2.1 — WS-handshake bearer-validation tightening tests.
 *
 *  Covers the slice-127 surface that flips WS auth from "any Bearer
 *  string passes" to "structured `<token_id>.<bearer>` shape is
 *  verified against `client_tokens` BEFORE socket acceptance, and
 *  raw/opaque bearers are rejected when that store is wired":
 *
 *    - `parseStructuredBearer` (exported substrate): canonical happy
 *      path, edge cases around the `.` separator (none, leading,
 *      trailing, multiple), and the empty-bearer reject.
 *    - End-to-end WS upgrade: legacy raw bearer rejected, structured
 *      bearer verified + accepted on match, structured bearer rejected
 *      on mismatch / unknown token_id / malformed shape, missing
 *      `clientTokens` dep keeps db-less legacy compositions working.
 *    - `WsClient.client_token_id` populated on verify success +
 *      undefined on legacy raw-bearer path.
 *    - `revokeConnectedInstance` returns the populated
 *      `client_token_id` for verified sockets so the
 *      `pair_revoke.detail.client_token_id` join column lands on every
 *      online-device revoke (closes the slice-126 forward-compat
 *      scaffold).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { WS_VERSION_SUBPROTOCOL, encodeBearerSubprotocol } from '@recued/contracts';
import Database from 'better-sqlite3';

import { startServer, type RunningServer } from '../server.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import {
  parseStructuredBearer,
  STRUCTURED_BEARER_LEN,
  STRUCTURED_BEARER_TOKEN_ID_LEN,
} from '../ws-server.js';
import type { RecipeDefinition } from '@recued/contracts';

const canonicalTokenId = (filler = 'A'): string =>
  filler.repeat(STRUCTURED_BEARER_TOKEN_ID_LEN);
const canonicalBearer = (filler = 'B'): string =>
  filler.repeat(STRUCTURED_BEARER_LEN);

// Fast Argon2id params for tests — same shape as `d-148-phase-2-client-
// tokens.test.ts`. Production parameters take ~250ms per verify on the
// test runner; the FAST_ARGON2 shape keeps the suite under a second.
const FAST_ARGON2 = { t: 1, m: 8, p: 1 };

const RECIPE: RecipeDefinition = {
  recipe_id: 'ws-bearer-verify-test',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'WS Bearer Verify Test',
    description: 't',
    author: 't',
    supported_platforms: ['t'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'x', transform: 'template', template: 'ok' }],
  output: { sidebar: [{ type: 'text', source: 'step.x' }] },
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const tryConnect = (
  port: number,
  token: string,
): Promise<{ ws: WebSocket; opened: boolean }> =>
  new Promise((resolve) => {
    // URL-encode the token — browser WebSocket clients can't set
    // Authorization headers, so they pass the bearer via `?token=`. The
    // server-side `extractRealm` uses `URLSearchParams` which decodes
    // `+` → space + `%XX` → bytes, so the caller MUST encode any base64
    // bearer (which contains `+`/`/`/`=`) before sending. Production
    // webclient bootstrap follows the same convention.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
    );
    let settled = false;
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: true });
    });
    ws.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: false });
    });
    ws.on('unexpected-response', () => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened: false });
    });
  });

/** Connect the way BROWSERS now do: the bearer in `Sec-WebSocket-Protocol`,
 *  nothing secret on the URL. `recued.v1` is offered first deliberately — see
 *  the ordering note in `ws-subprotocol.ts`. */
const tryConnectViaSubprotocol = (
  port: number,
  token: string,
): Promise<{ ws: WebSocket; opened: boolean; acceptedProtocol: string }> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [
      WS_VERSION_SUBPROTOCOL,
      encodeBearerSubprotocol(token),
    ]);
    let settled = false;
    const done = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ ws, opened, acceptedProtocol: ws.protocol ?? '' });
    };
    ws.on('open', () => done(true));
    ws.on('error', () => done(false));
    ws.on('unexpected-response', () => done(false));
  });

// ════════════════════════════════════════════════════════════════
// parseStructuredBearer — pure substrate
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.2.1 — parseStructuredBearer', () => {
  it('canonical happy path: 16-char token_id . 44-char bearer parses cleanly', () => {
    const tid = canonicalTokenId('A');
    const bearer = canonicalBearer('B');
    expect(parseStructuredBearer(`${tid}.${bearer}`)).toEqual({
      token_id: tid,
      bearer,
    });
  });

  it('no `.` → returns null (legacy raw-bearer path)', () => {
    expect(parseStructuredBearer('opaquebearerfromextension')).toBeNull();
    // Even a canonically-sized base64 raw bearer (the shape
    // `pair.consume` issues) resolves to null without the prefix —
    // the structured form is explicitly `<token_id>.<bearer>`, not the
    // bearer alone.
    expect(parseStructuredBearer(canonicalBearer('Y'))).toBeNull();
  });

  it('leading `.` → returns null (empty token_id pre-separator)', () => {
    expect(parseStructuredBearer(`.${canonicalBearer('B')}`)).toBeNull();
  });

  it('trailing `.` → returns null (empty bearer post-separator)', () => {
    expect(parseStructuredBearer(`${canonicalTokenId('A')}.`)).toBeNull();
  });

  it('token_id off canonical length → returns null (DoS pre-check; never reaches Argon2id)', () => {
    // Codex 2026-05-17 P1 #2 fold — the WS upgrade's pre-check rejects
    // anything that does NOT match the canonical issuance shape so an
    // attacker probing `/ws?token=a.b` is rejected synchronously
    // instead of triggering an Argon2id verify per request.
    const shortId = canonicalTokenId('A').slice(0, 8);
    const longId = canonicalTokenId('A') + 'extra';
    expect(parseStructuredBearer(`${shortId}.${canonicalBearer('B')}`)).toBeNull();
    expect(parseStructuredBearer(`${longId}.${canonicalBearer('B')}`)).toBeNull();
    // Garbage probe attempts also short-circuit (the canonical
    // attacker case).
    expect(parseStructuredBearer('a.b')).toBeNull();
  });

  it('bearer off canonical length → returns null (DoS pre-check)', () => {
    const shortBearer = canonicalBearer('B').slice(0, 16);
    const longBearer = canonicalBearer('B') + 'extra';
    expect(parseStructuredBearer(`${canonicalTokenId('A')}.${shortBearer}`)).toBeNull();
    expect(parseStructuredBearer(`${canonicalTokenId('A')}.${longBearer}`)).toBeNull();
  });

  it('multiple `.` → splits on FIRST separator (forward-compat for richer formats)', () => {
    // Token_id never contains `.` (16 chars of standard base64 from
    // `generateTokenId` — alphabet is A-Z/a-z/0-9/+/=). A future bearer
    // half that embeds `.`-delimited subfields would expand the bearer
    // side, NOT the id side, so first-`.` is the right pivot. Total
    // bearer length still pinned to STRUCTURED_BEARER_LEN to keep the
    // DoS pre-check in force.
    const tid = canonicalTokenId('A');
    // 44-char bearer with embedded dots.
    const bearer = 'b'.repeat(20) + '.' + 'b'.repeat(23);
    expect(bearer.length).toBe(STRUCTURED_BEARER_LEN);
    expect(parseStructuredBearer(`${tid}.${bearer}`)).toEqual({
      token_id: tid,
      bearer,
    });
  });

  it('empty string → returns null', () => {
    expect(parseStructuredBearer('')).toBeNull();
  });

  it('exported length constants match the substrate', () => {
    expect(STRUCTURED_BEARER_TOKEN_ID_LEN).toBe(16);
    expect(STRUCTURED_BEARER_LEN).toBe(44);
  });
});

// ════════════════════════════════════════════════════════════════
// End-to-end WS upgrade — structured bearer only
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.2.1 — WS upgrade with clientTokens.verify wired', () => {
  let server: RunningServer | undefined;
  let db: Database.Database;
  let issuedTokenId: string;
  let issuedBearer: string;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);

    db = new Database(':memory:');
    const clientTokens = createClientTokenStore(db, { argon2_params: FAST_ARGON2 });
    const issued = await clientTokens.issue({
      client_kind: 'webclient',
      client_label: 'Test webclient',
    });
    issuedTokenId = issued.token_id;
    issuedBearer = issued.bearer;

    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
      },
      clientTokens,
    });
    server!.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server?.close();
    db.close();
  });

  it('legacy raw-bearer connection is rejected when clientTokens is wired', async () => {
    const { opened } = await tryConnect(server!.port, 'legacy-opaque-bearer');
    expect(opened).toBe(false);
  });

  it('structured bearer with a matching client_tokens row → upgrade accepted + client_token_id populated', async () => {
    const { ws, opened } = await tryConnect(
      server!.port,
      `${issuedTokenId}.${issuedBearer}`,
    );
    expect(opened).toBe(true);
    // The verified token_id lands on the WsClient. The
    // `listConnectedInstances` accessor only surfaces registered
    // clients, but we can spot the population via the wsServer's
    // private-but-stable revoke handle below (NEXT test).
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await wait(20);
  });

  it('structured bearer with a canonical-length but wrong bearer (matching token_id) → upgrade rejected', async () => {
    const wrongBearer = canonicalBearer('Z'); // canonical length, wrong content
    const { opened } = await tryConnect(
      server!.port,
      `${issuedTokenId}.${wrongBearer}`,
    );
    expect(opened).toBe(false);
  });

  it('structured bearer with an unknown canonical-length token_id → upgrade rejected (constant-time dummy verify path)', async () => {
    const unknownId = canonicalTokenId('U'); // canonical length, never issued
    const { opened } = await tryConnect(
      server!.port,
      `${unknownId}.${issuedBearer}`,
    );
    expect(opened).toBe(false);
  });

  it('off-canonical-length structured shape is rejected without Argon2id verify', async () => {
    const { opened } = await tryConnect(server!.port, 'a.b');
    expect(opened).toBe(false);
  });

  it('revokeConnectedInstance returns the verified client_token_id so handlePairRevoke can stamp the audit join column', async () => {
    // End-to-end thread: structured-bearer upgrade verifies →
    // ws-server populates WsClient.client_token_id → register →
    // revokeConnectedInstance snapshots it BEFORE socket teardown →
    // returns it so `handlePairRevoke` can stamp
    // `detail.client_token_id` on the `pair_revoke` audit row. This
    // test pins the end-to-end auto-population without any pair-
    // revoke-rpc plumbing on top.
    const { ws, opened } = await tryConnect(
      server!.port,
      `${issuedTokenId}.${issuedBearer}`,
    );
    expect(opened).toBe(true);
    // Register so revokeConnectedInstance can target the instance_id.
    ws.send(JSON.stringify({
      type: 'register',
      instance_id: 'ext-bearer-verified',
      display_name: 'Verified webclient',
    }));
    await wait(50);
    const result = server!.wsServer.revokeConnectedInstance('ext-bearer-verified');
    expect(result.revoked).toBe(true);
    expect(result.client_token_id).toBe(issuedTokenId);
    await wait(20);
  });

  // ── The bearer's carrier ──────────────────────────────────────────
  //
  // ⛔ WHAT CHANGED AND WHY. Browsers cannot set request headers on
  // `new WebSocket(url, protocols)`, so the bearer used to ride the URL as
  // `?token=`. A URL is where secrets get durably written down — reverse-proxy
  // and access logs, crash reports, browser URL telemetry — none covered by
  // TLS, and `client_tokens` has NO expiry column, so anything that leaked
  // stayed valid until revoked by hand. It now rides `Sec-WebSocket-Protocol`,
  // the one header the constructor reaches.

  it('authenticates with the bearer in the SUBPROTOCOL, nothing secret on the URL', async () => {
    const { ws, opened } = await tryConnectViaSubprotocol(
      server!.port,
      `${issuedTokenId}.${issuedBearer}`,
    );
    expect(opened, 'the subprotocol carrier did not authenticate').toBe(true);
    ws.close();
    await wait(20);
  });

  it('the server NEVER echoes the bearer back in the handshake response', async () => {
    // `ws` selects the client's FIRST offered protocol by default and echoes the
    // selection in the `Sec-WebSocket-Protocol` RESPONSE header. Left to that
    // default, a bearer-first client would have its secret written into the
    // response — straight back into the logs this change exists to avoid. The
    // server pins the selection instead; this asserts the pin, not the ordering.
    const { ws, opened, acceptedProtocol } = await tryConnectViaSubprotocol(
      server!.port,
      `${issuedTokenId}.${issuedBearer}`,
    );
    expect(opened).toBe(true);
    expect(acceptedProtocol).toBe(WS_VERSION_SUBPROTOCOL);
    expect(acceptedProtocol).not.toContain('bearer.');
    expect(acceptedProtocol).not.toContain(issuedBearer);
    ws.close();
    await wait(20);
  });

  it('never echoes the bearer even when the client offers it FIRST', async () => {
    // ⛔ THIS IS THE TEST THAT ACTUALLY PINS THE GUARD. The case above offers
    // `recued.v1` first, so `ws`'s DEFAULT selection (first-offered) picks the
    // same value the pin would — it passes with or without `handleProtocols`,
    // proven by deleting the pin and watching all 21 stay green. It asserts the
    // outcome under a well-behaved client, not the guarantee.
    //
    // A client that offers the bearer first is the input that would do the thing
    // if the guard were gone: ws's default would select the bearer and echo it
    // into the `Sec-WebSocket-Protocol` RESPONSE header — the secret back in a
    // log, which is the whole point of moving it off the URL. Our clients order
    // it safely, but that is a client-side promise and the server must not
    // depend on one.
    const encodedBearer = encodeBearerSubprotocol(`${issuedTokenId}.${issuedBearer}`);
    const ws = new WebSocket(`ws://127.0.0.1:${server!.port}/ws`, [
      encodedBearer,               // ← adversarial ordering, on purpose
      WS_VERSION_SUBPROTOCOL,
    ]);
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });

    expect(opened, 'bearer-first must still authenticate — order is not auth').toBe(true);
    expect(
      ws.protocol,
      'the server echoed the BEARER back in the handshake response',
    ).toBe(WS_VERSION_SUBPROTOCOL);
    expect(ws.protocol).not.toContain('bearer.');
    expect(ws.protocol).not.toContain(encodedBearer);
    ws.close();
    await wait(20);
  });

  it('a BAD bearer in the subprotocol is refused, exactly like a bad one on the URL', async () => {
    // The input that would do the thing if the check were gone: a well-formed
    // carrier around a bearer that is not issued.
    const { opened } = await tryConnectViaSubprotocol(
      server!.port,
      `${canonicalTokenId('Z')}.${canonicalBearer('Z')}`,
    );
    expect(opened).toBe(false);
  });

  it('STILL accepts the legacy `?token=` form — un-upgraded clients must not break', async () => {
    // A PWA serves its cached bundle before replacing itself and an extension
    // updates on its own schedule, so browsers are still sending the old form.
    // Dropping it would 401 them with no way to tell why. This pins the
    // transition as deliberate; delete it only once no shipped client emits it.
    const { ws, opened } = await tryConnect(
      server!.port,
      `${issuedTokenId}.${issuedBearer}`,
    );
    expect(opened).toBe(true);
    ws.close();
    await wait(20);
  });
});

// ════════════════════════════════════════════════════════════════
// Without clientTokens wired → every upgrade on legacy path
// ════════════════════════════════════════════════════════════════

describe('D-148 § A.2.1 — WS upgrade without clientTokens dep (legacy compositions)', () => {
  let server: RunningServer | undefined;

  beforeAll(async () => {
    const manifests = createManifestRegistry('/nonexistent');
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(RECIPE);
    server = await startServer(0, {
      executeDeps: {
        recipeStore,
        executorConfig: { manifests },
        baseVault: {},
      },
      // clientTokens deliberately absent — db-less / legacy composition
    });
    server!.wsServer.maxInstances = 0;
  });

  afterAll(async () => {
    await server?.close();
  });

  it('structured-looking bearer accepted as legacy raw bearer (no verify path → accept-any)', async () => {
    // Without `clientTokens` wired, the upgrade handler short-circuits
    // through the legacy realm path even when the bearer happens to
    // carry a `.` separator. Pre-tightening behaviour preserved for
    // compositions that haven't yet composed `client_tokens`.
    const { ws, opened } = await tryConnect(
      server!.port,
      'fake-id.fake-bearer',
    );
    expect(opened).toBe(true);
    ws.close();
  });

  it('revokeConnectedInstance returns client_token_id undefined for legacy raw-bearer connections', async () => {
    const { ws, opened } = await tryConnect(server!.port, 'legacy-bearer-test');
    expect(opened).toBe(true);
    ws.send(JSON.stringify({
      type: 'register',
      instance_id: 'ext-legacy-raw',
      display_name: 'Legacy ext',
    }));
    await wait(50);
    const result = server!.wsServer.revokeConnectedInstance('ext-legacy-raw');
    expect(result.revoked).toBe(true);
    expect('client_token_id' in result).toBe(false);
  });
});
