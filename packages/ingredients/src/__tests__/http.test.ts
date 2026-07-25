import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeHTTP } from '../http.js';
import { IngredientError } from '../types.js';
import type { ResolvedCall } from '../types.js';
import type { IngredientManifest } from '@recued/contracts';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const baseManifest: IngredientManifest = {
  slug: 'deal-reader-hubspot',
  name: 'HubSpot Deal Reader',
  description: 'Reads a deal from HubSpot',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: {
    method: 'GET',
    url: 'https://api.hubapi.com/crm/v3/objects/deals/{deal_id}',
  },
  output: {
    'id': 'deal_id',
    'properties.dealname': 'deal_name',
    'properties.amount': 'amount',
  },
};

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : `Error ${status}`,
  headers: {
    get: (name: string) => headers[name.toLowerCase()] ?? 'application/json',
  },
  json: async () => body,
  text: async () => JSON.stringify(body),
} as unknown as Response);

const textResponse = (text: string, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'OK',
  headers: { get: () => 'text/plain' },
  text: async () => text,
  json: async () => { throw new Error('not json'); },
} as unknown as Response);

const toResolved = (manifest: IngredientManifest, input: Record<string, unknown>): ResolvedCall => ({
  slug: manifest.slug,
  risk_tier: manifest.risk_tier,
  input,
  output: manifest.output ?? {},
  fallback: manifest.fallback,
});

describe('executeHTTP — basics', () => {
  it('makes a GET request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '42', properties: { dealname: 'Acme' } }));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/42',
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/deals/42');
    expect(options.method).toBe('GET');
  });

  it('defaults to GET when method missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      url: 'https://api.hubapi.com/crm/v3/objects/deals/42',
    }));

    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });

  it('uppercases method', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'post',
      url: 'https://x.com',
      body: { x: 1 },
    }));

    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('throws when url missing', async () => {
    await expect(executeHTTP(toResolved(baseManifest, { method: 'GET' }))).rejects.toThrow(IngredientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('executeHTTP — path parameters', () => {
  it('substitutes {placeholder} from input fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/{deal_id}',
      deal_id: '12345',
    }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/crm/v3/objects/deals/12345');
  });

  it('url-encodes path parameter values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/search/{query}',
      query: 'hello world & friends',
    }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/search/hello%20world%20%26%20friends');
  });

  it('substitutes multiple placeholders', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/{object_type}/{object_id}',
      object_type: 'deals',
      object_id: '42',
    }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/crm/v3/objects/deals/42');
  });

  it('leaves placeholder unchanged when input field missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/{missing}/path',
    }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/{missing}/path');
  });
});

describe('executeHTTP — query parameters', () => {
  it('appends query.* keys to URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals',
      'query.limit': '100',
      'query.properties': 'dealname,amount',
    }));

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('limit=100');
    expect(url).toContain('properties=dealname%2Camount');
  });

  it('uses & separator if URL already has query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/search?type=deal',
      'query.q': 'acme',
    }));

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/search?type=deal&q=acme');
  });

  it('skips null and undefined query values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/x',
      'query.included': 'yes',
      'query.skipped': null,
      'query.also_skipped': undefined,
    }));

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('included=yes');
    expect(url).not.toContain('skipped');
  });
});

describe('executeHTTP — headers', () => {
  it('extracts header.* keys as request headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
      'header.authorization': 'Bearer token',
      'header.x-custom': 'value',
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['authorization']).toBe('Bearer token');
    expect(headers['x-custom']).toBe('value');
  });

  it('skips null/undefined header values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
      'header.x-required': 'present',
      'header.x-optional': null,
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-required']).toBe('present');
    expect(headers['x-optional']).toBeUndefined();
  });

  it('coerces non-string header values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
      'header.x-version': 42,
    }));

    expect(fetchMock.mock.calls[0][1].headers['x-version']).toBe('42');
  });

  it('drops prototype-sensitive header names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
      'header.x-safe': 'kept',
      'header.__proto__': 'drop-proto',
      'header.constructor': 'drop-constructor',
      'header.prototype': 'drop-prototype',
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-safe']).toBe('kept');
    expect(Object.prototype.hasOwnProperty.call(headers, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(headers, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(headers, 'prototype')).toBe(false);
  });
});

