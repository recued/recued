import { describe, expect, it, vi } from 'vitest';
import { buildOpenerRelayRedirectUri } from '@recued/contracts';
import type { ManagedOAuthResponse, OAuthAppsResponse, SavedOAuthApp } from '@recued/contracts';
import { createManagedOAuthPanel, type ManagedOAuthPanelContext } from '../settings/managed-oauth-panel.js';
import { createOAuthAppsPanel } from '../settings/oauth-apps-panel.js';
import { mountAccountsLanePanel } from '../connections/accounts-lane-panel.js';
import { createOAuthTroubleshooting, oauthHelpCallback, oauthHelpFailureObservation,
  oauthHelpIssues, oauthHelpPlan, oauthHelpPopupObservation, oauthHelpSummary,
  type OAuthTroubleshootingContext } from '../connections/oauth-troubleshooting.js';

const context = (route: 'direct' | 'broker' = 'direct'): OAuthTroubleshootingContext => ({
  key: 'private-account-key', route, issuer: 'google', savedApp: true,
  callbackUrl: buildOpenerRelayRedirectUri('https://app.recued.com'),
});
const mounted = (copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()) => {
  const listeners = new Map<string, EventListener>(); const focus = vi.fn();
  const host = { innerHTML: '', contains: () => true, querySelector: () => ({ focus }),
    ownerDocument: { defaultView: null }, addEventListener: (name: string, fn: EventListener) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name) } as unknown as HTMLElement;
  const help = createOAuthTroubleshooting({ copy }); help.mount(host, context());
  const click = (action: string) => {
    const node = { dataset: { oauthHelpAction: action }, closest() { return this; } };
    listeners.get('click')?.({ target: node, preventDefault() {} } as unknown as Event);
  };
  const choose = (value: string) => listeners.get('change')?.({ target: { value, hasAttribute: () => true } } as unknown as Event);
  const check = (index: string, checked: boolean) => listeners.get('change')?.({ target: {
    dataset: { oauthHelpCheck: index }, checked, hasAttribute: () => false } } as unknown as Event);
  return { help, host, copy, click, choose, check, listeners, focus };
};

