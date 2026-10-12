/** D-322 §15 — local completed-request history, without Nango functions or tokens. */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedOAuthAuth } from '@recued/contracts';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from '../connection-handler.js';

describe('managed Graph requested-scope history', () => {
  it.each([
    { relation: 'same', needed: ['Mail.Read', 'Calendars.Read'], reuse: true },
    { relation: 'less', needed: ['Mail.Read'], reuse: true },
    { relation: 'more', needed: ['Mail.Read', 'Calendars.Read', 'Mail.Send'], reuse: false },
    { relation: 'partial overlap', needed: ['Calendars.Read', 'Mail.Send'], reuse: false },
  ])('handles $relation scopes with standard Nango APIs', async ({ needed, reuse }) => {
    const db = new Database(':memory:'); const now = 1_800_000_000_000;
    try {
      const key = () => new Uint8Array(32).fill(9);
      const profiles = createManagedOAuthProfileStore(db, key); const connections = createConnectionStore(db);
      profiles.save({ id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1, api_key: 'broker-key' });
      const prior = ['offline_access', 'openid', 'https://graph.microsoft.com/User.Read',
        'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Calendars.Read'];
      profiles.rememberAccountScopes('https://api.nango.dev', 'outlook',
        JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]), prior);
      const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'outlook',
        connection_id: 'remote-account', target_origin: 'https://graph.microsoft.com',
        requested_scopes: prior, required_scopes: ['Mail.Read', 'Calendars.Read'] };
      const row = connections.upsert({ kind: 'api', name: 'outlook', display_name: 'Outlook', enrolled_at: 1, updated_at: 1,
        config_json: '{"base_url":"https://graph.microsoft.com/v1.0"}',
        auth_ciphertext: await encodeAuthForStorage(auth, { name: 'outlook', kind: 'api' }, key) });
      const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/integrations/outlook') return Response.json({ data: { unique_key: 'outlook', provider: 'outlook',
          credentials: { type: 'OAUTH2', scopes: 'offline_access,openid,User.Read' } } });
        if (path === '/connections') return Response.json({ connections: [{ id: 101, created: '2026-10-01T00:00:00.000Z',
          provider_config_key: 'outlook', connection_id: 'remote-account', errors: [] }] });
        if (path === '/connect/sessions/reconnect') return Response.json({ data: { connect_link: 'https://connect.nango.dev',
          expires_at: new Date(now + 600_000).toISOString() } });
        throw new Error('Unexpected Nango route: ' + path);
      });
      const service = createManagedOAuthService({ profiles, listConnections: () => connections.list(), now: () => now,
        decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext!, row, key), fetchImpl: fetch,
        clearGrantedScopes: names => connections.clearGrantedScopes(names) });
      const result = await service.handle({ action: 'start', name: 'outlook', profile_id: 'cloud',
        integration_id: 'outlook', base_url: 'https://graph.microsoft.com/v1.0', scopes: needed });
      expect(result.action).toBe(reuse ? 'reuse' : 'start'); expect(result).not.toHaveProperty('granted_scopes');
      if (result.action === 'reuse') {
        const verified = service.authorizeForSave(result.auth, 'https://graph.microsoft.com/v1.0', 'outlook', row);
        expect(verified.granted_scopes).toBeUndefined();
        expect(verified.auth.requested_scopes).toEqual([...prior].sort());
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/connect/'))).toBe(false);
      } else {
        expect(fetch.mock.calls.at(-1)?.[0]).toBe('https://api.nango.dev/connect/sessions/reconnect');
        expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toMatchObject({ connection_id: 'remote-account' });
        expect(result.action === 'start' && result.requested_scopes).toEqual(expect.arrayContaining([...prior, 'Mail.Send']));
      }
      expect(fetch.mock.calls.some(([url]) => new URL(String(url)).pathname === '/action/trigger')).toBe(false);
    } finally { db.close(); }
  });
});
