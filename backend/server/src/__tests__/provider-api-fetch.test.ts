import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionAuth, ConnectionRecord } from '@recued/contracts';
import { ResponseBodyTooLargeError } from '@recued/ingredients';

import { makeBoundedOriginApiFetch } from '../bounded-origin-http-fetcher.js';
import { searchHubSpotObjects } from '../data/hubspot/_hubspot-search.js';
import {
  PROVIDER_API_TIMEOUT_MS,
  PROVIDER_LONG_POLL_TIMEOUT_MS,
} from '../data/provider-api-fetch.js';
import { searchSalesforceObjects } from '../data/salesforce/_salesforce-search.js';

const oauthAuth = (vendor: 'hubspot' | 'salesforce'): ConnectionAuth => ({
  type: 'oauth2_refresh',
  refresh_token: 'refresh-token',
  client_id: 'client-id',
  client_secret: 'client-secret',
  token_endpoint: vendor === 'hubspot'
    ? 'https://api.hubapi.com/oauth/v1/token'
    : 'https://login.salesforce.com/services/oauth2/token',
  current_access_token: 'SECRET-access-token',
  expires_at: Date.now() + 60_000,
});

const hubspotConnection: ConnectionRecord = {
  name: 'hubspot-launch',
  kind: 'api',
  display_name: 'HubSpot launch',
  config: { base_url: 'https://api.hubapi.com', vendor: 'hubspot' },
  auth: oauthAuth('hubspot'),
  enrolled_at: 1,
  updated_at: 1,
};

const salesforceConnection: ConnectionRecord = {
  name: 'salesforce-launch',
  kind: 'api',
  display_name: 'Salesforce launch',
  config: {
    base_url: 'https://launch.my.salesforce.com',
    vendor: 'salesforce',
    sandbox: 'production',
  },
  auth: oauthAuth('salesforce'),
  enrolled_at: 1,
  updated_at: 1,
};

const drain = async (records: AsyncIterable<unknown>): Promise<void> => {
  for await (const _record of records) {
    // Exhaust the provider request.
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bounded provider API fetch', () => {
  it('refuses a cross-origin redirect before replaying bearer credentials', async () => {
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));
    const fetcher = makeBoundedOriginApiFetch({ fetchImpl });

    await expect(fetcher('https://api.provider.example/objects', {
      method: 'POST',
      headers: { authorization: 'Bearer SECRET-access-token' },
      body: '{"cursor":"next"}',
    })).rejects.toThrow(/redirect refused/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('returns replayable bounded text with status and headers intact', async () => {
    const raw = '{"records":[]}';
    const fetcher = makeBoundedOriginApiFetch({
      fetchImpl: async () => new Response(raw, {
        status: 201,
        statusText: 'Created',
        headers: { 'retry-after': '7' },
      }),
    });

    const response = await fetcher('https://api.provider.example/objects');

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.json()).toEqual({ records: [] });
    expect(await response.text()).toBe(raw);
  });

  it('cancels a length-less response when it crosses the byte ceiling', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = makeBoundedOriginApiFetch({
      fetchImpl: async () => new Response(body),
      maxResponseBytes: 4,
    });

    await expect(fetcher('https://api.provider.example/objects'))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('keeps a caller abort active while the response body stalls', async () => {
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const fetcher = makeBoundedOriginApiFetch({
      fetchImpl: async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            bodyStarted();
            const abort = (): void => controller.error(
              observedSignal?.reason ?? new DOMException('aborted', 'AbortError'),
            );
            if (observedSignal?.aborted) abort();
            else observedSignal?.addEventListener('abort', abort, { once: true });
          },
        });
        return new Response(body);
      },
    });
    const caller = new AbortController();

    const pending = fetcher('https://api.provider.example/objects', {
      signal: caller.signal,
    });
    await started;
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('fails closed for request shapes the replayable adapter cannot preserve', async () => {
    const fetcher = makeBoundedOriginApiFetch({
      fetchImpl: async () => new Response('{}'),
    });

    await expect(fetcher(new Request('https://api.provider.example/objects')))
      .rejects.toThrow(/requires a URL input/);
    await expect(fetcher('https://api.provider.example/objects', {
      method: 'POST',
      body: new URLSearchParams({ cursor: 'next' }),
    })).rejects.toThrow(/only string request bodies/);
  });

  it('reserves the long deadline only for Salesforce long polling', () => {
    expect(PROVIDER_API_TIMEOUT_MS).toBe(30_000);
    expect(PROVIDER_LONG_POLL_TIMEOUT_MS).toBeGreaterThan(120_000);
  });
});

describe('CRM production fetch defaults', () => {
  const redirectingGlobalFetch = () => vi.fn(async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => new Response(null, {
    status: 307,
    headers: { location: 'https://collector.invalid/steal' },
  }));

  it('uses the bounded default for HubSpot searches', async () => {
    const fetchSpy = redirectingGlobalFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(drain(searchHubSpotObjects(
      hubspotConnection,
      { objectType: 'contacts', properties: ['email'], modifiedSince: 0, limit: 1 },
      { refreshAuth: async () => oauthAuth('hubspot') },
    ))).rejects.toThrow(/redirect refused/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('uses the bounded default for Salesforce searches', async () => {
    const fetchSpy = redirectingGlobalFetch();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(drain(searchSalesforceObjects(
      salesforceConnection,
      { soql: 'SELECT Id FROM Contact LIMIT 1' },
      { refreshAuth: async () => oauthAuth('salesforce') },
    ))).rejects.toThrow(/redirect refused/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('has no raw global-fetch fallback left in CRM production call sites', () => {
    const files = [
      '../data/hubspot/_hubspot-search.ts',
      '../data/hubspot/contact-merge-client.ts',
      '../data/salesforce/_salesforce-search.ts',
      '../data/salesforce/cometd-subscriber.ts',
      '../data/salesforce/describe-probe.ts',
      '../data/salesforce/merge-client.ts',
      '../data/salesforce/pushtopic-soap.ts',
      '../serve/compose-generic-engagement-reconciliation.ts',
    ];

    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/globalThis\.fetch|fetch\.bind\(globalThis\)/);
    }
  });
});

describe('mail and calendar production fetch defaults', () => {
  it('routes every provider API and enrollment probe through the bounded fetcher', () => {
    const files = [
      { path: '../collections/mail/gmail-provider.ts', fallbacks: 1 },
      { path: '../collections/mail/graph-provider.ts', fallbacks: 1 },
      { path: '../collections/calendar/gcal-provider.ts', fallbacks: 2 },
      { path: '../collections/calendar/graph-provider.ts', fallbacks: 2 },
    ];

    for (const { path, fallbacks } of files) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(
        source.match(/opts\.fetcher\s*\?\?\s*defaultHttpFetcher/g),
        path,
      ).toHaveLength(fallbacks);
      expect(source, path).not.toMatch(/\bawait\s+fetch\s*\(/);
    }
  });
});
