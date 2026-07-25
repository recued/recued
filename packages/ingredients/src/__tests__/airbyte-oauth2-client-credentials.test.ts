import { describe, expect, it } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';

import {
  createConnectionApiHandler,
  exchangeOAuth2ClientCredentials,
} from '../connection-api.js';
import type { ResolvedCall } from '../types.js';

const NOW = 1_700_000_000_000;

const row: ConnectionRow = {
  pk: 'api:airbyte',
  kind: 'api',
  name: 'airbyte',
  display_name: 'Airbyte Cloud',
  config_json: '{"base_url":"https://api.airbyte.com/v1"}',
  auth_ciphertext: 'opaque',
  enrolled_at: NOW,
  updated_at: NOW,
};

const call: ResolvedCall = {
  slug: 'connection',
  risk_tier: 'read',
  input: {},
  output: {},
};

const auth = (
  overrides: Partial<Extract<ConnectionAuth, { type: 'oauth2_client_credentials' }>> = {},
): Extract<ConnectionAuth, { type: 'oauth2_client_credentials' }> => ({
  type: 'oauth2_client_credentials',
  client_id: overrides.client_id ?? 'airbyte-client',
  client_secret: overrides.client_secret ?? 'airbyte-secret',
  token_endpoint: overrides.token_endpoint ?? 'https://api.airbyte.com/v1/applications/token',
  ...(overrides.token_auth_style !== undefined ? { token_auth_style: overrides.token_auth_style } : {}),
  ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
  ...(overrides.current_access_token !== undefined
    ? { current_access_token: overrides.current_access_token }
    : {}),
  ...(overrides.expires_at !== undefined ? { expires_at: overrides.expires_at } : {}),
});

describe('OAuth2 client credentials — trusted connection adapter', () => {
  it('mints, persists, and injects an Airbyte bearer token without exposing the secret to operation input', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url.endsWith('/applications/token')) {
        return new Response(JSON.stringify({
          access_token: 'short-lived-token',
          token_type: 'Bearer',
          expires_in: 180,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const persisted: ConnectionAuth[] = [];
    const handler = createConnectionApiHandler({
      decodeAuth: async () => auth(),
      persistAuth: async (_row, next) => { persisted.push(next); },
      fetchImpl,
      now: () => NOW,
    });

    await handler(row, { method: 'GET', path: '/workspaces' }, call);

    expect(requests).toHaveLength(2);
    const tokenRequest = requests[0]!;
    expect(tokenRequest.url).toBe('https://api.airbyte.com/v1/applications/token');
    expect(new Headers(tokenRequest.init.headers).get('content-type'))
      .toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(tokenRequest.init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'airbyte-client',
      client_secret: 'airbyte-secret',
    });
    expect(new Headers(requests[1]!.init.headers).get('authorization'))
      .toBe('Bearer short-lived-token');
    expect(requests[1]!.url).toBe('https://api.airbyte.com/v1/workspaces');
    expect(persisted).toEqual([expect.objectContaining({
      type: 'oauth2_client_credentials',
      current_access_token: 'short-lived-token',
      expires_at: NOW + 180_000,
    })]);
  });

  it('supports HTTP Basic client auth and an optional scope', async () => {
    let captured: RequestInit | undefined;
    const result = await exchangeOAuth2ClientCredentials(
      auth({ token_auth_style: 'basic', scope: 'read write' }),
      (async (_input, init) => {
        captured = init;
        return new Response(JSON.stringify({ access_token: 'token', token_type: 'bearer' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
      () => NOW,
    );

    expect(new Headers(captured?.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from('airbyte-client:airbyte-secret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(String(captured?.body)))).toEqual({
      grant_type: 'client_credentials',
      scope: 'read write',
    });
    expect(result).toMatchObject({
      type: 'oauth2_client_credentials',
      current_access_token: 'token',
      token_auth_style: 'basic',
      scope: 'read write',
    });
    expect('expires_at' in result).toBe(false);
  });

  it('refuses a cross-origin token redirect before forwarding credentials', async () => {
    const contacted: string[] = [];
    await expect(exchangeOAuth2ClientCredentials(
      auth(),
      (async (input) => {
        contacted.push(input.toString());
        return new Response(null, {
          status: 307,
          headers: { location: 'https://attacker.example/token' },
        });
      }) as typeof fetch,
      () => NOW,
    )).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
    expect(contacted).toEqual(['https://api.airbyte.com/v1/applications/token']);
  });

  it('fails closed on a non-bearer token response', async () => {
    await expect(exchangeOAuth2ClientCredentials(
      auth(),
      (async () => new Response(JSON.stringify({
        access_token: 'not-usable-here',
        token_type: 'mac',
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
      () => NOW,
    )).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });

  it('classifies a non-object token payload as TOKEN_REFRESH_FAILED', async () => {
    await expect(exchangeOAuth2ClientCredentials(
      auth(),
      (async () => new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
      () => NOW,
    )).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
  });
});
