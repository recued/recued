/** D-148 P5 — BYO DDNS adapter round-trip tests.
 *
 *  Each adapter calls a `fetch`-shaped function. Tests inject a
 *  mock that captures the request and returns a canned response so
 *  we cover the full provider matrix without touching the network.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createDuckDnsAdapter,
  createCloudflareAdapter,
  createDynuAdapter,
  createGenericDnsAdapter,
  createRecuedCloudAdapter,
  RecuedAcmeClient,
  resolveTlsIntegration,
  isDdnsAdapterKind,
  isTlsIntegrationMode,
  TLS_INTEGRATION_MODES,
  DDNS_ADAPTER_KINDS,
} from '../index.js';

describe('DDNS_ADAPTER_KINDS — closed list discipline', () => {
  it('contains the expected five kinds', () => {
    expect(DDNS_ADAPTER_KINDS).toEqual([
      'recued-cloud',
      'duckdns',
      'cloudflare',
      'dynu',
      'generic-dns',
    ]);
  });

  it('isDdnsAdapterKind narrows correctly', () => {
    expect(isDdnsAdapterKind('duckdns')).toBe(true);
    expect(isDdnsAdapterKind('not-a-real-adapter')).toBe(false);
  });
});

describe('createDuckDnsAdapter', () => {
  it('builds a GET request with the right query params', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('OK', { status: 200 }));
    const adapter = createDuckDnsAdapter({
      subdomain: 'alice-recued',
      token: 'tok',
      fetch: fetchMock,
      now: () => 1700000000000,
    });
    const out = await adapter.update({
      handle: 'alice-recued.duckdns.org',
      ip_v4: '203.0.113.10',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('domains=alice-recued');
    expect(url).toContain('token=tok');
    expect(url).toContain('ip=203.0.113.10');
    expect(out.unchanged).toBe(false);
    expect(out.provider_message).toBe('OK');
  });

  it('throws on KO response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('KO', { status: 200 }));
    const adapter = createDuckDnsAdapter({
      subdomain: 's',
      token: 't',
      fetch: fetchMock,
    });
    await expect(adapter.update({ handle: 's.duckdns.org', ip_v4: '1.2.3.4' })).rejects.toThrow(
      /duckdns_update_failed/,
    );
  });

  it('passes ipv6 when supplied', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('OK', { status: 200 }));
    const adapter = createDuckDnsAdapter({
      subdomain: 's',
      token: 't',
      fetch: fetchMock,
    });
    await adapter.update({
      handle: 's.duckdns.org',
      ip_v4: '1.2.3.4',
      ip_v6: '2001:db8::1',
    });
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('ipv6=2001');
  });
});

describe('createCloudflareAdapter', () => {
  it('PATCHes the A record with ip_v4', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ success: true, result: {} }), { status: 200 }),
    );
    const adapter = createCloudflareAdapter({
      zone_id: 'ZONE',
      record_id: 'RECORD_A',
      api_token: 'CF_TOKEN',
      fetch: fetchMock,
    });
    const out = await adapter.update({
      handle: 'recued.example.com',
      ip_v4: '203.0.113.10',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call0 = fetchMock.mock.calls[0]!;
    const url = String(call0[0] ?? '');
    const init = (call0[1] ?? {}) as RequestInit;
    expect(url).toContain('/zones/ZONE/dns_records/RECORD_A');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { type: string; content: string };
    expect(body.type).toBe('A');
    expect(body.content).toBe('203.0.113.10');
    expect(out.ttl).toBe(300);
  });

  it('PATCHes both A and AAAA when ip_v6 + record_id_v6 provided', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const adapter = createCloudflareAdapter({
      zone_id: 'ZONE',
      record_id: 'RECORD_A',
      record_id_v6: 'RECORD_AAAA',
      api_token: 'CF_TOKEN',
      fetch: fetchMock,
    });
    await adapter.update({
      handle: 'recued.example.com',
      ip_v4: '203.0.113.10',
      ip_v6: '2001:db8::1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces error on non-2xx', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('forbidden', { status: 403 }),
    );
    const adapter = createCloudflareAdapter({
      zone_id: 'Z',
      record_id: 'R',
      api_token: 'T',
      fetch: fetchMock,
    });
    await expect(adapter.update({ handle: 'h', ip_v4: '1.2.3.4' })).rejects.toThrow(
      /cloudflare_update_failed/,
    );
  });
});

describe('createDynuAdapter', () => {
  it('GETs with HTTP Basic auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('good 203.0.113.10', { status: 200 }),
    );
    const adapter = createDynuAdapter({
      hostname: 'alice.dynu.net',
      username: 'alice',
      ip_update_password: 'secret',
      fetch: fetchMock,
    });
    const out = await adapter.update({ handle: 'alice.dynu.net', ip_v4: '203.0.113.10' });
    expect(out.unchanged).toBe(false);
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toContain('Basic ');
  });

  it('reports unchanged on `nochg`', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('nochg 203.0.113.10', { status: 200 }),
    );
    const adapter = createDynuAdapter({
      hostname: 'alice.dynu.net',
      username: 'alice',
      ip_update_password: 'secret',
      fetch: fetchMock,
    });
    const out = await adapter.update({ handle: 'alice.dynu.net', ip_v4: '203.0.113.10' });
    expect(out.unchanged).toBe(true);
  });
});

describe('createGenericDnsAdapter', () => {
  it('substitutes {handle} + {ip_v4} into URL template', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('good', { status: 200 }));
    const adapter = createGenericDnsAdapter({
      url_template: 'https://example.com/update?h={handle}&ip={ip_v4}',
      ok_substring: 'good',
      fetch: fetchMock,
    });
    await adapter.update({ handle: 'recued.example', ip_v4: '203.0.113.10' });
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('h=recued.example');
    expect(url).toContain('ip=203.0.113.10');
  });

  it('respects unchanged_substring', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('nochg', { status: 200 }));
    const adapter = createGenericDnsAdapter({
      url_template: 'https://example.com',
      ok_substring: 'nochg',
      unchanged_substring: 'nochg',
      fetch: fetchMock,
    });
    const out = await adapter.update({ handle: 'h', ip_v4: '1.2.3.4' });
    expect(out.unchanged).toBe(true);
  });

  it('throws when ok_substring not present', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('error', { status: 200 }));
    const adapter = createGenericDnsAdapter({
      url_template: 'https://example.com',
      ok_substring: 'good',
      fetch: fetchMock,
    });
    await expect(adapter.update({ handle: 'h', ip_v4: '1.2.3.4' })).rejects.toThrow(
      /generic_dns_update_failed/,
    );
  });
});

describe('createRecuedCloudAdapter', () => {
  it('signs the canonical payload + posts with bearer auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: {
            ddns_record_updated_at: 1700000000000,
            ttl: 300,
            warnings: [],
          },
        }),
        { status: 200 },
      ),
    );
    let signedPayload: Uint8Array | null = null;
    const adapter = createRecuedCloudAdapter({
      cloud_base_url: 'https://api.recued.cloud',
      pro_subscription_token: 'PRO_TOK',
      publisher_id: 'pub-1',
      sign(payload) {
        signedPayload = payload;
        return 'SIG';
      },
      fetch: fetchMock,
      now: () => 1700000000000,
    });
    const out = await adapter.update({
      handle: 'alice',
      ip_v4: '203.0.113.10',
    });
    expect(out.ttl).toBe(300);
    expect(signedPayload).not.toBeNull();
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer PRO_TOK');
    const body = JSON.parse(init.body as string) as { signature: string };
    expect(body.signature).toBe('SIG');
  });
});

describe('RecuedAcmeClient', () => {
  it('refuses to send a CSR containing PRIVATE KEY (client-side defense)', async () => {
    const client = new RecuedAcmeClient({
      cloud_base_url: 'https://api.recued.cloud',
      pro_subscription_token: 'PRO_TOK',
      publisher_id: 'pub-1',
      sign() {
        return 'SIG';
      },
      fetch: vi.fn(),
    });
    await expect(
      client.issueCert({
        handle: 'alice',
        domain: 'alice.recued.net',
        csr_pem: '-----BEGIN PRIVATE KEY-----\nLEAK\n-----END PRIVATE KEY-----',
      }),
    ).rejects.toThrow(/acme_csr_contains_private_key/);
  });

  it('returns parsed cert on successful response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: {
            cert_pem: 'CERT',
            issuer_chain_pem: 'CHAIN',
            expires_at: 1700000000000,
            renewal_recommended_at: 1700000000000 - 30 * 24 * 60 * 60 * 1000,
          },
        }),
        { status: 200 },
      ),
    );
    const client = new RecuedAcmeClient({
      cloud_base_url: 'https://api.recued.cloud',
      pro_subscription_token: 'TOK',
      publisher_id: 'pub-1',
      sign() {
        return 'SIG';
      },
      fetch: fetchMock,
    });
    const result = await client.issueCert({
      handle: 'alice',
      domain: 'alice.recued.net',
      csr_pem: '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----',
    });
    expect(result.cert_pem).toBe('CERT');
    expect(result.expires_at).toBe(1700000000000);
  });
});

describe('resolveTlsIntegration', () => {
  it('accepts recued-acme with cert + key paths', () => {
    const cfg = resolveTlsIntegration({
      mode: 'recued-acme',
      cert_path: '/var/lib/recued/cert.pem',
      tls_key_path: '/var/lib/recued/key.pem',
    });
    expect(cfg.mode).toBe('recued-acme');
    expect(cfg.listener_plaintext).toBe(false);
  });

  it('rejects recued-acme missing key path', () => {
    expect(() =>
      resolveTlsIntegration({ mode: 'recued-acme', cert_path: '/var/cert.pem' }),
    ).toThrow(/missing_paths/);
  });

  it('accepts certbot mode without key path', () => {
    const cfg = resolveTlsIntegration({ mode: 'certbot', cert_path: '/etc/letsencrypt' });
    expect(cfg.listener_plaintext).toBe(true);
  });

  it('rejects certbot mode that supplies a key path', () => {
    expect(() =>
      resolveTlsIntegration({
        mode: 'certbot',
        cert_path: '/etc/letsencrypt',
        tls_key_path: '/etc/key.pem',
      }),
    ).toThrow(/unexpected_key_path/);
  });

  it('accepts caddy mode (TLS terminated upstream)', () => {
    const cfg = resolveTlsIntegration({ mode: 'caddy' });
    expect(cfg.listener_plaintext).toBe(true);
  });

  it('rejects unknown mode', () => {
    expect(() => resolveTlsIntegration({ mode: 'bogus' })).toThrow(
      /tls_integration_mode_invalid/,
    );
  });

  it('isTlsIntegrationMode narrows', () => {
    for (const m of TLS_INTEGRATION_MODES) {
      expect(isTlsIntegrationMode(m)).toBe(true);
    }
    expect(isTlsIntegrationMode('made-up')).toBe(false);
  });
});
