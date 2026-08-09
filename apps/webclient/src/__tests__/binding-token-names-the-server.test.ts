/** A minted binding token must name the server it is for.
 *
 *  ⛔ THE DEFECT. `POST /v1/account/binding/token` has always accepted an
 *  optional `server_fingerprint`, and the auth Worker's DO has always enforced
 *  it — an exchange whose proving server differs from `intended_server` is
 *  rejected. The webclient never sent one. `account-binding-panel.ts` called
 *  `opts.mintBindingToken()` and the composition root built that caller as
 *  `() => accountBindingAuthClient.mintBindingToken()`, so every token the
 *  product ever minted was server-AGNOSTIC and the enforcement had nothing to
 *  enforce. Per the Worker's own comment: a captured token is then redeemable by
 *  ANY server presenting a valid self-proof — binding the attacker's server to
 *  the victim's account and consuming the victim's single-use nonce, so the
 *  victim's own server afterwards fails `nonce_reused`.
 *
 *  ⚠ WHAT THIS FILE PINS, AND WHY IT IS TWO TESTS. The value being correct and
 *  the value reaching the wire are different failures with the same symptom:
 *
 *    · `auth/__tests__/server-fingerprint.test.ts` proves the DERIVATION agrees
 *      with the server's own `ed25519PublicKeyFingerprint` — a mismatch there
 *      rejects every bind.
 *    · this file proves the auth client actually PUTS it in the request body —
 *      a drop here is invisible, because an unbound mint succeeds exactly like a
 *      bound one. That is what made the original defect survive: nothing fails
 *      when the field is missing.
 *
 *  Driven through `createAccountBindingAuthClient` — the real client the
 *  composition root builds — with only `fetch` faked, so the assertion is about
 *  the bytes that would leave the browser. */

import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { ed25519PublicKeyFingerprint } from '@recued/server/keys/index.js';
import {
  createAccountBindingAuthClient,
  type AccountBindingFetch,
} from '../settings/account-binding-auth-client.js';
import { serverKeyFingerprint } from '../auth/server-fingerprint.js';

const res = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
} as unknown as Response);

const sessionBody = (csrfToken: string) => ({
  authenticated: true,
  user: { id: 'acct-1', email: 'mary@example.com' },
  expiresAt: 1_700_000_100_000,
  csrfToken,
});

const mintBody = () => ({
  binding_token: 'bt_test',
  expires_at: 1_700_000_600_000,
  account_id: 'acct-1',
});

/** A real ed25519 key, exported the way the server exports its identity key and
 *  the way the webclient pins it in `server_public_key`. */
const realServerKey = (): { spkiDer: Uint8Array; b64: string } => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { spkiDer: new Uint8Array(der), b64: der.toString('base64') };
};

const driveMint = async (
  args: { server_fingerprint?: string },
): Promise<{ url: string; init?: RequestInit } | undefined> => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: AccountBindingFetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    if (url.endsWith('/v1/auth/session')) return res(200, sessionBody('csrf-1'));
    if (url.endsWith('/v1/account/binding/token')) return res(200, mintBody());
    throw new Error(`unexpected url ${url}`);
  });
  const client = createAccountBindingAuthClient({ workerUrl: 'https://auth.test', fetch });
  await client.mintBindingToken(args);
  return calls.find((c) => c.url.endsWith('/v1/account/binding/token'));
};

describe('binding token names the paired server', () => {
  it('puts the fingerprint of the PINNED server key in the mint request body', async () => {
    const key = realServerKey();
    const fingerprint = await serverKeyFingerprint(key.b64);

    const mint = await driveMint({ server_fingerprint: fingerprint });

    expect(mint, 'the mint request never left').toBeDefined();
    expect(mint!.init?.method).toBe('POST');
    const body = JSON.parse(String(mint!.init?.body)) as { server_fingerprint?: string };
    expect(
      body.server_fingerprint,
      'an absent fingerprint mints a token ANY proving server can redeem',
    ).toBe(fingerprint);
    // …and it is the value the server would compute for the same key, so the
    // DO's string comparison can succeed.
    expect(body.server_fingerprint).toBe(ed25519PublicKeyFingerprint(key.spkiDer));
  });

  it('sends NO body when no fingerprint is supplied — the shape the defect had', async () => {
    // Kept as the contrast case: this is what the product used to do on every
    // mint. It documents that the unbound path is silent — same 200, same
    // token — which is why the missing field went unnoticed for so long.
    const mint = await driveMint({});
    expect(mint).toBeDefined();
    expect(mint!.init?.body).toBeUndefined();
  });
});
