/** D-148 — the client half of the identity probe, cross-checked against the
 *  REAL server signer in the same process.
 *
 *  ⛔ WHY THE REAL SIGNER AND NOT A FIXTURE. The claim the feature rests on is
 *  *"both ends import `buildIdentityProbePayload`, so the signed bytes cannot
 *  drift."* A hand-written fixture signature would prove the verifier parses
 *  base64; signing with `ed25519Sign` over the payload the server builds is
 *  what proves the two halves agree. A drift here fails CLOSED — every probe
 *  reports `not_the_same_server` and no URL can ever be saved — which is safe
 *  but total, and would present as "saving is broken" with nothing pointing at
 *  an encoding.
 *
 *  ⚠ `crypto.subtle` (the webclient's verifier) and `node:crypto` (the
 *  server's signer) are both available here, which is what makes the
 *  cross-check possible at all. */

import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildIdentityProbePayload, IDENTITY_PROBE_PATH } from '@recued/contracts';
import { ed25519Sign } from '@recued/server/keys/index.js';
import type { Ed25519Keypair } from '@recued/server/keys/index.js';

import { identityProbeUrl, probeServerIdentity } from '../identity-probe.js';

const realKeypair = (): Ed25519Keypair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    key_class: 'server_identity_key',
    private_key_b64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    public_key_b64: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
    public_key_fingerprint: 'unused-here',
    created_at: 0,
  } as Ed25519Keypair;
};

