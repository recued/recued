/** D-148 § A.6.5 — `createRecuedAcmeClientFromRefs` factory tests.
 *
 *  Verifies the substrate that bridges Pro auth + publisher_id + signer
 *  refs into the `AcmeCertIssuer` shape the renewer
 *  (`createAcmeDomainRenewer`, 95th) consumes.
 *
 *  Key invariants:
 *    - `proAuth() === null` → throws `HTTP 401 pro_auth_unavailable`;
 *      renewer's `mapAcmeFailure` regex routes to `subscription_required`.
 *    - `publisherId() === null` → throws `HTTP 400
 *      publisher_id_unavailable`; renewer routes to `helper_unavailable`.
 *    - Both present → constructs a `RecuedAcmeClient` per-call with
 *      the resolved snapshot + delegates `issueCert`.
 *    - State rotation between calls — re-resolved each issuance so
 *      Pro re-auth + handle change land on the next cycle.
 *    - Fetch + now overrides pass through to the underlying client.
 *    - Composing with the actual renewer surfaces the right closed-
 *      list reasons end-to-end (`subscription_required` /
 *      `helper_unavailable`).
 *
 *  Spec: D-148 § A.5.3 + § A.6.5. */

import { describe, expect, it, vi } from 'vitest';
import type { TLSDomainCertChain, TLSDomainUploadResult } from '@recued/contracts';

import {
  ACME_ISSUANCE_TIMEOUT_MS,
  createRecuedAcmeClientFromRefs,
  selectProAuth,
  type ProAuthSnapshot,
  type RecuedAcmeClientFactoryOptions,
} from '../keys/rotation/recued-acme-client-factory.js';
import { createAcmeDomainRenewer } from '../keys/rotation/acme-domain-renewer.js';
import type { SqliteTlsDomainStore } from '../tls/domain-store.js';

// ────────────────────────────────────────────────────────────────
// Scaffolding
// ────────────────────────────────────────────────────────────────

const CLOUD_BASE = 'https://api.test.recued.net';

const fakeIssueResponse = (overrides?: Partial<{
  cert_pem: string;
  issuer_chain_pem: string;
  expires_at: number;
  renewal_recommended_at: number;
}>) => ({
  data: {
    cert_pem: 'NEW_CERT',
    issuer_chain_pem: 'NEW_CHAIN',
    expires_at: 2_700_000_000_000,
    renewal_recommended_at: 2_650_000_000_000,
    ...overrides,
  },
});

