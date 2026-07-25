/** D-115 Phase 6 — http-watcher handler tests. Moved from
 *  backend/server/src/watchers/__tests__/ in Phase 6D. */

import { describe, it, expect, vi } from 'vitest';

import { IngredientError } from '../../types.js';
import { evaluateHttpWatcher } from '../http.js';

const mkRes = (init: {
  status: number;
  body?: string;
  etag?: string | null;
}): Response => {
  const headers = new Headers();
  if (init.etag !== undefined && init.etag !== null) {
    headers.set('etag', init.etag);
  }
  // Null-body statuses (101 / 204 / 205 / 304) reject a non-null body
  // per the Fetch spec. Use `null` explicitly for 304; empty-string is
  // a body, not null.
  const nullBodyStatus = init.status === 101 || init.status === 204 ||
    init.status === 205 || init.status === 304;
  const body = nullBodyStatus ? null : (init.body ?? '');
  return new Response(body, { status: init.status, headers });
};

describe('evaluateHttpWatcher — first tick', () => {
  it('fires on 200 with ETag when no cursor', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body: 'hello', etag: '"v1"' }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(true);
    expect(r.status).toBe(200);
    expect(r.etag).toBe('"v1"');
    expect(r.hash).toHaveLength(64);
    expect(r.body).toBe('hello');
  });
  it('fires on 200 with no ETag when no cursor', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body: 'body', etag: null }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(true);
    expect(r.etag).toBeNull();
    expect(r.hash).toHaveLength(64);
  });
});

describe('evaluateHttpWatcher — ETag comparison', () => {
  it('does not fire when ETag unchanged', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body: 'hello', etag: '"v1"' }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_etag: '"v1"' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.etag).toBe('"v1"');
  });
  it('fires when ETag changed', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body: 'new', etag: '"v2"' }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_etag: '"v1"' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(true);
    expect(r.etag).toBe('"v2"');
  });
  it('sends If-None-Match when previous_etag set', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        mkRes({ status: 200, body: 'x', etag: '"v2"' }),
    );
    await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_etag: '"v1"' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const opts = fetchFn.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('"v1"');
  });
  it('does not send If-None-Match when previous_etag absent', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) => mkRes({ status: 200, body: 'x' }),
    );
    await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const opts = fetchFn.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
  });
});

describe('evaluateHttpWatcher — 304 Not Modified', () => {
  it('does not fire; preserves caller cursor', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 304 }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_etag: '"v1"', previous_hash: 'h1' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(304);
    expect(r.etag).toBe('"v1"');
    expect(r.hash).toBe('h1');
    expect(r.body).toBe('');
  });
});

describe('evaluateHttpWatcher — hash fallback', () => {
  it('fires when origin drops ETag but body hash differs', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body: 'new', etag: null }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_hash: 'stale' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(true);
    expect(r.etag).toBeNull();
    expect(r.hash).toHaveLength(64);
  });
  it('does not fire when body hash matches previous', async () => {
    const body = 'stable';
    // Compute expected hash.
    const firstFetch = vi.fn(async () => mkRes({ status: 200, body, etag: null }));
    const first = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: firstFetch as unknown as typeof fetch },
    );
    const fetchFn = vi.fn(async () => mkRes({ status: 200, body, etag: null }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com', previous_hash: first.hash ?? undefined },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
  });
});

describe('evaluateHttpWatcher — error handling (non-fatal)', () => {
  it('returns no-fire on non-2xx', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 500, body: 'err' }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(500);
    expect(r.etag).toBeNull();
    expect(r.hash).toBeNull();
  });
  it('returns no-fire on 404', async () => {
    const fetchFn = vi.fn(async () => mkRes({ status: 404 }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(404);
  });
  it('returns no-fire status=0 on network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(0);
  });
  it('returns no-fire status=0 on timeout', async () => {
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com' },
      { fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 5 },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe('evaluateHttpWatcher — input validation', () => {
  it('rejects missing target_url', async () => {
    await expect(
      evaluateHttpWatcher({ target_url: '' }),
    ).rejects.toThrow(IngredientError);
  });
  it('rejects invalid URL shape', async () => {
    await expect(
      evaluateHttpWatcher({ target_url: 'not a url' }),
    ).rejects.toThrow(/must be a valid URL/);
  });
  it('rejects non-http(s) protocol', async () => {
    await expect(
      evaluateHttpWatcher({ target_url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/http\(s\)/);
  });
  it('rejects non-string previous_etag', async () => {
    await expect(
      evaluateHttpWatcher({
        target_url: 'https://example.com',
        previous_etag: 123 as unknown as string,
      }),
    ).rejects.toThrow(IngredientError);
  });
});

describe('evaluateHttpWatcher — SSRF redirect origin pinning', () => {
  it('treats a cross-origin redirect as a non-fatal no-fire (fail-safe, no circuit-breaker trip)', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );
    const r = await evaluateHttpWatcher(
      { target_url: 'https://example.com/feed' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.should_run).toBe(false);
    expect(r.status).toBe(0);
  });
});
