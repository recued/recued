/** Managed transport preserves native file enumeration, cursors and byte ceilings. */
import { describe, expect, it, vi } from 'vitest';
import { getFileVendorDeclaration } from '@recued/contracts';
import { buildFileSourceAdapterResolver, type FileConnectionCredential, type FileFetch } from '../file-source-adapters/index.js';
import { buildRemoteFileByteResolvers } from '../collections/file/remote-byte-resolvers/index.js';

const origins: Record<string, string> = { google: 'https://www.googleapis.com', onedrive: 'https://graph.microsoft.com',
  sharepoint: 'https://graph.microsoft.com', box: 'https://api.box.com', dropbox: 'https://api.dropboxapi.com', notion: 'https://api.notion.com' };
const managed = (vendor: string, managedFetch: FileFetch): FileConnectionCredential => ({
  auth: { type: 'managed_oauth', broker_profile_id: 'broker', integration_id: vendor, connection_id: 'saved-account',
    target_origin: origins[vendor], requested_scopes: [] }, config: {}, managedFetch,
});
const nativeFile = { id: 'native-id', name: 'native.pdf', extension: { extra: [null, false, 0] } };
const list = (results: unknown[]) => ({ object: 'list', results, has_more: false, next_cursor: null });
const fileBlock = { object: 'block', id: 'block-id', type: 'file', has_children: false,
  last_edited_time: '2026-10-01T00:00:00.000Z', file: { type: 'file', file: { url: 'https://files.example.test/native.pdf?signature=fixture' } } };

const responseFor = (vendor: string, url: string, init: Parameters<FileFetch>[1]): Response => {
  const path = new URL(url).pathname;
  if (vendor === 'google') return Response.json(path.endsWith('/startPageToken')
    ? { startPageToken: 'opaque-cursor' } : { files: [{ ...nativeFile, mimeType: 'application/pdf' }] });
  if (vendor === 'onedrive' || vendor === 'sharepoint') return Response.json({ value: [{ ...nativeFile,
    file: { mimeType: 'application/pdf' }, parentReference: { path: '/drive/root:' } }],
    '@odata.deltaLink': origins[vendor] + '/v1.0/me/drive/root/delta?token=opaque' });
  if (vendor === 'dropbox') return Response.json({ entries: [{ ...nativeFile, '.tag': 'file', path_display: '/native.pdf' }],
    has_more: false, cursor: 'opaque-cursor' });
  if (vendor === 'box') return path.endsWith('/events')
    ? new Response('{"next_stream_position":9007199254740993123,"entries":[]}', { headers: { 'content-type': 'application/json' } })
    : Response.json({ entries: [{ ...nativeFile, type: 'file' }], total_count: 1, limit: 1000 });
  if (path.endsWith('/search')) {
    const args = JSON.parse(String(init.body)) as { filter: { value: string } };
    return Response.json(list(args.filter.value === 'page' ? [{ object: 'page', id: 'page-id',
      properties: { Name: { type: 'title', title: [{ plain_text: 'Native title' }] } } }] : []));
  }
  return Response.json(list([fileBlock]));
};

