/** D-322 — broker setup and Connect popup. Secrets stay in this mounted editor. */
import type { ManagedOAuthAuth, ManagedOAuthIntegration, ManagedOAuthProfileView,
  ManagedOAuthProvider, ManagedOAuthRemoteConnection, ManagedOAuthRequest, ManagedOAuthResponse, ManagedOAuthPermissionPreview,
  ManagedOAuthAccountUsage, ManagedOAuthAuthorizationRequest, ManagedOAuthImpactPreview } from '@recued/contracts';
import { renderManagedOAuthAccountUsage } from './managed-oauth-account-view.js';
import { renderManagedOAuthImpact } from './managed-oauth-impact-view.js';
import { CONNECTION_HEALTH_FRESH_MS, isManagedOAuthAccountUsage, isManagedOAuthImpactPreview } from '@recued/contracts';

export type ManagedOAuthCaller = (args: ManagedOAuthRequest) => Promise<ManagedOAuthResponse>;
export interface ManagedOAuthPanelContext {
  enabled: boolean; mode: 'create' | 'edit' | 'switch'; name: string; vendor?: string;
  base_url: string; scopes: string[]; profile_id: string; integration_id: string;
  connection_id?: string; imported?: boolean;
  expected_updated_at?: number;
  saving?: boolean;
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
  openConnection?(name: string, expectedUpdatedAt: number): Promise<boolean>;
  checkConnection?(name: string, expectedUpdatedAt: number): Promise<void>;
  open?: () => { location: { href: string }; closed: boolean; close(): void; opener?: unknown } | null;
  now?: () => number;
  confirmDiscard?: (prompt: string) => boolean;
}
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

let panelSequence = 0;

