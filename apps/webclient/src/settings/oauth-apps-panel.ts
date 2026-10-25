import { isOAuthAppsResponse, isOAuthAppSecretExpiryDate, oauthAppSecretExpiry, OAUTH_APP_EXPIRY_WARNING_DAYS,
  type OAuthAppsRequest, type OAuthAppsResponse, type OAuthAppIssuer, type SavedOAuthApp } from '@recued/contracts';
import { authenticationIncidentHistoryHref, escapeHtml as e } from '@recued/ui-shared';
import { createOAuthPermissionPanel } from './oauth-permission-panel.js';
import type { OAuthPermissionCleanupPopupFactory } from './oauth-permission-cleanup-panel.js';
import { createOAuthAppUsagePanel } from './oauth-app-usage-panel.js';
import { createOAuthAppRenewalPanel } from './oauth-app-renewal-panel.js';
import { createOAuthTroubleshooting } from '../connections/oauth-troubleshooting.js';
import type { ConnectionOAuthAppReview } from '../connections/connections-navigation.js';
export type OAuthAppsCaller = (args: OAuthAppsRequest) => Promise<OAuthAppsResponse>;
let panelSequence = 0;

/** Only this mounted editor holds a freshly entered secret. Reads return metadata. */
export const createOAuthAppsPanel = (deps: { host: HTMLElement; call: OAuthAppsCaller; changed?(): void; now?(): number; cleanupOAuth?: OAuthPermissionCleanupPopupFactory; navigate?(hash: string): void }) => {
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
  let entryPending = Promise.resolve(); let entryGeneration = 0;
  let usagePanel: ReturnType<typeof createOAuthAppUsagePanel> | undefined;
  let renewalPanel: ReturnType<typeof createOAuthAppRenewalPanel> | undefined;
  let permissionPanel: ReturnType<typeof createOAuthPermissionPanel> | undefined;
  const oauthHelp = createOAuthTroubleshooting();
  let helpApp: SavedOAuthApp | undefined;
  let pendingFocus: Record<string, string | undefined> | undefined; let focusOnOpen = false;
  let focusAfter: Record<string, string> | undefined;
  const material = () => JSON.stringify([issuer, label, clientId, secret, expiryDate, expiryInvalid]);
  const draft = () => editing !== undefined && material() !== baseline || usagePanel?.hasDraft() === true || permissionPanel?.hasDraft() === true || renewalPanel?.hasDraft() === true;
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
  const REMINDER_CAP = 3; let laterRemindersOpen = false;
  const expiryReminders = (): string => {
    if (!supportsExpiry) return '';
    const due = apps.filter(app => ['past_due', 'due_today', 'due_soon'].includes(oauthAppSecretExpiry(app, now()).status))
      .sort((a, b) => (a.secret_expires_on ?? '').localeCompare(b.secret_expires_on ?? '') || key(a).localeCompare(key(b)));
    if (!due.length) return '';
    // One line per app, as in the list below (spans, not divs: a reminder is one row of text and two buttons).
    const reminder = (app: SavedOAuthApp): string => '<li><span class="oauth-app-expiry-info"><strong>' + e(app.label) + '</strong> · ' + (app.issuer === 'google' ? 'Google' : 'Microsoft')
      + ' · <span class="oauth-app-expiry-date">' + e(expiryText(app)) + '</span></span><span class="oauth-app-expiry-actions">'
      + button('usage', 'Review usage and rotate secret', key(app), draft())
      + button('edit-expiry', 'Edit expiry date', key(app), draft()) + '</span></li>';
    // The soonest dates first; any beyond REMINDER_CAP wait behind one line.
    const later = due.slice(REMINDER_CAP);
    return '<section class="oauth-app-expiry-reminders" aria-label="Saved app expiry reminders"><h3>Saved app expiry reminders</h3>'
      + '<p>Dates due within ' + OAUTH_APP_EXPIRY_WARNING_DAYS + ' days, or already past. These are dates you recorded, not vendor checks. Access may still work.</p><ul>'
      + due.slice(0, REMINDER_CAP).map(reminder).join('') + '</ul>'
      + (later.length ? '<details class="oauth-app-expiry-more" data-oauth-app-expiry-more' + (laterRemindersOpen ? ' open' : '') + '><summary>Show ' + later.length + ' more</summary><ul>' + later.map(reminder).join('') + '</ul></details>' : '')
      + '</section>';
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
  const vendor = (value: OAuthAppIssuer): string => value === 'google' ? 'Google' : 'Microsoft';
  // A long list stays scannable: one line per app until it is opened, grouped
  // by vendor, a filter once there are more than FILTER_FROM apps, and the
  // first LIST_CAP rows until all are asked for.
  const FILTER_FROM = 6; const LIST_CAP = 8;
  const openRows = new Set<string>(); let filter = ''; let showAll = false;
  const ordered = (): SavedOAuthApp[] => [...apps].sort((a, b) => a.issuer.localeCompare(b.issuer)
    || Number(b.id === 'default') - Number(a.id === 'default') || a.label.localeCompare(b.label));
  const matches = (app: SavedOAuthApp): boolean => {
    const query = filter.trim().toLowerCase();
    return !query || [app.label, app.client_id, vendor(app.issuer), ...(app.uses ?? []).map(use => use.lane + ' ' + use.slug)]
      .some(text => text.toLowerCase().includes(query));
  };
  /** A row being edited, removed or opened always shows, cap or not. */
  const pinned = (app: SavedOAuthApp): boolean => openRows.has(key(app))
    || !!editing && key(editing) === key(app) || !!removing && key(removing) === key(app);
  const visibleRows = (): { shown: Set<string>; matched: number } => {
    const shown = new Set<string>(); const capped = !filter.trim() && !showAll; let matched = 0;
    for (const app of ordered()) {
      if (!matches(app)) continue;
      matched += 1;
      if (!capped || shown.size < LIST_CAP || pinned(app)) shown.add(key(app));
    }
    return { shown, matched };
  };
  const countText = (matched: number): string => (filter.trim() ? matched + ' of ' : '') + apps.length + (apps.length === 1 ? ' app' : ' apps');
  const editorForm = (): string => editing === undefined ? '' : `<form data-oauth-app-editor><h3>${editing ? 'Edit OAuth app' : 'Add OAuth app'}</h3>
    <label>Vendor <select data-oauth-app-field="issuer"${editing || writing ? ' disabled' : ''}><option value="google"${issuer === 'google' ? ' selected' : ''}>Google</option><option value="microsoft"${issuer === 'microsoft' ? ' selected' : ''}>Microsoft</option></select></label>
    <label>App name <input data-oauth-app-field="label" value="${e(label)}" maxlength="80"${writing ? ' disabled' : ''} required></label>
    <label>Client ID <input data-oauth-app-field="client-id" value="${e(clientId)}" maxlength="1024" spellcheck="false"${writing ? ' disabled' : ''} required></label>
    <label>${editing ? 'Client secret for a changed Client ID' : 'Client secret'} <input type="password" data-oauth-app-field="secret" value="${e(secret)}" autocomplete="off"${writing || editing && clientId.trim() === editing.client_id ? ' disabled' : ''}${editing ? '' : ' required'}></label>
    <p>${editing ? 'Leave the secret blank to keep it. Use Usage and rotate secret to change only the secret. A new Client ID needs its matching secret. Accounts using this app must be reconnected before its Client ID can change.' : 'The secret is encrypted on your Recued server and is never returned to the browser.'}</p>
    ${editingExpirySupported ? `<label>Secret expiry date (optional) <input type="date" data-oauth-app-field="expiry" value="${e(expiryDate)}" min="0001-01-01" max="9999-12-31"${writing || expirySupportChanged() ? ' disabled' : ''}></label><p>Copy the date from the vendor app, if known. Leave it blank when unknown. Recued does not look it up. Dates follow your local calendar day; they do not set an exact expiry time.</p>` : ''}
    ${editingExpirySupported ? button('clear-expiry', 'Clear expiry date', undefined, expirySupportChanged()) : ''}
    ${expirySupportChanged() ? '<p role="alert">The server’s expiry support changed while this edit was open. Your draft is kept. Restore the server version and refresh, or cancel this edit and reopen it before saving.</p>' : ''}
    <div class="oauth-apps-form-actions"><button type="submit" class="rx-btn rx-btn-primary rx-btn-sm"${writing || loading || expirySupportChanged() ? ' disabled' : ''}>${writing ? 'Saving…' : 'Save app'}</button>${button('cancel-edit', 'Cancel')}</div>
  </form>`;
  // Troubleshooting help opens beside what it is about: the add form, or the app's row.
  const helpBeside = (app?: SavedOAuthApp): boolean => app === undefined ? editing === null
    : editing ? key(editing) === key(app) : editing === undefined && !!helpApp && key(helpApp) === key(app);
  const appRow = (app: SavedOAuthApp, shown: Set<string>): string => {
    const id = key(app); const held = draft();
    return `<li class="oauth-app-row" data-oauth-app-row="${e(id)}"${shown.has(id) ? '' : ' hidden'}><details data-oauth-app-details="${e(id)}"${pinned(app) ? ' open' : ''}>
      <summary><span class="oauth-app-row-name"><strong>${e(app.label)}</strong>${app.id === 'default' ? '<span class="oauth-app-flag">Default</span>' : ''}${app.has_secret ? '' : '<span class="oauth-app-flag oauth-app-flag-warn">Client secret needed</span>'}${app.uses?.length ? `<span class="oauth-app-flag">Used by ${app.uses.length}</span>` : ''}</span>
        <code class="oauth-app-row-client">${e(app.client_id)}</code><span class="oauth-app-row-chevron" aria-hidden="true"></span></summary>
      <div class="oauth-app-row-body">
        <p>${vendor(app.issuer)} app${app.id === 'default' ? ' · Default app' : ''} · Client ID <code>${e(app.client_id)}</code></p>
        ${supportsExpiry ? `<p data-oauth-app-expiry-key="${e(id)}" data-oauth-app-expiry-state="${oauthAppSecretExpiry(app, now()).status}">${e(expiryText(app))}</p>` : ''}
        ${app.uses?.length ? `<p>Used by ${e(app.uses.map(use => use.lane + ' ' + use.slug).join(', '))}</p>` : ''}
        <div class="oauth-app-row-actions">${button('permissions', 'Review permissions', id, held)}${button('usage', 'Usage and rotate secret', id, held)}${button('renewal', 'Verify token renewal', id, held)}${button('troubleshoot', 'Troubleshoot OAuth', id, held)}${button('edit', 'Edit', id, held)}${button('remove', 'Remove', id, Boolean(app.uses?.length) || held)}</div>
        ${removing && key(removing) === id ? `<div class="oauth-apps-confirm" role="group" aria-label="Remove app"><p>Remove ${e(removing.label)} from saved apps?</p>${button('confirm-remove', 'Remove app')}${button('cancel-remove', 'Keep app')}</div>` : ''}
        ${editing && key(editing) === id ? editorForm() : ''}
        ${helpBeside(app) ? '<div data-app-oauth-help-host></div>' : ''}
      </div></details></li>`;
  };
  const appList = (): string => {
    const { shown, matched } = visibleRows(); const query = filter.trim();
    return (apps.length > FILTER_FROM || query ? `<div class="oauth-apps-find"><input type="search" data-oauth-app-filter value="${e(filter)}" placeholder="Find an app by name, Client ID or account" aria-label="Find a saved app">
        <span class="oauth-apps-count" data-oauth-app-count role="status">${e(countText(matched))}</span></div>` : '')
      + (['google', 'microsoft'] as const).map(group => {
        const members = ordered().filter(app => app.issuer === group);
        if (!members.length) return '';
        return `<section class="oauth-apps-group" data-oauth-app-group="${group}"${members.some(app => shown.has(key(app))) ? '' : ' hidden'}>
          <h4>${vendor(group)} <span class="oauth-apps-group-count">${members.length}</span></h4>
          <ul>${members.map(app => appRow(app, shown)).join('')}</ul></section>`;
      }).join('')
      + `<p class="oauth-apps-empty" data-oauth-app-no-match${query && matched === 0 ? '' : ' hidden'}>No saved app matches “${e(query)}”.</p>`
      + (apps.length > LIST_CAP ? `<button type="button" class="rx-btn rx-btn-link rx-btn-sm oauth-apps-more" data-oauth-app-action="show-all"${query ? ' hidden' : ''}>${showAll ? 'Show fewer apps' : 'Show all ' + apps.length + ' apps'}</button>` : '');
  };
  /** Typing in the filter updates the rows in place, so the field keeps its focus and caret. */
  const applyFilter = (): void => {
    const { shown, matched } = visibleRows(); const query = filter.trim();
    for (const node of host.querySelectorAll?.<HTMLElement>('[data-oauth-app-row]') ?? []) node.hidden = !shown.has(node.dataset.oauthAppRow ?? '');
    for (const group of host.querySelectorAll?.<HTMLElement>('[data-oauth-app-group]') ?? []) {
      group.hidden = ![...group.querySelectorAll<HTMLElement>('[data-oauth-app-row]')].some(node => !node.hidden);
    }
    const count = host.querySelector?.<HTMLElement>('[data-oauth-app-count]'); if (count) count.textContent = countText(matched);
    const none = host.querySelector?.<HTMLElement>('[data-oauth-app-no-match]');
    if (none) { none.hidden = !(query && matched === 0); none.textContent = 'No saved app matches “' + query + '”.'; }
    const more = host.querySelector?.<HTMLElement>('[data-oauth-app-action="show-all"]'); if (more) more.hidden = query !== '';
  };
  const render = () => {
    if (disposed) return;
    const active = host.ownerDocument?.activeElement as HTMLElement | null | undefined;
    if (focusAfter) { pendingFocus = focusAfter; focusAfter = undefined; }
    else if (active && host.contains(active) && (active.dataset?.oauthAppAction || active.dataset?.oauthAppField)) pendingFocus = { ...active.dataset };
    else if (active && !['BODY', 'MAIN'].includes(active.tagName)) pendingFocus = undefined;
    renderedReminders = expiryReminders();
    host.innerHTML = `<section class="oauth-apps" data-saved-oauth-app-manager aria-label="Saved OAuth apps">
      <h2>Saved OAuth apps</h2><p>Save separate Google and Microsoft app credentials for work or personal use. Pick an app when connecting an account.</p>
      <div data-oauth-app-expiry-reminders>${renderedReminders}</div>
      <div class="oauth-apps-toolbar">${button('toggle', expanded ? 'Close saved apps' : 'Manage saved apps')}${button('permissions', 'Permissions and cleanup', undefined, draft())}</div>
      ${error ? `<p role="alert">${e(error)}</p>` : ''}${notice ? `<p role="status">${e(notice)}</p>` : ''}
      ${loading ? '<p role="status">Loading saved apps…</p>' : ''}
      ${expanded ? `<div id="${editorId}" class="oauth-apps-manager">
        <div class="oauth-apps-toolbar">${button('add', 'Add OAuth app', undefined, draft())}${button('refresh', 'Refresh apps')}
          ${!draft() && !writing && !loading ? `<a class="oauth-apps-history" href="${e(authenticationIncidentHistoryHref({ kind: 'oauth_apps' }))}">View saved-app history</a>` : ''}</div>
        ${editing === null ? editorForm() : ''}${helpBeside() ? '<div data-app-oauth-help-host></div>' : ''}
        ${loaded && !apps.length ? '<p>No OAuth apps are saved yet.</p>' : appList()}
        <p class="oauth-apps-note">View each app’s usage to rotate its secret across selected credential copies. Mail and Calendar retain their selected app.</p>
      </div>` : ''}<div data-oauth-app-usage-host></div><div data-oauth-app-renewal-host></div><div data-oauth-permissions-host></div></section>`;
    const currentHelpApp = editing === undefined ? apps.find(app => helpApp && key(app) === key(helpApp)) : editing;
    oauthHelp.mount(host.querySelector?.<HTMLElement>('[data-app-oauth-help-host]') ?? null, expanded && (currentHelpApp || editing === null) ? {
      key: currentHelpApp ? key(currentHelpApp) + ':' + currentHelpApp.revision : 'new:' + issuer,
      route: 'direct', issuer: currentHelpApp?.issuer ?? issuer, savedApp: editing !== null, pending: writing,
    } : null);
    usagePanel?.render(); permissionPanel?.render(); renewalPanel?.render();
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
  const openRenewal = (app: SavedOAuthApp, onClose?: () => void): Promise<void> => {
    if (renewalPanel && !renewalPanel.canOpen(app)) {
      error = 'Another saved app has an unfinished renewal check. Read its result or refresh its status before reviewing token renewal for this app.'; render();
      return Promise.resolve();
    }
    return renewalPanel?.open(app, onClose) ?? Promise.resolve();
  };
  const click = (event: Event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-oauth-app-action]');
    if (!target || !host.contains(target) || writing || loading || usagePanel?.busy() || permissionPanel?.busy() || renewalPanel?.busy()) return;
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
      clear(); helpApp = app; openRows.add(key(app)); render(); oauthHelp.open(); return;
    }
    else if (action === 'show-all') showAll = !showAll;
    else if (action === 'usage') {
      if (draft()) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (app) { clear(); void usagePanel?.open(app); } return;
    }
    else if (action === 'renewal') {
      if (draft()) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (app) { clear(); void openRenewal(app, () => {
        [...host.querySelectorAll<HTMLElement>('[data-oauth-app-action="renewal"]')].find(n => n.dataset.oauthAppId === key(app))?.focus({ preventScroll: true });
      }); } return;
    }
    else if (action === 'add' || action === 'edit' || action === 'edit-expiry') {
      if (draft()) return;
      if (action === 'edit-expiry' && !supportsExpiry) return;
      const app = apps.find(app => key(app) === target.dataset.oauthAppId);
      if (action !== 'add' && !app) return;
      expanded = true; editing = app ?? null; removing = undefined; issuer = app?.issuer ?? issuer; label = app?.label ?? ''; clientId = app?.client_id ?? ''; secret = '';
      expiryDate = app?.secret_expires_on ?? ''; expiryEdited = false; expiryInvalid = false; editingExpirySupported = supportsExpiry; baseline = material();
      if (app) openRows.add(key(app));
    } else if (action === 'clear-expiry' && editing !== undefined && editingExpirySupported && !expirySupportChanged()) {
      expiryDate = ''; expiryEdited = true; expiryInvalid = false;
    } else if (action === 'cancel-edit') {
      // Back to the row's Edit, not to the top of a long list.
      if (editing) focusAfter = { oauthAppAction: 'edit', oauthAppId: key(editing) };
      clear();
    }
    else if (action === 'remove') { if (draft()) return; const app = apps.find(app => key(app) === target.dataset.oauthAppId); if (app && !app.uses?.length) { removing = app; openRows.add(key(app)); } }
    else if (action === 'cancel-remove') { if (removing) focusAfter = { oauthAppAction: 'remove', oauthAppId: key(removing) }; removing = undefined; }
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
    if (field?.hasAttribute?.('data-oauth-app-filter') && host.contains(field)) { filter = field.value; applyFilter(); return; }
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
  // A row stays open across re-renders once opened. `toggle` does not bubble, so listen as it passes down.
  const toggle = (event: Event) => {
    const details = event.target as HTMLDetailsElement | null; if (!details || !host.contains(details)) return;
    if (details.hasAttribute?.('data-oauth-app-expiry-more')) { laterRemindersOpen = details.open; return; }
    const id = details.dataset?.oauthAppDetails; if (!id) return;
    if (details.open) openRows.add(id); else openRows.delete(id);
  };
  host.addEventListener('click', click); host.addEventListener('input', input); host.addEventListener('change', input); host.addEventListener('submit', submit);
  host.addEventListener('toggle', toggle, true);
  permissionPanel = createOAuthPermissionPanel({ host, call: deps.call, ...(deps.changed ? { changed: deps.changed } : {}), ...(deps.cleanupOAuth ? { cleanupOAuth: deps.cleanupOAuth } : {}) });
  renewalPanel = createOAuthAppRenewalPanel({ host, call: deps.call, now,
    canNavigate: () => !writing && !loading && !(editing !== undefined && material() !== baseline) && !usagePanel?.busy() && !usagePanel?.hasDraft() && !permissionPanel?.busy() && !permissionPanel?.hasDraft(),
    navigate: hash => { if (deps.navigate) deps.navigate(hash); else if (host.ownerDocument?.defaultView) host.ownerDocument.defaultView.location.hash = hash; } });
  usagePanel = createOAuthAppUsagePanel({ host, call: deps.call, now, changed: () => { void refresh(); deps.changed?.(); }, verifyRenewal: app => { void openRenewal(app); } });
  host.ownerDocument?.addEventListener?.('visibilitychange', calendarChanged);
  render(); void refresh();
  return { refresh, whenLoaded: async () => { await pending; await entryPending; await usagePanel?.whenLoaded(); await permissionPanel?.whenLoaded(); await renewalPanel?.whenLoaded(); }, busy: () => writing || usagePanel?.busy() === true || permissionPanel?.busy() === true || renewalPanel?.busy() === true, hasDraft: draft,
    open(target?: ConnectionOAuthAppReview): void {
      if (disposed) return; expanded = true; focusOnOpen = !target; render(); const entry = ++entryGeneration;
      if (target) entryPending = (async () => {
        await pending; if (disposed || entry !== entryGeneration) return;
        if (draft() || writing || loading || usagePanel?.busy() || permissionPanel?.busy() || renewalPanel?.busy()) {
          error = 'Finish the current app review before opening another.'; render(); return;
        }
        const app = apps.find(a => a.issuer === target.issuer && a.id === target.id);
        if (!loaded || !app) { error = 'This saved OAuth app could not be found. Refresh saved apps and choose a current app.'; render(); return; }
        clear(); if (target.view === 'usage') await usagePanel?.open(app); else await openRenewal(app);
      })();
    },
    dispose(): void { disposed = true; generation += 1; entryGeneration++; clearExpiryTimer(); host.ownerDocument?.removeEventListener?.('visibilitychange', calendarChanged); clear(); usagePanel?.dispose(); permissionPanel?.dispose(); renewalPanel?.dispose(); oauthHelp.dispose(); host.removeEventListener('click', click); host.removeEventListener('input', input); host.removeEventListener('change', input); host.removeEventListener('submit', submit); host.removeEventListener('toggle', toggle, true); },
  };
};
export const OAUTH_APPS_STYLES = '.oauth-apps{border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0;overflow-wrap:anywhere}.oauth-apps li{padding:8px 0}.oauth-apps code,.oauth-apps li>span{display:block}.oauth-apps button{margin:4px 8px 4px 0}.oauth-apps label{display:grid;gap:4px;margin:10px 0}.oauth-apps input,.oauth-apps select{font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg);min-width:0;max-width:100%}'
  + '.oauth-app-expiry-reminders{border:1px solid var(--warning,#a16207);border-radius:8px;padding:12px;margin:12px 0}.oauth-app-expiry-reminders h3{margin-top:0}.oauth-apps [data-oauth-app-expiry-state="past_due"],.oauth-apps [data-oauth-app-expiry-state="due_today"]{font-weight:600}'
  + '.oauth-permissions{border-top:1px solid var(--border);margin-top:16px;padding-top:12px;min-width:0;overflow-wrap:anywhere}.oauth-permissions section{min-width:0}.oauth-permissions ul{padding-left:20px}.oauth-permissions h5{font-size:1em;margin-bottom:8px}.oauth-permission-scopes>li{margin:12px 0}.oauth-permissions input[type=checkbox]{width:18px;min-width:18px;flex:none}.oauth-permissions li>label{display:flex;align-items:flex-start;gap:8px}.oauth-permissions code{white-space:normal;overflow-wrap:anywhere}'
  + '.oauth-cleanup-worklist{border-top:1px solid var(--border);margin-top:16px;padding-top:12px}.oauth-cleanup-worklist label{display:flex;align-items:flex-start;gap:8px}.oauth-cleanup-worklist [data-permission-cleanup-task]{border:1px solid var(--border);padding:12px;border-radius:8px;margin-top:12px}'
  + '.oauth-cleanup-worklist label.oauth-cleanup-api-field{display:grid}.oauth-cleanup-api-field input{box-sizing:border-box;width:100%}'
  + '.oauth-app-usage,.oauth-app-renewal{border-top:1px solid var(--border);margin-top:16px;padding-top:12px;min-width:0}.oauth-app-usage ul,.oauth-app-renewal ul{padding-left:20px}.oauth-app-usage li>label,.oauth-app-renewal li>label{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}.oauth-app-usage input[type=checkbox],.oauth-app-renewal input[type=checkbox]{width:18px;min-width:18px;padding:0;flex:none}.oauth-app-usage li code{display:inline}.oauth-app-usage h4,.oauth-app-renewal h4{margin-bottom:6px}'
  + '.oauth-app-renewal button{max-width:100%;white-space:normal;overflow-wrap:anywhere}'
  // The list: one line per app until opened, grouped by vendor, with a filter for long lists.
  + '.oauth-apps [hidden]{display:none!important}'
  + '.oauth-app-expiry-reminders>p{margin:4px 0 0;color:var(--fg-muted);font-size:12.5px}'
  + '.oauth-app-expiry-reminders ul{display:grid;gap:6px;margin:10px 0 0;padding:0;list-style:none}'
  + '.oauth-apps .oauth-app-expiry-reminders li{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}'
  + '.oauth-app-expiry-info{min-width:0}.oauth-app-expiry-date{color:var(--fg-muted)}'
  + '.oauth-app-expiry-more{margin-top:6px}.oauth-app-expiry-more>summary{cursor:pointer;color:var(--accent);font-size:12.5px;font-weight:600}'
  // (0,2,0): the older ".oauth-apps li>span" block rule would otherwise win.
  + '.oauth-apps .oauth-app-expiry-actions{display:flex;flex-wrap:wrap;gap:6px}.oauth-app-expiry-actions button{margin:0}'
  + '.oauth-apps .oauth-apps-more{justify-self:start}'
  + '.oauth-apps-toolbar,.oauth-app-row-actions,.oauth-apps-form-actions,.oauth-apps-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px}'
  + '.oauth-apps-toolbar button,.oauth-app-row-actions button,.oauth-apps-form-actions button,.oauth-apps-confirm button,.oauth-apps .oauth-apps-more{margin:0}'
  + '.oauth-apps-confirm p{flex-basis:100%;margin:0}'
  + '.oauth-apps-manager{display:grid;gap:12px;margin-top:12px;min-width:0}'
  + '.oauth-apps-history{color:var(--accent);font-size:12.5px;font-weight:600;text-decoration:none}.oauth-apps-history:hover{text-decoration:underline}'
  + '.oauth-apps-find{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}.oauth-apps-find input{flex:1 1 240px;box-sizing:border-box}'
  + '.oauth-apps-count,.oauth-apps-note,.oauth-apps-empty{margin:0;color:var(--fg-muted);font-size:12.5px}'
  + '.oauth-apps-group{display:grid;gap:6px;min-width:0}'
  + '.oauth-apps-group h4{margin:0;color:var(--fg-muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}'
  + '.oauth-apps-group-count{margin-left:4px}'
  + '.oauth-apps-group ul{display:grid;gap:6px;margin:0;padding:0;list-style:none}'
  + '.oauth-apps .oauth-app-row{padding:0;min-width:0}'
  + '.oauth-app-row>details{min-width:0;border:1px solid var(--border);border-radius:8px;background:var(--surface)}'
  + '.oauth-app-row summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,38%) auto;align-items:center;gap:4px 12px;padding:9px 12px;border-radius:8px;cursor:pointer;list-style:none}'
  + '.oauth-app-row summary::-webkit-details-marker{display:none}.oauth-app-row summary:hover{background:var(--surface-sunk)}'
  + '.oauth-app-row summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}'
  + '.oauth-app-row>details[open]>summary{border-bottom:1px solid var(--border);border-radius:8px 8px 0 0}'
  + '.oauth-app-row-name{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}'
  + '.oauth-apps .oauth-app-row-client{display:block;max-width:100%;min-width:0;overflow:hidden;justify-self:end;color:var(--fg-muted);font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}'
  + '.oauth-app-row-chevron{width:6px;height:6px;margin:0 4px 3px 0;border-right:2px solid var(--fg-muted);border-bottom:2px solid var(--fg-muted);transform:rotate(45deg)}'
  + '.oauth-app-row>details[open] .oauth-app-row-chevron{margin-bottom:-3px;transform:rotate(-135deg)}'
  + '.oauth-app-flag{display:inline-block;padding:0 7px;border:1px solid var(--border);border-radius:999px;color:var(--fg-muted);font-size:11px;line-height:18px;white-space:nowrap}'
  + '.oauth-app-flag-warn{border-color:color-mix(in srgb,var(--warning,#a16207) 45%,var(--border));color:var(--warning,#a16207)}'
  + '.oauth-app-row-body{display:grid;gap:8px;min-width:0;padding:10px 12px 12px}.oauth-app-row-body>p{margin:0}'
  + '.oauth-apps .oauth-app-row-body code{display:inline;overflow-wrap:anywhere}'
  + '@media (max-width:560px){.oauth-app-row summary{grid-template-columns:minmax(0,1fr) auto}'
  + '.oauth-apps .oauth-app-row-client{grid-column:1;grid-row:2;justify-self:start}.oauth-app-row-chevron{grid-column:2;grid-row:1}}';
