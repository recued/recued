/** D-322 §43 — permission consolidation, with explicit read-only cleanup previews. */
import { isOAuthAppsResponse, isOAuthPermissionInventory, isOAuthPermissionCleanupPreview,
  isOAuthPermissionCleanupJob, managedOAuthDefaultVerificationUrl,
  type OAuthPermissionInventory, type OAuthPermissionCleanupPreview, type SavedOAuthApp } from '@recued/contracts';
import { escapeHtml as e } from '@recued/ui-shared';
import type { OAuthAppsCaller } from './oauth-apps-panel.js';
import { createOAuthPermissionCleanupPanel, type OAuthPermissionCleanupPopupFactory } from './oauth-permission-cleanup-panel.js';
import { scopeLabel, scopeDetail, scopeListItem } from './oauth-permission-scope-view.js';

export const createOAuthPermissionPanel = (deps: { host: HTMLElement; call: OAuthAppsCaller; changed?(): void; cleanupOAuth?: OAuthPermissionCleanupPopupFactory }) => {
  let inventory: OAuthPermissionInventory | undefined; let preview: OAuthPermissionCleanupPreview | undefined;
  let app: SavedOAuthApp | undefined; let groupId: string | undefined; let chosen = new Set<string>();
  let visible = false; let busy = false; let disposed = false; let generation = 0; let error = ''; let stale = false;
  let pending = Promise.resolve(); let returnFocus: HTMLElement | undefined;
  let cleanup: ReturnType<typeof createOAuthPermissionCleanupPanel> | undefined; let cleanupAvailable = false;
  const apiUrls = new Map<string, string>();
  const apiResources = () => {
    const selected = inventory?.groups.find(g => g.id === preview?.group_id);
    return inventory?.groups.filter(g => g.app_key === selected?.app_key).flatMap(g => g.api_resources ?? []) ?? [];
  };
  const working = () => busy || cleanup?.busy() === true;
  const button = (action: string, label: string, disabled = false) => '<button type="button" class="rx-btn rx-btn-outline rx-btn-sm" data-permission-action="'
    + action + '"' + (disabled ? ' disabled' : '') + '>' + e(label) + '</button>';
  const uses = (rows: OAuthPermissionInventory['groups'][number]['uses']) => rows.length ? '<ul>' + rows.map(use => '<li>'
    + e(use.kind + ': ' + use.label) + (use.may_use ? ' (may use)' : '') + (use.paused ? ' (paused)' : '') + '</li>').join('') + '</ul>' : '<p>No local dependents were found.</p>';
  const previewHtml = (): string => {
    if (!preview || !inventory) return '';
    const selected = inventory.groups.find(g => g.id === preview!.group_id);
    return '<section data-permission-cleanup-preview aria-label="Permission cleanup preview"><h4 tabindex="-1" data-cleanup-heading>Cleanup preview</h4>'
      + '<p>Selected permissions no longer needed locally:</p><ul>' + preview.selected_scopes.map(scopeListItem).join('') + '</ul>'
      + '<p>Permissions needed by current features:</p><ul>' + preview.required_scopes.map(scopeListItem).join('') + '</ul>'
      + '<details><summary>Other recorded permissions to keep</summary><ul>' + preview.retained_scopes.map(scopeListItem).join('') + '</ul></details>'
      + '<h4>Local uses of this authorization</h4>' + uses(preview.uses)
      + (preview.connection_names.length ? '<p>Connections: ' + e(preview.connection_names.join(', ')) + '.</p>' : '')
      + (preview.related_group_ids.length ? '<p>Other authorizations using this app may also be affected. Their account and grant identity have not been combined:</p><ul>'
        + preview.related_group_ids.map(id => inventory!.groups.find(g => g.id === id)).filter(g => g !== undefined)
          .map(g => '<li>' + e(g.app_label + ' · ' + g.account_label) + uses(g.uses) + '</li>').join('') + '</ul>' : '')
      + preview.warnings.map(w => '<p role="note">' + e(w) + '</p>').join('')
      + '<p><strong>No permissions have been removed.</strong> This preview identifies possible cleanup; it does not revoke access or reconnect accounts.</p>'
      + (selected?.issuer === 'google' ? '<p><a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Review Google account access</a></p>'
        : selected?.issuer === 'microsoft' ? '<p><a href="https://myapps.microsoft.com/" target="_blank" rel="noopener noreferrer">Review work or school app access</a> · '
          + '<a href="https://account.live.com/consent/Manage" target="_blank" rel="noopener noreferrer">Review personal Microsoft app access</a></p>' : '')
      + (cleanupAvailable && selected?.issuer === 'google' && selected.authentication === 'direct_oauth'
        ? (apiResources().length ? '<p>Choose a read-only URL that requires sign-in for each API connection. For Sheets, paste a private spreadsheet URL. Recued checks the same resource with and without the new credentials. It does not request extra permissions to identify an account.</p>'
          + apiResources().map(resource => '<label>Protected read URL for ' + e(resource.name) + '<input type="url" data-permission-api-url="' + e(resource.name) + '" value="'
            + e(apiUrls.get(resource.name) ?? managedOAuthDefaultVerificationUrl(resource.base_url))
            + '" placeholder="https://…"' + (working() ? ' disabled' : '') + '></label>').join('') : '')
          + button('start-cleanup', 'Start guided Google cleanup', working())
        : '<p>Guided reset is available for supported Recued direct Google sign-ins. Other authorizations keep the vendor review shown above.</p>')
      + button('back', 'Change cleanup selection', working()) + '</section>';
  };
  const render = () => {
    const host = deps.host.querySelector?.<HTMLElement>('[data-oauth-permissions-host]'); if (!host || disposed) return;
    if (!visible) { host.innerHTML = ''; return; }
    const apps = new Map<string, NonNullable<typeof inventory>['groups'][number][]>();
    for (const group of inventory?.groups ?? []) apps.set(group.app_key, [...apps.get(group.app_key) ?? [], group]);
    host.innerHTML = '<section class="oauth-permissions" aria-label="Consolidated OAuth permissions"><h3 tabindex="-1" data-permission-heading>Permissions and cleanup</h3>'
      + '<p>' + e(app ? app.label : 'All OAuth apps and broker integrations') + '</p>'
      + (app ? '<p>Saved app profiles with the same Client ID are reviewed together to protect their shared permissions.</p>' : '')
      + '<p>Review permissions needed by Mail, Calendar, file sources and installed workflows on this Recued server. Separate sign-ins stay separate. Other tools may use the same authorization.</p>'
      + (busy ? '<p role="status">' + (inventory ? 'Checking the cleanup selection against current dependencies…' : 'Reading local permission records…') + '</p>' : '')
      + (inventory ? '<p>Recorded grants are shown as last saved; opening this view does not contact the vendor. Requested permissions are not proof of consent.</p>'
        + (inventory.unavailable.length ? '<p role="alert">Some inventory is unavailable:</p><ul>' + inventory.unavailable.map(w => '<li>' + e(w) + '</li>').join('') + '</ul>' : '')
        + (!inventory.groups.length ? '<p>No OAuth authorizations were found in this view.</p>' : '')
        + [...apps.values()].map(groups => '<section aria-label="OAuth app permission usage"><h4>' + e(groups[0]!.app_label) + '</h4>'
          + '<p>' + e(String(new Set(groups.flatMap(g => g.required_scopes)).size)) + ' distinct required permissions across '
          + e(String(groups.length)) + ' separately tracked authorization' + (groups.length === 1 ? '' : 's') + '.</p>'
          + groups.map(group => '<section data-permission-group="' + group.id + '"><h5>' + e(group.account_label)
            + ' · ' + (group.authentication === 'broker' ? 'OAuth broker' : 'Recued direct OAuth') + '</h5>'
            + (group.connection_names.length ? '<p>Connections: ' + e(group.connection_names.join(', ')) + '.</p>' : '')
            + '<details><summary>Local uses (' + e(String(group.uses.length)) + ')</summary>' + uses(group.uses) + '</details>'
            + group.warnings.map(w => '<p role="note">' + e(w) + '</p>').join('')
            + (!group.scopes.length ? '<p>No permission list is recorded. Access remains unconfirmed.</p>' : '<ul class="oauth-permission-scopes">'
              + group.scopes.map(scope => '<li>' + (scope.status === 'unused_locally' ? '<label><input type="checkbox" data-permission-scope="' + e(scope.scope)
                + '" data-permission-group-id="' + group.id + '"' + (group.id === groupId && chosen.has(scope.scope) ? ' checked' : '')
                + (working() || !!preview ? ' disabled' : '') + '> <span>' + e(scopeLabel(scope.scope)) + '</span></label>' : '<strong>' + e(scopeLabel(scope.scope)) + '</strong>')
                + scopeDetail(scope.scope)
                + '<p>' + (scope.status === 'required' ? 'Required by ' + e(scope.required_by.map(u => u.kind + ': ' + u.label).join(', ')) + '.'
                  : scope.status === 'unused_locally' ? 'No longer required locally — eligible for a cleanup preview.'
                    : scope.required_by.length ? 'Needed elsewhere under this app: ' + e(scope.required_by.map(u => u.kind + ': ' + u.label).join(', ')) + '. Shared consent is unresolved — keep.'
                      : 'Usage or grant evidence is unknown — keep until reviewed.')
                + ' ' + (scope.evidence === 'recorded_grant' ? 'Recorded vendor grant.' : scope.evidence === 'requested_only' ? 'Requested only; consent is unconfirmed.' : 'Declared requirement; consent is unconfirmed.') + '</p></li>').join('') + '</ul>') + '</section>').join('') + '</section>').join('')
        + (!preview ? button('preview', 'Preview cleanup', working() || stale || chosen.size === 0) : '') : '')
      + previewHtml() + '<div data-oauth-permission-cleanup-host></div>' + (error ? '<p role="alert">' + e(error) + '</p>' : '')
      + button('refresh', 'Refresh permissions', working()) + button('close', 'Close permissions') + '</section>';
    cleanup?.render();
  };
  const open = (selected?: SavedOAuthApp, opener?: HTMLElement): Promise<void> => {
    if (disposed) return pending;
    if (!visible) returnFocus = opener;
    cleanup?.hide(); cleanupAvailable = false;
    const gen = ++generation; visible = true; busy = true; app = selected; inventory = undefined; preview = undefined; groupId = undefined;
    chosen.clear(); stale = false; error = ''; render();
    pending = (async () => {
      try {
        const result = await deps.call({ action: 'permission_inventory', ...(selected ? { issuer: selected.issuer, app_id: selected.id } : {}) });
        if (disposed || gen !== generation) return;
        if (!isOAuthAppsResponse(result) || result.action !== 'permission_inventory' || !isOAuthPermissionInventory(result.permission_inventory)
          || (selected ? result.permission_inventory.filter?.issuer !== selected.issuer || result.permission_inventory.filter.app_id !== selected.id
            : result.permission_inventory.filter !== undefined)) throw Error('Permission records could not be read. Refresh or update the server.');
        inventory = result.permission_inventory;
        const saved = result.permission_cleanup_jobs;
        cleanupAvailable = result.permission_cleanup_available === true && Array.isArray(saved) && saved.length <= 64 && saved.every(isOAuthPermissionCleanupJob);
        cleanup?.receive(cleanupAvailable ? saved!.filter(job => !selected || job.app.client_id === selected.client_id) : [], cleanupAvailable);
      } catch (err) { if (!disposed && gen === generation) error = err instanceof Error ? err.message : 'Permission records could not be read.'; }
      finally { if (!disposed && gen === generation) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-permission-heading]')?.focus(); } }
    })(); return pending;
  };
  const previewSelection = async () => {
    if (!inventory || !groupId || chosen.size === 0 || working() || stale) return;
    const gen = generation; const snapshot = inventory; const group = groupId; const selected = [...chosen].sort(); busy = true; error = ''; render();
    try {
      const result = await deps.call({ action: 'preview_permission_cleanup', inventory_fingerprint: snapshot.fingerprint, group_id: group,
        selected_scopes: selected, ...(snapshot.filter ? { filter: snapshot.filter } : {}) });
      if (disposed || gen !== generation) return;
      if (!isOAuthAppsResponse(result) || result.action !== 'preview_permission_cleanup' || !isOAuthPermissionCleanupPreview(result.permission_cleanup)
        || result.permission_cleanup.inventory_fingerprint !== snapshot.fingerprint || result.permission_cleanup.group_id !== group
        || JSON.stringify([...result.permission_cleanup.selected_scopes].sort()) !== JSON.stringify(selected)) throw Error('The cleanup preview could not be confirmed. Refresh permissions before reviewing again.');
      preview = result.permission_cleanup;
    } catch (err) { if (!disposed && gen === generation) { stale = true; error = err instanceof Error ? err.message : 'Refresh permissions before reviewing cleanup again.'; } }
    finally { if (!disposed && gen === generation) { busy = false; render(); deps.host.querySelector<HTMLElement>('[data-cleanup-heading]')?.focus(); } }
  };
  const close = () => {
    generation++; cleanup?.hide(); visible = false; busy = false; inventory = undefined; preview = undefined; chosen.clear(); error = ''; render();
    if (returnFocus?.isConnected) returnFocus.focus();
    else deps.host.querySelector<HTMLElement>('[data-oauth-app-action="permissions"]')?.focus();
  };
  const click = (event: Event) => {
    const node = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-permission-action]');
    if (!node || !deps.host.contains(node) || node.hasAttribute('disabled')) return;
    event.preventDefault(); const action = node.dataset.permissionAction;
    if (action === 'close') close();
    else if (!working() && action === 'refresh') pending = open(app);
    else if (!working() && action === 'preview') pending = previewSelection();
    else if (!working() && action === 'start-cleanup' && cleanupAvailable && preview && inventory) {
      const urls = [...deps.host.querySelectorAll<HTMLInputElement>('[data-permission-api-url]')].map(input => ({ name: input.dataset.permissionApiUrl!, url: input.value }));
      pending = cleanup?.prepare(preview, inventory.filter, urls) ?? Promise.resolve();
    }
    else if (!working() && action === 'back') { preview = undefined; render(); }
  };
  const change = (event: Event) => {
    const node = event.target as HTMLInputElement | null;
    if (node && deps.host.contains(node) && node.dataset.permissionApiUrl && !working()) { apiUrls.set(node.dataset.permissionApiUrl, node.value); return; }
    if (!node || !deps.host.contains(node) || !node.dataset.permissionScope || working() || preview || stale) return;
    const group = inventory?.groups.find(g => g.id === node.dataset.permissionGroupId);
    if (!group?.scopes.some(s => s.scope === node.dataset.permissionScope && s.status === 'unused_locally')) return;
    const focused = deps.host.ownerDocument?.activeElement === node;
    if (groupId !== group.id) { chosen.clear(); groupId = group.id; }
    if (node.checked) chosen.add(node.dataset.permissionScope); else chosen.delete(node.dataset.permissionScope);
    render();
    if (focused) [...deps.host.querySelectorAll<HTMLInputElement>('[data-permission-scope]')]
      .find(input => input.dataset.permissionGroupId === group.id && input.dataset.permissionScope === node.dataset.permissionScope)?.focus();
  };
  cleanup = createOAuthPermissionCleanupPanel({ host: deps.host, call: deps.call, stateChanged: render,
    ...(deps.cleanupOAuth ? { oauth: deps.cleanupOAuth } : {}),
    prepared() { chosen.clear(); groupId = undefined; preview = undefined; render(); },
    changed() { inventory = undefined; preview = undefined; chosen.clear(); render(); deps.changed?.(); } });
  deps.host.addEventListener('click', click); deps.host.addEventListener('change', change);
  return { open, render, whenLoaded: async () => { await pending; await cleanup?.whenLoaded(); }, busy: working, hasDraft: () => chosen.size > 0,
    close, dispose() { disposed = true; generation++; inventory = undefined; preview = undefined; chosen.clear();
      cleanup?.dispose();
      deps.host.removeEventListener('click', click); deps.host.removeEventListener('change', change);
      const host = deps.host.querySelector?.<HTMLElement>('[data-oauth-permissions-host]'); if (host) host.innerHTML = ''; } };
};
