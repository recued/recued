import { isAuthenticationIncidentHistoryPage, authenticationIncidentScope, authenticationAccessRecheckResults, type AuthenticationIncident, type AuthenticationIncidentHistoryCaller,
  type AuthenticationIncidentScope, type AuthenticationRepairTarget, type AuthenticationRepairAction, type AuthenticationRepairMethod,
  authenticationIncidentHistoryFilters, isAuthenticationIncidentHistoryFilters, authenticationHistoryEntryMatches,
  type AuthenticationIncidentHistoryFilters, type AuthenticationAccessVerification, type AuthenticationRenewalHistory } from '@recued/contracts';
import type { AuthenticationHistoryExportCaller, AuthenticationHistoryExportMode } from '@recued/contracts';
import { prepareAuthenticationHistoryDownload } from './authentication-history-export.js';
import { createAuthenticationHistoryPreview, AUTHENTICATION_HISTORY_PREVIEW_STYLES } from './authentication-history-preview.js';
import { createAuthenticationHistoryFilePanel, AUTHENTICATION_HISTORY_FILE_STYLES } from './authentication-history-file-panel.js';
import { createAuthenticationHistoryLiveRecords } from './authentication-history-live-record.js';
import { connectionsAccountAddress, connectionsReviewAccessAddress, connectionsOAuthAppsAddress, connectionsVerifyAccessAddress, connectionsIncidentHistoryAddress } from './connections-navigation.js';
import { createAuthenticationAccessPanel, appendAuthenticationAccessSummary, AUTHENTICATION_ACCESS_STYLES } from './authentication-access-panel.js';
import { appendLatestAuthenticationAccess, LATEST_AUTHENTICATION_ACCESS_STYLES } from './authentication-access-summary.js';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { oauthAppRenewalResultText, oauthAppRenewalCurrentText } from '../settings/oauth-app-renewal-summary.js';
import { oauthAppRenewalShortcuts, resolveOAuthAppRenewalShortcut } from '../settings/oauth-app-renewal-shortcuts.js';
import type { OAuthAppsCaller } from '../settings/oauth-apps-panel.js';
import { createAuthenticationAccessRepairShortcuts } from './authentication-access-repair-shortcuts.js';
import { createAuthenticationAccessComparisons } from './authentication-access-comparison.js';

type HistoryRow = AuthenticationIncident | AuthenticationRepairAction | AuthenticationAccessVerification | AuthenticationRenewalHistory;
// Validated IDs distinguish kinds even when a newer server adds unrelated fields.
const renewalRow = (row: HistoryRow): row is AuthenticationRenewalHistory => row.id.startsWith('renewal-');
const accessRow = (row: HistoryRow): row is AuthenticationAccessVerification => row.id.startsWith('verify-');
const repairRow = (row: HistoryRow): row is AuthenticationRepairAction => row.id.startsWith('repair-');

const destination = (target: AuthenticationRepairTarget): { text: string; href: string } => {
  switch (target.kind) {
    case 'connection': return { text: 'Open connection: ' + target.name, href: connectionsReviewAccessAddress(target.name).hash };
    case 'collection': return { text: 'Open ' + (target.platform === 'mail' ? 'Mail' : 'Calendar') + ': ' + target.slug, href: connectionsAccountAddress(target.platform, target.slug).hash };
    case 'file_source': return { text: 'Open file source', href: '#data/files/' + encodeURIComponent('remote:' + target.source_id) };
    case 'oauth_apps': return { text: 'Manage saved OAuth apps', href: connectionsOAuthAppsAddress().hash };
  }
};
const eventLabel = { opened: 'Problem first recorded', recorded: 'Earlier alert state added to history', changed: 'Reported problem or affected uses changed',
  awaiting_confirmation: 'No current problem recorded; waiting for access evidence', recovered: 'Later operations succeeded for every reported use', retired: 'Closed without confirmed recovery' } as const;
const retirementLabel = { authentication_changed: 'The saved authentication changed.', connection_removed: 'The saved account or connection was removed.',
  use_removed_or_changed: 'An affected use was removed or changed.', expiry_changed_or_removed: 'The saved expiry date or OAuth app changed or was removed.' } as const;
const useLabel = { pack: 'Pack', recipe: 'Recipe', dish: 'Dish', schedule: 'Schedule', mail: 'Mail', calendar: 'Calendar', file: 'Files' } as const;
const levelLabel = { review: 'Access or configuration needs review', rejected: 'Access was rejected', expiry_30: 'Secret date within 30 days',
  expiry_7: 'Secret date within 7 days', expiry_passed: 'Recorded secret date reached' } as const;
const repairLabel = { reauthorize: 'Reauthorize', switch_oauth_app: 'Switch OAuth app', switch_authentication: 'Switch authentication',
  rotate_secret: 'Rotate saved-app secret', replace_credentials: 'Replace credentials', change_permissions: 'Change permissions' } as const;
const failureLabel = { access_failed: 'The access check or authorization failed.', changed: 'The reviewed authentication or usage changed.',
  interrupted: 'The server stopped before the change was committed.', locked: 'The vault was locked.', server_error: 'The change could not finish.',
  inconclusive: 'The access check was inconclusive.', unreachable: 'The service could not be reached.' } as const;
const methodLabel = (m: AuthenticationRepairMethod): string => (m.type === 'direct_oauth' ? 'Recued direct OAuth' : m.type === 'broker' ? 'Broker sign-in'
  : m.type === 'other' ? 'Saved credentials' : 'Unknown authentication') + (m.label ? ' · ' + m.label
    : m.app_id ? ' · Saved app: ' + m.app_id : m.broker_profile_id ? ' · Broker profile: ' + m.broker_profile_id : '')
  + (m.broker_account_id ? ' · Broker account: ' + m.broker_account_id : '') + (m.connection_name ? ' · Connection: ' + m.connection_name : '');
