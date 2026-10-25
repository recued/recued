import { isPackReconnectWorklist, type PackReconnectGroup, type PackReconnectRequest,
  type PackReconnectResponse } from '@recued/contracts';
import { isAuthenticationRepairWorklist, CONNECTION_NAME_REGEX, type AuthenticationRepairCaller, type AuthenticationRepairWorklist, type AuthenticationRepairGroup, type AuthenticationRepairTarget } from '@recued/contracts';
import { connectionsAccountAddress, connectionsReviewAccessAddress, connectionsOAuthAppsAddress, connectionsVerifyAccessAddress } from '../connections/connections-navigation.js';
import { cloudFileSourceSlug } from '../data/cloud-file-explorer.js';
import { authenticationIncidentHistoryHref } from '@recued/ui-shared';
import type { ReconnectWorklistReturn } from './reconnect-worklist-continuity.js';
import { createAuthenticationAccessPanel, appendAuthenticationAccessSummary, AUTHENTICATION_ACCESS_STYLES } from '../connections/authentication-access-panel.js';
import { appendLatestAuthenticationAccess, LATEST_AUTHENTICATION_ACCESS_STYLES } from '../connections/authentication-access-summary.js';
import type { ManagedOAuthCaller } from './managed-oauth-panel.js';
import { createBulkAuthenticationAccessPanel, BULK_AUTHENTICATION_ACCESS_STYLES } from '../connections/bulk-authentication-access-panel.js';
import { createAuthenticationAccessRepairShortcuts } from '../connections/authentication-access-repair-shortcuts.js';
export type PackReconnectCaller = (args: PackReconnectRequest) => Promise<PackReconnectResponse>;

