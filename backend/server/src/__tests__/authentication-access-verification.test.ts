import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, isAuthenticationAccessPreview, isAuthenticationAccessVerification, type AuthenticationAccessPreview,
  type AuthenticationAccessVerification, type AuthenticationAccessSelection, type AuthenticationRepairTarget, type AuthenticationRepairWorklist, type OAuthAppRenewalVerification } from '@recued/contracts';
import { createAuthenticationAccessVerification, type PreparedAuthenticationAccess } from '../authentication-access-verification.js';
import { createAuthenticationRepairActionStore } from '../authentication-repair-action-store.js';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { makeConnectionHandlers } from '../connection-handler.js';
import { createOAuthAppRenewalHistory } from '../oauth-app-renewal-history.js';

const dbs: Database.Database[] = []; afterEach(() => { vi.useRealTimers(); dbs.splice(0).forEach(db => db.close()); });
const nonce = () => randomBytes(32).toString('base64url');
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 1000;
  let revision = 'b'.repeat(64); let blocked = false;
  const target: AuthenticationRepairTarget = { kind: 'connection', name: 'work' };
  const inventory: AuthenticationRepairWorklist = { observed_at: clock, unavailable: [], groups: [{ id: 'a'.repeat(64), label: 'Work', kind: 'account', authentication: 'direct_oauth',
    connection_names: ['work'], targets: [target], issues: [], usage_available: true, uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }, { kind: 'schedule', id: 'daily', label: 'Daily import' }] }] };
  const run = vi.fn<PreparedAuthenticationAccess['run']>(async () => [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }]);
  const prepare = vi.fn(async (t: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess> => {
    if (blocked) throw new RpcError('locked', 'never-export-locked-secret');
    return { descriptor: { label: t.kind === 'connection' ? 'API: ' + t.name : 'Account', authentication_revision: revision,
      check: t.kind === 'connection' ? 'api_read' : t.kind === 'collection' ? 'collection_read' : t.kind === 'file_source' ? 'file_metadata' : 'unsupported',
      ...(t.kind === 'connection' ? { base_url: 'https://vendor.test/v1' } : {}) }, run };
  });
  const inventoryRead = vi.fn(async () => inventory);
  const create = () => createAuthenticationAccessVerification({ db, inventory: inventoryRead, prepare, now: () => clock });
  const service = create(); const selection = { kind: 'group' as const, id: inventory.groups[0]!.id };
  const preview = async (selected: AuthenticationAccessSelection = selection): Promise<AuthenticationAccessPreview> => {
    const reply = await service.handle({ action: 'authentication_access_preview', selection: selected });
    if (reply.action !== 'authentication_access_preview') throw new Error('preview'); return reply.preview;
  };
  const start = async (p: AuthenticationAccessPreview, attempt_id = nonce(), url = 'https://vendor.test/v1/protected?fields=id') => {
    const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id, choices: [{ target_id: p.targets[0]!.id, url }] };
    const reply = await service.handle(request); if (reply.action !== request.action) throw new Error('run'); return { request, verification: reply.verification };
  };
  const status = async (id: string): Promise<AuthenticationAccessVerification> => {
    const reply = await service.handle({ action: 'authentication_access_status', id });
    if (reply.action !== 'authentication_access_status') throw new Error('status'); return reply.verification;
  };
  const finished = async (id: string): Promise<AuthenticationAccessVerification> => {
    let value = await status(id); await vi.waitFor(async () => { value = await status(id); expect(value.status).toBe('completed'); }); return value;
  };
  return { db, service, create, inventory, inventoryRead, target, selection, prepare, run, preview, start, status, finished,
    time: (v: number) => { clock = v; }, revision: (v: string) => { revision = v; }, locked: (v: boolean) => { blocked = v; } };
};

