/** D-148 — pre-auth server-identity probe (`POST /auth/identity-probe`).
 *
 *  The route lets a client ask *"is the server at this address the one I
 *  pinned?"* BEFORE presenting a bearer, which is what makes the Account &
 *  Servers URL edit safe by default rather than safe-after-exposure.
 *
 *  ⛔⛔ THE CENTRAL CASE IS `does not sign bytes the caller supplies`. Read it
 *  before changing anything here. `server_identity_key` also signs DDNS record
 *  updates, so a route that signed a caller's string would let anyone repoint
 *  `<handle>.recued.net`. That test builds the REAL DDNS canonical payload and
 *  proves the resulting signature does not verify over it.
 */

import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { canonicalJSONStringify } from '@recued/crypto';
import {
  IDENTITY_PROBE_PATH,
  IDENTITY_PROBE_DOMAIN,
  buildIdentityProbePayload,
} from '@recued/contracts';

import { createServerHandlerSet, type ServerConfig } from '../server.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore, ed25519Verify } from '../keys/index.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value;
  }
  end(body?: string): void {
    this.body = body ?? '';
  }
}

const buildReq = (opts: { url: string; method?: string; body?: string }): IncomingMessage => {
  const stream = Readable.from([
    Buffer.from(opts.body ?? '', 'utf-8'),
  ]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { method: string }).method = opts.method ?? 'POST';
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  return stream;
};

const NONCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const bootIdentity = async () => {
  const identity = await createServerIdentity({ store: createInMemoryServerKeyStore() });
  return identity;
};

const probeDepsFor = (
  identity: Awaited<ReturnType<typeof bootIdentity>>,
): NonNullable<ServerConfig['identityProbeDeps']> => ({
  serverIdentityKey: () => {
    const key = identity.serverIdentityKey();
    return {
      public_key_b64: key.public_key_b64,
      public_key_fingerprint: key.public_key_fingerprint,
    };
  },
  sign: (payload: string) => identity.signWithServerIdentity(payload),
});

const callProbe = async (
  config: ServerConfig,
  body: unknown,
): Promise<FakeRes> => {
  const set = createServerHandlerSet(config);
  const handler = set.handlers.ws!;
  const res = new FakeRes();
  await handler(
    buildReq({ url: IDENTITY_PROBE_PATH, body: JSON.stringify(body) }),
    res as never,
  );
  await set.close();
  return res;
};

