import { describe, it, expect } from 'vitest';
import { lookupIngredient, MARKETPLACE_URL } from '../client.js';

const mkFetch = (responses: Array<{ ok?: boolean; status?: number; body?: unknown; throws?: boolean }>) => {
  let i = 0;
  const calls: string[] = [];
  const fetchFn = async (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    const r = responses[i++] ?? { ok: true, body: null };
    if (r.throws) throw new Error('simulated network failure');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: '',
      json: async () => r.body ?? {},
    } as Response;
  };
  return { fetchFn, calls };
};

describe('lookupIngredient', () => {
  it('returns { author } when marketplace returns a published ingredient', async () => {
    const { fetchFn, calls } = mkFetch([{
      body: { data: { author: 'recued-core' }, meta: { request_id: 'x', timestamp: 't' } },
    }]);
    const r = await lookupIngredient('deal-reader-hubspot', fetchFn as never);
    expect(r).toEqual({ author: 'recued-core' });
    expect(calls[0]).toBe(`${MARKETPLACE_URL}/v1/marketplace/ingredients/deal-reader-hubspot`);
  });

  it('url-encodes slug with special chars', async () => {
    const { fetchFn, calls } = mkFetch([{ body: { data: { author: 'a' }, meta: {} } }]);
    await lookupIngredient('foo bar/baz', fetchFn as never);
    expect(calls[0]).toContain('foo%20bar%2Fbaz');
  });

  it('returns null on 404 (not published)', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 404 }]);
    const r = await lookupIngredient('nonexistent', fetchFn as never);
    expect(r).toBeNull();
  });

  it('returns null on other non-ok responses (treats as unreachable)', async () => {
    const { fetchFn } = mkFetch([{ ok: false, status: 503 }]);
    const r = await lookupIngredient('deal-reader-hubspot', fetchFn as never);
    expect(r).toBeNull();
  });

  it('returns null on network error (caller downgrades to local)', async () => {
    const { fetchFn } = mkFetch([{ throws: true }]);
    const r = await lookupIngredient('deal-reader-hubspot', fetchFn as never);
    expect(r).toBeNull();
  });

  it('returns null when response body lacks an author field', async () => {
    const { fetchFn } = mkFetch([{ body: { data: {}, meta: {} } }]);
    const r = await lookupIngredient('deal-reader-hubspot', fetchFn as never);
    expect(r).toBeNull();
  });

  it('returns null when author is empty string', async () => {
    const { fetchFn } = mkFetch([{ body: { data: { author: '' }, meta: {} } }]);
    const r = await lookupIngredient('deal-reader-hubspot', fetchFn as never);
    expect(r).toBeNull();
  });
});
