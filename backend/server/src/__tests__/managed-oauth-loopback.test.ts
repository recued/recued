/** D-322 — real local HTTP control/proxy traffic through production enrollment and API dispatch. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createConnectionApiHandler } from '@recued/ingredients';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, makeConnectionHandlers } from '../connection-handler.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';

const body = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json', 'x-native-page': 'vendor-page' });
  response.end(JSON.stringify(value));
};
const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => { response.writeHead(500); response.end('fixture failure'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
};

describe('managed OAuth loopback flow', () => {
  it('authorizes, persists, probes and proxies native queries, JSON, status and binary bodies without token export', async () => {
    const db = new Database(':memory:');
    const native = { values: [[null, true, 0, '=A1']], nextPageToken: 'native-page', opaque: { sheetId: 'vendor-id' } };
    const requests: { path: string; authorization: string | undefined; body: Buffer }[] = [];
    const vendor = await listen(async (request, response) => {
      requests.push({ path: request.url!, authorization: request.headers.authorization, body: await body(request) });
      if (request.url!.startsWith('/v4/error')) { json(response, { error: { code: 'VENDOR_FORBIDDEN', nativeField: true } }, 403); return; }
      if (request.method === 'PUT') { response.writeHead(201, { 'content-type': 'application/octet-stream' }); response.end(requests.at(-1)!.body); return; }
      json(response, native, request.method === 'POST' ? 201 : 200);
    });
    let session: { tags: Record<string, string> } | undefined; let consent = false; let brokerUrl = '';
    const brokerRequests: IncomingMessage['headers'][] = [];
    const broker = await listen(async (request, response) => {
      const url = new URL(request.url!, brokerUrl);
      if (url.pathname === '/authorize') { consent = true; response.end('Vendor consent fixture complete'); return; }
      if (request.headers.authorization !== 'Bearer fixture-environment-key') { json(response, {}, 401); return; }
      if (url.pathname === '/integrations') { json(response, { data: [{ unique_key: 'native-service', provider: 'google-sheet' }] }); return; }
      if (url.pathname === '/integrations/native-service') { json(response, { data: { unique_key: 'native-service', provider: 'google-sheet', credentials: { type: 'OAUTH2', scopes: 'native.read' } } }); return; }
      if (url.pathname === '/connect/sessions') {
        session = JSON.parse((await body(request)).toString()) as typeof session;
        json(response, { data: { connect_link: `${brokerUrl}/authorize`, expires_at: new Date(Date.now() + 600_000).toISOString() } }, 201); return;
      }
      if (url.pathname === '/connections') { json(response, { connections: consent ? [{ connection_id: 'remote-account', provider_config_key: 'native-service', tags: session!.tags, errors: [] }] : [] }); return; }
      if (url.pathname.startsWith('/proxy/')) {
        brokerRequests.push(request.headers);
        expect(request.headers['base-url-override']).toBe(vendor.url);
        expect(request.headers.retries).toBe('0');
        const headers = new Headers({ Authorization: 'Bearer fixture-vendor-token' });
        for (const [name, value] of Object.entries(request.headers)) if (name.startsWith('nango-proxy-') && typeof value === 'string') headers.set(name.slice(12), value);
        const responseFromVendor = await fetch(`${vendor.url}${url.pathname.slice(6)}${url.search}`, {
          method: request.method, headers, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: new Uint8Array(await body(request)) }), redirect: 'manual',
        });
        response.writeHead(responseFromVendor.status, Object.fromEntries(responseFromVendor.headers));
        response.end(Buffer.from(await responseFromVendor.arrayBuffer())); return;
      }
      json(response, {}, 404);
    });
    brokerUrl = broker.url;
    try {
      const key = () => new Uint8Array(32).fill(5);
      const store = createConnectionStore(db); const profiles = createManagedOAuthProfileStore(db, key);
      const decode = (row: Parameters<typeof decodeAuthFromStorage>[1] & { auth_ciphertext: string }) => decodeAuthFromStorage(row.auth_ciphertext, row, key);
      const service = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: decode });
      const handlers = makeConnectionHandlers({ store, getEncryptionKey: key, managedOAuth: service })!.handlers;
      const saved = await service.handle({ action: 'save_profile', broker: 'nango', label: 'Loopback', base_url: broker.url, api_key: 'fixture-environment-key' });
      if (saved.action !== 'save_profile') throw new Error('fixture profile missing');
      const start = await service.handle({ action: 'start', profile_id: saved.profile.id, integration_id: 'native-service', base_url: `${vendor.url}/v4`, scopes: ['native.write'] });
      if (start.action !== 'start') throw new Error('fixture flow missing');
      expect(await service.handle({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret })).toMatchObject({ status: 'pending' });
      await fetch(start.connect_link);
      const completed = await service.handle({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
      if (completed.action !== 'status' || completed.auth === undefined) throw new Error('fixture consent missing');
      await handlers['collection.connection.enroll']({ kind: 'api', name: 'native', display_name: 'Native fixture', config: { base_url: `${vendor.url}/v4` }, auth: completed.auth }, undefined as never);
      const row = store.get('api', 'native')!;
      const api = createConnectionApiHandler({ decodeAuth: decode, persistAuth: async () => {}, managedOAuthFetch: service.fetch });
      const call = { slug: 'native.list', risk_tier: 'read' as const, input: {}, output: {} };
      expect(await api(row, { method: 'GET', path: '/items', 'query.fields': ['title', 'sheets'] }, call)).toMatchObject({ status: 200, result: native });
      expect(requests.at(-1)?.path).toBe('/v4/items?fields=title&fields=sheets');
      expect(await api(row, { method: 'POST', path: '/items', body_raw: JSON.stringify(native), 'header.Content-Type': 'application/json' }, { ...call, risk_tier: 'write' })).toMatchObject({ status: 201, result: native });
      expect(JSON.parse(requests.at(-1)!.body.toString())).toEqual(native);
      const bytes = new Uint8Array([0, 1, 254, 255]);
      const binary = await service.fetch(completed.auth, `${vendor.url}/v4/upload`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      expect(binary.status).toBe(201); expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes);
      expect(binary.headers.get('content-type')).toBe('application/octet-stream');
      await expect(api(row, { method: 'GET', path: '/error' }, call)).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
      const probed = await handlers['collection.connection.probe']({ kind: 'api', name: 'native' }, undefined as never);
      expect(probed.health).toMatchObject({ status: 'unknown', last_error: 'managed_oauth_permissions_unverified' });
      expect(requests.every((request) => request.authorization === 'Bearer fixture-vendor-token')).toBe(true);
      expect(brokerRequests.every((headers) => headers['connection-id'] === 'remote-account')).toBe(true);
      expect(JSON.stringify(await handlers['collection.connection.list']({}, undefined as never))).not.toContain('fixture-environment-key');
    } finally { await broker.close(); await vendor.close(); db.close(); }
  });
});