describe('guided OAuth troubleshooting', () => {
  it('keeps provider observations separate from a reported symptom and local review', async () => {
    const f = mounted(); f.help.observePopup('denied', 'access_denied');
    expect(f.host.innerHTML).toContain('The vendor returned access_denied'); expect(f.host.innerHTML).not.toContain('You declined');
    f.click('toggle'); expect(f.host.innerHTML).toContain('Consent can fail because');
    f.choose('redirect'); f.check('0', true);
    expect(f.host.innerHTML).toContain('1 of 3 checks reviewed locally');
    f.help.observeFailure({ code: 'locked', message: 'private-secret' });
    expect(f.host.innerHTML).toContain('server reported that its vault is locked');
    expect(f.host.innerHTML).toContain('redirect URL does not match</option>');
    f.click('copy'); await vi.waitFor(() => expect(f.copy).toHaveBeenCalledOnce());
    const summary = f.copy.mock.calls[0]![0];
    expect(summary).toContain('Selected symptom (user reported): The callback');
    expect(summary).toContain('[reviewed locally]'); expect(summary).toContain('does not verify authorization');
    expect(summary).not.toMatch(/private-secret|private-account-key|https:\/\/app\.recued\.com/);
    f.help.dispose(); expect(f.listeners.size).toBe(0);
  });
  it('shows the callback from the direct flow and uses the broker callback guidance for Nango', () => {
    const f = mounted(); f.help.open(); f.choose('redirect');
    expect(f.host.innerHTML).toContain('Expected registration callback'); expect(f.host.innerHTML).toContain('oauth-callback');
    f.help.mount(f.host, context('broker')); f.help.open(); f.choose('redirect');
    expect(f.host.innerHTML).toContain('Nango server’s integration settings'); expect(f.host.innerHTML).not.toContain('Expected registration callback');
    expect(f.host.innerHTML).not.toContain('value="broker_key" selected'); f.help.dispose();
  });
  it('does not call an automatically suggested symptom a user report', async () => {
    const f = mounted(); f.help.observePopup('denied', 'invalid_grant'); f.help.open(); f.click('copy');
    await vi.waitFor(() => expect(f.copy).toHaveBeenCalledOnce());
    expect(f.copy.mock.calls[0]![0]).toContain('Suggested checks from observed failure:');
    expect(f.copy.mock.calls[0]![0]).not.toContain('user reported'); f.help.dispose();
  });
  it('retains local choices through a remount and resets them for another account or route', () => {
    const f = mounted(); f.help.open(); f.choose('secret'); f.check('1', true);
    f.help.mount(f.host, { ...context(), pending: true });
    expect(f.host.innerHTML).toContain('1 of 3 checks reviewed locally'); expect(f.host.innerHTML).toContain('result is still pending');
    f.help.mount(f.host, { ...context(), key: 'different-account' });
    expect(f.host.innerHTML).not.toContain('1 of 3'); expect(f.host.innerHTML).toContain('aria-expanded="false"');
    f.help.dispose();
  });
  it('copies the clicked context and ignores late clipboard completion after a context change', async () => {
    let release!: () => void;
    const copy = vi.fn<(text: string) => Promise<void>>(() => new Promise(resolve => { release = resolve; }));
    const f = mounted(copy); f.help.open(); f.choose('secret'); f.click('copy');
    f.help.mount(f.host, context('broker'));
    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(copy.mock.calls[0]![0]).toContain('Authentication: Recued direct OAuth');
    release(); await Promise.resolve(); expect(f.host.innerHTML).not.toContain('Help summary copied'); f.help.dispose();
  });
  it('handles clipboard failure without changing a credential or claiming a repair', async () => {
    const f = mounted(vi.fn<(text: string) => Promise<void>>().mockRejectedValue(Error('private-clipboard-error')));
    f.help.open(); f.click('copy'); await vi.waitFor(() => expect(f.host.innerHTML).toContain('could not be copied'));
    expect(f.host.innerHTML).not.toContain('private-clipboard-error'); f.help.dispose();
  });
  it('invalidates a pending copy and prior review when new diagnostic evidence arrives', async () => {
    let release!: () => void;
    const f = mounted(vi.fn(() => new Promise<void>(resolve => { release = resolve; })));
    f.help.observePopup('denied', 'invalid_client'); f.help.open(); f.check('0', true); f.click('copy');
    await vi.waitFor(() => expect(f.copy).toHaveBeenCalledOnce());
    f.help.observeFailure({ code: 'locked' }); release(); await Promise.resolve(); await Promise.resolve();
    expect(f.host.innerHTML).not.toContain('Help summary copied.');
    expect(f.host.innerHTML).toContain('0 of 3 checks reviewed locally'); f.help.dispose();
  });
  it('clears the copied notice when the local checklist changes', async () => {
    const f = mounted(); f.help.open(); f.click('copy');
    await vi.waitFor(() => expect(f.host.innerHTML).toContain('Help summary copied.'));
    f.check('0', true); expect(f.host.innerHTML).not.toContain('Help summary copied.'); f.help.dispose();
  });
  it('keeps the latest copy result when clipboard requests finish out of order', async () => {
    let release!: () => void;
    const copy = vi.fn<(text: string) => Promise<void>>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockRejectedValueOnce(Error('clipboard refused'));
    const f = mounted(copy); f.help.open(); f.click('copy'); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    f.click('copy'); await vi.waitFor(() => expect(f.host.innerHTML).toContain('could not be copied'));
    release(); await Promise.resolve(); await Promise.resolve();
    expect(f.host.innerHTML).toContain('could not be copied'); expect(f.host.innerHTML).not.toContain('Help summary copied.'); f.help.dispose();
  });
  it('uses token-request guidance for client credentials without browser callbacks or consent checks', () => {
    const ctx = { ...context(), flow: 'client_credentials' as const };
    expect(oauthHelpIssues(ctx)).not.toEqual(expect.arrayContaining(['popup', 'redirect', 'consent']));
    expect(oauthHelpIssues(ctx)).not.toContain('redirect'); expect(oauthHelpIssues(ctx)).not.toContain('browser');
    for (const issue of oauthHelpIssues(ctx)) {
      const plan = oauthHelpPlan(ctx, issue);
      expect(plan.steps.join(' ')).not.toMatch(/callback|sign-in|consent page|new authorization/);
    }
    const f = mounted(); f.help.mount(f.host, ctx); f.help.open();
    expect(f.host.innerHTML).toContain('without browser sign-in');
    expect(f.host.innerHTML).not.toContain('value="redirect"'); f.help.dispose();
  });
  it('does not carry provider prose, URLs or secret-bearing objects into a diagnostic summary', () => {
    for (const input of [{ message: 'secret=abc&code=private', code: 'unknown', details: { refresh_token: 'secret' } }, new Error('access_denied secret')]) {
      const observation = oauthHelpFailureObservation(input);
      expect(oauthHelpSummary(context(), observation.issue, observation, new Set())).not.toMatch(/abc|code=private|refresh_token|access_denied secret/);
    }
    const observation = oauthHelpPopupObservation('denied', 'invalid_client?client_secret=private');
    expect(observation.issue).toBe('consent'); expect(observation.label).not.toContain('private');
  });
  it.each(['connection_lost', 'timeout', 'server_unresponsive'])('routes %s to checking the existing result without claiming consent failed', code => {
    const observation = oauthHelpFailureObservation({ code, message: 'private transport trace' });
    expect(observation.issue).toBe('return'); expect(observation.label).toContain('result');
    const plan = oauthHelpPlan(context(), observation.issue);
    expect(plan.steps[0]).toContain('before starting new consent');
    expect(oauthHelpSummary(context(), observation.issue, observation, new Set())).not.toContain('private transport trace');
  });
  it.each(['access_denied', 'invalid_client', 'invalid_scope', 'invalid_grant', 'redirect_uri_mismatch', 'AADSTS7000222'])(
    'maps only the exact allowlisted provider code %s', code => {
      expect(oauthHelpPopupObservation('denied', code).label).toContain(code);
      expect(oauthHelpPopupObservation('denied', code + ' secret').label).not.toContain(code);
    });
  it.each(['https://app.recued.com', 'http://127.0.0.1:5300', 'https://my-server.example.com'])(
    'uses the real direct OAuth registration callback for %s', origin => {
      for (const noQuery of [true, false]) {
        const callback = buildOpenerRelayRedirectUri(origin, noQuery);
        expect(oauthHelpCallback(callback)).toBe(callback);
      }
    });
  it.each(['https://app.recued.com/oauth-callback?code=secret', 'https://app.recued.com/oauth-callback#access_token=secret',
    'https://user:secret@app.recued.com/oauth-callback', 'https://app.recued.com/authorize?state=secret',
    'https://app.recued.com/oauth-callback?opener_origin=ftp%3A%2F%2Fexample.com', 'javascript:alert(1)'])(
    'refuses a callback result or unrelated URL %s', url => { expect(oauthHelpCallback(url)).toBeUndefined(); });
  it('keeps broker setup optional and distinguishes app credentials, scope history and access evidence', () => {
    expect(oauthHelpIssues(context())).not.toContain('broker_key'); expect(oauthHelpIssues(context('broker'))).toContain('broker_key');
    expect(oauthHelpPlan(context(), 'credentials').steps.join(' ')).toContain('Usage and rotate secret');
    expect(oauthHelpPlan(context('broker'), 'credentials').steps.join(' ')).toContain('environment API key is a separate credential');
    expect(oauthHelpPlan(context('broker'), 'broker_history').explanation).toContain('cannot safely be treated as an empty grant');
    expect(oauthHelpPlan(context(), 'access').steps.join(' ')).toContain('403 alone does not prove');
    const generic = context(); delete generic.issuer;
    expect(oauthHelpPlan(generic, 'unknown').links).toEqual([]);
  });
});

