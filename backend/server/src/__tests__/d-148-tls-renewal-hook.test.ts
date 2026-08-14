/** D-148 § A.6.5 — `createDomainBackedTlsRenewalHook` adapter tests.
 *
 *  Verifies the production `TlsRenewalHook` adapter that bridges
 *  `SqliteTlsDomainStore` + an injected per-domain renewer into the
 *  rotation engine's `RotationEngineOptions.tls` slot.
 *
 *  Key invariants:
 *    - `renewer: null` always returns `helper_unavailable` (no store
 *      probe). Operator `tls.renew` rpc reaches a closed-list error
 *      code instead of `key_not_loaded`.
 *    - When the hint-picked address resolves to no `tls_domains` row
 *      (LAN-only / BYO-filtered / not-yet-provisioned), returns
 *      `helper_unavailable`. Doesn't call the renewer.
 *    - Source filter mirrors the cert source: `['pro_acme']`
 *      production wiring ignores BYO-uploaded rows so they don't get
 *      sent to the ACME renewer.
 *    - `previous_fingerprint` carries the `sha256:` prefix so the
 *      rotation engine's signed `cert_rotation_notice` matches the
 *      cert source's pin-fingerprint format end-to-end.
 *    - The three renewer failure reasons (`helper_unavailable` /
 *      `subscription_required` / `storage_io_error`) pass through
 *      verbatim.
 *
 *  Spec: D-148 § A.6.5. */

import { describe, expect, it, vi } from 'vitest';
import type { TLSDomainCertListEntry } from '@recued/contracts';

import {
  createDomainBackedTlsRenewalHook,
  type DomainRenewer,
} from '../keys/rotation/tls-renewal-hook.js';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

const entry = (
  domain: string,
  fingerprint: string,
  expires_at: number,
  source: 'byo_upload' | 'pro_acme' = 'pro_acme',
): TLSDomainCertListEntry => ({
  domain,
  fingerprint,
  expires_at,
  issuer: 'CN=Stub CA',
  source,
});

const stubStore = (
  entries: TLSDomainCertListEntry[],
): Pick<SqliteTlsDomainStore, 'list'> => ({
  list: () => entries,
});

const okRenewer = (new_fingerprint: string): DomainRenewer => ({
  // D-235 P4 — `cert_expires_at` rides along so a per-row renewal caller learns
  // when to come back without re-reading the store.
  renewDomain: vi.fn(
    async (
      _args: { domain: string },
    ): Promise<{ ok: true; new_fingerprint: string; cert_expires_at: number }> => ({
      ok: true,
      new_fingerprint,
      cert_expires_at: 4_000_000_000_000,
    }),
  ),
});

const failingRenewer = (
  reason: 'helper_unavailable' | 'subscription_required' | 'storage_io_error',
): DomainRenewer => ({
  renewDomain: vi.fn(
    async (): Promise<{
      ok: false;
      reason: 'helper_unavailable' | 'subscription_required' | 'storage_io_error';
    }> => ({ ok: false, reason }),
  ),
});

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — shape', () => {
  it('returns a TlsRenewalHook-shaped object', () => {
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: [] }),
      store: stubStore([]),
      renewer: null,
    });
    expect(typeof hook.renew).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Null renewer
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — null renewer', () => {
  it('returns helper_unavailable when renewer is null (substrate posture)', async () => {
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
      renewer: null,
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('does not call the store when renewer is null', async () => {
    const listSpy = vi.fn(() => [
      entry('alice.example', 'aabbcc', 1_900_000_000_000),
    ]);
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: { list: listSpy },
      renewer: null,
    });
    await hook.renew();
    expect(listSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// No matching row
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — no matching row', () => {
  it('returns helper_unavailable when LAN is empty + DDNS absent', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: [] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();
  });

  it('returns helper_unavailable when the store is empty', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();
  });

  it('returns helper_unavailable when the chosen hostname is not in the store', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://192.168.1.42:8443/ws'] }),
      store: stubStore([entry('alice.example', 'aabbcc', 1_900_000_000_000)]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();
  });

  it('returns helper_unavailable when the chosen URL is unparseable', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['not a url'] }),
      store: stubStore([entry('not a url', 'aabbcc', 1_900_000_000_000)]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Source filter
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — source filter', () => {
  it('ignores BYO rows when sources=["pro_acme"] (matches cert-source production wiring)', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([
        entry('alice.example', 'aabbcc', 1_900_000_000_000, 'byo_upload'),
      ]),
      renewer,
      sources: ['pro_acme'],
    });
    const result = await hook.renew();
    expect(result).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();
  });

  it('passes when the row matches the source filter', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([
        entry('alice.example', 'aabbcc', 1_900_000_000_000, 'pro_acme'),
      ]),
      renewer,
      sources: ['pro_acme'],
    });
    const result = await hook.renew();
    expect(result.ok).toBe(true);
    expect(renewer.renewDomain).toHaveBeenCalledWith({ domain: 'alice.example' });
  });

  it('accepts any source when sources is omitted', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([
        entry('alice.example', 'aabbcc', 1_900_000_000_000, 'byo_upload'),
      ]),
      renewer,
    });
    const result = await hook.renew();
    expect(result.ok).toBe(true);
    expect(renewer.renewDomain).toHaveBeenCalledWith({ domain: 'alice.example' });
  });
});