describe('executeHTTP — body', () => {
  it('sends string body as-is', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'POST',
      url: 'https://x.com',
      body: 'raw text',
    }));

    expect(fetchMock.mock.calls[0][1].body).toBe('raw text');
  });

  it('serializes object body as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'POST',
      url: 'https://x.com',
      body: { name: 'Acme', amount: 50000 },
    }));

    expect(fetchMock.mock.calls[0][1].body).toBe('{"name":"Acme","amount":50000}');
  });

  it('auto-adds Content-Type for object body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'POST',
      url: 'https://x.com',
      body: { x: 1 },
    }));

    expect(fetchMock.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  });

  it('preserves existing Content-Type if set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'POST',
      url: 'https://x.com',
      'header.content-type': 'application/x-www-form-urlencoded',
      body: 'a=1&b=2',
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('omits body when null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await executeHTTP(toResolved(baseManifest, {
      method: 'POST',
      url: 'https://x.com',
      body: null,
    }));

    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });
});

describe('executeHTTP — output mapping', () => {
  it('maps response paths to field names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      id: '42',
      properties: { dealname: 'Acme', amount: '50000' },
    }));

    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/42',
    })) as Record<string, unknown>;

    expect(result.deal_id).toBe('42');
    expect(result.deal_name).toBe('Acme');
    expect(result.amount).toBe('50000');
  });

  it('drops prototype-sensitive output field names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      id: '42',
      payload: { polluted: true },
      shadow: 'bad',
    }));

    const customManifest: IngredientManifest = {
      ...baseManifest,
      output: {
        'id': 'safe_id',
        'payload': '__proto__',
        'shadow': 'constructor',
      },
      fallback: {
        'shadow': 'prototype',
      },
    };

    const result = await executeHTTP(toResolved(customManifest, {
      method: 'GET',
      url: 'https://x.com',
    })) as Record<string, unknown>;

    expect(result.safe_id).toBe('42');
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
  });

  it('uses fallback path when primary returns undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      id: '42',
      // No properties.dealname (newer API shape)
      dealname: 'Acme Direct',
    }));

    const manifestWithFallback: IngredientManifest = {
      ...baseManifest,
      output: { 'properties.dealname': 'deal_name' },
      fallback: { 'dealname': 'deal_name' },
    };

    const result = await executeHTTP(toResolved(manifestWithFallback, {
      method: 'GET',
      url: 'https://x.com',
    })) as Record<string, unknown>;

    expect(result.deal_name).toBe('Acme Direct');
  });

  it('returns undefined for missing paths (no crash)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: '42' }));

    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
    })) as Record<string, unknown>;

    expect(result.deal_id).toBe('42');
    expect(result.deal_name).toBeUndefined();
    expect(result.amount).toBeUndefined();
  });

  it('handles array index in output paths', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      results: [{ id: '1' }, { id: '2' }],
    }));

    const customManifest: IngredientManifest = {
      ...baseManifest,
      output: { 'results.0.id': 'first_id' },
    };

    const result = await executeHTTP(toResolved(customManifest, {
      method: 'GET',
      url: 'https://x.com',
    })) as Record<string, unknown>;

    expect(result.first_id).toBe('1');
  });

  it('returns text body when response is not JSON', async () => {
    fetchMock.mockResolvedValue(textResponse('plain text response'));

    const customManifest: IngredientManifest = { ...baseManifest, output: {} };

    const result = await executeHTTP(toResolved(customManifest, {
      method: 'GET',
      url: 'https://x.com',
    }));

    expect(result).toEqual({});
  });
});

describe('executeHTTP — error handling', () => {
  it('classifies 401 as OAUTH_EXPIRED', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));

    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET', url: 'https://x.com',
    }))).rejects.toThrow(/401/);
  });

  it('classifies 403 as OAUTH_EXPIRED', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 403));

    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET', url: 'https://x.com',
    }))).rejects.toThrow(/403/);
  });

  it('classifies 404 as API_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));

    try {
      await executeHTTP(toResolved(baseManifest, { method: 'GET', url: 'https://x.com' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('API_NOT_FOUND');
    }
  });

  it('classifies 429 as API_RATE_LIMITED', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429));

    try {
      await executeHTTP(toResolved(baseManifest, { method: 'GET', url: 'https://x.com' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('API_RATE_LIMITED');
    }
  });

  it('classifies 500 as NETWORK_ERROR', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    try {
      await executeHTTP(toResolved(baseManifest, { method: 'GET', url: 'https://x.com' }));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('NETWORK_ERROR');
    }
  });

  it('throws on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET', url: 'https://x.com',
    }))).rejects.toThrow(/connection refused/);
  });

  it('throws STEP_TIMEOUT on abort', async () => {
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://x.com',
      timeout_ms: 50,
    }))).rejects.toThrow(/timed out/);
  });
});