// Template-only parent hosts expose the actual nested help controller, so these
// cases exercise context selection and event wiring rather than source strings.
const panelHost = (slot: string) => {
  const listeners = new Map<string, EventListener[]>(), helpListeners = new Map<string, EventListener[]>();
  const listen = (map: Map<string, EventListener[]>) => ({
    addEventListener: (name: string, fn: EventListener) => map.set(name, [...map.get(name) ?? [], fn]),
    removeEventListener: (name: string, fn: EventListener) => map.set(name, (map.get(name) ?? []).filter(value => value !== fn)),
  });
  const helpHost = { innerHTML: '', contains: () => true, ownerDocument: { defaultView: null },
    querySelector: () => ({ focus() {} }), ...listen(helpListeners) };
  const host = { innerHTML: '', contains: () => true, querySelectorAll: () => [],
    querySelector: (selector: string) => selector === '[' + slot + ']' && host.innerHTML.includes(slot) ? helpHost : null,
    ...listen(listeners) };
  const fire = (name: string, dataset: Record<string, string>, value = '', help = false) => {
    const node = { dataset, value, tagName: name === 'change' ? 'SELECT' : 'BUTTON', disabled: false,
      hasAttribute: (key: string) => key === 'data-oauth-help-issue' && 'oauthHelpIssue' in dataset,
      closest: (selector: string) => Object.keys(dataset).some(key => selector.includes(key.replace(/[A-Z]/g, value => '-' + value.toLowerCase()))) ? node : null,
      setAttribute() {}, getAttribute: () => null };
    for (const listener of [...(help ? helpListeners : listeners).get(name) ?? []]) listener({
      type: name, target: node, preventDefault() {},
    } as unknown as Event);
  };
  return { host: host as unknown as HTMLElement, helpHost,
    click: (dataset: Record<string, string>) => fire('click', dataset),
    change: (dataset: Record<string, string>, value: string) => fire('change', dataset, value),
    openHelp: () => fire('click', { oauthHelpAction: 'toggle' }, '', true),
    issue: (value: string) => fire('change', { oauthHelpIssue: '' }, value, true) };
};
const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

