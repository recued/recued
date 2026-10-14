/** D-322 §26 — late reads, malformed data and review-only resume at the public UI boundary. */
import { describe, expect, it, vi } from 'vitest';
import { isManagedOAuthMigrationCandidate, isManagedOAuthMigrationView, type ManagedOAuthMigrationCandidate,
  type ManagedOAuthMigrationView, type ManagedOAuthRequest, type ManagedOAuthResponse } from '@recued/contracts';
import { createManagedOAuthMigrationPanel } from '../settings/managed-oauth-migration-panel.js';
const candidate: ManagedOAuthMigrationCandidate = { name: 'work', display_name: 'Work', updated_at: 2, base_url: 'https://sheets.googleapis.com/v4',
  vendor: 'google', authentication: 'direct_oauth', required_scopes: ['sheet-read'], verification_url: '' };
const view = (): ManagedOAuthMigrationView => ({ id: 'migration-fixture-001', created_at: 1, expires_at: 100000, state: 'ready',
  fingerprint: 'a'.repeat(64), requested_scopes: [], target: { authentication: 'broker', identity: { status: 'unknown', reason: 'unsupported' },
    broker: { id: 'cloud', label: 'Cloud', base_url: 'https://api.nango.dev', broker: 'nango', revision: 1 }, integration_id: 'sheets', connection_id: 'remote' },
  rows: [{ connection: candidate, state: 'failed', reason: 'access_failed', http_status: 403 }], warnings: ['Read checks do not prove writes.'] });
const fixture = (call: (args: ManagedOAuthRequest) => Promise<ManagedOAuthResponse>) => {
  const listeners = new Map<string, EventListener[]>();
  const doc = { activeElement: null, body: {}, createElement: () => element() };
  const element = () => ({ innerHTML: '', ownerDocument: doc, setAttribute() {}, contains: () => true,
    querySelector: () => null, querySelectorAll: () => [], appendChild() {},
    addEventListener: (name: string, fn: EventListener) => listeners.set(name, [...listeners.get(name) ?? [], fn]),
    removeEventListener() {} });
  const host = element(); const closed = vi.fn();
  const panel = createManagedOAuthMigrationPanel({ host: host as unknown as HTMLElement, call, closed });
  const click = (action: string, resume?: string) => {
    const button = { dataset: { bulkAction: action, bulkResume: resume }, disabled: false, closest() { return this; } };
    for (const listener of listeners.get('click') ?? []) listener({ target: button, preventDefault() {} } as unknown as Event);
  };
  return { panel, host, click, closed };
};
describe('D-322 bulk migration UI', () => {
  it('keeps a stop result when an older status reply arrives afterwards', async () => {
    let finish!: (r: ManagedOAuthResponse) => void; let statuses = 0;
    const old = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const reviewed = view();
    const f = fixture(async args => {
      if (args.action === 'migration_candidates') return { action: args.action, candidates: [candidate] };
      if (args.action === 'migration_stop') return { action: args.action, migration: { ...reviewed, state: 'stopped' } };
      if (++statuses > 1) return old;
      return { action: 'migration_status', migrations: [reviewed] };
    });
    await f.panel.load(); f.click('', reviewed.id); f.click('refresh'); f.click('stop');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.host.innerHTML).toContain('Migration: stopped');
    finish({ action: 'migration_status', migrations: [reviewed] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.host.innerHTML).toContain('Migration: stopped'); f.panel.dispose();
  });
  it('selects the reviewed service when resuming its remaining connections', async () => {
    const outlook = { ...candidate, name: 'outlook', display_name: 'Outlook', base_url: 'https://graph.microsoft.com/v1.0', vendor: 'microsoft' };
    const reviewed = { ...view(), rows: [{ connection: outlook, state: 'failed' as const, reason: 'access_failed' as const }] };
    const f = fixture(async args => args.action === 'migration_candidates'
      ? { action: args.action, candidates: [candidate, outlook] }
      : args.action === 'migration_stop' ? { action: args.action, migration: { ...reviewed, state: 'stopped' } }
        : { action: 'migration_status', migrations: [reviewed] });
    await f.panel.load(); f.click('', reviewed.id); f.click('again');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.host.innerHTML).toContain('data-bulk-select="outlook" checked');
    expect(f.host.innerHTML).not.toContain('data-bulk-select="work"'); f.panel.dispose();
  });
  it('rejects malformed candidates and impossible checked rows', () => {
    expect(isManagedOAuthMigrationCandidate(candidate)).toBe(true);
    expect(isManagedOAuthMigrationCandidate({ ...candidate, base_url: 'javascript:bad()' })).toBe(false);
    expect(isManagedOAuthMigrationView(view())).toBe(true);
    expect(isManagedOAuthMigrationView({ ...view(), rows: [{ connection: candidate, state: 'verified' }] })).toBe(false);
    expect(isManagedOAuthMigrationView({ ...view(), rows: [{ connection: candidate, state: 'failed', reason: ['changed'] }] })).toBe(false);
  });
  it('drops a late candidates reply after disposal', async () => {
    let finish!: (r: ManagedOAuthResponse) => void;
    const delayed = new Promise<ManagedOAuthResponse>(resolve => { finish = resolve; });
    const f = fixture(async () => delayed); const loaded = f.panel.load(); const before = f.host.innerHTML;
    f.panel.dispose(); finish({ action: 'migration_candidates', candidates: [candidate] }); await loaded;
    expect(f.host.innerHTML).toBe(before);
  });
  it('does not render a malformed candidate or guess it is eligible', async () => {
    const f = fixture(async () => ({ action: 'migration_candidates', candidates: [{ ...candidate, base_url: 'not a URL' }] }));
    await f.panel.load(); expect(f.host.innerHTML).toContain('could not be confirmed');
    expect(f.host.innerHTML).not.toContain('not a URL'); f.panel.dispose();
  });
  it('resumes recent reviews without sending consent or apply requests', async () => {
    const calls: ManagedOAuthRequest[] = [];
    const f = fixture(async args => { calls.push(args); return args.action === 'migration_candidates'
      ? { action: 'migration_candidates', candidates: [candidate] } : { action: 'migration_status', migrations: [view()] }; });
    await f.panel.load(); f.click('', view().id);
    expect(f.host.innerHTML).toContain('Kept saved authentication');
    expect(f.host.innerHTML).toContain('HTTP 403');
    expect(calls.map(r => r.action)).toEqual(['migration_candidates', 'migration_status']); f.panel.dispose();
  });
});
