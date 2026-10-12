/** D-322 — Nango control plane and raw HTTP proxy. No actions or normalization. */
import { RpcError, managedOAuthScopeUnion } from '@recued/contracts';
import type { ManagedOAuthAuth, ManagedOAuthIntegration, ManagedOAuthIntegrationSetup,
  ManagedOAuthProvider, ManagedOAuthRemoteConnection } from '@recued/contracts';
import type { ManagedOAuthProfile } from './managed-oauth-profile-store.js';
import { IngredientError } from '@recued/ingredients';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scopes = (value: unknown): string[] => typeof value === 'string'
  ? managedOAuthScopeUnion(value.split(/[\s,]+/)) : [];
// D-322 — identity must come from the same public row as the completion tag.
const publicIdentity = (row: Record<string, unknown>): string | undefined => {
  if (!Number.isSafeInteger(row.id) || Number(row.id) < 1 || typeof row.created !== 'string'
    || !Number.isFinite(Date.parse(row.created))) return undefined;
  return JSON.stringify([row.id, Date.parse(row.created)]);
};

export const managedOAuthServerUrl = (raw: string): string => {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RpcError('bad_request', 'Enter a complete broker server URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new RpcError('bad_request', 'Broker URL must use HTTPS (HTTP is allowed on loopback), without credentials, query or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
};

export const createNangoOAuthAdapter = (fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) => {
  const control = async (profile: ManagedOAuthProfile, path: string, body?: unknown, method?: string): Promise<Record<string, unknown>> => {
    const url = `${managedOAuthServerUrl(profile.base_url)}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
        headers: { Authorization: `Bearer ${profile.api_key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new RpcError('broker_unavailable', 'The OAuth broker could not be reached. Check its URL and try again.'); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Retain the sanitized HTTP refusal. */ }
      throw new RpcError(response.status === 429 || response.status >= 500 ? 'broker_unavailable' : 'bad_request',
        `The OAuth broker rejected the request (HTTP ${response.status}). Check the Nango API key, integration and broker permissions.`);
    }
    let responseBody: string;
    try { responseBody = await response.text(); }
    catch { throw new RpcError('broker_unavailable', 'The OAuth broker response was interrupted. Try again.'); }
    try { return record(JSON.parse(responseBody)); }
    catch { throw new RpcError('bad_request', 'The OAuth broker returned an invalid response.'); }
  };

  const integrations = async (profile: ManagedOAuthProfile): Promise<ManagedOAuthIntegration[]> => {
    const value = await control(profile, '/integrations');
    if (!Array.isArray(value.data)) throw new RpcError('bad_request', 'The broker did not return an integration list.');
    return value.data.flatMap((item) => {
      const row = record(item);
      if (typeof row.unique_key !== 'string' || typeof row.provider !== 'string') return [];
      return [{ id: row.unique_key, label: typeof row.display_name === 'string' ? row.display_name : row.unique_key,
        provider: row.provider, default_scopes: [], scope_metadata: 'unknown' as const }];
    });
  };

  const integration = async (profile: ManagedOAuthProfile, id: string): Promise<ManagedOAuthIntegration> => {
    let row: Record<string, unknown>;
    try { row = record((await control(profile, `/integrations/${encodeURIComponent(id)}?include=credentials`)).data); }
    catch {
      // A restricted environment key can authorize/proxy without permission to read app secrets.
      const found = (await integrations(profile)).find((item) => item.id === id);
      if (found === undefined) throw new RpcError('bad_request', 'Select an integration configured in this broker environment.');
      if (!(await providers(profile)).some((item) => item.id === found.provider)) {
        throw new RpcError('bad_request', 'This integration does not use OAuth 2.0. Select an OAuth integration.');
      }
      return found;
    }
    if (row.unique_key !== id || typeof row.provider !== 'string') throw new RpcError('bad_request', 'The broker returned a different integration.');
    const credentials = record(row.credentials);
    if (typeof credentials.type === 'string' && credentials.type !== 'OAUTH2') {
      throw new RpcError('bad_request', 'This integration does not use OAuth 2.0. Select an OAuth integration.');
    }
    if (typeof credentials.type !== 'string' && !(await providers(profile)).some((item) => item.id === row.provider)) {
      throw new RpcError('bad_request', 'This integration does not use OAuth 2.0. Select an OAuth integration.');
    }
    return { id, label: typeof row.display_name === 'string' ? row.display_name : id, provider: row.provider,
      default_scopes: scopes(credentials.scopes), scope_metadata: typeof credentials.scopes === 'string' ? 'available' : 'unknown' };
  };

  const providers = async (profile: ManagedOAuthProfile): Promise<ManagedOAuthProvider[]> => {
    const value = await control(profile, '/providers');
    if (!Array.isArray(value.data)) throw new RpcError('bad_request', 'Nango did not return its provider catalog.');
    return value.data.flatMap((item) => {
      const row = record(item);
      if (row.auth_mode !== 'OAUTH2' || typeof row.name !== 'string') return [];
      return [{ id: row.name, label: typeof row.display_name === 'string' ? row.display_name : row.name }];
    });
  };

  const createIntegration = async (profile: ManagedOAuthProfile, input: ManagedOAuthIntegrationSetup): Promise<ManagedOAuthIntegration> => {
    const body = { unique_key: input.integration_id, provider: input.provider, display_name: input.label, forward_webhooks: false,
      ...(input.app === 'shared' ? {} : { credentials: { type: 'OAUTH2', client_id: input.client_id,
        client_secret: input.client_secret, scopes: input.scopes.join(',') } }) };
    let value: Record<string, unknown>;
    try { value = await control(profile, input.app === 'shared' ? '/integrations/quickstart' : '/integrations', body); }
    catch { throw new RpcError('bad_request', 'Nango could not create this integration. Check that the ID is unused, your API key allows integration creation, and the selected shared app or custom OAuth credentials are available. You can also configure it in Nango and refresh.'); }
    const row = record(value.data);
    if (row.unique_key !== input.integration_id || row.provider !== input.provider) throw new RpcError('bad_request', 'Nango returned a different integration after creation. Refresh integrations before continuing.');
    return { id: input.integration_id, label: input.label, provider: input.provider,
      default_scopes: input.app === 'shared' ? [] : [...input.scopes], scope_metadata: input.app === 'shared' ? 'unknown' : 'available' };
  };

  const remoteConnections = async (profile: ManagedOAuthProfile, integrationId: string, page: number, connectionId?: string) => {
    const query = new URLSearchParams({ integrationId, limit: connectionId === undefined ? '100' : '2', page: String(page),
      ...(connectionId === undefined ? {} : { connectionId }) });
    const value = await control(profile, `/connections?${query}`);
    if (!Array.isArray(value.connections)) throw new RpcError('bad_request', 'Nango did not return its connection list.');
    const connections: ManagedOAuthRemoteConnection[] = value.connections.flatMap((item) => {
      const row = record(item);
      if (row.provider_config_key !== integrationId || typeof row.connection_id !== 'string'
        || (connectionId !== undefined && row.connection_id !== connectionId)) return [];
      const user = record(row.end_user);
      return [{ id: row.connection_id, label: typeof user.display_name === 'string' ? user.display_name : row.connection_id,
        auth_error: Array.isArray(row.errors) && row.errors.some((error) => record(error).type === 'auth') }];
    });
    return { connections, page, has_more: connectionId === undefined && value.connections.length === 100 };
  };
  const existing = async (profile: ManagedOAuthProfile, integrationId: string, connectionId: string) => {
    const found = await remoteConnections(profile, integrationId, 0, connectionId);
    if (found.connections.length !== 1) throw new RpcError('bad_request', 'Select an existing account in this Nango integration. Refresh accounts and try again.');
    return found.connections[0]!;
  };
  // Public row identity is stable across API keys; connection_id is only environment-local.
  const connectionIdentity = async (profile: ManagedOAuthProfile, integrationId: string, connectionId: string): Promise<string> => {
    const query = new URLSearchParams({ integrationId, connectionId, limit: '2', page: '0' });
    const value = await control(profile, `/connections?${query}`);
    const found = Array.isArray(value.connections) ? value.connections.map(record).filter((row) =>
      row.provider_config_key === integrationId && row.connection_id === connectionId) : [];
    if (found.length !== 1) throw new RpcError('bad_request', 'Select an existing account in this Nango integration. Refresh accounts and try again.');
    const identity = publicIdentity(found[0]!);
    if (identity === undefined) {
      throw new RpcError('bad_request', 'Nango did not expose a stable identity for this saved account.');
    }
    return identity;
  };
  const deleteRemoteConnection = async (profile: ManagedOAuthProfile, integrationId: string, connectionId: string): Promise<void> => {
    const query = new URLSearchParams({ provider_config_key: integrationId });
    const result = await control(profile, `/connections/${encodeURIComponent(connectionId)}?${query}`, undefined, 'DELETE');
    if (result.success !== true) throw new RpcError('bad_request', 'Nango did not confirm account deletion. Refresh accounts before trying again.');
  };

  const start = async (profile: ManagedOAuthProfile, body: Record<string, unknown>, reconnect: boolean) => {
    const data = record((await control(profile, reconnect ? '/connect/sessions/reconnect' : '/connect/sessions', body)).data);
    if (typeof data.connect_link !== 'string' || typeof data.expires_at !== 'string') {
      throw new RpcError('bad_request', 'The broker did not return a Connect link.');
    }
    let link: URL;
    try { link = new URL(data.connect_link); }
    catch { throw new RpcError('bad_request', 'The broker returned an invalid Connect link.'); }
    const base = new URL(profile.base_url);
    const expectedOrigin = profile.connect_ui_origin ?? (base.origin === 'https://api.nango.dev' ? 'https://connect.nango.dev' : base.origin);
    if (link.origin !== expectedOrigin || link.username || link.password) {
      throw new RpcError('bad_request', 'The broker returned a Connect link on an unexpected host.');
    }
    const expires_at = Date.parse(data.expires_at);
    if (!Number.isFinite(expires_at)) throw new RpcError('bad_request', 'The broker returned an invalid session expiry.');
    return { connect_link: link.toString(), expires_at };
  };

  const completed = async (profile: ManagedOAuthProfile, tag: string, integrationId: string, expectedId?: string) => {
    const query = new URLSearchParams({ 'tags[recued_flow]': tag, limit: '2' });
    const value = await control(profile, `/connections?${query.toString()}`);
    if (!Array.isArray(value.connections)) throw new RpcError('bad_request', 'The broker did not return a connection list.');
    const matches = value.connections.map(record).filter((row) => record(row.tags).recued_flow === tag
      && row.provider_config_key === integrationId && typeof row.connection_id === 'string'
      && (expectedId === undefined || row.connection_id === expectedId));
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) throw new RpcError('conflict', 'Several broker connections matched this authorization. Start again.');
    const row = matches[0]!;
    if (Array.isArray(row.errors) && row.errors.some((error) => record(error).type === 'auth')) {
      throw new RpcError('bad_request', 'The broker reports an authorization failure. Authorize again.');
    }
    return { connection_id: row.connection_id as string, identity: publicIdentity(row) };
  };

  const fetch = async (profile: ManagedOAuthProfile, auth: ManagedOAuthAuth, target: string, init: RequestInit): Promise<Response> => {
    const url = new URL(target);
    if (url.origin !== auth.target_origin || url.username || url.password || url.hash) {
      throw new IngredientError('CONNECTION_REFUSED', 'Managed OAuth target changed. Authorize this vendor again.');
    }
    const headers = new Headers({ Authorization: `Bearer ${profile.api_key}`, 'Provider-Config-Key': auth.integration_id,
      'Connection-Id': auth.connection_id, 'Base-Url-Override': url.origin, Retries: '0', 'Forward-Headers-On-Redirect': 'false' });
    new Headers(init.headers).forEach((value, name) => {
      if (name === 'authorization' || name === 'cookie' || name === 'host') {
        throw new IngredientError('CONNECTION_REFUSED', `A managed OAuth request cannot override ${name}.`);
      }
      headers.set(`nango-proxy-${name}`, value);
      if (name === 'content-type') headers.set(name, value);
    });
    try {
      return await fetchImpl(`${managedOAuthServerUrl(profile.base_url)}/proxy${url.pathname}${url.search}`, {
        ...init, headers, redirect: 'error',
      });
    } catch (error) {
      if (init.signal?.aborted) throw new DOMException('OAuth broker request aborted.', 'AbortError');
      // Never include transport errors: they may quote the environment API key.
      void error;
      throw new Error('OAuth broker request failed.');
    }
  };
  return { integrations, integration, providers, createIntegration, remoteConnections, existing, connectionIdentity, deleteRemoteConnection, start, completed, fetch };
};
