/** D-322 §25 — encrypted production service, identity reads and stale impact refusal. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isManagedOAuthImpactPreview, type ManagedOAuthAuth, type ManagedOAuthAuthorizationRequest } from '@recued/contracts';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const world = async () => {
  const db = new Database(':memory:'); dbs.push(db); const key = () => new Uint8Array(32).fill(8);
  const profiles = createManagedOAuthProfileStore(db, key); const store = createConnectionStore(db);
  let email = 'selected@example.test'; let refs = [{ kind: 'pack' as const, id: 'mail-pack', label: 'Mail pack' }];
  const fetch = vi.fn<typeof globalThis.fetch>(async (raw, init) => {
    const url = new URL(String(raw)); const headers = new Headers(init?.headers);
    if (url.hostname === 'gmail.googleapis.com') return headers.has('Authorization')
      ? Response.json({ emailAddress: 'current@example.test', private: 'discard' }) : new Response(null, { status: 401 });
    if (url.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'gmail', provider: 'google-mail' }] });
    if (url.pathname === '/integrations/gmail') return Response.json({ data: { unique_key: 'gmail', provider: 'google-mail', credentials: { type: 'OAUTH2', scopes: scope } } });
    if (url.pathname === '/connections') return Response.json({ connections: [{ id: 201, connection_id: 'selected', provider_config_key: 'gmail', created: '2026-10-01T00:00:00Z', errors: [] }] });
    if (url.pathname.startsWith('/proxy/')) return Response.json({ emailAddress: email, access_token: 'never-project-this', messagesTotal: 200 });
    throw new Error('Unexpected fixture URL');
  });
  const service = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext, row, key),
    fetchImpl: fetch, now: () => 1000, connectionUses: () => ({ uses: refs, complete: true }) });
  const saved = await service.handle({ action: 'save_profile', broker: 'nango', label: 'Cloud', base_url: 'https://api.nango.dev', api_key: 'private-broker-key' });
  if (saved.action !== 'save_profile') throw new Error('Fixture profile');
  const auth: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: saved.profile.id, integration_id: 'gmail', connection_id: 'selected',
    target_origin: 'https://gmail.googleapis.com', requested_scopes: [scope], required_scopes: [scope] };
  for (const name of ['work', 'shared']) store.upsert({ kind: 'api', name, display_name: name, enrolled_at: 1, updated_at: 2,
    config_json: '{"base_url":"https://gmail.googleapis.com/gmail/v1","vendor":"google"}',
    auth_ciphertext: await encodeAuthForStorage(name === 'shared' ? auth : { type: 'oauth2_refresh', client_id: 'app', refresh_token: 'private-refresh',
      token_endpoint: 'https://oauth2.googleapis.com/token', current_access_token: 'old-access', expires_at: 100000 }, { kind: 'api', name }, key) });
  profiles.rememberAccountScopes('https://api.nango.dev', 'gmail', JSON.stringify([201, Date.parse('2026-10-01T00:00:00Z')]), [scope]);
  const request: ManagedOAuthAuthorizationRequest = { profile_id: saved.profile.id, integration_id: 'gmail', base_url: 'https://gmail.googleapis.com/gmail/v1',
    vendor: 'google', scopes: [scope], name: 'work', connection_id: 'selected', switch_authentication: true, expected_updated_at: 2, include_account_impact: true };
  const preview = async () => { const r = await service.handle({ action: 'preview', ...request }); if (r.action !== 'preview') throw new Error('Fixture preview'); return r.preview; };
  const begin = async () => { const p = await preview(); const r = await service.handle({ action: 'start', ...request, preview_fingerprint: p.fingerprint }); if (r.action !== 'reuse') throw new Error('Fixture reuse'); return r; };
  const handlers = makeConnectionHandlers({ store, getEncryptionKey: key, managedOAuth: service, resolveFetch: fetch, now: () => 1000 })!.handlers;
  return { service, store, fetch, request, preview, begin, handlers, decode: (name: string) => decodeAuthFromStorage(store.get('api', name)!.auth_ciphertext, { kind: 'api', name }, key),
    email: (v: string) => { email = v; },
    changeUses: () => { refs = [...refs, { kind: 'pack', id: 'new-pack', label: 'New pack' }]; } };
};
describe('D-322 account and impact flow', () => {
  it('advertises impact review on every recovered authorized status without another consent session', async () => {
    const w = await world(); const started = await w.begin();
    for (let i = 0; i < 2; i++) {
      expect(await w.service.handle({ action: 'status', flow_id: started.flow_id, claim_secret: started.claim_secret }))
        .toMatchObject({ action: 'status', status: 'authorized', auth: started.auth, impact_available: true });
    }
    expect(w.fetch.mock.calls.some(([url]) => String(url).includes('/connect/sessions'))).toBe(false);
  });
  it('reads current and selected emails without consent, saved writes or raw payload exposure', async () => {
    const w = await world(); const before = w.store.list(); const p = await w.preview();
    expect(isManagedOAuthImpactPreview(p.account_impact)).toBe(true);
    expect(p.account_impact!.current!.identity.email).toBe('current@example.test');
    expect(p.account_impact!.target.identity.email).toBe('selected@example.test');
    expect(p.account_impact!.connections.map(c => [c.name, c.effect])).toEqual([['shared', 'shares_account'], ['work', 'selected_connection']]);
    expect(w.store.list()).toEqual(before);
    expect(w.fetch.mock.calls.every(([,init]) => init?.method === undefined || init.method === 'GET')).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/never-project-this|private-broker-key|private-refresh|messagesTotal/);
  });
  it.each(['identity', 'usage'])('refuses changed %s before starting authorization', async what => {
    const w = await world(); const p = await w.preview();
    if (what === 'identity') w.email('another@example.test'); else w.changeUses();
    await expect(w.service.handle({ action: 'start', ...w.request, preview_fingerprint: p.fingerprint })).rejects.toMatchObject({ code: 'conflict' });
    expect(w.fetch.mock.calls.some(([url]) => String(url).includes('/connect/sessions'))).toBe(false);
  });
  it('re-reads the actual authorized account and refuses changed impact before applying', async () => {
    const w = await world(); const started = await w.begin();
    const reply = await w.service.handle({ action: 'account_impact', flow_id: started.flow_id, claim_secret: started.claim_secret });
    if (reply.action !== 'account_impact') throw new Error('Fixture impact');
    expect(reply.impact.phase).toBe('before_save'); const before = w.store.get('api','work');
    w.email('changed-after-review@example.test');
    await expect(w.handlers['collection.connection.managedOAuth']!({ action: 'apply_authentication_switch', name: 'work', expected_updated_at: 2,
      auth: started.auth, attempt_id: 'impact-switch-test-001', verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      impact_fingerprint: reply.impact.fingerprint }, undefined as never)).rejects.toMatchObject({ code: 'conflict' });
    expect(w.store.get('api','work')).toEqual(before);
  });
  it('applies a verified switch only with the freshly reviewed account and local usage', async () => {
    const w = await world(); const started = await w.begin();
    const reply = await w.service.handle({ action: 'account_impact', flow_id: started.flow_id, claim_secret: started.claim_secret });
    if (reply.action !== 'account_impact') throw new Error('Fixture impact');
    const request = { action: 'apply_authentication_switch' as const, name: 'work', expected_updated_at: 2,
      auth: started.auth, attempt_id: 'impact-switch-test-002', verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      impact_fingerprint: reply.impact.fingerprint };
    const result = await w.handlers['collection.connection.managedOAuth']!(request, undefined as never);
    expect(result).toMatchObject({ action: 'apply_authentication_switch', connection: { name: 'work' } });
    expect(await w.decode('work')).toMatchObject({ type: 'managed_oauth', connection_id: 'selected' });
    expect(w.store.get('api','shared')!.updated_at).toBe(2);
    const calls = w.fetch.mock.calls.length;
    expect(await w.handlers['collection.connection.managedOAuth']!(request, undefined as never)).toEqual(result);
    expect(w.fetch.mock.calls).toHaveLength(calls);
  });
});