describe('managed file providers', () => {
  it.each(Object.keys(origins))('keeps %s enumeration identical to direct credentials and omits bearer headers', async vendor => {
    const requests: { url: string; init: Parameters<FileFetch>[1] }[] = [];
    const proxy: FileFetch = async (url, init) => { requests.push({ url, init }); return responseFor(vendor, url, init); };
    const direct: FileFetch = async (url, init) => responseFor(vendor, url, init);
    const noDirect = vi.fn(async (): Promise<never> => { throw new Error('Managed API traffic bypassed its broker'); });
    const m = buildFileSourceAdapterResolver({ resolveConnection: async () => managed(vendor, proxy), fetchImpl: noDirect })(vendor)!;
    const d = buildFileSourceAdapterResolver({ resolveConnection: async () => ({ auth: { type: 'bearer', token: 'fixture-token' }, config: {} }), fetchImpl: direct })(vendor)!;
    const declaration = getFileVendorDeclaration(vendor)!;
    const request = { source_id: 'fixture-source', connection_name: 'saved', vendor, declaration, cursor: null };
    const actual = await m(request);
    expect(actual).toEqual(await d(request));
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expect(actual.rows).toHaveLength(1); expect(actual.complete).toBe(true);
      if (vendor !== 'notion') expect(actual.rows[0].extension).toEqual(nativeFile.extension);
      if (vendor === 'box') expect(actual.next_cursor).toBe('9007199254740993123');
    }
    expect(requests.length).toBeGreaterThan(0); expect(noDirect).not.toHaveBeenCalled();
    for (const { init } of requests) expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it.each(['google', 'onedrive', 'sharepoint', 'box', 'dropbox'])('returns raw %s bytes and retains its hard stream ceiling', async vendor => {
    const proxy = vi.fn<FileFetch>(async () => new Response('native-bytes', { headers: { 'content-type': 'application/pdf' } }));
    const noDirect = vi.fn(async (): Promise<never> => { throw new Error('Broker traffic used direct HTTP'); });
    const resolver = buildRemoteFileByteResolvers({ fetchImpl: noDirect })[vendor];
    const req = { cred: managed(vendor, proxy), remote_id: 'native-id', meta: { filename: 'native.pdf', provider: vendor, remote_id: 'native-id' }, maxBytes: 100 };
    expect(await resolver(req)).toEqual({ bytes: Buffer.from('native-bytes'), mime_type: 'application/pdf' });
    expect(new Headers(proxy.mock.calls[0][1].headers).get('authorization')).toBeNull();
    if (vendor === 'dropbox') {
      expect(proxy.mock.calls[0][0]).toBe('https://content.dropboxapi.com/2/files/download');
      expect(proxy.mock.calls[0][1].headers['Dropbox-API-Arg']).toBe('{"path":"native-id"}');
      expect(new Headers(proxy.mock.calls[0][1].headers).get('content-type')).toBeNull();
    }
    await expect(resolver({ ...req, maxBytes: 3 })).rejects.toMatchObject({ code: 'remote_too_large' });
    expect(noDirect).not.toHaveBeenCalled();
  });

  it('resolves a fresh Notion URL through the broker and downloads its bytes without either credential', async () => {
    const proxy = vi.fn<FileFetch>(async () => Response.json(fileBlock));
    const direct = vi.fn<FileFetch>(async () => new Response('native-bytes', { headers: { 'content-type': 'application/pdf' } }));
    const result = await buildRemoteFileByteResolvers({ fetchImpl: direct }).notion({ cred: managed('notion', proxy),
      remote_id: 'block-id', meta: { filename: 'native.pdf', provider: 'notion', remote_id: 'block-id' }, maxBytes: 100 });
    expect(result.bytes.toString()).toBe('native-bytes');
    expect(proxy).toHaveBeenCalledOnce(); expect(direct).toHaveBeenCalledOnce();
    expect(proxy.mock.calls[0][0]).toBe('https://api.notion.com/v1/blocks/block-id');
    expect(new Headers(proxy.mock.calls[0][1].headers).get('authorization')).toBeNull();
    expect(direct.mock.calls[0][0]).toBe('https://files.example.test/native.pdf?signature=fixture');
    expect(direct.mock.calls[0][1].headers).toEqual({});
  });

  it('fails closed on a managed credential without its broker transport or with another vendor origin', async () => {
    const direct = vi.fn(async (): Promise<never> => { throw new Error('Anonymous request'); });
    for (const cred of [{ ...managed('google', direct), managedFetch: undefined }, managed('box', direct)]) {
      const resolver = buildRemoteFileByteResolvers({ fetchImpl: direct }).google;
      await expect(resolver({ cred, remote_id: 'id', meta: { filename: 'native.pdf', provider: 'google', remote_id: 'id' }, maxBytes: 100 }))
        .rejects.toMatchObject({ code: 'file_storage_missing' });
    }
    expect(direct).not.toHaveBeenCalled();
  });
});
