import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeMCP } from '../mcp.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import type { IngredientManifest } from '@recued/contracts';

const toResolved = (manifest: IngredientManifest, input: Record<string, unknown>): ResolvedCall => ({
  slug: manifest.slug,
  risk_tier: manifest.risk_tier,
  input,
  output: manifest.output ?? {},
  fallback: manifest.fallback,
});

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const manifest: IngredientManifest = {
  slug: 'search-exa-mcp',
  name: 'Exa Search (MCP)',
  description: 'Web search via Exa MCP server',
  author: 'recued-core',
  kind: 'mcp',
  category: 'data',
  risk_tier: 'read',
  input: {
    'mcp.server_url': 'https://mcp.exa.ai/mcp',
    'mcp.tool': 'web_search_exa',
    'mcp.arguments': null,
  },
  output: {
    'content.0.text': 'results_text',
    'isError': 'is_error',
  },
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  json: async () => body,
} as Response);

describe('executeMCP', () => {
  it('sends a JSON-RPC tools/call request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ text: 'search results here' }], isError: false },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
      'mcp.arguments': { query: 'recued' },
    }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mcp.exa.ai/mcp');
    expect(options.method).toBe('POST');
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    });
    const body = JSON.parse(options.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'web_search_exa', arguments: { query: 'recued' } });
    expect(typeof body.id).toBe('number');
  });

  it('maps result paths to output field names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ text: 'first result' }], isError: false },
    }));

    const result = await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
      'mcp.arguments': { query: 'x' },
    })) as Record<string, unknown>;

    expect(result.results_text).toBe('first result');
    expect(result.is_error).toBe(false);
  });

  it('drops prototype-sensitive output field names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: {
        id: 'safe',
        payload: { polluted: true },
        shadow: 'bad',
      },
    }));

    const customManifest: IngredientManifest = {
      ...manifest,
      output: {
        'id': 'safe_id',
        'payload': '__proto__',
        'shadow': 'constructor',
      },
    };

    const result = await executeMCP(toResolved(customManifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
    })) as Record<string, unknown>;

    expect(result.safe_id).toBe('safe');
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });

  it('uses empty arguments when mcp.arguments is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [{ text: 'x' }] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.params.arguments).toEqual({});
  });

  it('throws INGREDIENT_NOT_FOUND when server_url missing', async () => {
    await expect(
      executeMCP(toResolved(manifest, { 'mcp.tool': 'web_search_exa' })),
    ).rejects.toThrow(IngredientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws INGREDIENT_NOT_FOUND when tool missing', async () => {
    await expect(
      executeMCP(toResolved(manifest, { 'mcp.server_url': 'https://x.com' })),
    ).rejects.toThrow(IngredientError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws NETWORK_ERROR on HTTP non-200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));

    await expect(
      executeMCP(toResolved(manifest, {
        'mcp.server_url': 'https://x.com',
        'mcp.tool': 'tool',
      })),
    ).rejects.toThrow(/500/);
  });

  it('throws NETWORK_ERROR on JSON-RPC error response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Invalid params' },
    }));

    await expect(
      executeMCP(toResolved(manifest, {
        'mcp.server_url': 'https://x.com',
        'mcp.tool': 'tool',
      })),
    ).rejects.toThrow(/Invalid params/);
  });

  it('throws NETWORK_ERROR on non-JSON-RPC response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ random: 'response' }));

    await expect(
      executeMCP(toResolved(manifest, {
        'mcp.server_url': 'https://x.com',
        'mcp.tool': 'tool',
      })),
    ).rejects.toThrow(/non-JSON-RPC/);
  });

  it('throws NETWORK_ERROR on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      executeMCP(toResolved(manifest, {
        'mcp.server_url': 'https://x.com',
        'mcp.tool': 'tool',
      })),
    ).rejects.toThrow(/connection refused/);
  });

  it('throws STEP_TIMEOUT when timeout is exceeded', async () => {
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(
      executeMCP(toResolved(manifest, {
        'mcp.server_url': 'https://x.com',
        'mcp.tool': 'tool',
        'mcp.timeout_ms': 50,
      })),
    ).rejects.toThrow(/timed out/);
  });

  it('handles array index in output paths', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { items: ['a', 'b', 'c'] },
    }));

    const customManifest: IngredientManifest = {
      ...manifest,
      output: { 'items.1': 'second' },
    };

    const result = await executeMCP(toResolved(customManifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
    })) as Record<string, unknown>;

    expect(result.second).toBe('b');
  });

  it('returns undefined for missing output paths (no crash)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [{ text: 'x' }] },
    }));

    const customManifest: IngredientManifest = {
      ...manifest,
      output: { 'nonexistent.deeply.nested': 'missing' },
    };

    const result = await executeMCP(toResolved(customManifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
    })) as Record<string, unknown>;

    expect(result.missing).toBeUndefined();
  });

  it('sends header.* input keys as request headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
      'header.x-api-key': 'secret-token',
      'header.x-custom': 'value',
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('secret-token');
    expect(headers['x-custom']).toBe('value');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('drops prototype-sensitive header names', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
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

  it('skips null header values (optional credentials)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
      'header.x-api-key': null,
      'header.x-other': 'kept',
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-other']).toBe('kept');
  });

  it('skips undefined header values', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
      'header.x-api-key': undefined,
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('coerces non-string header values to string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
      'header.x-version': 42,
    }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-version']).toBe('42');
  });

  it('increments request IDs across calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      jsonrpc: '2.0', id: 1, result: { content: [] },
    }));

    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
    }));
    await executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://x.com',
      'mcp.tool': 'tool',
    }));

    const id1 = JSON.parse(fetchMock.mock.calls[0][1].body).id;
    const id2 = JSON.parse(fetchMock.mock.calls[1][1].body).id;
    expect(id2).toBeGreaterThan(id1);
  });
});

