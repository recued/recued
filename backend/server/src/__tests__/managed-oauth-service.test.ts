/** D-322 — production RPC enrollment, owner claims, scopes and native pack dispatch. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionApiHandler } from '@recued/ingredients';
import type { ManagedOAuthAuth, ManagedOAuthRequest, ManagedOAuthResponse } from '@recued/contracts';
import { createManagedOAuthService, type ManagedOAuthServiceDeps } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const setup = (knownScopes = true, requiredScopes = () => ['https://www.googleapis.com/auth/spreadsheets'],
  requiredScopeSources?: ManagedOAuthServiceDeps['requiredScopeSources']) => {
  const db = new Database(':memory:'); dbs.push(db);
  const key = () => new Uint8Array(32).fill(9);
  const profiles = createManagedOAuthProfileStore(db, key); const connections = createConnectionStore(db);
  let clock = 1_800_000_000_000; let consent = false; let error = false;
  let completedTags: Record<string, string> | undefined;
  const sessions: Record<string, unknown>[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'sheets-production', provider: 'google-sheet', display_name: 'Google Sheets' }] });
    if (url.pathname === '/providers') return Response.json({ data: [{ name: 'google-sheet', auth_mode: 'OAUTH2' }] });
    if (url.pathname === '/integrations/sheets-production') return Response.json({ data: { unique_key: 'sheets-production', provider: 'google-sheet',
      ...(knownScopes ? { credentials: { type: 'OAUTH2', scopes: 'openid,https://www.googleapis.com/auth/spreadsheets.readonly' } } : {}) } });
    if (url.pathname.startsWith('/connect/sessions')) {
      sessions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ data: { connect_link: 'https://connect.nango.dev/?token=short-lived', expires_at: new Date(clock + 30 * 60_000).toISOString() } }, { status: 201 });
    }
    if (url.pathname === '/connections') {
      return Response.json({ connections: consent ? [{ connection_id: 'remote-account', provider_config_key: 'sheets-production', tags: completedTags,
        id: 101, created: '2026-10-01T00:00:00.000Z',
        errors: error ? [{ type: 'auth' }] : [] }] : [] });
    }
    if (url.pathname.startsWith('/proxy/')) return Response.json({ spreadsheets: [{ spreadsheetId: 'native-id', title: 'Native title' }], nextPageToken: 'native-page' });
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  });
  const decode = (row: Parameters<typeof decodeAuthFromStorage>[1] & { auth_ciphertext: string }) => decodeAuthFromStorage(row.auth_ciphertext, row, key);
  const service = createManagedOAuthService({ profiles, listConnections: () => connections.list(), decodeAuth: decode, fetchImpl: fetch,
    clearGrantedScopes: names => connections.clearGrantedScopes(names),
    requiredScopes, ...(requiredScopeSources ? { requiredScopeSources } : {}), now: () => clock });
  const handlers = makeConnectionHandlers({ store: connections, getEncryptionKey: key, managedOAuth: service, now: () => clock })!.handlers;
  const rpc = (args: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => handlers['collection.connection.managedOAuth'](args, undefined as never);
  const authorize = async () => {
    const saved = await rpc({ action: 'save_profile', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', api_key: 'environment-key' });
    if (saved.action !== 'save_profile') throw new Error('wrong fixture response');
    const start = await rpc({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', vendor: 'google', scopes: [] });
    if (start.action !== 'start') throw new Error('wrong fixture response');
    return { saved, start };
  };
  return { profiles, connections, fetch, sessions, service, handlers, rpc, authorize, decode,
    consent: () => { consent = true; error = false; completedTags = sessions.at(-1)!.tags as Record<string, string>; },
    failConsent: () => { consent = true; error = true; completedTags = sessions.at(-1)!.tags as Record<string, string>; },
    tick: () => { clock += 11 * 60_000; } };
};

const savedAccount = async (f: ReturnType<typeof setup>) => {
  const { saved, start } = await f.authorize(); f.consent();
  const result = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
  if (result.action !== 'status' || result.auth === undefined) throw new Error('fixture consent');
  await f.handlers['collection.connection.enroll']({ kind: 'api', name: 'sheets', display_name: 'Sheets',
    config: { base_url: 'https://sheets.googleapis.com/v4' }, auth: result.auth }, undefined as never);
  return { saved, row: f.connections.get('api', 'sheets')! };
};
const fullSheets = 'https://www.googleapis.com/auth/spreadsheets';
describe('D-322 pack access diagnostic account fences', () => {
  it('reads stable public account metadata without creating consent or changing scopes and connections', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f);
    const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture account');
    const before = f.connections.list(); const history = f.profiles.scopeHistorySignature();
    const count = f.sessions.length;
    expect(f.service.diagnosticProfileSignature!()).toContain(saved.profile.id);
    expect(await f.service.inspectAccount!(auth)).toMatchObject({ profile_revision: saved.profile.revision, auth_error: false,
      identity: JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]) });
    expect(f.connections.list()).toEqual(before);
    expect(f.profiles.scopeHistorySignature()).toBe(history);
    expect(f.sessions).toHaveLength(count);
    expect(f.fetch.mock.calls.at(-1)![1]?.method).toBe('GET');
  });
  it('keeps a remote authorization error distinct from a successful native access check', async () => {
    const f = setup(); const { row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture account');
    f.failConsent();
    expect(await f.service.inspectAccount!(auth)).toMatchObject({ auth_error: true });
  });
});
// Fixture history represents prior completed consent, not this editor's desired scopes.
const trackCompleted = (f: ReturnType<typeof setup>, scopes: readonly string[]) =>
  f.profiles.rememberAccountScopes('https://api.nango.dev', 'sheets-production',
    JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]), scopes);
const storeAccount = async (f: ReturnType<typeof setup>, name: string, auth: ManagedOAuthAuth, grants?: readonly string[]) =>
  f.connections.upsert({ name, kind: 'api', display_name: name,
    config_json: JSON.stringify({ base_url: auth.target_origin + '/v4' }),
    auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, () => new Uint8Array(32).fill(9)),
    enrolled_at: 1, updated_at: 2, ...(grants === undefined ? {} : { granted_scopes_json: JSON.stringify(grants) }) });

describe('managed OAuth service and production connection RPC', () => {
  it('reads exact account dependencies and recorded health without creating consent or changing local state', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture auth');
    await storeAccount(f, 'sheets-copy', auth);
    await storeAccount(f, 'unrelated-account', { ...auth, connection_id: 'another-account' });
    f.connections.upsert({ ...row, health_json: JSON.stringify({ status: 'auth_failed', last_probed_at: 100,
      last_error: 'private-vendor-token' }), last_used_at: 200 });
    const reader = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: f.fetch, connectionUses: name => ({ complete: true,
        uses: name === 'sheets' ? [{ kind: 'pack', id: 'sheet-pack', label: 'Sheet pack' }] : [] }) });
    const beforeRows = f.connections.list(); const beforeHistory = f.profiles.scopeHistorySignature();
    f.fetch.mockClear(); const sessionCount = f.sessions.length;
    const result = await reader.handle({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id });
    expect(result.action).toBe('account_usage'); if (result.action !== 'account_usage') throw new Error('fixture result');
    expect(result.usage.connections.map(connection => connection.name)).toEqual(['sheets', 'sheets-copy']);
    expect(result.usage.connections[0]).toMatchObject({ health: { status: 'auth_failed', last_probed_at: 100 },
      last_used_at: 200, uses: [{ kind: 'pack', id: 'sheet-pack' }], usage_available: true });
    expect(JSON.stringify(result)).not.toMatch(/private-vendor-token|ciphertext|api_key|authorization_receipt/);
    expect(f.connections.list()).toEqual(beforeRows); expect(f.profiles.scopeHistorySignature()).toBe(beforeHistory);
    expect(f.sessions.length).toBe(sessionCount);
    expect(f.fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('includes aliases of the same environment but excludes an identical account ID in a different environment', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture auth');
    const original = f.profiles.get(saved.profile.id)!;
    f.profiles.save({ ...original, id: 'alias', label: 'Same environment', revision: 1 });
    f.profiles.save({ ...original, id: 'foreign', label: 'Different environment', api_key: 'foreign-key', revision: 1 });
    await storeAccount(f, 'alias-connection', { ...auth, broker_profile_id: 'alias' });
    await storeAccount(f, 'foreign-connection', { ...auth, broker_profile_id: 'foreign' });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer foreign-key') return Response.json({ connections: [{
        connection_id: auth.connection_id, provider_config_key: auth.integration_id, id: 202, created: '2026-10-02T00:00:00.000Z',
      }] });
      return f.fetch(input, init);
    });
    const reader = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const result = await reader.handle({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id });
    if (result.action !== 'account_usage') throw new Error('fixture result');
    expect(result.usage.connections.map(connection => connection.name)).toEqual(['alias-connection', 'sheets']);
    expect(result.usage.connections.every(connection => !connection.usage_available)).toBe(true);
  });

  it('reports a broker auth error, and refuses a disappeared account instead of returning empty healthy usage', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture auth');
    f.failConsent();
    const result = await f.rpc({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id });
    expect(result.action === 'account_usage' && result.usage.auth_error).toBe(true);
    f.fetch.mockResolvedValue(Response.json({ connections: [] }));
    await expect(f.rpc({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id })).rejects.toThrow('Select an existing account');
  });

  it('matches aliases against the same public account snapshot as the reported broker status', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture auth');
    f.profiles.save({ ...f.profiles.get(saved.profile.id)!, id: 'alias', label: 'Alias', api_key: 'alias-key', revision: 1 });
    await storeAccount(f, 'alias-connection', { ...auth, broker_profile_id: 'alias' });
    let selectedReads = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (new URL(input.toString()).pathname !== '/connections') return f.fetch(input, init);
      const alias = new Headers(init?.headers).get('Authorization') === 'Bearer alias-key';
      const replaced = !alias && ++selectedReads > 1;
      return Response.json({ connections: [{ connection_id: auth.connection_id, provider_config_key: auth.integration_id,
        id: replaced ? 202 : 101, created: '2026-10-01T00:00:00.000Z', errors: replaced ? [{ type: 'auth' }] : [] }] });
    });
    const reader = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const result = await reader.handle({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id });
    if (result.action !== 'account_usage') throw new Error('fixture result');
    expect(result.usage.connections.map(connection => connection.name)).toEqual(['alias-connection', 'sheets']);
    expect(result.usage.auth_error).toBe(false); expect(selectedReads).toBe(1);
  });
  it('keeps legacy accounts visible in their own profile without inventing a public identity', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row);
    if (auth.type !== 'managed_oauth') throw new Error('fixture auth');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ connections: [{
      connection_id: auth.connection_id, provider_config_key: auth.integration_id, errors: [],
    }] }));
    const reader = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const result = await reader.handle({ action: 'account_usage', profile_id: saved.profile.id,
      integration_id: auth.integration_id, connection_id: auth.connection_id });
    if (result.action !== 'account_usage') throw new Error('fixture result');
    expect(result.usage.connections.map(connection => connection.name)).toEqual(['sheets']);
    expect(result.usage.warnings).toContain('Nango did not expose a stable account identity. Usage is limited to this broker profile.');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { action: 'preview', phase: 'before discovery' }, { action: 'start', phase: 'before discovery' },
    { action: 'preview', phase: 'during discovery' }, { action: 'start', phase: 'during discovery' },
    { action: 'account_usage', phase: 'before discovery' }, { action: 'account_usage', phase: 'during discovery' },
  ] as const)('blocks $action $phase while this account is being deleted, before creating consent', async ({ action, phase }) => {
    const f = setup(); const { saved } = await savedAccount(f); f.connections.delete('api', 'sheets');
    let deleted!: (response: Response) => void; let deleting!: () => void; let discovered!: (response: Response) => void; let discovering!: () => void;
    const deleteGate = new Promise<Response>(resolve => { deleted = resolve; });
    const deleteEntered = new Promise<void>(resolve => { deleting = resolve; });
    const discoveryGate = new Promise<Response>(resolve => { discovered = resolve; });
    const discoveryEntered = new Promise<void>(resolve => { discovering = resolve; });
    let delayDiscovery = phase === 'during discovery'; let discoveryResponse!: Response;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (init?.method === 'DELETE') { deleting(); return deleteGate; }
      const response = await f.fetch(input, init);
      if (String(input).includes('/connections?') && delayDiscovery) {
        delayDiscovery = false; discoveryResponse = response; discovering(); return discoveryGate;
      }
      return response;
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const target = { profile_id: saved.profile.id, integration_id: 'sheets-production', connection_id: 'remote-account' };
    const request = { action, ...target, base_url: 'https://sheets.googleapis.com/v4', scopes: ['new-scope'], force_reauthorization: true };
    const sessionCount = f.sessions.length; const history = f.profiles.scopeHistorySignature();
    let authorizing: Promise<ManagedOAuthResponse> | undefined;
    if (phase === 'during discovery') { authorizing = service.handle(request); await discoveryEntered; }
    const removing = service.handle({ action: 'delete_remote_connection', ...target, confirmation: 'remote-account' }); await deleteEntered;
    try {
      if (phase === 'during discovery') discovered(discoveryResponse);
      else authorizing = service.handle(request);
      await expect(authorizing).rejects.toThrow('being deleted');
      expect(f.sessions).toHaveLength(sessionCount); expect(f.profiles.scopeHistorySignature()).toBe(history);
    } finally { deleted(Response.json({ success: true })); await removing; }
  });
  it.each([
    { scopes: ['A', 'B'], decision: 'reuse', added: [], retained: [fullSheets, fullSheets + '.readonly', 'openid'] },
    { scopes: ['A'], decision: 'reuse', added: [], retained: ['B', fullSheets, fullSheets + '.readonly', 'openid'] },
    { scopes: ['A', 'B', 'C'], decision: 'reconnect', added: ['C'], retained: [fullSheets, 'openid'] },
    { scopes: ['B', 'C'], decision: 'reconnect', added: ['C'], retained: ['A', fullSheets, 'openid'] },
  ])('previews $scopes as $decision without changing account history or grant evidence', async ({ scopes, decision, added, retained }) => {
    const f = setup(true, () => []); const { saved, row } = await savedAccount(f);
    const auth = await f.decode(row) as ManagedOAuthAuth;
    const history = ['A', 'B', fullSheets, 'openid']; trackCompleted(f, history);
    await storeAccount(f, 'sheets', { ...auth, requested_scopes: history, required_scopes: ['A', 'B'] }, history);
    const rowsBefore = f.connections.list(); const historyBefore = f.profiles.scopeHistorySignature();
    const count = f.sessions.length; f.fetch.mockClear();
    const args = { profile_id: saved.profile.id, integration_id: auth.integration_id, name: 'sheets',
      connection_id: auth.connection_id, base_url: 'https://sheets.googleapis.com/v4', scopes };
    const result = await f.rpc({ action: 'preview', ...args });
    if (result.action !== 'preview') throw new Error('fixture preview');
    expect(result.preview).toMatchObject({ decision, added_scopes: added, retained_scopes: retained });
    expect(result.preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty('auth'); expect(result).not.toHaveProperty('granted_scopes');
    expect(JSON.stringify(result)).not.toContain('environment-key');
    expect(f.fetch.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(f.sessions).toHaveLength(count); expect(f.connections.list()).toEqual(rowsBefore);
    expect(f.profiles.scopeHistorySignature()).toBe(historyBefore);
    const started = await f.rpc({ action: 'start', ...args, preview_fingerprint: result.preview.fingerprint });
    expect(started.action).toBe(decision === 'reuse' ? 'reuse' : 'start');
    if (started.action === 'start') {
      expect(started.requested_scopes).toEqual(result.preview.requested_scopes);
      expect(f.sessions.at(-1)).toMatchObject({ connection_id: auth.connection_id, integration_id: auth.integration_id });
    }
  });
  it('attributes preserved requirements to sibling connections and their service-specific packs', async () => {
    const f = setup(true, () => ['pack-read'], () => [{ slug: 'sheets-pack', name: 'Sheets pack', scopes: ['pack-read'] }]);
    const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sibling', { ...auth, required_scopes: ['sibling-write'] });
    const result = await f.rpc({ action: 'preview', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', vendor: 'google', scopes: [] });
    if (result.action !== 'preview') throw new Error('fixture preview');
    expect(result.preview).toMatchObject({ decision: 'reconnect', required_scopes: ['pack-read'] });
    expect(result.preview.sources).toContainEqual({ kind: 'pack', label: 'Sheets pack (sheets-pack)', scopes: ['pack-read'] });
    expect(result.preview.sources).toContainEqual({ kind: 'connection', label: 'sibling', scopes: ['sibling-write'] });
    expect(result.preview.requested_scopes).toContain('sibling-write');
    expect(result.preview.retained_scopes).toContain('sibling-write');
    expect(f.sessions).toHaveLength(1);
  });
  it.each(['request', 'pack', 'integration', 'sibling', 'history', 'profile', 'identity', 'health', 'force', 'forged'] as const)
    ('rejects a preview made stale by %s before creating consent or clearing grants', async change => {
      let required: string[] = []; const f = setup(true, () => required);
      const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
      await storeAccount(f, 'sheets', auth, [fullSheets]);
      const args = { name: 'sheets', profile_id: saved.profile.id, integration_id: auth.integration_id,
        base_url: 'https://sheets.googleapis.com/v4', vendor: 'google', scopes: ['new-scope'] };
      const result = await f.rpc({ action: 'preview', ...args });
      if (result.action !== 'preview') throw new Error('fixture preview');
      const next = { ...args };
      if (change === 'request') next.scopes = ['different-scope'];
      if (change === 'pack') required = ['new-pack-scope'];
      if (change === 'sibling') await storeAccount(f, 'sibling', { ...auth, required_scopes: ['sibling-scope'] });
      if (change === 'history') trackCompleted(f, [fullSheets, 'openid', 'completed-extra']);
      if (change === 'profile') f.profiles.save({ ...f.profiles.get(saved.profile.id)!, revision: saved.profile.revision + 1 });
      if (change === 'health') f.failConsent();
      if (change === 'integration' || change === 'identity') {
        const original = f.fetch.getMockImplementation()!;
        f.fetch.mockImplementation(async (input, init) => {
          const response = await original(input, init); const body = await response.json();
          if (change === 'integration' && String(input).includes('/integrations/sheets-production')) body.data.credentials.scopes += ',changed-default';
          if (change === 'identity' && String(input).includes('/connections?')) body.connections[0].id = 202;
          return Response.json(body);
        });
      }
      const before = f.connections.list(); const beforeHistory = f.profiles.scopeHistorySignature(); const sessions = f.sessions.length;
      await expect(f.rpc({ action: 'start', ...next,
        preview_fingerprint: change === 'forged' ? 'forged' : result.preview.fingerprint,
        ...(change === 'force' ? { force_reauthorization: true } : {}) })).rejects.toThrow('Permissions changed after review');
      expect(f.sessions).toHaveLength(sessions); expect(f.connections.list()).toEqual(before);
      expect(f.profiles.scopeHistorySignature()).toBe(beforeHistory);
    });
  it('previews fixed Graph and unknown app profiles without claiming dynamic scopes will be requested', async () => {
    const f = setup(true, () => []); const { saved } = await f.authorize();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((input, init) => String(input).includes('/integrations/sheets-production')
      ? Promise.resolve(Response.json({ data: { unique_key: 'sheets-production', provider: 'google-sheet',
        credentials: { type: 'OAUTH2', scopes: 'https://graph.microsoft.com/.default' } } })) : original(input, init));
    const fixed = await f.rpc({ action: 'preview', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://graph.microsoft.com/v1.0', scopes: ['Mail.Send'] });
    expect(fixed).toMatchObject({ action: 'preview', preview: { scope_metadata: 'fixed', requested_scopes: ['https://graph.microsoft.com/.default'], required_scopes: ['Mail.Send'] } });
    const unknown = setup(false, () => []); const { saved: unknownProfile } = await unknown.authorize();
    const result = await unknown.rpc({ action: 'preview', profile_id: unknownProfile.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', scopes: ['desired'] });
    if (result.action !== 'preview') throw new Error('fixture preview');
    expect(result.preview.scope_metadata).toBe('unknown'); expect(result.preview.requested_scopes).toBeUndefined();
    expect(result.preview.added_scopes).toBeUndefined(); expect(result.preview.warnings.join(' ')).toContain('existing scope profile');
  });
  it('returns a blocked imported-account preview without changing unknown history', async () => {
    const f = setup(true, () => []); const { saved } = await f.authorize(); f.consent();
    await storeAccount(f, 'imported', { type: 'managed_oauth', broker_profile_id: saved.profile.id,
      integration_id: 'sheets-production', connection_id: 'remote-account', target_origin: 'https://sheets.googleapis.com',
      requested_scopes: [], imported: true });
    const result = await f.rpc({ action: 'preview', name: 'imported', profile_id: saved.profile.id,
      integration_id: 'sheets-production', base_url: 'https://sheets.googleapis.com/v4', scopes: ['C'] });
    expect(result).toMatchObject({ action: 'preview', preview: { decision: 'blocked', blocked_reason: expect.stringContaining('previous scopes') } });
    expect(f.profiles.accountScopes('https://api.nango.dev', 'sheets-production', JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]))).toBeUndefined();
    expect(f.sessions).toHaveLength(1);
  });
  it('allows repeated previews without reserving the remote account or creating save receipts', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const args = { name: 'sheets', profile_id: saved.profile.id, integration_id: auth.integration_id,
      base_url: 'https://sheets.googleapis.com/v4', scopes: [] };
    const results = await Promise.all([f.rpc({ action: 'preview', ...args }), f.rpc({ action: 'preview', ...args })]);
    expect(results[0]).toEqual(results[1]); expect(f.sessions).toHaveLength(1);
    expect(await f.rpc({ action: 'start', ...args })).toMatchObject({ action: 'reuse' });
  });
  // D-322 implementation audit — unsaved services need their own requirement fence.
  it.each(['consent', 'save'] as const)('rejects changed pack requirements for a new account before %s', async phase => {
    let required = [fullSheets]; const f = setup(true, () => required);
    const { start } = await f.authorize(); f.consent();
    expect(f.connections.list()).toEqual([]);
    if (phase === 'consent') {
      required = [fullSheets, 'new-pack-scope'];
      await expect(f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret }))
        .rejects.toThrow('scope requirements changed');
    } else {
      const result = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
      if (result.action !== 'status' || result.auth === undefined) throw new Error('fixture consent');
      required = [fullSheets, 'new-pack-scope'];
      await expect(f.handlers['collection.connection.enroll']({ kind: 'api', name: 'new-sheets', display_name: 'Sheets',
        config: { base_url: 'https://sheets.googleapis.com/v4', vendor: 'google' }, auth: result.auth }, undefined as never))
        .rejects.toThrow('scope requirements changed');
    }
    expect(f.connections.list()).toEqual([]);
  });
  it.each(['discovery', 'session'] as const)('rejects requirements changed during new-account %s', async phase => {
    let required = [fullSheets]; const f = setup(true, () => required);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const result = await original(input, init);
      const path = new URL(String(input)).pathname;
      if (path === (phase === 'discovery' ? '/integrations/sheets-production' : '/connect/sessions')) {
        required = [fullSheets, 'new-pack-scope'];
      }
      return result;
    });
    await expect(f.authorize()).rejects.toThrow('scope requirements changed');
    expect(f.sessions).toHaveLength(phase === 'discovery' ? 0 : 1);
    expect(f.connections.list()).toEqual([]);
  });
  it.each(['attach', 'reuse'] as const)('fences new-service requirements before saving a %s receipt', async action => {
    let required = [fullSheets]; const f = setup(true, () => required);
    const { saved, start } = await f.authorize(); f.consent();
    expect(await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret })).toMatchObject({ status: 'authorized' });
    await f.rpc({ action: 'cancel', flow_id: start.flow_id, claim_secret: start.claim_secret });
    const result = await f.rpc({ action: action === 'attach' ? 'attach' : 'start', profile_id: saved.profile.id,
      integration_id: 'sheets-production', connection_id: 'remote-account',
      base_url: 'https://sheets.googleapis.com/v4', vendor: 'google', scopes: [] });
    if (result.action !== action) throw new Error('fixture receipt');
    required = [fullSheets, 'new-pack-scope'];
    expect(() => f.service.authorizeForSave(result.auth, 'https://sheets.googleapis.com/v4', 'new-sheets'))
      .toThrow('scope requirements changed');
    expect(f.connections.list()).toEqual([]);
  });
  it.each(['status', 'cancel'] as const)('does not assign completed history to a replacement remote row during %s', async action => {
    const f = setup(); const { saved, start } = await f.authorize(); f.consent();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init); const url = new URL(String(input));
      if (url.pathname !== '/connections' || url.searchParams.has('tags[recued_flow]')) return response;
      const value = await response.json() as { connections: Record<string, unknown>[] };
      return Response.json({ connections: value.connections.map(row => ({ ...row, id: 202, tags: {} })) });
    });
    const request = { action, flow_id: start.flow_id, claim_secret: start.claim_secret };
    if (action === 'status') await expect(f.rpc(request)).rejects.toThrow('Nango account changed');
    else expect(await f.rpc(request)).toEqual({ action: 'cancel' });
    expect(f.profiles.accountScopes('https://api.nango.dev', 'sheets-production',
      JSON.stringify([202, Date.parse('2026-10-01T00:00:00.000Z')]))).toBeUndefined();
    await f.rpc({ action: 'cancel', flow_id: start.flow_id, claim_secret: start.claim_secret });
    await expect(f.rpc({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', base_url: 'https://sheets.googleapis.com/v4', vendor: 'google', scopes: [] }))
      .rejects.toThrow('previous scopes');
  });
  it.each(['tag', 'identity'] as const)('rejects new-service requirements changed during the completion %s lookup', async lookup => {
    let required = [fullSheets]; const f = setup(true, () => required);
    const { start } = await f.authorize(); f.consent();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init); const url = new URL(String(input));
      if (url.pathname === '/connections' && url.searchParams.has('tags[recued_flow]') === (lookup === 'tag')) {
        required = [fullSheets, 'new-pack-scope'];
      }
      return response;
    });
    await expect(f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret }))
      .rejects.toThrow('scope requirements changed');
    expect(f.profiles.accountScopes('https://api.nango.dev', 'sheets-production',
      JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]))).toBeUndefined();
    expect(f.connections.list()).toEqual([]);
  });
  it.each(['status', 'cancel'] as const)('does not borrow a later identity when completion metadata is missing during %s', async action => {
    const f = setup(); const { start } = await f.authorize(); f.consent();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      const response = await original(input, init); const url = new URL(String(input));
      if (url.pathname !== '/connections' || !url.searchParams.has('tags[recued_flow]')) return response;
      const value = await response.json() as { connections: Record<string, unknown>[] };
      return Response.json({ connections: value.connections.map(({ id: _id, created: _created, ...row }) => row) });
    });
    const result = await f.rpc({ action, flow_id: start.flow_id, claim_secret: start.claim_secret });
    expect(result).toMatchObject(action === 'status' ? { status: 'authorized' } : { action: 'cancel' });
    expect(result).not.toHaveProperty('granted_scopes');
    expect(f.profiles.accountScopes('https://api.nango.dev', 'sheets-production',
      JSON.stringify([101, Date.parse('2026-10-01T00:00:00.000Z')]))).toBeUndefined();
  });
  it.each([
    { relation: 'same', scopes: ['A', 'B'], reuse: true },
    { relation: 'less', scopes: ['A'], reuse: true },
    { relation: 'more', scopes: ['A', 'B', 'C'], reuse: false },
    { relation: 'partial overlap', scopes: ['B', 'C'], reuse: false },
  ])('handles $relation scopes without creating another remote account', async ({ scopes, reuse }) => {
    const f = setup(); const { saved, row } = await savedAccount(f);
    const old = await f.decode(row) as ManagedOAuthAuth;
    const current = await storeAccount(f, 'sheets', { ...old, requested_scopes: [fullSheets, 'openid', 'A', 'B'], required_scopes: ['A', 'B'] },
      [fullSheets, 'openid', 'A', 'B']);
    trackCompleted(f, ['A', 'B', fullSheets, 'openid']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: old.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes });
    expect(result.action).toBe(reuse ? 'reuse' : 'start');
    if (reuse) {
      if (result.action !== 'reuse') throw new Error('fixture reuse');
      expect(f.sessions).toHaveLength(1);
      expect(result.auth).toMatchObject({ connection_id: 'remote-account', required_scopes: [...scopes].sort(),
        requested_scopes: ['A', 'B', fullSheets, 'openid'] });
      await f.rpc({ action: 'save_reauthorization', name: 'sheets', expected_updated_at: current.updated_at, patch: { auth: result.auth } });
      expect(result.granted_scopes).toBeUndefined();
      expect(f.connections.get('api', 'sheets')!.granted_scopes_json).toBeUndefined();
    } else {
      if (result.action !== 'start') throw new Error('fixture reconnect');
      expect(f.sessions).toHaveLength(2);
      expect(f.sessions[1]).toMatchObject({ connection_id: 'remote-account', integration_id: 'sheets-production' });
      expect(f.sessions[1]).not.toHaveProperty('allowed_integrations');
      expect(result.requested_scopes).toEqual(['A', 'B', 'C', fullSheets, 'openid']);
      // Evidence is retired before the external session, even if it is never saved.
      expect(f.connections.get('api', 'sheets')!.granted_scopes_json).toBeUndefined();
    }
  });
  it.each([
    { scopes: ['A', 'B'], reuse: true }, { scopes: ['A'], reuse: true },
    { scopes: ['A', 'B', 'C'], reuse: false }, { scopes: ['B', 'C'], reuse: false },
  ])('uses local history without claiming grants for $scopes', async ({ scopes, reuse }) => {
    const f = setup(); const { saved, row } = await savedAccount(f);
    const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sheets', { ...auth, requested_scopes: ['A', 'B', fullSheets, 'openid'], required_scopes: ['A', 'B'] });
    trackCompleted(f, ['A', 'B', fullSheets, 'openid']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes });
    expect(result.action).toBe(reuse ? 'reuse' : 'start'); expect(f.sessions).toHaveLength(reuse ? 1 : 2);
    expect(result).not.toHaveProperty('granted_scopes');
    expect(f.fetch.mock.calls.some(([url]) => new URL(String(url)).pathname === '/action/trigger')).toBe(false);
    if (!reuse) expect(f.sessions[1]).toMatchObject({ connection_id: 'remote-account' });
  });
  it('preserves every sibling’s requests and needs, even at another vendor API origin', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f);
    const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, [fullSheets, 'openid', 'A']);
    const sibling = await storeAccount(f, 'drive', { ...auth, target_origin: 'https://www.googleapis.com',
      requested_scopes: ['drive-old'], required_scopes: ['drive-needed'] }, ['drive-grant']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] });
    expect(result.action).toBe('start');
    if (result.action !== 'start') throw new Error('fixture');
    expect(result.requested_scopes).toEqual(['A', 'drive-grant', 'drive-needed', 'drive-old', fullSheets, 'openid']);
    const after = f.connections.get('api', 'drive')!;
    expect(after.granted_scopes_json).toBeUndefined();
    expect(after.auth_ciphertext).toBe(sibling.auth_ciphertext);
    expect(after.updated_at).toBe(sibling.updated_at);
    expect(after.config_json).toBe(sibling.config_json);
  });
  it('does not use edited local requests or cached grants to skip unfinished consent', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sheets', { ...auth, requested_scopes: [...auth.requested_scopes, 'new-scope'], required_scopes: ['new-scope'] },
      ['new-scope', fullSheets, 'openid']);
    const started = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['new-scope'] });
    if (started.action !== 'start') throw new Error('Consent was never completed for new-scope');
    expect(f.sessions.at(-1)).toMatchObject({ connection_id: 'remote-account' });
    f.consent(); expect(await f.rpc({ action: 'status', flow_id: started.flow_id, claim_secret: started.claim_secret }))
      .toMatchObject({ status: 'authorized' });
    await f.rpc({ action: 'cancel', flow_id: started.flow_id, claim_secret: started.claim_secret });
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['new-scope'] });
    expect(result.action).toBe('reuse'); expect(result).not.toHaveProperty('granted_scopes');
  });
  it('does not reuse completed history after the remote public account identity changes', async () => {
    const f = setup(); const { saved } = await savedAccount(f);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const response = await f.fetch(input, init);
      if (new URL(String(input)).pathname !== '/connections') return response;
      const data = await response.json() as { connections: Record<string, unknown>[] };
      return Response.json({ connections: data.connections.map(row => ({ ...row, id: 202 })) });
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: fetch });
    const result = await service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: 'sheets-production', base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    expect(result.action).toBe('start'); expect(f.sessions.at(-1)).toMatchObject({ connection_id: 'remote-account' });
  });
  it('forces same-ID consent when access is broken or Sign in again is chosen', async () => {
    for (const broken of [false, true]) {
      const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
      trackCompleted(f, ['A', 'B', fullSheets, 'openid']);
      await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
      if (broken) f.failConsent();
      expect((await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
        integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'],
        ...(broken ? {} : { force_reauthorization: true }) })).action).toBe('start');
      expect(f.sessions[1]).toMatchObject({ connection_id: 'remote-account' });
      expect(f.sessions[1]).toMatchObject({ integrations_config_defaults: { 'sheets-production': {
        connection_config: { oauth_scopes_override: ['A', 'B', fullSheets, 'openid'].join(',') },
      } } });
    }
  });
  it('keeps a smaller local request distinct from the account’s historical authorization', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const current = await storeAccount(f, 'sheets', { ...auth, requested_scopes: ['A', 'B', fullSheets, 'openid'], required_scopes: ['A', 'B'] },
      ['A', 'B', fullSheets, 'openid']);
    trackCompleted(f, ['A', 'B', fullSheets, 'openid']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] });
    if (result.action !== 'reuse') throw new Error('fixture reuse');
    expect(() => f.service.authorizeForSave({ ...result.auth, required_scopes: [] }, 'https://sheets.googleapis.com/v4', 'sheets', current)).toThrow('changed');
    await f.rpc({ action: 'save_reauthorization', name: 'sheets', expected_updated_at: current.updated_at, patch: { auth: result.auth } });
    const savedAuth = await f.decode(f.connections.get('api', 'sheets')!) as ManagedOAuthAuth;
    expect(savedAuth.required_scopes).toEqual(['A']); expect(savedAuth.requested_scopes).toContain('B');
    expect(savedAuth).not.toHaveProperty('authorization_receipt');
    expect(() => f.service.authorizeForSave(result.auth, 'https://sheets.googleapis.com/v4', 'sheets', current)).toThrow('Authorize');
  });
  it('does not promote either saved grant set when reusing completed requests', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', 'B', fullSheets, 'openid']);
    await storeAccount(f, 'sibling', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
    trackCompleted(f, ['A', 'B', fullSheets, 'openid']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] });
    expect(result).toMatchObject({ action: 'reuse' }); expect(result).not.toHaveProperty('granted_scopes');
  });
  it.each([true, false])('checks public account identity across profiles, same environment: %s', async sameEnvironment => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const other = { ...f.profiles.get(saved.profile.id)!, id: 'other-profile', api_key: 'other-environment', revision: 1 };
    f.profiles.save(other);
    await storeAccount(f, 'sibling', { ...auth, broker_profile_id: other.id,
      requested_scopes: ['other-request'], required_scopes: ['other-required'] }, ['other-grant']);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const response = await f.fetch(input, init);
      if (new URL(String(input)).pathname !== '/connections') return response;
      const payload = await response.json() as { connections: Record<string, unknown>[] };
      const otherKey = new Headers(init?.headers).get('authorization') === 'Bearer other-environment';
      return Response.json({ connections: payload.connections.map(r => ({ ...r, id: otherKey && !sameEnvironment ? 202 : 101,
        created: '2026-10-01T00:00:00.000Z' })) });
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: fetch, clearGrantedScopes: names => f.connections.clearGrantedScopes(names) });
    const result = await service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['new'] });
    if (result.action !== 'start') throw new Error('fixture');
    expect(result.requested_scopes.includes('other-request')).toBe(sameEnvironment);
    expect(result.requested_scopes.includes('other-required')).toBe(sameEnvironment);
    expect(result.requested_scopes.includes('other-grant')).toBe(sameEnvironment);
    expect(f.connections.get('api', 'sibling')!.granted_scopes_json === undefined).toBe(sameEnvironment);
  });
  it('rejects a changed sibling before saving a reuse receipt, even at the same timestamp', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const current = await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
    const sibling = await storeAccount(f, 'sibling', { ...auth, required_scopes: ['A'] });
    trackCompleted(f, ['A', fullSheets, 'openid']);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] });
    if (result.action !== 'reuse') throw new Error('fixture');
    await storeAccount(f, 'sibling', { ...auth, required_scopes: ['A', 'new'] });
    expect(f.connections.get('api', 'sibling')!.updated_at).toBe(sibling.updated_at);
    await expect(f.rpc({ action: 'save_reauthorization', name: 'sheets', expected_updated_at: current.updated_at,
      patch: { auth: result.auth } })).rejects.toThrow('scope requirements changed');
    expect(f.connections.get('api', 'sheets')!.auth_ciphertext).toBe(current.auth_ciphertext);
  });
  it('rejects a sibling added while a reconnect session is being created', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    let finish!: (r: Response) => void; let enter!: () => void;
    const gate = new Promise<Response>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (String(input).endsWith('/connect/sessions/reconnect')) { enter(); return gate; }
      return f.fetch(input, init);
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const pending = service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['new'] });
    const refusal = expect(pending).rejects.toThrow('scope requirements changed');
    await entered; await storeAccount(f, 'sibling', { ...auth, required_scopes: ['also-needed'] });
    finish(Response.json({ data: { connect_link: 'https://connect.nango.dev', expires_at: new Date(Date.now() + 600_000).toISOString() } }));
    await refusal;
  });
  it('checks current installed-pack requirements before reuse and before receipt save', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const current = await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
    f.connections.upsert({ ...current, config_json: '{"base_url":"https://sheets.googleapis.com/v4","vendor":"google"}' });
    let required = ['A'];
    trackCompleted(f, ['A', fullSheets, 'openid']);
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: f.fetch, requiredScopes: () => required });
    const result = await service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'], vendor: 'google' });
    if (result.action !== 'reuse') throw new Error('fixture');
    required = ['A', 'new-pack-permission'];
    expect(() => service.authorizeForSave(result.auth, 'https://sheets.googleapis.com/v4', 'sheets',
      f.connections.get('api', 'sheets')!)).toThrow('scope requirements changed');
  });
  it('retains tracked history when attaching another local connection to an account Recued authorized', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const attached = await f.rpc({ action: 'attach', profile_id: saved.profile.id, integration_id: auth.integration_id,
      connection_id: auth.connection_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['additional-need'] });
    if (attached.action !== 'attach') throw new Error('fixture');
    expect(attached.auth.imported).toBeUndefined(); expect(attached.auth.requested_scopes).toEqual(auth.requested_scopes);
    expect(attached.auth.required_scopes).toEqual(['additional-need']);
    await f.handlers['collection.connection.enroll']({ kind: 'api', name: 'second',
      display_name: 'Second', config: { base_url: 'https://sheets.googleapis.com/v4' }, auth: attached.auth }, undefined as never);
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    if (result.action !== 'start') throw new Error('fixture');
    expect(result.requested_scopes).toContain('additional-need');
  });
  it('retires grant evidence without retaining an uncompleted scope after failed session creation', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => String(input).endsWith('/connect/sessions/reconnect')
      ? Promise.reject(new Error('reply lost')) : f.fetch(input, init));
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: fetch, clearGrantedScopes: names => f.connections.clearGrantedScopes(names) });
    await expect(service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A', 'C'] })).rejects.toThrow('could not be reached');
    expect(f.connections.get('api', 'sheets')!.granted_scopes_json).toBeUndefined();
    const restarted = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: f.fetch });
    const result = await restarted.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] });
    if (result.action !== 'start') throw new Error('fixture');
    expect(result.requested_scopes).not.toContain('C');
    expect(f.sessions.at(-1)).toMatchObject({ connection_id: 'remote-account' });
  });
  it.each([false, true])('retains completed reconnect scopes without Save, completion polled: %s', async polled => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const started = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['C'] });
    if (started.action !== 'start') throw new Error('fixture');
    f.consent();
    if (polled) expect(await f.rpc({ action: 'status', flow_id: started.flow_id, claim_secret: started.claim_secret })).toMatchObject({ status: 'authorized' });
    await f.rpc({ action: 'cancel', flow_id: started.flow_id, claim_secret: started.claim_secret });
    const restarted = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: f.fetch });
    const result = await restarted.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    if (result.action !== 'reuse') throw new Error('fixture');
    expect(result.auth.requested_scopes).toContain('C');
    expect(result.granted_scopes).toBeUndefined(); expect(f.sessions).toHaveLength(2);
  });
  it('does not force a canceled unsupported scope into the next authorization', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const started = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['unsupported'] });
    if (started.action !== 'start') throw new Error('fixture');
    await f.rpc({ action: 'cancel', flow_id: started.flow_id, claim_secret: started.claim_secret });
    const result = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    if (result.action !== 'reuse') throw new Error('fixture');
    expect(result.auth.requested_scopes).not.toContain('unsupported');
    expect(result.granted_scopes).toBeUndefined();
  });
  it('retains new-account consent history without a local Save and makes no grant claim', async () => {
    const f = setup(); const { saved, start } = await f.authorize(); f.consent();
    const authorized = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    expect(authorized).not.toHaveProperty('granted_scopes');
    await f.rpc({ action: 'cancel', flow_id: start.flow_id, claim_secret: start.claim_secret });
    expect(f.connections.list()).toEqual([]);
    const restarted = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: f.fetch });
    const result = await restarted.handle({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', base_url: 'https://sheets.googleapis.com/v4', scopes: ['more'] });
    if (result.action !== 'start') throw new Error('fixture');
    expect(result.requested_scopes).toContain(fullSheets);
    expect(result.requested_scopes).toContain('more'); expect(f.sessions.at(-1)).toMatchObject({ connection_id: 'remote-account' });
  });
  it('refuses a failed identity lookup instead of bypassing encrypted history', async () => {
    const f = setup(); const { saved, row } = await savedAccount(f); const auth = await f.decode(row) as ManagedOAuthAuth;
    const current = await storeAccount(f, 'sheets', { ...auth, required_scopes: ['A'] }, ['A', fullSheets, 'openid']);
    const before = f.profiles.scopeHistorySignature(); let lookups = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (new URL(String(input)).pathname === '/connections' && ++lookups === 2) return Promise.resolve(new Response(null, { status: 503 }));
      return f.fetch(input, init);
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: fetch, clearGrantedScopes: names => f.connections.clearGrantedScopes(names) });
    await expect(service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id,
      integration_id: auth.integration_id, base_url: 'https://sheets.googleapis.com/v4', scopes: ['A'] })).rejects.toMatchObject({ code: 'broker_unavailable' });
    expect(f.sessions).toHaveLength(1); expect(f.profiles.scopeHistorySignature()).toBe(before);
    expect(f.connections.get('api', 'sheets')!.granted_scopes_json).toBe(current.granted_scopes_json);
  });
  it('omits the separate Sheets readonly scope when full spreadsheet access is already requested', async () => {
    const f = setup(); const { start } = await f.authorize();
    expect(start.requested_scopes).toEqual(['https://www.googleapis.com/auth/spreadsheets', 'openid']);
    expect(f.sessions[0]).toMatchObject({ integrations_config_defaults: {
      'sheets-production': { connection_config: { oauth_scopes_override: 'https://www.googleapis.com/auth/spreadsheets,openid' } },
    } });
    f.consent();
    const status = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (status.action !== 'status') throw new Error('fixture status');
    expect(status).toMatchObject({ status: 'authorized', auth: { requested_scopes: start.requested_scopes } });
    expect(status.granted_scopes).toBeUndefined();
  });

  it.each([
    { target: 'https://sheets.googleapis.com/v4', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      expected: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'openid'] },
    { target: 'https://sheets.googleapis.com/v4', scopes: ['https://www.googleapis.com/auth/spreadsheets', 'other-required-scope'],
      expected: ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'other-required-scope'] },
    { target: 'https://vendor.example/api', scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      expected: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/spreadsheets.readonly', 'openid'] },
  ])('keeps the requested access for $target with $scopes', async ({ target, scopes, expected }) => {
    const f = setup();
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(),
      decodeAuth: f.decode, fetchImpl: f.fetch });
    const saved = await service.handle({ action: 'save_profile', label: 'Cloud', broker: 'nango',
      base_url: 'https://api.nango.dev', api_key: 'environment-key' });
    if (saved.action !== 'save_profile') throw new Error('fixture profile');
    const start = await service.handle({ action: 'start', profile_id: saved.profile.id,
      integration_id: 'sheets-production', base_url: target, scopes });
    expect(start).toMatchObject({ action: 'start', requested_scopes: expected });
    expect(f.sessions[0]).toMatchObject({ integrations_config_defaults: {
      'sheets-production': { connection_config: { oauth_scopes_override: expected.join(',') } },
    } });
  });

  it('refuses to replace recorded account scopes when app defaults become unavailable', async () => {
    const f = setup(); const { saved } = await savedAccount(f);
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => String(input).includes('/integrations/sheets-production')
      ? Promise.resolve(Response.json({ data: { unique_key: 'sheets-production', provider: 'google-sheet' } })) : f.fetch(input, init));
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    await expect(service.handle({ action: 'start', name: 'sheets', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', scopes: ['new-permission'] })).rejects.toThrow('app scopes');
    expect(f.sessions).toHaveLength(1);
  });
  it('serializes reconnects for the same remote account, including while session creation is pending', async () => {
    const f = setup(); const { saved } = await savedAccount(f);
    let finish!: (r: Response) => void; let started!: () => void;
    const gate = new Promise<Response>((resolve) => { finish = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (String(input).endsWith('/connect/sessions/reconnect')) { started(); return gate.then((response) => response.clone()); }
      return f.fetch(input, init);
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const request = { action: 'start' as const, name: 'sheets', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', scopes: ['first-scope'] };
    const first = service.handle(request); await entered;
    const second = service.handle({ ...request, scopes: ['second-scope'] });
    finish(Response.json({ data: { connect_link: 'https://connect.nango.dev', expires_at: new Date(Date.now() + 600_000).toISOString() } }));
    const flow = await first;
    await expect(second).rejects.toThrow('already pending');
    await expect(service.handle(request)).rejects.toThrow('already pending');
    if (flow.action !== 'start') throw new Error('fixture flow');
    await service.handle({ action: 'cancel', flow_id: flow.flow_id, claim_secret: flow.claim_secret });
    expect((await service.handle(request)).action).toBe('start');
  });
  it('rejects an attachment whose metadata arrives after successful remote deletion', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    let finish!: (r: Response) => void; let entered!: () => void; let delay = true;
    const gate = new Promise<Response>((resolve) => { finish = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (init?.method === 'DELETE') return Response.json({ success: true });
      const response = await f.fetch(input, init);
      if (String(input).includes('/connections?') && delay) { delay = false; entered(); return gate; }
      return response;
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: fetch });
    const request = { profile_id: saved.profile.id, integration_id: 'sheets-production', connection_id: 'remote-account' };
    const attached = service.handle({ action: 'attach', ...request, base_url: 'https://sheets.googleapis.com/v4' }); await waiting;
    await service.handle({ action: 'delete_remote_connection', ...request, confirmation: 'remote-account' });
    finish(Response.json({ connections: [{ connection_id: 'remote-account', provider_config_key: 'sheets-production', errors: [] }] }));
    await expect(attached).rejects.toThrow('changed while');
  });
  it('rejects a key from another Nango environment even when its integration and account IDs collide', async () => {
    const f = setup(); const { saved } = await savedAccount(f);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes('/connections?')) return Response.json({ connections: [{ id: new Headers(init?.headers).get('authorization') === 'Bearer other-environment' ? 202 : 101,
        created: '2026-10-01T00:00:00.000Z', connection_id: 'remote-account', provider_config_key: 'sheets-production', errors: [] }] });
      return f.fetch(input, init);
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    await expect(service.handle({ action: 'save_profile', id: saved.profile.id, broker: 'nango', label: 'Cloud', base_url: saved.profile.base_url,
      api_key: 'other-environment' })).rejects.toThrow('same Nango accounts');
    expect(f.profiles.get(saved.profile.id)?.api_key).toBe('environment-key');
    expect((await service.handle({ action: 'save_profile', id: saved.profile.id, broker: 'nango', label: 'Cloud', base_url: saved.profile.base_url,
      api_key: 'rotated-same-env' })).action).toBe('save_profile');
  });
  it('issues no receipt for consent metadata that arrives after the account was deleted', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    let finish!: (r: Response) => void; let entered!: () => void;
    const gate = new Promise<Response>((resolve) => { finish = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (init?.method === 'DELETE') return Response.json({ success: true });
      const response = await f.fetch(input, init);
      if (new URL(String(input)).searchParams.has('tags[recued_flow]')) { entered(); return gate; }
      return response;
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: fetch });
    const flow = await service.handle({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    if (flow.action !== 'start') throw new Error('fixture flow');
    const checking = service.handle({ action: 'status', flow_id: flow.flow_id, claim_secret: flow.claim_secret }); await waiting;
    await service.handle({ action: 'delete_remote_connection', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', confirmation: 'remote-account' });
    finish(Response.json({ connections: [{ connection_id: 'remote-account', provider_config_key: 'sheets-production', tags: { recued_flow: flow.flow_id }, errors: [] }] }));
    await expect(checking).rejects.toThrow('changed while');
  });
  it('attaches an existing account without a Connect session, then saves through the production receipt gate', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    const before = f.sessions.length;
    expect(await f.rpc({ action: 'remote_connections', profile_id: saved.profile.id, integration_id: 'sheets-production' }))
      .toMatchObject({ connections: [{ id: 'remote-account', auth_error: false }] });
    const attached = await f.rpc({ action: 'attach', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', base_url: 'https://sheets.googleapis.com/v4' });
    if (attached.action !== 'attach') throw new Error('fixture');
    expect(f.sessions).toHaveLength(before);
    expect(attached.auth.requested_scopes).toEqual([]);
    expect(attached.auth.imported).toBe(true);
    expect(() => f.service.authorizeForSave({ ...attached.auth, connection_id: 'another-user' }, 'https://sheets.googleapis.com/v4', 'imported')).toThrow('changed');
    expect(() => f.service.authorizeForSave({ ...attached.auth, imported: undefined }, 'https://sheets.googleapis.com/v4', 'imported')).toThrow('changed');
    await f.handlers['collection.connection.enroll']({ kind: 'api', name: 'imported', display_name: 'Imported account',
      config: { base_url: 'https://sheets.googleapis.com/v4' }, auth: attached.auth, granted_scopes: ['forged-grant'] }, undefined as never);
    const row = f.connections.get('api', 'imported')!;
    expect(row.granted_scopes_json).toBeUndefined();
    expect(await f.decode(row)).toMatchObject({ connection_id: 'remote-account', requested_scopes: [], imported: true });
    await expect(f.rpc({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production',
      base_url: 'https://sheets.googleapis.com/v4', name: 'imported', scopes: ['new-permission'] })).rejects.toThrow('previous scopes');
    expect(f.sessions).toHaveLength(before);
    expect(() => f.service.authorizeForSave(attached.auth, 'https://sheets.googleapis.com/v4', 'replayed')).toThrow('Authorize');
  });
  it('refuses missing or broken remote accounts and reconnects no account whose previous scopes are unknown', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    const request = { profile_id: saved.profile.id, integration_id: 'sheets-production', base_url: 'https://sheets.googleapis.com/v4' };
    await expect(f.rpc({ action: 'attach', ...request, connection_id: 'nonexistent' })).rejects.toThrow('Select an existing account');
    f.failConsent();
    await expect(f.rpc({ action: 'attach', ...request, connection_id: 'remote-account' })).rejects.toThrow('needs reauthorization');
    await expect(f.rpc({ action: 'start', ...request, connection_id: 'remote-account', scopes: ['new-permission'] })).rejects.toThrow('previous scopes');
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/connect/sessions/reconnect'))).toBe(false);
  });
  it('cancels attached receipts and rechecks profile revisions after remote verification', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    const attached = await f.rpc({ action: 'attach', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', base_url: 'https://sheets.googleapis.com/v4' });
    if (attached.action !== 'attach') throw new Error('fixture');
    await f.rpc({ action: 'cancel', flow_id: attached.flow_id, claim_secret: attached.claim_secret });
    expect(() => f.service.authorizeForSave(attached.auth, 'https://sheets.googleapis.com/v4', 'sheets')).toThrow('Authorize');
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const response = await f.fetch(input, init);
      if (new URL(String(input)).pathname === '/connections') f.profiles.save({ ...f.profiles.get(saved.profile.id)!, revision: saved.profile.revision + 1 });
      return response;
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: fetch });
    await expect(service.handle({ action: 'attach', profile_id: saved.profile.id, integration_id: 'sheets-production',
      connection_id: 'remote-account', base_url: 'https://sheets.googleapis.com/v4' })).rejects.toThrow('profile changed');
  });
  it('blocks a remote deletion used by Recued and blocks pending receipt saves during deletion', async () => {
    const f = setup(); const { saved } = await f.authorize(); f.consent();
    let finish!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => { finish = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => init?.method === 'DELETE' ? gate : f.fetch(input, init));
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: f.decode, fetchImpl: fetch });
    const request = { profile_id: saved.profile.id, integration_id: 'sheets-production', connection_id: 'remote-account' };
    const attached = await service.handle({ action: 'attach', ...request, base_url: 'https://sheets.googleapis.com/v4' });
    if (attached.action !== 'attach') throw new Error('fixture');
    await expect(service.handle({ action: 'delete_remote_connection', ...request, confirmation: 'wrong' })).rejects.toThrow('confirm deletion');
    const deletion = service.handle({ action: 'delete_remote_connection', ...request, confirmation: 'remote-account' });
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    expect(() => service.authorizeForSave(attached.auth, 'https://sheets.googleapis.com/v4', 'sheets')).toThrow('being deleted');
    finish(Response.json({ success: true })); await deletion;
    expect(() => service.authorizeForSave(attached.auth, 'https://sheets.googleapis.com/v4', 'sheets')).toThrow('Authorize');
    const { encodeAuthForStorage } = await import('../connection-handler.js');
    f.connections.upsert({ name: 'saved', kind: 'api', display_name: 'Saved', config_json: '{}', enrolled_at: 1, updated_at: 1,
      auth_ciphertext: await encodeAuthForStorage({ ...attached.auth, authorization_receipt: undefined }, { name: 'saved', kind: 'api' }, () => new Uint8Array(32).fill(9)) });
    const before = fetch.mock.calls.length;
    await expect(service.handle({ action: 'delete_remote_connection', ...request, confirmation: 'remote-account' })).rejects.toThrow('Remove the Recued connections');
    expect(fetch.mock.calls).toHaveLength(before);
  });
  it('discovers OAuth providers and creates integrations without persisting app secrets or changing existing integrations', async () => {
    const f = setup(); const { saved } = await f.authorize();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/providers') return Response.json({ data: [{ name: 'google-sheet', display_name: 'Google Sheets', auth_mode: 'OAUTH2' }, { name: 'stripe', auth_mode: 'API_KEY' }] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: { unique_key: body.unique_key, provider: body.provider } });
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: fetch });
    expect(await service.handle({ action: 'providers', profile_id: saved.profile.id, base_url: 'https://sheets.googleapis.com/v4' }))
      .toMatchObject({ selected_id: 'google-sheet', providers: [{ id: 'google-sheet' }] });
    const response = await service.handle({ action: 'create_integration', profile_id: saved.profile.id, integration_id: 'recued-sheets',
      provider: 'google-sheet', label: 'My Sheets', app: 'custom', client_id: 'client-id', client_secret: 'private-client-secret', scopes: ['read', 'read'] });
    expect(response).toMatchObject({ integration: { default_scopes: ['read'] } });
    expect(JSON.stringify(response)).not.toContain('private-client-secret');
    expect(f.profiles.list()[0]?.revision).toBe(saved.profile.revision);
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'PATCH')).toBe(true);
    await expect(service.handle({ action: 'create_integration', profile_id: saved.profile.id, integration_id: 'stripe',
      provider: 'stripe', label: 'Stripe', app: 'shared', scopes: [] })).rejects.toThrow('OAuth 2.0 provider');
  });
  it('rechecks the broker after encryption before committing a verified receipt', async () => {
    const f = setup(); const { start, saved } = await f.authorize(); f.consent();
    const status = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (status.action !== 'status' || status.auth === undefined) throw new Error('fixture');
    const handlers = makeConnectionHandlers({ store: f.connections, managedOAuth: f.service, getEncryptionKey: () => {
      const previous = f.profiles.get(saved.profile.id)!;
      f.profiles.save({ ...previous, revision: previous.revision + 1 });
      return new Uint8Array(32).fill(9);
    } })!.handlers;
    await expect(handlers['collection.connection.enroll']({ name: 'raced', kind: 'api', display_name: 'Race fixture',
      config: { base_url: 'https://sheets.googleapis.com/v4' }, auth: status.auth }, undefined as never)).rejects.toThrow('profile changed');
    expect(f.connections.get('api', 'raced')).toBeNull();
  });
  it('does not delete a profile if a connection is added during asynchronous reference checks', async () => {
    const f = setup(); const { saved } = await f.authorize();
    f.connections.upsert({ name: 'older', kind: 'api', display_name: 'Older', config_json: '{}', auth_ciphertext: 'fixture', enrolled_at: 1, updated_at: 1 });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => f.connections.list(), decodeAuth: async () => {
      await gate; return { type: 'none' };
    } });
    const deletion = service.handle({ action: 'delete_profile', id: saved.profile.id });
    f.connections.upsert({ name: 'newer', kind: 'api', display_name: 'Newer', config_json: '{}', auth_ciphertext: 'fixture-managed', enrolled_at: 2, updated_at: 2 });
    finish(); await expect(deletion).rejects.toThrow('connections changed');
    expect(f.profiles.get(saved.profile.id)).toBeDefined();
  });
  it('preserves an Entra static profile instead of mixing .default with dynamic permissions', async () => {
    const f = setup(); const { saved } = await f.authorize();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes('/integrations/')) return Response.json({ data: { unique_key: 'graph', provider: 'microsoft', credentials: { type: 'OAUTH2', scopes: '.default,offline_access' } } });
      f.sessions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ data: { connect_link: 'https://connect.nango.dev', expires_at: new Date(Date.now() + 600_000).toISOString() } });
    });
    const service = createManagedOAuthService({ profiles: f.profiles, listConnections: () => [], decodeAuth: f.decode, fetchImpl: fetch });
    expect(await service.handle({ action: 'start', profile_id: saved.profile.id, integration_id: 'graph', base_url: 'https://graph.microsoft.com/v1.0',
      scopes: ['Mail.Read', 'Files.ReadWrite'] })).toMatchObject({ scope_metadata: 'fixed', requested_scopes: ['.default', 'offline_access'] });
    expect(f.sessions.at(-1)).not.toHaveProperty('integrations_config_defaults');
  });
  it('discovers, verifies consent, saves encrypted references and executes unchanged native operations', async () => {
    const f = setup(); const { saved, start } = await f.authorize();
    const discovered = await f.rpc({ action: 'integrations', profile_id: saved.profile.id, vendor: 'google', base_url: 'https://sheets.googleapis.com/v4' });
    expect(discovered).toMatchObject({ selected_id: 'sheets-production', required_scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    expect(await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: 'wrong-owner' })).toMatchObject({ status: 'expired' });
    expect(await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret })).toMatchObject({ status: 'pending' });
    f.consent(); const status = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (status.action !== 'status' || status.auth === undefined) throw new Error('missing authorization');
    const verified = status.auth;
    expect(status.granted_scopes).toBeUndefined();
    expect(start.requested_scopes).toEqual(['https://www.googleapis.com/auth/spreadsheets', 'openid']);
    expect(f.sessions[0]).toMatchObject({ allowed_integrations: ['sheets-production'], integrations_config_defaults: {
      'sheets-production': { connection_config: { oauth_scopes_override: start.requested_scopes.join(',') } } } });
    await f.handlers['collection.connection.enroll']({ name: 'sheets', kind: 'api', display_name: 'Sheets', config: { vendor: 'google', base_url: 'https://sheets.googleapis.com/v4' },
      auth: status.auth, granted_scopes: ['forged-grant'] }, undefined as never);
    const row = f.connections.get('api', 'sheets')!;
    expect(row.granted_scopes_json).toBeUndefined();
    const decoded = await f.decode(row);
    expect(decoded).toMatchObject({ type: 'managed_oauth', connection_id: 'remote-account' });
    expect(decoded).not.toHaveProperty('authorization_receipt');
    expect(row.auth_ciphertext).not.toContain('remote-account');
    await expect(f.handlers['collection.connection.update']({ kind: 'api', name: 'sheets', expected_updated_at: row.updated_at,
      patch: { config: { base_url: 'https://another-vendor.example' } } }, undefined as never)).rejects.toThrow('authorized vendor origin');
    expect(f.connections.get('api', 'sheets')?.config_json).toBe(row.config_json);
    const handler = createConnectionApiHandler({ decodeAuth: f.decode, persistAuth: async () => {}, managedOAuthFetch: f.service.fetch });
    const result = await handler(row, { method: 'GET', path: '/spreadsheets', 'query.pageToken': 'native-request-page' },
      { slug: 'google-sheets.list', risk_tier: 'read', input: {}, output: {} });
    expect(result).toMatchObject({ status: 200, result: { spreadsheets: [{ spreadsheetId: 'native-id', title: 'Native title' }], nextPageToken: 'native-page' } });
    expect(f.fetch.mock.calls.at(-1)?.[0]).toBe('https://api.nango.dev/proxy/v4/spreadsheets?pageToken=native-request-page');
    await expect(f.rpc({ action: 'delete_profile', id: saved.profile.id })).rejects.toThrow('Remove');
    expect(() => f.service.authorizeForSave(verified, 'https://sheets.googleapis.com/v4', 'again')).toThrow('Authorize');
  });
  it('rejects forged references and edited targets without consuming the rightful receipt', async () => {
    const f = setup(); const { start } = await f.authorize(); f.consent();
    const status = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (status.action !== 'status' || status.auth === undefined) throw new Error('missing authorization');
    const verified = status.auth;
    expect(() => f.service.authorizeForSave({ ...verified, connection_id: 'another-account' }, 'https://sheets.googleapis.com/v4', 'sheets')).toThrow('changed');
    expect(() => f.service.authorizeForSave(verified, 'https://evil.example', 'sheets')).toThrow('changed');
    expect(f.service.authorizeForSave(status.auth, 'https://sheets.googleapis.com/v4', 'sheets').auth).not.toHaveProperty('authorization_receipt');
  });
  it('retires expired, canceled and profile-stale flows; failed consent never creates a receipt', async () => {
    const f = setup(); const { start, saved } = await f.authorize(); f.failConsent();
    await expect(f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret })).rejects.toThrow('authorization failure');
    await f.rpc({ action: 'cancel', flow_id: start.flow_id, claim_secret: start.claim_secret });
    expect(await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret })).toMatchObject({ status: 'expired' });
    const another = await f.rpc({ action: 'start', profile_id: saved.profile.id, integration_id: 'sheets-production', base_url: 'https://sheets.googleapis.com/v4', scopes: [] });
    if (another.action !== 'start') throw new Error('fixture');
    await f.rpc({ action: 'save_profile', id: saved.profile.id, label: 'Renamed', broker: 'nango', base_url: saved.profile.base_url });
    await expect(f.rpc({ action: 'status', flow_id: another.flow_id, claim_secret: another.claim_secret })).rejects.toThrow('profile changed');
    f.tick(); expect(await f.rpc({ action: 'status', flow_id: another.flow_id, claim_secret: another.claim_secret })).toMatchObject({ status: 'expired' });
  });
  it('preserves unknown shared-app defaults instead of replacing them with an incomplete scope list', async () => {
    const f = setup(false); const { start } = await f.authorize();
    expect(start.scope_metadata).toBe('unknown'); expect(start.requested_scopes).toEqual([]);
    expect(f.sessions[0]).not.toHaveProperty('integrations_config_defaults');
    expect(f.sessions[0]).not.toHaveProperty('overrides');
  });
  it('reauthorizes the same remote ID and clears stale granted scope evidence', async () => {
    const f = setup(); const { saved, start } = await f.authorize(); f.consent();
    const result = await f.rpc({ action: 'status', flow_id: start.flow_id, claim_secret: start.claim_secret });
    if (result.action !== 'status' || result.auth === undefined) throw new Error('fixture');
    const { auth } = f.service.authorizeForSave(result.auth, 'https://sheets.googleapis.com/v4', 'sheets');
    const { encodeAuthForStorage } = await import('../connection-handler.js');
    const row = f.connections.upsert({ name: 'sheets', kind: 'api', display_name: 'Sheets', config_json: '{"base_url":"https://sheets.googleapis.com/v4","vendor":"google"}',
      auth_ciphertext: await encodeAuthForStorage({ ...auth,
        requested_scopes: [...auth.requested_scopes, 'https://www.googleapis.com/auth/spreadsheets.readonly'] },
      { name: 'sheets', kind: 'api' }, () => new Uint8Array(32).fill(9)),
      enrolled_at: 1, updated_at: 2, granted_scopes_json: '["previous-grant"]' });
    const reconnect = await f.rpc({ action: 'start', name: 'sheets', profile_id: saved.profile.id, integration_id: auth.integration_id,
      base_url: 'https://sheets.googleapis.com/v4', scopes: ['new-scope'] });
    if (reconnect.action !== 'start') throw new Error('fixture');
    expect(f.sessions.at(-1)).toMatchObject({ connection_id: 'remote-account', integration_id: 'sheets-production' });
    expect(reconnect.requested_scopes).toContain('previous-grant'); expect(reconnect.requested_scopes).toContain('new-scope');
    expect(reconnect.requested_scopes).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(reconnect.requested_scopes).not.toContain('https://www.googleapis.com/auth/spreadsheets.readonly');
    f.consent();
    const status = await f.rpc({ action: 'status', flow_id: reconnect.flow_id, claim_secret: reconnect.claim_secret });
    if (status.action !== 'status' || status.auth === undefined) throw new Error('fixture');
    await f.rpc({ action: 'save_reauthorization', name: row.name, expected_updated_at: row.updated_at,
      patch: { auth: status.auth } });
    expect(f.connections.get('api', 'sheets')?.granted_scopes_json).toBeUndefined();
    expect((await f.decode(f.connections.get('api', 'sheets')!)) as ManagedOAuthAuth).toMatchObject({ connection_id: 'remote-account' });
    const current = f.connections.get('api', 'sheets')!;
    const next = await f.rpc({ action: 'start', name: current.name, profile_id: saved.profile.id, integration_id: auth.integration_id,
      base_url: 'https://sheets.googleapis.com/v4', scopes: ['another-scope'] });
    if (next.action !== 'start') throw new Error('fixture');
    f.connections.upsert({ ...current, display_name: 'Changed at the same timestamp', updated_at: current.updated_at });
    await expect(f.rpc({ action: 'status', flow_id: next.flow_id, claim_secret: next.claim_secret })).rejects.toThrow('saved connection changed');
  });
});
