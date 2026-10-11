/** D-148 § A.5.3 — `RecuedAcmeClient`. These two cases lived in
 *  `adapters.test.ts` until 2026-10-10, when the unwired DDNS adapters and TLS
 *  modes it mostly covered were deleted. */

import { describe, it, expect, vi } from 'vitest';
import { RecuedAcmeClient } from '../index.js';

describe('RecuedAcmeClient', () => {
  it('refuses to send a CSR containing PRIVATE KEY (client-side defense)', async () => {
    const client = new RecuedAcmeClient({
      cloud_base_url: 'https://api.recued.com',
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
      cloud_base_url: 'https://api.recued.com',
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