describe('executeHTTP — HubSpot-realistic example', () => {
  it('reads a deal end-to-end', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      id: '12345',
      properties: {
        dealname: 'Acme Corp Renewal',
        amount: '150000',
        dealstage: 'closedwon',
        closedate: '2026-04-01',
      },
      createdAt: '2026-01-15T00:00:00Z',
    }));

    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/{deal_id}',
      'header.authorization': 'Bearer pat-na2-secret',
      'header.content-type': 'application/json',
      'query.properties': 'dealname,amount,dealstage,closedate',
      deal_id: '12345',
    })) as Record<string, unknown>;

    expect(result).toEqual({
      deal_id: '12345',
      deal_name: 'Acme Corp Renewal',
      amount: '150000',
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/deals/12345?properties=dealname%2Camount%2Cdealstage%2Cclosedate');
    expect(options.method).toBe('GET');
    expect(options.headers['authorization']).toBe('Bearer pat-na2-secret');
  });
});

describe('executeHTTP — timeout covers body read (regression)', () => {
  it('aborts a slow-streaming body, not just the headers', async () => {
    // The old implementation cleared the timer after fetch() returned the
    // Response but BEFORE response.json()/text() was consumed. A server that
    // streamed headers instantly and then stalled on the body would hang
    // forever. Regression test: prove the abort now propagates to the body
    // stream because the entire call is covered by one timer scope.
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      // Return a Response-like whose .json() never resolves until the
      // signal fires an abort.
      const response = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              const err = new Error('body aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      } as unknown as Response;
      return Promise.resolve(response);
    });

    const start = Date.now();
    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://slow-body.example.com/data',
      timeout_ms: 150,
    }))).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    // Should abort quickly — not hang for the default 30s
    expect(elapsed).toBeLessThan(1500);
  });

  it('succeeds when body reads within the timer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '42', properties: { dealname: 'Q', amount: '1' } }));
    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://ok.example.com',
      timeout_ms: 1000,
    }));
    expect((result as { deal_id: string }).deal_id).toBe('42');
  });
});

