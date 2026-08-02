import { describe, expect, it, vi } from 'vitest';

import type { AccountBindingExchangeRequest } from '@recued/contracts';

import {
  createHttpAccountBindingExchangeClient,
  type FetchLike,
} from '../account-binding/exchange-client.js';
import { createDdnsUpdateClient } from '../ddns/update-client.js';
import { createRecuedCloudHandleClient } from '../handle/recued-cloud-client.js';
import type { StoredAccountBinding } from '../keys/index.js';
import { createHttpProEntitlementSource } from '../pro-convenience/entitlement-source.js';

const bindingRequest: AccountBindingExchangeRequest = {
  binding_token: 'SECRET-binding-token',
  server_fingerprint: 'sha256:server',
  server_public_key_b64: 'public-key',
  proof_payload: '{}',
  proof_signature: 'signature',
  confirm_rebind: false,
};

const storedBinding: StoredAccountBinding = {
  account_id: 'acct_1',
  server_scoped_credential: 'SECRET-server-credential',
  server_fingerprint: 'sha256:server',
  bound_at: 1,
  credential_issued_at: 1,
};

const redirectingFetchSpy = () => vi.fn(async (
  _input: RequestInfo | URL,
  _init?: RequestInit,
) => new Response(null, {
  status: 307,
  headers: { location: 'https://collector.invalid/steal' },
}));

describe('server cloud HTTP lifecycle', () => {
  it('refuses to replay an account-binding token across origins', async () => {
    const fetchSpy = redirectingFetchSpy();
    const client = createHttpAccountBindingExchangeClient({
      getEndpointUrl: () => 'https://auth.recued.com/v1/account/bind/exchange',
      fetchImpl: fetchSpy as unknown as FetchLike,
    });

    await expect(client.exchange(bindingRequest)).resolves.toMatchObject({
      ok: false,
      code: 'exchange_unavailable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('fails entitlement closed before replaying a server credential across origins', async () => {
    const fetchSpy = redirectingFetchSpy();
    const source = createHttpProEntitlementSource({
      loadBinding: () => storedBinding,
      getEndpointUrl: () => 'https://auth.recued.com/v1/account/entitlement/mint',
      getPublicKeyB64: () => 'configured-key',
      fetchImpl: fetchSpy,
    });

    await expect(source.resolve()).resolves.toEqual({
      state: 'unavailable',
      reason: 'entitlement_mint_unavailable',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses to replay a signed handle request across origins', async () => {
    const fetchSpy = redirectingFetchSpy();
    const client = createRecuedCloudHandleClient({
      cloud_base_url: 'https://api.recued.cloud',
      fetch: fetchSpy,
    });

    const result = await client.reserveHandle({
      publisher_id: 'publisher',
      handle: 'launch',
      nonce: 'nonce',
      signature: 'SECRET-signed-envelope',
      timestamp: 1,
    });
    expect(result).toMatchObject({ ok: false, error: 'handle_validation_error' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses to replay a signed DDNS update across origins', async () => {
    const fetchSpy = redirectingFetchSpy();
    const client = createDdnsUpdateClient({
      cloud_base_url: 'https://api.recued.cloud',
      signPayload: () => 'SECRET-ddns-signature',
      fetch: fetchSpy,
    });

    const result = await client.update({
      publisher_id: 'publisher',
      handle: 'launch',
      ip_v4: '203.0.113.1',
      timestamp: 1,
    });
    expect(result).toMatchObject({ ok: false, error: 'network_error' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('rejects an oversized cloud response before JSON parsing', async () => {
    const client = createRecuedCloudHandleClient({
      cloud_base_url: 'https://api.recued.cloud',
      maxResponseBytes: 4,
      fetch: async () => new Response('{"data":{"handle":"too large"}}'),
    });

    const result = await client.reserveHandle({
      publisher_id: 'publisher',
      handle: 'launch',
      nonce: 'nonce',
      signature: 'signature',
      timestamp: 1,
    });
    expect(result).toMatchObject({ ok: false, error: 'handle_validation_error' });
    if (!result.ok) expect(result.message).toContain('limit 4');
  });

  it('keeps the entitlement deadline active while the response body stalls', async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const source = createHttpProEntitlementSource({
        loadBinding: () => storedBinding,
        getEndpointUrl: () => 'https://auth.recued.com/v1/account/entitlement/mint',
        getPublicKeyB64: () => 'configured-key',
        timeoutMs: 20,
        fetchImpl: async (_input, init) => {
          observedSignal = init?.signal ?? undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const abort = (): void => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                controller.error(error);
              };
              if (observedSignal?.aborted) abort();
              else observedSignal?.addEventListener('abort', abort, { once: true });
            },
          });
          return new Response(body, { status: 200 });
        },
      });

      const pending = source.resolve();
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toEqual({
        state: 'unavailable',
        reason: 'entitlement_mint_unavailable',
      });
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
