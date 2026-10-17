import { describe, expect, it, vi } from 'vitest';
import type { AuthenticationIncidentHistoryPage, AuthenticationIncidentHistoryCaller, AuthenticationIncidentScope, AuthenticationRepairAction, AuthenticationRenewalHistory, AuthenticationAccessVerification } from '@recued/contracts';
import { authenticationIncidentHistoryHref, renderAuthenticationManagement } from '@recued/ui-shared';
import { parseConnectionsIncidentHistory } from '../connections/connections-navigation.js';
import { parseShellRoute } from '../shell/route.js';
import { createAuthenticationIncidentPanel } from '../connections/authentication-incident-panel.js';
import type { OAuthAppsCaller } from '../settings/oauth-apps-panel.js';

class Element {
  children: Element[] = []; attrs = new Map<string, string>(); listeners = new Map<string, () => void>();
  textContent = ''; className = ''; type = ''; disabled = false;
  focus?: (options?: FocusOptions) => void;
  get firstChild(): Element | null { return this.children[0] ?? null; }
  appendChild(child: Element): void { this.children.push(child); }
  removeChild(child: Element): void { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  addEventListener(key: string, fn: () => void): void { this.listeners.set(key, fn); }
  click(): void { if (!this.disabled) this.listeners.get('click')?.(); }
  text(): string { return this.textContent + ' ' + this.children.map(child => child.text()).join(' '); }
  find(key: string, value: string): Element | undefined { return this.attrs.get(key) === value ? this : this.children.map(c => c.find(key, value)).find(Boolean); }
  querySelector(selector: string): Element | null {
    const match = /^\[([^=]+)="([^"]+)"\]$/.exec(selector); return match ? this.find(match[1]!, match[2]!) ?? null : null;
  }
}
const page = (scope: AuthenticationIncidentScope = { kind: 'connection', name: 'work' }): AuthenticationIncidentHistoryPage => ({ scope, observed_at: 200, retention_days: 90,
  incidents: [{ id: '12345678-1234-4123-8123-123456789abc', status: 'retired', started_at: 100, last_problem_at: 150, history_started_at: 100, ended_at: 200,
    retirement_reason: 'authentication_changed', currently_reported: false, level: 'rejected', events_truncated: false, details_truncated: false,
    events: [{ kind: 'opened', at: 100, level: 'rejected' }, { kind: 'retired', at: 200, level: 'rejected' }],
    group: { id: 'a'.repeat(64), kind: 'account', label: '<script>Work</script>', authentication: 'direct_oauth', connection_names: ['work'],
      issues: [], uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }], targets: [{ kind: 'connection', name: 'work' }], usage_available: false } }] });
const mount = (call?: AuthenticationIncidentHistoryCaller, scope: AuthenticationIncidentScope = { kind: 'connection', name: 'work' }, shortcuts?: { renewal?: OAuthAppsCaller; navigate?(hash: string): void; verify?: import('../settings/managed-oauth-panel.js').ManagedOAuthCaller }) => {
  const host = new Element(); const body = new Element();
  const doc = { body, activeElement: body, createElement: () => {
    const element = new Element(); element.focus = () => { doc.activeElement = element; }; return element;
  } };
  const panel = createAuthenticationIncidentPanel({ document: doc as unknown as Document,
    scope, ...(call ? { call } : {}), ...shortcuts }); panel.mount(host as unknown as HTMLElement); return { host, panel, doc };
};