/** A stand-in server that answers exactly as `server.ts` does. */
const serverThatSigns = (
  keypair: Ed25519Keypair,
  opts: { nonceOverride?: string } = {},
) => {
  const seen: Array<{ url: string; body: { nonce: string; expect_fingerprint: string }; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { nonce: string; expect_fingerprint: string };
    seen.push({ url: String(url), body, init: init ?? {} });
    const signature = ed25519Sign(
      keypair,
      buildIdentityProbePayload({
        // The override models a server replaying a signature bound to some
        // OTHER nonce — the exact thing freshness is supposed to stop.
        nonce: opts.nonceOverride ?? body.nonce,
        server_public_key: keypair.public_key_b64,
      }),
    );
    return new Response(JSON.stringify({ signature }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, seen };
};

describe('identityProbeUrl', () => {
  it('maps the stored ws URL to the probe route, preserving host and port', () => {
    expect(identityProbeUrl('wss://h.example/ws')).toBe(`https://h.example${IDENTITY_PROBE_PATH}`);
    expect(identityProbeUrl('ws://127.0.0.1:7717/ws')).toBe(`http://127.0.0.1:7717${IDENTITY_PROBE_PATH}`);
    expect(identityProbeUrl('wss://h.example:8443/ws')).toBe(`https://h.example:8443${IDENTITY_PROBE_PATH}`);
  });

  it('⛔ preserves a reverse-proxy MOUNT PREFIX', () => {
    // nginx/Caddy in front of an existing site, Recued mounted under a path —
    // the shape D-148 § A.17 documents and the reason the address is editable.
    // Dropping the prefix probed the owner's OWN WEBSITE instead of their
    // server, and reported "could not prove it is this server" about it.
    expect(identityProbeUrl('wss://example.com/recued/ws')).toBe(
      `https://example.com/recued${IDENTITY_PROBE_PATH}`,
    );
    expect(identityProbeUrl('wss://example.com/apps/recued/ws')).toBe(
      `https://example.com/apps/recued${IDENTITY_PROBE_PATH}`,
    );
    // A trailing slash on the mount is the same mount.
    expect(identityProbeUrl('wss://example.com/recued/ws/')).toBe(
      `https://example.com/recued${IDENTITY_PROBE_PATH}`,
    );
    // And a plain ws:// LAN mount, since a proxy is not always TLS.
    expect(identityProbeUrl('ws://192.168.1.9:7717/recued/ws')).toBe(
      `http://192.168.1.9:7717/recued${IDENTITY_PROBE_PATH}`,
    );
  });

  it('agrees with the sibling URL builders the bootstrap already uses', () => {
    // ⚠ THE TELL THAT FOUND THIS: three builders in webclient-bootstrap.ts
    // preserve the prefix via `serverUrl.replace(/\/ws(?=$|\?)/, '/ws/download')`,
    // and `normaliseServerUrlToWs` deliberately keeps a prefix. A lone
    // disagreement with three siblings is a bug, not a design.
    for (const stored of ['wss://example.com/recued/ws', 'wss://example.com/ws']) {
      const sibling = stored.replace(/\/ws(?=$|\?)/, '/ws/download');
      const mountOf = (u: string) => new URL(u).pathname.replace(/\/ws(\/download)?\/?$/, '');
      expect(mountOf(identityProbeUrl(stored)!.replace(IDENTITY_PROBE_PATH, '/ws')))
        .toBe(mountOf(sibling));
    }
  });

  it('drops query and fragment — a URL is the one place a secret must not ride', () => {
    expect(identityProbeUrl('wss://h.example/ws?token=sekrit#frag')).toBe(
      `https://h.example${IDENTITY_PROBE_PATH}`,
    );
  });

  it('returns null rather than guessing at an address it cannot parse', () => {
    for (const bad of ['', 'not a url', 'ftp://h.example/ws', 'wss://[fe80::1%25eth0]/ws']) {
      expect(identityProbeUrl(bad)).toBeNull();
    }
  });
});

describe('probeServerIdentity', () => {
  it('verifies a signature the REAL server signer produced', async () => {
    const keypair = realKeypair();
    const { fetchImpl, seen } = serverThatSigns(keypair);

    const outcome = await probeServerIdentity({
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      fetch: fetchImpl,
    });

    expect(outcome).toEqual({ kind: 'verified' });
    expect(seen[0]!.url).toBe(`https://h.example${IDENTITY_PROBE_PATH}`);
    // ⛔ Anonymous by construction, even against a hostile host.
    expect(seen[0]!.init.credentials).toBe('omit');
  });

  it('🔑 refuses a signature bound to a different nonce — freshness is load-bearing', async () => {
    const keypair = realKeypair();
    // Same key, same payload shape, real signature — but over a nonce this
    // client never chose. That is a captured reply, and it must not pass.
    const { fetchImpl } = serverThatSigns(keypair, { nonceOverride: 'x'.repeat(43) });

    const outcome = await probeServerIdentity({
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      fetch: fetchImpl,
    });
    expect(outcome).toEqual({ kind: 'not_the_same_server' });
  });

  it('refuses a valid signature from a DIFFERENT server', async () => {
    const theirs = realKeypair();
    const ours = realKeypair();
    const { fetchImpl } = serverThatSigns(theirs);

    const outcome = await probeServerIdentity({
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: ours.public_key_b64,
      fetch: fetchImpl,
    });
    expect(outcome).toEqual({ kind: 'not_the_same_server' });
  });

  it('sends a fresh nonce each time, so two probes never share one', async () => {
    const keypair = realKeypair();
    const { fetchImpl, seen } = serverThatSigns(keypair);
    const args = {
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      fetch: fetchImpl,
    };
    await probeServerIdentity(args);
    await probeServerIdentity(args);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.nonce).not.toBe(seen[1]!.body.nonce);
  });

  it('names the fingerprint it expects, never asking who is there', async () => {
    const keypair = realKeypair();
    const { fetchImpl, seen } = serverThatSigns(keypair);
    await probeServerIdentity({
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      fetch: fetchImpl,
    });
    expect(seen[0]!.body.expect_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reads a refusal, a non-JSON body and a missing signature all as not-the-same-server', async () => {
    const keypair = realKeypair();
    const responses = [
      new Response('{}', { status: 404 }),
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify({}), { status: 200 }),
      new Response(JSON.stringify({ signature: '' }), { status: 200 }),
      new Response(JSON.stringify({ signature: 12 }), { status: 200 }),
    ];
    for (const response of responses) {
      const outcome = await probeServerIdentity({
        serverUrl: 'wss://h.example/ws',
        pinnedPublicKey: keypair.public_key_b64,
        fetch: (async () => response) as unknown as typeof globalThis.fetch,
      });
      expect(outcome).toEqual({ kind: 'not_the_same_server' });
    }
  });

  it('⛔ a NON-2xx is refused even carrying a valid signature', async () => {
    // Found by mutation: deleting the `!res.ok` guard reddened nothing, because
    // every existing refusal case also lacked a signature, so the SIGNATURE
    // check was doing the work. The status check is its own rule.
    //
    // ⚠ 2xx, NOT `=== 200`, AND THE FIRST VERSION OF THIS TEST GOT THAT WRONG —
    // it asserted "only a 200 counts" and 201 verified. Left deliberately
    // loose: the SIGNATURE is the proof of identity, while the status is
    // transport metadata a reverse proxy may legitimately rewrite, and this
    // feature exists to work behind nginx and Caddy. Tightening would trade a
    // guarantee we already have for a false negative in someone's deployment.
    const keypair = realKeypair();
    const goodSignature = (nonce: string) => ed25519Sign(
      keypair,
      buildIdentityProbePayload({ nonce, server_public_key: keypair.public_key_b64 }),
    );
    for (const status of [400, 404, 418, 500, 502]) {
      const outcome = await probeServerIdentity({
        serverUrl: 'wss://h.example/ws',
        pinnedPublicKey: keypair.public_key_b64,
        fetch: (async (_u: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return new Response(
            JSON.stringify({ signature: goodSignature(body.nonce) }),
            { status },
          );
        }) as unknown as typeof globalThis.fetch,
      });
      expect(outcome, `status ${status} must not verify`)
        .toEqual({ kind: 'not_the_same_server' });
    }
  });

  it('...and a 2xx with that same signature DOES verify', async () => {
    // The control for the case above: proves it is the STATUS being rejected,
    // not something wrong with the signature. 201 is included because `res.ok`
    // is deliberately 2xx-wide — see the note above.
    const keypair = realKeypair();
    for (const status of [200, 201]) {
      const outcome = await probeServerIdentity({
        serverUrl: 'wss://h.example/ws',
        pinnedPublicKey: keypair.public_key_b64,
        fetch: (async (_u: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          return new Response(JSON.stringify({
            signature: ed25519Sign(keypair, buildIdentityProbePayload({
              nonce: body.nonce, server_public_key: keypair.public_key_b64,
            })),
          }), { status });
        }) as unknown as typeof globalThis.fetch,
      });
      expect(outcome, `status ${status} should verify`).toEqual({ kind: 'verified' });
    }
  });

  it('reads a dead address as unreachable, never as a verdict about identity', async () => {
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'wss://dead.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });

  // ── ws:// from an https page ────────────────────────────────────────────
  // A LAN server is `ws://` → `http://`, and the webclient is served from
  // `https://app.recued.com`. That is the ORDINARY "move me to my LAN address"
  // case, not an edge one, and the browser refuses it before a byte leaves.

  it('⛔ names the BROWSER when a plain address is refused from a secure page', async () => {
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'ws://192.168.1.9:7717/ws',
      pinnedPublicKey: keypair.public_key_b64,
      pageProtocol: 'https:',
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });
    // ⚠ NOT `unreachable`. The server may be running and answering; blaming it
    // sends the owner to restart a working machine.
    expect(outcome).toEqual({ kind: 'blocked_by_browser' });
  });

  it('includes LOOPBACK once the request has actually failed', async () => {
    // Chrome permits a loopback dial from a secure page, so this must not be
    // warned about up front — but a failure IS the evidence, which is the
    // split `insecure-origin.ts` documents.
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'ws://localhost:7717/ws',
      pinnedPublicKey: keypair.public_key_b64,
      pageProtocol: 'https:',
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'blocked_by_browser' });
  });

  it('still says unreachable when the page is NOT secure — nothing is blocked', async () => {
    // The bundled webclient on loopback is an http page; a ws:// dial from it
    // is perfectly legal, so a failure there really is the server.
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'ws://192.168.1.9:7717/ws',
      pinnedPublicKey: keypair.public_key_b64,
      pageProtocol: 'http:',
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });

  it('a wss:// address failing from a secure page is the SERVER, not the browser', async () => {
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'wss://h.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      pageProtocol: 'https:',
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });

  it('a plain LAN address that ANSWERS still verifies — the diagnosis is failure-only', async () => {
    // ⚠ Guards against over-reach: an http page, or a browser that allowed it,
    // must not be told its working setup is blocked.
    const keypair = realKeypair();
    const { fetchImpl } = serverThatSigns(keypair);
    const outcome = await probeServerIdentity({
      serverUrl: 'ws://192.168.1.9:7717/ws',
      pinnedPublicKey: keypair.public_key_b64,
      pageProtocol: 'https:',
      fetch: fetchImpl,
    });
    expect(outcome).toEqual({ kind: 'verified' });
  });

  it('gives up on a hanging address instead of hanging the Save button', async () => {
    const keypair = realKeypair();
    const outcome = await probeServerIdentity({
      serverUrl: 'wss://slow.example/ws',
      pinnedPublicKey: keypair.public_key_b64,
      timeoutMs: 5,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });
});
