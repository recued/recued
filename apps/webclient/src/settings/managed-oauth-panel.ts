/** D-322 — broker setup and Connect popup. Secrets stay in this mounted editor. */
import type { ManagedOAuthAuth, ManagedOAuthIntegration, ManagedOAuthProfileView,
  ManagedOAuthProvider, ManagedOAuthRemoteConnection, ManagedOAuthRequest, ManagedOAuthResponse } from '@recued/contracts';

export type ManagedOAuthCaller = (args: ManagedOAuthRequest) => Promise<ManagedOAuthResponse>;
export interface ManagedOAuthPanelContext {
  enabled: boolean; mode: 'create' | 'edit'; name: string; vendor?: string;
  base_url: string; scopes: string[]; profile_id: string; integration_id: string;
  connection_id?: string; imported?: boolean;
}
export interface ManagedOAuthPanelDeps {
  call?: ManagedOAuthCaller;
  /** Same editor, available from Apps & APIs without starting enrollment. */
  manageProfiles?: boolean;
  context(): ManagedOAuthPanelContext;
  select(profile: string, integration: string): void;
  requiredScopes?(scopes: readonly string[]): void;
  authorized(auth: ManagedOAuthAuth, grantedScopes?: readonly string[]): void;
  invalidate(): void;
  changed(): void;
  open?: () => { location: { href: string }; closed: boolean; close(): void; opener?: unknown } | null;
  now?: () => number;
}
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export const createManagedOAuthPanel = (deps: ManagedOAuthPanelDeps) => {
  let host: HTMLElement | null = null;
  let profiles: readonly ManagedOAuthProfileView[] = [];
  let integrations: readonly ManagedOAuthIntegration[] = [];
  let loaded = false; let disposed = false; let generation = 0; let busy = false;
  let contextKey = ''; let discoveryKey = ''; let message = ''; let error = '';
  let setup = false; let editingProfile: string | undefined;
  let label = ''; let server = 'https://api.nango.dev'; let apiKey = '';
  let connectOrigin = '';
  let profileBaseline = '';
  let integrationSetup = false; let providers: readonly ManagedOAuthProvider[] = [];
  let providerId = ''; let integrationId = ''; let integrationLabel = '';
  let app: 'shared' | 'custom' = 'shared'; let clientId = ''; let clientSecret = ''; let appScopes = '';
  let existingMode = false; let remotes: readonly ManagedOAuthRemoteConnection[] = [];
  let accountDiscoveryKey = '';
  let remoteId = ''; let remotePage = 0; let remoteMore = false; let deleteConfirmation = '';
  const clearApp = (): void => { integrationSetup = false; clientId = ''; clientSecret = ''; appScopes = ''; };
  const clearAccounts = (): void => { remotes = []; remoteId = ''; remotePage = 0; remoteMore = false; deleteConfirmation = ''; };
  const profileDraft = (): string => JSON.stringify([label, server, connectOrigin, apiKey]);
  let pending: { flow_id: string; claim_secret: string; expires_at: number; failures: number; popup: ReturnType<NonNullable<ManagedOAuthPanelDeps['open']>> } | undefined;
  let opening: ReturnType<NonNullable<ManagedOAuthPanelDeps['open']>> | undefined;
  let verifiedFlow: { flow_id: string; claim_secret: string } | undefined;
  let wasEnabled = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retirement: Promise<void> = Promise.resolve();
  const now = deps.now ?? Date.now;
  const call = async (args: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (deps.call === undefined) throw new Error('Managed OAuth is unavailable on this server. Upgrade the paired server to use it.');
    return deps.call(args);
  };
  const stop = (): Promise<void> => {
    const cancellations: Promise<unknown>[] = [];
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    const old = pending; pending = undefined;
    try { opening?.close(); } catch { /* already closed */ }
    opening = undefined;
    if (old !== undefined) {
      try { old.popup?.close(); } catch { /* already closed */ }
      cancellations.push(call({ action: 'cancel', flow_id: old.flow_id, claim_secret: old.claim_secret }));
    }
    const verified = verifiedFlow; verifiedFlow = undefined;
    if (verified !== undefined) cancellations.push(call({ action: 'cancel', ...verified }));
    retirement = Promise.allSettled([retirement, ...cancellations]).then(() => {});
    return retirement;
  };
  const render = (): void => {
    if (host === null || disposed) return;
    const ctx = deps.context();
    const option = (value: string, title: string, current: string) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(title)}</option>`;
    const locked = busy ? ' disabled' : '';
    const identityLocked = ctx.mode === 'edit' ? ' disabled' : locked;
    host.innerHTML = `<section class="connections-managed-oauth" aria-label="Managed OAuth">
      <p>The selected broker stores vendor credentials and sees API traffic. Vendor consent and administrator policies still apply. ${deps.manageProfiles ? 'Manage the brokers and accounts used by your API connections here.' : 'Use this connection for API packs. Compatible saved connections can also be selected for Mail, Calendar and file sync.'}</p>
      <label>Broker profile <select data-managed-field="profile"${identityLocked}>
        ${option('', 'Select a broker profile', ctx.profile_id)}${profiles.map((p) => option(p.id, `${p.label} (${p.base_url})`, ctx.profile_id)).join('')}
      </select></label>
      <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="add"${locked}>Add broker</button>
      <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="refresh-profiles"${locked}>Refresh brokers</button>
      ${ctx.profile_id ? `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="edit"${locked}>Edit broker key</button><button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="delete"${locked}>Delete broker profile</button>` : ''}
      ${setup ? `<fieldset><legend>${editingProfile ? 'Edit Nango broker' : 'Nango broker'}</legend>
        <label>Name <input data-managed-field="label" value="${escape(label)}"${locked}></label>
        <label>Server URL <input type="url" data-managed-field="server" value="${escape(server)}"${locked}${editingProfile ? ' readonly' : ''}></label>
        <label>Connect UI origin (optional) <input type="url" data-managed-field="connect-origin" value="${escape(connectOrigin)}"${locked}${editingProfile ? ' readonly' : ''} placeholder="https://connect.your-domain.com"></label>
        <label>Nango API key <input type="password" autocomplete="off" data-managed-field="key" value="${escape(apiKey)}"${locked} placeholder="${editingProfile ? 'Leave blank to keep the saved key' : 'API key for this Nango environment'}"></label>
        <p>Copy the key from Nango → Environment Settings → API Keys. The server can be Nango Cloud or self-hosted on any reachable machine. Use a key with integration discovery, Connect sessions, connection-list and proxy permissions. Creating integrations and deleting Nango accounts require their additional permissions. Free Cloud has connection limits.</p>
        ${editingProfile ? '<p>Use another key from the same Nango environment. With saved accounts, Recued checks both keys before saving. Rotate before revoking the old key. For another environment or a revoked old key, create a new broker profile and connect its accounts again.</p>' : ''}
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="save-profile"${locked}>Test and save broker</button>
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="close-setup"${locked}>Cancel broker setup</button>
      </fieldset>` : ''}
      ${ctx.profile_id ? `<label>Vendor integration <select data-managed-field="integration"${identityLocked}>
        ${option('', 'Select a configured integration', ctx.integration_id)}${ctx.integration_id && !integrations.some((i) => i.id === ctx.integration_id) ? option(ctx.integration_id, `Saved integration: ${ctx.integration_id}`, ctx.integration_id) : ''}${integrations.map((i) => option(i.id, `${i.label} — ${i.provider} (${i.id})`, ctx.integration_id)).join('')}
      </select></label><button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="refresh"${locked}>Refresh integrations</button>` : ''}
      ${!deps.manageProfiles ? '<p>One matching integration is selected automatically. If several apps serve this vendor, choose the one you configured. A shared app may have fixed scopes.</p>' : ''}
      ${ctx.profile_id && (deps.manageProfiles || ctx.mode === 'create') ? `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="add-integration"${locked}>Create vendor integration</button>` : ''}
      ${ctx.profile_id && integrations.length === 0 ? '<p>Create an OAuth integration here or in your Nango dashboard, then refresh integrations. Choose its shared app if one is offered.</p>' : ''}
      ${integrationSetup ? `<fieldset><legend>Create integration in Nango</legend>
        <label>Vendor <select data-managed-field="provider"${locked}>${option('', 'Select an OAuth provider', providerId)}${providers.map((p) => option(p.id, `${p.label} (${p.id})`, providerId)).join('')}</select></label>
        <label>Integration ID <input data-managed-field="integration-id" value="${escape(integrationId)}"${locked}></label>
        <label>Name <input data-managed-field="integration-label" value="${escape(integrationLabel)}"${locked}></label>
        <label>OAuth app <select data-managed-field="app"${locked}>${option('shared', 'Nango shared app, if available', app)}${option('custom', 'My vendor OAuth app', app)}</select></label>
        ${app === 'custom' ? `<label>OAuth client ID <input data-managed-field="client-id" value="${escape(clientId)}"${locked}></label>
          <label>OAuth client secret <input type="password" autocomplete="off" data-managed-field="client-secret" value="${escape(clientSecret)}"${locked}></label>
          <label>App scopes <input data-managed-field="app-scopes" value="${escape(appScopes)}"${locked}></label>
          <p>Configure the redirect URI shown by your Nango server in the vendor app. These app credentials are sent to Nango.</p>` : '<p>Shared apps are available for selected providers and may have fixed scopes. Your Nango server must offer one; self-hosted deployments may not.</p>'}
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="create-integration"${busy || !providerId ? ' disabled' : ''}>Create integration</button>
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="close-integration"${locked}>Cancel integration setup</button>
      </fieldset>` : ''}
      ${ctx.profile_id && ctx.integration_id && (deps.manageProfiles || ctx.mode === 'create') ? `<label>Account setup <select data-managed-field="account-mode"${locked}>
        ${option('existing', deps.manageProfiles ? 'Manage existing Nango accounts' : 'Use an existing Nango account', existingMode ? 'existing' : 'new')}
        ${option('new', deps.manageProfiles ? 'Select an account action' : 'Authorize a new account', existingMode ? 'existing' : 'new')}
      </select></label>` : ''}
      ${!deps.manageProfiles && ctx.mode === 'create' && ctx.profile_id && ctx.integration_id && !existingMode ? '<p>A new sign-in creates another Nango connection. Use an existing account to share its authorization across Recued connections and packs.</p>' : ''}
      ${existingMode ? `<label>Nango account <select data-managed-field="account"${locked}>${option('', 'Select an existing account', remoteId)}${remotes.map((r) => option(r.id, `${r.label} (${r.id})${r.auth_error ? ' — reauthorization needed' : ''}`, remoteId)).join('')}</select></label>
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="refresh-accounts"${locked}>Refresh accounts</button>
        ${remotePage > 0 ? `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="previous-accounts"${locked}>Previous accounts</button>` : ''}
        ${remoteMore ? `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="next-accounts"${locked}>Next accounts</button>` : ''}
        ${!deps.manageProfiles ? `<p>Reuse this account’s current authorization. Its granted permissions remain unverified. To change permissions, manage consent in Nango with its existing scope profile, or authorize a new account here.</p>
          <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="attach"${busy || !remoteId || remotes.find((r) => r.id === remoteId)?.auth_error ? ' disabled' : ''}>Use selected account</button>` :
          remoteId ? `<p>Deleting this account from Nango affects every tool using it. Remove its Recued connections first. Vendor consent may remain until revoked at the vendor.</p>
            <label>Type account ID to confirm deletion <input data-managed-field="delete-confirmation" value="${escape(deleteConfirmation)}"${locked}></label>
            <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="delete-account"${busy || deleteConfirmation !== remoteId ? ' disabled' : ''}>Delete account from Nango</button>` : ''}
      ` : ''}
      ${ctx.mode === 'edit' && !ctx.connection_id ? '<p>To switch a direct credential to managed OAuth, add a new connection, then select it for your packs. Reauthorization keeps the saved broker and account.</p>' : ''}
      ${ctx.mode === 'edit' && ctx.imported ? '<p>This account was reused from Nango. Recued checks for saved scope history before changing consent. If that history is unknown, manage consent in Nango with its existing scope profile.</p>' : ''}
      ${!deps.manageProfiles && (ctx.mode === 'edit' || !existingMode) ? `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="authorize"${busy || verifiedFlow !== undefined || !ctx.profile_id || !ctx.integration_id || (ctx.mode === 'edit' && !ctx.connection_id) ? ' disabled' : ''}>${ctx.mode === 'edit' ? 'Reauthorize' : 'Authorize'}</button>` : ''}
      ${!deps.manageProfiles && ctx.mode === 'edit' && ctx.connection_id ? `<p>Recued reuses the saved account when its completed scope requests cover current needs. Granted permissions remain unknown. New consent keeps scopes needed by other connections. Choose Sign in again to repair access.</p>
        <button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="force-reauthorize"${locked}>Sign in again</button>` : ''}
      ${pending ? '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-managed-action="cancel">Cancel authorization</button>' : ''}
      ${message ? `<p role="status">${escape(message)}</p>` : ''}${error ? `<p role="alert">${escape(error)}</p>` : ''}
      <p>Removing a Recued connection keeps its Nango account. Use Manage OAuth brokers to delete unused Nango accounts.</p>
    </section>`;
  };
  const fail = (value: unknown): void => {
    error = value instanceof Error ? value.message : 'Managed OAuth failed. Try again.';
    busy = false; render(); deps.changed();
  };
  const run = (work: Promise<void>, gen = generation): void => {
    void work.catch((value) => { if (!disposed && gen === generation) fail(value); });
  };
  const discover = async (): Promise<void> => {
    const ctx = deps.context(); const gen = generation;
    if (!ctx.enabled || !ctx.profile_id || (!deps.manageProfiles && !ctx.base_url)) { integrations = []; render(); return; }
    const key = JSON.stringify([ctx.profile_id, ctx.base_url, ctx.vendor]); discoveryKey = key;
    const result = await call({ action: 'integrations', profile_id: ctx.profile_id, ...(deps.manageProfiles ? {} : { base_url: ctx.base_url }),
      ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }) });
    if (disposed || gen !== generation || result.action !== 'integrations') return;
    integrations = result.integrations;
    if (ctx.mode === 'create') deps.requiredScopes?.(result.required_scopes ?? []);
    const selected = ctx.mode === 'edit' || integrations.some((i) => i.id === ctx.integration_id) ? ctx.integration_id : result.selected_id ?? '';
    deps.select(ctx.profile_id, selected); render(); deps.changed(); discoverAccounts();
  };
  const loadAccounts = async (page = 0, preferReuse = false): Promise<void> => {
    const ctx = deps.context(); const gen = generation;
    stop(); deps.invalidate(); clearAccounts(); remotePage = page; busy = true; render(); deps.changed();
    const result = await call({ action: 'remote_connections', profile_id: ctx.profile_id, integration_id: ctx.integration_id, page });
    if (disposed || gen !== generation || result.action !== 'remote_connections') return;
    remotes = result.connections; remotePage = result.page; remoteMore = result.has_more; busy = false;
    if (preferReuse && remotes.length === 0 && !remoteMore) existingMode = false;
    message = remotes.length === 0 ? 'No existing accounts on this page. Authorize a new account or check the selected integration.' : '';
    render(); deps.changed();
  };
  const discoverAccounts = (): void => {
    const ctx = deps.context();
    if (deps.manageProfiles || !ctx.enabled || ctx.mode !== 'create' || !ctx.profile_id || !ctx.integration_id) return;
    const key = JSON.stringify([ctx.profile_id, ctx.integration_id]);
    if (key === accountDiscoveryKey) return;
    accountDiscoveryKey = key; existingMode = true; error = ''; message = '';
    // Check before offering new consent. An account is still the owner's choice,
    // even when only one exists; a failed lookup must not imply an empty broker.
    run(loadAccounts(0, true));
  };
  const attachAccount = async (): Promise<void> => {
    const ctx = deps.context(); const gen = ++generation;
    const canceled = stop(); deps.invalidate(); busy = true; render(); deps.changed();
    try {
      await canceled;
      if (disposed || gen !== generation) return;
      const result = await call({ action: 'attach', profile_id: ctx.profile_id, integration_id: ctx.integration_id,
        connection_id: remoteId, base_url: ctx.base_url, scopes: ctx.scopes,
        ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }) });
      if (disposed || gen !== generation || result.action !== 'attach') {
        if (result.action === 'attach') void call({ action: 'cancel', flow_id: result.flow_id, claim_secret: result.claim_secret }).catch(() => {});
        return;
      }
      verifiedFlow = { flow_id: result.flow_id, claim_secret: result.claim_secret };
      busy = false; deps.authorized(result.auth);
      message = 'Existing Nango authorization verified. Save and probe this connection. Granted permissions remain unknown. Manage consent in Nango to change permissions, or authorize a new account here.';
      render(); deps.changed();
    } catch (value) {
      if (!disposed && gen === generation) fail(value);
    }
  };
  const load = async (): Promise<void> => {
    const gen = generation;
    const result = await call({ action: 'profiles' });
    if (disposed || result.action !== 'profiles') return;
    profiles = result.profiles;
    const ctx = deps.context();
    if (gen !== generation || !ctx.enabled) { render(); return; }
    if (!ctx.profile_id && profiles.length === 1) deps.select(profiles[0]!.id, '');
    await discover(); render(); deps.changed();
  };
  const poll = async (gen: number): Promise<void> => {
    const flow = pending;
    if (flow === undefined || disposed || gen !== generation) return;
    if (now() >= flow.expires_at) { stop(); fail(new Error('Authorization expired. Authorize again.')); return; }
    try {
      const result = await call({ action: 'status', flow_id: flow.flow_id, claim_secret: flow.claim_secret });
      if (disposed || gen !== generation || pending !== flow || result.action !== 'status') return;
      if (flow.failures > 0) { flow.failures = 0; message = 'Waiting for vendor authorization.'; render(); deps.changed(); }
      if (result.status === 'authorized' && result.auth !== undefined) {
        pending = undefined; busy = false;
        verifiedFlow = { flow_id: flow.flow_id, claim_secret: flow.claim_secret };
        try { flow.popup?.close(); } catch { /* closed */ }
        deps.authorized(result.auth, result.granted_scopes);
        message = result.granted_scopes === undefined
          ? 'Authorized. Recued has no confirmed granted-scope metadata from this broker. Save and probe, then use vendor operations to check the access they need.'
          : 'Existing authorization verified. Save and probe this connection.';
        render(); deps.changed(); return;
      }
      if (result.status === 'expired' || flow.popup?.closed) {
        stop(); fail(new Error(result.status === 'expired' ? 'Authorization expired. Start again.' : 'Authorization window closed before completion.'));
        return;
      }
      pollTimer = setTimeout(() => { void poll(gen); }, 2500);
    } catch (value) {
      if (disposed || gen !== generation || pending !== flow) return;
      const code = value !== null && typeof value === 'object' && 'code' in value ? value.code : undefined;
      if ((code === 'broker_unavailable' || code === 'transport' || code === 'timeout') && now() < flow.expires_at) {
        flow.failures += 1;
        error = ''; message = 'Connection to the OAuth broker was interrupted. Retrying authorization verification…';
        const delay = Math.min(2500 * 2 ** Math.min(flow.failures - 1, 2), flow.expires_at - now());
        pollTimer = setTimeout(() => { void poll(gen); }, delay);
        render(); deps.changed(); return;
      }
      stop(); fail(value);
    }
  };
  const authorize = async (force = false): Promise<void> => {
    const ctx = deps.context();
    if (force && ctx.mode !== 'edit') return;
    if (ctx.mode === 'create' && accountDiscoveryKey !== JSON.stringify([ctx.profile_id, ctx.integration_id])) { discoverAccounts(); return; }
    if ((verifiedFlow !== undefined && !force) || (ctx.mode === 'create' && existingMode)) return;
    const gen = ++generation;
    const canceled = stop(); deps.invalidate(); busy = true; error = ''; message = '';
    const popup = deps.open === undefined ? globalThis.window?.open('about:blank', '_blank') : deps.open();
    if (!popup && (ctx.mode === 'create' || force)) { fail(new Error('Allow popups, then authorize again.')); return; }
    opening = popup; render(); deps.changed();
    try {
      await canceled;
      if (disposed || gen !== generation) { popup?.close(); return; }
      const result = await call({ action: 'start', profile_id: ctx.profile_id, integration_id: ctx.integration_id,
        base_url: ctx.base_url, scopes: ctx.scopes, ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }),
        ...(ctx.mode === 'edit' ? { name: ctx.name } : {}), ...(force ? { force_reauthorization: true } : {}) });
      if (disposed || gen !== generation || (result.action !== 'start' && result.action !== 'reuse')) {
        popup?.close();
        if (result.action === 'start' || result.action === 'reuse') void call({ action: 'cancel', flow_id: result.flow_id, claim_secret: result.claim_secret }).catch(() => {});
        return;
      }
      opening = undefined;
      if (result.action === 'reuse') {
        popup?.close(); busy = false;
        verifiedFlow = { flow_id: result.flow_id, claim_secret: result.claim_secret };
        deps.authorized(result.auth, result.granted_scopes);
        message = 'Reusing the saved Nango account. These scopes were requested before; granted permissions remain unknown. Save and probe this connection. Use Sign in again if access needs repair.';
        render(); deps.changed(); return;
      }
      if (!popup) {
        void call({ action: 'cancel', flow_id: result.flow_id, claim_secret: result.claim_secret }).catch(() => {});
        fail(new Error('Allow popups, then authorize again.')); return;
      }
      popup.opener = null;
      popup.location.href = result.connect_link;
      pending = { flow_id: result.flow_id, claim_secret: result.claim_secret, expires_at: result.expires_at, failures: 0, popup };
      message = result.scope_metadata === 'unknown'
        ? 'The broker did not expose its app scopes. Its configured scope profile is preserved; additional requested permissions may need an app change in the broker.'
        : result.scope_metadata === 'fixed'
          ? 'This Microsoft app uses a static .default scope profile. Recued preserves it. Configure additional permissions in the broker app, obtain any required administrator consent, then reauthorize.'
          : 'Complete vendor consent in the authorization window.';
      render(); deps.changed(); void poll(gen);
    } catch (value) {
      popup?.close();
      if (disposed || gen !== generation) return;
      opening = undefined; fail(value);
    }
  };
  const action = async (name: string): Promise<void> => {
    if (busy && name !== 'cancel') return;
    const ctx = deps.context(); error = '';
    const gen = generation;
    switch (name) {
      case 'add': setup = true; editingProfile = undefined; label = ''; server = 'https://api.nango.dev'; apiKey = ''; connectOrigin = ''; profileBaseline = profileDraft(); render(); return;
      case 'edit': {
        const saved = profiles.find((p) => p.id === ctx.profile_id); if (saved === undefined) return;
        setup = true; editingProfile = saved.id; label = saved.label; server = saved.base_url; connectOrigin = saved.connect_ui_origin ?? ''; apiKey = ''; profileBaseline = profileDraft(); render(); return;
      }
      case 'close-setup': setup = false; apiKey = ''; render(); return;
      case 'save-profile': {
        busy = true; render(); deps.changed();
        const result = await call({ action: 'save_profile', label, base_url: server, broker: 'nango',
          ...(connectOrigin ? { connect_ui_origin: connectOrigin } : {}),
          ...(editingProfile === undefined ? {} : { id: editingProfile }), ...(apiKey ? { api_key: apiKey } : {}) });
        if (disposed || gen !== generation || result.action !== 'save_profile') return;
        apiKey = ''; setup = false; busy = false; stop(); deps.invalidate(); clearAccounts(); clearApp(); existingMode = false; accountDiscoveryKey = '';
        deps.select(result.profile.id, result.profile.id === ctx.profile_id ? ctx.integration_id : ''); await load(); return;
      }
      case 'delete': {
        busy = true; render(); deps.changed();
        await call({ action: 'delete_profile', id: ctx.profile_id });
        if (disposed || gen !== generation) return;
        busy = false; deps.select('', ''); deps.invalidate(); await load(); return;
      }
      case 'refresh-profiles': await load(); return;
      case 'refresh': await discover(); return;
      case 'add-integration': {
        busy = true; render(); deps.changed();
        const result = await call({ action: 'providers', profile_id: ctx.profile_id,
          ...(deps.manageProfiles ? {} : { base_url: ctx.base_url }), ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }) });
        if (disposed || gen !== generation || result.action !== 'providers') return;
        providers = result.providers; providerId = result.selected_id ?? ''; integrationId = providerId ? `recued-${providerId}` : '';
        integrationLabel = providers.find((p) => p.id === providerId)?.label ?? ''; app = 'shared';
        clientId = ''; clientSecret = ''; appScopes = ctx.scopes.join(','); integrationSetup = true; busy = false;
        render(); deps.changed(); return;
      }
      case 'close-integration': clearApp(); render(); deps.changed(); return;
      case 'create-integration': {
        busy = true; render(); deps.changed();
        try {
          const result = await call({ action: 'create_integration', profile_id: ctx.profile_id, integration_id: integrationId,
            provider: providerId, label: integrationLabel, app, scopes: app === 'custom' ? appScopes.split(/[\s,]+/).filter(Boolean) : [],
            ...(app === 'custom' ? { client_id: clientId, client_secret: clientSecret } : {}) });
          if (disposed || gen !== generation || result.action !== 'create_integration') return;
          clearApp(); busy = false; clearAccounts(); accountDiscoveryKey = ''; deps.invalidate(); deps.select(ctx.profile_id, result.integration.id);
          await discover(); return;
        } finally {
          // The broker has received the app secret; never retain it after a failed request.
          clientSecret = '';
        }
      }
      case 'refresh-accounts': await loadAccounts(); return;
      case 'next-accounts': await loadAccounts(remotePage + 1); return;
      case 'previous-accounts': await loadAccounts(Math.max(0, remotePage - 1)); return;
      case 'attach': await attachAccount(); return;
      case 'delete-account': {
        busy = true; render(); deps.changed();
        await call({ action: 'delete_remote_connection', profile_id: ctx.profile_id, integration_id: ctx.integration_id,
          connection_id: remoteId, confirmation: deleteConfirmation });
        if (disposed || gen !== generation) return;
        await loadAccounts(); message = 'Account deleted from Nango. Vendor consent may remain until revoked at the vendor.'; render(); return;
      }
      case 'authorize': await authorize(); return;
      case 'force-reauthorize': await authorize(true); return;
      case 'cancel': generation += 1; stop(); deps.invalidate(); busy = false; message = 'Authorization canceled.'; render(); deps.changed(); return;
    }
  };
  const click = (event: Event): void => {
    const target = event.target as Element | null;
    if (target === null || typeof target.closest !== 'function') return;
    const button = target.closest<HTMLElement>('[data-managed-action]');
    if (button === null || !host?.contains(button) || (button as HTMLButtonElement).disabled) return;
    const gen = generation;
    event.preventDefault(); void action(button.dataset.managedAction ?? '').catch((value) => {
      if (!disposed && gen === generation) fail(value);
    });
  };
  const input = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (target === null || !host?.contains(target) || !['INPUT', 'SELECT'].includes(target.tagName)) return;
    const field = target.dataset.managedField;
    if ((target.tagName === 'SELECT' ? 'change' : 'input') !== event.type) return;
    if (busy) return;
    if (field === 'label') label = target.value;
    if (field === 'server') server = target.value;
    if (field === 'connect-origin') connectOrigin = target.value;
    if (field === 'key') apiKey = target.value;
    if (field === 'integration-id') integrationId = target.value;
    if (field === 'integration-label') integrationLabel = target.value;
    if (field === 'client-id') clientId = target.value;
    if (field === 'client-secret') clientSecret = target.value;
    if (field === 'app-scopes') appScopes = target.value;
    if (field === 'delete-confirmation') {
      deleteConfirmation = target.value;
      const button = host?.querySelector?.<HTMLButtonElement>('[data-managed-action="delete-account"]');
      if (button !== null && button !== undefined) button.disabled = deleteConfirmation !== remoteId;
    }
    if (field === 'provider') {
      providerId = target.value; integrationId = `recued-${providerId}`; integrationLabel = providers.find((p) => p.id === providerId)?.label ?? '';
      render();
    }
    if (field === 'app') { app = target.value === 'custom' ? 'custom' : 'shared'; clientSecret = ''; clientId = ''; render(); }
    if (field === 'account-mode' || field === 'account') {
      generation += 1; stop(); deps.invalidate();
      if (field === 'account-mode') { existingMode = target.value === 'existing'; clearAccounts(); if (existingMode) run(loadAccounts()); }
      else { remoteId = target.value; deleteConfirmation = ''; }
      render(); deps.changed();
    }
    if (field === 'profile' || field === 'integration') {
      generation += 1; stop(); deps.invalidate(); clearApp(); clearAccounts(); existingMode = false; accountDiscoveryKey = '';
      deps.select(field === 'profile' ? target.value : deps.context().profile_id, field === 'integration' ? target.value : '');
      if (field === 'profile') run(discover());
      deps.changed(); render();
    }
  };
  const detach = (): void => {
    host?.removeEventListener('click', click); host?.removeEventListener('input', input); host?.removeEventListener('change', input);
  };
  const sync = (): void => {
    let ctx = deps.context(); const key = JSON.stringify([ctx.enabled, ctx.mode, ctx.name, ctx.vendor, ctx.base_url, ctx.scopes, ctx.profile_id, ctx.integration_id]);
    if (contextKey !== '' && key !== contextKey) { generation += 1; stop(); clearAccounts(); clearApp(); accountDiscoveryKey = ''; existingMode = false; busy = false; deps.invalidate(); message = ''; }
    contextKey = key;
    if (!ctx.enabled) { apiKey = ''; setup = false; clearApp(); clearAccounts(); existingMode = false; accountDiscoveryKey = ''; }
    if (ctx.enabled && !wasEnabled && ctx.mode === 'create' && !ctx.profile_id && profiles.length === 1) {
      deps.select(profiles[0]!.id, ''); ctx = deps.context();
    }
    wasEnabled = ctx.enabled;
    const nextDiscovery = JSON.stringify([ctx.profile_id, ctx.base_url, ctx.vendor]);
    if (loaded && ctx.enabled && nextDiscovery !== discoveryKey) run(discover());
    else discoverAccounts();
  };
  return {
    mount(element: HTMLElement | null) {
      detach(); host = element; sync(); render();
      host?.addEventListener('click', click); host?.addEventListener('input', input); host?.addEventListener('change', input);
      if (host !== null && !loaded) { loaded = true; run(load()); }
    },
    sync, busy: () => busy, hasDraft: () => (setup && profileDraft() !== profileBaseline) || integrationSetup,
    dispose() { disposed = true; generation += 1; stop(); apiKey = ''; clearApp(); clearAccounts(); detach(); host = null; },
  };
};
