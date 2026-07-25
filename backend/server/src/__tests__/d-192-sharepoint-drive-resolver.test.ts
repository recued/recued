/** D-192 CORE #5e — SharePoint site→drive resolver, tested in ISOLATION.
 *
 *  Pins the URL parsing (Graph site-addressing pieces) + the classified failure
 *  modes the enroll dialog surfaces. The Graph call is driven through an injected
 *  `typeof fetch` stub — no network. The enroll wiring (token refresh + persist)
 *  is covered in `d-192-sharepoint-enroll-resolve.test.ts`. */

import { describe, expect, it } from 'vitest';

import {
  parseSharePointSiteUrl,
  resolveSharePointDriveId,
} from '../sharepoint-drive-resolver.js';

/** A `typeof fetch` stub: record the URL, return a scripted status + JSON body
 *  (or throw a transport error). Only `status`/`ok`/`json()` are consumed. */
const fetchStub = (
  script: (url: string) => { status: number; body?: unknown; malformed?: boolean; throwErr?: Error },
): { fetchImpl: typeof fetch; urls: string[] } => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const r = script(url);
    if (r.throwErr) throw r.throwErr;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => {
        if (r.malformed) throw new Error('Unexpected token < in JSON');
        return r.body ?? {};
      },
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, urls };
};

describe('parseSharePointSiteUrl', () => {
  it('splits a site URL into hostname + server-relative path (leading slash dropped)', () => {
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com/sites/TeamDocs')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: 'sites/TeamDocs',
    });
  });

  it('handles a nested site path', () => {
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com/sites/Team/Sub')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: 'sites/Team/Sub',
    });
  });

  it('strips a trailing slash', () => {
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com/sites/TeamDocs/')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: 'sites/TeamDocs',
    });
  });

  it('the tenant root site → empty sitePath', () => {
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com/')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: '',
    });
    expect(parseSharePointSiteUrl('https://contoso.sharepoint.com')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: '',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSharePointSiteUrl('  https://contoso.sharepoint.com/sites/X  ')).toEqual({
      hostname: 'contoso.sharepoint.com',
      sitePath: 'sites/X',
    });
  });

  it('rejects a non-URL, a non-https URL, and a host-less URL', () => {
    expect(parseSharePointSiteUrl('not a url')).toHaveProperty('error');
    expect(parseSharePointSiteUrl('http://contoso.sharepoint.com/sites/X')).toHaveProperty('error');
    // `file:///x` parses but has no host.
    expect(parseSharePointSiteUrl('file:///etc/passwd')).toHaveProperty('error');
  });
});

describe('resolveSharePointDriveId', () => {
  const token = 'ACCESS_TOKEN';

  it('resolves the default library drive id via the colon-addressed Graph URL + bearer auth', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ status: 200, body: { id: 'b!AbCdEf', name: 'Documents' } }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/TeamDocs',
      token,
      fetchImpl,
    });
    expect(out).toEqual({ ok: true, drive_id: 'b!AbCdEf' });
    expect(urls).toEqual([
      'https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/TeamDocs:/drive',
    ]);
  });

  it('the tenant root site uses the plain /sites/{host}/drive form', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ status: 200, body: { id: 'b!Root' } }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/',
      token,
      fetchImpl,
    });
    expect(out).toEqual({ ok: true, drive_id: 'b!Root' });
    expect(urls).toEqual(['https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com/drive']);
  });

  it('honors a custom graphBase', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ status: 200, body: { id: 'b!X' } }));
    await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/X',
      token,
      graphBase: 'https://graph.microsoft.us/v1.0/',
      fetchImpl,
    });
    expect(urls[0]).toBe('https://graph.microsoft.us/v1.0/sites/contoso.sharepoint.com:/sites/X:/drive');
  });

  it('403/401 → a "grant Sites.Read.All" reason', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fetchStub(() => ({ status }));
      const out = await resolveSharePointDriveId({
        siteUrl: 'https://contoso.sharepoint.com/sites/X',
        token,
        fetchImpl,
      });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/Sites\.Read\.All/);
    }
  });

  it('404 → a "site not found, check the URL" reason', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 404 }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/Ghost',
      token,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/not found/i);
  });

  it('another non-2xx → a generic HTTP-status reason', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 500 }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/X',
      token,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/HTTP 500/);
  });

  it('a malformed JSON body → a malformed-response reason', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 200, malformed: true }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/X',
      token,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/malformed/i);
  });

  it('a 200 with no `id` → a missing-id reason', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 200, body: { name: 'Documents' } }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/X',
      token,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/no 'id'/);
  });

  it('a bad site URL fails BEFORE any fetch (never hits the network)', async () => {
    const { fetchImpl, urls } = fetchStub(() => ({ status: 200, body: { id: 'b!X' } }));
    const out = await resolveSharePointDriveId({ siteUrl: 'not a url', token, fetchImpl });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/not a valid URL/);
    expect(urls).toEqual([]); // no network call for a malformed URL
  });

  it('SSRF-safety: a site URL with embedded userinfo still targets graph.microsoft.com, never the embedded host', async () => {
    // `new URL('https://contoso.sharepoint.com@evil.example/sites/X')` parses
    // `evil.example` as the HOST (userinfo `contoso.sharepoint.com@`). The resolver
    // uses that only as a Graph PATH segment — the outbound host stays the pinned
    // Graph base, so the Bearer access token never reaches `evil.example`.
    const { fetchImpl, urls } = fetchStub(() => ({ status: 200, body: { id: 'b!X' } }));
    await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com@evil.example/sites/X',
      token,
      fetchImpl,
    });
    expect(urls[0]).toBe(
      'https://graph.microsoft.com/v1.0/sites/evil.example:/sites/X:/drive',
    );
    expect(new URL(urls[0]).host).toBe('graph.microsoft.com'); // token went to Graph, not evil.example
  });

  it('a transport error → a "couldn\'t reach Graph" reason (never throws)', async () => {
    const { fetchImpl } = fetchStub(() => ({ status: 0, throwErr: new Error('ECONNREFUSED') }));
    const out = await resolveSharePointDriveId({
      siteUrl: 'https://contoso.sharepoint.com/sites/X',
      token,
      fetchImpl,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/couldn't reach Microsoft Graph/);
  });
});