export const createReconnectWorklistPanel = (deps: {
  document: Document;
  call?: PackReconnectCaller;
  repairs?: AuthenticationRepairCaller;
  verify?: ManagedOAuthCaller;
  onReconnect?(group: PackReconnectGroup): void;
  returned?: ReconnectWorklistReturn;
}) => {
  const doc = deps.document;
  let host: HTMLElement | null = null;
  let data: PackReconnectResponse | undefined;
  let repairs: AuthenticationRepairWorklist | undefined; let repairError = '';
  const authLabel = (g: AuthenticationRepairGroup): string => g.authentication === 'direct_oauth' ? 'Recued direct OAuth' : g.authentication === 'broker' ? 'Broker sign-in' : g.authentication === 'other' ? 'Saved authentication' : 'Authentication details unavailable';
  const useLabels = { pack: 'Pack', recipe: 'Recipe', dish: 'Dish', schedule: 'Schedule', mail: 'Mail', calendar: 'Calendar', file: 'Files' } as const;
  const repairLink = (target: AuthenticationRepairTarget): { label: string; href: string } | undefined => {
    if (target.kind === 'connection') return CONNECTION_NAME_REGEX.test(target.name) ? { label: 'Fix in Apps & APIs: ' + target.name, href: connectionsReviewAccessAddress(target.name).hash } : undefined;
    if (target.kind === 'collection') return { label: 'Fix in ' + (target.platform === 'mail' ? 'Mail' : 'Calendar') + ': ' + target.slug, href: connectionsAccountAddress(target.platform, target.slug).hash };
    if (target.kind === 'file_source') return { label: 'Open the file source', href: '#data/files/' + encodeURIComponent(cloudFileSourceSlug(target.source_id)) };
    return { label: 'Manage saved OAuth apps', href: connectionsOAuthAppsAddress().hash };
  };
  let loading = false; let writing = false; let navigating = false; let disposed = false; let showReviewed = false;
  let generation = 0; let error = ''; let notice = deps.returned?.verified
    ? `The protected read passed for ${deps.returned.name}. Review any remaining permission reminders.`
      + (deps.returned.reconnect_collections?.length ? ' Review linked Mail and Calendar accounts: '
        + deps.returned.reconnect_collections.map(c => c.label).join(', ') + '.' : '') : '';
  let pending = Promise.resolve();
  let expanded = deps.returned !== undefined;
  let refreshQueued = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n;
  };
  const row = (className: string): HTMLDivElement => { const div = node('div'); div.className = className; return div; };
  const link = (label: string, href: string, className = 'reconnect-worklist-link'): HTMLAnchorElement => {
    const a = node('a', label); a.href = href; a.setAttribute('href', href); a.className = className; return a;
  };
  const button = (label: string, action: string, fn: () => void): HTMLButtonElement => {
    const b = node('button', label); b.type = 'button'; b.disabled = writing || navigating || loading;
    b.disabled ||= accessRepairs?.busy() ?? false;
    b.setAttribute('data-reconnect-worklist-action', action); b.addEventListener('click', () => {
      if (!disposed && !writing && !navigating && !loading && !accessRepairs?.busy()) fn();
    }); return b;
  };
  const render = (): void => {
    if (!host || disposed) return;
    const disclosureBeforeRender = host.querySelector<HTMLDetailsElement>('.reconnect-worklist-disclosure');
    if (disclosureBeforeRender) expanded = disclosureBeforeRender.open;
    const expandedAccess = new Set((repairs?.groups ?? []).filter(group => host?.querySelector<HTMLDetailsElement>('[data-authentication-access-disclosure="' + group.id + '"]')?.open).map(group => group.id));
    accessRepairs?.beginRender();
    const bulkFocus = bulkHost.contains(doc.activeElement) ? doc.activeElement as HTMLElement | null : null;
    while (host.firstChild) host.removeChild(host.firstChild);
    const disclosure = node('details'); disclosure.className = 'reconnect-worklist-disclosure'; disclosure.open = expanded;
    disclosure.addEventListener('toggle', () => { if (disclosure.isConnected) expanded = disclosure.open; });
    const count = (repairs?.groups.filter(group => group.issues.length).length ?? 0)
      + (data?.groups.filter(group => !group.reviewed).length ?? 0) + (data?.unresolved_packs.length ?? 0);
    const unavailable = !!error || !!repairError || !!repairs?.unavailable.length;
    const summary = node('summary', loading ? 'Reading authentication status…' : unavailable ? 'Authentication status needs a refresh' : !data && !repairs ? 'Authentication status not yet read' : count ? `Needs attention (${count})` : 'Authentication status · No recorded problems');
    summary.setAttribute('data-authentication-repairs-summary', ''); disclosure.appendChild(summary);
    disclosure.setAttribute('data-worklist-state', loading ? 'loading' : count ? 'attention' : unavailable ? 'unavailable' : !data && !repairs ? 'unread' : 'clear');
    const section = node('section'); section.className = 'reconnect-worklist';
    section.setAttribute('data-reconnect-worklist', ''); section.setAttribute('aria-label', deps.repairs ? 'Authentication repairs' : 'Reconnect later');
    const head = row('reconnect-worklist-head');
    head.appendChild(node('h2', deps.repairs ? 'Authentication repairs' : 'Reconnect later'));
    const lead = node('p', deps.repairs ? 'Sign-ins that stopped working and Pack permission reminders, in one place. Opening or refreshing this list reads local status; it does not contact vendors or change authentication.' : 'Review vendor permissions for installed Packs. This list uses their declared permission needs.');
    lead.className = 'reconnect-worklist-lead'; head.appendChild(lead); section.appendChild(head);
    const toolbar = row('reconnect-worklist-toolbar');
    toolbar.appendChild(button('Refresh', 'refresh', () => { void refresh(); }));
    if (bulkPanel) {
      toolbar.appendChild(button('Verify multiple accounts', 'bulk-access', () => {
        if (accessPanel?.hasDraft() || accessPanel?.busy()) { notice = 'Close the current access review before choosing multiple accounts.'; render(); return; }
        expanded = true; void bulkPanel.open(() => host?.querySelector<HTMLElement>('[data-reconnect-worklist-action="bulk-access"]')?.focus());
        bulkHost.scrollIntoView?.({ block: 'nearest' });
      }));
    }
    if (deps.repairs) {
      const history = link('Incident history', authenticationIncidentHistoryHref(), 'reconnect-worklist-link reconnect-worklist-button-link');
      history.setAttribute('data-authentication-history-link', 'all'); toolbar.appendChild(history);
    }
    const reviewed = data?.groups.filter(g => g.reviewed).length ?? 0;
    if (reviewed) {
      const toggle = button(`${showReviewed ? 'Hide' : 'Show'} reviewed (${reviewed})`, 'toggle-reviewed', () => { showReviewed = !showReviewed; render(); });
      toggle.setAttribute('aria-pressed', String(showReviewed)); toolbar.appendChild(toggle);
    }
    section.appendChild(toolbar);
    if (bulkPanel) { section.appendChild(bulkHost); bulkPanel.mount(bulkHost); }
    if (loading) { const p = node('p', deps.repairs ? 'Reading local authentication status…' : 'Checking installed permissions…'); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (error) { const p = node('p', error); p.setAttribute('role', 'alert'); section.appendChild(p); }
    if (repairError) { const p = node('p', repairError); p.setAttribute('role', 'alert'); section.appendChild(p); }
    for (const message of repairs?.unavailable ?? []) { const p = node('p', message); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (repairs) {
      const observed = node('p', 'Local status as of ' + new Date(repairs.observed_at).toLocaleString() + '. Only an access check confirms vendor permissions and access.');
      observed.className = 'reconnect-worklist-observed'; section.appendChild(observed);
    }
    if (notice) { const p = node('p', notice); p.setAttribute('role', 'status'); section.appendChild(p); }
    if (accessPanel) { section.appendChild(accessHost); accessPanel.mount(accessHost); }
    if (data || repairs) {
      const packData = data ?? { groups: [], unresolved_packs: [] };
      const visible = packData.groups.filter(g => !g.reviewed || showReviewed);
      const hasAuthIssues = repairs?.groups.some(g => g.issues.length > 0) ?? false;
      if (!visible.length && !hasAuthIssues && !packData.unresolved_packs.length && !loading && !error && !repairError && !(repairs?.unavailable.length)) section.appendChild(node('p', deps.repairs ? 'No recorded authentication problems or permission reminders need attention.' : 'No permissions are waiting for review.'));
      const appendPermission = (group: PackReconnectGroup, parent: HTMLElement): void => {
        const article = node('article'); article.className = 'reconnect-worklist-item'; article.setAttribute('data-reconnect-worklist-group', group.id);
        const heading = row('reconnect-worklist-item-head');
        heading.appendChild(node('h3', group.display_name));
        const chip = node('span', group.authentication === 'direct_oauth' ? 'Recued direct OAuth'
          : group.authentication === 'broker' ? 'Broker sign-in' : group.name ? 'Saved connection' : 'Connection needed');
        chip.className = 'reconnect-worklist-chip'; heading.appendChild(chip); article.appendChild(heading);
        const list = node('ul');
        for (const item of group.items) {
          const li = node('li'); const link = node('a', `${item.pack_name} · v${item.version}`);
          link.href = '#packs/' + encodeURIComponent(item.pack_slug); li.appendChild(link);
          li.appendChild(node('span', ' · ' + item.slot)); list.appendChild(li);
        }
        article.appendChild(list);
        const details = node('details'); details.appendChild(node('summary', 'Required permissions'));
        details.appendChild(node('p', group.required_scopes.join(', '))); article.appendChild(details);
        if (group.reviewed) article.appendChild(node('p', 'Marked reviewed. Vendor permission evidence is unchanged.'));
        else if (group.items.some(i => i.coverage === 'missing')) article.appendChild(node('p', 'Recorded grants are missing: '
          + [...new Set(group.items.flatMap(i => i.missing_scopes))].join(', ') + '. Reconnect to request them.'));
        else article.appendChild(node('p', 'Vendor permissions are unknown. A successful read checks only the chosen resource.'));
        const actions = row('reconnect-worklist-actions');
        if (group.can_reconnect && deps.onReconnect) {
          const reconnect = button('Reconnect', 'reconnect', () => {
            navigating = true; render();
            try { deps.onReconnect!(structuredClone(group)); }
            catch (e) { navigating = false; error = e instanceof Error ? e.message : 'Reconnect could not be opened.'; render(); }
            finally { navigating = false; render(); }
          });
          reconnect.className = 'reconnect-worklist-primary'; actions.appendChild(reconnect);
        }
        if (group.name) actions.appendChild(link('Open connection', '#connections/others/review-access/api/' + encodeURIComponent(group.name), 'reconnect-worklist-link reconnect-worklist-button-link'));
        if (!group.reviewed && group.can_mark_reviewed) actions.appendChild(button('Mark reviewed', 'mark-reviewed', () => { void mutate('mark_reviewed', group); }));
        else if (group.reviewed) actions.appendChild(button('Restore reminder', 'restore-review', () => { void mutate('restore_review', group); }));
        article.appendChild(actions);
        if (!group.reviewed && group.can_mark_reviewed) {
          const hint = node('p', 'Mark reviewed clears this reminder only. It does not grant or verify permissions.'); hint.className = 'reconnect-worklist-note'; article.appendChild(hint);
        }
        parent.appendChild(article);
      };
      const claimed = new Set<string>(); let issueCount = 0;
      for (const account of repairs?.groups ?? []) {
        const permissions = account.kind === 'account' ? visible.filter(g => g.name && account.connection_names.includes(g.name)) : [];
        if (!account.issues.length && !permissions.length && !account.access_verification && !account.access_summary?.lookup_incomplete
          && !account.access_summary?.targets.some(t => t.latest || t.state === 'unavailable')) continue;
        const article = node('article'); article.className = 'reconnect-worklist-item'; article.setAttribute('data-authentication-repair-group', account.id);
        const heading = row('reconnect-worklist-item-head');
        heading.appendChild(node('h3', account.label));
        const chip = node('span', authLabel(account)); chip.className = 'reconnect-worklist-chip'; heading.appendChild(chip);
        article.appendChild(heading);
        for (const issue of account.issues) {
          const p = node('p', issue.message + (issue.observed_at === undefined ? '' : ' Recorded ' + new Date(issue.observed_at).toLocaleString() + '.'));
          p.className = 'reconnect-worklist-issue'; p.setAttribute('data-authentication-repair-issue', issue.code); article.appendChild(p);
        }
        // The fix comes first: the exact local destination for each target.
        const actions = row('reconnect-worklist-actions');
        let primary = true;
        for (const destination of account.targets) { const target = repairLink(destination); if (!target) continue;
          const a = link(target.label, target.href, 'reconnect-worklist-link ' + (primary ? 'reconnect-worklist-primary' : 'reconnect-worklist-button-link'));
          a.setAttribute('data-authentication-repair-link', destination.kind); actions.appendChild(a); primary = false;
        }
        article.appendChild(actions);
        if (account.access_summary) {
          appendLatestAuthenticationAccess(doc, article, account.access_summary, accessPanel ? (entry, sourceButton) => {
            if (disposed || loading || writing || accessRepairs?.busy() || !host?.contains(sourceButton)) return;
            void accessPanel.openSaved(entry, () => host?.querySelector<HTMLElement>('[data-authentication-repair-group="' + account.id + '"]')
              ?.querySelector<HTMLElement>('[data-latest-access-view="' + entry.result.id + '"]')?.focus(), account.access_summary!.selection);
            accessHost.scrollIntoView?.({ block: 'nearest' });
          } : undefined, accessRepairs?.append);
        } else if (account.access_verification) {
          const details = node('details'); details.setAttribute('data-authentication-access-disclosure', account.id); details.open = expandedAccess.has(account.id);
          details.appendChild(node('summary', 'Latest access check')); appendAuthenticationAccessSummary(doc, details, account.access_verification, accessRepairs?.append); article.appendChild(details);
        }
        if (accessPanel && account.access_summary) {
          const verify = link('Verify access', connectionsVerifyAccessAddress({ kind: 'group', id: account.id }).hash, 'reconnect-worklist-link reconnect-worklist-button-link');
          verify.setAttribute('data-reconnect-worklist-action', 'verify-' + account.id); actions.appendChild(verify);
        } else if (accessPanel) {
          const verify = button(account.access_verification?.status === 'checking' ? 'View access check' : 'Verify access', 'verify-' + account.id,
            () => { accessPanel.open({ kind: 'group', id: account.id }, account.access_verification,
              () => host?.querySelector<HTMLElement>('[data-reconnect-worklist-action="verify-' + account.id + '"]')?.focus()); accessHost.scrollIntoView?.({ block: 'nearest' }); });
          actions.appendChild(verify);
        }
        const history = link('History', authenticationIncidentHistoryHref({ kind: 'group', id: account.id }), 'reconnect-worklist-link reconnect-worklist-quiet-link');
        history.setAttribute('data-authentication-history-link', account.id); actions.appendChild(history);
        if (account.issues.length) issueCount += 1;
        if (account.uses.length) {
          const details = node('details'); details.appendChild(node('summary', 'Affected uses (' + account.uses.length + ')'));
          const list = node('ul'); for (const u of account.uses) list.appendChild(node('li', useLabels[u.kind] + ': ' + u.label)); details.appendChild(list); article.appendChild(details);
        }
        if (!account.usage_available) article.appendChild(node('p', 'Some local uses could not be read. Review the connection before changing authentication.'));
        for (const permission of permissions) { claimed.add(permission.id); appendPermission(permission, article); }
        section.appendChild(article);
      }
      for (const permission of visible) if (!claimed.has(permission.id)) appendPermission(permission, section);
      for (const pack of packData.unresolved_packs) {
        const p = node('p', pack.message + ' '); p.setAttribute('role', 'status'); const a = node('a', pack.name);
        a.href = '#packs/' + encodeURIComponent(pack.slug); p.appendChild(a); section.appendChild(p);
      }
      if (issueCount) {
        const footnote = node('p', 'Problems stay here until their recorded status changes. Marking Pack permissions reviewed clears only that Pack reminder.');
        footnote.className = 'reconnect-worklist-footnote'; section.appendChild(footnote);
      }
    }
    disclosure.appendChild(section); host.appendChild(disclosure);
    if (bulkFocus && bulkHost.contains(bulkFocus) && (doc.activeElement === bulkFocus || doc.activeElement === doc.body)) bulkFocus.focus({ preventScroll: true });
  };
  const accept = (result: PackReconnectResponse, action: PackReconnectRequest['action']): void => {
    if (result.action !== action || !isPackReconnectWorklist(result)) throw new Error('The reconnect worklist could not be read. Update the server or refresh.');
    data = structuredClone(result);
  };
  const refresh = (): Promise<void> => {
    if (disposed || navigating) return pending;
    // Pack broadcasts must be replayed after the in-flight snapshot or write.
    if (loading || writing) { refreshQueued = true; return pending; }
    accessRepairs?.reset();
    pending = (async () => {
      do {
        refreshQueued = false;
        const gen = ++generation; loading = true; error = ''; render();
        try {
          const [permissions, authentication] = await Promise.allSettled([
            Promise.resolve().then(() => deps.call ? deps.call({ action: 'list' }) : { action: 'list' as const, groups: [], unresolved_packs: [] }),
            Promise.resolve().then(() => deps.repairs?.()),
          ]);
          if (disposed || gen !== generation) return;
          if (permissions.status === 'fulfilled') { try { accept(permissions.value, 'list'); } catch { error = 'Pack permission reminders could not be read. Refresh or update the server.'; } }
          else error = 'Pack permission reminders could not be read. Refresh or update the server.';
          repairError = '';
          if (deps.repairs) {
            if (authentication.status === 'fulfilled' && isAuthenticationRepairWorklist(authentication.value)) repairs = structuredClone(authentication.value);
            else repairError = 'Authentication status could not be refreshed. Earlier observations may be shown; refresh or update the server.';
          }
        } catch {
          if (!disposed && gen === generation) error = 'The worklist could not be refreshed.';
        } finally { if (!disposed && gen === generation) { loading = false; render(); } }
      } while (!disposed && refreshQueued);
    })();
    return pending;
  };
  const mutate = (action: 'mark_reviewed' | 'restore_review', group: PackReconnectGroup): Promise<void> => {
    if (disposed || writing || loading || navigating) return pending;
    accessRepairs?.reset();
    const gen = ++generation; writing = true; error = ''; render();
    pending = (async () => {
      try {
        if (!deps.call) throw new Error('Pack permissions are unavailable in this view.');
        const result = await deps.call({ action, group_id: group.id, fingerprint: group.fingerprint });
        if (disposed || gen !== generation) return;
        accept(result, action); notice = action === 'mark_reviewed' ? 'Marked reviewed. Vendor permission evidence is unchanged.' : 'Reminder restored.';
      } catch (e) { if (!disposed && gen === generation) error = e instanceof Error ? e.message : 'The reminder could not be updated. Refresh and try again.'; }
      finally {
        if (!disposed && gen === generation) {
          writing = false; render();
          if (refreshQueued) await refresh();
        }
      }
    })();
    return pending;
  };
  const accessHost = doc.createElement('div');
  const accessPanel = deps.verify ? createAuthenticationAccessPanel({ document: doc, call: deps.verify, updated: () => { void refresh(); } }) : undefined;
  const bulkHost = doc.createElement('div');
  const bulkPanel = deps.verify && deps.repairs ? createBulkAuthenticationAccessPanel({ document: doc, read: deps.repairs, call: deps.verify,
    updated: () => { void refresh(); } }) : undefined;
  const accessRepairs = deps.verify ? createAuthenticationAccessRepairShortcuts({ document: doc, call: deps.verify, host: () => host,
    active: () => !disposed && !loading && !writing && !navigating && !bulkPanel?.busy() && !accessPanel?.hasInFlightWork(), changed: () => render() }) : undefined;
  return {
    mount(element: HTMLElement): void { host = element; render(); if (!data && !loading) void refresh(); },
    refresh,
    whenLoaded: async (): Promise<void> => { await pending; await accessPanel?.whenLoaded(); await bulkPanel?.whenLoaded(); await accessRepairs?.whenLoaded(); },
    hasDraft: (): boolean => (accessPanel?.hasDraft() ?? false) || (bulkPanel?.hasDraft() ?? false),
    inFlightWorkPrompt: (): string | null => bulkPanel?.busy() ? 'Leave the account checks? Unstarted checks will stop. Started jobs keep running and stay in connection history.' : null,
    busy: (): boolean => writing || (accessPanel?.hasInFlightWork() ?? false) || (bulkPanel?.busy() ?? false),
    dispose(): void { disposed = true; generation += 1; accessRepairs?.dispose(); accessPanel?.dispose(); bulkPanel?.dispose(); host = null; },
  };
};
export const RECONNECT_WORKLIST_STYLES = `
.reconnect-worklist-disclosure {
  display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; margin: 0 0 18px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface); font-size: 13px;
}
.reconnect-worklist-disclosure > summary {
  list-style: none; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 11px 14px;
  border-radius: 10px; color: var(--fg); font-weight: 600; cursor: pointer;
}
.reconnect-worklist-disclosure > summary::-webkit-details-marker { display: none; }
.reconnect-worklist-disclosure > summary::before {
  content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-subtle);
}
.reconnect-worklist-disclosure > summary::after {
  content: ''; flex: none; width: 7px; height: 7px; margin: 0 4px 3px auto;
  border-right: 2px solid var(--fg-muted); border-bottom: 2px solid var(--fg-muted); transform: rotate(45deg);
}
.reconnect-worklist-disclosure[open] > summary::after { margin-bottom: -3px; transform: rotate(-135deg); }
.reconnect-worklist-disclosure > summary:hover { background: var(--surface-sunk); }
.reconnect-worklist-disclosure > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.reconnect-worklist-disclosure[open] > summary { border-bottom: 1px solid var(--border); border-radius: 10px 10px 0 0; }
.reconnect-worklist-disclosure[data-worklist-state="attention"] { box-shadow: inset 3px 0 0 var(--danger); }
.reconnect-worklist-disclosure[data-worklist-state="attention"] > summary::before { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-weak); }
.reconnect-worklist-disclosure[data-worklist-state="clear"] > summary { color: var(--fg-muted); font-weight: 500; }
.reconnect-worklist-disclosure[data-worklist-state="clear"] > summary::before { background: var(--accent); }
.reconnect-worklist-disclosure[data-worklist-state="unavailable"] > summary::before { background: none; border: 2px solid var(--fg-muted); width: 4px; height: 4px; }
.reconnect-worklist-disclosure[data-worklist-state="loading"] > summary::before { background: var(--accent); animation: reconnect-worklist-pulse 1.2s ease-in-out infinite; }
@keyframes reconnect-worklist-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.reconnect-worklist {
  display: grid; gap: 12px; min-width: 0; margin: 12px 0; padding: 16px;
  border: 1px solid var(--border); border-radius: 10px;
  color: var(--fg); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere;
}
.reconnect-worklist-disclosure .reconnect-worklist { margin: 0; padding: 14px 16px 16px; border: 0; border-radius: 0; }
.reconnect-worklist > div:empty { display: none; }
.reconnect-worklist p { margin: 0; }
.reconnect-worklist h2 { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 14px; line-height: 1.35; font-weight: 650; }
.reconnect-worklist h3 { margin: 0; color: var(--fg-strong, var(--fg)); font-size: 13.5px; line-height: 1.35; font-weight: 650; }
.reconnect-worklist ul { margin: 0; padding-left: 18px; }
.reconnect-worklist details > summary { cursor: pointer; font-weight: 600; }
.reconnect-worklist-head { display: grid; gap: 3px; min-width: 0; }
.reconnect-worklist-lead, .reconnect-worklist-observed, .reconnect-worklist-footnote, .reconnect-worklist-note { color: var(--fg-muted); font-size: 12.5px; }
.reconnect-worklist-toolbar, .reconnect-worklist-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.reconnect-worklist .reconnect-worklist-toolbar > *, .reconnect-worklist .reconnect-worklist-actions > * { margin: 0; }
.reconnect-worklist button, .reconnect-worklist .reconnect-worklist-button-link, .reconnect-worklist .reconnect-worklist-primary {
  display: inline-flex; align-items: center; justify-content: center; max-width: 100%; min-height: 34px; margin: 4px 8px 4px 0; padding: 6px 12px;
  border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--fg);
  font: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.25; text-align: center; text-decoration: none; cursor: pointer;
}
.reconnect-worklist button:hover:not(:disabled), .reconnect-worklist .reconnect-worklist-button-link:hover { background: var(--surface-sunk); text-decoration: none; }
/* A finger's height on a phone. ⛔ The buttons were 34px and the disclosure 38px. */
@media (max-width: 640px) {
  .reconnect-worklist button, .reconnect-worklist .reconnect-worklist-button-link, .reconnect-worklist .reconnect-worklist-primary { min-height: 44px; }
  .reconnect-worklist-disclosure > summary { min-height: 44px; }
}
.reconnect-worklist .reconnect-worklist-primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.reconnect-worklist .reconnect-worklist-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); text-decoration: none; }
.reconnect-worklist button:disabled { opacity: 0.55; cursor: default; }
.reconnect-worklist button:focus-visible, .reconnect-worklist a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.reconnect-worklist a { color: var(--accent); font-weight: 600; text-decoration: none; }
.reconnect-worklist a:hover { text-decoration: underline; }
.reconnect-worklist .reconnect-worklist-quiet-link { padding: 6px 4px; font-size: 12.5px; }
.reconnect-worklist [role=alert] { color: var(--danger); }
.reconnect-worklist article {
  display: grid; gap: 8px; min-width: 0; padding: 12px 14px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
}
.reconnect-worklist article article { padding: 10px 0 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; }
.reconnect-worklist-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
.reconnect-worklist-chip {
  padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface-sunk); color: var(--fg-muted); font-size: 11px; font-weight: 600; line-height: 1.4;
}
.reconnect-worklist-issue { color: var(--danger); font-weight: 550; }
`
  + AUTHENTICATION_ACCESS_STYLES + LATEST_AUTHENTICATION_ACCESS_STYLES + BULK_AUTHENTICATION_ACCESS_STYLES;