const okFetch = (
  responseBuilder?: () => unknown,
): ReturnType<typeof vi.fn> => {
  return vi.fn(async () => {
    const payload = responseBuilder ? responseBuilder() : fakeIssueResponse();
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as ReturnType<typeof vi.fn>;
};

const build = (
  overrides?: Partial<RecuedAcmeClientFactoryOptions>,
): {
  options: RecuedAcmeClientFactoryOptions;
  signer: ReturnType<typeof vi.fn>;
  fetchSpy: ReturnType<typeof vi.fn>;
} => {
  const signer = vi.fn(() => 'SIG_B64');
  const fetchSpy = overrides?.fetch as ReturnType<typeof vi.fn> | undefined
    ?? okFetch();
  const options: RecuedAcmeClientFactoryOptions = {
    cloud_base_url: CLOUD_BASE,
    proAuth: () => ({ pro_subscription_token: 'TOK' }),
    publisherId: () => 'PUB_ID',
    sign: signer,
    fetch: fetchSpy as unknown as typeof fetch,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { options, signer, fetchSpy };
};

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — shape', () => {
  it('returns an AcmeCertIssuer-shaped object with issueCert', () => {
    const { options } = build();
    const issuer = createRecuedAcmeClientFromRefs(options);
    expect(typeof issuer.issueCert).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────
// Pro auth missing → synthetic HTTP 401 → subscription_required
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — Pro auth missing', () => {
  it('throws HTTP 401 when proAuth() returns null', async () => {
    const { options, fetchSpy, signer } = build({
      proAuth: () => null,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/HTTP 401\b/);
    // No cloud round-trip + no signing work when substrate isn't ready.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it('error message names pro_auth_unavailable for log scrapers', async () => {
    const { options } = build({ proAuth: () => null });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/pro_auth_unavailable/);
  });

  it('re-reads proAuth on each call (rotation picks up new state)', async () => {
    let snapshot: ProAuthSnapshot | null = null;
    const { options } = build({ proAuth: () => snapshot });
    const issuer = createRecuedAcmeClientFromRefs(options);
    // First call: not authenticated yet.
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR1' }),
    ).rejects.toThrow(/HTTP 401\b/);
    // Pro auth completes between calls.
    snapshot = { pro_subscription_token: 'TOK_NEW' };
    // Second call: succeeds.
    const out = await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR2' });
    expect(out.cert_pem).toBe('NEW_CERT');
  });
});

// ────────────────────────────────────────────────────────────────
// Publisher_id missing → synthetic HTTP 400 → helper_unavailable
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — publisher_id missing', () => {
  it('throws HTTP 400 when publisherId() returns null', async () => {
    const { options, fetchSpy, signer } = build({
      publisherId: () => null,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/HTTP 400\b/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signer).not.toHaveBeenCalled();
  });

  it('error message names publisher_id_unavailable for log scrapers', async () => {
    const { options } = build({ publisherId: () => null });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/publisher_id_unavailable/);
  });

  it('proAuth-null wins over publisherId-null (Pro auth checked first)', async () => {
    // Both missing — the factory checks proAuth FIRST so operators
    // see the actionable surface (re-authenticate Pro) before the
    // less common one (reserve a handle).
    const { options } = build({
      proAuth: () => null,
      publisherId: () => null,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/HTTP 401\b/);
  });

  it('re-reads publisherId on each call (rotation picks up new state)', async () => {
    let id: string | null = null;
    const { options } = build({ publisherId: () => id });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR1' }),
    ).rejects.toThrow(/HTTP 400\b/);
    id = 'PUB_NEW';
    const out = await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR2' });
    expect(out.cert_pem).toBe('NEW_CERT');
  });
});