const historyTypes = { incident: 'Incidents', repair: 'Repairs', verification: 'Access checks', renewal: 'Token-renewal checks' } as const;
const historyOutcomes = { open: 'Open incidents', recovered: 'Recorded recovery', retired: 'Closed without confirmed recovery', running: 'Running checks or repairs',
  applied: 'Applied repairs', failed: 'Failed checks or repairs', passed: 'Recorded checks passed', unconfirmed: 'Unconfirmed checks' } as const;
let historyFilterCounter = 0;
class HistoryFilterError extends Error {}

export const createAuthenticationIncidentPanel = (deps: { document: Document; scope: AuthenticationIncidentScope; call?: AuthenticationIncidentHistoryCaller; verify?: ManagedOAuthCaller;
  filters?: AuthenticationIncidentHistoryFilters; renewal?: OAuthAppsCaller; navigate?(hash: string): void;
  exportHistory?: AuthenticationHistoryExportCaller; download?(filename: string, json: string): void; downloadText?(filename: string, text: string): void }) => {
  const doc = deps.document; const scope = authenticationIncidentScope(deps.scope);
  const validFilters = deps.filters === undefined || isAuthenticationIncidentHistoryFilters(deps.filters);
  let filters = authenticationIncidentHistoryFilters(validFilters ? deps.filters : {}); let filterError = ''; const filterId = 'history-filters-' + ++historyFilterCounter;
  const draft = { search: filters.search ?? '', type: filters.type ?? '', outcome: filters.outcome ?? '', from: filters.from ?? '', through: filters.through ?? '' };
  let host: HTMLElement | null = null; let disposed = false; let loading = false; let loaded = false; let error = '';
  let incidents: AuthenticationIncident[] = []; let cursor: string | undefined; let observedAt: number | undefined;
  let rows: HistoryRow[] = []; let repairHistoryAvailable = false; let renewalHistoryAvailable = false;
  let pending: Promise<void> = Promise.resolve(); const cursors = new Set<string>();
  let shortcutPending = Promise.resolve(); let openingShortcut: string | undefined; let shortcutError = '';
  let exporting = false; let exportError = ''; let exportStatus = ''; let exportPending = Promise.resolve(); let exportSelectionVersion = 0;
  let exportMode: AuthenticationHistoryExportMode = 'aliases';
  let livePreviewSource: { origin: HTMLElement; recordId: string } | undefined;
  const focusLivePreviewSource = (target?: HTMLElement): void => {
    if (disposed || !target || !host?.contains(target)) return;
    target.focus({ preventScroll: true });
    if (!disposed && host?.contains(target) && doc.activeElement === target) target.scrollIntoView?.({ block: 'nearest' });
  };
  const liveRecords = createAuthenticationHistoryLiveRecords({ document: doc, mode: () => exportMode, active: control => !disposed && !!host?.contains(control),
    previewId: filterId + '-record-preview', preview: (value, origin, recordId) => {
      if (disposed || !host?.contains(origin)) return;
      const source = { origin, recordId }; livePreviewSource = source;
      try { livePreview.show(value, { source: 'live' }); livePreview.focus(); }
      catch { if (livePreviewSource === source) { livePreviewSource = undefined; livePreview.clear(); } throw new Error('Record preview could not be opened.'); }
    },
    ...(deps.download ? { download: deps.download } : {}) });
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; return n;
  };
  const link = (text: string, href: string): HTMLAnchorElement => {
    const a = node('a', text); a.href = href; a.setAttribute('href', href); return a;
  };
  const button = (text: string, action: string, more = false): HTMLButtonElement => {
    const b = node('button', text); b.type = 'button'; b.disabled = loading || !!openingShortcut || (accessRepairs?.busy() ?? false) || (accessComparisons?.busy() ?? false);
    b.setAttribute('data-incident-action', action); b.addEventListener('click', () => { void load(more, doc.activeElement === b ? action : undefined); }); return b;
  };
  const exportHistory = (): void => {
    if (disposed || exporting || !validFilters || !deps.exportHistory) return;
    const query = { scope, ...(Object.keys(filters).length ? { filters } : {}) };
    const selectedVersion = exportSelectionVersion;
    const selectedMode = exportMode;
    const focusExport = host?.contains(doc.activeElement) && doc.activeElement?.getAttribute('data-history-export') === 'preview';
    exporting = true; exportError = ''; exportStatus = ''; exportPreview.clear(); renderExport();
    exportPending = (async () => {
      try {
        const value = await deps.exportHistory!(query);
        if (disposed || selectedVersion !== exportSelectionVersion) return;
        const result = prepareAuthenticationHistoryDownload(value, query, selectedMode);
        exportPreview.show(result);
        exportStatus = `Preview ready: ${result.count} matching retained entr${result.count === 1 ? 'y' : 'ies'}. Review it, then download this snapshot.`;
      } catch (err) {
        if (!disposed && selectedVersion === exportSelectionVersion) {
          const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
          exportError = code === 'payload_too_large' ? 'This history export is too large. Narrow the applied filters and try again.'
            : 'History export preview could not be prepared. Reconnect or update the server, then try again. No partial report was prepared.';
        }
      } finally {
        if (!disposed) {
          const restoreFocus = focusExport && selectedVersion === exportSelectionVersion && (doc.activeElement === doc.body || !doc.activeElement?.isConnected);
          exporting = false; renderExport();
          if (restoreFocus) { if (exportPreview.hasSnapshot()) exportPreview.focus(); else exportButton.focus({ preventScroll: true }); }
        }
      }
    })();
  };
  // Export progress is independent of the history/access-review DOM. Updating
  // it must not remount a URL draft, file picker, comparison or disclosure.
  const exportButton = node('button'); exportButton.type = 'button'; exportButton.setAttribute('data-history-export', 'preview');
  exportButton.setAttribute('aria-describedby', filterId + '-export-help'); exportButton.addEventListener('click', () => {
    if (!disposed && host?.contains(exportButton)) exportHistory();
  });
  const exportPreview = createAuthenticationHistoryPreview({ document: doc, ...(deps.download ? { download: deps.download } : {}),
    closed: () => { if (!disposed) { exportStatus = ''; renderExport(); if (host?.contains(exportButton)) exportButton.focus({ preventScroll: true }); } } });
  const openedFile = createAuthenticationHistoryFilePanel({ document: doc, ...(deps.download ? { download: deps.download } : {}), ...(deps.downloadText ? { downloadText: deps.downloadText } : {}) });
  const livePreview = createAuthenticationHistoryPreview({ document: doc, ...(deps.download ? { download: deps.download } : {}), closed: () => {
    const source = livePreviewSource; livePreviewSource = undefined;
    if (disposed || !source || !host || doc.activeElement !== doc.body && doc.activeElement?.isConnected) return;
    focusLivePreviewSource(liveRecords.focusTarget(source.recordId, source.origin) ?? host.querySelector<HTMLElement>('[data-incident-action="refresh"]') ?? undefined);
  } });
  livePreview.element.id = filterId + '-record-preview'; livePreview.element.setAttribute('data-history-preview', 'live-record'); livePreview.element.setAttribute('aria-label', 'History record preview');
  const clearLivePreview = (): void => { livePreviewSource = undefined; livePreview.clear(); };
  const exportPrivacy = node('div'); exportPrivacy.className = 'authentication-history-export-privacy';
  const exportPrivacyLabel = node('label', 'Export privacy'); exportPrivacyLabel.setAttribute('for', filterId + '-export-mode'); exportPrivacy.appendChild(exportPrivacyLabel);
  const exportModeSelect = node('select'); exportModeSelect.setAttribute('data-history-export-mode', 'privacy');
  exportModeSelect.id = filterId + '-export-mode';
  exportModeSelect.setAttribute('aria-describedby', filterId + '-export-help');
  for (const [value, text] of [['aliases', 'Privacy mode (aliases)'], ['full', 'Names and IDs (local use)']] as const) {
    const option = node('option', text); option.value = value; exportModeSelect.appendChild(option);
  }
  exportModeSelect.addEventListener('change', () => {
    if (disposed || exporting || !host?.contains(exportModeSelect)) return;
    if (exportModeSelect.value !== 'aliases' && exportModeSelect.value !== 'full') return;
    const focused = doc.activeElement; const source = livePreview.element.contains(focused) ? livePreviewSource : undefined;
    exportMode = exportModeSelect.value; exportStatus = ''; exportError = ''; exportPreview.clear(); clearLivePreview(); liveRecords.privacyChanged(); renderExport();
    if (source && (doc.activeElement === focused || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) {
      focusLivePreviewSource(liveRecords.focusTarget(source.recordId, source.origin) ?? exportModeSelect);
    }
  });
  exportPrivacy.appendChild(exportModeSelect);
  const exportHelp = node('p');
  exportHelp.id = filterId + '-export-help';
  const exportStatusNode = node('p'); exportStatusNode.setAttribute('role', 'status');
  const exportErrorNode = node('p'); exportErrorNode.setAttribute('role', 'alert');
  const exportNodes = [exportButton, exportHelp, ...(!deps.exportHistory ? [node('p', 'Complete history export is unavailable. You can still export loaded records below. Reconnect or update the server for a complete snapshot.')] : []), exportStatusNode, exportErrorNode, exportPreview.element, livePreview.element];
  const renderExport = (): void => {
    if (disposed) return;
    exportModeSelect.value = exportMode; exportModeSelect.disabled = exporting;
    exportButton.textContent = exporting ? 'Preparing export preview…' : exportPreview.hasSnapshot() ? 'Refresh export preview' : 'Preview export'; exportButton.disabled = exporting || !deps.exportHistory || !validFilters;
    exportHelp.textContent = 'Export this record on a history row copies or downloads just that entry in the selected privacy mode, without another server request. '
      + 'Preview this record lets you review the exact captured entry first. Changing export privacy clears this record preview. '
      + 'Preview export captures all retained entries matching the applied filters, including older pages. Unapplied edits are excluded. Download the same snapshot from the preview. '
      + (exportMode === 'aliases' ? 'Names, IDs and fingerprints become aliases that link records within this file only. Labels, messages and search text are removed. Dates, providers and outcomes remain. Review the file before sharing.'
        : 'Names and IDs mode keeps account and app labels, names and IDs. Complete reports also include applied search text. Keep these files for local use.')
      + ' Credentials and raw provider errors are omitted. No vendor access is checked.';
    exportStatusNode.textContent = exporting ? 'Preparing a complete preview from saved local history…' : exportStatus; exportStatusNode.hidden = !exportStatusNode.textContent;
    exportErrorNode.textContent = exportError; exportErrorNode.hidden = !exportError;
  };
  const applyFilters = (value: unknown): void => {
    if (disposed) return;
    if (!isAuthenticationIncidentHistoryFilters(value)) {
      const invalidSearch = typeof value === 'object' && value !== null && 'search' in value && !isAuthenticationIncidentHistoryFilters({ search: value.search });
      filterError = invalidSearch ? 'Search text is too long or contains unsupported characters. Shorten it or try different text.' : 'Choose a valid date range and filter selection.';
      render(); return;
    }
    filterError = ''; const next = authenticationIncidentHistoryFilters(value);
    if (JSON.stringify(next) === JSON.stringify(filters)) { void load(); return; }
    const hash = connectionsIncidentHistoryAddress(scope, next).hash;
    if (deps.navigate) deps.navigate(hash);
    else if (doc.defaultView) doc.defaultView.location.hash = hash;
    else if (!loading) { filters = next; exportSelectionVersion++; exportStatus = ''; exportError = ''; exportPreview.clear(); clearLivePreview(); rows = []; incidents = []; cursor = undefined; loaded = false; observedAt = undefined; void load(); }
  };
  const appendFilters = (parent: HTMLElement): void => {
    const form = node('form'); form.className = 'authentication-history-filters'; form.setAttribute('aria-label', 'Filter connection history');
    const grid = node('div'); grid.className = 'authentication-history-filter-fields';
    for (const [key, title] of [['search', 'Search saved history'], ['type', 'Event type'], ['outcome', 'Recorded outcome'], ['from', 'Started from (UTC)'], ['through', 'Started through (UTC)']] as const) {
      const field = node('div'); const label = node('label', title); label.htmlFor = filterId + '-' + key; field.appendChild(label);
      const input = key === 'type' || key === 'outcome' ? node('select') : node('input'); input.id = label.htmlFor;
      input.setAttribute('data-history-filter', key); input.setAttribute('aria-describedby', filterId + '-help');
      if (key === 'type' || key === 'outcome') {
        const options = key === 'type' ? historyTypes : historyOutcomes;
        const all = node('option', key === 'type' ? 'All event types' : 'All outcomes'); all.value = ''; input.appendChild(all);
        for (const [value, text] of Object.entries(options)) { const option = node('option', text); option.value = value; input.appendChild(option); }
      } else {
        input.setAttribute('type', key === 'search' ? 'search' : 'date'); if (key === 'search') { input.setAttribute('maxlength', '128'); input.setAttribute('placeholder', 'Account, app, connection, use, or saved ID'); }
      }
      input.value = draft[key]; input.addEventListener(key === 'type' || key === 'outcome' ? 'change' : 'input', () => {
        if (!disposed && host?.contains(input)) draft[key] = input.value;
      }); field.appendChild(input); grid.appendChild(field);
    }
    form.appendChild(grid);
    const help = node('p', 'Search names and IDs across retained history. Dates use the original start time in UTC. Outcomes describe saved observations, including historical passes.');
    help.id = filterId + '-help'; form.appendChild(help);
    const apply = node('button', 'Apply filters'); apply.type = 'submit'; apply.setAttribute('data-history-filter-action', 'apply'); form.appendChild(apply);
    const clear = node('button', 'Clear filters'); clear.type = 'button'; clear.setAttribute('data-history-filter-action', 'clear'); clear.addEventListener('click', () => {
      if (disposed || !host?.contains(clear)) return; for (const key of Object.keys(draft) as (keyof typeof draft)[]) draft[key] = ''; applyFilters({});
    }); form.appendChild(clear);
    form.addEventListener('submit', event => { event.preventDefault(); if (!disposed && host?.contains(form)) applyFilters(Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ''))); });
    if (filterError) { const alert = node('p', filterError); alert.setAttribute('role', 'alert'); form.appendChild(alert); }
    if (Object.keys(filters).length) { const applied = node('p', 'Applied filters: ' + Object.entries(filters).map(([key, value]) => key === 'type' ? historyTypes[value as keyof typeof historyTypes]
      : key === 'outcome' ? historyOutcomes[value as keyof typeof historyOutcomes] : key === 'search' ? 'Search “' + value + '”' : (key === 'from' ? 'Started from ' : 'Started through ') + value + ' UTC').join(' · '));
      applied.setAttribute('data-history-applied-filters', ''); form.appendChild(applied); }
    parent.appendChild(form);
  };
  const renewalShortcut = (row: AuthenticationRenewalHistory, label: string, selection: { grantId: string; index: number } | 'verify'): HTMLButtonElement => {
    const key = row.id + ':' + (selection === 'verify' ? 'verify' : selection.grantId + ':' + selection.index);
    const b = node('button', label); b.type = 'button'; b.disabled = loading || !!openingShortcut || (accessRepairs?.busy() ?? false) || (accessComparisons?.busy() ?? false); b.setAttribute('data-renewal-shortcut', key);
    b.addEventListener('click', () => {
      if (!deps.renewal || disposed || loading || openingShortcut || accessRepairs?.busy() || accessComparisons?.busy()) return;
      openingShortcut = key; shortcutError = ''; render();
      shortcutPending = (async () => {
        try {
          const href = await resolveOAuthAppRenewalShortcut(deps.renewal!, row, selection);
          if (disposed) return; openingShortcut = undefined; render();
          if (deps.navigate) deps.navigate(href); else if (doc.defaultView) doc.defaultView.location.hash = href;
        } catch (err) { if (!disposed) shortcutError = err instanceof Error ? err.message : 'This repair review could not be opened. Refresh and try again.'; }
        finally { if (!disposed) {
          const restore = doc.activeElement === doc.body || !doc.activeElement?.isConnected;
          openingShortcut = undefined; render();
          if (restore) host?.querySelector<HTMLElement>('[data-renewal-shortcut="' + key + '"]')?.focus({ preventScroll: true });
        } }
      })();
    }); return b;
  };
  const render = (): void => {
    if (!host || disposed) return;
    const chosen = host.contains(doc.activeElement) ? doc.activeElement : null;
    const focusedRecordId = chosen ? liveRecords.recordId(chosen as HTMLElement) : undefined;
    const previewFocus = chosen && (exportPreview.element.contains(chosen) || openedFile.element.contains(chosen) || livePreview.element.contains(chosen) || focusedRecordId !== undefined) ? chosen as HTMLElement : null;
    // DOM ranges collapse when the preview is moved during a history render.
    // Keep literal-node endpoints for the focused manual-copy field only.
    const manualSelection = (() => {
      if (previewFocus?.getAttribute('data-history-preview-copy-selection') !== 'manual') return;
      try {
        const selection = doc.defaultView?.getSelection(); const anchor = selection?.anchorNode; const focus = selection?.focusNode;
        if (!selection || !anchor || !focus || !previewFocus.contains(anchor) || !previewFocus.contains(focus)) return;
        return { anchor, focus, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset };
      } catch { return; }
    })();
    const focusAttr = chosen?.getAttribute('data-history-filter') ? 'data-history-filter'
      : chosen?.getAttribute('data-history-export') ? 'data-history-export'
      : chosen?.getAttribute('data-history-export-mode') ? 'data-history-export-mode' : 'data-history-filter-action';
    const filterFocus = chosen?.getAttribute(focusAttr); const focusedInput = filterFocus && focusAttr === 'data-history-filter' ? host.querySelector<HTMLInputElement>('[data-history-filter="' + filterFocus + '"]') : null;
    const caret = focusedInput?.selectionStart; const caretEnd = focusedInput?.selectionEnd;
    const chosenHref = chosen?.getAttribute('href') ?? null;
    const chosenLinkIndex = chosenHref === null ? -1 : Array.from(host.querySelectorAll<HTMLElement>('[href]')).filter(link => link.getAttribute('href') === chosenHref).findIndex(link => link === chosen);
    const expandedAccess = new Set(rows.filter(repairRow).filter(row => host?.querySelector<HTMLDetailsElement>('[data-authentication-access-disclosure="' + row.id + '"]')?.open).map(row => row.id));
    accessRepairs?.beginRender(); accessComparisons?.beginRender(); liveRecords.retain(rows);
    while (host.firstChild) host.removeChild(host.firstChild);
    const section = node('section'); section.className = 'authentication-incidents'; section.setAttribute('aria-label', 'Connection incident history');
    section.appendChild(node('h2', 'Connection incident history'));
    const back = scope.kind === 'all' || scope.kind === 'group' ? { text: 'Back to Connections', href: '#connections/others' } : destination(scope);
    section.appendChild(link(back.text, back.href));
    section.appendChild(node('p', 'Saved local observations show problems, repair actions, token renewal and access checks. Applied repairs and later successful operations are recorded separately. Opening or refreshing history reads local observations. Verify access lets you explicitly run new read checks.'));
    section.appendChild(node('p', 'Closed incidents, finished repairs and checks stay for up to 90 days; the latest 10,000 finished records are kept. Earlier events are available only from when history recording was enabled.'));
    if (scope.kind !== 'all') section.appendChild(link('View all connection incidents', connectionsIncidentHistoryAddress({ kind: 'all' }, filters).hash));
    section.appendChild(openedFile.element);
    appendFilters(section);
    section.appendChild(exportPrivacy);
    section.appendChild(button('Refresh history', 'refresh'));
    renderExport(); for (const child of exportNodes) section.appendChild(child);
    if (accessPanel) { section.appendChild(accessHost); accessPanel.mount(accessHost); }
    if (loading) { const status = node('p', 'Reading saved history…'); status.setAttribute('role', 'status'); section.appendChild(status); }
    if (error) { const alert = node('p', error); alert.setAttribute('role', 'alert'); section.appendChild(alert); }
    if (openingShortcut) { const status = node('p', 'Comparing current authentication before opening the review…'); status.setAttribute('role', 'status'); section.appendChild(status); }
    if (shortcutError) { const alert = node('p', shortcutError); alert.setAttribute('role', 'alert'); section.appendChild(alert); }
    if (observedAt !== undefined) {
      const repairCount = rows.filter(repairRow).length;
      const verificationCount = rows.filter(accessRow).length;
      const renewalCount = rows.filter(renewalRow).length;
      const status = node('p', `History read: ${new Date(observedAt).toLocaleString()}. ${incidents.length} incident${incidents.length === 1 ? '' : 's'} shown.`
        + (repairHistoryAvailable ? ` ${repairCount} repair action${repairCount === 1 ? '' : 's'} shown.` : ' This server does not provide repair-action history.')
        + (verificationCount ? ` ${verificationCount} access check${verificationCount === 1 ? '' : 's'} shown.` : '')
        + (renewalCount ? ` ${renewalCount} renewal check${renewalCount === 1 ? '' : 's'} shown.` : '')
        + (renewalHistoryAvailable ? '' : ' This server does not provide token-renewal history.'));
      status.setAttribute('role', 'status'); section.appendChild(status);
    }
    if (loaded && !rows.length && !loading && !error) section.appendChild(node('p', Object.keys(filters).length
      ? 'No retained entries match these filters. Widen the dates or clear the filters. This does not confirm vendor access.'
      : 'No incidents have been recorded for this selection. No repair actions are shown. This does not confirm vendor access.'));
    for (const row of rows) {
      if (renewalRow(row)) {
        const article = node('article'); article.setAttribute('data-authentication-renewal', row.id);
        article.appendChild(node('h3', 'Token renewal verification'));
        article.appendChild(node('p', row.app_label + ' · ' + (row.issuer === 'google' ? 'Google' : 'Microsoft') + ' · App revision ' + row.app_revision));
        article.appendChild(node('p', row.status === 'checking' ? 'Renewal checks are running in the background. Refresh history to read saved progress.' : 'Saved renewal results'));
        article.appendChild(node('p', 'Started: ' + new Date(row.started_at).toLocaleString() + (row.finished_at === undefined ? '.' : '. Finished: ' + new Date(row.finished_at).toLocaleString() + '.')));
        if (row.history_started_at > row.started_at) article.appendChild(node('p', 'Added to history: ' + new Date(row.history_started_at).toLocaleString() + '. This earlier check was imported from its saved receipt. Its position shows when it was added.'));
        article.appendChild(node('p', 'This review lists checked, excluded and unavailable authorizations separately. A passed renewal proves token issuance and saving. It does not prove data access, sending, editing, sync or incident recovery.'));
        const results = node('ul');
        for (const r of row.results) {
          const item = node('li'); item.appendChild(node('strong', r.label)); item.appendChild(node('p', oauthAppRenewalResultText(r)));
          const current = oauthAppRenewalCurrentText(r); if (current) item.appendChild(node('p', current));
          if (deps.renewal) for (const [index, action] of oauthAppRenewalShortcuts(row, r).entries()) {
            item.appendChild(renewalShortcut(row, action.label, { grantId: r.id, index }));
          }
          for (const name of r.connections) { const d = destination({ kind: 'connection', name }); item.appendChild(link(d.text, d.href)); }
          for (const a of r.native_accounts) { const d = destination({ kind: 'collection', platform: a.platform, slug: a.slug }); item.appendChild(link(d.text, d.href)); }
          results.appendChild(item);
        }
        article.appendChild(results);
        if (row.incomplete) article.appendChild(node('p', 'Some local authorizations could not be listed. These results cover only the listed checks.'));
        if (row.references_incomplete) article.appendChild(node('p', 'Some account or file references were not recorded. Use the listed API connection or all history to find these renewal results.'));
        if (deps.renewal && row.status === 'completed') {
          article.appendChild(node('p', 'Repair shortcuts open a fresh review. Consent and changes still need your approval. After repairing, review and run new renewal checks.'));
          article.appendChild(renewalShortcut(row, 'Review token renewal again', 'verify'));
        }
        if (deps.verify && row.status === 'completed') {
          const verify = link('Verify access', connectionsVerifyAccessAddress({ kind: 'renewal', id: row.id }).hash);
          verify.setAttribute('data-renewal-verify-access', row.id); article.appendChild(verify);
          article.appendChild(node('p', 'Review current saved accounts and resources before running separate read checks.'));
        }
        article.appendChild(link('Manage saved OAuth apps', connectionsOAuthAppsAddress().hash));
        liveRecords.append(article, row); section.appendChild(article); continue;
      }
      if (accessRow(row)) {
        const article = node('article'); article.setAttribute('data-authentication-verification', row.id); article.appendChild(node('h3', 'Access verification'));
        appendAuthenticationAccessSummary(doc, article, row, accessRepairs?.append);
        accessComparisons?.append(article, row);
        if (accessPanel) {
          const view = node('button', 'View access check'); view.type = 'button'; view.setAttribute('data-incident-view-access', row.id);
          view.disabled = loading || (accessRepairs?.busy() ?? false) || (accessComparisons?.busy() ?? false);
          view.addEventListener('click', () => { if (!disposed && !loading && !accessRepairs?.busy() && !accessComparisons?.busy()) { accessPanel.open(row.selection, row,
            () => host?.querySelector<HTMLElement>('[data-incident-view-access="' + row.id + '"]')?.focus()); accessHost.scrollIntoView?.({ block: 'nearest' }); } }); article.appendChild(view);
          if (authenticationAccessRecheckResults(row).length) {
            const recheck = link('Review failed or unconfirmed reads', connectionsVerifyAccessAddress({ kind: 'verification', id: row.id }).hash);
            recheck.setAttribute('data-incident-recheck-access', row.id); article.appendChild(recheck);
          }
        }
        liveRecords.append(article, row); section.appendChild(article); continue;
      }
      if (repairRow(row)) {
        const article = node('article'); article.setAttribute('data-authentication-repair', row.id);
        article.appendChild(node('h3', repairLabel[row.action]));
        article.appendChild(node('p', row.status === 'checking' ? 'Checking repair' : row.status === 'applied' ? 'Authentication updated' : 'Repair failed · Saved authentication kept'));
        article.appendChild(node('p', 'Started: ' + new Date(row.started_at).toLocaleString() + (row.finished_at === undefined ? '.' : '. Finished: ' + new Date(row.finished_at).toLocaleString() + '.')));
        if (row.from) article.appendChild(node('p', 'From: ' + methodLabel(row.from)));
        if (row.to) article.appendChild(node('p', 'To: ' + methodLabel(row.to)));
        if (row.reason) article.appendChild(node('p', failureLabel[row.reason]));
        if (row.restart_required) article.appendChild(node('p', 'Authentication was saved; collection restart still needs attention.'));
        if (row.recovery_confirmed_at !== undefined) article.appendChild(node('p', 'Later successful operations recorded for every related incident: '
          + new Date(row.recovery_confirmed_at).toLocaleString() + '. This does not prove every permission or establish which repair caused recovery.'));
        else if (row.status === 'applied') article.appendChild(node('p', row.action === 'rotate_secret'
          ? 'The secret was saved locally. Vendor access was not checked. Later successful operations are needed to confirm recovery.'
          : 'The reviewed change was saved. Later successful operations are needed to confirm recovery for affected uses. Failed work was not retried.'));
        for (const target of row.targets) { const d = destination(target); article.appendChild(link(d.text, d.href)); }
        if (row.targets_truncated) article.appendChild(node('p', 'Some affected references are omitted from this preview.'));
        if (row.access_summary) {
          appendLatestAuthenticationAccess(doc, article, row.access_summary, accessPanel ? (entry, sourceButton) => {
            if (disposed || loading || accessRepairs?.busy() || !host?.contains(sourceButton)) return;
            void accessPanel.openSaved(entry, () => host?.querySelector<HTMLElement>('[data-authentication-repair="' + row.id + '"]')
              ?.querySelector<HTMLElement>('[data-latest-access-view="' + entry.result.id + '"]')?.focus(), row.access_summary!.selection);
            accessHost.scrollIntoView?.({ block: 'nearest' });
          } : undefined, accessRepairs?.append);
        } else if (row.access_verification) {
          const details = node('details'); details.setAttribute('data-authentication-access-disclosure', row.id); details.open = expandedAccess.has(row.id);
          details.appendChild(node('summary', 'Latest access check')); appendAuthenticationAccessSummary(doc, details, row.access_verification, accessRepairs?.append); article.appendChild(details);
        }
        if (row.status === 'applied' && accessPanel) {
          if (row.access_summary) {
            const verify = link('Verify access', connectionsVerifyAccessAddress({ kind: 'repair', id: row.id }).hash);
            verify.setAttribute('data-incident-verify-access', row.id); article.appendChild(verify);
          } else {
            const verify = node('button', row.access_verification?.status === 'checking' ? 'View access check' : 'Verify access'); verify.type = 'button'; verify.disabled = loading || (accessRepairs?.busy() ?? false);
            verify.setAttribute('data-incident-verify-access', row.id);
            verify.addEventListener('click', () => { if (!disposed && !loading && !accessRepairs?.busy()) { accessPanel.open({ kind: 'repair', id: row.id }, row.access_verification,
              () => host?.querySelector<HTMLElement>('[data-incident-verify-access="' + row.id + '"]')?.focus()); accessHost.scrollIntoView?.({ block: 'nearest' }); } });
            article.appendChild(verify);
          }
        }
        const related = node('details'); related.appendChild(node('summary', 'Related incidents (' + row.incidents.length + ')'));
        for (const incident of row.incidents) related.appendChild(link(incident.label + ' · View incident history', '#connections/others/incident-history/group/' + incident.group_id));
        if (!row.incidents.length) related.appendChild(node('p', 'No open incident was associated when this repair started.'));
        if (row.incidents_truncated) related.appendChild(node('p', 'Some related incidents are omitted from this preview.'));
        related.appendChild(node('p', 'A related incident may close when authentication changes. That alone does not confirm recovered access.'));
        article.appendChild(related); liveRecords.append(article, row); section.appendChild(article); continue;
      }
      const incident = row;
      const article = node('article'); article.setAttribute('data-authentication-incident', incident.id);
      article.appendChild(node('h3', incident.group.label));
      article.appendChild(node('p', incident.group.authentication === 'direct_oauth' ? 'Recued direct OAuth' : incident.group.authentication === 'broker'
        ? 'Broker sign-in' : incident.group.authentication === 'other' ? 'Saved authentication' : 'Authentication details were unavailable'));
      article.appendChild(node('p', (incident.status === 'recovered' ? 'Successful operations recorded' : incident.status === 'retired' ? 'Closed without confirmed recovery'
        : incident.currently_reported ? 'Open problem' : 'Awaiting access evidence') + ' · ' + levelLabel[incident.level]));
      article.appendChild(node('p', `First observed: ${new Date(incident.started_at).toLocaleString()}. Last problem observed: ${incident.last_problem_at === undefined ? 'Unknown' : new Date(incident.last_problem_at).toLocaleString()}.`));
      if (incident.last_problem_at === undefined) article.appendChild(node('p', 'Earlier alert state did not retain the last problem observation time.'));
      if (incident.ended_at !== undefined) article.appendChild(node('p', 'Ended: ' + new Date(incident.ended_at).toLocaleString() + '.'));
      if (incident.retirement_reason) article.appendChild(node('p', retirementLabel[incident.retirement_reason]));
      if (incident.status === 'recovered') article.appendChild(node('p', 'A later successful operation was recorded for every reported problem. This does not verify every permission or replay failed work.'));
      if (incident.status === 'open' && !incident.currently_reported) article.appendChild(node('p', 'The recorded problem is no longer present. Recovery still needs later positive evidence for every failed use.'));
      const details = node('details'); details.appendChild(node('summary', 'Recorded problems and affected uses'));
      for (const issue of incident.group.issues) details.appendChild(node('p', issue.message));
      const uses = node('ul'); for (const use of incident.group.uses) uses.appendChild(node('li', useLabel[use.kind] + ': ' + use.label)); details.appendChild(uses);
      if (!incident.group.usage_available || incident.details_truncated) details.appendChild(node('p', 'The list of affected uses or problems may be incomplete.'));
      details.appendChild(node('p', 'These are historical references. Their current authentication or availability may have changed.'));
      for (const target of incident.group.targets.slice(0, 4)) { const d = destination(target); details.appendChild(link(d.text, d.href)); }
      article.appendChild(details);
      const timeline = node('details'); timeline.open = incident.status === 'open'; timeline.appendChild(node('summary', 'Timeline (' + incident.events.length + ' events)'));
      const events = node('ol'); for (const event of incident.events) events.appendChild(node('li', new Date(event.at).toLocaleString() + ' · ' + eventLabel[event.kind]
        + (event.kind === 'opened' || event.kind === 'recorded' || event.kind === 'changed' ? ' · ' + levelLabel[event.level] : '')));
      timeline.appendChild(events); article.appendChild(timeline);
      if (incident.events_truncated) article.appendChild(node('p', 'Some intermediate events were omitted. The first event and most recent events are shown.'));
      if (incident.history_started_at > incident.started_at) article.appendChild(node('p', 'History recording began ' + new Date(incident.history_started_at).toLocaleString() + '. Earlier alert state supplied the first observation date.'));
      liveRecords.append(article, row); section.appendChild(article);
    }
    if (cursor) section.appendChild(button(repairHistoryAvailable ? 'Load older history' : 'Load older incidents', 'older', true));
    host.appendChild(section);
    // Detaching the panel can run a blur handler that chooses another control.
    // Restore a captured field only while this render still owns lost focus.
    if (previewFocus && host.contains(previewFocus) && (doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) {
      previewFocus.focus({ preventScroll: true });
      if (manualSelection && doc.activeElement === previewFocus && previewFocus.contains(manualSelection.anchor) && previewFocus.contains(manualSelection.focus)) {
        try { doc.defaultView?.getSelection()?.setBaseAndExtent(manualSelection.anchor, manualSelection.anchorOffset, manualSelection.focus, manualSelection.focusOffset); }
        catch { /* Manual selection remains available if the browser refuses. */ }
      }
    }
    else if (focusedRecordId !== undefined && (doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) {
      (liveRecords.focusTarget(focusedRecordId) ?? host.querySelector<HTMLElement>('[data-incident-action="refresh"]'))?.focus({ preventScroll: true });
    }
    else if (filterFocus) {
      const control = host.querySelector<HTMLInputElement>('[' + focusAttr + '="' + filterFocus + '"]'); control?.focus({ preventScroll: true });
      if (typeof caret === 'number') control?.setSelectionRange?.(caret, caretEnd ?? caret);
    } else if (chosenLinkIndex >= 0 && (doc.activeElement === chosen || doc.activeElement === doc.body || !doc.activeElement?.isConnected)) {
      Array.from(host.querySelectorAll<HTMLElement>('[href]')).filter(link => link.getAttribute('href') === chosenHref)[chosenLinkIndex]?.focus({ preventScroll: true });
    }
  };
  const load = (more = false, focusAction?: string): Promise<void> => {
    if (disposed || loading || openingShortcut || more && !cursor) return pending;
    accessRepairs?.reset(); accessComparisons?.reset();
    loading = true; error = ''; shortcutError = ''; render(); const requestedCursor = more ? cursor : undefined;
    pending = (async () => {
      try {
        if (!deps.call) throw new Error('unavailable');
        if (!validFilters) throw new HistoryFilterError();
        const page = await deps.call({ scope, include_renewals: true, ...(Object.keys(filters).length ? { filters } : {}), ...(requestedCursor ? { cursor: requestedCursor } : {}) });
        if (disposed) return;
        if (!isAuthenticationIncidentHistoryPage(page) || JSON.stringify(page.scope) !== JSON.stringify(scope)
          || page.next_cursor && (page.next_cursor === requestedCursor || more && cursors.has(page.next_cursor))) throw new Error('invalid');
        if (JSON.stringify(authenticationIncidentHistoryFilters(page.filters)) !== JSON.stringify(filters)) throw new HistoryFilterError();
        const accepted = structuredClone(page);
        const byId = new Map<string, HistoryRow>([...accepted.incidents, ...accepted.repairs ?? [], ...accepted.verifications ?? [], ...accepted.renewals ?? []].map(i => [i.id, i]));
        const incoming = (accepted.order ?? accepted.incidents.map(i => i.id)).map(id => byId.get(id)!);
        if (!incoming.every(row => authenticationHistoryEntryMatches(row, filters))) throw new HistoryFilterError();
        rows = more ? [...new Map([...rows, ...incoming].map(i => [i.id, i])).values()] : incoming;
        incidents = rows.filter((row): row is AuthenticationIncident => !repairRow(row) && !accessRow(row) && !renewalRow(row)); repairHistoryAvailable = accepted.repairs !== undefined;
        renewalHistoryAvailable = accepted.renewals !== undefined;
        if (!more) cursors.clear();
        if (requestedCursor) cursors.add(requestedCursor);
        cursor = accepted.next_cursor; observedAt = accepted.observed_at; loaded = true;
      } catch (err) { if (!disposed) error = err instanceof HistoryFilterError ? 'The server could not confirm these history filters. Clear the filters or update the server. Earlier matching observations may be shown.'
        : 'History could not be refreshed. Earlier observations may be shown. Retry or update the server.'; }
      finally { if (!disposed) {
        const restoreFocus = focusAction !== undefined && (doc.activeElement === doc.body || !doc.activeElement?.isConnected);
        loading = false; render();
        if (restoreFocus) (host?.querySelector<HTMLElement>('[data-incident-action="' + focusAction + '"]')
          ?? host?.querySelector<HTMLElement>('[data-incident-action="refresh"]'))?.focus({ preventScroll: true });
      } }
    })(); return pending;
  };
  const accessHost = doc.createElement('div');
  const accessPanel = deps.verify ? createAuthenticationAccessPanel({ document: doc, call: deps.verify, updated: () => { void load(); } }) : undefined;
  const accessRepairs = deps.verify ? createAuthenticationAccessRepairShortcuts({ document: doc, call: deps.verify, host: () => host,
    active: (): boolean => !disposed && !loading && !openingShortcut && !accessComparisons?.busy(), changed: () => render(), ...(deps.navigate ? { navigate: deps.navigate } : {}) }) : undefined;
  const accessComparisons = deps.verify ? createAuthenticationAccessComparisons({ document: doc, call: deps.verify, host: () => host,
    active: (): boolean => !disposed && !loading && !openingShortcut && !accessRepairs?.busy(), changed: () => render() }) : undefined;
  return { mount(element: HTMLElement): void { host = element; render(); void load(); }, refresh: () => load(),
    hasDraft: (): boolean => accessPanel?.hasDraft() ?? false,
    hasInFlightWork: (): boolean => accessPanel?.hasInFlightWork() ?? false,
    whenLoaded: async () => { await pending; await exportPending; await openedFile.whenLoaded(); await shortcutPending; await accessPanel?.whenLoaded(); await accessRepairs?.whenLoaded(); await accessComparisons?.whenLoaded(); },
    dispose(): void { disposed = true; livePreviewSource = undefined; livePreview.dispose(); liveRecords.dispose(); exportPreview.dispose(); openedFile.dispose(); accessRepairs?.dispose(); accessComparisons?.dispose(); accessPanel?.dispose(); host = null; } };
};
export const AUTHENTICATION_INCIDENT_STYLES = `.authentication-incidents{font-size:13px;line-height:1.5;min-width:0;overflow-wrap:anywhere}.authentication-incidents h2{font-size:20px;margin:0 0 12px}.authentication-incidents article{border:1px solid var(--border);border-radius:8px;padding:16px;margin:16px 0}.authentication-incidents h3{font-size:16px;margin:0 0 8px}.authentication-incidents a{display:inline-block;margin:4px 12px 4px 0;min-height:28px}.authentication-incidents button{font:inherit;min-height:44px;max-width:100%;white-space:normal;overflow-wrap:anywhere;margin:4px 8px 4px 0;border:1px solid var(--border);border-radius:6px;padding:7px 12px;background:var(--surface);color:var(--fg);cursor:pointer}.authentication-incidents button:disabled{opacity:.6;cursor:default}.authentication-incidents details>summary{cursor:pointer}.authentication-incidents [role=alert]{color:var(--danger,#b42318)}
.authentication-history-filters{border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0}
.authentication-history-export-privacy{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0}.authentication-history-export-privacy select{box-sizing:border-box;font:inherit;height:44px;min-height:44px;max-width:100%;min-width:0;padding:7px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}
.authentication-incidents [data-history-live-record]{margin-top:12px}.authentication-incidents [data-history-live-record]>summary{min-height:44px;display:list-item;align-content:center}
.authentication-incidents [data-history-live-control="preview"]{box-sizing:border-box;display:block;width:100%;max-width:340px}
.authentication-history-filter-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.authentication-history-filter-fields>div:first-child{grid-column:1/-1}
.authentication-history-filter-fields label{display:block;margin-bottom:4px}
.authentication-history-filter-fields input,.authentication-history-filter-fields select{box-sizing:border-box;width:100%;min-width:0;min-height:44px;font:inherit;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--fg)}
@media(max-width:600px){.authentication-history-filter-fields{grid-template-columns:minmax(0,1fr)}}` + AUTHENTICATION_ACCESS_STYLES + LATEST_AUTHENTICATION_ACCESS_STYLES + AUTHENTICATION_HISTORY_PREVIEW_STYLES + AUTHENTICATION_HISTORY_FILE_STYLES;