describe('OAuth troubleshooting target contexts', () => {
  it('resets the Nango checklist when the selected remote account or permission needs change', async () => {
    const f = panelHost('data-managed-oauth-help-host');
    const ctx: ManagedOAuthPanelContext = { enabled: true, mode: 'create', name: 'test',
      base_url: 'https://sheets.googleapis.com/v4', scopes: [], profile_id: 'cloud', integration_id: 'sheets' };
    const panel = createManagedOAuthPanel({ manageProfiles: true, context: () => ctx,
      call: async request => {
        if (request.action === 'profiles') return { action: 'profiles', profiles: [{ id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }] };
        if (request.action === 'integrations') return { action: 'integrations', integrations: [{ id: 'sheets', label: 'Sheets', provider: 'google-sheet', default_scopes: [], scope_metadata: 'unknown' }], selected_id: 'sheets', required_scopes: [] };
        if (request.action === 'remote_connections') return { action: 'remote_connections', connections: [{ id: 'first', label: 'First', auth_error: false }, { id: 'second', label: 'Second', auth_error: false }], page: 0, has_more: false };
        if (request.action === 'account_usage') return { action: 'account_usage', usage: { connection_id: request.connection_id, auth_error: false, connections: [], warnings: [] } };
        if (request.action === 'providers') return { action: 'providers', providers: [{ id: 'microsoft-graph', label: 'Microsoft Graph' }], selected_id: 'microsoft-graph' };
        throw Error('Unexpected request ' + request.action);
      }, select: (profile, integration) => { ctx.profile_id = profile; ctx.integration_id = integration; },
      authorized() {}, invalidate() {}, changed: () => panel.mount(f.host),
    });
    panel.mount(f.host); await settle();
    f.change({ managedField: 'account' }, 'first'); await settle(); f.openHelp(); f.issue('secret');
    expect(f.helpHost.innerHTML).toContain('value="secret" selected');
    f.change({ managedField: 'account' }, 'second'); await settle();
    expect(f.helpHost.innerHTML).toContain('aria-expanded="false"');
    f.openHelp(); f.issue('scopes'); ctx.scopes = ['new-scope']; panel.mount(f.host); await settle();
    expect(f.helpHost.innerHTML).toContain('aria-expanded="false"'); panel.dispose();
  });
  it('uses the vendor being created instead of the previously selected Nango integration', async () => {
    const f = panelHost('data-managed-oauth-help-host');
    const ctx: ManagedOAuthPanelContext = { enabled: true, mode: 'create', name: '', base_url: '', scopes: [], profile_id: 'cloud', integration_id: 'sheets' };
    const call = async (request: { action: string }): Promise<ManagedOAuthResponse> => {
      if (request.action === 'profiles') return { action: 'profiles', profiles: [{ id: 'cloud', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', revision: 1 }] };
      if (request.action === 'integrations') return { action: 'integrations', integrations: [{ id: 'sheets', label: 'Sheets', provider: 'google-sheet', default_scopes: [], scope_metadata: 'unknown' }], selected_id: 'sheets', required_scopes: [] };
      if (request.action === 'remote_connections') return { action: 'remote_connections', connections: [], page: 0, has_more: false };
      if (request.action === 'providers') return { action: 'providers', providers: [{ id: 'microsoft-graph', label: 'Microsoft Graph' }], selected_id: 'microsoft-graph' };
      throw Error('Unexpected request ' + request.action);
    };
    const panel = createManagedOAuthPanel({ manageProfiles: true, call, context: () => ctx,
      select: (profile, integration) => { ctx.profile_id = profile; ctx.integration_id = integration; },
      authorized() {}, invalidate() {}, changed: () => panel.mount(f.host) });
    panel.mount(f.host); await settle(); f.click({ managedAction: 'add-integration' }); await settle();
    f.openHelp(); f.issue('credentials');
    expect(f.helpHost.innerHTML).toContain('Check Application (client) ID');
    expect(f.helpHost.innerHTML).not.toContain('Google OAuth help'); panel.dispose();
  });
  it('opens help for the clicked saved app even with another unchanged app editor open', async () => {
    const f = panelHost('data-app-oauth-help-host');
    const apps: SavedOAuthApp[] = [
      { id: 'default', issuer: 'google', label: 'Google', client_id: 'google-client', has_secret: true, revision: 1 },
      { id: 'default', issuer: 'microsoft', label: 'Microsoft', client_id: 'ms-client', has_secret: true, revision: 1 },
    ];
    const panel = createOAuthAppsPanel({ host: f.host, call: async (): Promise<OAuthAppsResponse> => ({ action: 'list', apps }) });
    await panel.whenLoaded(); panel.open(); f.click({ oauthAppAction: 'edit', oauthAppId: 'google:default' });
    f.click({ oauthAppAction: 'troubleshoot', oauthAppId: 'microsoft:default' }); f.issue('credentials');
    expect(f.helpHost.innerHTML).toContain('Microsoft sign-in errors');
    expect(f.helpHost.innerHTML).not.toContain('Google OAuth help');
    f.click({ oauthAppAction: 'edit', oauthAppId: 'google:default' });
    f.change({ oauthAppField: 'label' }, 'Unsaved label'); const before = f.helpHost.innerHTML;
    f.click({ oauthAppAction: 'troubleshoot', oauthAppId: 'microsoft:default' });
    expect(panel.hasDraft()).toBe(true); expect(f.helpHost.innerHTML).toBe(before); panel.dispose();
  });
  it('drops the prior checklist immediately when Mail changes its saved broker source', async () => {
    const f = panelHost('data-account-oauth-help-host');
    const connection = (name: string) => ({ name, display_name: name, kind: 'api' as const, auth_type: 'managed_oauth' as const, enrolled_at: 1,
      base_url: 'https://gmail.googleapis.com/gmail/v1', health: { status: 'unknown' as const },
      managed_oauth: { type: 'managed_oauth' as const, broker_profile_id: 'cloud', integration_id: 'gmail', connection_id: name,
        target_origin: 'https://gmail.googleapis.com', requested_scopes: [] } });
    const panel = mountAccountsLanePanel({ host: f.host, document: {} as Document,
      mail: { list: async () => ({ instances: [] }), enrollImap: async () => ({ slug: 'test', send_capable: false }),
        enrollOAuth: async () => ({ ok: true, account_key_prefix: 'mail/test' }), delete: async () => ({ ok: true }) },
      listManagedConnections: async () => ({ connections: [connection('first'), connection('second')] }) });
    await panel.whenLoaded(); f.click({ action: 'accounts-open-add' }); f.click({ action: 'accounts-pick-provider', provider: 'gmail' });
    f.change({ acctField: 'connection_name' }, 'first'); f.openHelp(); f.issue('secret');
    expect(f.helpHost.innerHTML).toContain('value="secret" selected');
    f.change({ acctField: 'connection_name' }, 'second');
    expect(f.helpHost.innerHTML).toContain('aria-expanded="false"'); panel.dispose();
  });
});