describe('explicit saved-authentication access jobs', () => {
  it('releases closed reviews without cancelling a reserved job or breaking a lost-reply retry', async () => {
    const f = fixture();
    for (let i = 0; i < 70; i++) {
      const p = await f.preview(); expect(await f.service.handle({ action: 'authentication_access_retire', review_id: p.id })).toEqual({ action: 'authentication_access_retire' });
      await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' });
    }
    let release!: () => void; f.run.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const first = await f.start(p); await f.service.handle({ action: 'authentication_access_retire', review_id: p.id });
    const retry = await f.service.handle(first.request); expect('verification' in retry && retry.verification.id).toBe(first.verification.id);
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('honors review retirement during asynchronous final validation', async () => {
    const f = fixture(); const p = await f.preview(); const normal = f.prepare.getMockImplementation()!; let entered!: () => void; let release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementationOnce(async target => { entered(); await gate; return normal(target); });
    const starting = f.start(p); const rejected = expect(starting).rejects.toMatchObject({ code: 'conflict' }); await entering;
    await f.service.handle({ action: 'authentication_access_retire', review_id: p.id }); release(); await rejected; expect(f.run).not.toHaveBeenCalled();
  });
  it('reserves the preview capacity before asynchronous inventory reads', async () => {
    const f = fixture(); const results = await Promise.allSettled(Array.from({ length: 65 }, () => f.preview()));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(64);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1); expect(f.run).not.toHaveBeenCalled();
  });
  it('refuses a review that expires during asynchronous final validation', async () => {
    const f = fixture(); const p = await f.preview(); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { const saved = await normal(target); f.time(p.expires_at); return saved; });
    await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' }); expect(f.run).not.toHaveBeenCalled();
  });
  it('prepares locally, saves per-target results, and leaves workflows, repair status and sync untouched', async () => {
    const f = fixture(); const p = await f.preview(); expect(isAuthenticationAccessPreview(p)).toBe(true); expect(f.run).not.toHaveBeenCalled();
    const { verification } = await f.start(p); const done = await f.finished(verification.id);
    expect(isAuthenticationAccessVerification(done)).toBe(true); expect(done.results[0]).toMatchObject({ target: f.target, current: 'yes', authentication_revision: 'b'.repeat(64),
      checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] });
    expect(done.uses).toEqual(f.inventory.groups[0]!.uses); expect(f.run).toHaveBeenCalledTimes(1);
    const decorated = await f.service.worklist(f.inventory); expect(decorated.groups[0]!.access_verification?.id).toBe(done.id);
    expect(f.inventory.groups[0]!.access_verification).toBeUndefined();
    await f.status(done.id); await f.service.worklist(f.inventory); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('returns a checking receipt before a slow vendor finishes and deduplicates a lost start reply', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const first = await f.start(p); expect(first.verification.status).toBe('checking');
    const replay = await f.service.handle(first.request); expect('verification' in replay && replay.verification.id).toBe(first.verification.id);
    const duplicate = await f.service.handle({ ...first.request, attempt_id: nonce() }); expect('verification' in duplicate && duplicate.verification.id).toBe(first.verification.id);
    await expect(f.service.handle({ ...first.request, choices: [] })).rejects.toMatchObject({ code: 'conflict' });
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous starts and rejects a different check for an already running selection', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const [first, second] = await Promise.all([f.start(p), f.start(p)]);
    expect(first.verification.id).toBe(second.verification.id);
    await expect(f.start(p, nonce(), 'https://vendor.test/v1/other')).rejects.toMatchObject({ code: 'conflict' });
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('rejects stale permission, membership, expired and malformed reviews before vendor work', async () => {
    const f = fixture(); const p = await f.preview(); f.revision('c'.repeat(64)); await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.run).not.toHaveBeenCalled(); const next = await f.preview(); f.inventory.groups[0]!.uses.push({ kind: 'recipe', id: 'new', label: 'New recipe' });
    await expect(f.start(next)).rejects.toMatchObject({ code: 'conflict' });
    const expired = await f.preview(); f.time(expired.expires_at); await expect(f.start(expired)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.handle({ action: 'authentication_access_preview', selection: { kind: 'group', id: 'invalid' } })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each(['https://evil.test/v1/account', 'https://vendor.test/v1/../private', 'https://vendor.test/v1/protected?access_token=secret'])('rejects an unsafe resource before a job is reserved: %s', async url => {
    const f = fixture(); await expect(f.start(await f.preview(), nonce(), url)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.run).not.toHaveBeenCalled(); expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
  });
  it('continues per target after failure and never copies raw errors or resource URLs into the receipt', async () => {
    const f = fixture(); f.inventory.groups[0]!.targets.push({ kind: 'connection', name: 'second' });
    f.run.mockRejectedValueOnce(new RpcError('credential_verification_failed', 'never-export-secret', 422, undefined, { verification_status: 'auth_failed' }));
    const { verification } = await f.start(await f.preview()); const done = await f.finished(verification.id);
    expect(done.results[0]!.checks[0]).toEqual({ kind: 'api_read', status: 'failed', reason: 'access_rejected' }); expect(done.results[1]!.checks[0]!.status).toBe('passed');
    expect(f.run).toHaveBeenCalledTimes(2); expect(JSON.stringify(f.db.prepare('SELECT * FROM authentication_access_verifications').all())).not.toMatch(/never-export|https:|fields=id/);
  });
  it('fences an authentication change during a successful read and supersedes earlier results on read', async () => {
    const f = fixture(); f.run.mockImplementationOnce(async () => { f.revision('d'.repeat(64)); return [{ kind: 'api_read', status: 'passed' }]; });
    const started = await f.start(await f.preview()); const done = await f.finished(started.verification.id);
    expect(done.results[0]).toMatchObject({ current: 'no', checks: [{ status: 'unconfirmed', reason: 'changed' }] });
    f.run.mockResolvedValue([{ kind: 'api_read', status: 'passed' }]); const fresh = await f.start(await f.preview()); await f.finished(fresh.verification.id);
    f.revision('e'.repeat(64)); expect((await f.status(fresh.verification.id)).results[0]!.current).toBe('no');
    f.locked(true); expect((await f.status(fresh.verification.id)).results[0]!.current).toBe('unknown');
  });
  it('retains a completed check after restart and closes interrupted work without replay', async () => {
    const f = fixture(); const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    done.status = 'checking'; delete done.finished_at; done.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    f.db.prepare('UPDATE authentication_access_verifications SET data = ?, finished_at = NULL WHERE id = ?').run(JSON.stringify(done), done.id);
    const restarted = f.create(); const read = await restarted.handle({ action: 'authentication_access_status', id: done.id });
    expect('verification' in read && read.verification).toMatchObject({ status: 'completed', results: [{ checks: [{ reason: 'interrupted' }] }] });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('retains checks started from the worklist in scoped history after authentication changes', async () => {
    const f = fixture(); const start = await f.start(await f.preview()); await f.finished(start.verification.id); f.revision('e'.repeat(64));
    const history = createAuthenticationIncidentStore(f.db);
    const page = await f.service.history(history.history({ scope: f.target }, 1000));
    expect(page.order).toEqual([start.verification.id]); expect(page.verifications).toHaveLength(1);
    expect(page.verifications![0]!.results[0]!.current).toBe('no');
    expect(history.history({ scope: { kind: 'group', id: f.selection.id } }, 1000).verifications).toHaveLength(1);
    expect(history.history({ scope: { kind: 'connection', name: 'unrelated' } }, 1000).verifications).toHaveLength(0);
  });
  it('reserves the source receipt and history atomically before any vendor work', async () => {
    const f = fixture(); const plan = await f.preview();
    f.db.exec("CREATE TRIGGER deny_verification BEFORE INSERT ON authentication_incident_history WHEN NEW.kind = 'verification' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    await expect(f.start(plan)).rejects.toThrow('receipt failure'); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
  });
  it('bounds an ignored vendor abort and prevents late success from changing the saved outcome', async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: () => void; let signal: AbortSignal | undefined;
    f.run.mockImplementation(async (_choice, incoming) => { signal = incoming; await new Promise<void>(resolve => { release = resolve; }); return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await f.start(await f.preview()); for (let i = 0; i < 20; i++) await Promise.resolve(); expect(release).toBeDefined();
    await vi.advanceTimersByTimeAsync(65_000); expect(signal?.aborted).toBe(true);
    expect((await f.status(first.verification.id)).results[0]!.checks[0]).toMatchObject({ status: 'unconfirmed', reason: 'unavailable' });
    release(); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((await f.status(first.verification.id)).results[0]!.checks[0]!.status).toBe('unconfirmed'); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('associates exact applied-repair targets, keeps old incidents separate, and decorates only the matching action', async () => {
    const f = fixture(); const repairs = createAuthenticationRepairActionStore(f.db); const history = createAuthenticationIncidentStore(f.db);
    repairs.begin('connection_credentials', 'apply', { action: 'reauthorize', targets: [f.target] }, 900); repairs.finish('connection_credentials', 'apply', { status: 'applied' }, 950);
    const action = history.history({ scope: { kind: 'all' } }, 1000).repairs![0]!;
    const reply = await f.service.handle({ action: 'authentication_access_preview', selection: { kind: 'repair', id: action.id } });
    if (reply.action !== 'authentication_access_preview') throw new Error('preview'); const start = await f.start(reply.preview); await f.finished(start.verification.id);
    const decorated = await f.service.history(history.history({ scope: { kind: 'all' } }, 1000));
    expect(decorated.repairs![0]).toMatchObject({ status: 'applied', access_verification: { status: 'completed' } });
    expect(decorated.repairs![0]!.recovery_confirmed_at).toBeUndefined(); expect(decorated.incidents).toEqual([]);
  });
  it('expires retained results after 90 days and refuses unsupported injected results', async () => {
    const f = fixture(); f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'passed', reason: 'not_executed' }]);
    const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    expect(done.results[0]!.checks[0]).toMatchObject({ status: 'unconfirmed', reason: 'unavailable' });
    f.time(1000 + 91 * 86_400_000); await expect(f.status(done.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.service.worklist(f.inventory)).groups[0]!.access_verification).toBeUndefined();
  });
  it('routes all access actions through the existing owner-managed authentication handler', async () => {
    const f = fixture(); const connections = createConnectionStore(f.db);
    const handler = makeConnectionHandlers({ store: connections, authenticationAccess: f.service, authenticationRepairs: async () => f.inventory })!;
    const reply = await handler.handlers['collection.connection.managedOAuth']({ action: 'authentication_access_preview', selection: f.selection }, undefined as never);
    expect(reply.action).toBe('authentication_access_preview'); expect(f.run).not.toHaveBeenCalled();
    const old = makeConnectionHandlers({ store: connections })!;
    await expect(old.handlers['collection.connection.managedOAuth']({ action: 'authentication_access_preview', selection: f.selection }, undefined as never)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('access verification from retained token-renewal results', () => {
  const retain = (f: ReturnType<typeof fixture>, targets: AuthenticationRepairTarget[] = []) => {
    const value: OAuthAppRenewalVerification = { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 1,
      app_label: 'Work app', status: 'completed', started_at: 800, finished_at: 900, incomplete: false,
      results: [{ id: 'c'.repeat(64), revision: 'd'.repeat(64), label: 'Shared API', connections: ['work'], native_accounts: [], eligible: true, status: 'passed', current: 'yes' },
        { id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Native calendar', connections: [], native_accounts: [{ platform: 'calendar', slug: 'native' }],
          eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'yes' }] };
    createOAuthAppRenewalHistory(f.db).begin(value, 800, { groups: [f.selection.id], targets });
    return { value, selection: { kind: 'renewal' as const, id: value.id } };
  };
  const start = async (f: ReturnType<typeof fixture>, p: AuthenticationAccessPreview) => {
    const reply = await f.service.handle({ action: 'authentication_access_run', review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(),
      choices: p.targets.filter(t => t.check === 'api_read').map(t => ({ target_id: t.id, url: 'https://vendor.test/v1/protected' })) });
    if (reply.action !== 'authentication_access_run') throw Error('run'); return reply.verification;
  };
  it.each(['vault locked', 'source evicted', 'inventory unavailable', 'review capacity full'] as const)('resumes saved status when fresh preparation is blocked: %s', async why => {
    const f = fixture(); const r = retain(f); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await start(f, await f.preview(r.selection)); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    let resumed: AuthenticationAccessPreview | undefined;
    try {
      if (why === 'vault locked') f.locked(true);
      if (why === 'source evicted') f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id);
      if (why === 'inventory unavailable') f.inventoryRead.mockRejectedValue(new Error('local inventory unavailable'));
      if (why === 'review capacity full') for (let i = 0; i < 64; i++) await f.preview();
      resumed = await f.preview(r.selection);
      expect(isAuthenticationAccessPreview(resumed)).toBe(true); expect(resumed.running?.id).toBe(first.id);
      expect(f.run).toHaveBeenCalledTimes(1);
      await expect(start(f, resumed)).rejects.toMatchObject({ code: 'conflict' });
      expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 });
    } finally { f.locked(false); release(); await f.finished(first.id); }
    await expect(start(f, resumed!)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 });
  });
  it('retains only the typed selection identity and isolates it from caller metadata and later mutation', async () => {
    const f = fixture(); const r = retain(f); const selected = { ...r.selection, client_secret: 'private-extra-selection', url: 'https://vendor.test/private-extra-selection' };
    const p = await f.preview(selected); expect.soft(p.selection).toEqual(r.selection);
    const v = await start(f, p); await f.finished(v.id);
    expect.soft(JSON.stringify(f.db.prepare('SELECT data FROM authentication_access_verifications').all())).not.toContain('private-extra-selection');
    expect.soft(JSON.stringify(f.db.prepare("SELECT data FROM authentication_incident_history WHERE kind = 'verification'").all())).not.toContain('private-extra-selection');
    selected.id = 'renewal-22345678-1234-4123-8123-123456789abc'; expect(p.selection).toEqual(r.selection);
  });
  it('reviews retained API, native, connection-backed collection and file references without broadening to other app uses', async () => {
    const f = fixture(); const mail: AuthenticationRepairTarget = { kind: 'collection', platform: 'mail', slug: 'bound' };
    const file: AuthenticationRepairTarget = { kind: 'file_source', source_id: 'files-work' };
    f.inventory.groups[0]!.targets.push(mail, file);
    f.inventory.groups.push({ ...f.inventory.groups[0]!, id: '9'.repeat(64), connection_names: ['unrelated'], targets: [{ kind: 'connection', name: 'unrelated' }] });
    const r = retain(f, [mail, file]); const p = await f.preview(r.selection);
    expect(isAuthenticationAccessPreview(p)).toBe(true); expect(f.run).not.toHaveBeenCalled();
    expect(p.targets.map(t => t.target)).toEqual(expect.arrayContaining([f.target, mail, file, { kind: 'collection', platform: 'calendar', slug: 'native' }]));
    expect(p.targets).toHaveLength(4); expect(p.uses).toEqual(f.inventory.groups[0]!.uses);
    expect(p.label).toContain('Current saved authentication');
    const original = f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(r.value.id);
    const v = await start(f, p); const done = await f.finished(v.id);
    expect(done.selection).toEqual(r.selection); expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(r.value.id)).toEqual(original);
    const history = createAuthenticationIncidentStore(f.db);
    for (const scope of [{ kind: 'oauth_apps' as const }, { kind: 'group' as const, id: f.selection.id }, mail, file, f.target]) {
      expect(history.history({ scope, include_renewals: true }, 1000).verifications!.map(v => v.id)).toContain(done.id);
    }
    expect(history.history({ scope: { kind: 'connection', name: 'unrelated' } }, 1000).verifications).toEqual([]);
    expect(history.history({ scope: { kind: 'all' } }, 1000).incidents).toEqual([]);
  });
  it('resumes the matching active access receipt without replaying a vendor read', async () => {
    const f = fixture(); const r = retain(f); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await start(f, await f.preview(r.selection)); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const reopened = await f.preview(r.selection); expect(reopened.running?.id).toBe(first.id); expect(isAuthenticationAccessPreview(reopened)).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1); release(); await f.finished(first.id);
    expect((await f.preview(r.selection)).running).toBeUndefined();
  });
  it('uses only explicit references from older receipts and declares missing coverage', async () => {
    const f = fixture(); const r = retain(f); f.db.prepare('DELETE FROM authentication_incident_targets WHERE incident_id = ?').run(r.value.id);
    const p = await f.preview(r.selection); expect(p.targets.map(t => t.target)).toEqual([f.target, { kind: 'collection', platform: 'calendar', slug: 'native' }]);
    expect(p.targets_truncated).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('bounds retained references and carries incomplete inventory into access evidence', async () => {
    const f = fixture(); const extra: AuthenticationRepairTarget[] = Array.from({ length: 35 }, (_, i) => ({ kind: 'connection', name: 'copy-' + i }));
    const r = retain(f, extra); const p = await f.preview(r.selection);
    expect(p.targets).toHaveLength(32); expect(p.targets_truncated).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('blocks unfinished, expired and evicted renewal receipts before any vendor work', async () => {
    const f = fixture(); const r = retain(f);
    f.db.prepare('UPDATE authentication_incident_history SET ended_at = NULL, data = ? WHERE id = ?')
      .run(JSON.stringify({ ...r.value, status: 'checking', finished_at: undefined }), r.value.id);
    await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'bad_request' });
    f.db.prepare('UPDATE authentication_incident_history SET ended_at = 900, data = ? WHERE id = ?').run(JSON.stringify(r.value), r.value.id);
    f.time(91 * 86_400_000); await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'not_found' });
    f.time(1000); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id);
    await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'not_found' }); expect(f.run).not.toHaveBeenCalled();
  });
  it('fences authentication, retained membership and source eviction during final validation', async () => {
    const f = fixture(); const r = retain(f); const p = await f.preview(r.selection);
    f.revision('8'.repeat(64)); await expect(start(f, p)).rejects.toMatchObject({ code: 'conflict' });
    const changed = await f.preview(r.selection);
    f.db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(r.value.id, JSON.stringify({ kind: 'connection', name: 'added' }));
    await expect(start(f, changed)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await f.preview(r.selection); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { const p = await normal(target); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id); return p; });
    await expect(start(f, fresh)).rejects.toMatchObject({ code: 'not_found' }); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
  });
});
