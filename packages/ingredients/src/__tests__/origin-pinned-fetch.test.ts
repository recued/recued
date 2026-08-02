/** SSRF hardening — origin-pinned redirect following.
 *
 *  Pins the redirect-handling contract: same-origin 3xx followed up to
 *  a hop cap; first cross-origin 3xx refused BEFORE the request is
 *  issued; non-redirect + Location-less + unparseable-Location returned
 *  as-is; every hop fetched with `redirect: 'manual'`. */

import { describe, expect, it, vi } from 'vitest';
import {
  CrossOriginRedirectError,
  RedirectLimitError,
  fetchOriginPinned,
} from '../origin-pinned-fetch.js';

interface Call { url: string; redirect: RequestRedirect | undefined; method: string | undefined; body: string | undefined }

/** Build a fetch stub from a responder keyed on the request URL. */
const stub = (
  responder: (url: string) => Response,
): { fetchImpl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      redirect: init?.redirect,
      method: init?.method,
      body: init?.body == null ? undefined : String(init.body),
    });
    return responder(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

const redirectTo = (location: string, status = 302): Response =>
  new Response('', { status, headers: { location } });

describe('fetchOriginPinned', () => {
  const BASE = 'https://api.example.com';

  it('returns a non-redirect response directly (one fetch, redirect:manual)', async () => {
    const { fetchImpl, calls } = stub(() => new Response('{"ok":true}', { status: 200 }));
    const res = await fetchOriginPinned(fetchImpl, `${BASE}/v1/x`, { method: 'GET' }, BASE);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('follows a SAME-origin redirect to the final response', async () => {
    const { fetchImpl, calls } = stub((url) =>
      url.endsWith('/old')
        ? redirectTo(`${BASE}/new`)
        : new Response('{"ok":true}', { status: 200 }),
    );
    const res = await fetchOriginPinned(fetchImpl, `${BASE}/old`, { method: 'GET' }, BASE);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/old`, `${BASE}/new`]);
  });

  it('releases the intermediate response before following a redirect', async () => {
    const cancel = vi.fn();
    const { fetchImpl } = stub((url) =>
      url.endsWith('/old')
        ? new Response(new ReadableStream<Uint8Array>({ cancel }), {
            status: 302,
            headers: { location: `${BASE}/new` },
          })
        : new Response('{"ok":true}', { status: 200 }),
    );

    await fetchOriginPinned(fetchImpl, `${BASE}/old`, { method: 'GET' }, BASE);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a CROSS-origin redirect before issuing the cross-origin request', async () => {
    const { fetchImpl, calls } = stub(() =>
      redirectTo('http://169.254.169.254/latest/meta-data/'),
    );
    await expect(
      fetchOriginPinned(fetchImpl, `${BASE}/v1/x`, { method: 'GET' }, BASE),
    ).rejects.toBeInstanceOf(CrossOriginRedirectError);
    // Only the initial (same-origin) request was made — the metadata host
    // was never contacted.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/x`);
  });

  it('releases a refused cross-origin redirect response', async () => {
    const cancel = vi.fn();
    const { fetchImpl } = stub(() =>
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 307,
        headers: { location: 'https://evil.example/x' },
      }),
    );

    await expect(fetchOriginPinned(
      fetchImpl,
      `${BASE}/v1/x`,
      { method: 'POST', body: 'secret' },
      BASE,
    )).rejects.toBeInstanceOf(CrossOriginRedirectError);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a protocol-relative cross-origin redirect (//evil.example.com)', async () => {
    const { fetchImpl } = stub(() => redirectTo('//evil.example.com/x'));
    await expect(
      fetchOriginPinned(fetchImpl, `${BASE}/v1/x`, { method: 'GET' }, BASE),
    ).rejects.toBeInstanceOf(CrossOriginRedirectError);
  });

  it('returns a 3xx WITHOUT a Location header as-is (caller classifies it)', async () => {
    const { fetchImpl, calls } = stub(() => new Response('', { status: 302 }));
    const res = await fetchOriginPinned(fetchImpl, `${BASE}/v1/x`, { method: 'GET' }, BASE);
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
  });

  it('returns a 3xx with an unparseable Location as-is (does not follow / throw)', async () => {
    const { fetchImpl } = stub(() => redirectTo('http://[::bad'));
    const res = await fetchOriginPinned(fetchImpl, `${BASE}/v1/x`, { method: 'GET' }, BASE);
    expect(res.status).toBe(302);
  });

  it('refuses a same-origin redirect LOOP past the hop cap (RedirectLimitError, not cross-origin)', async () => {
    // Always redirect same-origin to a fresh path — never resolves.
    let n = 0;
    const { fetchImpl, calls } = stub(() => redirectTo(`${BASE}/hop${n++}`));
    await expect(
      fetchOriginPinned(fetchImpl, `${BASE}/start`, { method: 'GET' }, BASE),
    ).rejects.toBeInstanceOf(RedirectLimitError);
    // Bounded — does not fetch unboundedly.
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it('normalizes a same-origin 303 to a GET with no body on the next hop', async () => {
    const { fetchImpl, calls } = stub((url) =>
      url.endsWith('/submit')
        ? redirectTo(`${BASE}/result`, 303)
        : new Response('{"ok":true}', { status: 200 }),
    );
    const res = await fetchOriginPinned(
      fetchImpl,
      `${BASE}/submit`,
      { method: 'POST', body: '{"a":1}' },
      BASE,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // First hop carries the POST body; the 303 follow-up is a bodyless GET.
    expect(calls[0]!.method).toBe('POST');
    expect(calls[1]!.method).toBe('GET');
    expect(calls[1]!.body).toBeUndefined();
  });
});
