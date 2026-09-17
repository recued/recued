/** D-148 — the identity probe over a REAL HTTP round-trip.
 *
 *  ⛔ WHY THIS EXISTS ALONGSIDE `d-148-identity-probe.test.ts`. Every case in
 *  that file drives the handler with a synthetic `req` object and a `FakeRes`
 *  that records `setHeader`/`end` calls. That proves the handler's LOGIC and
 *  nothing about whether the thing works when bytes actually move: a real
 *  request has a body stream that must be consumed, real headers, a real
 *  socket, and a response that must be flushed and parseable. The `ws` module
 *  that vanished from the SEA binary is this codebase's own reminder that the
 *  artifact a test never executes is where the defect lives.
 *
 *  ⚠ Deliberately NOT a duplicate of the logic suite. It asserts the round
 *  trip: a real client fetches, the reply parses, and a signature produced by a
 *  real server verifies against a real key. */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IDENTITY_PROBE_PATH, buildIdentityProbePayload } from '@recued/contracts';

import { createServerHandlerSet, type ServerHandlerSet } from '../server.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore, ed25519Verify } from '../keys/index.js';

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const boot = async (): Promise<{
  origin: string;
  key: { public_key_b64: string; public_key_fingerprint: string };
}> => {
  const identity = await createServerIdentity({ store: createInMemoryServerKeyStore() });
  const set: ServerHandlerSet = createServerHandlerSet({
    identityProbeDeps: {
      serverIdentityKey: () => {
        const k = identity.serverIdentityKey();
        return { public_key_b64: k.public_key_b64, public_key_fingerprint: k.public_key_fingerprint };
      },
      sign: (payload) => identity.signWithServerIdentity(payload),
    },
  });
  const server: Server = createServer((req, res) => {
    void set.handlers.ws!(req, res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  open.push(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await set.close();
  });
  const k = identity.serverIdentityKey();
  return {
    origin: `http://127.0.0.1:${port}`,
    key: { public_key_b64: k.public_key_b64, public_key_fingerprint: k.public_key_fingerprint },
  };
};

const NONCE = 'n'.repeat(43);

describe('identity probe — real HTTP', () => {
  it('⛔ a real POST returns a signature that verifies against the real key', async () => {
    const { origin, key } = await boot();

    const res = await fetch(`${origin}${IDENTITY_PROBE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, expect_fingerprint: key.public_key_fingerprint }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const { signature } = (await res.json()) as { signature: string };

    // Rebuilt from the pin, exactly as the client does.
    const payload = buildIdentityProbePayload({
      nonce: NONCE,
      server_public_key: key.public_key_b64,
    });
    expect(ed25519Verify(key.public_key_b64, payload, signature)).toBe(true);
  });

  it('answers the browser preflight with the headers that make the POST legal', async () => {
    const { origin } = await boot();
    const res = await fetch(`${origin}${IDENTITY_PROBE_PATH}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('carries the CORS header on the real 200 too, not only the preflight', async () => {
    // A preflight that passes and a response the browser then discards for
    // want of the header is a failure mode no logic test can see.
    const { origin, key } = await boot();
    const res = await fetch(`${origin}${IDENTITY_PROBE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, expect_fingerprint: key.public_key_fingerprint }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses a real request that names another server, and says nothing about this one', async () => {
    const { origin, key } = await boot();
    const res = await fetch(`${origin}${IDENTITY_PROBE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, expect_fingerprint: `sha256:${'b'.repeat(64)}` }),
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(key.public_key_b64);
    expect(body).not.toContain(key.public_key_fingerprint);
    expect(body).not.toContain('signature');
  });

  it('⚠ a real oversized body is refused like every other refusal, not with 413', async () => {
    // The stream path is where this one actually happens: the body is consumed
    // over a socket and the cap fires mid-flight, which a synthetic request
    // models only approximately.
    const { origin, key } = await boot();
    const res = await fetch(`${origin}${IDENTITY_PROBE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: NONCE, expect_fingerprint: key.public_key_fingerprint, pad: 'x'.repeat(64_000) }),
    });
    expect(res.status).toBe(404);
  });
});