// ────────────────────────────────────────────────────────────────
// Renewer success
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — renewer success', () => {
  it('returns ok with new + previous fingerprints (both sha256:-prefixed)', async () => {
    const renewer = okRenewer('sha256:new-fp');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([entry('alice.example', 'old-fp', 1_900_000_000_000)]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({
      ok: true,
      new_fingerprint: 'sha256:new-fp',
      previous_fingerprint: 'sha256:old-fp',
    });
  });

  it('preserves the sha256: prefix on a stored fingerprint that already carries it', async () => {
    const renewer = okRenewer('new-fp');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
      store: stubStore([
        entry('alice.example', 'sha256:old-fp', 1_900_000_000_000),
      ]),
      renewer,
    });
    const result = await hook.renew();
    expect(result).toEqual({
      ok: true,
      new_fingerprint: 'sha256:new-fp',
      previous_fingerprint: 'sha256:old-fp',
    });
  });

  it('passes the canonical (lowercase) domain name to the renewer', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({ lan: ['wss://Alice.Example:8443/ws'] }),
      store: stubStore([entry('alice.example', 'old', 1_900_000_000_000)]),
      renewer,
    });
    await hook.renew();
    expect(renewer.renewDomain).toHaveBeenCalledWith({ domain: 'alice.example' });
  });
});

// ────────────────────────────────────────────────────────────────
// Renewer failure passthrough
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — renewer failure', () => {
  for (const reason of [
    'helper_unavailable',
    'subscription_required',
    'storage_io_error',
  ] as const) {
    it(`passes through reason '${reason}' verbatim`, async () => {
      const renewer = failingRenewer(reason);
      const hook = createDomainBackedTlsRenewalHook({
        readHints: () => ({ lan: ['wss://alice.example:8443/ws'] }),
        store: stubStore([entry('alice.example', 'old', 1_900_000_000_000)]),
        renewer,
      });
      const result = await hook.renew();
      expect(result).toEqual({ ok: false, reason });
      expect(renewer.renewDomain).toHaveBeenCalledOnce();
    });
  }
});

// ────────────────────────────────────────────────────────────────
// LAN-first / DDNS fallback (inherited from resolver)
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — hint precedence', () => {
  it('uses lan[0] when populated, even when DDNS would match', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({
        lan: ['wss://lan.example:8443/ws'],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([
        entry('lan.example', 'fp-lan', 1_900_000_000_000),
        entry('ddns.example', 'fp-ddns', 2_000_000_000_000),
      ]),
      renewer,
    });
    await hook.renew();
    expect(renewer.renewDomain).toHaveBeenCalledWith({ domain: 'lan.example' });
  });

  it('falls through to DDNS when every LAN entry is empty', async () => {
    const renewer = okRenewer('sha256:new');
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () => ({
        lan: ['', ''],
        ddns: 'wss://ddns.example:443/ws',
      }),
      store: stubStore([entry('ddns.example', 'fp-ddns', 2_000_000_000_000)]),
      renewer,
    });
    await hook.renew();
    expect(renewer.renewDomain).toHaveBeenCalledWith({ domain: 'ddns.example' });
  });
});

// ────────────────────────────────────────────────────────────────
// Hint freshness (read every call)
// ────────────────────────────────────────────────────────────────

describe('createDomainBackedTlsRenewalHook — readHints freshness', () => {
  it('observes hint changes between calls (no construction-time capture)', async () => {
    const renewer = okRenewer('sha256:new');
    let phase = 0;
    const hook = createDomainBackedTlsRenewalHook({
      readHints: () =>
        phase === 0
          ? { lan: [] }
          : { lan: ['wss://alice.example:8443/ws'] },
      store: stubStore([entry('alice.example', 'old', 1_900_000_000_000)]),
      renewer,
    });
    const first = await hook.renew();
    expect(first).toEqual({ ok: false, reason: 'helper_unavailable' });
    expect(renewer.renewDomain).not.toHaveBeenCalled();

    phase = 1;
    const second = await hook.renew();
    expect(second.ok).toBe(true);
    expect(renewer.renewDomain).toHaveBeenCalledOnce();
  });
});