describe('executeMCP — write delivery uncertainty', () => {
  const writeManifest: IngredientManifest = {
    ...manifest,
    slug: 'sheet-write-mcp',
    name: 'Sheet Writer (MCP)',
    description: 'Writes a row to a Google Sheet via MCP',
    category: 'action',
    risk_tier: 'write',
    input: {
      'mcp.server_url': 'https://mcp.example.com/mcp',
      'mcp.tool': 'append_row',
      'mcp.arguments': null,
    },
    output: { 'content.0.text': 'result' },
  };

  it('write-tier timeout → ACTION_DELIVERY_UNCERTAIN', async () => {
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
      await executeMCP(toResolved(writeManifest, {
        'mcp.server_url': 'https://mcp.example.com/mcp',
        'mcp.tool': 'append_row',
        'mcp.arguments': { row: ['a', 'b'] },
        'mcp.timeout_ms': 50,
      }));
      expect.fail('should throw');
    } catch (e) {
      expect((e as IngredientError).code).toBe('ACTION_DELIVERY_UNCERTAIN');
      expect((e as IngredientError).message).toContain('outcome cannot be confirmed');
    }
  });

  it('write-tier network error → ACTION_DELIVERY_UNCERTAIN', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(executeMCP(toResolved(writeManifest, {
      'mcp.server_url': 'https://mcp.example.com/mcp',
      'mcp.tool': 'append_row',
      'mcp.arguments': {},
    }))).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('write-tier 500 response → ACTION_DELIVERY_UNCERTAIN', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => ({}),
    } as Response);
    await expect(executeMCP(toResolved(writeManifest, {
      'mcp.server_url': 'https://mcp.example.com/mcp',
      'mcp.tool': 'append_row',
      'mcp.arguments': {},
    }))).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('write-tier 400 response → clean NETWORK_ERROR (server rejected pre-commit)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({}),
    } as Response);
    await expect(executeMCP(toResolved(writeManifest, {
      'mcp.server_url': 'https://mcp.example.com/mcp',
      'mcp.tool': 'append_row',
      'mcp.arguments': {},
    }))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('write-tier JSON-RPC level error in 2xx envelope → clean NETWORK_ERROR', async () => {
    // 200 OK + {error: {...}} means the server received and processed the
    // request — the tool's own error is clean-error territory, not
    // delivery uncertainty. The provider responded, we just don't like
    // what it said.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'invalid row format' },
    }));
    await expect(executeMCP(toResolved(writeManifest, {
      'mcp.server_url': 'https://mcp.example.com/mcp',
      'mcp.tool': 'append_row',
      'mcp.arguments': { invalid: true },
    }))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('read-tier timeout keeps STEP_TIMEOUT classification', async () => {
    fetchMock.mockImplementation((_url, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    await expect(executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
      'mcp.arguments': { q: 'hi' },
      'mcp.timeout_ms': 50,
    }))).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('read-tier 500 keeps NETWORK_ERROR classification', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => ({}),
    } as Response);
    await expect(executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
      'mcp.arguments': { q: 'hi' },
    }))).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('executeMCP — SSRF redirect origin pinning', () => {
  it('refuses a cross-origin redirect with URL_REF_INVALID, never contacting the target', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    await expect(executeMCP(toResolved(manifest, {
      'mcp.server_url': 'https://mcp.exa.ai/mcp',
      'mcp.tool': 'web_search_exa',
    }))).rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('executeMCP — malformed server_url validation', () => {
  it('fails a malformed server_url as URL_REF_INVALID, never dispatching', async () => {
    await expect(executeMCP(toResolved(manifest, {
      'mcp.server_url': 'not-a-valid-url',
      'mcp.tool': 'web_search_exa',
    }))).rejects.toMatchObject({ code: 'URL_REF_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