export const createManagedOAuthPanel = (deps: ManagedOAuthPanelDeps) => {
  const panelId = `managed-oauth-${++panelSequence}`;
  const now = deps.now ?? Date.now;
  let host: HTMLElement | null = null;
  let profiles: readonly ManagedOAuthProfileView[] = [];
  let integrations: readonly ManagedOAuthIntegration[] = [];
  let loaded = false; let disposed = false; let generation = 0; let busy = false;
  let profilesLoading = false; let profilesRead = false;
  let contextKey = ''; let discoveryKey = ''; let message = ''; let error = '';
  let setup = false; let editingProfile: string | undefined;
  let label = ''; let server = 'https://api.nango.dev'; let apiKey = '';
  let connectOrigin = '';
  let showKey = false; let deletingProfile = false; let working = '';
  let fieldErrors: Record<string, string> = {};
  let focus: { selector: string; start?: number | null; end?: number | null; direction?: 'forward' | 'backward' | 'none' | null } | undefined;
  const openDetails = new Set<string>();
  let profileBaseline = '';
  let integrationSetup = false; let providers: readonly ManagedOAuthProvider[] = [];
  let providerId = ''; let integrationId = ''; let integrationLabel = '';
  let app: 'shared' | 'custom' = 'shared'; let clientId = ''; let clientSecret = ''; let appScopes = '';
  let existingMode = false; let switchMode = false; let remotes: readonly ManagedOAuthRemoteConnection[] = [];
  let accountDiscoveryKey = '';
  let remoteId = ''; let remotePage = 0; let remoteMore = false; let deleteConfirmation = '';
  let usage: ManagedOAuthAccountUsage | undefined; let usageLoading = false; let usageError = ''; let usageSequence = 0;
  let checkingConnection: string | undefined;
  let usageHealthTimer: ReturnType<typeof setTimeout> | undefined;
  const stopUsageHealthTimer = (): void => { if (usageHealthTimer !== undefined) clearTimeout(usageHealthTimer); usageHealthTimer = undefined; };
  const scheduleUsageHealth = (): void => {
    stopUsageHealthTimer();
    const observedAt = now();
    const next = Math.min(...(usage?.connections ?? []).flatMap(connection => {
      const at = connection.health.last_probed_at;
      return connection.health.status === 'ok' && at !== undefined && at <= observedAt
        && at + CONNECTION_HEALTH_FRESH_MS >= observedAt ? [at + CONNECTION_HEALTH_FRESH_MS + 1] : [];
    }));
    if (!Number.isFinite(next)) return;
    const seq = usageSequence; const gen = generation;
    usageHealthTimer = setTimeout(() => {
      usageHealthTimer = undefined;
      if (disposed || seq !== usageSequence || gen !== generation) return;
      scheduleUsageHealth(); render(); deps.changed();
    }, Math.max(1, next - observedAt));
  };
  const clearUsage = (): void => { usageSequence += 1; stopUsageHealthTimer(); usage = undefined; usageLoading = false; usageError = ''; checkingConnection = undefined; };
  const deletionDisabled = (): boolean => busy || usageLoading || !usage || !!usageError
    || usage.connections.length > 0 || deleteConfirmation !== remoteId;
  let preview: ManagedOAuthPermissionPreview | undefined;
  let completedImpact: ManagedOAuthImpactPreview | undefined;
  let impactLoading = false; let impactError = '';
  let readyAuthorization: { auth: ManagedOAuthAuth; grants?: readonly string[] } | undefined;
  let previewKey = ''; let previewLoading = false; let previewError = ''; let previewSequence = 0;
  let forcePreview = false;
  const clearPreview = (): void => { previewSequence += 1; preview = undefined; previewKey = ''; previewLoading = false; previewError = '';
    completedImpact = undefined; impactLoading = false; impactError = ''; readyAuthorization = undefined; };
  const permissionKey = (): string => {
    const ctx = deps.context();
    return JSON.stringify([ctx.enabled, ctx.mode, ctx.name, ctx.vendor, ctx.base_url, ctx.scopes,
      ctx.profile_id, ctx.integration_id, ctx.mode === 'edit' ? ctx.connection_id : undefined, forcePreview,
      ctx.mode === 'switch' ? [ctx.expected_updated_at, existingMode, remoteId] : undefined]);
  };
  const authorizationRequest = (): ManagedOAuthAuthorizationRequest => {
    const ctx = deps.context();
    return { profile_id: ctx.profile_id, integration_id: ctx.integration_id, base_url: ctx.base_url, scopes: [...ctx.scopes], include_account_impact: true,
      ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }),
      ...(ctx.mode === 'edit' ? { name: ctx.name, connection_id: ctx.connection_id } : {}),
      ...(ctx.mode === 'switch' ? { name: ctx.name, switch_authentication: true as const,
        expected_updated_at: ctx.expected_updated_at, ...(existingMode ? { connection_id: remoteId } : {}) } : {}),
    };
  };
  const clearApp = (): void => { integrationSetup = false; clientId = ''; clientSecret = ''; appScopes = ''; };
  const clearAccounts = (): void => { clearUsage(); remotes = []; remoteId = ''; remotePage = 0; remoteMore = false; deleteConfirmation = ''; };
  const profileDraft = (): string => JSON.stringify([label, server, connectOrigin, apiKey]);
  let pending: { flow_id: string; claim_secret: string; expires_at: number; failures: number; popup: ReturnType<NonNullable<ManagedOAuthPanelDeps['open']>> } | undefined;
  let opening: ReturnType<NonNullable<ManagedOAuthPanelDeps['open']>> | undefined;
  let verifiedFlow: { flow_id: string; claim_secret: string; account_id: string } | undefined;
  let completedAccountId = ''; let completedAccountKey = '';
  const accountContextKey = (): string => {
    const ctx = deps.context();
    return JSON.stringify([ctx.enabled, ctx.mode, ctx.name, ctx.vendor, ctx.base_url, ctx.profile_id, ctx.integration_id, ctx.expected_updated_at]);
  };
  const rememberCompletedAccount = (auth: ManagedOAuthAuth): void => {
    if (deps.context().mode === 'switch') { completedAccountId = auth.connection_id; completedAccountKey = accountContextKey(); }
  };
  let wasEnabled = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retirement: Promise<void> = Promise.resolve();
  const closePopup = (popup: ReturnType<NonNullable<ManagedOAuthPanelDeps['open']>> | undefined): void => {
    if (!popup || popup.closed) return;
    // An isolated cross-origin window can reject close in WebKit. Close only a
    // window we can still inspect; its server flow is retired independently.
    try { void popup.location.href; popup.close(); } catch { /* owner can close the vendor window */ }
  };
  const rememberFocus = (): void => {
    const active = host?.ownerDocument?.activeElement as HTMLInputElement | null | undefined;
    if (active == null || !host?.contains(active)) return;
    const field = active.dataset?.managedField; const action = active.dataset?.managedAction;
    if (field || action) focus = { selector: field ? `[data-managed-field="${field}"]` : `[data-managed-action="${action}"]`,
      start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
  };
  const restoreFocus = (): void => {
    if (!focus || !host) return;
    const active = host.ownerDocument?.activeElement;
    if (active && active !== host.ownerDocument.body && !host.contains(active)) return;
    // focusin records the new element's initial caret. Keep the old selection
    // before focusing so that event cannot overwrite the position to restore.
    const previous = focus;
    const replacement = host.querySelector?.<HTMLInputElement>(previous.selector);
    if (!replacement || replacement.disabled) return;
    replacement.focus?.({ preventScroll: true });
    if (typeof previous.start === 'number' && typeof previous.end === 'number') {
      try { replacement.setSelectionRange?.(previous.start, previous.end, previous.direction ?? undefined); } catch { /* URL and select fields have no caret API. */ }
    }
  };
  const focusField = (field: string): void => { focus = { selector: `[data-managed-field="${field}"]` }; restoreFocus(); };
  const confirmDiscard = (subject: string): boolean => {
    const confirm = deps.confirmDiscard ?? host?.ownerDocument?.defaultView?.confirm?.bind(host.ownerDocument.defaultView);
    return confirm?.(`Discard ${subject}? Credential fields are not saved in your browser. Select Cancel to keep editing.`) ?? true;
  };
  const call = async (args: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (deps.call === undefined) throw new Error('Managed OAuth is unavailable on this server. Upgrade the paired server to use it.');
    return deps.call(args);
  };
  const stop = (): Promise<void> => {
    const cancellations: Promise<unknown>[] = [];
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
    const old = pending; pending = undefined;
    closePopup(opening);
    opening = undefined;
    if (old !== undefined) {
      closePopup(old.popup);
      cancellations.push(call({ action: 'cancel', flow_id: old.flow_id, claim_secret: old.claim_secret }));
    }
    const verified = verifiedFlow; verifiedFlow = undefined;
    if (verified !== undefined) cancellations.push(call({ action: 'cancel', flow_id: verified.flow_id, claim_secret: verified.claim_secret }));
    retirement = Promise.allSettled([retirement, ...cancellations]).then(() => {});
    return retirement;
  };
  const render = (): void => {
    if (host === null || disposed) return;
    rememberFocus();
    for (const detail of host.querySelectorAll?.<HTMLDetailsElement>('[data-managed-details]') ?? []) {
      const key = detail.dataset.managedDetails!;
      if (detail.open) openDetails.add(key); else openDetails.delete(key);
    }
    const ctx = deps.context(); const profile = profiles.find(p => p.id === ctx.profile_id);
    const option = (value: string, title: string, current: string) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(title)}</option>`;
    const locked = busy || profilesLoading || ctx.saving ? ' disabled' : '';
    const identityLocked = ctx.mode === 'edit' ? ' disabled' : locked;
    const button = (action: string, title: string, variant = 'secondary', disabled = busy || profilesLoading): string =>
      `<button type="button" class="rx-btn rx-btn-${variant} rx-btn-sm" data-managed-action="${action}"${disabled || ctx.saving ? ' disabled' : ''}>${escape(title)}</button>`;
    const inputField = (field: string, title: string, value: string, type = 'text', hint = '', readonly = false, placeholder = ''): string => {
      const issue = fieldErrors[field]; const description = [hint ? `${panelId}-${field}-hint` : '', issue ? `${panelId}-${field}-error` : ''].filter(Boolean).join(' ');
      return `<div class="managed-oauth-field"><label for="${panelId}-${field}">${title}</label><input id="${panelId}-${field}" data-managed-field="${field}" type="${type}" value="${escape(value)}"${locked}${readonly ? ' readonly' : ''}${type === 'password' || field === 'key' || field === 'client-secret' ? ' autocomplete="off" spellcheck="false"' : ''}${placeholder ? ` placeholder="${escape(placeholder)}"` : ''}${description ? ` aria-describedby="${description}"` : ''}${issue ? ' aria-invalid="true"' : ''}>
        ${hint ? `<small id="${panelId}-${field}-hint">${hint}</small>` : ''}${issue ? `<small class="managed-oauth-field-error" id="${panelId}-${field}-error">${escape(issue)}</small>` : ''}</div>`;
    };
    const details = (key: string, title: string, content: string): string => `<details class="managed-oauth-details" data-managed-details="${key}"${openDetails.has(key) ? ' open' : ''}><summary>${title}</summary><div>${content}</div></details>`;
    const accountSection = ctx.profile_id && ctx.integration_id && !setup && !integrationSetup;
    const permissionSection = !deps.manageProfiles && accountSection && (ctx.mode === 'edit' ? !!ctx.connection_id
      : ctx.mode === 'switch' ? !existingMode || !!remoteId : !existingMode);
    const reviewed = previewKey === permissionKey() && !previewLoading ? preview : undefined;
    const completedNewAccountNeedsReview = ctx.mode === 'switch' && !existingMode && completedAccountId !== '';
    const scopeItems = (scopes: readonly string[]): string => scopes.length
      ? `<ul>${scopes.map(scope => `<li><code>${escape(scope)}</code></li>`).join('')}</ul>` : '<p>None.</p>';
    const decisionLabel = reviewed ? {
      authorize: 'Authorize a new Nango account', reuse: 'Reuse current authorization',
      reconnect: 'Reconnect the same Nango account', blocked: 'Authorization needs attention',
    }[reviewed.decision] : '';
    host.innerHTML = `<section class="connections-managed-oauth" aria-label="${deps.manageProfiles ? 'OAuth brokers' : 'Managed OAuth'}" aria-busy="${busy || profilesLoading}">
      <header class="managed-oauth-heading"><div><h3>${deps.manageProfiles ? 'OAuth brokers' : 'Connect through a broker'}</h3><p>${deps.manageProfiles ? 'Manage the brokers and accounts used by your API connections here.' : 'Use a saved broker to authorize this connection.'}</p></div><span class="managed-oauth-badge">Nango</span></header>
      <p class="managed-oauth-trust">Your broker stores vendor credentials and handles API traffic. Vendor consent and administrator policies still apply.</p>
      <div class="managed-oauth-section">
        ${!setup ? !profilesRead && !profilesLoading ? '<p>Broker profiles could not be loaded. Refresh to try again.</p>' : profiles.length === 0 && !profilesLoading ? `<div class="managed-oauth-empty"><strong>Add your first OAuth broker</strong><p>Use Nango Cloud or your own Nango server. You’ll need its environment API key.</p></div>` : `<label class="managed-oauth-field"><span>Broker profile</span><select data-managed-field="profile"${identityLocked}>${option('', 'Select a broker', ctx.profile_id)}${profiles.map(p => option(p.id, p.label, ctx.profile_id)).join('')}</select></label>` : ''}
        ${profile && !setup ? `<div class="managed-oauth-profile"><span class="managed-oauth-badge">${profile.base_url === 'https://api.nango.dev' ? 'Nango Cloud' : 'Nango server'}</span><code>${escape(profile.base_url)}</code>${profile.connect_ui_origin ? `<small>Connect UI: <code>${escape(profile.connect_ui_origin)}</code></small>` : ''}<small>API key saved on your Recued server.</small></div>` : ''}
        ${!setup ? `<div class="managed-oauth-actions">${button('add', 'Add broker', profiles.length ? 'secondary' : 'primary', busy || profilesLoading || !profilesRead)}${profiles.length || !profilesRead ? button('refresh-profiles', 'Refresh brokers') : ''}${profile ? button('edit', 'Edit broker') + button('delete', 'Remove profile', 'danger-text') : ''}</div>` : ''}
        ${deletingProfile && profile ? `<div class="managed-oauth-danger"><strong>Remove ${escape(profile.label)}?</strong><p>This removes the saved broker key from Recued. Nango accounts remain. Profiles used by saved connections cannot be removed.</p><div class="managed-oauth-actions">${button('confirm-delete-profile', 'Remove profile', 'danger')}${button('cancel-delete-profile', 'Keep profile')}</div></div>` : ''}
        ${setup ? `<fieldset class="managed-oauth-editor"><legend>${editingProfile ? 'Edit broker profile' : 'Add Nango broker'}</legend>
          <div class="managed-oauth-grid">${inputField('label', 'Profile name', label, 'text', 'A name you can recognize when choosing a broker.', false, 'e.g. Nango Cloud · Personal')}
            ${inputField('server', 'Server URL', server, 'url', editingProfile ? 'Create a new profile to use another server or environment.' : 'Nango Cloud is prefilled. For self-hosting, enter your Nango API URL.', !!editingProfile)}</div>
          <div class="managed-oauth-key">${inputField('key', editingProfile ? 'Environment API key (optional)' : 'Environment API key', apiKey, showKey ? 'text' : 'password', 'Nango → Environment Settings → API Keys. This is your broker key, not a vendor OAuth client secret.', false, editingProfile ? 'Leave blank to keep the saved key' : 'Paste the API key for this Nango environment')}
            <button type="button" class="rx-btn rx-btn-secondary rx-btn-sm" data-managed-action="toggle-key" aria-pressed="${showKey}"${locked}>${showKey ? 'Hide key' : 'Show key'}</button></div>
          ${details('connect-origin', 'Separate Connect UI (optional)', inputField('connect-origin', 'Connect UI origin', connectOrigin, 'url', 'Leave blank for Nango Cloud or when Connect is served by the same Nango server.', !!editingProfile, 'https://connect.your-domain.com'))}
          ${details('key-help', editingProfile ? 'API key permissions and rotation' : 'API key permissions', `<p>Use a key that can discover integrations, create Connect sessions, list connections and proxy requests. Creating integrations and deleting Nango accounts need their respective permissions.</p>${editingProfile ? '<p>Rotate with a key from the same environment before revoking the old one. Recued checks saved accounts against both keys. For a different environment or a revoked old key, create a new profile and connect its accounts again.</p>' : ''}`)}
          <p class="managed-oauth-note">The key is encrypted on your Recued server. Cloud connection limits depend on your Nango plan.</p>
          <div class="managed-oauth-actions">${button('save-profile', busy ? 'Testing broker…' : 'Test and save broker', 'primary')}${button('close-setup', 'Cancel')}</div>
        </fieldset>` : ''}
      </div>
      ${ctx.profile_id && !setup ? `<div class="managed-oauth-section"><h4>Vendor integration</h4><p class="managed-oauth-note">${deps.manageProfiles ? 'Choose the Nango integration whose accounts you want to manage.' : 'A matching integration is selected automatically when available. Choose one if this broker has several.'}</p>
        <label class="managed-oauth-field"><span>Integration</span><select data-managed-field="integration"${identityLocked}>${option('', 'Select a configured integration', ctx.integration_id)}${ctx.integration_id && !integrations.some(i => i.id === ctx.integration_id) ? option(ctx.integration_id, `Saved integration: ${ctx.integration_id}`, ctx.integration_id) : ''}${integrations.map(i => option(i.id, `${i.label} · ${i.id}`, ctx.integration_id)).join('')}</select></label>
        <div class="managed-oauth-actions">${button('refresh', 'Refresh integrations')}${!integrationSetup && (deps.manageProfiles || ctx.mode === 'create') ? button('add-integration', 'Create vendor integration') : ''}</div>
        ${integrations.length === 0 && !integrationSetup ? '<p class="managed-oauth-note">No matching integrations found. Create one here or in Nango, then refresh. Use a shared OAuth app when your Nango server offers one.</p>' : ''}
        ${integrationSetup ? `<fieldset class="managed-oauth-editor"><legend>Create integration in Nango</legend>
          <label class="managed-oauth-field"><span>Vendor</span><select data-managed-field="provider"${locked}>${option('', 'Select an OAuth provider', providerId)}${providers.map(p => option(p.id, `${p.label} (${p.id})`, providerId)).join('')}</select></label>
          <div class="managed-oauth-grid">${inputField('integration-label', 'Name', integrationLabel)}${inputField('integration-id', 'Integration ID', integrationId, 'text', 'A unique ID in this Nango environment.')}</div>
          <label class="managed-oauth-field"><span>OAuth app</span><select data-managed-field="app"${locked}>${option('shared', 'Nango shared app, if available', app)}${option('custom', 'My vendor OAuth app', app)}</select></label>
          ${app === 'custom' ? `${inputField('client-id', 'OAuth client ID', clientId)}${inputField('client-secret', 'OAuth client secret', clientSecret, 'password')}${inputField('app-scopes', 'App scopes', appScopes)}<p class="managed-oauth-note">Configure the redirect URI shown by your Nango server in the vendor app. These app credentials are sent to Nango.</p>` : '<p class="managed-oauth-note">Shared apps are available for selected providers and may have fixed scopes. Your Nango server must offer one; self-hosted deployments may not.</p>'}
          <div class="managed-oauth-actions">${button('create-integration', busy ? 'Creating integration…' : 'Create integration', 'primary', busy || !providerId)}${button('close-integration', 'Cancel')}</div>
        </fieldset>` : ''}
      </div>` : ''}
      ${accountSection ? `<div class="managed-oauth-section"><h4>${deps.manageProfiles ? 'Nango accounts' : 'Account authorization'}</h4>
        ${!deps.manageProfiles && ctx.mode !== 'edit' ? `<label class="managed-oauth-field"><span>Account setup</span><select data-managed-field="account-mode"${locked}>${option('existing', 'Use an existing Nango account', existingMode ? 'existing' : 'new')}${option('new', 'Authorize a new account', existingMode ? 'existing' : 'new')}</select></label>` : ''}
        ${!deps.manageProfiles && ctx.mode !== 'edit' && !existingMode ? '<p class="managed-oauth-note">A new sign-in creates another Nango connection. Reuse an existing account to share authorization across your connections and packs.</p>' : ''}
        ${existingMode ? `<label class="managed-oauth-field"><span>Nango account</span><select data-managed-field="account"${locked}>${option('', 'Select an existing account', remoteId)}${remotes.map(r => option(r.id, `${r.label} (${r.id})${r.auth_error ? ' — reauthorization needed' : ''}`, remoteId)).join('')}</select></label>
          <div class="managed-oauth-actions">${button('refresh-accounts', 'Refresh accounts')}${remotePage > 0 ? button('previous-accounts', 'Previous accounts') : ''}${remoteMore ? button('next-accounts', 'Next accounts') : ''}</div>
          ${!deps.manageProfiles && ctx.mode === 'create' ? `<p class="managed-oauth-note">Reuse this account’s current authorization. Granted permissions remain unverified. To change permissions, manage consent in Nango with its existing scope profile, or authorize a new account here.</p>${button('attach', 'Use selected account', 'primary', busy || !remoteId || !!remotes.find(r => r.id === remoteId)?.auth_error)}` : ''}` : ''}
        ${deps.manageProfiles && remoteId ? renderManagedOAuthAccountUsage({ usage, loading: usageLoading, error: usageError,
          canOpen: deps.openConnection !== undefined, canCheck: deps.checkConnection !== undefined,
          checking: checkingConnection, disabled: busy || profilesLoading, now: now() }) : ''}
        ${deps.manageProfiles && remoteId ? details('account-delete', 'Delete this account from Nango', `<div class="managed-oauth-danger"><p>Deletion affects every tool using this account. Remove its Recued connections first. Vendor consent may remain until revoked at the vendor.</p>${usage?.connections.length ? '<p>This account has saved Recued connections. Open them above to review their use before removal.</p>' : ''}${inputField('delete-confirmation', 'Type account ID to confirm deletion', deleteConfirmation, 'text', `Account ID: <code>${escape(remoteId)}</code>`)}${button('delete-account', 'Delete account from Nango', 'danger', deletionDisabled())}</div>`) : ''}
        ${ctx.mode === 'edit' && !ctx.connection_id ? '<p class="managed-oauth-note">Use Switch authentication in this connection’s editor to choose a broker account while keeping its name. Reauthorization keeps the saved broker and account.</p>' : ''}
        ${ctx.mode === 'edit' && ctx.imported ? '<p class="managed-oauth-note">This account was reused from Nango. Recued checks for saved scope history before changing consent. If that history is unknown, manage consent in Nango with its existing scope profile.</p>' : ''}
        ${!deps.manageProfiles && ctx.mode === 'edit' && ctx.connection_id ? '<p class="managed-oauth-note">Recued reuses completed scope requests when they cover current needs. Granted permissions remain unknown. New consent preserves scopes needed by other connections. Choose Review sign-in again to check a repair request.</p>' : ''}
        ${renderManagedOAuthImpact(completedImpact ?? reviewed?.account_impact, impactLoading, impactError)}
        ${verifiedFlow && readyAuthorization && (completedImpact || impactError) ? button('refresh-impact', 'Refresh account and impact', 'secondary', busy) : ''}
        ${permissionSection ? `<section class="managed-oauth-preview" aria-label="Permission preview" aria-busy="${previewLoading}"><h4>Permission preview</h4>
          ${previewLoading ? '<p role="status">Checking the permission request…</p>' : reviewed ? `<strong>${decisionLabel}</strong>
            ${reviewed.blocked_reason ? `<p role="alert">${escape(reviewed.blocked_reason)}</p>` : ''}
            ${reviewed.added_scopes === undefined ? '<p>Nango will use its configured scope profile. The exact permission request is unavailable.</p>' : `<h5>New requested permissions</h5>${scopeItems(reviewed.added_scopes)}<h5>Permissions retained beyond this connection’s needs</h5>${scopeItems(reviewed.retained_scopes ?? [])}`}
            ${details('permission-sources', 'Permission needs and history', `<ul>${reviewed.sources.map(source => `<li><strong>${escape(source.label)}</strong>${scopeItems(source.scopes)}</li>`).join('')}</ul>`)}
            ${reviewed.requested_scopes === undefined ? '' : details('permission-full', reviewed.decision === 'reuse' ? 'Previously requested scope list' : 'Full requested scope list', scopeItems(reviewed.requested_scopes))}
            ${reviewed.warnings.map(warning => `<p class="managed-oauth-note">${escape(warning)}</p>`).join('')}` : `<p${previewError ? ' role="alert"' : ''}>${escape(previewError || 'Review the permission request before continuing.')}</p>`}
          ${button('refresh-permissions', 'Refresh permission preview', 'secondary', busy || previewLoading || verifiedFlow !== undefined)}
        </section>` : ''}
        <div class="managed-oauth-actions">${!deps.manageProfiles && (ctx.mode !== 'create' || !existingMode) ? button('authorize', reviewed?.decision === 'reuse' ? 'Use current authorization' : forcePreview ? 'Sign in again' : ctx.mode === 'edit' ? 'Reauthorize' : 'Authorize', 'primary', busy || completedNewAccountNeedsReview || verifiedFlow !== undefined || !reviewed || reviewed.decision === 'blocked' || !ctx.profile_id || !ctx.integration_id || (ctx.mode === 'edit' && !ctx.connection_id)) : ''}
          ${!deps.manageProfiles && (ctx.mode === 'edit' && ctx.connection_id || ctx.mode === 'switch' && existingMode && remoteId) ? button('force-reauthorize', forcePreview ? 'Use automatic reuse' : 'Review sign-in again') : ''}
          ${ctx.mode === 'switch' && completedAccountId ? button('review-authorization', 'Review authorization again') : ''}
          ${pending ? button('cancel', 'Cancel authorization', 'secondary', false) : ''}</div>
      </div>` : ''}
      ${busy || profilesLoading || message ? `<p class="managed-oauth-feedback" role="status" tabindex="-1">${escape(profilesLoading ? 'Loading broker profiles…' : busy && !pending ? working || 'Contacting Nango…' : message)}</p>` : ''}${error ? `<p class="managed-oauth-feedback managed-oauth-feedback-error" role="alert" tabindex="-1">${escape(error)}</p>` : ''}
      ${ctx.profile_id && !setup ? '<p class="managed-oauth-note managed-oauth-footer">Removing a Recued connection keeps its Nango account. Use Manage OAuth brokers to delete unused Nango accounts.</p>' : ''}
    </section>`;
    restoreFocus();
    syncPreview();
  };
  const syncPreview = (): void => {
    const ctx = deps.context();
    if (!ctx.enabled || deps.manageProfiles || setup || integrationSetup || !ctx.profile_id || !ctx.integration_id
      || !ctx.base_url || (ctx.mode === 'edit' ? !ctx.connection_id : ctx.mode === 'switch' ? existingMode && !remoteId : existingMode)) {
      if (previewKey) clearPreview();
      return;
    }
    if (busy || profilesLoading || pending || verifiedFlow
      || (ctx.mode === 'create' && accountDiscoveryKey !== JSON.stringify([ctx.profile_id, ctx.integration_id]))) return;
    const key = permissionKey();
    if (key === previewKey) return;
    const sequence = ++previewSequence;
    previewKey = key; preview = undefined; previewError = ''; previewLoading = true;
    render();
    const read = async (): Promise<ManagedOAuthResponse | undefined> => {
      await retirement;
      if (disposed || sequence !== previewSequence || key !== permissionKey()) return;
      return call({ action: 'preview', ...authorizationRequest(),
      ...(forcePreview ? { force_reauthorization: true } : {}) });
    };
    void read().then(result => {
      if (disposed || sequence !== previewSequence || key !== permissionKey()) return;
      if (result?.action !== 'preview') throw new Error('Permission preview is unavailable. Upgrade the paired server and try again.');
      if (result.preview.account_impact !== undefined && (!isManagedOAuthImpactPreview(result.preview.account_impact)
        || result.preview.account_impact.phase !== 'before_authorization'
        || result.preview.account_impact.target.broker?.id !== ctx.profile_id
        || result.preview.account_impact.target.integration_id !== ctx.integration_id
        || result.preview.account_impact.target.connection_id !== authorizationRequest().connection_id)) {
        throw new Error('The account and impact preview is invalid. Refresh the review.');
      }
      preview = result.preview; previewLoading = false; render(); deps.changed();
    }).catch(value => {
      if (disposed || sequence !== previewSequence || key !== permissionKey()) return;
      preview = undefined; previewLoading = false;
      previewError = value instanceof Error ? value.message : 'Could not check permissions. Refresh the preview to try again.';
      render(); deps.changed();
    });
  };
  const fail = (value: unknown): void => {
    error = value instanceof Error ? value.message : 'Managed OAuth failed. Try again.';
    busy = false; profilesLoading = false; render(); deps.changed();
  };
  const failAuthorization = (value: unknown): void => {
    stop(); deps.invalidate(); previewSequence += 1;
    // Keep this key so a terminal failure requires explicit review, after retirement.
    preview = undefined; previewLoading = false;
    previewError = value instanceof Error ? value.message : 'Refresh the permission preview before trying again.';
    fail(value);
  };
  const run = (work: Promise<void>, gen = generation): void => {
    void work.catch((value) => { if (!disposed && gen === generation) fail(value); });
  };
  const discover = async (): Promise<void> => {
    const ctx = deps.context();
    if (!ctx.enabled || !ctx.profile_id || (!deps.manageProfiles && !ctx.base_url)) { integrations = []; render(); return; }
    const key = JSON.stringify([ctx.profile_id, ctx.base_url, ctx.vendor]); discoveryKey = key;
    // Settle an auto-selected profile before capturing this read's generation.
    // Keep integration discovery busy through its request, including on reopen.
    sync(); working = 'Loading vendor integrations…'; busy = true; render(); deps.changed();
    const gen = generation;
    let result: ManagedOAuthResponse;
    try {
      result = await call({ action: 'integrations', profile_id: ctx.profile_id, ...(deps.manageProfiles ? {} : { base_url: ctx.base_url }),
        ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }) });
    } catch (value) { if (!disposed && gen === generation) fail(value); return; }
    if (disposed || gen !== generation || result.action !== 'integrations') return;
    integrations = result.integrations; busy = false;
    if (ctx.mode !== 'edit') deps.requiredScopes?.(result.required_scopes ?? []);
    const selected = ctx.mode === 'edit' || integrations.some((i) => i.id === ctx.integration_id) ? ctx.integration_id : result.selected_id ?? '';
    deps.select(ctx.profile_id, selected); render(); deps.changed(); discoverAccounts();
  };
  const loadAccounts = async (page = 0, preferReuse = false): Promise<void> => {
    const ctx = deps.context(); const gen = generation;
    stop(); deps.invalidate(); clearAccounts(); remotePage = page; working = 'Loading Nango accounts…'; busy = true; render(); deps.changed();
    const result = await call({ action: 'remote_connections', profile_id: ctx.profile_id, integration_id: ctx.integration_id, page });
    if (disposed || gen !== generation || result.action !== 'remote_connections') return;
    remotes = result.connections; remotePage = result.page; remoteMore = result.has_more; busy = false;
    if (preferReuse && remotes.length === 0 && !remoteMore) existingMode = false;
    message = remotes.length === 0 ? deps.manageProfiles ? 'No Nango accounts on this page. Check the selected integration.' : 'No existing accounts on this page. Authorize a new account or check the selected integration.' : '';
    render(); deps.changed();
  };
  const loadUsage = async (): Promise<void> => {
    if (!deps.manageProfiles || !remoteId) return;
    const ctx = deps.context(); const id = remoteId; const seq = ++usageSequence; const gen = generation;
    stopUsageHealthTimer(); usage = undefined; usageError = ''; usageLoading = true; render(); deps.changed();
    try {
      const result = await call({ action: 'account_usage', profile_id: ctx.profile_id, integration_id: ctx.integration_id, connection_id: id });
      if (disposed || seq !== usageSequence || gen !== generation) return;
      if (result.action !== 'account_usage' || !isManagedOAuthAccountUsage(result.usage) || result.usage.connection_id !== id) {
        throw new Error('Account usage could not be verified. Refresh and try again.');
      }
      usage = result.usage;
      scheduleUsageHealth();
    } catch (value) {
      if (disposed || seq !== usageSequence || gen !== generation) return;
      usageError = value instanceof Error ? value.message : 'Account usage could not be read. Try again.';
    }
    if (disposed || seq !== usageSequence || gen !== generation) return;
    usageLoading = false; render(); deps.changed();
  };
  const discoverAccounts = (): void => {
    const ctx = deps.context();
    if (!ctx.enabled || ctx.mode === 'edit' || !ctx.profile_id || !ctx.integration_id) return;
    const key = JSON.stringify([ctx.profile_id, ctx.integration_id]);
    if (key === accountDiscoveryKey) return;
    accountDiscoveryKey = key; existingMode = true; error = ''; message = '';
    // Check before offering new consent. An account is still the owner's choice,
    // even when only one exists; a failed lookup must not imply an empty broker.
    run(loadAccounts(0, !deps.manageProfiles));
  };
  const attachAccount = async (): Promise<void> => {
    if (deps.context().mode !== 'create') return;
    const ctx = deps.context(); const gen = ++generation;
    working = 'Verifying the existing Nango account…';
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
      verifiedFlow = { flow_id: result.flow_id, claim_secret: result.claim_secret, account_id: result.auth.connection_id };
      if (!await finishAuthorization(result.auth, undefined, result.impact_available === true)) return;
      message = 'Existing Nango authorization verified. Save and probe this connection. Granted permissions remain unknown. Manage consent in Nango to change permissions, or authorize a new account here.';
      render(); deps.changed();
    } catch (value) {
      if (!disposed && gen === generation) fail(value);
    }
  };
  const load = async (): Promise<void> => {
    const gen = generation;
    profilesLoading = true; render(); deps.changed();
    const result = await call({ action: 'profiles' });
    if (disposed || result.action !== 'profiles') return;
    profiles = result.profiles; profilesLoading = false; profilesRead = true;
    const ctx = deps.context();
    if (gen !== generation || !ctx.enabled) { render(); deps.changed(); return; }
    if (!ctx.profile_id && profiles.length === 1) deps.select(profiles[0]!.id, '');
    await discover(); render(); deps.changed();
  };
  const readCompletedImpact = async (): Promise<boolean> => {
    if (!verifiedFlow || !readyAuthorization) return false;
    const flow = verifiedFlow; const gen = generation; const ctx = deps.context();
    completedImpact = undefined; impactLoading = true; impactError = ''; busy = true;
    render(); deps.changed();
    try {
      const result = await call({ action: 'account_impact', flow_id: flow.flow_id, claim_secret: flow.claim_secret });
      if (disposed || gen !== generation || verifiedFlow !== flow) return false;
      if (result.action !== 'account_impact' || !isManagedOAuthImpactPreview(result.impact)
        || result.impact.phase !== 'before_save' || result.impact.mode !== (ctx.mode === 'edit' ? 'reauthorize' : ctx.mode)
        || result.impact.target.broker?.id !== ctx.profile_id || result.impact.target.integration_id !== ctx.integration_id
        || result.impact.target.connection_id !== readyAuthorization.auth.connection_id) throw new Error('Invalid account review');
      completedImpact = result.impact;
    } catch {
      if (!disposed && gen === generation) {
        impactError = 'The account and impact could not be reviewed. Refresh this review or authorize again.';
        deps.invalidate();
      }
    }
    if (disposed || gen !== generation) return false;
    impactLoading = false; busy = false; render(); deps.changed(); return completedImpact !== undefined;
  };
  const finishAuthorization = async (auth: ManagedOAuthAuth, grants: readonly string[] | undefined, modern: boolean): Promise<boolean> => {
    readyAuthorization = { auth, grants };
    rememberCompletedAccount(auth);
    if (modern && !await readCompletedImpact()) return false;
    busy = false; deps.authorized(auth, grants); return true;
  };
  const poll = async (gen: number): Promise<void> => {
    const flow = pending;
    if (flow === undefined || disposed || gen !== generation) return;
    if (now() >= flow.expires_at) { failAuthorization(new Error('Authorization expired. Refresh the permission preview before authorizing again.')); return; }
    try {
      const result = await call({ action: 'status', flow_id: flow.flow_id, claim_secret: flow.claim_secret });
      if (disposed || gen !== generation || pending !== flow) return;
      if (result.action !== 'status') throw new Error('Unexpected authorization status response. Refresh the permission preview and try again.');
      if (flow.failures > 0) { flow.failures = 0; message = 'Waiting for vendor authorization.'; render(); deps.changed(); }
      if (result.status === 'authorized' && result.auth !== undefined) {
        pending = undefined; busy = false;
        verifiedFlow = { flow_id: flow.flow_id, claim_secret: flow.claim_secret, account_id: result.auth.connection_id };
        closePopup(flow.popup);
        if (!await finishAuthorization(result.auth, result.granted_scopes, result.impact_available === true)) return;
        message = result.granted_scopes === undefined
          ? 'Authorized. Recued has no confirmed granted-scope metadata from this broker. Save and probe, then use vendor operations to check the access they need.'
          : 'Existing authorization verified. Save and probe this connection.';
        if (deps.context().mode === 'switch') message = 'Account authorization is ready. Verify access to the chosen resource, then apply the switch.';
        message += ' Close the sign-in window if it is still open.';
        render(); deps.changed(); return;
      }
      if (result.status === 'expired' || flow.popup?.closed) {
        failAuthorization(new Error(result.status === 'expired' ? 'Authorization expired. Refresh the permission preview before authorizing again.' : 'Authorization window closed before completion.'));
        return;
      }
      pollTimer = setTimeout(() => { void poll(gen); }, 2500);
    } catch (value) {
      if (disposed || gen !== generation || (pending !== flow && (verifiedFlow?.flow_id !== flow.flow_id || verifiedFlow.claim_secret !== flow.claim_secret))) return;
      const code = value !== null && typeof value === 'object' && 'code' in value ? value.code : undefined;
      if (pending === flow && (code === 'broker_unavailable' || code === 'transport' || code === 'timeout') && now() < flow.expires_at) {
        flow.failures += 1;
        error = ''; message = 'Connection to the OAuth broker was interrupted. Retrying authorization verification…';
        const delay = Math.min(2500 * 2 ** Math.min(flow.failures - 1, 2), flow.expires_at - now());
        pollTimer = setTimeout(() => { void poll(gen); }, delay);
        render(); deps.changed(); return;
      }
      failAuthorization(value);
    }
  };
  const authorize = async (): Promise<void> => {
    const ctx = deps.context();
    if (ctx.mode === 'switch' && !existingMode && completedAccountId) return;
    const force = forcePreview;
    if (force && ctx.mode !== 'edit' && !(ctx.mode === 'switch' && existingMode && remoteId)) return;
    if (ctx.mode !== 'edit' && accountDiscoveryKey !== JSON.stringify([ctx.profile_id, ctx.integration_id])) { discoverAccounts(); return; }
    if ((verifiedFlow !== undefined && !force) || (ctx.mode === 'create' && existingMode)) return;
    const reviewed = previewKey === permissionKey() && !previewLoading ? preview : undefined;
    if (!reviewed || reviewed.decision === 'blocked') { render(); return; }
    const gen = ++generation;
    working = 'Preparing account authorization…';
    const canceled = stop(); deps.invalidate(); busy = true; error = ''; message = '';
    const popup = reviewed.decision === 'reuse' ? null : deps.open === undefined ? globalThis.window?.open('about:blank', '_blank') : deps.open();
    if (!popup && reviewed.decision !== 'reuse') { fail(new Error('Allow popups, then authorize again.')); return; }
    opening = popup; render(); deps.changed();
    try {
      await canceled;
      if (disposed || gen !== generation) { closePopup(popup); return; }
      const result = await call({ action: 'start', ...authorizationRequest(),
        preview_fingerprint: reviewed.fingerprint, ...(force ? { force_reauthorization: true } : {}) });
      if (disposed || gen !== generation) {
        closePopup(popup);
        if (result.action === 'start' || result.action === 'reuse') void call({ action: 'cancel', flow_id: result.flow_id, claim_secret: result.claim_secret }).catch(() => {});
        return;
      }
      if (result.action !== 'start' && result.action !== 'reuse') throw new Error('Unexpected authorization response. Refresh the permission preview and try again.');
      opening = undefined;
      if (result.action === 'reuse') {
        closePopup(popup); busy = false;
        verifiedFlow = { flow_id: result.flow_id, claim_secret: result.claim_secret, account_id: result.auth.connection_id };
        if (!await finishAuthorization(result.auth, result.granted_scopes, result.impact_available === true)) return;
        message = ctx.mode === 'switch' ? 'Account authorization is ready. Verify access to the chosen resource, then apply the switch.' : 'Reusing the saved Nango account. These scopes were requested before; granted permissions remain unknown. Save and probe this connection. Choose Review sign-in again if access needs repair.';
        render(); deps.changed(); return;
      }
      // Own the returned claim before browser navigation or UI callbacks can throw.
      pending = { flow_id: result.flow_id, claim_secret: result.claim_secret, expires_at: result.expires_at, failures: 0, popup: popup ?? null };
      if (!popup) throw new Error('Allow popups, then authorize again.');
      popup.opener = null;
      popup.location.href = result.connect_link;
      message = result.scope_metadata === 'unknown'
        ? 'The broker did not expose its app scopes. Its configured scope profile is preserved; additional requested permissions may need an app change in the broker.'
        : result.scope_metadata === 'fixed'
          ? 'This Microsoft app uses a static .default scope profile. Recued preserves it. Configure additional permissions in the broker app, obtain any required administrator consent, then reauthorize.'
          : 'Complete vendor consent in the authorization window.';
      render(); deps.changed(); void poll(gen);
    } catch (value) {
      closePopup(popup);
      if (disposed || gen !== generation) return;
      failAuthorization(value);
    }
  };
  /** Review completed consent again without creating another remote account. */
  const reviewAuthorization = async (): Promise<void> => {
    const ctx = deps.context(); const id = completedAccountId;
    if (ctx.mode !== 'switch' || !id || setup || integrationSetup) return;
    const gen = ++generation; const canceled = stop(); deps.invalidate(); clearPreview(); forcePreview = false;
    working = 'Checking the authorized account…'; busy = true; error = ''; message = ''; render(); deps.changed();
    try {
      await canceled;
      if (disposed || gen !== generation) return;
      const result = await call({ action: 'account_usage', profile_id: ctx.profile_id, integration_id: ctx.integration_id, connection_id: id });
      if (disposed || gen !== generation) return;
      if (result.action !== 'account_usage' || !isManagedOAuthAccountUsage(result.usage) || result.usage.connection_id !== id) {
        throw new Error('The completed account could not be verified. Refresh accounts and choose it again.');
      }
      remotes = [{ id, label: remotes.find(account => account.id === id)?.label ?? id, auth_error: result.usage.auth_error },
        ...remotes.filter(account => account.id !== id)];
      existingMode = true; remoteId = id; busy = false; render(); deps.changed();
    } catch (value) { if (!disposed && gen === generation) fail(value); }
  };
  const action = async (name: string, connectionName?: string): Promise<void> => {
    if (deps.context().saving) return;
    if ((busy || profilesLoading) && name !== 'cancel') return;
    const ctx = deps.context();
    if (name === 'toggle-key') { showKey = !showKey; render(); return; }
    error = ''; fieldErrors = {};
    const gen = generation;
    switch (name) {
      case 'refresh-usage': await loadUsage(); return;
      case 'open-connection':
      case 'check-connection': {
        if (!deps.manageProfiles || usageLoading || !connectionName) return;
        const connection = usage?.connections.find(row => row.name === connectionName);
        if (!connection) return;
        const operation = name === 'open-connection' ? deps.openConnection : deps.checkConnection;
        if (!operation) return;
        working = name === 'open-connection' ? 'Opening the saved connection…' : 'Checking API access…';
        busy = true; checkingConnection = name === 'check-connection' ? connectionName : undefined; render(); deps.changed();
        try { await operation(connectionName, connection.updated_at); }
        finally { if (!disposed && gen === generation) { busy = false; checkingConnection = undefined; render(); deps.changed(); } }
        if (!disposed && gen === generation && name === 'check-connection') await loadUsage();
        return;
      }
      case 'add':
        if (((setup && profileDraft() !== profileBaseline) || integrationSetup) && !confirmDiscard('this broker setup')) return;
        clearApp(); deletingProfile = false; setup = true; editingProfile = undefined; label = 'Nango Cloud'; server = 'https://api.nango.dev'; apiKey = ''; connectOrigin = ''; showKey = false; profileBaseline = profileDraft(); render(); focusField('label'); return;
      case 'edit': {
        const saved = profiles.find((p) => p.id === ctx.profile_id); if (saved === undefined) return;
        if (integrationSetup && !confirmDiscard('this integration setup')) return;
        clearApp(); deletingProfile = false; setup = true; editingProfile = saved.id; label = saved.label; server = saved.base_url; connectOrigin = saved.connect_ui_origin ?? ''; apiKey = ''; showKey = false; profileBaseline = profileDraft(); render(); focusField('key'); return;
      }
      case 'close-setup':
        if (profileDraft() !== profileBaseline && !confirmDiscard('this broker setup')) return;
        setup = false; apiKey = ''; showKey = false; focus = { selector: `[data-managed-action="${editingProfile ? 'edit' : 'add'}"]` }; render(); deps.changed(); return;
      case 'save-profile': {
        if (!label.trim()) fieldErrors.label = 'Enter a profile name.';
        const validUrl = (value: string): boolean => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } };
        if (!validUrl(server)) fieldErrors.server = 'Enter an HTTP or HTTPS server URL without credentials, a query or a fragment.';
        if (connectOrigin && (!validUrl(connectOrigin) || new URL(connectOrigin).pathname !== '/')) fieldErrors['connect-origin'] = 'Enter only the Connect UI origin, such as https://connect.example.com.';
        if (!editingProfile && !apiKey.trim()) fieldErrors.key = 'Paste the environment API key from Nango.';
        if (Object.keys(fieldErrors).length) {
          if (fieldErrors['connect-origin']) openDetails.add('connect-origin');
          error = 'Check the highlighted fields before testing your broker.'; render(); focusField(Object.keys(fieldErrors)[0]!); return;
        }
        working = 'Testing the broker and saving its encrypted key…'; showKey = false;
        message = '';
        busy = true; render(); deps.changed();
        const result = await call({ action: 'save_profile', label: label.trim(), base_url: server.trim(), broker: 'nango',
          ...(connectOrigin ? { connect_ui_origin: connectOrigin } : {}),
          ...(editingProfile === undefined ? {} : { id: editingProfile }), ...(apiKey ? { api_key: apiKey } : {}) });
        if (disposed || gen !== generation || result.action !== 'save_profile') return;
        apiKey = ''; setup = false; busy = false; stop(); deps.invalidate(); clearAccounts(); clearApp(); existingMode = false; accountDiscoveryKey = '';
        focus = { selector: '[data-managed-field="profile"]' };
        deps.select(result.profile.id, result.profile.id === ctx.profile_id ? ctx.integration_id : ''); await load();
        message = 'Broker tested and saved.'; render(); deps.changed(); return;
      }
      case 'delete': deletingProfile = true; render(); focus = { selector: '[data-managed-action="cancel-delete-profile"]' }; restoreFocus(); return;
      case 'cancel-delete-profile': deletingProfile = false; focus = { selector: '[data-managed-action="delete"]' }; render(); return;
      case 'confirm-delete-profile': {
        if (!deletingProfile) return;
        if (integrationSetup && !confirmDiscard('this integration setup')) return;
        working = 'Removing the broker profile…';
        message = '';
        busy = true; render(); deps.changed();
        await call({ action: 'delete_profile', id: ctx.profile_id });
        if (disposed || gen !== generation) return;
        busy = false; deletingProfile = false; deps.select('', ''); deps.invalidate(); await load(); return;
      }
      case 'refresh-profiles': await load(); return;
      case 'refresh': await discover(); return;
      case 'add-integration': {
        working = 'Loading supported OAuth providers…';
        message = '';
        busy = true; render(); deps.changed();
        const result = await call({ action: 'providers', profile_id: ctx.profile_id,
          ...(deps.manageProfiles ? {} : { base_url: ctx.base_url }), ...(ctx.vendor === undefined ? {} : { vendor: ctx.vendor }) });
        if (disposed || gen !== generation || result.action !== 'providers') return;
        providers = result.providers; providerId = result.selected_id ?? ''; integrationId = providerId ? `recued-${providerId}` : '';
        integrationLabel = providers.find((p) => p.id === providerId)?.label ?? ''; app = 'shared';
        clientId = ''; clientSecret = ''; appScopes = ctx.scopes.join(','); integrationSetup = true; busy = false;
        render(); deps.changed(); focusField('provider'); return;
      }
      case 'close-integration':
        if (!confirmDiscard('this integration setup')) return;
        clearApp(); focus = { selector: '[data-managed-action="add-integration"]' }; render(); deps.changed(); return;
      case 'create-integration': {
        if (!integrationId.trim()) fieldErrors['integration-id'] = 'Enter a unique integration ID.';
        if (!integrationLabel.trim()) fieldErrors['integration-label'] = 'Enter an integration name.';
        if (app === 'custom' && !clientId.trim()) fieldErrors['client-id'] = 'Enter your vendor OAuth client ID.';
        if (app === 'custom' && !clientSecret.trim()) fieldErrors['client-secret'] = 'Enter your vendor OAuth client secret.';
        if (Object.keys(fieldErrors).length) { error = 'Check the highlighted integration fields.'; render(); focusField(Object.keys(fieldErrors)[0]!); return; }
        working = 'Creating the integration in Nango…';
        message = '';
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
        if (deletionDisabled()) return;
        working = 'Deleting the account from Nango…';
        message = '';
        busy = true; render(); deps.changed();
        await call({ action: 'delete_remote_connection', profile_id: ctx.profile_id, integration_id: ctx.integration_id,
          connection_id: remoteId, confirmation: deleteConfirmation });
        if (disposed || gen !== generation) return;
        await loadAccounts(); message = 'Account deleted from Nango. Vendor consent may remain until revoked at the vendor.'; render(); return;
      }
      case 'review-authorization': await reviewAuthorization(); return;
      case 'authorize': await authorize(); return;
      case 'force-reauthorize':
        stop(); deps.invalidate(); forcePreview = !forcePreview; clearPreview(); render(); deps.changed(); return;
      case 'refresh-permissions': clearPreview(); render(); deps.changed(); return;
      case 'refresh-impact': {
        if (await readCompletedImpact() && readyAuthorization) deps.authorized(readyAuthorization.auth, readyAuthorization.grants);
        return;
      }
      case 'cancel': generation += 1; stop(); clearPreview(); deps.invalidate(); busy = false;
        message = 'Authorization canceled. Close the sign-in window if it is still open.'; render(); deps.changed(); return;
    }
  };
  const click = (event: Event): void => {
    const target = event.target as Element | null;
    if (target === null || typeof target.closest !== 'function') return;
    const button = target.closest<HTMLElement>('[data-managed-action]');
    if (button === null || !host?.contains(button) || (button as HTMLButtonElement).disabled) return;
    const gen = generation;
    event.preventDefault(); void action(button.dataset.managedAction ?? '', button.dataset.managedName).catch((value) => {
      if (!disposed && gen === generation) fail(value);
    });
  };
  const input = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (target === null || !host?.contains(target) || !['INPUT', 'SELECT'].includes(target.tagName)) return;
    const field = target.dataset.managedField;
    if ((target.tagName === 'SELECT' ? 'change' : 'input') !== event.type) return;
    if (busy || profilesLoading || deps.context().saving) return;
    rememberFocus();
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
      if (button !== null && button !== undefined) button.disabled = deletionDisabled();
    }
    if (field === 'provider') {
      providerId = target.value; integrationId = `recued-${providerId}`; integrationLabel = providers.find((p) => p.id === providerId)?.label ?? '';
      render();
    }
    if (field === 'app') { app = target.value === 'custom' ? 'custom' : 'shared'; clientSecret = ''; clientId = ''; render(); }
    if (field === 'account-mode' || field === 'account') {
      completedAccountId = ''; completedAccountKey = '';
      generation += 1; stop(); deps.invalidate(); clearPreview(); forcePreview = false;
      if (field === 'account-mode') { existingMode = target.value === 'existing'; clearAccounts(); if (existingMode) run(loadAccounts()); }
      else { clearUsage(); remoteId = target.value; deleteConfirmation = ''; if (deps.manageProfiles) void loadUsage(); }
      render(); deps.changed();
    }
    if (field === 'profile' || field === 'integration') {
      if (integrationSetup && !confirmDiscard('this integration setup')) { render(); return; }
      generation += 1; stop(); deps.invalidate(); clearApp(); clearAccounts(); existingMode = deps.context().mode === 'switch'; accountDiscoveryKey = '';
      deletingProfile = false;
      deps.select(field === 'profile' ? target.value : deps.context().profile_id, field === 'integration' ? target.value : '');
      if (field === 'profile') run(discover());
      deps.changed(); render();
    }
    if (field && fieldErrors[field]) { delete fieldErrors[field]; if (!Object.keys(fieldErrors).length) error = ''; render(); }
  };
  const focusIn = (): void => { rememberFocus(); };
  const focusOut = (event: Event): void => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && !host?.contains(next)) focus = undefined;
  };
  const detach = (): void => {
    host?.removeEventListener('click', click); host?.removeEventListener('input', input); host?.removeEventListener('change', input);
    host?.removeEventListener('focusin', focusIn); host?.removeEventListener('focusout', focusOut);
  };
  const sync = (): void => {
    // New enrollment writes result metadata into the form. Only an edited saved
    // account ID is an authorization input; imported is server-issued metadata.
    let ctx = deps.context(); const key = JSON.stringify([ctx.enabled, ctx.mode, ctx.name, ctx.vendor, ctx.base_url, ctx.scopes,
      ctx.profile_id, ctx.integration_id, ctx.mode === 'edit' ? ctx.connection_id : undefined, ctx.expected_updated_at]);
    if (completedAccountKey && completedAccountKey !== accountContextKey()) { completedAccountId = ''; completedAccountKey = ''; }
    if (contextKey !== '' && key !== contextKey) { generation += 1; stop(); clearPreview(); forcePreview = false; clearAccounts(); clearApp(); accountDiscoveryKey = ''; if (ctx.mode !== 'switch') existingMode = false; busy = false; deps.invalidate(); message = ''; }
    contextKey = key;
    if (ctx.mode === 'switch' && !switchMode) existingMode = true;
    switchMode = ctx.mode === 'switch';
    if (!ctx.enabled) { clearPreview(); forcePreview = false; apiKey = ''; showKey = false; setup = false; deletingProfile = false; fieldErrors = {}; error = ''; message = ''; focus = undefined; clearApp(); clearAccounts(); existingMode = false; accountDiscoveryKey = ''; }
    if (ctx.enabled && !wasEnabled && ctx.mode !== 'edit' && !ctx.profile_id && profiles.length === 1) {
      deps.select(profiles[0]!.id, ''); ctx = deps.context();
    }
    wasEnabled = ctx.enabled;
    const nextDiscovery = JSON.stringify([ctx.profile_id, ctx.base_url, ctx.vendor]);
    if (loaded && ctx.enabled && nextDiscovery !== discoveryKey) run(discover());
    else discoverAccounts();
    syncPreview();
  };
  return {
    mount(element: HTMLElement | null) {
      rememberFocus();
      const enabledBefore = wasEnabled;
      detach(); host = element; sync(); render();
      host?.addEventListener('click', click); host?.addEventListener('input', input); host?.addEventListener('change', input);
      host?.addEventListener('focusin', focusIn); host?.addEventListener('focusout', focusOut);
      if (host !== null && (!loaded || (!enabledBefore && deps.context().enabled))) { loaded = true; run(load()); }
    },
    sync, busy: () => busy || profilesLoading, impactFingerprint: () => completedImpact?.fingerprint,
    hasDraft: () => (setup && profileDraft() !== profileBaseline) || integrationSetup,
    dispose() { disposed = true; generation += 1; stop(); clearPreview(); apiKey = ''; clearApp(); clearAccounts(); detach(); host = null; },
  };
};