describe('D-148 identity probe — proving identity without presenting a bearer', () => {
  it('signs a payload the SERVER builds, verifiable against the pinned key', async () => {
    const identity = await bootIdentity();
    const key = identity.serverIdentityKey();
    const res = await callProbe(
      { identityProbeDeps: probeDepsFor(identity) },
      { nonce: NONCE, expect_fingerprint: key.public_key_fingerprint },
    );

    expect(res.statusCode).toBe(200);
    const { signature } = JSON.parse(res.body!) as { signature: string };

    // The client rebuilds the payload from ITS OWN pin — the response carries
    // no key, so a server cannot steer what the client verifies.
    const expected = buildIdentityProbePayload({
      nonce: NONCE,
      server_public_key: key.public_key_b64,
    });
    expect(ed25519Verify(key.public_key_b64, expected, signature)).toBe(true);
  });

  it('⛔ never hands the signer bytes the caller chose — no DDNS takeover oracle', async () => {
    const identity = await bootIdentity();
    const key = identity.serverIdentityKey();

    // ⚠ SPY ON WHAT THE SIGNER IS HANDED, not on what comes back. An earlier
    // version of this test posted a DDNS-shaped string as the nonce and
    // asserted the RESPONSE could not be replayed — and it passed even with
    // the route signing `probeBody.nonce` directly, because the nonce
    // validator rejected the string first and the assertion never ran. The
    // validator is a real defense, but it is a DIFFERENT defense, and a test
    // that cannot tell them apart proves neither.
    const signed: string[] = [];
    const deps: NonNullable<ServerConfig['identityProbeDeps']> = {
      ...probeDepsFor(identity),
      sign: (payload: string) => {
        signed.push(payload);
        return identity.signWithServerIdentity(payload);
      },
    };

    const res = await callProbe(
      { identityProbeDeps: deps },
      { nonce: NONCE, expect_fingerprint: key.public_key_fingerprint },
    );
    expect(res.statusCode).toBe(200);
    expect(signed).toHaveLength(1);

    // 🔑 The property, over the bytes that actually reached the key: never the
    // caller's string, always a domain-tagged object the server built, with
    // the nonce demoted to a field inside it.
    expect(signed[0]).not.toBe(NONCE);
    const parsed = JSON.parse(signed[0]!) as Record<string, unknown>;
    expect(parsed.domain).toBe(IDENTITY_PROBE_DOMAIN);
    expect(parsed.nonce).toBe(NONCE);
    expect(parsed.server_public_key).toBe(key.public_key_b64);
  });

  it('⛔ rejects a nonce shaped like another protocol\'s signed payload', async () => {
    const identity = await bootIdentity();
    const key = identity.serverIdentityKey();

    // The exact bytes `backend/api/src/routes/ddns.ts` rebuilds and verifies.
    // Nothing here is secret: the handle IS the public hostname and
    // `publisher_id` is the fingerprint the Server Passport publishes. Signing
    // this string would let anyone repoint `<handle>.recued.net`.
    const ddnsForgery = canonicalJSONStringify({
      publisher_id: key.public_key_fingerprint,
      handle: 'victim',
      ip_v4: '203.0.113.9',
      ip_v6: null,
      timestamp: 1_700_000_000_000,
    });

    const signed: string[] = [];
    const deps: NonNullable<ServerConfig['identityProbeDeps']> = {
      ...probeDepsFor(identity),
      sign: (payload: string) => {
        signed.push(payload);
        return identity.signWithServerIdentity(payload);
      },
    };

    for (const attempt of [
      { nonce: ddnsForgery, expect_fingerprint: key.public_key_fingerprint },
      { nonce: NONCE, expect_fingerprint: ddnsForgery },
    ]) {
      expect((await callProbe({ identityProbeDeps: deps }, attempt)).statusCode).toBe(404);
    }
    // The second, independent defense: the signer was never reached at all.
    expect(signed).toEqual([]);
  });

  it('the signed payload carries the domain tag that separates it from other protocols', async () => {
    const payload = buildIdentityProbePayload({ nonce: NONCE, server_public_key: 'k' });
    expect(JSON.parse(payload)).toEqual({
      domain: IDENTITY_PROBE_DOMAIN,
      nonce: NONCE,
      server_public_key: 'k',
    });
    // Key-set disjointness from DDNS is a happy accident; the tag is the rule.
    expect(payload).toContain(IDENTITY_PROBE_DOMAIN);
  });

  it('refuses identically for a wrong fingerprint, a bad nonce, and no deps — never a beacon', async () => {
    const identity = await bootIdentity();
    const key = identity.serverIdentityKey();
    const deps = probeDepsFor(identity);
    const wrongFingerprint = 'sha256:' + 'b'.repeat(64);

    const refusals = await Promise.all([
      // Not configured at all.
      callProbe({}, { nonce: NONCE, expect_fingerprint: key.public_key_fingerprint }),
      // Configured, but this is not that server.
      callProbe({ identityProbeDeps: deps }, { nonce: NONCE, expect_fingerprint: wrongFingerprint }),
      // Nonce too short to be a real nonce.
      callProbe({ identityProbeDeps: deps }, { nonce: 'short', expect_fingerprint: key.public_key_fingerprint }),
      // Nonce carrying structure rather than entropy.
      callProbe({ identityProbeDeps: deps }, { nonce: '{"a":1}', expect_fingerprint: key.public_key_fingerprint }),
      // Unbounded nonce — a caller must not steer the size of what we sign.
      callProbe({ identityProbeDeps: deps }, { nonce: 'a'.repeat(10_000), expect_fingerprint: key.public_key_fingerprint }),
      // Fingerprint in the wrong encoding.
      callProbe({ identityProbeDeps: deps }, { nonce: NONCE, expect_fingerprint: key.public_key_b64 }),
      // Nothing at all.
      callProbe({ identityProbeDeps: deps }, {}),
    ]);

    // ⚠ AND THE TWO THAT USED TO ESCAPE. `readJsonBody` throws past the route
    // into `wsHandler`'s outer catch, which answers 400 and 413 — so malformed
    // and oversized bodies answered differently from every other refusal here.
    const set = createServerHandlerSet({ identityProbeDeps: deps });
    const raw = async (body: string): Promise<FakeRes> => {
      const res = new FakeRes();
      await set.handlers.ws!(buildReq({ url: IDENTITY_PROBE_PATH, body }), res as never);
      return res;
    };
    const malformed = await raw('{not json');
    const oversized = await raw(JSON.stringify({ nonce: 'a'.repeat(43), pad: 'x'.repeat(20_000) }));
    await set.close();

    const all = [...refusals, malformed, oversized];
    for (const res of all) expect(res.statusCode).toBe(404);
    // ⛔ One refusal, byte-identical, whatever the input.
    expect(new Set(all.map((r) => r.body)).size).toBe(1);
  });

  it('⚠ does NOT hide that the route exists — and that is deliberate', async () => {
    // The claim this file used to make was that a scanner could not tell "not
    // this server" from "no such route". It was never true: the floor handler's
    // 404 carries a different body, and the test that was meant to prove it
    // compared the route's refusals to EACH OTHER rather than to an unknown
    // path. Pinning the real behaviour so nobody re-asserts the stronger one.
    const identity = await bootIdentity();
    const set = createServerHandlerSet({ identityProbeDeps: probeDepsFor(identity) });
    const call = async (url: string): Promise<FakeRes> => {
      const res = new FakeRes();
      await set.handlers.ws!(
        buildReq({ url, body: JSON.stringify({ nonce: 'a'.repeat(43), expect_fingerprint: 'sha256:' + 'b'.repeat(64) }) }),
        res as never,
      );
      return res;
    };
    const mine = await call(IDENTITY_PROBE_PATH);
    const unknown = await call('/auth/no-such-route');
    await set.close();

    expect(mine.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    // 🔑 The property that IS delivered: neither answer says anything about
    // WHO this server is — no signature, no key, no yes-or-no on an identity.
    for (const res of [mine, unknown]) {
      expect(res.body).not.toContain('signature');
      expect(res.body).not.toContain(identity.serverIdentityKey().public_key_b64);
      expect(res.body).not.toContain(identity.serverIdentityKey().public_key_fingerprint);
    }
  });

  it('⛔ answers the CORS PREFLIGHT a real browser sends first', async () => {
    // ⚠ NO UNIT TEST WITH A FAKE `fetch` CAN SEE THIS. The probe posts
    // `content-type: application/json`, which is not a CORS-safelisted value,
    // so a browser sends OPTIONS before the POST and never makes the request
    // if that fails. The whole feature would be dead in a real browser while
    // every test stayed green.
    const identity = await bootIdentity();
    const set = createServerHandlerSet({ identityProbeDeps: probeDepsFor(identity) });
    const res = new FakeRes();
    await set.handlers.ws!(
      buildReq({ url: IDENTITY_PROBE_PATH, method: 'OPTIONS' }),
      res as never,
    );
    await set.close();

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // The two that make the actual POST legal.
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('content-type');
  });

  it('refuses a method that is neither POST nor the preflight', async () => {
    const identity = await bootIdentity();
    const set = createServerHandlerSet({ identityProbeDeps: probeDepsFor(identity) });
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = new FakeRes();
      await set.handlers.ws!(
        buildReq({ url: IDENTITY_PROBE_PATH, method }),
        res as never,
      );
      expect(res.statusCode, `${method} must not reach the signer`).not.toBe(200);
    }
    await set.close();
  });

  it('answers cross-origin — the webclient is never same-origin with the server', async () => {
    const identity = await bootIdentity();
    const res = await callProbe(
      { identityProbeDeps: probeDepsFor(identity) },
      { nonce: NONCE, expect_fingerprint: identity.serverIdentityKey().public_key_fingerprint },
    );
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('reads the key per request, so a rotation takes effect without a restart', async () => {
    const identity = await bootIdentity();
    const before = identity.serverIdentityKey().public_key_fingerprint;
    const config = { identityProbeDeps: probeDepsFor(identity) };

    await identity.rotateServerIdentity();
    const after = identity.serverIdentityKey();
    expect(after.public_key_fingerprint).not.toBe(before);

    // The pre-rotation pin no longer proves anything...
    expect((await callProbe(config, { nonce: NONCE, expect_fingerprint: before })).statusCode).toBe(404);
    // ...and the current key answers, on a handler set composed before it existed.
    expect(
      (await callProbe(config, { nonce: NONCE, expect_fingerprint: after.public_key_fingerprint })).statusCode,
    ).toBe(200);
  });
});