describe('connection incident history owner UI', () => {
  const renewal = (): AuthenticationRenewalHistory => ({ id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 2,
    app_label: '<script>Work app</script>', started_at: 100, history_started_at: 180, finished_at: 150, status: 'completed', incomplete: true, references_incomplete: true,
    results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work API', connections: ['work'], native_accounts: [], eligible: true, status: 'passed', current: 'no' },
      { id: '1'.repeat(64), revision: '2'.repeat(64), label: 'Work Mail', connections: [], native_accounts: [{ platform: 'mail', slug: 'work' }],
        eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown' }] });
  it('offers an opaque access-review entry only for completed renewal history without starting checks', async () => {
    const v = renewal(); const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    const verify = vi.fn<import('../settings/managed-oauth-panel.js').ManagedOAuthCaller>();
    const f = mount(async () => data, data.scope, { verify }); await f.panel.whenLoaded();
    expect(f.host.find('data-renewal-verify-access', v.id)?.attrs.get('href')).toBe('#connections/others/verify-access/renewal/' + v.id);
    expect(verify).not.toHaveBeenCalled();
    v.status = 'checking'; delete v.finished_at; v.results[0]!.status = 'unconfirmed'; v.results[0]!.reason = 'not_checked';
    await f.panel.refresh(); expect(f.host.find('data-renewal-verify-access', v.id)).toBeUndefined(); expect(verify).not.toHaveBeenCalled(); f.panel.dispose();
  });
  it('opens only a freshly compared renewal repair and offers a new verification review', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    const read = vi.fn<OAuthAppsCaller>(async () => ({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: v }));
    const navigate = vi.fn(); const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    expect(read).not.toHaveBeenCalled(); expect(f.host.text()).toContain('Re-authorize API: work');
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); await f.panel.whenLoaded();
    expect(read).toHaveBeenCalledExactlyOnceWith({ action: 'renewal_status', id: v.id });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('#connections/others/review-access/api/work/from-renewal/google/default');
    f.host.find('data-renewal-shortcut', v.id + ':verify')!.click(); await f.panel.whenLoaded();
    expect(navigate).toHaveBeenLastCalledWith('#connections/others/oauth-apps/google/default/renewal'); f.panel.dispose();
  });
  it('retains history and blocks a stale repair without starting consent or renewal', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'client_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id]; const fresh = structuredClone(v); fresh.results[0]!.current = 'unknown';
    const read = vi.fn<OAuthAppsCaller>(async () => ({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: fresh }));
    const navigate = vi.fn(); const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); await f.panel.whenLoaded();
    expect(navigate).not.toHaveBeenCalled(); expect(f.host.text()).toContain('could not be compared'); expect(f.host.text()).toContain('Saved renewal results');
    expect(read.mock.calls.map(([r]) => r.action)).toEqual(['renewal_status']);
    await f.panel.refresh(); expect(f.host.text()).not.toContain('The app or authorization changed, or could not be compared.'); f.panel.dispose();
  });
  it('drops a pending shortcut when the owner leaves history', async () => {
    const v = renewal(); Object.assign(v.results[0]!, { status: 'failed', reason: 'grant_rejected', current: 'yes' });
    const data = page(); data.incidents = []; data.repairs = []; data.renewals = [v]; data.order = [v.id];
    let release!: (reply: Awaited<ReturnType<OAuthAppsCaller>>) => void;
    const read = vi.fn<OAuthAppsCaller>(() => new Promise(resolve => { release = resolve; })); const navigate = vi.fn();
    const f = mount(async () => data, data.scope, { renewal: read, navigate }); await f.panel.whenLoaded();
    f.host.find('data-renewal-shortcut', v.id + ':' + v.results[0]!.id + ':0')!.click(); const waiting = f.panel.whenLoaded(); f.panel.dispose();
    release({ action: 'renewal_status', apps: [{ issuer: 'google', id: 'default', label: 'Work', client_id: 'client', revision: 2, has_secret: true }], renewal_verification: v });
    await waiting; expect(navigate).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(1);
  });
  const repair = (): AuthenticationRepairAction => ({ id: 'repair-' + 'b'.repeat(64), action: 'reauthorize', status: 'applied', started_at: 110, finished_at: 120,
    from: { type: 'direct_oauth', app_id: 'work app' }, to: { type: 'broker', broker_profile_id: 'team', broker_account_id: 'chosen-account' }, targets: [{ kind: 'connection', name: 'work' }],
    targets_truncated: false, incidents: [{ id: page().incidents[0]!.id, group_id: 'a'.repeat(64), label: 'Work' }], incidents_truncated: false });
  it('renders renewal, access, repair and incident entries in one order with distinct evidence and counts', async () => {
    const data = page(); const token = renewal(); const action = repair();
    const check: AuthenticationAccessVerification = { id: 'verify-12345678-1234-4123-8123-123456789abc', selection: { kind: 'repair', id: action.id },
      started_at: 130, finished_at: 140, status: 'completed', results: [{ id: '3'.repeat(64), label: 'API read', target: { kind: 'connection', name: 'work' },
        authentication_revision: '4'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] }], targets_truncated: false, uses: [], usage_available: true };
    Object.assign(check, { app_revision: 2 }); Object.assign(data.incidents[0]!, { results: [], action: 'extra_server_field' });
    data.renewals = [token]; data.repairs = [action]; data.verifications = [check]; data.order = [token.id, check.id, action.id, data.incidents[0]!.id];
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(data); const { host, panel } = mount(call); await panel.whenLoaded();
    expect(host.find('data-authentication-renewal', token.id)).toBeDefined(); expect(host.find('data-authentication-verification', token.id)).toBeUndefined();
    const text = host.text(); expect(text).toContain('1 renewal check shown'); expect(text).toContain('1 access check shown');
    expect(text.indexOf('Token renewal verification')).toBeLessThan(text.indexOf('Access verification'));
    expect(text.indexOf('Access verification')).toBeLessThan(text.indexOf('Reauthorize'));
    for (const label of ['Added to history:', 'Superseded', 'could not be compared', 'excluded from the check', 'does not prove data access', 'Some local authorizations', 'Some account or file references were not recorded']) expect(text).toContain(label);
    expect(host.find('href', '#connections/mail/work')).toBeDefined();
    expect(call).toHaveBeenCalledOnce(); expect(call).toHaveBeenCalledWith({ scope: data.scope, include_renewals: true }); panel.dispose();
  });
  it('pages renewal-only results, refreshes saved progress and retains them after invalid replies', async () => {
    const first = renewal(); first.status = 'checking'; delete first.finished_at;
    first.results[0]!.status = 'unconfirmed'; first.results[0]!.reason = 'not_checked';
    const second = renewal(); second.id = 'renewal-22345678-1234-4123-8123-123456789abc';
    const base = { ...page(), incidents: [], repairs: [] };
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce({ ...base, renewals: [first], order: [first.id], next_cursor: 'older' })
      .mockResolvedValueOnce({ ...base, renewals: [second], order: [second.id] }).mockResolvedValueOnce({ ...base, renewals: [second], order: ['unknown'] });
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).toContain('running in the background');
    expect(host.text()).not.toContain('No incidents have been recorded'); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(host.text()).toContain('2 renewal checks shown'); expect(call.mock.calls[1]![0]).toMatchObject({ include_renewals: true, cursor: 'older' });
    await panel.refresh(); expect(host.text()).toContain('History could not be refreshed'); expect(host.find('data-authentication-renewal', first.id)).toBeDefined(); panel.dispose();
  });
  it('renders repair results and related-incident links in the server-provided history order', async () => {
    const data = page(); const action = repair(); data.repairs = [action]; data.order = [action.id, data.incidents[0]!.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded();
    expect(host.text()).toContain('Authentication updated'); expect(host.text()).toContain('Later successful operations are needed');
    expect(host.text()).toContain('1 repair action shown'); expect(host.text()).toContain('From: Recued direct OAuth'); expect(host.text()).toContain('Broker profile: team');
    expect(host.text()).toContain('Broker account: chosen-account');
    expect(host.text().indexOf('Reauthorize')).toBeLessThan(host.text().indexOf('<script>Work</script>'));
    expect(host.find('href', '#connections/others/incident-history/group/' + 'a'.repeat(64))).toBeDefined(); panel.dispose();
  });
  it('labels confirmed later operations separately and keeps unverified secret rotation explicit', async () => {
    const data = page(); data.incidents[0]!.status = 'recovered'; delete data.incidents[0]!.retirement_reason; data.incidents[0]!.events[1]!.kind = 'recovered';
    data.incidents[0]!.recovery_evidence = { earliest_at: 160, latest_at: 190 };
    const action = repair(); action.recovery_confirmed_at = 190; data.repairs = [action]; data.order = [action.id, data.incidents[0]!.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded(); expect(host.text()).toContain('Later successful operations recorded for every related incident');
    action.action = 'rotate_secret'; delete action.recovery_confirmed_at; await panel.refresh();
    expect(host.text()).toContain('Vendor access was not checked'); expect(host.text()).not.toContain('Later successful operations recorded for every related incident'); panel.dispose();
  });
  it('shows failed, interrupted and restart-pending repairs without claiming a saved change failed or access recovered', async () => {
    const data = page(); const action = repair(); action.status = 'failed'; action.reason = 'interrupted'; data.incidents = []; data.repairs = [action]; data.order = [action.id];
    const { host, panel } = mount(async () => data); await panel.whenLoaded(); expect(host.text()).toContain('Repair failed · Saved authentication kept');
    expect(host.text()).toContain('server stopped before the change was committed');
    action.status = 'applied'; delete action.reason; action.restart_required = true; await panel.refresh();
    expect(host.text()).toContain('collection restart still needs attention'); expect(host.text()).not.toContain('Repair failed'); panel.dispose();
  });
  it('pages repair-only history and retains actions when a later response has invalid order', async () => {
    const data = page(); data.incidents = []; const action = repair(); data.repairs = [action]; data.order = [action.id]; data.next_cursor = 'older';
    const invalid = { ...data, order: ['unknown'] };
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(data).mockResolvedValueOnce(invalid);
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).not.toContain('No incidents have been recorded');
    expect(host.text()).toContain('Load older history'); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(host.text()).toContain('History could not be refreshed'); expect(host.find('data-authentication-repair', action.id)).toBeDefined(); panel.dispose();
  });
  it('shows historical impacts and retirement without claiming recovered access', async () => {
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValue(page()); const { host, panel } = mount(call); await panel.whenLoaded();
    expect(call).toHaveBeenCalledWith({ scope: { kind: 'connection', name: 'work' }, include_renewals: true });
    expect(host.text()).toContain('Closed without confirmed recovery'); expect(host.text()).toContain('saved authentication changed');
    expect(host.text()).toContain('Pack: Sheets'); expect(host.text()).toContain('list of affected uses or problems may be incomplete');
    expect(host.text()).not.toContain('Later operations succeeded'); expect(host.find('data-authentication-incident', page().incidents[0]!.id)).toBeDefined(); panel.dispose();
  });
  it('distinguishes awaiting evidence from later verified operations', async () => {
    const waiting = page(); Object.assign(waiting.incidents[0]!, { status: 'open', currently_reported: false }); delete waiting.incidents[0]!.ended_at; delete waiting.incidents[0]!.retirement_reason;
    waiting.incidents[0]!.events[1]!.kind = 'awaiting_confirmation';
    const recovered = page(); Object.assign(recovered.incidents[0]!, { status: 'recovered' }); delete recovered.incidents[0]!.retirement_reason;
    recovered.incidents[0]!.events[1]!.kind = 'recovered';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(waiting).mockResolvedValueOnce(recovered);
    const { host, panel } = mount(call); await panel.whenLoaded(); expect(host.text()).toContain('Awaiting access evidence');
    await panel.refresh(); expect(host.text()).toContain('Successful operations recorded'); expect(host.text()).toContain('does not verify every permission'); panel.dispose();
  });
  it('paginates stored incidents and retains the previous page with a visible error when a refresh fails', async () => {
    const first = page(); first.next_cursor = 'page_two'; const second = page(); second.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockRejectedValue(new Error('never-export-secret'));
    const { host, panel } = mount(call); await panel.whenLoaded(); host.find('data-incident-action', 'older')!.click(); await panel.whenLoaded();
    expect(call.mock.calls[1]![0].cursor).toBe('page_two'); expect(host.text()).toContain('2 incidents shown');
    await panel.refresh(); expect(host.text()).toContain('Earlier observations may be shown'); expect(host.text()).not.toContain('never-export');
    expect(host.find('data-authentication-incident', first.incidents[0]!.id)).toBeDefined(); panel.dispose();
  });
  it('ignores replies after disposal and rejects a wrong-scope or malformed page', async () => {
    let done!: (page: AuthenticationIncidentHistoryPage) => void;
    const { host, panel } = mount(() => new Promise(resolve => { done = resolve; })); const text = host.text(); panel.dispose(); done(page()); await panel.whenLoaded(); expect(host.text()).toBe(text);
    const wrong = mount(async () => page({ kind: 'all' })); await wrong.panel.whenLoaded(); expect(wrong.host.text()).toContain('History could not be refreshed'); wrong.panel.dispose();
    const invalid = mount(async () => ({ ...page(), retention_days: 1 })); await invalid.panel.whenLoaded(); expect(invalid.host.text()).toContain('History could not be refreshed'); invalid.panel.dispose();
  });
  it('handles empty history and an older server without claiming healthy vendor access', async () => {
    const empty = mount(async () => ({ ...page(), incidents: [] })); await empty.panel.whenLoaded(); expect(empty.host.text()).toContain('does not confirm vendor access'); empty.panel.dispose();
    expect(empty.host.text()).toContain('This server does not provide token-renewal history');
    const old = mount(); await old.panel.whenLoaded(); expect(old.host.text()).toContain('update the server'); old.panel.dispose();
  });
  it('labels an unknown historical last failure date without rejecting the incident or displaying an invalid date', async () => {
    const historical = page(); delete historical.incidents[0]!.last_problem_at;
    const { host, panel } = mount(async () => historical); await panel.whenLoaded();
    expect(host.text()).toContain('Last problem observed: Unknown'); expect(host.text()).not.toMatch(/Invalid Date|History could not be refreshed/); panel.dispose();
  });
  it.each(['refresh', 'older'])('restores keyboard focus to a live control after %s replaces the panel', async action => {
    const first = page(); first.next_cursor = 'older_page';
    const older = page(); older.next_cursor = 'last_page'; older.incidents[0]!.id = '22345678-1234-4123-8123-123456789abc';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValue(action === 'older' ? older : first);
    const { host, panel, doc } = mount(call); await panel.whenLoaded();
    const oldControl = host.find('data-incident-action', action)!; oldControl.focus!(); oldControl.click(); await panel.whenLoaded();
    expect(doc.activeElement).toBe(host.find('data-incident-action', action)); expect(doc.activeElement).not.toBe(oldControl); panel.dispose();
  });
  it('does not move focus back into history when the user has focused another control while it loads', async () => {
    let finish!: (value: AuthenticationIncidentHistoryPage) => void;
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(page()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { host, panel, doc } = mount(call); await panel.whenLoaded(); const refresh = host.find('data-incident-action', 'refresh')!;
    refresh.focus!(); refresh.click(); const outside = new Element(); Object.assign(outside, { isConnected: true }); doc.activeElement = outside;
    finish(page()); await panel.whenLoaded(); expect(doc.activeElement).toBe(outside); panel.dispose();
  });
  it('keeps keyboard focus in the panel when the last older page removes its paging control', async () => {
    const first = page(); first.next_cursor = 'last_page';
    const call = vi.fn<AuthenticationIncidentHistoryCaller>().mockResolvedValueOnce(first).mockResolvedValueOnce({ ...page(), incidents: [] });
    const { host, panel, doc } = mount(call); await panel.whenLoaded(); const older = host.find('data-incident-action', 'older')!;
    older.focus!(); older.click(); await panel.whenLoaded();
    expect(host.find('data-incident-action', 'older')).toBeUndefined(); expect(doc.activeElement).toBe(host.find('data-incident-action', 'refresh')); panel.dispose();
  });
  it('round-trips non-secret history scopes and rejects unsupported or incomplete addresses', () => {
    for (const scope of [{ kind: 'all' }, { kind: 'connection', name: 'work' }, { kind: 'collection', platform: 'mail', slug: 'in box' },
      { kind: 'group', id: 'a'.repeat(64) }, { kind: 'file_source', source_id: 'google.work.file' }, { kind: 'oauth_apps' }] satisfies AuthenticationIncidentScope[]) {
      expect(parseConnectionsIncidentHistory(parseShellRoute(authenticationIncidentHistoryHref(scope)).segments)).toEqual(scope);
    }
    expect(parseConnectionsIncidentHistory(['others', 'incident-history', 'connection', '../work'])).toBeNull();
    expect(parseConnectionsIncidentHistory(['others', 'incident-history', 'collection', 'mail'])).toBeNull();
    const props = { prefix: 'connections' as const, action: 'reauthorize' as const, current: 'Direct OAuth', canChangeApp: true, canChangeMethod: true, historyScope: { kind: 'connection' as const, name: 'work' } };
    expect(renderAuthenticationManagement(props)).toContain('href="#connections/others/incident-history/connection/work"');
    expect(renderAuthenticationManagement({ ...props, busy: true })).not.toContain('href=');
  });
});
