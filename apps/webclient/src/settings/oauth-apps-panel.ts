import { isOAuthAppsResponse, isOAuthAppSecretExpiryDate, oauthAppSecretExpiry, OAUTH_APP_EXPIRY_WARNING_DAYS,
  type OAuthAppsRequest, type OAuthAppsResponse, type OAuthAppIssuer, type SavedOAuthApp } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import { createOAuthPermissionPanel } from './oauth-permission-panel.js';
import type { OAuthPermissionCleanupPopupFactory } from './oauth-permission-cleanup-panel.js';
import { createOAuthAppUsagePanel } from './oauth-app-usage-panel.js';
import { createOAuthTroubleshooting } from '../connections/oauth-troubleshooting.js';
export type OAuthAppsCaller = (args: OAuthAppsRequest) => Promise<OAuthAppsResponse>;
let panelSequence = 0;

/** Only this mounted editor holds a freshly entered secret. Reads return metadata. */
export const createOAuthAppsPanel = (deps: { host: HTMLElement; call: OAuthAppsCaller; changed?(): void; now?(): number; cleanupOAuth?: OAuthPermissionCleanupPopupFactory }) => {
  const host = deps.host;
  const editorId = 'saved-oauth-apps-' + ++panelSequence;
  let apps: SavedOAuthApp[] = []; let loaded = false; let loading = false; let writing = false; let disposed = false;
  let expanded = false; let editing: SavedOAuthApp | null | undefined; let removing: SavedOAuthApp | undefined;
  let issuer: OAuthAppIssuer = 'google'; let label = ''; let clientId = ''; let secret = ''; let baseline = '';
  let expiryDate = ''; let expiryEdited = false; let expiryInvalid = false; let supportsExpiry = false;
  let editingExpirySupported = false; let renderedReminders = '';
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const now = deps.now ?? Date.now;
  let error = ''; let notice = ''; let generation = 0; let pending = Promise.resolve();
  let usagePanel: ReturnType<typeof createOAuthAppUsagePanel> | undefined;
  let permissionPanel: ReturnType<typeof createOAuthPermissionPanel> | undefined;
  const oauthHelp = createOAuthTroubleshooting();
  let helpApp: SavedOAuthApp | undefined;
  let pendingFocus: Record<string, string | undefined> | undefined; let focusOnOpen = false;
  const material = () => JSON.stringify([issuer, label, clientId, secret, expiryDate, expiryInvalid]);
  const draft = () => editing !== undefined && material() !== baseline || usagePanel?.hasDraft() === true || permissionPanel?.hasDraft() === true;
  const clear = () => { editing = undefined; removing = undefined; label = ''; clientId = ''; secret = ''; expiryDate = ''; expiryEdited = false; expiryInvalid = false; editingExpirySupported = false; baseline = ''; };
  const expirySupportChanged = () => editing !== undefined && editingExpirySupported !== supportsExpiry;
  const button = (action: string, text: string, id?: string, disabled = false) =>
    `<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-oauth-app-action="${action}"${action === 'toggle' ? ` aria-expanded="${expanded}" aria-controls="${editorId}"` : ''}${id ? ` data-oauth-app-id="${e(id)}"` : ''}${writing || loading || disabled ? ' disabled' : ''}>${e(text)}</button>`;
  const key = (app: SavedOAuthApp) => app.issuer + ':' + app.id;
  const expiryText = (app: SavedOAuthApp): string => {
    const status = oauthAppSecretExpiry(app, now());
    if (status.status === 'unknown') return 'No secret expiry date recorded';
    if (status.status === 'past_due') return 'Recorded secret expiry: ' + status.date + ' — date has passed';
    if (status.status === 'due_today') return 'Recorded secret expiry: ' + status.date + ' — today';
    return 'Recorded secret expiry: ' + status.date + (status.status === 'due_soon' ? ' — in ' + status.days_remaining + ' day' + (status.days_remaining === 1 ? '' : 's') : '');
  };
  const expiryReminders = (): string => {
    if (!supportsExpiry) return '';
    const due = apps.filter(app => ['past_due', 'due_today', 'due_soon'].includes(oauthAppSecretExpiry(app, now()).status))
      .sort((a, b) => (a.secret_expires_on ?? '').localeCompare(b.secret_expires_on ?? '') || key(a).localeCompare(key(b)));
    if (!due.length) return '';
    return '<section class="oauth-app-expiry-reminders" aria-label="Saved app expiry reminders"><h3>Saved app expiry reminders</h3>'
      + '<p>Dates due within ' + OAUTH_APP_EXPIRY_WARNING_DAYS + ' days, or already past. These are dates you recorded, not vendor checks. Access may still work.</p><ul>'
      + due.map(app => '<li><strong>' + e(app.label) + '</strong> · ' + (app.issuer === 'google' ? 'Google' : 'Microsoft')
        + '<p>' + e(expiryText(app)) + '</p>' + button('usage', 'Review usage and rotate secret', key(app), draft())
        + button('edit-expiry', 'Edit expiry date', key(app), draft()) + '</li>').join('') + '</ul></section>';
  };
  const refreshExpiryView = (): void => {
    if (disposed) return;
    const reminders = host.querySelector?.<HTMLElement>('[data-oauth-app-expiry-reminders]');
    const next = expiryReminders();
    if (reminders && next !== renderedReminders) {
      const active = host.ownerDocument?.activeElement as HTMLElement | null | undefined;
      const focused = active && reminders.contains(active) ? { action: active.dataset.oauthAppAction, id: active.dataset.oauthAppId } : undefined;
      reminders.innerHTML = next; renderedReminders = next;
      if (focused) {
        const replacement = [...reminders.querySelectorAll<HTMLElement>('[data-oauth-app-action]')]
          .find(node => node.dataset.oauthAppAction === focused.action && node.dataset.oauthAppId === focused.id && !node.hasAttribute('disabled'));
        (replacement ?? host.querySelector<HTMLElement>('[data-oauth-app-action="toggle"]'))?.focus({ preventScroll: true });
      }
    }
    for (const node of host.querySelectorAll?.<HTMLElement>('[data-oauth-app-expiry-key]') ?? []) {
      const app = apps.find(app => key(app) === node.dataset.oauthAppExpiryKey);
      if (app) { node.textContent = expiryText(app); node.dataset.oauthAppExpiryState = oauthAppSecretExpiry(app, now()).status; }
    }
  };
  const clearExpiryTimer = (): void => { if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined; };
  const scheduleExpiryTick = (): void => {
    clearExpiryTimer();
    if (disposed || !supportsExpiry || !apps.some(app => isOAuthAppSecretExpiryDate(app.secret_expires_on))) return;
    const at = now(); const current = new Date(at); if (!Number.isFinite(current.getTime())) return;
    const next = current.setHours(24, 0, 0, 0);
    if (!Number.isFinite(next) || next <= at) return;
    expiryTimer = setTimeout(() => { expiryTimer = undefined; refreshExpiryView(); scheduleExpiryTick(); }, Math.max(1, next - at));
  };
  const calendarChanged = (): void => { refreshExpiryView(); scheduleExpiryTick(); };
  const render = () => {
    if (disposed) return;
    const active = host.ownerDocument?.activeElement as HTMLElement | null | undefined;
    if (active && host.contains(active) && (active.dataset?.oauthAppAction || active.dataset?.oauthAppField)) pendingFocus = { ...active.dataset };
    else if (active && !['BODY', 'MAIN'].includes(active.tagName)) pendingFocus = undefined;
    renderedReminders = expiryReminders();
    host.innerHTML = `<section class="oauth-apps" data-saved-oauth-app-manager aria-label="Saved OAuth apps">
      <h2>Saved OAuth apps</h2><p>Save separate Google and Microsoft app credentials for work or personal use. Pick an app when connecting an account.</p>
      <div data-oauth-app-expiry-reminders>${renderedReminders}</div>
      ${button('toggle', expanded ? 'Close saved apps' : 'Manage saved apps')}${button('permissions', 'Permissions and cleanup', undefined, draft())}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}${notice ? `<p role="status">${e(notice)}</p>` : ''}
      ${loading ? '<p role="status">Loading saved apps…</p>' : ''}
      ${expanded ? `<div id="${editorId}">${button('refresh', 'Refresh apps')}${button('add', 'Add OAuth app', undefined, draft())}
        <p>View each app’s usage to rotate its secret across selected credential copies. Mail and Calendar retain their selected app.</p>
        ${loaded && !apps.length ? '<p>No OAuth apps are saved yet.</p>' : ''}
        <ul>${apps.map(app => `<li><strong>${e(app.label)}</strong> · ${app.issuer === 'google' ? 'Google' : 'Microsoft'}${app.id === 'default' ? ' · Default app' : ''}
          <code>${e(app.client_id)}</code>${app.has_secret ? '' : '<span>Client secret needed</span>'}
          ${supportsExpiry ? `<span data-oauth-app-expiry-key="${e(key(app))}" data-oauth-app-expiry-state="${oauthAppSecretExpiry(app, now()).status}">${e(expiryText(app))}</span>` : ''}
          ${app.uses?.length ? `<span>Used by ${e(app.uses.map(use => use.lane + ' ' + use.slug).join(', '))}</span>` : ''}
          ${button('permissions', 'Review permissions', key(app), draft())}${button('usage', 'Usage and rotate secret', key(app), draft())}${button('troubleshoot', 'Troubleshoot OAuth', key(app), draft())}${button('edit', 'Edit', key(app), draft())}${button('remove', 'Remove', key(app), Boolean(app.uses?.length) || draft())}</li>`).join('')}</ul>
        ${removing ? `<div role="group" aria-label="Remove app"><p>Remove ${e(removing.label)} from saved apps?</p>${button('confirm-remove', 'Remove app')}${button('cancel-remove', 'Keep app')}</div>` : ''}
        ${editing !== undefined ? `<form data-oauth-app-editor><h3>${editing ? 'Edit OAuth app' : 'Add OAuth app'}</h3>
          <label>Vendor <select data-oauth-app-field="issuer"${editing || writing ? ' disabled' : ''}><option value="google"${issuer === 'google' ? ' selected' : ''}>Google</option><option value="microsoft"${issuer === 'microsoft' ? ' selected' : ''}>Microsoft</option></select></label>
          <label>App name <input data-oauth-app-field="label" value="${e(label)}" maxlength="80"${writing ? ' disabled' : ''} required></label>
          <label>Client ID <input data-oauth-app-field="client-id" value="${e(clientId)}" maxlength="1024" spellcheck="false"${writing ? ' disabled' : ''} required></label>
          <label>${editing ? 'Client secret for a changed Client ID' : 'Client secret'} <input type="password" data-oauth-app-field="secret" value="${e(secret)}" autocomplete="off"${writing || editing && clientId.trim() === editing.client_id ? ' disabled' : ''}${editing ? '' : ' required'}></label>
          <p>${editing ? 'Leave the secret blank to keep it. Use Usage and rotate secret to change only the secret. A new Client ID needs its matching secret. Accounts using this app must be reconnected before its Client ID can change.' : 'The secret is encrypted on your Recued server and is never returned to the browser.'}</p>
          ${editingExpirySupported ? `<label>Secret expiry date (optional) <input type="date" data-oauth-app-field="expiry" value="${e(expiryDate)}" min="0001-01-01" max="9999-12-31"${writing || expirySupportChanged() ? ' disabled' : ''}></label><p>Copy the date from the vendor app, if known. Leave it blank when unknown. Recued does not look it up. Dates follow your local calendar day; they do not set an exact expiry time.</p>` : ''}
          ${editingExpirySupported ? button('clear-expiry', 'Clear expiry date', undefined, expirySupportChanged()) : ''}
          ${expirySupportChanged() ? '<p role="alert">The server’s expiry support changed while this edit was open. Your draft is kept. Restore the server version and refresh, or cancel this edit and reopen it before saving.</p>' : ''}
          <button type="submit" class="rx-btn rx-btn-primary rx-btn-sm"${writing || loading || expirySupportChanged() ? ' disabled' : ''}>${writing ? 'Saving…' : 'Save app'}</button>${button('cancel-edit', 'Cancel')}
        </form>` : ''}<div data-app-oauth-help-host></div></div>` : ''}<div data-oauth-app-usage-host></div><div data-oauth-permissions-host></div></section>`;
    const currentHelpApp = editing === undefined ? apps.find(app => helpApp && key(app) === key(helpApp)) : editing;
    oauthHelp.mount(host.querySelector?.<HTMLElement>('[data-app-oauth-help-host]') ?? null, expanded && (currentHelpApp || editing === null) ? {
      key: currentHelpApp ? key(currentHelpApp) + ':' + currentHelpApp.revision : 'new:' + issuer,
      route: 'direct', issuer: currentHelpApp?.issuer ?? issuer, savedApp: editing !== null, pending: writing,
    } : null);
    usagePanel?.render(); permissionPanel?.render();
    if (pendingFocus) {
      const control = [...host.querySelectorAll?.<HTMLElement>('[data-oauth-app-action],[data-oauth-app-field]') ?? []]
        .find(node => Object.entries(pendingFocus!).every(([key, value]) => node.dataset[key] === value));
      if (control && !control.hasAttribute('disabled')) { control.focus({ preventScroll: true }); pendingFocus = undefined; }
      else if (!writing && !loading) {
        const add = host.querySelector<HTMLElement>('[data-oauth-app-action="add"]'); add?.focus(); add?.scrollIntoView?.({ block: 'nearest' }); pendingFocus = undefined;
      }
    }
    if (focusOnOpen && !loading) { const add = host.querySelector<HTMLElement>('[data-oauth-app-action="add"]'); add?.focus(); add?.scrollIntoView?.({ block: 'center' }); focusOnOpen = false; }
    scheduleExpiryTick();
  };
  const accept = (result: OAuthAppsResponse, action: OAuthAppsRequest['action']) => {
    if (!isOAuthAppsResponse(result) || result.action !== action) throw new Error('Saved app settings could not be read. Refresh or update the server.');
    apps = structuredClone(result.apps); loaded = true;
    supportsExpiry = result.secret_expiry_supported === true;
  };
  const refresh = (): Promise<void> => {
    if (disposed || loading || writing) return pending;
    const gen = ++generation; loading = true; error = ''; render();
    pending = (async () => {
      try { const result = await deps.call({ action: 'list' }); if (!disposed && gen === generation) accept(result, 'list'); }
      catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'Could not load saved apps.'; }
      finally { if (!disposed && gen === generation) { loading = false; render(); } }
    })(); return pending;
  };
  const write = (request: OAuthAppsRequest) => {
    if (disposed || loading || writing) return;
    const gen = ++generation; writing = true; error = ''; notice = ''; render();
    pending = (async () => {
      try {
        const result = await deps.call(request); if (disposed || gen !== generation) return;
        accept(result, request.action); clear(); notice = request.action === 'save' ? 'OAuth app saved.' : 'OAuth app removed.';
        if (request.action === 'save' && request.secret_expires_on !== undefined) {
          const saved = apps.find(app => app.id === result.saved_id && app.issuer === request.issuer);
          if (!supportsExpiry || !saved || saved.secret_expires_on !== (request.secret_expires_on ?? undefined)) notice += ' The server did not confirm the expiry date. Refresh or update Recued before recording it.';
        }
        try { deps.changed?.(); } catch { notice += ' Refresh connection settings to see the change.'; }
      } catch (err) { if (!disposed && gen === generation) { oauthHelp.observeFailure(err); error = err instanceof Error ? err.message : 'Could not save app settings.'; } }
      finally { if (!disposed && gen === generation) { writing = false; render(); } }
    })();
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-oauth-app-action]');
    if (!target || !host.contains(target) || writing || loading || usagePanel?.busy() || permissionPanel?.busy()) return;
    target.focus?.({ preventScroll: true });
    const action = target.dataset.oauthAppAction; error = ''; notice = '';
    if (action === 'toggle') { if (draft()) { error = 'Save or cancel the app draft before closing it.'; } else expanded = !expanded; }
    else if (action === 'refresh') { void refresh(); return; }
    else if (action === 'permissions') {
      if (draft()) return;
      const selected = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (target.dataset.oauthAppId && !selected) return;
      clear(); void permissionPanel?.open(selected, target); return;
    }
    else if (action === 'troubleshoot') {
      if (draft()) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (!app) return;
      clear(); helpApp = app; render(); oauthHelp.open(); return;
    }
    else if (action === 'usage') {
      if (draft()) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (app) { clear(); void usagePanel?.open(app); } return;
    }
    else if (action === 'add' || action === 'edit' || action === 'edit-expiry') {
      if (draft()) return;
      if (action === 'edit-expiry' && !supportsExpiry) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (action !== 'add' && !app) return;
      expanded = true; editing = app ?? null; removing = undefined; issuer = app?.issuer ?? issuer; label = app?.label ?? ''; clientId = app?.client_id ?? ''; secret = '';
      expiryDate = app?.secret_expires_on ?? ''; expiryEdited = false; expiryInvalid = false; editingExpirySupported = supportsExpiry; baseline = material();
    } else if (action === 'clear-expiry' && editing !== undefined && editingExpirySupported && !expirySupportChanged()) {
      expiryDate = ''; expiryEdited = true; expiryInvalid = false;
    } else if (action === 'cancel-edit') clear();
    else if (action === 'remove') { if (draft()) return; const app = apps.find(app => key(app) === target.dataset.oauthAppId); if (app && !app.uses?.length) removing = app; }
    else if (action === 'cancel-remove') removing = undefined;
    else if (action === 'confirm-remove' && removing) { write({ action: 'delete', issuer: removing.issuer, id: removing.id, expected_revision: removing.revision }); return; }
    render();
    if (action === 'add' || action === 'edit' || action === 'edit-expiry') {
      const field = host.querySelector<HTMLInputElement>('[data-oauth-app-field="' + (action === 'edit-expiry' ? 'expiry' : 'label') + '"]');
      field?.focus(); field?.scrollIntoView?.({ block: 'center' });
    }
    if (action === 'clear-expiry') host.querySelector<HTMLInputElement>('[data-oauth-app-field="expiry"]')?.focus({ preventScroll: true });
  };
  const input = (event: Event) => {
    const field = event.target as HTMLInputElement | HTMLSelectElement | null;
    if (!field?.dataset.oauthAppField || !host.contains(field) || writing || editing === undefined) return;
    const name = field.dataset.oauthAppField;
    if (name === 'issuer' && !editing && (field.value === 'google' || field.value === 'microsoft')) { issuer = field.value; render(); }
    if (name === 'label') label = field.value;
    if (name === 'client-id') {
      clientId = field.value;
      if (editing && !expiryEdited) {
        expiryDate = clientId.trim() === editing.client_id ? editing.secret_expires_on ?? '' : '';
        const expiry = host.querySelector<HTMLInputElement>('[data-oauth-app-field="expiry"]'); if (expiry) expiry.value = expiryDate;
      }
      const input = host.querySelector<HTMLInputElement>('[data-oauth-app-field="secret"]');
      if (input && editing) {
        input.disabled = clientId.trim() === editing.client_id;
        if (input.disabled) { secret = ''; input.value = ''; }
      }
    }
    if (name === 'secret') secret = field.value;
    if (name === 'expiry' && editingExpirySupported && !expirySupportChanged()) { expiryDate = field.value; expiryEdited = true; expiryInvalid = field.validity?.badInput === true; }
  };
  const submit = (event: Event) => {
    if (!(event.target as HTMLElement | null)?.hasAttribute?.('data-oauth-app-editor')) return;
    event.preventDefault(); if (editing === undefined || writing || loading || expirySupportChanged()) return;
    if (!label.trim() || !clientId.trim() || !editing && !secret.trim()) { error = 'Enter an app name, Client ID and matching secret.'; render(); return; }
    if (supportsExpiry && (expiryInvalid || expiryDate && !isOAuthAppSecretExpiryDate(expiryDate))) { error = 'Enter a real secret expiry date, or use Clear expiry date when unknown.'; render(); return; }
    if (editing && clientId.trim() === editing.client_id && secret.trim()) { error = 'Use Usage and rotate secret to review the accounts and credential copies before changing this secret.'; render(); return; }
    write({ action: 'save', issuer, label: label.trim(), client_id: clientId.trim(), ...(secret.trim() ? { client_secret: secret.trim() } : {}),
      ...(supportsExpiry ? { secret_expires_on: expiryDate || null } : {}),
      ...(editing ? { id: editing.id, expected_revision: editing.revision } : {}) });
  };
  host.addEventListener('click', click); host.addEventListener('input', input); host.addEventListener('change', input); host.addEventListener('submit', submit);
  permissionPanel = createOAuthPermissionPanel({ host, call: deps.call, ...(deps.changed ? { changed: deps.changed } : {}), ...(deps.cleanupOAuth ? { cleanupOAuth: deps.cleanupOAuth } : {}) });
  usagePanel = createOAuthAppUsagePanel({ host, call: deps.call, now, changed: () => { void refresh(); deps.changed?.(); } });
  host.ownerDocument?.addEventListener?.('visibilitychange', calendarChanged);
  render(); void refresh();
  return { refresh, whenLoaded: async () => { await pending; await usagePanel?.whenLoaded(); await permissionPanel?.whenLoaded(); }, busy: () => writing || usagePanel?.busy() === true || permissionPanel?.busy() === true, hasDraft: draft,
    open(): void { if (disposed) return; expanded = true; focusOnOpen = true; render(); },
    dispose(): void { disposed = true; generation += 1; clearExpiryTimer(); host.ownerDocument?.removeEventListener?.('visibilitychange', calendarChanged); clear(); usagePanel?.dispose(); permissionPanel?.dispose(); oauthHelp.dispose(); host.removeEventListener('click', click); host.removeEventListener('input', input); host.removeEventListener('change', input); host.removeEventListener('submit', submit); },
  };
};
export const OAUTH_APPS_STYLES = '.oauth-apps{border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0;overflow-wrap:anywhere}.oauth-apps li{padding:8px 0}.oauth-apps code,.oauth-apps li>span{display:block}.oauth-apps button{margin:4px 8px 4px 0}.oauth-apps label{display:grid;gap:4px;margin:10px 0}.oauth-apps input,.oauth-apps select{font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg);min-width:0;max-width:100%}'
  + '.oauth-app-expiry-reminders{border:1px solid var(--warning,#a16207);border-radius:8px;padding:12px;margin:12px 0}.oauth-app-expiry-reminders h3{margin-top:0}.oauth-apps [data-oauth-app-expiry-state="past_due"],.oauth-apps [data-oauth-app-expiry-state="due_today"]{font-weight:600}'
  + '.oauth-permissions{border-top:1px solid var(--border);margin-top:16px;padding-top:12px;min-width:0;overflow-wrap:anywhere}.oauth-permissions section{min-width:0}.oauth-permissions ul{padding-left:20px}.oauth-permissions h5{font-size:1em;margin-bottom:8px}.oauth-permission-scopes>li{margin:12px 0}.oauth-permissions input[type=checkbox]{width:18px;min-width:18px;flex:none}.oauth-permissions li>label{display:flex;align-items:flex-start;gap:8px}.oauth-permissions code{white-space:normal;overflow-wrap:anywhere}'
  + '.oauth-cleanup-worklist{border-top:1px solid var(--border);margin-top:16px;padding-top:12px}.oauth-cleanup-worklist label{display:flex;align-items:flex-start;gap:8px}.oauth-cleanup-worklist [data-permission-cleanup-task]{border:1px solid var(--border);padding:12px;border-radius:8px;margin-top:12px}'
  + '.oauth-cleanup-worklist label.oauth-cleanup-api-field{display:grid}.oauth-cleanup-api-field input{box-sizing:border-box;width:100%}'
  + '.oauth-app-usage{border-top:1px solid var(--border);margin-top:16px;padding-top:12px}.oauth-app-usage ul{padding-left:20px}.oauth-app-usage li>label{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.oauth-app-usage input[type=checkbox]{width:18px;min-width:18px;padding:0;flex:none}.oauth-app-usage li code{display:inline}.oauth-app-usage h4{margin-bottom:6px}';