describe('executeHTTP — write delivery uncertainty (risk_tier-aware)', () => {
  const writeManifest: IngredientManifest = {
    ...baseManifest,
    slug: 'deal-updater-hubspot',
    name: 'Deal Updater',
    description: 'Updates a deal record in HubSpot',
    category: 'action',
    risk_tier: 'write',
  };

  const adminManifest: IngredientManifest = {
    ...baseManifest,
    slug: 'contact-merger-hubspot',
    name: 'Contact Merger',
    description: 'Merges two contacts',
    category: 'action',
    risk_tier: 'admin',
  };

  const destructiveManifest: IngredientManifest = {
    ...baseManifest,
    slug: 'deal-deleter-hubspot',
    name: 'Deal Deleter',
    description: 'Deletes a deal permanently',
    category: 'action',
    risk_tier: 'destructive',
  };

  it('write-tier timeout → ACTION_DELIVERY_UNCERTAIN (not STEP_TIMEOUT)', async () => {
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    try {
      await executeHTTP(toResolved(writeManifest, {
        method: 'PATCH', url: 'https://api.hubapi.com/crm/v3/objects/deals/123',
        timeout_ms: 50,
      }));
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(IngredientError);
      expect((e as IngredientError).code).toBe('ACTION_DELIVERY_UNCERTAIN');
      expect((e as IngredientError).message).toContain('outcome cannot be confirmed');
      expect((e as IngredientError).message).toContain('verify state');
    }
  });

  it('write-tier network error → ACTION_DELIVERY_UNCERTAIN', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    try {
      await executeHTTP(toResolved(writeManifest, {
        method: 'PATCH', url: 'https://api.hubapi.com/deals/1',
      }));
      expect.fail('should throw');
    } catch (e) {
      expect((e as IngredientError).code).toBe('ACTION_DELIVERY_UNCERTAIN');
      expect((e as IngredientError).details).toMatchObject({ cause: 'network' });
    }
  });

  it('write-tier 500 response → ACTION_DELIVERY_UNCERTAIN (not NETWORK_ERROR)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'db crash' }),
    } as unknown as Response);
    try {
      await executeHTTP(toResolved(writeManifest, {
        method: 'PATCH', url: 'https://api.hubapi.com/deals/1',
      }));
      expect.fail('should throw');
    } catch (e) {
      expect((e as IngredientError).code).toBe('ACTION_DELIVERY_UNCERTAIN');
      expect((e as IngredientError).details).toMatchObject({ status: 500 });
    }
  });

  it('write-tier 503 response → ACTION_DELIVERY_UNCERTAIN', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    } as unknown as Response);
    await expect(executeHTTP(toResolved(writeManifest, {
      method: 'POST', url: 'https://api.hubapi.com/deals',
    }))).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('write-tier 400 response → clean NETWORK_ERROR (client-side rejection)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'invalid field' }),
    } as unknown as Response);
    try {
      await executeHTTP(toResolved(writeManifest, {
        method: 'PATCH', url: 'https://api.hubapi.com/deals/1',
      }));
      expect.fail('should throw');
    } catch (e) {
      expect((e as IngredientError).code).toBe('NETWORK_ERROR');
      // 400 = server rejected before any state change, not ambiguous
    }
  });

  it('write-tier 401/403 → OAUTH_EXPIRED (still clean — known rejection)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    } as unknown as Response);
    await expect(executeHTTP(toResolved(writeManifest, {
      method: 'PATCH', url: 'https://api.hubapi.com/deals/1',
    }))).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
  });

  it('write-tier 404 → API_NOT_FOUND (still clean — known rejection)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    } as unknown as Response);
    await expect(executeHTTP(toResolved(writeManifest, {
      method: 'PATCH', url: 'https://api.hubapi.com/deals/999',
    }))).rejects.toMatchObject({ code: 'API_NOT_FOUND' });
  });

  it('admin-tier gets same uncertainty treatment', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(executeHTTP(toResolved(adminManifest, {
      method: 'POST', url: 'https://api.hubapi.com/contacts/merge',
    }))).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('destructive-tier gets same uncertainty treatment', async () => {
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    await expect(executeHTTP(toResolved(destructiveManifest, {
      method: 'DELETE', url: 'https://api.hubapi.com/deals/123',
      timeout_ms: 50,
    }))).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('read-tier timeout → STEP_TIMEOUT (not ACTION_DELIVERY_UNCERTAIN)', async () => {
    // baseManifest has risk_tier: 'read'. Reads stay clean.
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET', url: 'https://api.hubapi.com/deals/1',
      timeout_ms: 50,
    }))).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('read-tier 500 → NETWORK_ERROR (not ACTION_DELIVERY_UNCERTAIN)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500, statusText: 'Internal Server Error',
      headers: { get: () => 'application/json' },
      json: async () => ({}),
    } as unknown as Response);
    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET', url: 'https://api.hubapi.com/deals/1',
    }))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('executeHTTP — timeout resolution', () => {
  it('uses default when timeout_ms is undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', properties: {} }));
    await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://ok.example.com',
    }));
    // No specific assertion — just proving the call succeeds with no timeout set
    expect(fetchMock).toHaveBeenCalled();
  });

  it('clamps non-numeric timeout_ms to default (no throw)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', properties: {} }));
    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://ok.example.com',
      timeout_ms: 'forever' as unknown as number,
    }));
    expect(result).toBeTruthy();
  });

  it('clamps NaN to default (no hang)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', properties: {} }));
    const result = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://ok.example.com',
      timeout_ms: NaN,
    }));
    expect(result).toBeTruthy();
  });

  it('clamps negative values to the minimum', async () => {
    // Any finite abort within MIN_TIMEOUT_MS (100ms) counts. Use a stalling
    // fetch so the min floor has something to abort against.
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const start = Date.now();
    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://slow.example.com',
      timeout_ms: -100,
    }))).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - start;
    // -100 → MIN (100), so it should abort in well under 500ms
    expect(elapsed).toBeLessThan(500);
  });
});

describe('executeHTTP — SSRF redirect origin pinning', () => {
  it('refuses a cross-origin redirect (→ metadata host) with URL_REF_INVALID, never contacting it', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    await expect(executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/1',
    }))).rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // metadata host never contacted
  });

  it('fails a write-tier call with a malformed URL as URL_REF_INVALID, never dispatching (no false delivery-uncertain)', async () => {
    const writeManifest = { ...baseManifest, risk_tier: 'write' as const };
    await expect(executeHTTP(toResolved(writeManifest, { method: 'POST', url: 'not-an-absolute-url' })))
      .rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a same-origin redirect and returns the mapped body', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: 'https://api.hubapi.com/v3/redirected' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '99', properties: { dealname: 'Acme' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const r = await executeHTTP(toResolved(baseManifest, {
      method: 'GET',
      url: 'https://api.hubapi.com/crm/v3/objects/deals/1',
    })) as Record<string, unknown>;
    expect(r.deal_id).toBe('99');
    expect(r.deal_name).toBe('Acme');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