// ────────────────────────────────────────────────────────────────
// Success path — both refs present
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — success path', () => {
  it('delegates to RecuedAcmeClient.issueCert with resolved snapshot', async () => {
    const fetchSpy = okFetch();
    const { options, signer } = build({
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    const result = await issuer.issueCert({
      handle: 'alice',
      domain: 'alice.recued.net',
      csr_pem:
        '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----',
    });
    expect(result).toEqual({
      cert_pem: 'NEW_CERT',
      issuer_chain_pem: 'NEW_CHAIN',
      expires_at: 2_700_000_000_000,
      renewal_recommended_at: 2_650_000_000_000,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    // Bearer + JSON body verified via the fetch arg.
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${CLOUD_BASE}/v1/acme/issue-cert`);
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer TOK');
    expect((init as RequestInit).redirect).toBe('error');
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.publisher_id).toBe('PUB_ID');
    expect(body.handle).toBe('alice');
    // D-176 — the full domain rides the wire (unsigned; cross-checked
    // by the cloud against the CSR + the authenticated handle).
    expect(body.domain).toBe('alice.recued.net');
    expect(body.signature).toBe('SIG_B64');
    // Signer invoked once per issuance.
    expect(signer).toHaveBeenCalledOnce();
  });

  it('passes the now override through to the client (request timestamp)', async () => {
    const fetchSpy = okFetch();
    const { options } = build({
      fetch: fetchSpy as unknown as typeof fetch,
      now: () => 1_650_000_000_000,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.timestamp).toBe(1_650_000_000_000);
  });

  it('constructs a fresh client per call (state rotation observable)', async () => {
    const fetchSpy = okFetch();
    let token = 'TOK_A';
    const { options } = build({
      fetch: fetchSpy as unknown as typeof fetch,
      proAuth: () => ({ pro_subscription_token: token }),
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR1' });
    token = 'TOK_B';
    await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR2' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const headers1 = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    const headers2 = new Headers((fetchSpy.mock.calls[1]![1] as RequestInit).headers);
    expect(headers1.get('authorization')).toBe('Bearer TOK_A');
    expect(headers2.get('authorization')).toBe('Bearer TOK_B');
  });

  it('awaits an async ProAuthResolver (binding entitlement mint path)', async () => {
    const fetchSpy = okFetch();
    const { options } = build({
      fetch: fetchSpy as unknown as typeof fetch,
      proAuth: async () => ({
        pro_subscription_token: 'ENTITLEMENT_CLAIM',
        source: 'binding_entitlement',
      }),
    });
    const issuer = createRecuedAcmeClientFromRefs(options);

    await issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' });

    const headers = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer ENTITLEMENT_CLAIM');
  });
});

// ────────────────────────────────────────────────────────────────
// Cloud-side error pass-through
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — cloud errors', () => {
  it('propagates HTTP 4xx errors from RecuedAcmeClient verbatim', async () => {
    const failingFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      async text() {
        return 'subscription expired';
      },
      async json() {
        return {};
      },
    }));
    const { options } = build({
      fetch: failingFetch as unknown as typeof fetch,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/HTTP 403\b/);
  });

  it('propagates HTTP 5xx errors from RecuedAcmeClient verbatim', async () => {
    const failingFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      async text() {
        return 'cloud down';
      },
      async json() {
        return {};
      },
    }));
    const { options } = build({
      fetch: failingFetch as unknown as typeof fetch,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toThrow(/HTTP 503\b/);
  });

  it('rejects CSRs that bundle a PRIVATE KEY block at the client boundary', async () => {
    // `RecuedAcmeClient.issueCert` has its own defensive PRIVATE-KEY
    // gate. The factory shouldn't swallow that error or pre-empt it —
    // verifying the factory passes the gate through transparently.
    const fetchSpy = okFetch();
    const { options } = build({
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);
    await expect(
      issuer.issueCert({
        handle: 'alice',
        domain: 'alice.recued.net',
        csr_pem:
          '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----\n' +
          '-----BEGIN PRIVATE KEY-----\nLEAK\n-----END PRIVATE KEY-----',
      }),
    ).rejects.toThrow(/acme_csr_contains_private_key/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancels and rejects a lengthless response above the 1 MiB ACME ceiling', async () => {
    const cancel = vi.fn();
    const oversizedFetch = vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
      { status: 200 },
    ));
    const { options } = build({
      fetch: oversizedFetch as unknown as typeof fetch,
    });
    const issuer = createRecuedAcmeClientFromRefs(options);

    await expect(
      issuer.issueCert({ handle: 'alice', domain: 'alice.recued.net', csr_pem: 'CSR' }),
    ).rejects.toMatchObject({
      name: 'ResponseBodyTooLargeError',
      maxBytes: 1024 * 1024,
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // ⚠ Asserts the BEHAVIOUR (the deadline covers the BODY READ, so a peer that
  //   sends headers then stalls forever is still aborted — a slowloris defence),
  //   against the REAL constant. It previously hardcoded 30_000 and went red on a
  //   deliberate raise to 240s; the number was never the contract.
  it('keeps the issuance deadline active while reading the cloud body', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const stalledFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (!(init?.signal instanceof AbortSignal)) {
          throw new Error('ACME request was dispatched without a deadline signal');
        }
        capturedSignal = init.signal;
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { streamController = controller; },
        });
        init.signal.addEventListener('abort', () => {
          streamController?.error(new DOMException('aborted', 'AbortError'));
        }, { once: true });
        return new Response(body, { status: 200 });
      });
      const { options } = build({
        fetch: stalledFetch as unknown as typeof fetch,
      });
      const issuer = createRecuedAcmeClientFromRefs(options);
      const pending = issuer.issueCert({
        handle: 'alice',
        domain: 'alice.recued.net',
        csr_pem: 'CSR',
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      await vi.advanceTimersByTimeAsync(ACME_ISSUANCE_TIMEOUT_MS + 1);
      await rejected;
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Integration: factory + renewer end-to-end closed-list mapping
// ────────────────────────────────────────────────────────────────

describe('createRecuedAcmeClientFromRefs — renewer integration', () => {
  // Verifies that the factory's synthetic HTTP statuses route through
  // the renewer's `mapAcmeFailure` regex to the right closed-list
  // reasons end-to-end. This is the load-bearing contract: substrate
  // missing → operator sees the right surface (Settings → Pro vs
  // Settings → Handle) via the renewer's reason.

  const chain = (
    domain: string,
    fingerprint: string,
  ): TLSDomainCertChain => ({
    domain,
    cert_pem: 'OLD_CERT',
    private_key_pem: 'PRIVKEY',
    fingerprint,
    expires_at: 1_700_000_000_000,
    source: 'pro_acme',
  });

  const stubStore = (): Pick<SqliteTlsDomainStore, 'lookup' | 'upload'> => {
    const chains = new Map<string, TLSDomainCertChain>([
      ['alice.recued.net', chain('alice.recued.net', 'OLDFP')],
    ]);
    return {
      lookup: (domain) => chains.get(domain) ?? null,
      upload: async (args) => {
        const updated: TLSDomainCertChain = {
          domain: args.domain,
          cert_pem: args.cert_pem,
          private_key_pem: args.private_key_pem,
          fingerprint: 'NEWFP',
          expires_at: 2_700_000_000_000,
          source: args.source,
        };
        if (args.chain_pem !== undefined) updated.chain_pem = args.chain_pem;
        chains.set(args.domain, updated);
        return {
          fingerprint: 'NEWFP',
          expires_at: 2_700_000_000_000,
          san: [args.domain],
        } as TLSDomainUploadResult;
      },
    };
  };

  it('proAuth-null → renewer returns subscription_required', async () => {
    const { options } = build({ proAuth: () => null });
    const acme = createRecuedAcmeClientFromRefs(options);
    const renewer = createAcmeDomainRenewer({
      acme,
      store: stubStore(),
      generateCsr: () =>
        '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----',
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'subscription_required' });
  });

  it('publisherId-null → renewer returns helper_unavailable', async () => {
    const { options } = build({ publisherId: () => null });
    const acme = createRecuedAcmeClientFromRefs(options);
    const renewer = createAcmeDomainRenewer({
      acme,
      store: stubStore(),
      generateCsr: () =>
        '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----',
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: false, reason: 'helper_unavailable' });
  });

  it('both refs ready → renewer returns ok with new_fingerprint', async () => {
    const fetchSpy = okFetch();
    const { options } = build({
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const acme = createRecuedAcmeClientFromRefs(options);
    const renewer = createAcmeDomainRenewer({
      acme,
      store: stubStore(),
      generateCsr: () =>
        '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----',
    });
    const out = await renewer.renewDomain({ domain: 'alice.recued.net' });
    expect(out).toEqual({ ok: true, new_fingerprint: 'NEWFP' });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('selectProAuth — D-175 P8b binding-authoritative-when-present', () => {
  const binding: ProAuthSnapshot = {
    pro_subscription_token: 'claim',
    source: 'binding_entitlement',
  };
  const manual: ProAuthSnapshot = {
    pro_subscription_token: 'manual',
    source: 'manual_token',
  };

  it('prefers a resolved binding entitlement (the preferred path)', () => {
    expect(
      selectProAuth({ bindingAuth: binding, hasStoredBinding: true, manualAuth: manual }),
    ).toBe(binding);
  });

  it('fails closed when a binding is stored but its entitlement did not resolve (unbind/rebind/revoked)', () => {
    // The load-bearing fix: a bound-but-now-unbound server must NOT fall back
    // to the manual token — account-ownership revocation stops actuation.
    expect(
      selectProAuth({ bindingAuth: null, hasStoredBinding: true, manualAuth: manual }),
    ).toBeNull();
  });

  it('falls back to the manual token only for a server with NO binding (D-148 migration path)', () => {
    expect(
      selectProAuth({ bindingAuth: null, hasStoredBinding: false, manualAuth: manual }),
    ).toBe(manual);
  });

  it('returns null when unbound and no manual token is configured', () => {
    expect(
      selectProAuth({ bindingAuth: null, hasStoredBinding: false, manualAuth: null }),
    ).toBeNull();
  });
});
