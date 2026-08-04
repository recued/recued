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
import { provisionHandleFromBinding } from '../pro-convenience/handle-provisioner.js';

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

  // A self-hosted server with NO recued.com account must not talk to the auth
  // Worker at all. Every other assertion here is about a request failing
  // CLOSED; this one is about the request never being MADE — an unbound server
  // that contacts `auth.recued.com` announces its existence to the cloud for
  // an account that does not exist. Both entry points read the stored binding
  // FIRST, including from the boot-time provisioning tick that re-runs every
  // five minutes for the life of the process.
  it('never calls the auth Worker while the server holds no account binding', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const source = createHttpProEntitlementSource({
      loadBinding: () => null,
      getEndpointUrl: () => 'https://auth.recued.com/v1/account/entitlement/mint',
      getPublicKeyB64: () => 'configured-key',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    await expect(source.resolve()).resolves.toEqual({ state: 'unbound' });
    await expect(source.resolveClaim()).resolves.toBeNull();

    const unreachable = () => {
      throw new Error('unbound server must not reach the handle state machine');
    };
    const outcome = await provisionHandleFromBinding({
      serverFingerprint: () => 'sha256:server',
      loadBinding: () => null,
      entitlement: source,
      handle: {
        current: unreachable,
        reserveInitial: unreachable,
        changeHandle: unreachable,
        reReserve: unreachable,
      },
    });

    expect(outcome).toEqual({ outcome: 'skipped', reason: 'unbound' });
    expect(fetchSpy).not.toHaveBeenCalled();

    // Known positive on the SAME spy: a zero above must mean "the binding gate
    // held", not "this composition never reaches fetch at all".
    await createHttpProEntitlementSource({
      loadBinding: () => storedBinding,
      getEndpointUrl: () => 'https://auth.recued.com/v1/account/entitlement/mint',
      getPublicKeyB64: () => 'configured-key',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    }).resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
