/** D-322 — raw HTTP transport fidelity and broker routing control. */
import { describe, expect, it, vi } from 'vitest';
import { createNangoOAuthAdapter, managedOAuthServerUrl } from '../managed-oauth-nango.js';
import type { ManagedOAuthAuth } from '@recued/contracts';
const profile = { id: 'nango', label: 'Cloud', broker: 'nango' as const, base_url: 'https://api.nango.dev', revision: 1, api_key: 'broker-key' };
const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: 'nango', integration_id: 'sheets-prod',
  connection_id: 'account-1', target_origin: 'https://sheets.googleapis.com', requested_scopes: [] };

describe('Nango Connect routing', () => {
  it.each([false, true])('binds the stock self-hosted Connect UI to its broker for reconnect=%s', async (reconnect) => {
    const selfHosted = { ...profile, base_url: 'http://127.0.0.1:3003', connect_ui_origin: 'http://127.0.0.1:3009' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: {
      connect_link: 'http://127.0.0.1:3009/?session_token=connect-session&theme=dark',
      expires_at: '2026-10-12T14:00:00Z',
    } }));
    const result = await createNangoOAuthAdapter(fetch).start(selfHosted, {}, reconnect);
    const link = new URL(result.connect_link);
    // Stock Connect UI otherwise defaults its session lookup and auth socket to Nango Cloud.
    expect(link.searchParams.get('apiURL')).toBe(selfHosted.base_url);
    expect(link.searchParams.get('session_token')).toBe('connect-session');
    expect(link.searchParams.get('theme')).toBe('dark');
    expect(link.origin).toBe(selfHosted.connect_ui_origin);
    expect(result.connect_link).not.toContain(profile.api_key);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${selfHosted.base_url}/connect/sessions${reconnect ? '/reconnect' : ''}`);
  });
  it.each([
    { base_url: 'https://nango.example/broker/api', connect_ui_origin: 'https://connect.example' },
    { base_url: profile.base_url, connect_ui_origin: 'https://connect.nango.dev' },
  ])('replaces an off-broker API override while retaining the configured API path: $base_url', async (routing) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: {
      connect_link: `${routing.connect_ui_origin}/?session_token=connect-session&apiURL=https%3A%2F%2Funrelated.example`,
      expires_at: '2026-10-12T14:00:00Z',
    } }));
    const result = await createNangoOAuthAdapter(fetch).start({ ...profile, ...routing }, {}, false);
    const link = new URL(result.connect_link);
    expect(link.searchParams.getAll('apiURL')).toEqual([routing.base_url]);
    expect(link.searchParams.get('session_token')).toBe('connect-session');
    expect(result.connect_link).not.toContain('unrelated.example');
  });
});

describe('Nango raw proxy', () => {
  it('marks a sanitized control-plane network failure as retryable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Failed with Bearer broker-key'));
    await expect(createNangoOAuthAdapter(fetch).integrations(profile)).rejects.toMatchObject({
      code: 'broker_unavailable', message: 'The OAuth broker could not be reached. Check its URL and try again.',
    });
  });
  it('keeps an interrupted control response retryable without exposing its transport error', async () => {
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(new Error('private broker-key')) });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    await expect(createNangoOAuthAdapter(fetch).integrations(profile)).rejects.toMatchObject({
      code: 'broker_unavailable', message: 'The OAuth broker response was interrupted. Try again.',
    });
  });
  it('keeps malformed control JSON a permanent protocol error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('invalid JSON'));
    await expect(createNangoOAuthAdapter(fetch).integrations(profile)).rejects.toMatchObject({
      code: 'bad_request', message: 'The OAuth broker returned an invalid response.',
    });
  });
  it('sanitizes a rejected control response even when canceling its failed body rejects', async () => {
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(new Error('private broker-key')) });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status: 503 }));
    await expect(createNangoOAuthAdapter(fetch).integrations(profile)).rejects.toMatchObject({
      code: 'broker_unavailable', message: 'The OAuth broker rejected the request (HTTP 503). Check the Nango API key, integration and broker permissions.',
    });
  });
  it.each([[429, 'broker_unavailable'], [503, 'broker_unavailable'], [401, 'bad_request'], [403, 'bad_request']])(
    'classifies control-plane HTTP %s as %s without exposing the response body', async (status, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private broker-key', { status: Number(status) }));
      try { await createNangoOAuthAdapter(fetch).integrations(profile); expect.fail('Request should fail'); }
      catch (error) {
        expect(error).toMatchObject({ code });
        expect(error instanceof Error ? error.message : '').not.toContain('private broker-key');
      }
    });
  it.each(['omitted', 'denied'])('rejects non-OAuth integrations when app credentials are %s', async (access) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/providers') return Response.json({ data: [{ name: 'stripe', auth_mode: 'API_KEY' }] });
      if (path === '/integrations') return Response.json({ data: [{ unique_key: 'stripe-key', provider: 'stripe' }] });
      if (access === 'denied') return Response.json({}, { status: 403 });
      return Response.json({ data: { unique_key: 'stripe-key', provider: 'stripe' } });
    });
    await expect(createNangoOAuthAdapter(fetch).integration(profile, 'stripe-key')).rejects.toThrow('OAuth 2.0');
  });
  it('uses the public quickstart endpoint for shared apps and the credential endpoint for custom apps', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: { unique_key: body.unique_key, provider: body.provider, credentials: { client_secret: 'never-project' } } });
    });
    const adapter = createNangoOAuthAdapter(fetch);
    const setup = { profile_id: profile.id, integration_id: 'new-sheets', provider: 'google-sheet', label: 'Sheets', scopes: ['read'] };
    const shared = await adapter.createIntegration(profile, { ...setup, app: 'shared' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.nango.dev/integrations/quickstart');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty('credentials');
    expect(shared).toMatchObject({ default_scopes: [], scope_metadata: 'unknown' });
    expect(JSON.stringify(shared)).not.toContain('never-project');
    await adapter.createIntegration(profile, { ...setup, app: 'custom', client_id: 'my-id', client_secret: 'my-secret' });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.nango.dev/integrations');
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ forward_webhooks: false,
      credentials: { type: 'OAUTH2', client_id: 'my-id', client_secret: 'my-secret', scopes: 'read' } });
  });
  it('lists only the selected integration, verifies IDs and redacts account metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ connections: [
      { connection_id: 'account-1', provider_config_key: 'sheets-prod', end_user: { display_name: 'Work account' },
        tags: { private: 'private-tag' }, credentials: { access_token: 'private-token' }, errors: [] },
      { connection_id: 'other', provider_config_key: 'different-app', errors: [] },
    ] }));
    const result = await createNangoOAuthAdapter(fetch).remoteConnections(profile, 'sheets-prod', 3);
    expect(result).toEqual({ connections: [{ id: 'account-1', label: 'Work account', auth_error: false }], page: 3, has_more: false });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ integrationId: 'sheets-prod', limit: '100', page: '3' });
    fetch.mockResolvedValueOnce(Response.json({ connections: [{ connection_id: 'forged', provider_config_key: 'different-app' }] }));
    await expect(createNangoOAuthAdapter(fetch).existing(profile, 'sheets-prod', 'forged')).rejects.toThrow('Select an existing account');
  });
  it('deletes through the selected self-hosted server with an encoded account ID and no retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ success: true }));
    await createNangoOAuthAdapter(fetch).deleteRemoteConnection({ ...profile, base_url: 'https://nango.example' }, 'sheets-prod', 'id/with?reserved');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://nango.example/connections/id%2Fwith%3Freserved?provider_config_key=sheets-prod');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', redirect: 'error', headers: { Authorization: 'Bearer broker-key' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves query, native response and body; recipe headers cannot set broker retries', async () => {
    const original = new Response(JSON.stringify({ sheets: [{ properties: { sheetId: 7 } }], nextPageToken: 'page-2' }),
      { status: 206, headers: { 'content-type': 'application/json', 'x-vendor-id': 'native' } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(original);
    const result = await createNangoOAuthAdapter(fetch).fetch(profile, auth,
      'https://sheets.googleapis.com/v4/spreadsheets/id?fields=sheets&fields=title',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Retries: '12', 'Connection-Id': 'hijacked' }, body: '{"native":true}' });
    expect(result).toBe(original);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.nango.dev/proxy/v4/spreadsheets/id?fields=sheets&fields=title');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer broker-key');
    expect(headers.get('provider-config-key')).toBe('sheets-prod');
    expect(headers.get('connection-id')).toBe('account-1');
    expect(headers.get('base-url-override')).toBe('https://sheets.googleapis.com');
    expect(headers.get('retries')).toBe('0');
    expect(headers.get('forward-headers-on-redirect')).toBe('false');
    expect(headers.get('nango-proxy-retries')).toBe('12');
    expect(headers.get('nango-proxy-connection-id')).toBe('hijacked');
    expect(init?.body).toBe('{"native":true}'); expect(init?.redirect).toBe('error');
    expect(await result.json()).toEqual({ sheets: [{ properties: { sheetId: 7 } }], nextPageToken: 'page-2' });
  });
  it('passes binary uploads and vendor error responses without normalization', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('vendor-specific failure', { status: 422 }));
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const response = await createNangoOAuthAdapter(fetch).fetch(profile, auth, 'https://sheets.googleapis.com/upload',
      { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(bytes);
    expect(response.status).toBe(422); expect(await response.text()).toBe('vendor-specific failure');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses another origin and credential overrides before egress', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const adapter = createNangoOAuthAdapter(fetch);
    await expect(adapter.fetch(profile, auth, 'https://evil.example/data', {})).rejects.toThrow('target changed');
    await expect(adapter.fetch(profile, auth, 'https://sheets.googleapis.com/data', { headers: { Authorization: 'steal' } })).rejects.toThrow('cannot override');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sanitizes broker failures and rejects unsafe server URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Failed with Bearer broker-key'));
    await expect(createNangoOAuthAdapter(fetch).fetch(profile, auth, 'https://sheets.googleapis.com/data', {})).rejects.toThrow(/^OAuth broker request failed\.$/);
    await expect(createNangoOAuthAdapter(fetch).integrations(profile)).rejects.toThrow('could not be reached');
    for (const value of ['http://example.com', 'https://secret@example.com', 'https://example.com?key=secret', 'file:///tmp/broker']) {
      expect(() => managedOAuthServerUrl(value)).toThrow();
    }
    expect(managedOAuthServerUrl('http://127.0.0.1:3003/')).toBe('http://127.0.0.1:3003');
  });
});
